import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { isRegistrationConfigured, sendRegistrationCode } from "@/lib/server/registration-client";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  email: z.string().email(),
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
 * POST /api/v1/settings/users/add-mmah/send-code
 *
 * Step 1 of "add an MMH user" from the settings page: validates the email (must
 * not already belong to any user), then asks the central registration service to
 * generate and deliver a 6-digit code. The code is generated, stored, and emailed
 * entirely by that service.
 *
 * Body: { email }
 * Requires an admin. The email must not already be bound to any user in any
 * ledger (the email is the global MMH identity).
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Not signed in." }, { status: 401, headers: cors() });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Admin permission required." }, { status: 403, headers: cors() });
  }
  if (!isRegistrationConfigured()) {
    return NextResponse.json(
      { ok: false, code: "REGISTRATION_NOT_CONFIGURED", error: "The registration service is not configured on this server." },
      { status: 503, headers: cors() },
    );
  }

  const body = await req.json().catch(() => null);
  const parse = SendCodeSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "A valid email is required." }, { status: 400, headers: cors() });
  }

  const email = parse.data.email.trim().toLowerCase();

  await getHouseholdScope();

  const emailTaken = await prisma.user.findFirst({
    where: { email },
    select: { id: true },
  });
  if (emailTaken) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already registered." }, { status: 409, headers: cors() });
  }

  try {
    const result = await sendRegistrationCode({ email, purpose: "registration" });
    if (!result.ok) {
      logger.warn(result.error || "add-mmh verification email sending failed", "user-registration");
      const status = result.code === "RATE_LIMITED" ? 429 : 502;
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: result.error }, { status, headers: cors() });
    }
  } catch (error) {
    logger.error("add-mmh verification email sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
