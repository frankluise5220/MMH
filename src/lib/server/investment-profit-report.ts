import { AccountKind, TransactionType } from "@prisma/client";

import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { isTradingClosedDate, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  calculateFundPositionsFromEntries,
  type FundPositionEntryLike,
} from "@/lib/fund/recalcPosition";
import { allocateBuyFailedRefunds } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import { loadWealthStatisticSourceEntries } from "@/lib/server/investment-statistic-sources";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { getInvestmentStatisticItems, type InvestmentStatisticEntryLike } from "@/lib/transaction-statistics";

export type InvestmentProfitPeriod = "day" | "month" | "year";
export type InvestmentProfitKind = "fund" | "wealth" | "deposit";

export type InvestmentProfitReportRow = {
  key: string;
  label: string;
  subLabel: string;
  fundProfit: number;
  wealthProfit: number;
  depositProfit: number;
  totalProfit: number;
  count: number;
};

export type InvestmentProfitMissingNav = {
  fundCode: string;
  date: string;
  accountId: string;
  accountName: string;
};

type ProfitEvent = {
  date: Date;
  kind: InvestmentProfitKind;
  profit: number;
};

type Bucket = {
  key: string;
  label: string;
  subLabel: string;
  start: Date;
  end: Date;
};

type FundLikeAccount = {
  id: string;
  name: string;
  investProductType: string | null;
  costBasisMethod: string | null;
  fundUnitsDecimals: number;
  tradingCalendar: string | null;
};

