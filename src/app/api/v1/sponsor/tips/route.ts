import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getCachedHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const AMOUNT_PATTERN = /^\d{1,5}(?:\.\d{1,2})?$/;
const MAX_AMOUNT = 99999.99;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SponsorTipRecord = {
  id: string;
  email: string;
  amount: { toString(): string };
  status: string;
  claimedAt: Date | null;
  createdAt: Date;
};

function tipResponse(record: SponsorTipRecord) {
  return {
    id: record.id,
    email: record.email,
    amount: record.amount.toString(),
    status: record.status,
    claimedAt: record.claimedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

function normalizeAmount(value: unknown) {
  const amount = typeof value === "string" ? value.trim() : "";
  if (!AMOUNT_PATTERN.test(amount)) return null;
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > MAX_AMOUNT) return null;
  return numericAmount.toFixed(2);
}

/**
 * POST /api/v1/sponsor/tips
 *
 * Records a self-reported sponsor tip after the user has paid through the
 * selected static Alipay QR code. The signed-in user and active household are
 * resolved on the server and cannot be supplied by the client.
 *
 * Body: { amount: string, email: string, customAmount?: boolean }
 * For a custom-amount QR, the amount is entered directly in Alipay. The
 * server stores 0.00 as an explicit unknown-amount marker for that case.
 * Response: { ok: true, data: SponsorTipIntent } on success.
 *
 * PATCH /api/v1/sponsor/tips
 *
 * Marks the current user's own tip intent as self-reported complete. Static QR
 * payments cannot be verified by this server.
 *
 * Body: { id: string }
 * Response: { ok: true, data: SponsorTipIntent } on success.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Authentication is required." }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const customAmount = body?.customAmount === true;
  const amount = customAmount ? "0.00" : normalizeAmount(body?.amount);
  const email = typeof body?.email === "string" ? body.email.trim() : "";

  if (!amount) {
    return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "Enter a valid amount greater than 0 with up to 2 decimal places." }, { status: 400 });
  }
  if (!email) {
    return NextResponse.json({ ok: false, code: "MISSING_EMAIL", error: "An email address is required." }, { status: 400 });
  }
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ ok: false, code: "INVALID_EMAIL", error: "Enter a valid email address." }, { status: 400 });
  }

  const { householdId } = await getCachedHouseholdScope();
  const record = await prisma.sponsorTipIntent.create({
    data: {
      userId: currentUser.id,
      householdId,
      email,
      amount,
      status: "claimed",
      claimedAt: new Date(),
    },
  });

  return NextResponse.json({ ok: true, data: tipResponse(record) }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Authentication is required." }, { status: 401 });
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_TIP_ID", error: "A tip intent id is required." }, { status: 400 });
  }

  const { householdId } = await getCachedHouseholdScope();
  const updated = await prisma.sponsorTipIntent.updateMany({
    where: { id, userId: currentUser.id, householdId },
    data: { status: "claimed", claimedAt: new Date() },
  });
  if (updated.count === 0) {
    return NextResponse.json({ ok: false, code: "TIP_NOT_FOUND", error: "Sponsor tip intent was not found." }, { status: 404 });
  }

  const record = await prisma.sponsorTipIntent.findFirst({
    where: { id, userId: currentUser.id, householdId },
  });
  if (!record) {
    return NextResponse.json({ ok: false, code: "TIP_NOT_FOUND", error: "Sponsor tip intent was not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, data: tipResponse(record) });
}
