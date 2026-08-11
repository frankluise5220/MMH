import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { getStockFeeRuleByDate, normalizeStockFeeType, normalizeStockTradeDirection, setStockFeeRule } from "@/lib/stock/feeRule";
import { normalizeStockCode, normalizeStockMarket } from "@/lib/stock/securities";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function utcDate(raw: string | null) {
  if (!raw) return new Date();
  const [y, m, d] = raw.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function assertStockAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: "investment", investProductType: "stock" },
    select: { id: true },
  });
  if (!account) throw new Error("股票账户不存在或不属于当前账簿");
}

/**
 * GET /api/v1/stocks/fee-rules
 * Gets the effective stock fee rule for an account/security/date.
 *
 * Query:
 * - accountId: string
 * - feeType: "commission" | "stamp_tax" | "transfer_fee" | "exchange_fee" | "regulatory_fee" | "platform_fee" | "other"
 * - direction?: "buy" | "sell" | "both"
 * - tradeDate?: YYYY-MM-DD
 * - securityId?: string
 * - market?: string
 * - stockCode?: string
 *
 * Response:
 * - { ok: true, data: { rule } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || "";
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少股票账户" }, { status: 400, headers: corsHeaders() });
    await assertStockAccount(accountId, householdId);

    const feeType = normalizeStockFeeType(req.nextUrl.searchParams.get("feeType"));
    const direction = normalizeStockTradeDirection(req.nextUrl.searchParams.get("direction"));
    const tradeDate = utcDate(req.nextUrl.searchParams.get("tradeDate"));
    const securityId = req.nextUrl.searchParams.get("securityId")?.trim() || null;
    const marketRaw = req.nextUrl.searchParams.get("market")?.trim() || "";
    const stockCodeRaw = req.nextUrl.searchParams.get("stockCode")?.trim() || "";
    const rule = await getStockFeeRuleByDate({
      accountId,
      feeType,
      direction,
      tradeDate,
      securityId,
      market: marketRaw ? normalizeStockMarket(marketRaw) : null,
      stockCode: stockCodeRaw ? normalizeStockCode(stockCodeRaw) : null,
    });

    return NextResponse.json({
      ok: true,
      data: {
        rule: rule
          ? {
              id: rule.id,
              accountId: rule.accountId,
              securityId: rule.securityId,
              market: rule.market,
              stockCode: rule.stockCode,
              feeType: rule.feeType,
              direction: rule.direction,
              rate: rule.rate == null ? null : Number(rule.rate),
              amount: rule.amount == null ? null : Number(rule.amount),
              minAmount: rule.minAmount == null ? null : Number(rule.minAmount),
              currency: rule.currency,
              effectiveDate: rule.effectiveDate.toISOString().slice(0, 10),
              source: rule.source,
              note: rule.note,
            }
          : null,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "查询失败" }, { status: 500, headers: corsHeaders() });
  }
}

/**
 * POST /api/v1/stocks/fee-rules
 * Adds a stock fee rule.
 *
 * Body:
 * - accountId: string
 * - feeType: string
 * - direction?: string
 * - rate?: number
 * - amount?: number
 * - minAmount?: number
 * - effectiveDate?: YYYY-MM-DD
 * - securityId?: string
 * - market?: string
 * - stockCode?: string
 * - currency?: string
 * - note?: string
 *
 * Response:
 * - { ok: true, data: { rule } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少股票账户" }, { status: 400, headers: corsHeaders() });
    await assertStockAccount(accountId, householdId);

    const effectiveDateRaw = String(body.effectiveDate ?? "").trim();
    const rule = await setStockFeeRule({
      accountId,
      feeType: body.feeType,
      direction: body.direction,
      rate: body.rate,
      amount: body.amount,
      minAmount: body.minAmount,
      effectiveDate: effectiveDateRaw ? utcDate(effectiveDateRaw) : null,
      securityId: String(body.securityId ?? "").trim() || null,
      market: String(body.market ?? "").trim() || null,
      stockCode: String(body.stockCode ?? "").trim() || null,
      currency: body.currency,
      source: "manual",
      note: body.note,
    });

    return NextResponse.json({
      ok: true,
      data: {
        rule: {
          id: rule.id,
          accountId: rule.accountId,
          securityId: rule.securityId,
          market: rule.market,
          stockCode: rule.stockCode,
          feeType: rule.feeType,
          direction: rule.direction,
          rate: rule.rate == null ? null : Number(rule.rate),
          amount: rule.amount == null ? null : Number(rule.amount),
          minAmount: rule.minAmount == null ? null : Number(rule.minAmount),
          currency: rule.currency,
          effectiveDate: rule.effectiveDate.toISOString().slice(0, 10),
          source: rule.source,
          note: rule.note,
        },
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "保存失败" }, { status: 500, headers: corsHeaders() });
  }
}
