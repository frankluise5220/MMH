import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { isRegistrationConfigured, sendRegistrationCode } from "@/lib/server/registration-client";
import {
  activeLedgerInviteCodes,
  parseLedgerInviteCodeRecords,
} from "@/lib/ledger-invite-codes";
import { LEDGER_CREATION_INVITE_CODE_KEY } from "@/lib/households/create-ledger";
import { logger } from "@/lib/logger";
import { inspectLedgerInviteCode, missingIssuerRejection } from "@/lib/server/ledger-invite-code-guard";

export const runtime = "nodejs";

const SendCodeSchema = z.object({
  email: z.string().email(),
  inviteCode: z.string().trim().optional(),
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
 * POST /api/v1/auth/register/send-code
 *
 * Step 1 of the public self-service signup flow (no session required): validates
 * the email (must not already belong to an existing user), then asks the central
 * registration service to generate and deliver a 6-digit code. The code is
 * generated, stored, and emailed entirely by that service.
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
    // Each failure mode gets its own code + message: "invalid / another system /
    // already used" in one string left signups undiagnosable from the UI.
    const inspection = inspectLedgerInviteCode(inviteRecords, inviteCode);
    if (!inspection.ok) {
      const { rejection } = inspection;
      return NextResponse.json({ ok: false, code: rejection.code, error: rejection.message }, { status: rejection.status, headers: cors() });
    }
    const issuerHousehold = await prisma.household.findUnique({
      where: { id: inspection.record.issuerHouseholdId },
      select: { id: true },
    });
    if (!issuerHousehold) {
      const rejection = missingIssuerRejection();
      return NextResponse.json({ ok: false, code: rejection.code, error: rejection.message }, { status: rejection.status, headers: cors() });
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

  try {
    const result = await sendRegistrationCode({ email, purpose: "registration" });
    if (!result.ok) {
      logger.warn(result.error || "signup verification email sending failed", "user-registration");
      const status = result.code === "RATE_LIMITED" ? 429 : 502;
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: result.error }, { status, headers: cors() });
    }
  } catch (error) {
    logger.error("signup verification email sending failed", "user-registration", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "verification email sending failed" }, { status: 500, headers: cors() });
  }

  return NextResponse.json({
    ok: true,
    message: "A verification code email has been sent. Please check the inbox or spam folder.",
  }, { headers: cors() });
}
