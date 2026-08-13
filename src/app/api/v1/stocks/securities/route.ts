import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { queryStockIdentity } from "@/lib/stock/queryApi";
import { inferStockMarketFromCode, normalizeStockCode, normalizeStockMarket, resolveOrCreateStockSecurity } from "@/lib/stock/securities";

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

function usableStockName(value: unknown, stockCode: string) {
  const name = String(value ?? "").trim();
  return name && name !== stockCode ? name : null;
}

async function findLocalStockName(householdId: string, market: string, stockCode: string) {
  const holding = await prisma.stockHolding.findFirst({
    where: { householdId, market, stockCode, stockName: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { stockName: true },
  });
  const holdingName = usableStockName(holding?.stockName, stockCode);
  if (holdingName) return holdingName;

  const transaction = await prisma.stockTransaction.findFirst({
    where: { householdId, market, stockCode, deletedAt: null, stockName: { not: null } },
    orderBy: [{ tradeDate: "desc" }, { updatedAt: "desc" }],
    select: { stockName: true },
  });
  return usableStockName(transaction?.stockName, stockCode);
}

/**
 * GET /api/v1/stocks/securities
 * Lists stock securities for the current household.
 *
 * Query:
 * - market?: string; omitted exact lookups infer market from code
 * - code?: exact stock code. When lookup=1, local miss falls back to stock identity API and caches the result.
 * - lookup?: "1" | "true"
 * - q?: string matches stock code or name
 *
 * Response:
 * - exact lookup: { ok: true, data: { security } }
 * - list lookup: { ok: true, data: { securities: [{ id, market, stockCode, stockName, currency, exchange }] } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const marketRaw = req.nextUrl.searchParams.get("market")?.trim() || "";
    const codeRaw = req.nextUrl.searchParams.get("code")?.trim() || "";
    const lookup = /^(1|true|yes)$/i.test(req.nextUrl.searchParams.get("lookup")?.trim() ?? "");
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";
    const market = marketRaw ? normalizeStockMarket(marketRaw) : (codeRaw ? inferStockMarketFromCode(codeRaw) : "");

    if (codeRaw) {
      const stockCode = normalizeStockCode(codeRaw);
      let security = await prisma.stockSecurity.findFirst({
        where: { householdId, isActive: true, market, stockCode },
      });
      if (lookup && !usableStockName(security?.stockName, stockCode)) {
        const localStockName = await findLocalStockName(householdId, market, stockCode);
        if (localStockName) {
          security = await resolveOrCreateStockSecurity(prisma, {
            householdId,
            market,
            stockCode,
            stockName: localStockName,
            currency: security?.currency,
            exchange: security?.exchange,
          });
        }
      }
      if (lookup && !usableStockName(security?.stockName, stockCode)) {
        const identity = await queryStockIdentity(market, stockCode);
        if (identity?.stockName && identity.stockName !== stockCode) {
          security = await resolveOrCreateStockSecurity(prisma, {
            householdId,
            market: identity.market,
            stockCode: identity.stockCode,
            stockName: identity.stockName,
            currency: identity.currency,
            exchange: identity.exchange,
          });
        }
      }

      return NextResponse.json({
        ok: true,
        data: {
          security: security
            ? {
                id: security.id,
                market: security.market,
                stockCode: security.stockCode,
                stockName: security.stockName,
                currency: security.currency,
                exchange: security.exchange,
              }
            : null,
        },
      }, { headers: corsHeaders() });
    }

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
 * - market?: string; omitted values are inferred from stockCode where possible
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
    const stockCode = normalizeStockCode(body.stockCode);
    const market = body.market ? normalizeStockMarket(body.market) : inferStockMarketFromCode(stockCode);
    const stockName = String(body.stockName ?? "").trim() || undefined;
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
