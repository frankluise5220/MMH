import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { isRegistrationConfigured } from "@/lib/server/registration-client";
import { sendRegistrationVerificationEmail } from "@/lib/mail/registration";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  email: z.string().email(),
});

const CODE_TTL_MINUTES = 15;
const MAX_SENDS_PER_TARGET = 3; // per hour
const MAX_SENDS_PER_IP = 10; // per hour

// Adding an MMH user from the settings page has no user row yet (the row is
// only created after the code is confirmed), so RegistrationCode.targetUserId
// (non-nullable) is anchored to this sentinel. The verification hash is keyed
// on the email instead of a userId, so these codes can never collide with the
// admin-issued codes keyed on a real userId (settings/users/register/*).
const ADD_MMH_TARGET_ID = "add-mmah-pending";

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

/**
 * POST /api/v1/settings/users/add-mmah/send-code
 *
 * Step 1 of "add an MMH user" from the settings page: validates the email (must
 * not already belong to any user), sends a 6-digit verification code, and stores
 * a hashed single-use code in RegistrationCode anchored to ADD_MMH_TARGET_ID.
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

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "EMAIL_CODE_NOT_CONFIGURED", error: "Email verification codes are not configured on this server." }, { status: 500, headers: cors() });
  }

  const now = Date.now();
  const windowStart = new Date(now - 60 * 60 * 1000);
  const ip = getClientIp(req);
  const [targetRecent, ipRecent] = await Promise.all([
    prisma.registrationCode.count({ where: { targetUserId: ADD_MMH_TARGET_ID, email, createdAt: { gt: windowStart } } }),
    ip ? prisma.registrationCode.count({ where: { ip, createdAt: { gt: windowStart } } }) : Promise.resolve(0),
  ]);
  if (targetRecent >= MAX_SENDS_PER_TARGET || ipRecent >= MAX_SENDS_PER_IP) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many verification codes sent, please try again later." }, { status: 429, headers: cors() });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash("sha256").update(`${secret}:${ADD_MMH_TARGET_ID}:${email}:${code}`).digest("hex");
  const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

  const created = await prisma.registrationCode.create({
    data: {
      targetUserId: ADD_MMH_TARGET_ID,
      email,
      codeHash,
      expiresAt,
      ip: ip ?? undefined,
      userAgent: req.headers.get("user-agent") ?? undefined,
    },
    select: { id: true },
  });

  try {
    const mailRes = await sendRegistrationVerificationEmail({
      to: email,
      code,
      expiresMinutes: CODE_TTL_MINUTES,
      // Adding an MMH member is a central-service flow; it must not borrow a ledger SMTP account.
      allowSmtp: false,
    });
    if (!mailRes.ok) {
      await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete unsent add-mmh code", "user-registration"));
      logger.warn(mailRes.error || "add-mmh verification email sending failed", "user-registration");
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: mailRes.error }, { status: 500, headers: cors() });
    }
  } catch (error) {
    await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete failed add-mmh code", "user-registration"));
    logger.error("add-mmh verification email sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
