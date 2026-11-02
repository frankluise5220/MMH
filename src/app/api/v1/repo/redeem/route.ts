import { NextRequest, NextResponse } from "next/server";

import { todayDateBusinessYmd } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { redeemRepo } from "@/lib/server/repo-transactions";

export const runtime = "nodejs";

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

function optionalNumber(raw: unknown): number | null {
  if (raw == null || text(raw) === "") return null;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * POST /api/v1/repo/redeem —— 逆回购到期回款（本息回到券商资金账户）。
 *
 * Body:
 * - lotId: 借出时的存单 id
 * - arrivalDate?: 回款日 yyyy-MM-dd（默认今天）
 * - cashAccountId?: 到账账户（默认沿用借出时的券商资金账户）
 * - arrivalAmount?: 实际到账本息；留空按本金 + 利息
 * - interest?: 实际利息；留空按占款天数重算
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const lotId = text(body.lotId);
    if (!lotId) return NextResponse.json({ error: "缺少逆回购存单" }, { status: 400 });

    const result = await redeemRepo({
      householdId,
      lotId,
      arrivalDate: text(body.arrivalDate) || todayDateBusinessYmd(),
      cashAccountId: text(body.cashAccountId) || null,
      arrivalAmount: optionalNumber(body.arrivalAmount),
      interest: optionalNumber(body.interest),
      note: text(body.note),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "逆回购回款失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
