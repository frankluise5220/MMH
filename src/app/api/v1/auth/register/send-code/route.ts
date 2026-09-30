import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { isRegistrationConfigured } from "@/lib/server/registration-client";
import { sendRegistrationVerificationEmail } from "@/lib/mail/registration";
import {
  activeLedgerInviteCodes,
  findLedgerInviteCodeRecord,
  parseLedgerInviteCodeRecords,
} from "@/lib/ledger-invite-codes";
import { LEDGER_CREATION_INVITE_CODE_KEY } from "@/lib/households/create-ledger";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  email: z.string().email(),
  inviteCode: z.string().trim().optional(),
});

const CODE_TTL_MINUTES = 15;
const MAX_SENDS_PER_TARGET = 3; // per hour
const MAX_SENDS_PER_IP = 10; // per hour

// A self-service signup has no user row yet, so the RegistrationCode.targetUserId
// (non-nullable) is anchored to this sentinel. The verification hash is keyed on
// the email instead of a userId, so signup codes and admin-issued codes (keyed on
// a real userId) can never collide.
const SIGNUP_TARGET_ID = "signup-pending";

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
 * POST /api/v1/auth/register/send-code
 *
 * Step 1 of the public self-service signup flow (no session required): validates
 * the email (must not already belong to an existing user), sends a 6-digit
 * verification code, and stores a hashed single-use code in RegistrationCode.
 *
 * Body: { email }
 */
export async function POST(req: NextRequest) {
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
  const inviteCode = parse.data.inviteCode?.trim() ?? "";

  if (inviteCode) {
    const inviteSetting = await prisma.systemSetting.findUnique({ where: { key: LEDGER_CREATION_INVITE_CODE_KEY } });
    const inviteRecords = parseLedgerInviteCodeRecords(inviteSetting?.value);
    const inviteRecord = findLedgerInviteCodeRecord(inviteRecords, inviteCode);
    if (!inviteRecord || inviteRecord.usedAt) {
      return NextResponse.json({ ok: false, code: "INVITE_CODE_INVALID", error: "The invite code is invalid or has already been used." }, { status: 403, headers: cors() });
    }
    if (activeLedgerInviteCodes(inviteRecords).length === 0) {
      return NextResponse.json({ ok: false, code: "INVITE_CODE_CLOSED", error: "Ledger creation is currently closed." }, { status: 403, headers: cors() });
    }
  }

  // Self-service signup only bootstraps the very first ledger on an empty
  // deployment. Once any ledger or user exists, opening a new ledger is a
  // separate, invite-gated action and must not be reachable through signup.
  const [householdCount, userCount] = await prisma.$transaction([
    prisma.household.count(),
    prisma.user.count(),
  ]);
  if (!inviteCode && (householdCount > 0 || userCount > 0)) {
    return NextResponse.json({ ok: false, code: "SIGNUP_CLOSED", error: "Registration is only available before the first ledger is created." }, { status: 403, headers: cors() });
  }

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
    prisma.registrationCode.count({ where: { targetUserId: SIGNUP_TARGET_ID, email, createdAt: { gt: windowStart } } }),
    ip ? prisma.registrationCode.count({ where: { ip, createdAt: { gt: windowStart } } }) : Promise.resolve(0),
  ]);
  if (targetRecent >= MAX_SENDS_PER_TARGET || ipRecent >= MAX_SENDS_PER_IP) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "Too many verification codes sent, please try again later." }, { status: 429, headers: cors() });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = crypto.createHash("sha256").update(`${secret}:${email}:${code}`).digest("hex");
  const expiresAt = new Date(now + CODE_TTL_MINUTES * 60 * 1000);

  const created = await prisma.registrationCode.create({
    data: {
      targetUserId: SIGNUP_TARGET_ID,
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
    });
    if (!mailRes.ok) {
      await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete unsent signup code", "user-registration"));
      logger.warn(mailRes.error || "signup verification email sending failed", "user-registration");
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: mailRes.error }, { status: 500, headers: cors() });
    }
  } catch (error) {
    await prisma.registrationCode.delete({ where: { id: created.id } }).catch(logger.catchSilent("delete failed signup code", "user-registration"));
    logger.error("signup verification email sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
