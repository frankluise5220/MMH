import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { getLatestFundNav, refreshLatestFundNav } from "@/lib/fund/navCache";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function parseSince(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function parseBoolean(value: string | null) {
  return value === "1" || value === "true";
}

function changedBetween(since: Date | null, serverTime: Date) {
  return since ? { gt: since, lte: serverTime } : undefined;
}

type LatestFundNav = NonNullable<Awaited<ReturnType<typeof getLatestFundNav>>>;
type SyncFundNavRow = {
  id: string;
  fundCode: string;
  navDate: Date;
  nav: unknown;
  cumNav: unknown | null;
  name: string | null;
  updatedAt: Date;
};

function mergeLatestFundNav(rows: SyncFundNavRow[], latestByCode: Map<string, LatestFundNav>): SyncFundNavRow[] {
  const byKey = new Map(rows.map((row) => [`${row.fundCode}:${row.navDate.toISOString()}`, row]));
  for (const [fundCode, latest] of latestByCode) {
    const key = `${fundCode}:${latest.navDate.toISOString()}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        id: latest.id,
        fundCode,
        navDate: latest.navDate,
        nav: latest.nav,
        cumNav: latest.cumNav,
        name: latest.name,
        updatedAt: latest.navDate,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.navDate.getTime() - b.navDate.getTime());
}

/**
 * GET /api/v1/mobile/sync
 *
 * Android-only incremental sync endpoint. The mobile client should keep a local
 * Room cursor and call this endpoint with `since=<serverTime from previous sync>`.
 * Category currently has no updatedAt/deletedAt fields, so categories are returned
 * as a full table snapshot each time while other tables use updatedAt/deletedAt.
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  let scope;
  try {
    scope = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unauthorized" },
      { status: 401, headers: corsHeaders() },
    );
  }

  try {
    const url = new URL(req.url);
    const since = parseSince(url.searchParams.get("since"));
    const limit = parseLimit(url.searchParams.get("limit"));
    const refreshDaily = parseBoolean(url.searchParams.get("refreshDaily"));
    const serverTime = new Date();
    const updatedAt = changedBetween(since, serverTime);

    const accountWhere = {
      ...scope.hidFilter,
      ...(updatedAt ? { updatedAt } : {}),
    };
    const transactionWhere = since
      ? {
          ...scope.hidFilter,
          OR: [{ updatedAt }, { deletedAt: updatedAt }],
        }
      : { ...scope.hidFilter, deletedAt: null };

    const [accounts, categories, transactionsRaw, fundHoldings, fundConfirmDays, fundFeeRates, regularInvestPlans] = await Promise.all([
      prisma.account.findMany({
        where: accountWhere,
        select: {
          id: true,
          name: true,
          balance: true,
          kind: true,
          debtDirection: true,
          currency: true,
          isActive: true,
          isPlaceholder: true,
          investProductType: true,
          tradingCalendar: true,
          creditLimit: true,
          billingDay: true,
          repaymentDay: true,
          numberMasked: true,
          institutionId: true,
          groupId: true,
          costBasisMethod: true,
          updatedAt: true,
          AccountGroup: { select: { id: true, name: true, sortOrder: true } },
          Institution: { select: { id: true, name: true, type: true } },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.category.findMany({
        where: scope.hidFilter,
        select: { id: true, name: true, type: true, parentId: true },
        orderBy: [{ type: "asc" }, { name: "asc" }],
      }),
      prisma.txRecord.findMany({
        where: transactionWhere,
        select: {
          id: true,
          date: true,
          postedAt: true,
          type: true,
          amount: true,
          dayOrder: true,
          accountId: true,
          accountName: true,
          toAccountId: true,
          toAccountName: true,
          categoryId: true,
          categoryName: true,
          note: true,
          fundCode: true,
          fundName: true,
          fundProductType: true,
          fundSubtype: true,
          fundNav: true,
          fundUnits: true,
          fundFee: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          fundArrivalAmount: true,
          source: true,
          deletedAt: true,
          updatedAt: true,
          account: { select: { kind: true, Institution: { select: { name: true } } } },
          toAccount: { select: { kind: true, Institution: { select: { name: true } } } },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.fundHolding.findMany({
        where: {
          Account: scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          fundCode: true,
          fundName: true,
          units: true,
          avgCost: true,
          cost: true,
          nav: true,
          pendingCost: true,
          historicalProfit: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.fundConfirmDays.findMany({
        where: {
          Account: scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          fundCode: true,
          days: true,
          redeemCostDays: true,
          arrivalDays: true,
          effectiveDate: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.fundFeeRate.findMany({
        where: {
          Account: scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          accountId: true,
          fundCode: true,
          rate: true,
          feeType: true,
          effectiveDate: true,
          updatedAt: true,
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
      prisma.regularInvestPlan.findMany({
        where: {
          ...scope.hidFilter,
          ...(updatedAt ? { updatedAt } : {}),
        },
        select: {
          id: true,
          householdId: true,
          accountId: true,
          accountName: true,
          cashAccountId: true,
          cashAccountName: true,
          fundCode: true,
          fundName: true,
          fundProductType: true,
          amount: true,
          intervalUnit: true,
          intervalValue: true,
          executionDay: true,
          startDate: true,
          endDate: true,
          totalRuns: true,
          executedRuns: true,
          lastRunDate: true,
          nextRunDate: true,
          status: true,
          feeRate: true,
          confirmDays: true,
          arrivalDays: true,
          memo: true,
          skipPendingPreceding: true,
          createdAt: true,
          updatedAt: true,
          Account_RegularInvestPlan_accountIdToAccount: {
            select: { Institution: { select: { name: true } } },
          },
          Account_RegularInvestPlan_cashAccountIdToAccount: {
            select: { Institution: { select: { name: true } } },
          },
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take: limit + 1,
      }),
    ]);

    const accountBatch = accounts.slice(0, limit);
    const transactionBatch = transactionsRaw.slice(0, limit);
    const holdingBatch = fundHoldings.slice(0, limit);
    const confirmDaysBatch = fundConfirmDays.slice(0, limit);
    const feeRateBatch = fundFeeRates.slice(0, limit);
    const regularInvestPlanBatch = regularInvestPlans.slice(0, limit);

    const currentHoldingCodes = await prisma.fundHolding.findMany({
      where: { Account: scope.hidFilter },
      select: { fundCode: true },
      distinct: ["fundCode"],
    });
    const fundCodes = Array.from(
      new Set([
        ...currentHoldingCodes.map((item) => item.fundCode),
        ...holdingBatch.map((item) => item.fundCode),
        ...regularInvestPlanBatch.map((item) => item.fundCode),
        ...transactionBatch.map((item) => item.fundCode).filter((code): code is string => Boolean(code)),
      ]),
    );

    if (refreshDaily && fundCodes.length) {
      await Promise.allSettled(fundCodes.map((fundCode) => refreshLatestFundNav(fundCode)));
    }

    const latestNavEntries = await Promise.all(
      fundCodes.map(async (fundCode) => {
        const latest = await getLatestFundNav(fundCode);
        return latest ? [fundCode, latest] as const : null;
      }),
    );
    const latestNavByCode = new Map(latestNavEntries.filter((item): item is readonly [string, NonNullable<Awaited<ReturnType<typeof getLatestFundNav>>>] => item != null));

    const fundNav = fundCodes.length
      ? await prisma.fundNavCache.findMany({
          where: {
            fundCode: { in: fundCodes },
            ...(updatedAt ? { updatedAt } : {}),
          },
          select: {
            id: true,
            fundCode: true,
            navDate: true,
            nav: true,
            cumNav: true,
            name: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        })
      : [];

    const hasMore =
      accounts.length > limit ||
      transactionsRaw.length > limit ||
      fundHoldings.length > limit ||
      fundConfirmDays.length > limit ||
      fundFeeRates.length > limit ||
      regularInvestPlans.length > limit ||
      fundNav.length > limit;

    return NextResponse.json(
      {
        ok: true,
        serverTime: serverTime.toISOString(),
        hasMore,
        accounts: accountBatch.map((account) => ({
          id: account.id,
          name: account.name,
          balance: toNumber(account.balance),
          kind: account.kind,
          debtDirection: account.debtDirection,
          currency: account.currency,
          isActive: account.isActive,
          isPlaceholder: account.isPlaceholder,
          investProductType: account.investProductType,
          tradingCalendar: account.tradingCalendar,
          creditLimit: account.creditLimit == null ? null : toNumber(account.creditLimit),
          billingDay: account.billingDay,
          repaymentDay: account.repaymentDay,
          numberMasked: account.numberMasked,
          institutionId: account.institutionId,
          institutionName: account.Institution?.name ?? null,
          groupId: account.groupId,
          groupName: account.AccountGroup.name,
          costBasisMethod: account.costBasisMethod,
          updatedAt: account.updatedAt.toISOString(),
        })),
        categories,
        transactions: transactionBatch
          .filter((tx) => !tx.deletedAt)
          .map((tx) => ({
            id: tx.id,
            date: formatDateUtc(tx.date),
            postedAt: tx.postedAt ? tx.postedAt.toISOString() : null,
            type: tx.type,
            amount: toNumber(tx.amount),
            dayOrder: tx.dayOrder,
            accountId: tx.accountId,
            accountName: tx.accountName,
            accountKind: tx.account.kind,
            accountInstitutionName: tx.account.Institution?.name ?? null,
            toAccountId: tx.toAccountId,
            toAccountName: tx.toAccountName,
            toAccountKind: tx.toAccount?.kind ?? null,
            toAccountInstitutionName: tx.toAccount?.Institution?.name ?? null,
            categoryId: tx.categoryId,
            categoryName: tx.categoryName,
            note: tx.note,
            fundCode: tx.fundCode,
            fundName: tx.fundName,
            fundProductType: tx.fundProductType,
            fundSubtype: tx.fundSubtype,
            fundNav: tx.fundNav == null ? null : toNumber(tx.fundNav),
            fundUnits: tx.fundUnits == null ? null : toNumber(tx.fundUnits),
            fundFee: tx.fundFee == null ? null : toNumber(tx.fundFee),
            fundConfirmDate: tx.fundConfirmDate ? formatDateUtc(tx.fundConfirmDate) : null,
            fundArrivalDate: tx.fundArrivalDate ? formatDateUtc(tx.fundArrivalDate) : null,
            fundArrivalAmount: tx.fundArrivalAmount == null ? null : toNumber(tx.fundArrivalAmount),
            source: tx.source,
            updatedAt: tx.updatedAt.toISOString(),
          })),
        deletedTransactionIds: transactionBatch.filter((tx) => tx.deletedAt).map((tx) => tx.id),
        fundHoldings: holdingBatch.map((item) => {
          const latestNav = latestNavByCode.get(item.fundCode);
          return {
            id: item.id,
            accountId: item.accountId,
            fundCode: item.fundCode,
            fundName: item.fundName ?? latestNav?.name ?? null,
            units: toNumber(item.units),
            avgCost: toNumber(item.avgCost),
            cost: toNumber(item.cost),
            nav: latestNav?.nav ?? (item.nav == null ? null : toNumber(item.nav)),
            navDate: latestNav ? formatDateUtc(latestNav.navDate) : null,
            pendingCost: toNumber(item.pendingCost),
            historicalProfit: toNumber(item.historicalProfit),
            updatedAt: item.updatedAt.toISOString(),
          };
        }),
        regularInvestPlans: regularInvestPlanBatch.map((item) => ({
          id: item.id,
          householdId: item.householdId ?? "",
          accountId: item.accountId,
          accountName: item.accountName,
          accountInstitutionName: item.Account_RegularInvestPlan_accountIdToAccount.Institution?.name ?? null,
          cashAccountId: item.cashAccountId,
          cashAccountName: item.cashAccountName,
          cashAccountInstitutionName: item.Account_RegularInvestPlan_cashAccountIdToAccount?.Institution?.name ?? null,
          fundCode: item.fundCode,
          fundName: item.fundName ?? latestNavByCode.get(item.fundCode)?.name ?? "",
          fundProductType: item.fundProductType,
          amount: toNumber(item.amount),
          intervalUnit: item.intervalUnit,
          intervalValue: item.intervalValue,
          executionDay: item.executionDay,
          startDate: formatDateUtc(item.startDate),
          endDate: item.endDate ? formatDateUtc(item.endDate) : null,
          totalRuns: item.totalRuns,
          executedRuns: item.executedRuns,
          lastRunDate: item.lastRunDate ? formatDateUtc(item.lastRunDate) : null,
          nextRunDate: formatDateUtc(item.nextRunDate),
          status: item.status,
          feeRate: item.feeRate == null ? null : toNumber(item.feeRate),
          confirmDays: item.confirmDays,
          arrivalDays: item.arrivalDays,
          memo: item.memo,
          skipPendingPreceding: item.skipPendingPreceding,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
        fundConfirmDays: confirmDaysBatch.map((item) => ({
          id: item.id,
          accountId: item.accountId,
          fundCode: item.fundCode,
          days: item.days,
          redeemCostDays: item.redeemCostDays,
          arrivalDays: item.arrivalDays,
          effectiveDate: item.effectiveDate.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
        fundFeeRates: feeRateBatch.map((item) => ({
          id: item.id,
          accountId: item.accountId,
          fundCode: item.fundCode,
          rate: toNumber(item.rate),
          feeType: item.feeType,
          effectiveDate: item.effectiveDate.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
        fundNav: mergeLatestFundNav(fundNav.slice(0, limit), latestNavByCode).map((item) => ({
          id: item.id,
          fundCode: item.fundCode,
          navDate: formatDateUtc(item.navDate),
          nav: toNumber(item.nav),
          cumNav: item.cumNav == null ? null : toNumber(item.cumNav),
          name: item.name,
          updatedAt: item.updatedAt.toISOString(),
        })),
      },
      { headers: corsHeaders() },
    );
  } catch (e) {
    console.error("GET /api/v1/mobile/sync error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Sync failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