type FundTxRow = {
  id: string;
  accountId: string;
  toAccountId: string | null;
  fundCode: string | null;
  amount: unknown;
  fundFee: unknown;
  fundArrivalAmount: unknown;
  fundUnits: unknown;
  fundSubtype: string | null;
  fundConfirmDate: Date | null;
  fundArrivalDate: Date | null;
  fundSourceEntryId: string | null;
  source: string | null;
  createdAt: Date;
  date: Date;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function utcDay(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function endOfMonth(year: number, month: number) {
  return utcDay(year, month, 0);
}

function monthLabel(month: number) {
  return `${month}月`;
}

function productKindOf(entry: InvestmentStatisticEntryLike): InvestmentProfitKind {
  if (entry.fundProductType === "wealth") return "wealth";
  if (entry.fundProductType === "deposit") return "deposit";
  return "fund";
}

function createRow(bucket: Pick<Bucket, "key" | "label" | "subLabel">): InvestmentProfitReportRow {
  return {
    key: bucket.key,
    label: bucket.label,
    subLabel: bucket.subLabel,
    fundProfit: 0,
    wealthProfit: 0,
    depositProfit: 0,
    totalProfit: 0,
    count: 0,
  };
}

function addProfit(row: InvestmentProfitReportRow, kind: InvestmentProfitKind, profit: number, count = 1) {
  if (profit === 0) return;
  if (kind === "wealth") row.wealthProfit += profit;
  else if (kind === "deposit") row.depositProfit += profit;
  else row.fundProfit += profit;
  row.totalProfit += profit;
  row.count += count;
}

function eventBucketKey(date: Date, period: InvestmentProfitPeriod) {
  const key = ymd(date);
  if (period === "day") return key;
  if (period === "month") return key.slice(0, 7);
  return key.slice(0, 4);
}

function eventsFromEntry(entry: InvestmentStatisticEntryLike & { date: Date; source?: string | null }) {
  if (entry.source === "insurance") return [];
  const kind = productKindOf(entry);
  return getInvestmentStatisticItems(entry).map((item): ProfitEvent => ({
    date: entry.date,
    kind,
    profit: item.type === "income" ? item.amount : -item.amount,
  }));
}

function buildBuckets(period: InvestmentProfitPeriod, year: number, month: number, currentYear: number, firstYear: number) {
  if (period === "day") {
    return Array.from({ length: daysInMonth(year, month) }, (_, index): Bucket => {
      const day = index + 1;
      const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const date = utcDay(year, month - 1, day);
      return { key, label: `${day}号`, subLabel: key, start: date, end: date };
    });
  }

  if (period === "month") {
    return Array.from({ length: 12 }, (_, index): Bucket => {
      const m = index + 1;
      const key = `${year}-${String(m).padStart(2, "0")}`;
      return {
        key,
        label: monthLabel(m),
        subLabel: `${year}年${monthLabel(m)}`,
        start: utcDay(year, m - 1, 1),
        end: endOfMonth(year, m),
      };
    });
  }

  return Array.from({ length: currentYear - firstYear + 1 }, (_, index): Bucket => {
    const rowYear = firstYear + index;
    return {
      key: String(rowYear),
      label: `${rowYear}年`,
      subLabel: "",
      start: utcDay(rowYear, 0, 1),
      end: utcDay(rowYear, 11, 31),
    };
  });
}

function periodStart(period: InvestmentProfitPeriod, year: number, month: number, firstYear: number) {
  if (period === "day") return utcDay(year, month - 1, 1);
  if (period === "month") return utcDay(year, 0, 1);
  return utcDay(firstYear, 0, 1);
}

function periodEndExclusive(period: InvestmentProfitPeriod, year: number, month: number, currentYear: number) {
  if (period === "day") return utcDay(year, month, 1);
  if (period === "month") return utcDay(year + 1, 0, 1);
  return utcDay(currentYear + 1, 0, 1);
}

function baselineDateFor(period: InvestmentProfitPeriod, year: number, month: number, firstYear: number) {
  if (period === "day") return utcDay(year, month - 1, 0);
  if (period === "month") return utcDay(year, 0, 0);
  return utcDay(firstYear, 0, 0);
}

function calcDateOf(entry: FundPositionEntryLike) {
  const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
  return subtype === "buy" || subtype === "dividend_reinvest"
    ? (entry.confirmDate ?? entry.arrivalDate ?? "")
    : (entry.confirmDate ?? entry.arrivalDate ?? "");
}

function toFundEntry(row: FundTxRow, refundAmountByBuyId: Map<string, number>): FundPositionEntryLike {
  const amount = toNumber(row.amount);
  const fee = toNumber(row.fundFee ?? 0);
  const grossAfterRefund = row.fundSubtype === "buy"
    ? Math.max(0, Math.abs(amount) - (refundAmountByBuyId.get(row.id) ?? 0))
    : null;
  const netBuyAmount = row.fundSubtype === "buy"
    ? Math.max(0, (grossAfterRefund ?? 0) - fee)
    : null;
  return {
    id: row.id,
    fundCode: row.fundCode,
    amount,
    fee,
    arrivalAmount: row.fundArrivalAmount != null ? toNumber(row.fundArrivalAmount) : null,
    units: row.fundUnits != null ? toNumber(row.fundUnits) : null,
    subtype: row.fundSubtype,
    source: row.source,
    isPending: row.fundSubtype === "buy_failed" || (row.fundConfirmDate == null && row.fundSubtype === "buy"),
    confirmDate: row.fundConfirmDate ? ymd(row.fundConfirmDate) : null,
    arrivalDate: row.fundArrivalDate ? ymd(row.fundArrivalDate) : null,
    netBuyAmount,
    pendingBuyAmount: grossAfterRefund,
  };
}

function cashFlowForReturn(entry: FundPositionEntryLike) {
  const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
  if (subtype === "buy_failed") return { cashIn: 0, cashOut: 0 };
  if (subtype === "buy" && entry.source !== "dividend") {
    return { cashIn: Math.abs(entry.amount), cashOut: 0 };
  }
  if (subtype === "redeem" || subtype === "switch_out" || subtype === "dividend_cash") {
    return { cashIn: 0, cashOut: Math.abs(entry.arrivalAmount ?? entry.amount) };
  }
  return { cashIn: 0, cashOut: 0 };
}

function latestNavOnOrBefore(
  navByCode: Map<string, Array<{ date: string; nav: number }>>,
  fundCode: string,
  date: string,
) {
  const rows = navByCode.get(fundCode);
  if (!rows?.length) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.date <= date) return row.nav;
  }
  return null;
}

function exactNavOnDate(
  navByCode: Map<string, Array<{ date: string; nav: number }>>,
  fundCode: string,
  date: string,
) {
  return navByCode.get(fundCode)?.find((row) => row.date === date)?.nav ?? null;
}

function shouldRequireExactNav(dateKey: string, todayKey: string, tradingCalendar?: string | null) {
  return dateKey < todayKey && !isTradingClosedDate(dateKey, tradingCalendar ?? "cn_fund");
}

function addMissingNav(
  missingNavByKey: Map<string, InvestmentProfitMissingNav>,
  item: InvestmentProfitMissingNav,
) {
  const key = `${item.fundCode}|${item.date}`;
  if (!missingNavByKey.has(key)) missingNavByKey.set(key, item);
}

