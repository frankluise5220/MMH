import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { issueSessionCookies, sessionDaysFromRequest } from "@/lib/server/session-issue";
import {
  createLedgerWithDefaults,
  LEDGER_CREATION_INVITE_CODE_KEY,
} from "@/lib/households/create-ledger";
import {
  activeLedgerInviteCodes,
  markLedgerInviteCodeUsed,
  parseLedgerInviteCodeRecords,
  serializeLedgerInviteCodeRecords,
} from "@/lib/ledger-invite-codes";
import { inspectLedgerInviteCode, missingIssuerRejection } from "@/lib/server/ledger-invite-code-guard";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";
import { queueLedgerInventoryReport } from "@/lib/server/ledger-inventory";
import { matchesGatewayFnosIdentity, readGatewayFnosIdentity } from "@/lib/server/gateway-identity";
import { hashPassword } from "@/lib/auth/password";

const LEGACY_PASSWORD_KEY = "access_password";

class CreateLedgerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * POST /api/v1/auth/create-ledger
 * Public entry: creates a new ledger and logs in directly as the new ledger's admin.
 * - Initializing the first ledger on an empty deployment does not require an invite code.
 * - Non-first-time creation must validate the ledger creation invite code from system settings.
 * - Invite codes are single-use; after a successful creation, the created ledger and usage time are recorded and the code is invalidated.
 *
 * Body:
 * {
 *   inviteCode?: string,
 *   name: string,
 *   adminName: string,
 *   adminPassword: string,
 *   adminEmail?: string
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gatewayIdentity = readGatewayFnosIdentity(req.headers);
  const inviteCode = String(body.inviteCode ?? "").trim();
  const name = String(body.name ?? "").trim();
  const authMode = body.authMode === "fnos" ? "fnos" : body.authMode === "mmh" ? "mmh" : "local";
  const fnosUid = String(body.fnosUid ?? "").trim();
  const adminName = String(body.adminName ?? "").trim();
  const adminPassword = String(body.adminPassword ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();
  // The MMH membership password (central registration service, scrypt). It is
  // NOT the ledger-local admin password: it proves ownership of an existing MMH
  // identity, exactly like the login tab does.
  const mmhPassword = String(body.mmhPassword ?? "").trim();

  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, code: "INVALID_LEDGER_NAME", error: "Ledger name must be between 1 and 50 characters." }, { status: 400 });
  }
  if (!adminName || adminName.length > 50) {
    return NextResponse.json({ ok: false, code: "INVALID_ADMIN_NAME", error: "Administrator username must be between 1 and 50 characters." }, { status: 400 });
  }
  if (authMode === "fnos" && !matchesGatewayFnosIdentity(gatewayIdentity, fnosUid)) {
    return NextResponse.json({ ok: false, code: "FNOS_ID_REQUIRED", error: "The fnOS account identity is required." }, { status: 400 });
  }
  if (authMode === "mmh" && (!adminEmail || !mmhPassword)) {
    return NextResponse.json({ ok: false, code: "MMH_CREDENTIALS_REQUIRED", error: "An MMH account email and membership password are required." }, { status: 400 });
  }
  if (authMode === "local" && !adminPassword) {
    return NextResponse.json({ ok: false, code: "ADMIN_PASSWORD_REQUIRED", error: "Administrator password is required." }, { status: 400 });
  }

  // Verify an *existing* MMH identity against the central registration service
  // before touching the database. Network-bound, so it stays outside the
  // transaction (same reason the bcrypt hash below does). The returned
  // principalId is what lets this ledger later recognise the same MMH account.
  let mmhPrincipalId: string | null = null;
  if (authMode === "mmh") {
    const verification = await verifyEmailPrincipal({ email: adminEmail, password: mmhPassword });
    if (!verification.ok || !verification.principalId) {
      return NextResponse.json(
        {
          ok: false,
          code: verification.code ?? "MMH_CREDENTIALS_INVALID",
          error: verification.error ?? "The MMH account email or membership password is incorrect.",
        },
        { status: verification.status ?? 401 },
      );
    }
    mmhPrincipalId = verification.principalId;
  }

  const [householdCount, userCount, legacy] = await prisma.$transaction([
    prisma.household.count(),
    prisma.user.count(),
    prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
      select: { value: true },
    }),
  ]);
  const isInitialLedgerSetup = householdCount === 0 && userCount === 0 && !(legacy?.value?.length);

  if (!isInitialLedgerSetup) {
    if (!inviteCode) {
      return NextResponse.json({ ok: false, code: "INVITE_CODE_REQUIRED", error: "An invite code is required." }, { status: 400 });
    }
  }

  // Hash the admin password *before* opening the transaction: bcrypt is CPU-bound
  // and needs no database access, so keeping it outside avoids burning the
  // transaction budget on low-power hardware (see getConfiguredTransactionOptions).
  // fnOS and MMH admins sign in with an external identity, so they start with no
  // ledger-local password (same shape as the fnOS gateway path); the sensitive
  // operation guard walks them through creating one on first use.
  const adminPasswordHash = authMode === "fnos" || authMode === "mmh" || !adminPassword ? null : await hashPassword(adminPassword);

  let created: Awaited<ReturnType<typeof createLedgerWithDefaults>>;
  try {
    created = await prisma.$transaction(async (tx) => {
      if (isInitialLedgerSetup) {
        return createLedgerWithDefaults(tx, {
          name,
          adminName,
          adminPasswordHash,
          adminEmail,
          fnosUid: authMode === "fnos" ? fnosUid : undefined,
          registrationPrincipalId: mmhPrincipalId,
        });
      }

      const inviteSetting = await tx.systemSetting.findUnique({
        where: { key: LEDGER_CREATION_INVITE_CODE_KEY },
      });
      const inviteRecords = parseLedgerInviteCodeRecords(inviteSetting?.value);
      // Precise verdicts: a wrong code, a code from another instance, an
      // already-used code and an unconfigured server must not look the same.
      const inspection = inspectLedgerInviteCode(inviteRecords, inviteCode);
      if (!inspection.ok) {
        const { rejection } = inspection;
        if (rejection.code === "INVITE_CODE_NOT_FOUND" && activeLedgerInviteCodes(inviteRecords).length === 0) {
          throw new CreateLedgerError("Ledger creation is currently closed. Contact an administrator.", 403);
        }
        throw new CreateLedgerError(rejection.message, rejection.status);
      }
      const issuerHousehold = await tx.household.findUnique({
        where: { id: inspection.record.issuerHouseholdId },
        select: { id: true },
      });
      if (!issuerHousehold) {
        throw new CreateLedgerError(missingIssuerRejection().message, 403);
      }

      const result = await createLedgerWithDefaults(tx, {
        name,
        adminName,
        adminPasswordHash,
        adminEmail,
        fnosUid: authMode === "fnos" ? fnosUid : undefined,
        registrationPrincipalId: mmhPrincipalId,
      });
      const usedInviteRecords = markLedgerInviteCodeUsed(inviteRecords, inviteCode, {
        householdId: result.household.id,
        householdName: result.household.name,
        usedUserId: result.adminUser.id,
        usedUserName: result.adminUser.name,
      });
      await tx.systemSetting.upsert({
        where: { key: LEDGER_CREATION_INVITE_CODE_KEY },
        create: {
          key: LEDGER_CREATION_INVITE_CODE_KEY,
          value: serializeLedgerInviteCodeRecords(usedInviteRecords),
        },
        update: { value: serializeLedgerInviteCodeRecords(usedInviteRecords) },
      });
      return result;
    });
  } catch (error) {
    if (error instanceof CreateLedgerError) {
      return NextResponse.json({ ok: false, code: "LEDGER_CREATION_REJECTED", error: error.message }, { status: error.status });
    }
    throw error;
  }

  // A ledger was created (possibly the first one on a brand-new deployment);
  // refresh the installation inventory in the background.
  queueLedgerInventoryReport("ledger-created");

  const response = NextResponse.json({
    ok: true,
    initialSetup: isInitialLedgerSetup,
    household: { id: created.household.id, name: created.household.name },
  });
  issueSessionCookies(
    response,
    {
      userId: created.adminUser.id,
      name: created.adminUser.name,
      householdId: created.household.id,
      authVersion: created.adminUser.authVersion,
    },
    { sessionDays: sessionDaysFromRequest(req), req },
  );
  return response;
}
