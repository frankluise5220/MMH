import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";
import { refuseMmhSessionBindingChange } from "@/lib/server/mmh-binding-guard";
import { queueLedgerInventoryReport } from "@/lib/server/ledger-inventory";

export const runtime = "nodejs";

const BindSchema = z.object({
  userId: z.string().min(1),
  username: z.string().email(),
  password: z.string().min(1).max(200),
  /**
   * Re-point an existing binding.
   *
   * A principalId is stable for one central account but not across registration
   * service instances: once the service this deployment was bound to is
   * repointed or rebuilt, the stored id no longer matches and MMH sign-in is
   * refused with MMH_BINDING_STALE. Re-verifying the membership password is the
   * repair — the central service answers with the account's current id, and that
   * answer is authoritative, so overwriting the row is safe by construction. It
   * still has to be asked for explicitly, so a stray request cannot silently
   * rebind an account to whatever identity the password happens to reach.
   */
  rebind: z.boolean().optional(),
});

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

/**
 * Binds a local user to an existing MMH identity.
 *
 * The MMH membership password is verified against the central mmh-registration
 * service (`verifyEmailPrincipal`); it is never compared against a local ledger
 * password hash. On success the returned principalId is stored on the target
 * user row, which links this ledger user to the shared MMH account.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Not signed in." }, { status: 401, headers: cors() });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Admin permission required." }, { status: 403, headers: cors() });
  }

  const mmhSessionRefusal = refuseMmhSessionBindingChange(currentUser.authMethod);
  if (mmhSessionRefusal) {
    return NextResponse.json(mmhSessionRefusal, { status: 403, headers: cors() });
  }

  const body = await req.json().catch(() => null);
  const parsed = BindSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "userId, MMH username and password are required." }, { status: 400, headers: cors() });
  }

  const { userId, username, password } = parsed.data;
  const { householdId } = await getHouseholdScope();
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, householdId: true, isSystem: true, registrationPrincipalId: true, registrationEmail: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "User was not found." }, { status: 404, headers: cors() });
  }
  if (target.isSystem && currentUser.isSystem !== true) {
    return NextResponse.json({ ok: false, code: "SYSTEM_ADMIN_RESTRICTED", error: "Only the system admin can manage the system admin." }, { status: 403, headers: cors() });
  }
  if (!target.isSystem && target.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Unauthorized target user." }, { status: 403, headers: cors() });
  }
  if (target.registrationPrincipalId && !parsed.data.rebind) {
    return NextResponse.json({ ok: false, code: "ALREADY_BOUND", error: "This user is already bound to an MMH user." }, { status: 409, headers: cors() });
  }

  const requestedEmail = username.trim().toLowerCase();
  const recordedAddress = (target.registrationEmail ?? "").trim().toLowerCase();
  // Re-verifying repairs ONE account, it does not move the user onto another
  // one. Switching a bound user to a different MMH account is a deliberate
  // unbind-then-bind: silently re-pointing an existing identity here would make
  // "re-bind" a way to swap whose account it is, from a dialog that reads like
  // a confirmation.
  //
  // A binding with no recorded address is exempt, and must be: it cannot answer
  // for ANY address, so every request would count as a "change" and the binding
  // could never be repaired. This path is the repair — the membership password
  // proves ownership and the service returns the account's CURRENT principal id,
  // which is exactly what gets written, so the row is re-aligned rather than
  // re-pointed. Blocking it here would make the "no address recorded" guidance
  // (which sends the user to re-verify) a dead end.
  if (target.registrationPrincipalId && recordedAddress && requestedEmail !== recordedAddress) {
    return NextResponse.json(
      {
        ok: false,
        code: "MMH_ALREADY_BOUND_OTHER",
        error: "该账号已绑定其他 MMH 账号。如需更换，请先取消绑定再绑定新的 MMH 账号。",
      },
      { status: 409, headers: cors() },
    );
  }

  // Verify the membership credentials against the central registration service.
  const verification = await verifyEmailPrincipal({
    email: requestedEmail,
    password: password.trim(),
  });
  if (!verification.ok || !verification.principalId) {
    return NextResponse.json(
      { ok: false, code: verification.code ?? "MMH_CREDENTIAL_VERIFICATION_FAILED", error: verification.error ?? "MMH credential verification failed." },
      { status: verification.status ?? 502, headers: cors() },
    );
  }

  const principalId = verification.principalId;
  await prisma.user.update({
    where: { id: userId },
    data: {
      // Only the MMH columns move. `User.email` is the local contact address
      // (it is how the local account is looked up for password recovery) and
      // must not be overwritten by the membership address — binding an MMH
      // account is not a request to change who the local user is.
      registrationPrincipalId: principalId,
      registrationEmail: requestedEmail,
    },
  });

  // The ledger now carries one more MMH-bound member; refresh the inventory.
  queueLedgerInventoryReport("mmh-bound");

  return NextResponse.json(
    { ok: true, principalId, email: requestedEmail },
    { headers: cors() },
  );
}
