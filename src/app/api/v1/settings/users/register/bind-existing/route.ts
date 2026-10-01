import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";

export const runtime = "nodejs";

const BindSchema = z.object({
  userId: z.string().min(1),
  username: z.string().email(),
  password: z.string().min(1).max(200),
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

  const body = await req.json().catch(() => null);
  const parsed = BindSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "userId, MMH username and password are required." }, { status: 400, headers: cors() });
  }

  const { userId, username, password } = parsed.data;
  const { householdId } = await getHouseholdScope();
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, householdId: true, isSystem: true, registrationPrincipalId: true, email: true },
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
  if (target.registrationPrincipalId) {
    return NextResponse.json({ ok: false, code: "ALREADY_BOUND", error: "This user is already bound to an MMH user." }, { status: 409, headers: cors() });
  }

  // Verify the membership credentials against the central registration service.
  const verification = await verifyEmailPrincipal({
    email: username.trim().toLowerCase(),
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
      email: username.trim().toLowerCase(),
      registrationPrincipalId: principalId,
    },
  });

  return NextResponse.json(
    { ok: true, principalId, email: username.trim().toLowerCase() },
    { headers: cors() },
  );
}
