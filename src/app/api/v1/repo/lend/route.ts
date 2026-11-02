import { NextRequest, NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { lendRepo } from "@/lib/server/repo-transactions";

export const runtime = "nodejs";

function text(raw: unknown): string {
  return String(raw ?? "").trim();
}

function positiveNumber(raw: unknown): number | null {
  const value = Number(String(raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * POST /api/v1/repo/lend —— 逆回购借出（一笔 = 一张存单）。
 *
 * Body:
 * - accountId: 债券账户（券商账户）
 * - cashAccountId: 券商资金账户
 * - date: 成交日 yyyy-MM-dd
 * - code: 品种代码，如 204001
 * - amount: 借出本金
 * - annualRate?: 成交年化（%）
 * - termDays? / maturityDate? / fee? / note?
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const accountId = text(body.accountId);
    const cashAccountId = text(body.cashAccountId);
    const date = text(body.date);
    const code = text(body.code);
    const amount = positiveNumber(body.amount);
    if (!accountId) return NextResponse.json({ error: "请选择债券账户" }, { status: 400 });
    if (!cashAccountId) return NextResponse.json({ error: "请选择资金账户" }, { status: 400 });
    if (!date) return NextResponse.json({ error: "请选择成交日期" }, { status: 400 });
    if (!code) return NextResponse.json({ error: "请选择逆回购品种" }, { status: 400 });
    if (!amount) return NextResponse.json({ error: "借出金额不正确" }, { status: 400 });

    const result = await lendRepo({
      householdId,
      accountId,
      cashAccountId,
      date,
      code,
      amount,
      annualRate: positiveNumber(body.annualRate),
      termDays: positiveNumber(body.termDays),
      maturityDate: text(body.maturityDate) || null,
      fee: body.fee == null || text(body.fee) === "" ? null : Number(body.fee),
      note: text(body.note),
      tagIds: Array.isArray(body.tagIds) ? body.tagIds.filter((id: unknown): id is string => typeof id === "string") : [],
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "逆回购借出失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
