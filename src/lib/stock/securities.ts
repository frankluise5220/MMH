import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  defaultStockCurrencyForMarket,
  inferStockExchangeFromCode,
  normalizeStockCode,
  normalizeStockMarket,
} from "@/lib/stock/market";
import { queryStockIdentity } from "@/lib/stock/queryApi";

type TxClient = Prisma.TransactionClient | typeof prisma;

export { inferStockExchangeFromCode, inferStockMarketFromCode, normalizeStockCode, normalizeStockMarket } from "@/lib/stock/market";

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
  const explicitStockName = String(params.stockName ?? "").trim();
  const explicitCurrency = String(params.currency ?? "").trim().toUpperCase();
  const explicitExchange = String(params.exchange ?? "").trim().toUpperCase();

  if (!stockCode) throw new Error("股票代码必填");

  const existing = await client.stockSecurity.findUnique({
    where: {
      householdId_market_stockCode: {
        householdId: params.householdId,
        market,
        stockCode,
      },
    },
  });
  // The name uses existing data in the table first: an explicitly passed name, or a name already saved in StockSecurity that differs from the code, both count as usable.
  // Only when no usable name exists at all (first purchase with no historical name) do we query the external stock lookup API.
  const explicitNameUsable = Boolean(explicitStockName && explicitStockName !== stockCode);
  const storedNameUsable = Boolean(existing?.stockName && existing.stockName !== stockCode);
  const shouldQueryIdentity = !explicitNameUsable && !storedNameUsable;
  const identity = shouldQueryIdentity ? await queryStockIdentity(market, stockCode) : null;
  const stockName = explicitStockName || identity?.stockName || existing?.stockName || stockCode;
  const currency = explicitCurrency || identity?.currency || existing?.currency || defaultStockCurrencyForMarket(market);
  const exchange = explicitExchange || identity?.exchange || existing?.exchange || inferStockExchangeFromCode(market, stockCode);

  if (existing) {
    return client.stockSecurity.update({
      where: { id: existing.id },
      data: {
        stockName,
        currency,
        exchange,
        isActive: true,
      },
    });
  }

  return client.stockSecurity.create({
    data: {
      householdId: params.householdId,
      market,
      stockCode,
      stockName,
      currency,
      exchange,
    },
  });
}
