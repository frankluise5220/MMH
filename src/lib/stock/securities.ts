import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type TxClient = Prisma.TransactionClient | typeof prisma;

export function normalizeStockMarket(raw: unknown) {
  const value = String(raw ?? "").trim().toUpperCase();
  return value || "CN";
}

export function normalizeStockCode(raw: unknown) {
  return String(raw ?? "").trim().toUpperCase();
}

export async function resolveOrCreateStockSecurity(
  client: TxClient,
  params: {
    householdId: string;
    market: string;
    stockCode: string;
    stockName?: string | null;
    currency?: string | null;
    exchange?: string | null;
  },
) {
  const market = normalizeStockMarket(params.market);
  const stockCode = normalizeStockCode(params.stockCode);
  const stockName = String(params.stockName ?? "").trim() || stockCode;
  const currency = String(params.currency ?? "CNY").trim().toUpperCase() || "CNY";
  const exchange = String(params.exchange ?? "").trim() || null;

  if (!stockCode) throw new Error("股票代码必填");

  return client.stockSecurity.upsert({
    where: {
      householdId_market_stockCode: {
        householdId: params.householdId,
        market,
        stockCode,
      },
    },
    create: {
      householdId: params.householdId,
      market,
      stockCode,
      stockName,
      currency,
      exchange,
    },
    update: {
      stockName,
      currency,
      exchange,
      isActive: true,
    },
  });
}
