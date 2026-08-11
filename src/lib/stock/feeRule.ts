import { Prisma, StockFeeType, StockTradeDirection } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeStockCode, normalizeStockMarket } from "@/lib/stock/securities";

type TxClient = Prisma.TransactionClient | typeof prisma;

export function normalizeStockFeeType(raw: unknown): StockFeeType {
  const value = String(raw ?? "").trim();
  return Object.values(StockFeeType).includes(value as StockFeeType)
    ? (value as StockFeeType)
    : StockFeeType.commission;
}

export function normalizeStockTradeDirection(raw: unknown): StockTradeDirection {
  const value = String(raw ?? "").trim();
  return Object.values(StockTradeDirection).includes(value as StockTradeDirection)
    ? (value as StockTradeDirection)
    : StockTradeDirection.both;
}

function parseOptionalNumber(raw: unknown) {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function directionFilter(direction: StockTradeDirection) {
  return direction === StockTradeDirection.both
    ? [StockTradeDirection.both]
    : [direction, StockTradeDirection.both];
}

export async function getStockFeeRuleByDate(
  params: {
    accountId: string;
    feeType: StockFeeType | string;
    tradeDate: Date;
    direction?: StockTradeDirection | string | null;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
  },
  client: TxClient = prisma,
) {
  const feeType = normalizeStockFeeType(params.feeType);
  const direction = normalizeStockTradeDirection(params.direction);
  const market = params.market ? normalizeStockMarket(params.market) : null;
  const stockCode = params.stockCode ? normalizeStockCode(params.stockCode) : null;
  const directions = directionFilter(direction);

  const rules = await client.stockFeeRule.findMany({
    where: {
      accountId: params.accountId,
      feeType,
      direction: { in: directions },
      effectiveDate: { lte: params.tradeDate },
      OR: [
        ...(params.securityId ? [{ securityId: params.securityId }] : []),
        ...(market && stockCode ? [{ market, stockCode }] : []),
        { securityId: null, market: null, stockCode: null },
      ],
    },
    orderBy: [{ effectiveDate: "desc" }, { securityId: "desc" }, { stockCode: "desc" }],
  });

  return rules[0] ?? null;
}

export async function setStockFeeRule(
  params: {
    accountId: string;
    feeType: StockFeeType | string;
    direction?: StockTradeDirection | string | null;
    rate?: unknown;
    amount?: unknown;
    minAmount?: unknown;
    effectiveDate?: Date | null;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
    currency?: string | null;
    source?: string | null;
    note?: string | null;
  },
  client: TxClient = prisma,
) {
  const feeType = normalizeStockFeeType(params.feeType);
  const direction = normalizeStockTradeDirection(params.direction);
  const rate = parseOptionalNumber(params.rate);
  const amount = parseOptionalNumber(params.amount);
  const minAmount = parseOptionalNumber(params.minAmount);
  const effectiveDate = params.effectiveDate ?? new Date();
  const market = params.market ? normalizeStockMarket(params.market) : null;
  const stockCode = params.stockCode ? normalizeStockCode(params.stockCode) : null;
  const currency = String(params.currency ?? "CNY").trim().toUpperCase() || "CNY";

  if (rate == null && amount == null) {
    throw new Error("请填写费率或固定金额");
  }

  return client.stockFeeRule.create({
    data: {
      accountId: params.accountId,
      securityId: params.securityId ?? null,
      market,
      stockCode,
      feeType,
      direction,
      rate,
      amount,
      minAmount,
      currency,
      effectiveDate,
      source: String(params.source ?? "manual").trim() || "manual",
      note: String(params.note ?? "").trim() || null,
    },
  });
}
