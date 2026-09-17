import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";

const MONEY_EPS = 0.005;
const UNITS_EPS = 0.000001;

export type WealthPositionEntryLike = {
  id: string;
  cashEntryId?: string | null;
  productKey: string | null;
  action: FundSubtype | string | null;
  tradeDate: Date | string | null;
  createdAt: Date | string | null;
  grossAmount: unknown;
  arrivalAmount?: unknown | null;
  units?: unknown | null;
  nav?: unknown | null;
  interest?: unknown | null;
  fee?: unknown | null;
};

export type WealthBucket = {
  cost: number;
  units: number;
  cycleHasUnits: boolean;
  historicalProfit: number;
};

export type WealthPositionCalcResult = {
  holdings: Map<string, WealthBucket>;
  realizedProfitByTransactionId: Map<string, number>;
};

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function absNum(value: unknown) {
  return Math.abs(toNumber(value));
}

function ymd(value: Date | string | null | undefined) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function time(value: Date | string | null | undefined) {
  if (!value) return 0;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function isCashInAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.redeem || action === FundSubtype.switch_out || action === FundSubtype.dividend_cash;
}

/** 坏账核销：本金直接损失，无现金流动（城投债收不回的部分）。 */
function isWriteOffAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.write_off;
}

function isDividendAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.dividend_cash;
}

function netArrivalAmount(entry: WealthPositionEntryLike) {
  if (entry.arrivalAmount != null) return absNum(entry.arrivalAmount);
  const gross = absNum(entry.grossAmount);
  const fee = Math.max(0, toNumber(entry.fee));
  if (entry.interest != null) return Math.max(0, gross + toNumber(entry.interest) - fee);
  return gross;
}

export function calculateWealthCashDividendProfit(value: {
  arrivalAmount?: unknown | null;
  grossAmount?: unknown | null;
}) {
  const arrival = value.arrivalAmount == null ? null : absNum(value.arrivalAmount);
  return roundMoney(arrival ?? absNum(value.grossAmount));
}

