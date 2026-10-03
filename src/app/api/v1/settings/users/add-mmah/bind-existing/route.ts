import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";
import { DEFAULT_SESSION_DAYS, normalizeSessionDays } from "@/lib/session-days";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const BindSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "user", "viewer"]).default("user"),
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
 * POST /api/v1/settings/users/add-mmah/bind-existing
 *
 * Adds a new user bound to an *existing* MMH identity. The membership password is
 * verified against the central mmh-registration service (`verifyEmailPrincipal`);
 * it is never compared against a local ledger password hash. On success a new
 * user row is created in the current household bound to that MMH identity, with
 * no local password (pure MMH login).
 *
 * Body: { email, password, name?, role? }
 * Requires an admin. The email must not already be bound to any user.
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
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "MMH username and password are required." }, { status: 400, headers: cors() });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const password = parsed.data.password.trim();
  const name = parsed.data.name?.trim() || email.split("@")[0] || "user";
  const role = parsed.data.role;

  const { householdId } = await getHouseholdScope();

  const emailTaken = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });
  if (emailTaken) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already bound to a user." }, { status: 409, headers: cors() });
  }

  // Verify the membership credentials against the central registration service.
  const verification = await verifyEmailPrincipal({ email, password });
  if (!verification.ok || !verification.principalId) {
    return NextResponse.json(
      { ok: false, code: verification.code ?? "MMH_CREDENTIAL_VERIFICATION_FAILED", error: verification.error ?? "MMH credential verification failed." },
      { status: verification.status ?? 502, headers: cors() },
    );
  }
  const principalId = verification.principalId;

  let createdUser: { id: string; name: string; email: string | null; role: string } | null = null;
  try {
    createdUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          role,
          householdId,
          registrationPrincipalId: principalId,
          // Pure MMH account: no local password.
        },
        select: { id: true, name: true, email: true, role: true },
      });
      await tx.userSettings.create({
        data: {
          userId: user.id,
          sessionDays: normalizeSessionDays(undefined, DEFAULT_SESSION_DAYS),
        },
      });
      return user;
    });
  } catch (error) {
    logger.error("add-mmh bind-existing user creation failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "ADD_MMH_FAILED", error: "Failed to add the MMH user. Please try again." }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    user: { ...createdUser, registrationPrincipalId: principalId },
  }, { headers: cors() });
}
