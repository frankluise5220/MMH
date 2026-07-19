import type { FundProductType, FundSubtype } from "@prisma/client";
import { TransactionType } from "@prisma/client";

import { toNumber } from "@/lib/date-utils";
import {
  SYSTEM_DEPOSIT_FEE_CATEGORY,
  SYSTEM_DEPOSIT_INTEREST_CATEGORY,
  SYSTEM_FUND_LOSS_CATEGORY,
  SYSTEM_FUND_PROFIT_CATEGORY,
  SYSTEM_INVESTMENT_DIVIDEND_CATEGORY,
  SYSTEM_INVESTMENT_LOSS_CATEGORY,
  SYSTEM_WEALTH_LOSS_CATEGORY,
  SYSTEM_WEALTH_PROFIT_CATEGORY,
} from "@/lib/default-categories";

/**
 * Converts stored cash-flow amounts into category-statistics amounts.
 * TxRecord.amount is an account-side cash-flow value: positive means inflow
 * to accountId, negative means outflow from accountId. The transaction type
 * chooses the report section only; it must not rewrite the stored sign.
 *
 * In reports, normal expense outflows are displayed as positive expense totals,
 * while positive expense records reduce expense totals. Income records keep the
 * same sign so negative income records can reduce income totals.
 */
export function getIncomeExpenseStatisticAmount(
  type: TransactionType,
  amount: unknown,
) {
  const value = toNumber(amount);
  if (type === TransactionType.expense) return -value;
  if (type === TransactionType.income) return value;
  throw new Error(`Unsupported income/expense statistics type: ${type}`);
}

export type InvestmentStatisticType = "income" | "expense";

type InvestmentProductKind = "fund" | "wealth" | "deposit";

export type InvestmentStatisticEntryLike = {
  id: string;
  amount: unknown;
  fundSubtype?: FundSubtype | string | null;
  fundProductType?: FundProductType | string | null;
  realizedProfit?: unknown | null;
  depositInterest?: unknown | null;
  fundFee?: unknown | null;
  fundCode?: string | null;
  fundName?: string | null;
};

export type InvestmentStatisticItem = {
  idSuffix: string;
  type: InvestmentStatisticType;
  amount: number;
  categoryName: string;
  categoryCandidates: string[];
  label: string;
};

export type StatisticCategoryType = "income" | "expense";

export type StatisticCategoryLike = {
  id: string;
  name: string;
  type: string;
};

export type StatisticCategoryRef = {
  id: string | null;
  name: string;
  type: StatisticCategoryType;
};

export type StatisticCategoryBucket = StatisticCategoryRef & {
  value: number;
};

export const INVESTMENT_STATISTIC_CATEGORY_NAMES = [
  SYSTEM_FUND_PROFIT_CATEGORY,
  SYSTEM_FUND_LOSS_CATEGORY,
  SYSTEM_WEALTH_PROFIT_CATEGORY,
  SYSTEM_WEALTH_LOSS_CATEGORY,
  SYSTEM_DEPOSIT_INTEREST_CATEGORY,
  SYSTEM_DEPOSIT_FEE_CATEGORY,
  SYSTEM_INVESTMENT_DIVIDEND_CATEGORY,
  SYSTEM_INVESTMENT_LOSS_CATEGORY,
];

export function buildStatisticCategoryItems(
  categoryMap: Map<string, number>,
  total: number,
  limit = 8,
) {
  const sorted = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);
  const picked = sorted.slice(0, limit);
  const pickedNames = new Set(picked.map(([name]) => name));

  for (const name of INVESTMENT_STATISTIC_CATEGORY_NAMES) {
    if (!pickedNames.has(name) && categoryMap.has(name)) {
      picked.push([name, categoryMap.get(name) ?? 0]);
      pickedNames.add(name);
    }
  }

  return picked.map(([name, value]) => ({
    name,
    value,
    pct: total > 0 ? (value / total) * 100 : 0,
  }));
}

export function createStatisticCategoryResolver(categories: StatisticCategoryLike[]) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const byTypeAndName = new Map<string, StatisticCategoryLike>();
  for (const category of categories) {
    if (category.type !== "income" && category.type !== "expense") continue;
    byTypeAndName.set(`${category.type}:${category.name}`, category);
  }

  return function resolveStatisticCategory(params: {
    type: StatisticCategoryType;
    categoryId?: string | null;
    categoryName?: string | null;
    candidates?: string[];
    fallbackName?: string;
  }): StatisticCategoryRef {
    if (params.categoryId) {
      const category = byId.get(params.categoryId);
      if (category && category.type === params.type) {
        return { id: category.id, name: category.name, type: params.type };
      }
    }

    const names = [
      ...(params.categoryName?.trim() ? [params.categoryName.trim()] : []),
      ...(params.candidates ?? []),
    ];
    for (const name of names) {
      const category = byTypeAndName.get(`${params.type}:${name}`);
      if (category) return { id: category.id, name: category.name, type: params.type };
    }

    return {
      id: null,
      name: params.fallbackName ?? params.categoryName?.trim() ?? (params.type === "income" ? "未分类收入" : "未分类支出"),
      type: params.type,
    };
  };
}

export function addStatisticCategoryBucket(
  bucketMap: Map<string, StatisticCategoryBucket>,
  category: StatisticCategoryRef,
  amount: number,
) {
  if (amount === 0) return;
  const key = category.id ?? `name:${category.type}:${category.name}`;
  const current = bucketMap.get(key);
  if (current) {
    current.value += amount;
  } else {
    bucketMap.set(key, { ...category, value: amount });
  }
}

