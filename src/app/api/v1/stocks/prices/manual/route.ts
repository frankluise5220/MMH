import { NextRequest, NextResponse } from "next/server";
import type { StockSecurity } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { normalizeStockCode, normalizeStockMarket } from "@/lib/stock/market";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * PUT /api/v1/stocks/prices/manual
 * Writes one manually entered closing price into StockPriceCache (source
 * "manual") and recalculates the account's stock holdings from it.
 *
 * Body:
 * - accountId: stock account id
 * - securityId?: security id (preferred lookup key)
 * - market?: string; used with stockCode as the fallback lookup
 * - stockCode?: string
 * - priceDate: YYYY-MM-DD
 * - closePrice: number > 0
 *
 * Response:
 * - { ok: true, data: { price } }
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as {
      accountId?: unknown;
      securityId?: unknown;
      market?: unknown;
      stockCode?: unknown;
      priceDate?: unknown;
      closePrice?: unknown;
    } | null;

    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少股票账户" }, { status: 400, headers: corsHeaders() });
    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: "investment", investProductType: "stock" },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, error: "股票账户不存在或不属于当前账簿" }, { status: 400, headers: corsHeaders() });
    }

    const priceDateRaw = String(body?.priceDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDateRaw)) {
      return NextResponse.json({ ok: false, error: "日期格式应为 YYYY-MM-DD" }, { status: 400, headers: corsHeaders() });
    }
    const closePrice = Number(body?.closePrice);
    if (!Number.isFinite(closePrice) || closePrice <= 0) {
      return NextResponse.json({ ok: false, error: "收盘价必须是大于 0 的数字" }, { status: 400, headers: corsHeaders() });
    }

    const securityIdRaw = String(body?.securityId ?? "").trim();
    const stockCode = normalizeStockCode(String(body?.stockCode ?? ""));
    const market = normalizeStockMarket(String(body?.market ?? ""));

    let security: StockSecurity | null = null;
    if (securityIdRaw) {
      security = await prisma.stockSecurity.findFirst({ where: { id: securityIdRaw, householdId } });
    }
    if (!security && stockCode) {
      security = await prisma.stockSecurity.findUnique({
        where: { householdId_market_stockCode: { householdId, market, stockCode } },
      });
    }
    if (!security) {
      return NextResponse.json({ ok: false, error: "未找到对应股票，无法保存收盘价" }, { status: 400, headers: corsHeaders() });
    }

    const priceDate = new Date(`${priceDateRaw}T00:00:00.000Z`);
    await prisma.stockPriceCache.upsert({
      where: {
        market_stockCode_priceDate: {
          market: security.market,
          stockCode: security.stockCode,
          priceDate,
        },
      },
      create: {
        securityId: security.id,
        market: security.market,
        stockCode: security.stockCode,
        priceDate,
        closePrice: String(closePrice),
        currency: security.currency,
        source: "manual",
      },
      update: {
        securityId: security.id,
        closePrice: String(closePrice),
        currency: security.currency,
        source: "manual",
      },
    });

    await recalcStockPositions(accountId, [security.id]);
    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      data: {
        price: {
          securityId: security.id,
          market: security.market,
          stockCode: security.stockCode,
          closePrice,
          priceDate: priceDateRaw,
          source: "manual",
        },
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "保存收盘价失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
