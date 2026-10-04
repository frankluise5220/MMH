import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveTemplateLang, sendRegistrationCode } from "@/lib/server/registration-client";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

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

const BodySchema = z.object({
  email: z.string().email(),
});

/**
 * POST /api/v1/auth/mmh-password-reset/send-code
 *
 * Asks the central mmh-registration service to generate and deliver a
 * verification code for resetting the MMH membership password. The code is
 * generated, stored, and emailed entirely by that service (through its local
 * Postfix); the MMH app no longer mints or sends these codes itself.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "A valid email is required." }, { status: 400, headers: cors() });
  }

  const email = parse.data.email.trim().toLowerCase();
  const lang = resolveTemplateLang(req.cookies.get("mmh_display_language")?.value);

  try {
    const result = await sendRegistrationCode({ email, purpose: "password-reset", lang });
    if (!result.ok) {
      logger.warn(result.error || "mmh password-reset code sending failed", "user-registration");
      // Map the registration-service verdict onto the historical MMH error code
      // so the client's error handling does not change.
      const code = result.code === "REGISTRATION_NOT_CONFIGURED"
        ? "REGISTRATION_NOT_CONFIGURED"
        : result.code === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : "EMAIL_SEND_FAILED";
      const status = result.code === "REGISTRATION_NOT_CONFIGURED" ? 503 : result.code === "RATE_LIMITED" ? 429 : 502;
      return NextResponse.json({ ok: false, code, error: result.error }, { status, headers: cors() });
    }
  } catch (error) {
    logger.error("mmh password-reset code sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