export function buildStatisticCategoryItemsFromBuckets(
  bucketMap: Map<string, StatisticCategoryBucket>,
  total: number,
  limit = 8,
) {
  const sorted = Array.from(bucketMap.values()).sort((a, b) => b.value - a.value);
  const picked = sorted.slice(0, limit);
  const pickedKeys = new Set(picked.map((bucket) => bucket.id ?? `${bucket.type}:${bucket.name}`));

  for (const name of INVESTMENT_STATISTIC_CATEGORY_NAMES) {
    const bucket = sorted.find((item) => item.name === name);
    if (!bucket) continue;
    const key = bucket.id ?? `${bucket.type}:${bucket.name}`;
    if (!pickedKeys.has(key)) {
      picked.push(bucket);
      pickedKeys.add(key);
    }
  }

  return picked.map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    value: bucket.value,
    pct: total > 0 ? (bucket.value / total) * 100 : 0,
  }));
}

function classifyInvestmentProduct(entry: InvestmentStatisticEntryLike): InvestmentProductKind {
  if (entry.fundProductType === "wealth") return "wealth";
  if (entry.fundProductType === "deposit") return "deposit";
  return "fund";
}

function profitCategory(kind: InvestmentProductKind, value: number) {
  if (kind === "wealth") {
    return value >= 0
      ? { name: SYSTEM_WEALTH_PROFIT_CATEGORY, candidates: [SYSTEM_WEALTH_PROFIT_CATEGORY, "投资收益", "投资收入"] }
      : { name: SYSTEM_WEALTH_LOSS_CATEGORY, candidates: [SYSTEM_WEALTH_LOSS_CATEGORY, SYSTEM_INVESTMENT_LOSS_CATEGORY] };
  }
  if (kind === "deposit") {
    return value >= 0
      ? { name: SYSTEM_DEPOSIT_INTEREST_CATEGORY, candidates: [SYSTEM_DEPOSIT_INTEREST_CATEGORY, "利息", "投资收益"] }
      : { name: SYSTEM_DEPOSIT_FEE_CATEGORY, candidates: [SYSTEM_DEPOSIT_FEE_CATEGORY, SYSTEM_INVESTMENT_LOSS_CATEGORY] };
  }
  return value >= 0
    ? { name: SYSTEM_FUND_PROFIT_CATEGORY, candidates: [SYSTEM_FUND_PROFIT_CATEGORY, "投资收益", "投资收入"] }
    : { name: SYSTEM_FUND_LOSS_CATEGORY, candidates: [SYSTEM_FUND_LOSS_CATEGORY, SYSTEM_INVESTMENT_LOSS_CATEGORY] };
}

/**
 * Converts investment transactions into category-statistics rows.
 *
 * Cash account balance still uses the real cash flow (`fundArrivalAmount` etc.).
 * This helper only exposes the economic P/L portion for reports/statistics:
 * fund realized P/L comes from the canonical fund recalculation result
 * (`TxRecord.realizedProfit`), while wealth/deposit yield uses interest minus fee.
 */
export function getInvestmentStatisticItems(entry: InvestmentStatisticEntryLike): InvestmentStatisticItem[] {
  const items: InvestmentStatisticItem[] = [];
  const kind = classifyInvestmentProduct(entry);
  const subtype = entry.fundSubtype ?? "";

  if (subtype === "dividend_cash") {
    const amount = Math.abs(toNumber(entry.amount));
    if (amount > 0) {
      const category = kind === "wealth"
        ? profitCategory("wealth", amount)
        : { name: SYSTEM_INVESTMENT_DIVIDEND_CATEGORY, candidates: [SYSTEM_INVESTMENT_DIVIDEND_CATEGORY, "股息分红", SYSTEM_FUND_PROFIT_CATEGORY] };
      items.push({
        idSuffix: "dividend",
        type: "income",
        amount,
        categoryName: category.name,
        categoryCandidates: category.candidates,
        label: kind === "wealth" ? "理财分红" : "投资分红",
      });
    }
  }

  if (kind === "fund" && entry.realizedProfit != null) {
    const profit = toNumber(entry.realizedProfit);
    if (profit !== 0) {
      const category = profitCategory("fund", profit);
      items.push({
        idSuffix: "realized-profit",
        type: profit > 0 ? "income" : "expense",
        amount: Math.abs(profit),
        categoryName: category.name,
        categoryCandidates: category.candidates,
        label: profit > 0 ? "基金收益" : "基金亏损",
      });
    }
  }

  if ((kind === "wealth" || kind === "deposit") && (subtype === "redeem" || subtype === "switch_out")) {
    const hasRealizedProfit = entry.realizedProfit !== null && entry.realizedProfit !== undefined;
    const hasInterest = entry.depositInterest !== null && entry.depositInterest !== undefined;
    const hasFee = entry.fundFee !== null && entry.fundFee !== undefined;
    if (hasRealizedProfit || hasInterest || hasFee) {
      const netProfit = hasRealizedProfit
        ? toNumber(entry.realizedProfit)
        : toNumber(entry.depositInterest) - toNumber(entry.fundFee);
      if (netProfit !== 0) {
        const category = profitCategory(kind, netProfit);
        items.push({
          idSuffix: "yield",
          type: netProfit > 0 ? "income" : "expense",
          amount: Math.abs(netProfit),
          categoryName: category.name,
          categoryCandidates: category.candidates,
          label: kind === "wealth"
            ? (netProfit > 0 ? "理财收益" : "理财亏损")
            : (netProfit > 0 ? "存款利息" : "存款手续费"),
        });
      }
    }
  }

  return items;
}
