import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { normalizeStockCode, normalizeStockMarket, resolveOrCreateStockSecurity } from "@/lib/stock/securities";

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

/**
 * GET /api/v1/stocks/securities
 * Lists stock securities for the current household.
 *
 * Query:
 * - market?: string
 * - q?: string matches stock code or name
 *
 * Response:
 * - { ok: true, data: { securities: [{ id, market, stockCode, stockName, currency, exchange }] } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const marketRaw = req.nextUrl.searchParams.get("market")?.trim() || "";
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";
    const market = marketRaw ? normalizeStockMarket(marketRaw) : "";
    const rows = await prisma.stockSecurity.findMany({
      where: {
        householdId,
        isActive: true,
        ...(market ? { market } : {}),
        ...(q
          ? {
              OR: [
                { stockCode: { contains: normalizeStockCode(q) } },
                { stockName: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ market: "asc" }, { stockCode: "asc" }],
      take: 100,
    });

    return NextResponse.json({
      ok: true,
      data: {
        securities: rows.map((item) => ({
          id: item.id,
          market: item.market,
          stockCode: item.stockCode,
          stockName: item.stockName,
          currency: item.currency,
          exchange: item.exchange,
        })),
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "查询失败" }, { status: 500, headers: corsHeaders() });
  }
}

/**
 * POST /api/v1/stocks/securities
 * Creates or returns a stock security master record.
 *
 * Body:
 * - market: string
 * - stockCode: string
 * - stockName?: string
 * - currency?: string
 * - exchange?: string
 *
 * Response:
 * - { ok: true, data: { security } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json();
    const market = normalizeStockMarket(body.market);
    const stockCode = normalizeStockCode(body.stockCode);
    const stockName = String(body.stockName ?? "").trim() || stockCode;
    const currency = normalizeCurrency(body.currency);
    const exchange = String(body.exchange ?? "").trim() || null;

    if (!stockCode) return NextResponse.json({ ok: false, error: "股票代码必填" }, { status: 400, headers: corsHeaders() });

    const security = await resolveOrCreateStockSecurity(prisma, {
      householdId,
      market,
      stockCode,
      stockName,
      currency,
      exchange,
    });

    return NextResponse.json({
      ok: true,
      data: {
        security: {
          id: security.id,
          market: security.market,
          stockCode: security.stockCode,
          stockName: security.stockName,
          currency: security.currency,
          exchange: security.exchange,
        },
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "创建失败" }, { status: 500, headers: corsHeaders() });
  }
}