function accountMarketValueAt(params: {
  account: FundLikeAccount;
  entries: FundPositionEntryLike[];
  navByCode: Map<string, Array<{ date: string; nav: number }>>;
  date: Date;
  todayKey: string;
  missingNavByKey: Map<string, InvestmentProfitMissingNav>;
}) {
  const dateKey = ymd(params.date);
  const entriesToDate = params.entries.filter((entry) => {
    const calcDate = calcDateOf(entry);
    return !!calcDate && calcDate <= dateKey;
  });
  const calc = calculateFundPositionsFromEntries(
    entriesToDate,
    normalizeFundUnitsDecimals(params.account.fundUnitsDecimals),
    params.account.costBasisMethod,
  );

  let marketValue = 0;
  for (const [fundCode, holding] of calc.holdings) {
    const units = holding.units;
    const pending = holding.pendingCost;
    const confirmedCost = holding.cost;
    if (units <= 0.0001 && pending <= 0.01) continue;
    const exactNav = exactNavOnDate(params.navByCode, fundCode, dateKey);
    if (units > 0 && exactNav == null && shouldRequireExactNav(dateKey, params.todayKey, params.account.tradingCalendar)) {
      addMissingNav(params.missingNavByKey, {
        fundCode,
        date: dateKey,
        accountId: params.account.id,
        accountName: params.account.name,
      });
    }
    const nav = exactNav ?? latestNavOnOrBefore(params.navByCode, fundCode, dateKey);
    const confirmedMarketValue = nav != null && units > 0 ? units * nav : confirmedCost;
    marketValue += confirmedMarketValue + pending;
  }
  return roundMoney(marketValue);
}

function bucketCashFlows(params: {
  entries: FundPositionEntryLike[];
  start: Date;
  end: Date;
}) {
  const start = ymd(params.start);
  const end = ymd(params.end);
  let cashIn = 0;
  let cashOut = 0;
  for (const entry of params.entries) {
    const calcDate = calcDateOf(entry);
    if (!calcDate || calcDate < start || calcDate > end) continue;
    const flow = cashFlowForReturn(entry);
    cashIn += flow.cashIn;
    cashOut += flow.cashOut;
  }
  return { cashIn, cashOut };
}

async function applyFundValuationProfit(params: {
  rows: Map<string, InvestmentProfitReportRow>;
  buckets: Bucket[];
  accounts: FundLikeAccount[];
  txRows: FundTxRow[];
}) {
  if (params.accounts.length === 0 || params.buckets.length === 0) return [];

  const snapshotAccountIds = new Set(params.accounts.map((account) => account.id));
  const accountById = new Map(params.accounts.map((account) => [account.id, account]));
  const entriesByAccountId = new Map<string, FundPositionEntryLike[]>();
  const fundCodes = new Set<string>();
  const missingNavByKey = new Map<string, InvestmentProfitMissingNav>();
  const todayKey = ymd(new Date());
  const { refundAmountByBuyId } = allocateBuyFailedRefunds(params.txRows.map((row) => ({
    id: row.id,
    date: row.date,
    createdAt: row.createdAt,
    fundConfirmDate: row.fundConfirmDate,
    fundArrivalDate: row.fundArrivalDate,
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    fundCode: row.fundCode,
    fundSubtype: row.fundSubtype,
    fundUnits: row.fundUnits != null ? toNumber(row.fundUnits) : null,
    source: row.source,
    amount: toNumber(row.amount),
    fundSourceEntryId: row.fundSourceEntryId,
  })));

  for (const row of params.txRows) {
    const accountId = row.toAccountId && snapshotAccountIds.has(row.toAccountId)
      ? row.toAccountId
      : row.accountId;
    if (!snapshotAccountIds.has(accountId)) continue;
    const entry = toFundEntry(row, refundAmountByBuyId);
    if (!entry.fundCode) continue;
    fundCodes.add(entry.fundCode);
    const entries = entriesByAccountId.get(accountId) ?? [];
    entries.push(entry);
    entriesByAccountId.set(accountId, entries);
  }

  if (fundCodes.size === 0) return [];

  const maxBoundary = params.buckets[params.buckets.length - 1]!.end;
  const navRows = await prisma.fundNavCache.findMany({
    where: {
      fundCode: { in: Array.from(fundCodes) },
      navDate: { lte: maxBoundary },
    },
    select: { fundCode: true, navDate: true, nav: true },
    orderBy: [{ fundCode: "asc" }, { navDate: "asc" }],
  });
  const navByCode = new Map<string, Array<{ date: string; nav: number }>>();
  for (const navRow of navRows) {
    const list = navByCode.get(navRow.fundCode) ?? [];
    list.push({ date: ymd(navRow.navDate), nav: toNumber(navRow.nav) });
    navByCode.set(navRow.fundCode, list);
  }

  let previousSnapshot = 0;
  for (const [index, bucket] of params.buckets.entries()) {
    if (index === 0) {
      const baseline = new Date(bucket.start);
      baseline.setUTCDate(baseline.getUTCDate() - 1);
      previousSnapshot = params.accounts.reduce((sum, account) => {
        const entries = entriesByAccountId.get(account.id) ?? [];
        return sum + accountMarketValueAt({ account, entries, navByCode, date: baseline, todayKey, missingNavByKey });
      }, 0);
    }

    let currentSnapshot = 0;
    let cashIn = 0;
    let cashOut = 0;
    let contributorCount = 0;
    for (const account of params.accounts) {
      const entries = entriesByAccountId.get(account.id) ?? [];
      currentSnapshot += accountMarketValueAt({ account, entries, navByCode, date: bucket.end, todayKey, missingNavByKey });
      const flow = bucketCashFlows({ entries, start: bucket.start, end: bucket.end });
      cashIn += flow.cashIn;
      cashOut += flow.cashOut;
      if (flow.cashIn !== 0 || flow.cashOut !== 0 || accountById.has(account.id)) contributorCount += 1;
    }

    const profit = roundMoney(currentSnapshot + cashOut - cashIn - previousSnapshot);
    const row = params.rows.get(bucket.key);
    if (row) addProfit(row, "fund", profit, Math.max(1, contributorCount));
    previousSnapshot = currentSnapshot;
  }

  return Array.from(missingNavByKey.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.fundCode.localeCompare(b.fundCode, "zh-Hans-CN"),
  );
}

