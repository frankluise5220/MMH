/**
 * Server-side aggregation backing the `mmh_query_investment_flow` MCP tool.
 *
 * The point of this module is that the caliber lives here, not in the agent.
 * An agent that re-adds raw detail rows will get a different number every time
 * (apply vs confirm date, dividend reinvestment, failed-buy refunds, ...).
 * Everything below is decided once, on the server.
 *
 * Scope: `fund_transactions` only (fund + money fund). Wealth, bond, metal and
 * property keep their own business tables and are not covered yet.
 */
import { FundSubtype, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

export type InvestmentFlowDateBasis = "apply" | "confirm";
export type InvestmentFlowSubtype = "buy" | "sell" | "all";
export type InvestmentFlowProductType = "fund" | "money" | "all";
export type InvestmentFlowGroupBy = "none" | "fund" | "account";

export type InvestmentFlowInput = {
  householdId: string;
  from: string;
  to: string;
  subtype?: InvestmentFlowSubtype;
  productType?: InvestmentFlowProductType;
  dateBasis?: InvestmentFlowDateBasis;
  groupBy?: InvestmentFlowGroupBy;
};

export type InvestmentFlowBucket = {
  totalAmount: number;
  count: number;
  regularInvestAmount?: number;
  breakdown: Array<{
    fundCode?: string;
    fundName?: string;
    accountId?: string;
    accountName?: string;
    amount: number;
    units: number;
    count: number;
  }>;
};

export type InvestmentFlowResult = {
  from: string;
  to: string;
  dateBasis: InvestmentFlowDateBasis;
  productType: InvestmentFlowProductType;
  buy: InvestmentFlowBucket;
  sell: InvestmentFlowBucket;
};

/** Subtypes that increase holdings and represent money going in. */
const BUY_SUBTYPES = new Set<string>([
  FundSubtype.buy,
  FundSubtype.switch_in,
  FundSubtype.regular_invest,
]);

/** Subtypes that decrease holdings and represent money coming out. */
const SELL_SUBTYPES = new Set<string>([FundSubtype.redeem, FundSubtype.switch_out]);

const REGULAR_INVEST_REFUND_SOURCE = "regular_invest_refund";

function parseDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Money paid in for one row.
 *
 * - `buy_failed` is a failed subscription. When it is the regular-investment
 *   refund leg the money came back, so it must be deducted from the buy total;
 *   any other failure contributes nothing.
 * - `dividend_reinvest` increases units but moves no cash, so it is excluded.
 */
function buyAmount(row: {
  fundSubtype: string;
  source: string | null;
  grossAmount: Prisma.Decimal | number;
}): number {
  const gross = Math.abs(toNumber(row.grossAmount));
  if (row.fundSubtype === FundSubtype.buy_failed) {
    return row.source === REGULAR_INVEST_REFUND_SOURCE ? -gross : 0;
  }
  return BUY_SUBTYPES.has(row.fundSubtype) ? gross : 0;
}

/** Money received for one row (net arrival, not gross). */
function sellAmount(row: {
  fundSubtype: string;
  arrivalAmount: Prisma.Decimal | null;
  grossAmount: Prisma.Decimal | number;
}): number {
  if (!SELL_SUBTYPES.has(row.fundSubtype)) return 0;
  return Math.abs(toNumber(row.arrivalAmount ?? row.grossAmount));
}

function emptyBucket(withRegular: boolean): InvestmentFlowBucket {
  return {
    totalAmount: 0,
    count: 0,
    ...(withRegular ? { regularInvestAmount: 0 } : {}),
    breakdown: [],
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export async function queryInvestmentFlow(input: InvestmentFlowInput): Promise<InvestmentFlowResult> {
  const from = parseDay(input.from);
  const to = parseDay(input.to);
  if (!from || !to) {
    throw new Error("INVALID_DATE_RANGE: from and to must be YYYY-MM-DD");
  }
  if (from.getTime() > to.getTime()) {
    throw new Error("INVALID_DATE_RANGE: from must not be after to");
  }

  const dateBasis = input.dateBasis ?? "apply";
  const productType = input.productType ?? "fund";
  const subtype = input.subtype ?? "buy";
  const groupBy = input.groupBy ?? "fund";

  // `to` is inclusive: shift to the start of the next day.
  const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  const dateFilter =
    dateBasis === "confirm"
      ? { confirmDate: { gte: from, lt: toExclusive } }
      : { applyDate: { gte: from, lt: toExclusive } };

  const wantedSubtypes: FundSubtype[] = [
    ...BUY_SUBTYPES,
    ...SELL_SUBTYPES,
    FundSubtype.buy_failed,
  ] as FundSubtype[];

  const rows = await prisma.fundTransaction.findMany({
    where: {
      householdId: input.householdId,
      deletedAt: null,
      ...dateFilter,
      fundSubtype: { in: wantedSubtypes },
      ...(productType === "all" ? {} : { fundProductType: productType }),
    },
    select: {
      fundSubtype: true,
      source: true,
      grossAmount: true,
      arrivalAmount: true,
      units: true,
      fundCode: true,
      fundName: true,
      fundAccountId: true,
      regularInvestPlanId: true,
    },
  });

  const accountIds = Array.from(new Set(rows.map((row) => row.fundAccountId)));
  const accounts = accountIds.length
    ? await prisma.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, name: true },
      })
    : [];
  const accountNameById = new Map(accounts.map((account) => [account.id, account.name]));

  const buy = emptyBucket(true);
  const sell = emptyBucket(false);
  const buyGroups = new Map<string, InvestmentFlowBucket["breakdown"][number]>();
  const sellGroups = new Map<string, InvestmentFlowBucket["breakdown"][number]>();

  function groupKey(row: (typeof rows)[number]): string {
    if (groupBy === "account") return `account:${row.fundAccountId}`;
    if (groupBy === "fund") return `fund:${row.fundCode}`;
    return "all";
  }

  for (const row of rows) {
    const inAmount = buyAmount(row);
    const outAmount = sellAmount(row);
    const units = Math.abs(toNumber(row.units));

    if (subtype !== "sell" && inAmount !== 0) {
      buy.totalAmount += inAmount;
      buy.count += 1;
      if (row.regularInvestPlanId) {
        buy.regularInvestAmount = (buy.regularInvestAmount ?? 0) + inAmount;
      }
      const key = groupKey(row);
      const bucket = buyGroups.get(key) ?? {
        ...(groupBy === "fund" ? { fundCode: row.fundCode, fundName: row.fundName ?? row.fundCode } : {}),
        ...(groupBy === "account"
          ? { accountId: row.fundAccountId, accountName: accountNameById.get(row.fundAccountId) ?? "" }
          : {}),
        amount: 0,
        units: 0,
        count: 0,
      };
      bucket.amount += inAmount;
      bucket.units += units;
      bucket.count += 1;
      buyGroups.set(key, bucket);
    }

    if (subtype !== "buy" && outAmount !== 0) {
      sell.totalAmount += outAmount;
      sell.count += 1;
      const key = groupKey(row);
      const bucket = sellGroups.get(key) ?? {
        ...(groupBy === "fund" ? { fundCode: row.fundCode, fundName: row.fundName ?? row.fundCode } : {}),
        ...(groupBy === "account"
          ? { accountId: row.fundAccountId, accountName: accountNameById.get(row.fundAccountId) ?? "" }
          : {}),
        amount: 0,
        units: 0,
        count: 0,
      };
      bucket.amount += outAmount;
      bucket.units += units;
      bucket.count += 1;
      sellGroups.set(key, bucket);
    }
  }

  const finalize = (bucket: InvestmentFlowBucket, groups: Map<string, InvestmentFlowBucket["breakdown"][number]>) => {
    bucket.totalAmount = round2(bucket.totalAmount);
    if (bucket.regularInvestAmount !== undefined) {
      bucket.regularInvestAmount = round2(bucket.regularInvestAmount);
    }
    bucket.breakdown = Array.from(groups.values())
      .map((entry) => ({ ...entry, amount: round2(entry.amount), units: Math.round(entry.units * 100) / 100 }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  };

  finalize(buy, buyGroups);
  finalize(sell, sellGroups);

  return {
    from: input.from,
    to: input.to,
    dateBasis,
    productType,
    buy,
    sell,
  };
}
