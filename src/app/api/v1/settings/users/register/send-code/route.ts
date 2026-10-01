import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { sendRegistrationVerificationEmail } from "@/lib/mail/registration";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
});

const CODE_TTL_MINUTES = 15;
const MAX_SENDS_PER_TARGET = 3; // per hour
const MAX_SENDS_PER_IP = 10; // per hour

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
 * POST /api/v1/settings/users/register/send-code
 *
 * Step 1 of the email-verified registration flow: validates the target user and
 * the email (must not be in use by another user), sends a 6-digit verification
 * code to the email, and stores a hashed single-use code in RegistrationCode.
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

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "EMAIL_CODE_NOT_CONFIGURED", error: "Email verification codes are not configured on this server." }, { status: 500, headers: cors() });
  }

  const now = Date.now();
  const windowStart = new Date(now - 60 * 60 * 1000);
  const ip = getClientIp(req);
  const [targetRecent, ipRecent] = await Promise.all([
    prisma.registrationCode.count({ where: { targetUserId: userId, createdAt: { gt: windowStart } } }),
    ip ? prisma.registrationCode.count({ where: { ip, createdAt: { gt: windowStart } } }) : Promise.resolve(0),
  ]);
  if (targetRecent >= MAX_SENDS_PER_TARGET || ipRecent >= MAX_SENDS_PER_IP) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many verification codes sent, please try again later." }, { status: 429, headers: cors() });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash("sha256").update(`${secret}:${userId}:${code}`).digest("hex");
  const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

  const created = await prisma.registrationCode.create({
    data: {
      targetUserId: userId,
      email: normalizedEmail,
      codeHash,
      expiresAt,
      ip: ip ?? undefined,
      userAgent: req.headers.get("user-agent") ?? undefined,
    },
    select: { id: true },
  });

  try {
    const mailRes = await sendRegistrationVerificationEmail({
      to: normalizedEmail,
      code,
      expiresMinutes: CODE_TTL_MINUTES,
      // MMH registration is a central service flow; it must not borrow a ledger SMTP account.
      allowSmtp: false,
    });
    if (!mailRes.ok) {
      await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete unsent registration code", "user-registration"));
      logger.warn(mailRes.error || "verification email sending failed", "user-registration");
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: mailRes.error }, { status: 500, headers: cors() });
    }
  } catch (error) {
    await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete failed registration code", "user-registration"));
    logger.error("verification email sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
