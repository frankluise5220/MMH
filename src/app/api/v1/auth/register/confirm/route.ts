import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { isRegistrationConfigured, registerEmailPrincipal, setEmailPrincipalPassword } from "@/lib/server/registration-client";
import {
  createLedgerWithDefaults,
  LEDGER_CREATION_INVITE_CODE_KEY,
} from "@/lib/households/create-ledger";
import {
  markLedgerInviteCodeUsed,
  parseLedgerInviteCodeRecords,
  serializeLedgerInviteCodeRecords,
} from "@/lib/ledger-invite-codes";
import { logger } from "@/lib/logger";
import { inspectLedgerInviteCode, missingIssuerRejection } from "@/lib/server/ledger-invite-code-guard";
import {
  HOUSEHOLD_COOKIE,
  SESSION_DAYS_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  createVerifiedSessionValue,
  sessionCookieOptions,
} from "@/lib/server/session-cookies";

export const runtime = "nodejs";

const ConfirmSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(20),
  password: z.string().min(6).max(200),
  // Optional MMH membership password (scrypt, stored in the central registration
  // service). Distinct from `password`, which is the ledger-local admin password.
  mmhPassword: z.string().min(6).max(200).optional(),
  name: z.string().trim().min(1).max(50).optional(),
  inviteCode: z.string().trim().optional(),
  ledgerName: z.string().trim().min(1).max(50).optional(),
});

const SIGNUP_TARGET_ID = "signup-pending";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

function resolveSessionMaxAge(req: NextRequest) {
  const raw = req.cookies.get(SESSION_DAYS_COOKIE)?.value ?? "30";
  const days = Number(raw);
  const normalizedDays = Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 365) : 30;
  return normalizedDays * 24 * 60 * 60;
}

/**
 * POST /api/v1/auth/register/confirm
 *
 * Step 2 of the public self-service signup flow (no session required): verifies
 * the email code, registers an email principal in the external mmh-registration
 * service, then creates a new ledger with the registrant as its admin user
 * (email as the login name) and signs them in.
 *
 * Body: { email, code, password, name? }
 */
