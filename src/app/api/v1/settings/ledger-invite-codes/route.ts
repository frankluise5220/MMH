import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import {
  isLedgerInviteCodeExpired,
  parseLedgerInviteCodeRecords,
} from "@/lib/ledger-invite-codes";
import { LEDGER_CREATION_INVITE_CODE_KEY } from "@/lib/households/create-ledger";
import { isLedgerInviteCodeSigningAvailable, ledgerInviteCodeSignatureState } from "@/lib/server/ledger-invite-code-signing";

/**
 * GET /api/v1/settings/ledger-invite-codes
 *
 * Admin-only read of the invite-code list, annotated with the *same* verdict the
 * redemption endpoints use.
 *
 * The settings page previously derived the status badge from `usedAt` /
 * `expiresAt` only, so a code that could never be redeemed — foreign signature,
 * or a server running without `MMH_SESSION_SECRET` — was still shown as
 * available while the redeemer got "invalid / another system / already used".
 * That mismatch is exactly what makes a failed signup undiagnosable, so the
 * verdict is computed server-side (only the server can verify the HMAC) and
 * rendered as-is.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可读取邀请码" }, { status: 403 });
  }
  const row = await prisma.systemSetting.findUnique({ where: { key: LEDGER_CREATION_INVITE_CODE_KEY } });
  const records = parseLedgerInviteCodeRecords(row?.value ?? null).map((record) => {
    const signatureState = ledgerInviteCodeSignatureState(record);
    const expired = !record.usedAt && isLedgerInviteCodeExpired(record);
    return {
      ...record,
      signatureState,
      expired,
      redeemable: !record.usedAt && !expired && signatureState === "valid",
    };
  });
  return NextResponse.json({
    ok: true,
    // False when this deployment cannot sign/verify at all (production without
    // MMH_SESSION_SECRET); every code then reports signatureState "unavailable".
    signingAvailable: isLedgerInviteCodeSigningAvailable(),
    records,
  });
}
