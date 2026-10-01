import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { sendRegistrationVerificationEmail } from "@/lib/mail/registration";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const CODE_TTL_MINUTES = 15;
const MAX_SENDS_PER_TARGET = 5;
const MAX_SENDS_PER_IP = 10;

// Fixed scope id so MMH membership password-reset codes live in their own
// namespace, separate from public signup (SIGNUP_TARGET_ID) and ledger-local
// password reset (PasswordResetToken).
const MMH_RESET_TARGET_ID = "mmh-password-reset";

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

const BodySchema = z.object({
  email: z.string().email(),
});

/**
 * POST /api/v1/auth/mmh-password-reset/send-code
 *
 * Sends a verification code to the given email for resetting the MMH membership
 * password (stored in the central mmh-registration service). The email is the
 * membership identity (provider=email, issuer=mmh); no local ledger user is
 * required. Uses the relay/Resend path (never a ledger SMTP account).
 */
export async function POST(req: NextRequest) {
  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "EMAIL_CODE_NOT_CONFIGURED", error: "Email verification codes are not configured on this server." }, { status: 500, headers: cors() });
  }

  const body = await req.json().catch(() => null);
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "A valid email is required." }, { status: 400, headers: cors() });
  }

  const email = parse.data.email.trim().toLowerCase();
  const ip = getClientIp(req);

  const now = Date.now();
  const windowStart = new Date(now - 60 * 60 * 1000);
  const [targetRecent, ipRecent] = await Promise.all([
    prisma.registrationCode.count({ where: { targetUserId: MMH_RESET_TARGET_ID, email, createdAt: { gt: windowStart } } }),
    ip ? prisma.registrationCode.count({ where: { ip, createdAt: { gt: windowStart } } }) : Promise.resolve(0),
  ]);
  if (targetRecent >= MAX_SENDS_PER_TARGET || ipRecent >= MAX_SENDS_PER_IP) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many verification codes sent, please try again later." }, { status: 429, headers: cors() });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash("sha256").update(`${secret}:${MMH_RESET_TARGET_ID}:${email}:${code}`).digest("hex");
  const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

  const created = await prisma.registrationCode.create({
    data: {
      targetUserId: MMH_RESET_TARGET_ID,
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
      allowSmtp: false,
    });
    if (!mailRes.ok) {
      await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete unsent mmh reset code", "user-registration"));
      logger.warn(mailRes.error || "mmh password-reset code sending failed", "user-registration");
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: mailRes.error }, { status: 500, headers: cors() });
    }
  } catch (error) {
    await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete failed mmh reset code", "user-registration"));
    logger.error("mmh password-reset code sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