export async function POST(req: NextRequest) {
  if (!isRegistrationConfigured()) {
    return NextResponse.json(
      { ok: false, code: "REGISTRATION_NOT_CONFIGURED", error: "The registration service is not configured on this server." },
      { status: 503, headers: cors() },
    );
  }

  const body = await req.json().catch(() => null);
  const parse = ConfirmSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "email, code and password are required." }, { status: 400, headers: cors() });
  }

  const email = parse.data.email.trim().toLowerCase();
  const password = parse.data.password.trim();
  const adminName = parse.data.name?.trim() || email.split("@")[0] || "admin";
  const inviteCode = parse.data.inviteCode?.trim() ?? "";
  const ledgerName = parse.data.ledgerName?.trim() ?? "";
  const inviteRegistration = Boolean(inviteCode);

  if (inviteRegistration && !ledgerName) {
    return NextResponse.json({ ok: false, code: "LEDGER_NAME_REQUIRED", error: "A ledger name is required." }, { status: 400, headers: cors() });
  }

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "EMAIL_CODE_NOT_CONFIGURED", error: "Email verification codes are not configured on this server." }, { status: 500, headers: cors() });
  }

  const codeHash = crypto.createHash("sha256").update(`${secret}:${email}:${parse.data.code.trim()}`).digest("hex");
  const token = await prisma.registrationCode.findFirst({
    where: {
      targetUserId: SIGNUP_TARGET_ID,
      email,
      codeHash,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!token) {
    return NextResponse.json({ ok: false, code: "INVALID_OR_EXPIRED_CODE", error: "The verification code is invalid or has expired." }, { status: 400, headers: cors() });
  }

  let inviteRecords: ReturnType<typeof parseLedgerInviteCodeRecords> | null = null;
  if (inviteRegistration) {
    const inviteSetting = await prisma.systemSetting.findUnique({ where: { key: LEDGER_CREATION_INVITE_CODE_KEY } });
    inviteRecords = parseLedgerInviteCodeRecords(inviteSetting?.value);
    // Same precise verdicts as send-code: this is the last chance to tell the
    // user *why* their code was rejected.
    const inspection = inspectLedgerInviteCode(inviteRecords, inviteCode);
    if (!inspection.ok) {
      const { rejection } = inspection;
      return NextResponse.json({ ok: false, code: rejection.code, error: rejection.message }, { status: rejection.status, headers: cors() });
    }
    const issuerHousehold = await prisma.household.findUnique({
      where: { id: inspection.record.issuerHouseholdId },
      select: { id: true },
    });
    if (!issuerHousehold) {
      const rejection = missingIssuerRejection();
      return NextResponse.json({ ok: false, code: rejection.code, error: rejection.message }, { status: rejection.status, headers: cors() });
    }
  }

  // Self-service signup only bootstraps the very first ledger on an empty
  // deployment. Once any ledger or user exists, opening a new ledger is a
  // separate, invite-gated action and must not be reachable through signup.
  const [householdCount, userCount] = await prisma.$transaction([
    prisma.household.count(),
    prisma.user.count(),
  ]);
  if (!inviteRegistration && (householdCount > 0 || userCount > 0)) {
    return NextResponse.json({ ok: false, code: "SIGNUP_CLOSED", error: "Registration is only available before the first ledger is created." }, { status: 403, headers: cors() });
  }

  const emailTaken = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });
  if (emailTaken) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already registered." }, { status: 409, headers: cors() });
  }

  const registration = await registerEmailPrincipal({ displayName: adminName, email });
  if (!registration.ok || !registration.principalId) {
    return NextResponse.json(
      { ok: false, code: registration.code ?? "REGISTRATION_SERVICE_ERROR", error: registration.error ?? "Registration service failed." },
      { status: registration.status ?? 502, headers: cors() },
    );
  }
  const principalId = registration.principalId;

  // If the user supplied an MMH membership password, set it on the freshly
  // created principal. This is the central credential (scrypt) and is distinct
  // from the ledger-local admin password above. Do this before creating the
  // local ledger so a failure here never leaves a half-created account.
  const mmhPassword = parse.data.mmhPassword?.trim();
  if (mmhPassword) {
    const setPassword = await setEmailPrincipalPassword({ email, password: mmhPassword });
    if (!setPassword.ok) {
      return NextResponse.json(
        { ok: false, code: setPassword.code ?? "MMH_PASSWORD_SET_FAILED", error: setPassword.error ?? "Failed to set the MMH membership password." },
        { status: setPassword.status ?? 502, headers: cors() },
      );
    }
  }

  let created: Awaited<ReturnType<typeof createLedgerWithDefaults>>;
  try {
    created = await prisma.$transaction(async (tx) => {
      const result = await createLedgerWithDefaults(tx, {
        name: inviteRegistration ? ledgerName : adminName,
        adminName,
        adminPassword: password,
        adminEmail: email,
      });
      // Record the external registration identity on the newly created admin user.
      await tx.user.update({
        where: { id: result.adminUser.id },
        data: { registrationPrincipalId: principalId },
      });
      await tx.registrationCode.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
      if (inviteRegistration && inviteRecords) {
        const usedInviteRecords = markLedgerInviteCodeUsed(inviteRecords, inviteCode, {
          householdId: result.household.id,
          householdName: result.household.name,
          usedUserId: result.adminUser.id,
          usedUserName: result.adminUser.name,
        });
        await tx.systemSetting.upsert({
          where: { key: LEDGER_CREATION_INVITE_CODE_KEY },
          create: { key: LEDGER_CREATION_INVITE_CODE_KEY, value: serializeLedgerInviteCodeRecords(usedInviteRecords) },
          update: { value: serializeLedgerInviteCodeRecords(usedInviteRecords) },
        });
      }
      return result;
    });
  } catch (error) {
    logger.error("signup ledger creation failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "SIGNUP_FAILED", error: "Failed to create your account. Please try again." }, { status: 500, headers: cors() });
  }

  const response = NextResponse.json({
    ok: true,
    email,
    household: { id: created.household.id, name: created.household.name },
  }, { headers: cors() });

  const maxAge = resolveSessionMaxAge(req);
  const cookieOptions = sessionCookieOptions(maxAge, req);
  response.cookies.set(VERIFIED_COOKIE, createVerifiedSessionValue(created.adminUser.id, maxAge, created.adminUser.authVersion), cookieOptions);
  response.cookies.set(USER_ID_COOKIE, created.adminUser.id, cookieOptions);
  response.cookies.set(USERNAME_COOKIE, created.adminUser.name, cookieOptions);
  response.cookies.set(HOUSEHOLD_COOKIE, created.household.id, cookieOptions);

  return response;
}
