import { TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
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

type ProfitEvent = {
  date: Date;
  kind: InvestmentProfitKind;
  profit: number;
};

function productKindOf(entry: InvestmentStatisticEntryLike): InvestmentProfitKind {
  if (entry.fundProductType === "wealth") return "wealth";
  if (entry.fundProductType === "deposit") return "deposit";
  return "fund";
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addEventToBucket(bucket: InvestmentProfitReportRow, event: ProfitEvent) {
  if (event.kind === "wealth") bucket.wealthProfit += event.profit;
  else if (event.kind === "deposit") bucket.depositProfit += event.profit;
  else bucket.fundProfit += event.profit;
  bucket.totalProfit += event.profit;
  bucket.count += 1;
}

function createRow(key: string, label: string, subLabel = ""): InvestmentProfitReportRow {
  return {
    key,
    label,
    subLabel,
    fundProfit: 0,
    wealthProfit: 0,
    depositProfit: 0,
    totalProfit: 0,
    count: 0,
  };
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

function monthLabel(month: number) {
  return `${month}月`;
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildRows(params: {
  period: InvestmentProfitPeriod;
  year: number;
  month: number;
  currentYear: number;
  events: ProfitEvent[];
}) {
  if (params.period === "day") {
    const rows = new Map<string, InvestmentProfitReportRow>();
    const totalDays = daysInMonth(params.year, params.month);
    for (let day = 1; day <= totalDays; day += 1) {
      const key = `${params.year}-${String(params.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      rows.set(key, createRow(key, `${day}号`, key));
    }
    for (const event of params.events) {
      const key = dateKey(event.date);
      const row = rows.get(key);
      if (row) addEventToBucket(row, event);
    }
    return Array.from(rows.values());
  }

  if (params.period === "month") {
    const rows = new Map<string, InvestmentProfitReportRow>();
    for (let month = 1; month <= 12; month += 1) {
      const key = `${params.year}-${String(month).padStart(2, "0")}`;
      rows.set(key, createRow(key, monthLabel(month), `${params.year}年${monthLabel(month)}`));
    }
    for (const event of params.events) {
      if (event.date.getUTCFullYear() !== params.year) continue;
      const month = event.date.getUTCMonth() + 1;
      const row = rows.get(`${params.year}-${String(month).padStart(2, "0")}`);
      if (row) addEventToBucket(row, event);
    }
    return Array.from(rows.values());
  }

  const eventYears = params.events.map((event) => event.date.getUTCFullYear());
  const firstYear = Math.min(...eventYears, params.currentYear);
  const rows = new Map<string, InvestmentProfitReportRow>();
  for (let year = firstYear; year <= params.currentYear; year += 1) {
    const key = String(year);
    rows.set(key, createRow(key, `${year}年`, ""));
  }
  for (const event of params.events) {
    const key = String(event.date.getUTCFullYear());
    const row = rows.get(key);
    if (row) addEventToBucket(row, event);
  }
  return Array.from(rows.values());
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
  const currentYear = now.getFullYear();
  const start = params.period === "year"
    ? new Date(Date.UTC(1970, 0, 1))
    : params.period === "day"
      ? new Date(Date.UTC(params.year, params.month - 1, 1))
      : new Date(Date.UTC(params.year, 0, 1));
  const endExclusive = params.period === "year"
    ? new Date(Date.UTC(currentYear + 1, 0, 1))
    : params.period === "day"
      ? new Date(Date.UTC(params.year, params.month, 1))
      : new Date(Date.UTC(params.year + 1, 0, 1));
  const accountIds = Array.from(new Set(params.accountIds?.filter(Boolean) ?? []));
  const tagIds = Array.from(new Set(params.tagIds?.filter(Boolean) ?? []));
  const accountFilter = accountIds.length
    ? { OR: [{ accountId: { in: accountIds } }, { toAccountId: { in: accountIds } }] }
    : {};
  const tagFilter = tagIds.length ? { EntryTag: { some: { tagId: { in: tagIds } } } } : {};

  const txEntries = await prisma.txRecord.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      type: TransactionType.investment,
      date: { gte: start, lt: endExclusive },
      ...accountFilter,
      ...tagFilter,
    },
    select: {
      id: true,
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
    start,
    endExclusive,
    accountIds,
    tagIds,
    excludeEntryIds: representedInvestmentEntryIds,
  });
  const events = [
    ...txEntries.flatMap(eventsFromEntry),
    ...wealthEntries.flatMap(eventsFromEntry),
  ].filter((event) => event.profit !== 0);
  const rows = buildRows({
    period: params.period,
    year: params.year,
    month: params.month,
    currentYear,
    events,
  });
  const totals = rows.reduce(
    (sum, row) => ({
      fundProfit: sum.fundProfit + row.fundProfit,
      wealthProfit: sum.wealthProfit + row.wealthProfit,
      depositProfit: sum.depositProfit + row.depositProfit,
      totalProfit: sum.totalProfit + row.totalProfit,
      count: sum.count + row.count,
    }),
    { fundProfit: 0, wealthProfit: 0, depositProfit: 0, totalProfit: 0, count: 0 },
  );

  return {
    rows,
    totals,
    eventCount: events.length,
  };
}