function findFirstDataYear(params: {
  currentYear: number;
  txRows: FundTxRow[];
  eventRows: Array<{ date: Date }>;
}) {
  const years = [
    ...params.txRows.map((row) => (row.fundConfirmDate ?? row.date).getUTCFullYear()),
    ...params.eventRows.map((row) => row.date.getUTCFullYear()),
  ].filter((year) => Number.isInteger(year) && year >= 1900 && year <= params.currentYear);
  return years.length ? Math.min(...years) : params.currentYear;
}

export async function loadInvestmentProfitReport(
  ctx: HouseholdContext,
  params: {
    period: InvestmentProfitPeriod;
    year: number;
    month: number;
    accountIds?: string[] | null;
    tagIds?: string[] | null;
  },
) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const accountIds = Array.from(new Set(params.accountIds?.filter(Boolean) ?? []));
  const tagIds = Array.from(new Set(params.tagIds?.filter(Boolean) ?? []));

  const accounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      kind: AccountKind.investment,
      ...(accountIds.length ? { id: { in: accountIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      kind: true,
      investProductType: true,
      costBasisMethod: true,
      fundUnitsDecimals: true,
      tradingCalendar: true,
    },
    orderBy: { name: "asc" },
  });
  const investmentAccounts = accounts.filter(isPureInvestmentAccount);
  const investmentAccountIds = investmentAccounts.map((account) => account.id);
  const snapshotAccounts: FundLikeAccount[] = investmentAccounts
    .filter((account) => account.investProductType === "fund" || account.investProductType == null)
    .map((account) => ({
      id: account.id,
      name: account.name,
      investProductType: account.investProductType,
      costBasisMethod: account.costBasisMethod,
      fundUnitsDecimals: account.fundUnitsDecimals ?? 3,
      tradingCalendar: account.tradingCalendar ?? "cn_fund",
    }));
  const snapshotAccountIds = new Set(snapshotAccounts.map((account) => account.id));

  const snapshotAccountFilter = investmentAccountIds.length
    ? { OR: [{ accountId: { in: investmentAccountIds } }, { toAccountId: { in: investmentAccountIds } }] }
    : {};
  const maxSnapshotDate = params.period === "year"
    ? utcDay(currentYear, 11, 31)
    : params.period === "day"
      ? endOfMonth(params.year, params.month)
      : endOfMonth(params.year, 12);
  const fundTxRows = await prisma.txRecord.findMany({
    where: {
      ...ctx.hidFilter,
      deletedAt: null,
      type: TransactionType.investment,
      fundCode: { not: null },
      date: { lte: maxSnapshotDate },
      ...snapshotAccountFilter,
    },
    select: {
      id: true,
      accountId: true,
      toAccountId: true,
      fundCode: true,
      amount: true,
      fundFee: true,
      fundArrivalAmount: true,
      fundUnits: true,
      fundSubtype: true,
      fundConfirmDate: true,
      fundArrivalDate: true,
      fundSourceEntryId: true,
      source: true,
      createdAt: true,
      date: true,
    },
    orderBy: [{ fundConfirmDate: "asc" }, { date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 50000,
  });

  const broadStart = params.period === "year" ? utcDay(1970, 0, 1) : periodStart(params.period, params.year, params.month, params.year);
  const broadEndExclusive = periodEndExclusive(params.period, params.year, params.month, currentYear);
  const eventAccountFilter = investmentAccountIds.length
    ? { OR: [{ accountId: { in: investmentAccountIds } }, { toAccountId: { in: investmentAccountIds } }] }
    : {};
  const tagFilter = tagIds.length ? { EntryTag: { some: { tagId: { in: tagIds } } } } : {};

  const txEntries = await prisma.txRecord.findMany({
    where: {
      ...ctx.hidFilter,
      deletedAt: null,
      type: TransactionType.investment,
      date: { gte: broadStart, lt: broadEndExclusive },
      ...eventAccountFilter,
      ...tagFilter,
    },
    select: {
      id: true,
      accountId: true,
      toAccountId: true,
      date: true,
      amount: true,
      source: true,
      fundSubtype: true,
      fundProductType: true,
      fundCode: true,
      fundName: true,
      realizedProfit: true,
      depositInterest: true,
      fundFee: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 50000,
  });

  const representedInvestmentEntryIds = new Set(
    txEntries
      .filter((entry) => getInvestmentStatisticItems(entry).length > 0)
      .map((entry) => entry.id),
  );
  const wealthEntries = await loadWealthStatisticSourceEntries(ctx, {
    start: broadStart,
    endExclusive: broadEndExclusive,
    accountIds: investmentAccountIds,
    tagIds,
    excludeEntryIds: representedInvestmentEntryIds,
  });

  const firstYear = params.period === "year"
    ? findFirstDataYear({ currentYear, txRows: fundTxRows, eventRows: [...txEntries, ...wealthEntries] })
    : params.year;
  const buckets = buildBuckets(params.period, params.year, params.month, currentYear, firstYear);
  const rows = new Map(buckets.map((bucket) => [bucket.key, createRow(bucket)]));

  const missingNavs = await applyFundValuationProfit({
    rows,
    buckets,
    accounts: snapshotAccounts,
    txRows: fundTxRows,
  });

  const accountTypeById = new Map(investmentAccounts.map((account) => [account.id, account.investProductType]));
  const events = [
    ...txEntries.flatMap((entry) => {
      const accountId = entry.toAccountId && accountTypeById.has(entry.toAccountId) ? entry.toAccountId : entry.accountId;
      if (snapshotAccountIds.has(accountId)) return [];
      return eventsFromEntry(entry);
    }),
    ...wealthEntries.flatMap(eventsFromEntry),
  ].filter((event) => event.profit !== 0);

  for (const event of events) {
    const row = rows.get(eventBucketKey(event.date, params.period));
    if (row) addProfit(row, event.kind, event.profit);
  }

  const orderedRows = buckets.map((bucket) => rows.get(bucket.key)!).map((row) => ({
    ...row,
    fundProfit: roundMoney(row.fundProfit),
    wealthProfit: roundMoney(row.wealthProfit),
    depositProfit: roundMoney(row.depositProfit),
    totalProfit: roundMoney(row.totalProfit),
  }));
  const totals = orderedRows.reduce(
    (sum, row) => ({
      fundProfit: roundMoney(sum.fundProfit + row.fundProfit),
      wealthProfit: roundMoney(sum.wealthProfit + row.wealthProfit),
      depositProfit: roundMoney(sum.depositProfit + row.depositProfit),
      totalProfit: roundMoney(sum.totalProfit + row.totalProfit),
      count: sum.count + row.count,
    }),
    { fundProfit: 0, wealthProfit: 0, depositProfit: 0, totalProfit: 0, count: 0 },
  );

  return {
    rows: orderedRows,
    totals,
    eventCount: events.length,
    start: ymd(periodStart(params.period, params.year, params.month, firstYear)),
    end: ymd(buckets[buckets.length - 1]?.end ?? new Date()),
    baselineDate: ymd(baselineDateFor(params.period, params.year, params.month, firstYear)),
    missingNavs,
  };
}