function positiveNum(value: unknown) {
  const n = toNumber(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function inferWealthUnitNav(value: { nav?: unknown | null; grossAmount?: unknown | null; arrivalAmount?: unknown | null; units?: unknown | null }) {
  const nav = positiveNum(value.nav);
  if (nav != null) return nav;
  const units = positiveNum(value.units);
  if (units == null || units <= UNITS_EPS) return null;
  const amount = positiveNum(value.grossAmount) ?? positiveNum(value.arrivalAmount);
  if (amount == null) return null;
  return amount / units;
}

function fallbackNetProfit(entry: WealthPositionEntryLike) {
  const fee = Math.max(0, toNumber(entry.fee));
  if (entry.interest != null) return roundMoney(toNumber(entry.interest) - fee);
  if (fee > 0) return roundMoney(-fee);
  if (entry.arrivalAmount != null) {
    const principal = absNum(entry.grossAmount);
    return principal > MONEY_EPS ? roundMoney(absNum(entry.arrivalAmount) - principal) : 0;
  }
  return 0;
}

export function calculateWealthPositionsFromEntries(
  entries: WealthPositionEntryLike[],
  fundUnitsDecimals: number,
): WealthPositionCalcResult {
  const holdings = new Map<string, WealthBucket>();
  const realizedProfitByTransactionId = new Map<string, number>();
  const sorted = [...entries].sort((a, b) =>
    ymd(a.tradeDate).localeCompare(ymd(b.tradeDate)) ||
    time(a.createdAt) - time(b.createdAt) ||
    a.id.localeCompare(b.id),
  );

  for (const entry of sorted) {
    const productKey = entry.productKey?.trim();
    if (!productKey) continue;
    const action = entry.action ?? FundSubtype.buy;
    const gross = absNum(entry.grossAmount);
    const units = entry.units == null ? null : roundFundUnits(absNum(entry.units), fundUnitsDecimals);
    const bucket = holdings.get(productKey) ?? { cost: 0, units: 0, cycleHasUnits: false, historicalProfit: 0 };

    if (isDividendAction(action)) {
      const profit = calculateWealthCashDividendProfit(entry);
      bucket.historicalProfit += profit;
      realizedProfitByTransactionId.set(entry.id, profit);
      holdings.set(productKey, bucket);
      continue;
    }

    if (isWriteOffAction(action)) {
      const loss = gross;
      bucket.cost = Math.max(0, roundMoney(bucket.cost - loss));
      // 核销 = 已实现损失：计入历史收益的负项，持仓余额同步扣减。
      bucket.historicalProfit = roundMoney(bucket.historicalProfit - loss);
      realizedProfitByTransactionId.set(entry.id, roundMoney(-loss));
      if (bucket.cycleHasUnits && (bucket.units <= UNITS_EPS || bucket.cost <= MONEY_EPS)) {
        bucket.cost = 0;
        bucket.units = 0;
        bucket.cycleHasUnits = false;
      }
      holdings.set(productKey, bucket);
      continue;
    }

    if (!isCashInAction(action)) {
      if (units != null && units > UNITS_EPS) {
        bucket.cycleHasUnits = true;
        bucket.units = roundFundUnits(bucket.units + units, fundUnitsDecimals);
      }
      const buyUnitNav = inferWealthUnitNav(entry);
      const unitCost = units != null && units > UNITS_EPS && buyUnitNav != null
        ? units * buyUnitNav
        : gross;
      bucket.cost = Math.max(0, roundMoney(bucket.cost + unitCost));
      holdings.set(productKey, bucket);
      continue;
    }

    const arrival = netArrivalAmount(entry);
    let costReduced = gross;
    if (units != null && units > UNITS_EPS && bucket.cycleHasUnits && bucket.units > UNITS_EPS) {
      costReduced = Math.min(bucket.cost, (bucket.cost / bucket.units) * units);
      bucket.units = Math.max(0, roundFundUnits(bucket.units - units, fundUnitsDecimals));
    } else if (units != null && units > UNITS_EPS) {
      bucket.units = Math.max(0, roundFundUnits(bucket.units - units, fundUnitsDecimals));
    }

    const redeemUnitNav = inferWealthUnitNav(entry);
    const calculatedProfit = units != null && units > UNITS_EPS && redeemUnitNav != null && costReduced > MONEY_EPS
      ? roundMoney((units * redeemUnitNav) - costReduced + toNumber(entry.interest) - Math.max(0, toNumber(entry.fee)))
      : units != null && units > UNITS_EPS
        ? roundMoney(arrival - costReduced)
        : fallbackNetProfit(entry);
    if (calculatedProfit != null) {
      bucket.historicalProfit += calculatedProfit;
      realizedProfitByTransactionId.set(entry.id, calculatedProfit);
    }

    bucket.cost = Math.max(0, roundMoney(bucket.cost - costReduced));
    if (bucket.cycleHasUnits && (bucket.units <= UNITS_EPS || bucket.cost <= MONEY_EPS)) {
      bucket.cost = 0;
      bucket.units = 0;
      bucket.cycleHasUnits = false;
    }
    holdings.set(productKey, bucket);
  }

  return { holdings, realizedProfitByTransactionId };
}

export async function recalcWealthPositions(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, kind: true, investProductType: true, fundUnitsDecimals: true },
  });
  if (!account || account.kind !== "investment" || account.investProductType !== "wealth") return;

  const fundUnitsDecimals = normalizeFundUnitsDecimals(account.fundUnitsDecimals, 2);
  const rows = await prisma.wealthTransaction.findMany({
    where: { accountId, deletedAt: null },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      cashEntryId: true,
      wealthProductId: true,
      productName: true,
      action: true,
      tradeDate: true,
      createdAt: true,
      grossAmount: true,
      arrivalAmount: true,
      units: true,
      nav: true,
      interest: true,
      fee: true,
    },
  });

  const calc = calculateWealthPositionsFromEntries(
    rows.map((row) => ({
      id: row.id,
      cashEntryId: row.cashEntryId,
      productKey: row.wealthProductId ?? row.productName ?? null,
      action: row.action,
      tradeDate: row.tradeDate,
      createdAt: row.createdAt,
      grossAmount: row.grossAmount,
      arrivalAmount: row.arrivalAmount,
      units: row.units,
      nav: row.nav,
      interest: row.interest,
      fee: row.fee,
    })),
    fundUnitsDecimals,
  );

  for (const row of rows) {
    const action = row.action;
    // write_off 的已实现损失（=-核销额）也要回写，与 redeem/dividend 同等地位。
    if (!isCashInAction(action) && !isWriteOffAction(action)) continue;
    const realizedProfit = calc.realizedProfitByTransactionId.get(row.id) ?? null;
    await prisma.wealthTransaction.update({
      where: { id: row.id },
      data: { realizedProfit },
    });
    if (row.cashEntryId) {
      await prisma.txRecord.updateMany({
        where: { id: row.cashEntryId },
        data: { realizedProfit },
      });
    }
  }
}
