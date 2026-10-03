import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { registerEmailPrincipal, setEmailPrincipalPassword } from "@/lib/server/registration-client";
import { DEFAULT_SESSION_DAYS, normalizeSessionDays } from "@/lib/session-days";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const ConfirmSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(20),
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(["admin", "user", "viewer"]).default("user"),
  // Optional MMH membership password (stored in the central registration service).
  mmhPassword: z.string().min(6).max(200).optional(),
});

const CONFIRM_ATTEMPT_LIMIT = 10;
const CONFIRM_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// See add-mmah/send-code: the code is anchored to this sentinel until the user
// row is created on confirm.
const ADD_MMH_TARGET_ID = "add-mmah-pending";

declare global {
  var __addMmhConfirmAttempts: Map<string, number[]> | undefined;
}

const confirmAttempts = globalThis.__addMmhConfirmAttempts ??= new Map<string, number[]>();

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

/**
 * POST /api/v1/settings/users/add-mmah/confirm
 *
 * Step 2 of "add an MMH user" from the settings page: verifies the code, registers
 * the email identity in the external mmh-registration service, then creates a new
 * user row in the current household bound to that MMH identity. The new user has
 * NO local password (pure MMH login); an optional MMH membership password is set
 * on the central principal.
 *
 * Body: { email, code, name?, role?, mmhPassword? }
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
  const ip = getClientIp(req);
  if (ip && isConfirmAttemptLimited(ip)) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many attempts, please try again later." }, { status: 429, headers: cors() });
  }
  recordConfirmAttempt(ip ?? "unknown");

  const body = await req.json().catch(() => null);
  const parse = ConfirmSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "email and code are required." }, { status: 400, headers: cors() });
  }

  const email = parse.data.email.trim().toLowerCase();
  const code = parse.data.code.trim();
  const name = parse.data.name?.trim() || email.split("@")[0] || "user";
  const role = parse.data.role;

  const { householdId } = await getHouseholdScope();

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "EMAIL_CODE_NOT_CONFIGURED", error: "Email verification codes are not configured on this server." }, { status: 500, headers: cors() });
  }

  const codeHash = crypto.createHash("sha256").update(`${secret}:${ADD_MMH_TARGET_ID}:${email}:${code}`).digest("hex");
  const token = await prisma.registrationCode.findFirst({
    where: {
      targetUserId: ADD_MMH_TARGET_ID,
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

  const emailTaken = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });
  if (emailTaken) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already registered." }, { status: 409, headers: cors() });
  }

  // Register the central MMH principal first — a failure here must not leave a
  // half-created local user row.
  const registration = await registerEmailPrincipal({ displayName: name, email });
  if (!registration.ok || !registration.principalId) {
    return NextResponse.json(
      { ok: false, code: registration.code ?? "REGISTRATION_SERVICE_ERROR", error: registration.error ?? "Registration service failed." },
      { status: registration.status ?? 502, headers: cors() },
    );
  }
  const principalId = registration.principalId;

  // Set the MMH membership password on the freshly created principal, if supplied.
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
      await tx.registrationCode.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
      return user;
    });
  } catch (error) {
    logger.error("add-mmh user creation failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "ADD_MMH_FAILED", error: "Failed to add the MMH user. Please try again." }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    user: { ...createdUser, registrationPrincipalId: principalId },
  }, { headers: cors() });
}
