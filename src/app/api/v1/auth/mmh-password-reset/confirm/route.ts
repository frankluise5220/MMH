import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setEmailPrincipalPassword, verifyRegistrationCode } from "@/lib/server/registration-client";

export const runtime = "nodejs";

const CONFIRM_ATTEMPT_LIMIT = 10;
const CONFIRM_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

declare global {
  var __mmhResetConfirmAttempts: Map<string, number[]> | undefined;
}

const confirmAttempts = globalThis.__mmhResetConfirmAttempts ??= new Map<string, number[]>();

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

function isLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - CONFIRM_ATTEMPT_WINDOW_MS;
  const recent = (confirmAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  confirmAttempts.set(ip, recent);
  return recent.length >= CONFIRM_ATTEMPT_LIMIT;
}

function record(ip: string) {
  const now = Date.now();
  const windowStart = now - CONFIRM_ATTEMPT_WINDOW_MS;
  const recent = (confirmAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  recent.push(now);
  confirmAttempts.set(ip, recent);
}

const ConfirmSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(20),
  newPassword: z.string().min(8).max(128),
});

/**
 * POST /api/v1/auth/mmh-password-reset/confirm
 *
 * Resets the MMH membership password. Verifies the email code, then calls
 * setEmailPrincipalPassword on the central registration service. The password
 * is only ever sent to that service over the bearer-authenticated connection;
 * it is never persisted or logged locally.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (ip && isLimited(ip)) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many attempts, please try again later." }, { status: 429, headers: cors() });
  }
  record(ip ?? "unknown");

  const body = await req.json().catch(() => null);
  const parse = ConfirmSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "email, code and a new password (8-128 chars) are required." }, { status: 400, headers: cors() });
  }

  const { email, code, newPassword } = parse.data;
  const normalizedEmail = email.trim().toLowerCase();

  // The code is verified by the central registration service, which issued it.
  const codeResult = await verifyRegistrationCode({
    email: normalizedEmail,
    purpose: "password-reset",
    code: code.trim(),
  });
  if (!codeResult.ok) {
    const status = codeResult.code === "RATE_LIMITED" || codeResult.code === "TOO_MANY_ATTEMPTS" ? 429 : 400;
    return NextResponse.json({ ok: false, code: "INVALID_OR_EXPIRED_CODE", error: "The verification code is invalid or has expired." }, { status, headers: cors() });
  }

  const setPassword = await setEmailPrincipalPassword({ email: normalizedEmail, password: newPassword.trim() });
  if (!setPassword.ok) {
    return NextResponse.json(
      { ok: false, code: setPassword.code ?? "MMH_PASSWORD_RESET_FAILED", error: setPassword.error ?? "Failed to reset the MMH membership password." },
      { status: setPassword.status ?? 502, headers: cors() },
    );
  }

  return NextResponse.json({ ok: true, principalId: setPassword.principalId }, { headers: cors() });
}
