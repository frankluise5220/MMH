import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { registerEmailPrincipal } from "@/lib/server/registration-client";
import { getUserSessionDays, issueSessionCookies } from "@/lib/server/session-issue";

export const runtime = "nodejs";

const CONFIRM_ATTEMPT_LIMIT = 10;
const CONFIRM_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

declare global {
  var __registerConfirmAttempts: Map<string, number[]> | undefined;
}

const confirmAttempts = globalThis.__registerConfirmAttempts ??= new Map<string, number[]>();

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

function getClientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || null;
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim() || null;
  return null;
}

function isConfirmAttemptLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - CONFIRM_ATTEMPT_WINDOW_MS;
  const recent = (confirmAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  confirmAttempts.set(ip, recent);
  return recent.length >= CONFIRM_ATTEMPT_LIMIT;
}

function recordConfirmAttempt(ip: string) {
  const now = Date.now();
  const windowStart = now - CONFIRM_ATTEMPT_WINDOW_MS;
  const recent = (confirmAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  recent.push(now);
  confirmAttempts.set(ip, recent);
}

const ConfirmSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6).max(200).optional(),
  code: z.string().min(4).max(20),
});

/**
 * POST /api/v1/settings/users/register/confirm
 *
 * Step 2 of the email-verified registration flow: verifies the code that was sent
 * to the email, registers the email identity in the external mmh-registration
 * service, and makes the email a valid login name for the target user.
 *
 * Body: { userId, email, password?, code }
 * - The code is single-use and expires after 15 minutes.
 * - On success the returned principalId is stored on the user row. The email is
 *   updated to the verified address; a password is only required when the target
 *   user does not already have a local login password.
 * - Re-registering an already-registered user with the same email returns the
 *   existing principalId (idempotent) and still updates the local email/password.
 *
 * Requires an admin; the target must be the system admin (only the system admin
 * may register it) or a user of the operator's current household.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Not signed in." }, { status: 401, headers: cors() });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Admin permission required." }, { status: 403, headers: cors() });
  }
  const ip = getClientIp(req);
  if (ip && isConfirmAttemptLimited(ip)) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many attempts, please try again later." }, { status: 429, headers: cors() });
  }
  recordConfirmAttempt(ip ?? "unknown");

  const body = await req.json().catch(() => null);
  const parse = ConfirmSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "userId, email, password and code are required." }, { status: 400, headers: cors() });
  }

  const { userId, email, password, code } = parse.data;
  const normalizedEmail = email.trim().toLowerCase();

  const { householdId } = await getHouseholdScope();
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "User was not found." }, { status: 404, headers: cors() });
  }
  if (target.isSystem && !(currentUser.isSystem === true)) {
    return NextResponse.json({ ok: false, code: "SYSTEM_ADMIN_RESTRICTED", error: "Only the system admin can register the system admin." }, { status: 403, headers: cors() });
  }
  if (!target.isSystem && target.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Unauthorized target user." }, { status: 403, headers: cors() });
  }

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "EMAIL_CODE_NOT_CONFIGURED", error: "Email verification codes are not configured on this server." }, { status: 500, headers: cors() });
  }

  const codeHash = crypto.createHash("sha256").update(`${secret}:${userId}:${code.trim()}`).digest("hex");
  const token = await prisma.registrationCode.findFirst({
    where: {
      targetUserId: userId,
      email: normalizedEmail,
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

  // A password is now fully optional: an MMH identity can be bound to a user
  // without forcing a local login password (e.g. a pure fnOS-gateway account).
  // When supplied, it is set only if the target has no existing password.

  const emailTaken = await prisma.user.findFirst({
    where: { email: normalizedEmail, id: { not: userId } },
    select: { id: true },
  });
  if (emailTaken) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already used by another user." }, { status: 409, headers: cors() });
  }

  let principalId = target.registrationPrincipalId;
  if (!principalId) {
    const registration = await registerEmailPrincipal({ displayName: normalizedEmail, email: normalizedEmail });
    if (!registration.ok || !registration.principalId) {
      return NextResponse.json(
        { ok: false, code: registration.code ?? "REGISTRATION_SERVICE_ERROR", error: registration.error ?? "Registration service failed." },
        { status: registration.status ?? 502, headers: cors() },
      );
    }
    principalId = registration.principalId;
  }

  // Binding an email to an account must NOT clobber an existing login password.
  // A password is set only when one was supplied AND the target has no password
  // yet (and then bump authVersion to invalidate older sessions).
  const passwordWasSet = target.passwordHash == null && !!password;
  const passwordHash = passwordWasSet ? await hashPassword(password!.trim()) : null;
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        email: normalizedEmail,
        ...(passwordWasSet ? { passwordHash, authVersion: { increment: 1 } } : {}),
        ...(principalId ? { registrationPrincipalId: principalId } : {}),
      },
    });
    await tx.registrationCode.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
  });

  const response = NextResponse.json({ ok: true, principalId, email: normalizedEmail }, { headers: cors() });

  // Only re-mint the active session when we actually changed credentials (set a new
  // password) and the target is the currently signed-in user; otherwise the session
  // authVersion is untouched and the operator stays signed in.
  if (passwordWasSet && target.id === currentUser.id) {
    const newAuthVersion = target.authVersion + 1;
    issueSessionCookies(
      response,
      {
        userId: target.id,
        name: target.name,
        householdId: target.householdId,
        authVersion: newAuthVersion,
      },
      { sessionDays: await getUserSessionDays(target.id), req },
    );
  }

  return response;
}
