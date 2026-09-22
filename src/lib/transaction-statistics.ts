import type { FundProductType, FundSubtype } from "@prisma/client";
import { TransactionType } from "@prisma/client";

import { toNumber } from "@/lib/date-utils";
import {
  SYSTEM_DEPOSIT_FEE_CATEGORY,
  SYSTEM_DEPOSIT_INTEREST_CATEGORY,
  SYSTEM_FINANCE_INVESTMENT_INCOME_CATEGORY,
  SYSTEM_FUND_LOSS_CATEGORY,
  SYSTEM_FUND_PROFIT_CATEGORY,
  SYSTEM_INVESTMENT_DIVIDEND_CATEGORY,
  SYSTEM_INVESTMENT_LOSS_CATEGORY,
  SYSTEM_WEALTH_LOSS_CATEGORY,
  SYSTEM_WEALTH_PROFIT_CATEGORY,
} from "@/lib/default-categories";
import { isDebtPrincipalTransfer, TRANSACTION_SOURCE_BOND } from "@/lib/transaction-semantics";

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

type InvestmentProductKind = "fund" | "wealth" | "deposit" | "debt";

const MONEY_EPSILON = 0.005;

export type InvestmentStatisticEntryLike = {
  id: string;
  amount: unknown;
  type?: TransactionType | string | null;
  source?: string | null;
  /** 账户现状 kind，用于判断历史 source 是否仍应按债务口径统计。 */
  accountKind?: string | null;
  toAccountKind?: string | null;
  fundSubtype?: FundSubtype | string | null;
  fundProductType?: FundProductType | string | null;
  realizedProfit?: unknown | null;
  debtInterestAmount?: unknown | null;
  depositInterest?: unknown | null;
  fundFee?: unknown | null;
  fundUnits?: unknown | null;
  fundNav?: unknown | null;
  fundCode?: string | null;
  fundName?: string | null;
};

export type InvestmentStatisticItem = {
  idSuffix: string;
  type: InvestmentStatisticType;
  productKind: InvestmentProductKind;
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

export const BOND_INTEREST_INCOME_CATEGORY_CANDIDATES = [
  SYSTEM_FINANCE_INVESTMENT_INCOME_CATEGORY,
  "投资收入",
];

/**
 * Auto-posted bond interest income rows (source "bond", fundSubtype
 * "dividend_cash") carry an investment-type category snapshot that is not
 * part of the income/expense tree, so statistics must classify them through
 * the reserved finance/investment income root instead.
 */
export function isBondInterestIncomeEntry(entry: {
  type?: TransactionType | string | null;
  source?: string | null;
  fundSubtype?: string | null;
}): boolean {
  return (
    entry.type === TransactionType.income &&
    entry.source === TRANSACTION_SOURCE_BOND &&
    entry.fundSubtype === "dividend_cash"
  );
}

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

export type NamedStatisticBucket = {
  id: string | null;
  name: string;
  value: number;
};

export function addNamedStatisticBucket(
  bucketMap: Map<string, NamedStatisticBucket>,
  item: { id: string | null; name: string },
  amount: number,
) {
  if (amount === 0) return;
  const key = item.id ?? `name:${item.name}`;
  const current = bucketMap.get(key);
  if (current) {
    current.value += amount;
  } else {
    bucketMap.set(key, { id: item.id, name: item.name, value: amount });
  }
}

export function buildNamedStatisticItemsFromBuckets(
  bucketMap: Map<string, NamedStatisticBucket>,
  limit = 8,
) {
  const sorted = Array.from(bucketMap.values()).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, bucket) => sum + bucket.value, 0);
  return sorted.slice(0, limit).map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    value: bucket.value,
    pct: total > 0 ? (bucket.value / total) * 100 : 0,
  }));
}

export const UNTAGGED_STATISTIC_TAG_ID = "__untagged__";
export const UNTAGGED_STATISTIC_TAG_COLOR = "#94A3B8";

export type StatisticTagBucket = {
  id: string;
  name: string;
  color: string;
  value: number;
};

export type StatisticTagLike = {
  tagId: string;
  Tag: { id: string; name: string; color: string | null };
};

/**
 * Puts an income/expense amount into tag pie buckets. Tagged rows keep the
 * existing multi-tag full-amount behaviour; rows with no EntryTag go into a
 * synthetic 「无标签」 slice so the ring is complete instead of a silent gap.
 */
export function addStatisticTagBucket(
  bucketMap: Map<string, StatisticTagBucket>,
  tags: StatisticTagLike[] | null | undefined,
  amount: number,
  untaggedLabel = "无标签",
) {
  if (amount === 0) return;
  if (!tags || tags.length === 0) {
    const current = bucketMap.get(UNTAGGED_STATISTIC_TAG_ID);
    if (current) {
      current.value += amount;
    } else {
      bucketMap.set(UNTAGGED_STATISTIC_TAG_ID, {
        id: UNTAGGED_STATISTIC_TAG_ID,
        name: untaggedLabel,
        color: UNTAGGED_STATISTIC_TAG_COLOR,
        value: amount,
      });
    }
    return;
  }
  for (const et of tags) {
    const id = et.Tag?.id ?? et.tagId;
    if (!id) continue;
    const current = bucketMap.get(id);
    if (current) {
      current.value += amount;
    } else {
      bucketMap.set(id, {
        id,
        name: et.Tag?.name ?? id,
        color: et.Tag?.color ?? "#3B82F6",
        value: amount,
      });
    }
  }
}

