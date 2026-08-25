import { Prisma } from "@prisma/client";

import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  inferStockExchangeFromCode,
  inferStockMarketFromCode,
  normalizeStockCode,
  normalizeStockMarket,
} from "@/lib/stock/market";
import { queryStockClosePriceByDate } from "@/lib/stock/queryApi";

type TxClient = Prisma.TransactionClient | typeof prisma;

export type StockClosePriceLookupItem = {
  market: string;
  stockCode: string;
  closePrice: number;
  priceDate: string;
  currency: string;
  exchange?: string | null;
  source: string;
};

function parseDateOnly(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnlyUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toLookupItem(row: {
  market: string;
  stockCode: string;
  closePrice: unknown;
  priceDate: Date;
  currency: string;
  source: string;
}): StockClosePriceLookupItem {
  return {
    market: row.market,
    stockCode: row.stockCode,
    closePrice: toNumber(row.closePrice),
    priceDate: formatDateUtc(row.priceDate),
    currency: row.currency,
    source: row.source,
  };
}

export async function getStockClosePriceByDate(
  client: TxClient,
  params: {
    market?: string;
    stockCode: string;
    priceDate: string | Date;
    securityId?: string | null;
    exchange?: string | null;
  },
): Promise<StockClosePriceLookupItem | null> {
  const stockCode = normalizeStockCode(params.stockCode);
  const market = params.market ? normalizeStockMarket(params.market) : inferStockMarketFromCode(stockCode);
  const targetDate = parseDateOnly(params.priceDate);
  if (!stockCode || !targetDate) return null;

  const cached = await client.stockPriceCache.findFirst({
    where: {
      market,
      stockCode,
      priceDate: targetDate,
    },
  });
  if (cached) return toLookupItem(cached);

  const external = await queryStockClosePriceByDate(
    market,
    stockCode,
    formatDateUtc(targetDate),
    params.exchange ?? inferStockExchangeFromCode(market, stockCode),
  );
  if (!external) return null;

  const priceDate = dateOnlyUtc(external.priceDate);
  await client.stockPriceCache.upsert({
    where: {
      market_stockCode_priceDate: {
        market: external.market,
        stockCode: external.stockCode,
        priceDate,
      },
    },
    create: {
      ...(params.securityId ? { securityId: params.securityId } : {}),
      market: external.market,
      stockCode: external.stockCode,
      priceDate,
      closePrice: String(external.closePrice),
      currency: external.currency,
      source: external.source,
    },
    update: {
      ...(params.securityId ? { securityId: params.securityId } : {}),
      closePrice: String(external.closePrice),
      currency: external.currency,
      source: external.source,
    },
  });

  return external;
}
