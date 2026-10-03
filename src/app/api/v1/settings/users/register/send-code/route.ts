import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { sendRegistrationCode } from "@/lib/server/registration-client";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  userId: z.string().min(1),
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
 * POST /api/v1/settings/users/register/send-code
 *
 * Step 1 of the email-verified registration flow: validates the target user and
 * the email (must not be in use by another user), then asks the central
 * registration service to generate and deliver a 6-digit code.
 *
 * Body: { userId, email }
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
  const body = await req.json().catch(() => null);
  const parse = SendCodeSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "userId and email are required." }, { status: 400, headers: cors() });
  }

  const { userId, email } = parse.data;
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

  const emailTaken = await prisma.user.findFirst({
    where: { email: normalizedEmail, id: { not: userId } },
    select: { id: true },
  });
  if (emailTaken) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_EMAIL", error: "This email is already used by another user." }, { status: 409, headers: cors() });
  }

  try {
    const result = await sendRegistrationCode({ email: normalizedEmail, purpose: "registration" });
    if (!result.ok) {
      logger.warn(result.error || "verification email sending failed", "user-registration");
      const status = result.code === "RATE_LIMITED" ? 429 : 502;
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: result.error }, { status, headers: cors() });
    }
  } catch (error) {
    logger.error("verification email sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