export function buildStatisticTagItemsFromBuckets(
  bucketMap: Map<string, StatisticTagBucket>,
  limit = 8,
) {
  const sorted = Array.from(bucketMap.values()).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, bucket) => sum + bucket.value, 0);
  const picked = sorted.slice(0, limit);
  const untagged = bucketMap.get(UNTAGGED_STATISTIC_TAG_ID);
  if (untagged && !picked.some((bucket) => bucket.id === UNTAGGED_STATISTIC_TAG_ID)) {
    picked.push(untagged);
  }
  return picked.map((bucket) => ({
    ...bucket,
    pct: total > 0 ? (bucket.value / total) * 100 : 0,
  }));
}

export type StatisticDistributionEntryLike = {
  accountId?: string | null;
  toAccountId?: string | null;
  locationId?: string | null;
  locationName?: string | null;
};

const UNSPECIFIED_INSTITUTION_NAME = "未指定机构";

/**
 * Collects institution / location slices for the same amounts that already
 * entered income/expense category pies. Income uses the receiving account
 * (toAccountId ?? accountId); expense uses the outflow account (accountId).
 * Location buckets only include rows that actually have a location snapshot.
 */
export function createStatisticDistributionCollector(
  institutionByAccountId: Map<string, { id: string | null; name: string }>,
) {
  const incomeByInst = new Map<string, NamedStatisticBucket>();
  const expenseByInst = new Map<string, NamedStatisticBucket>();
  const incomeByLoc = new Map<string, NamedStatisticBucket>();
  const expenseByLoc = new Map<string, NamedStatisticBucket>();

  function institutionItem(accountId: string | null | undefined) {
    const inst = accountId ? institutionByAccountId.get(accountId) : undefined;
    const name = inst?.name?.trim() ?? "";
    if (inst?.id || name) {
      return { id: inst?.id ?? null, name: name || UNSPECIFIED_INSTITUTION_NAME };
    }
    return { id: null as string | null, name: UNSPECIFIED_INSTITUTION_NAME };
  }

  function locationItem(entry: StatisticDistributionEntryLike) {
    const name = entry.locationName?.trim() ?? "";
    if (!entry.locationId && !name) return null;
    return { id: entry.locationId ?? null, name: name || "未填地点" };
  }

  function sliceAccountId(entry: StatisticDistributionEntryLike, side: "income" | "expense") {
    return side === "income" ? (entry.toAccountId || entry.accountId || null) : (entry.accountId || null);
  }

  return {
    add(side: "income" | "expense", entry: StatisticDistributionEntryLike, amount: number) {
      addNamedStatisticBucket(
        side === "income" ? incomeByInst : expenseByInst,
        institutionItem(sliceAccountId(entry, side)),
        amount,
      );
      const loc = locationItem(entry);
      if (loc) {
        addNamedStatisticBucket(side === "income" ? incomeByLoc : expenseByLoc, loc, amount);
      }
    },
    build(limit = 8) {
      return {
        incomeInstitutions: buildNamedStatisticItemsFromBuckets(incomeByInst, limit),
        expenseInstitutions: buildNamedStatisticItemsFromBuckets(expenseByInst, limit),
        incomeLocations: buildNamedStatisticItemsFromBuckets(incomeByLoc, limit),
        expenseLocations: buildNamedStatisticItemsFromBuckets(expenseByLoc, limit),
      };
    },
  };
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

function storedResultLooksLikeCashReceiptTotal(entry: InvestmentStatisticEntryLike, result: number) {
  const cashAmount = Math.abs(toNumber(entry.amount));
  return cashAmount > MONEY_EPSILON && Math.abs(Math.abs(result) - cashAmount) <= MONEY_EPSILON;
}

function hasUnitBasedResultEvidence(entry: InvestmentStatisticEntryLike) {
  return toNumber(entry.fundUnits) > 0 || toNumber(entry.fundNav) > 0;
}

function profitCategory(kind: InvestmentProductKind, value: number) {
  if (kind === "wealth") {
    return value >= 0
      ? { name: SYSTEM_WEALTH_PROFIT_CATEGORY, candidates: [SYSTEM_WEALTH_PROFIT_CATEGORY, "投资收益", SYSTEM_FINANCE_INVESTMENT_INCOME_CATEGORY, "投资收入"] }
      : { name: SYSTEM_WEALTH_LOSS_CATEGORY, candidates: [SYSTEM_INVESTMENT_LOSS_CATEGORY, SYSTEM_WEALTH_LOSS_CATEGORY] };
  }
  if (kind === "deposit") {
    return value >= 0
      ? { name: SYSTEM_DEPOSIT_INTEREST_CATEGORY, candidates: [SYSTEM_DEPOSIT_INTEREST_CATEGORY, "利息", "投资收益"] }
      : { name: SYSTEM_DEPOSIT_FEE_CATEGORY, candidates: [SYSTEM_INVESTMENT_LOSS_CATEGORY, SYSTEM_DEPOSIT_FEE_CATEGORY] };
  }
  return value >= 0
    ? { name: SYSTEM_FUND_PROFIT_CATEGORY, candidates: [SYSTEM_FUND_PROFIT_CATEGORY, "投资收益", SYSTEM_FINANCE_INVESTMENT_INCOME_CATEGORY, "投资收入"] }
    : { name: SYSTEM_FUND_LOSS_CATEGORY, candidates: [SYSTEM_INVESTMENT_LOSS_CATEGORY, SYSTEM_FUND_LOSS_CATEGORY] };
}

/**
 * Converts investment transactions into category-statistics rows.
 *
 * Cash account balance still uses the real cash flow (`fundArrivalAmount` etc.).
 * This helper only exposes the economic P/L portion for reports/statistics:
 * fund realized P/L comes from the canonical fund recalculation result
 * (`TxRecord.realizedProfit`). Wealth uses `realizedProfit` when unit-based
 * redemption recalculation has written it, and falls back to interest minus fee.
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
        : kind === "deposit"
          ? profitCategory("deposit", amount)
          : { name: SYSTEM_FUND_PROFIT_CATEGORY, candidates: [SYSTEM_FUND_PROFIT_CATEGORY, "投资收益", SYSTEM_FINANCE_INVESTMENT_INCOME_CATEGORY, "投资收入", SYSTEM_INVESTMENT_DIVIDEND_CATEGORY, "股息分红"] };
      items.push({
        idSuffix: "dividend",
        type: "income",
        productKind: kind,
        amount,
        categoryName: category.name,
        categoryCandidates: category.candidates,
        label: kind === "wealth" ? "理财分红" : kind === "deposit" ? "存款利息" : "基金收益",
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
        productKind: kind,
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
    const hasUnitBasis = hasUnitBasedResultEvidence(entry);
    if (hasRealizedProfit || hasInterest || hasFee) {
      const storedProfit = hasRealizedProfit ? toNumber(entry.realizedProfit) : null;
      const netProfit = storedProfit != null
        ? (!hasInterest && !hasFee && !hasUnitBasis && storedResultLooksLikeCashReceiptTotal(entry, storedProfit) ? 0 : storedProfit)
        : toNumber(entry.depositInterest) - toNumber(entry.fundFee);
      if (netProfit !== 0) {
        const category = profitCategory(kind, netProfit);
        items.push({
          idSuffix: "yield",
          type: netProfit > 0 ? "income" : "expense",
          productKind: kind,
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

function debtResultProfitFallback(entry: InvestmentStatisticEntryLike) {
  if (entry.realizedProfit !== null && entry.realizedProfit !== undefined) return toNumber(entry.realizedProfit);
  if (entry.debtInterestAmount === null || entry.debtInterestAmount === undefined) return 0;
  const interest = Math.abs(toNumber(entry.debtInterestAmount));
  if (interest === 0) return 0;
  // 账户两端都已改成普通账户时，历史 source 不再按债务利息口径决定正负号。
  if (!isDebtPrincipalTransfer(entry)) return 0;
  const source = String(entry.source ?? "");
  if (source === "debt_collect_in") return interest;
  if (source === "debt_repay_out" || source === "debt_prepay_out" || source === "scheduled_task" || source === "debt_lend_out") {
    return -interest;
  }
  return 0;
}

/**
 * Converts any business row that carries a realized result into statistics
 * items. `realizedProfit` is the generic economic-result field: cash flow still
 * uses the real movement amount, while reports use this field for the yield,
 * interest, gain, or loss portion.
 */
export function getBusinessResultStatisticItems(entry: InvestmentStatisticEntryLike): InvestmentStatisticItem[] {
  if (entry.type === TransactionType.investment || entry.type === "investment") {
    return getInvestmentStatisticItems(entry);
  }
  if (entry.type !== TransactionType.transfer && entry.type !== "transfer") return [];

  const profit = debtResultProfitFallback(entry);
  if (profit === 0) return [];
  const positive = profit > 0;
  return [{
    idSuffix: "realized-profit",
    type: positive ? "income" : "expense",
    productKind: "debt",
    amount: Math.abs(profit),
    categoryName: positive ? "利息" : "贷款利息",
    categoryCandidates: positive
      ? ["利息", "投资收益", SYSTEM_FINANCE_INVESTMENT_INCOME_CATEGORY, "投资收入"]
      : ["贷款利息", "利息支出"],
    label: positive ? "利息收入" : "利息支出",
  }];
}
