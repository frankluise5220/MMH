import { NextRequest, NextResponse } from "next/server";
import type { StockSecurity } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { getStockSecurityByCode, inferStockMarketFromCode, normalizeStockCode, normalizeStockMarket, resolveOrCreateStockSecurity } from "@/lib/stock/securities";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
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
 * - market?: string; omitted exact lookups infer market from code
 * - code?: exact stock code. Exact lookup first checks local stock data and
 *   then falls back to the stock identity API unless localOnly=1 is supplied.
 * - localOnly?: "1" keeps exact lookup inside StockSecurity, holdings, and transactions.
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
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";
    const localOnly = req.nextUrl.searchParams.get("localOnly") === "1";
    const market = marketRaw ? normalizeStockMarket(marketRaw) : (codeRaw ? inferStockMarketFromCode(codeRaw) : "");

    if (codeRaw) {
      const security = await getStockSecurityByCode(prisma, {
        householdId,
        market,
        stockCode: codeRaw,
        localOnly,
      });

      return NextResponse.json({
        ok: true,
        data: {
          security,
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
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Fetch failed" }, { status: 500, headers: corsHeaders() });
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

    if (!stockCode) return NextResponse.json({ ok: false, code: "STOCK_CODE_REQUIRED", error: "Stock code is required" }, { status: 400, headers: corsHeaders() });

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
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "Create failed" }, { status: 500, headers: corsHeaders() });
  }
}

/**
 * PATCH /api/v1/stocks/securities
 * Updates editable stock security attributes: stockName / currency / exchange.
 * market and stockCode are identity keys shared by the price cache and the
 * denormalized transaction copies, so they are intentionally not editable here.
 * A renamed security propagates its new name to StockTransaction and
 * StockHolding (both keep their own stockName copies); a currency change is
 * mirrored onto this security's StockPriceCache rows.
 *
 * Body:
 * - securityId?: string (preferred lookup key)
 * - market?: string + stockCode?: string (fallback lookup)
 * - stockName?: string
 * - currency?: string
 * - exchange?: string | null
 *
 * Response:
 * - { ok: true, data: { security } }
 */
export async function PATCH(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;

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
      return NextResponse.json({ ok: false, code: "SECURITY_NOT_FOUND", error: "股票不存在或不属于当前账簿" }, { status: 404, headers: corsHeaders() });
    }

    const data: { stockName?: string; currency?: string; exchange?: string | null } = {};
    if (body?.stockName !== undefined) {
      const stockName = String(body.stockName ?? "").trim();
      if (!stockName) {
        return NextResponse.json({ ok: false, code: "STOCK_NAME_REQUIRED", error: "股票名称不能为空" }, { status: 400, headers: corsHeaders() });
      }
      data.stockName = stockName;
    }
    if (body?.currency !== undefined) {
      const currency = String(body.currency ?? "").trim().toUpperCase();
      if (!currency) {
        return NextResponse.json({ ok: false, code: "CURRENCY_REQUIRED", error: "币种不能为空" }, { status: 400, headers: corsHeaders() });
      }
      data.currency = currency;
    }
    if (body?.exchange !== undefined) {
      const exchange = String(body.exchange ?? "").trim().toUpperCase();
      data.exchange = exchange || null;
    }

    if (Object.keys(data).length > 0) {
      await prisma.stockSecurity.update({ where: { id: security.id }, data });
      if (data.stockName !== undefined && data.stockName !== security.stockName) {
        await prisma.stockTransaction.updateMany({
          where: { securityId: security.id },
          data: { stockName: data.stockName },
        });
        await prisma.stockHolding.updateMany({
          where: { securityId: security.id },
          data: { stockName: data.stockName },
        });
      }
      if (data.currency !== undefined && data.currency !== security.currency) {
        await prisma.stockPriceCache.updateMany({
          where: { securityId: security.id },
          data: { currency: data.currency },
        });
      }
      revalidateAfterInvestChange();
    }

    const updated = await prisma.stockSecurity.findUnique({ where: { id: security.id } });
    return NextResponse.json({
      ok: true,
      data: {
        security: updated
          ? {
              id: updated.id,
              market: updated.market,
              stockCode: updated.stockCode,
              stockName: updated.stockName,
              currency: updated.currency,
              exchange: updated.exchange,
            }
          : null,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "保存失败" }, { status: 500, headers: corsHeaders() });
  }
}
