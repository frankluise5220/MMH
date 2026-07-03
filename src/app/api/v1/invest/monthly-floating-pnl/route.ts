import { NextRequest, NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import {
  calculateFundPositionsFromEntries,
  type FundPositionEntryLike,
} from "@/lib/fund/recalcPosition";

export const dynamic = "force-dynamic";

type SnapshotPosition = {
  fundCode: string;
  fundName: string | null;
  units: number;
  cost: number;
  nav: number | null;
  navDate: string | null;
  marketValue: number;
  floatingPnL: number;
};

type AccountSnapshot = {
  accountId: string;
  accountName: string;
  date: string;
  totalCost: number;
  marketValue: number;
  floatingPnL: number;
  missingNavCodes: string[];
  positions: SnapshotPosition[];
};

type AccountMonthlyFloatingPnL = {
  accountId: string;
  accountName: string;
  baseline: AccountSnapshot;
  end: AccountSnapshot;
  floatingPnLChange: number;
};

function parseTargetMonth(req: NextRequest) {
  const rawMonth = req.nextUrl.searchParams.get("month")?.trim();
  const rawYear = req.nextUrl.searchParams.get("year")?.trim();
  const rawMonthNumber = req.nextUrl.searchParams.get("monthNumber")?.trim();
  const normalizedMonth = rawMonth?.match(/^(\d{4})-(\d{2})$/);
  const year = normalizedMonth ? Number(normalizedMonth[1]) : Number(rawYear);
  const month = normalizedMonth ? Number(normalizedMonth[2]) : Number(rawMonthNumber ?? rawMonth);
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2000 || year > 2100 || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function toEntryLike(row: {
  id: string;
  fundCode: string | null;
  amount: unknown;
  fundFee: unknown;
  fundArrivalAmount: unknown;
  fundUnits: unknown;
  fundSubtype: string | null;
  source: string | null;
  fundConfirmDate: Date | null;
  fundArrivalDate: Date | null;
}): FundPositionEntryLike {
  return {
    id: row.id,
    fundCode: row.fundCode,
    amount: toNumber(row.amount),
    fee: toNumber(row.fundFee ?? 0),
    arrivalAmount: row.fundArrivalAmount != null ? toNumber(row.fundArrivalAmount) : null,
    units: row.fundUnits != null ? toNumber(row.fundUnits) : null,
    subtype: row.fundSubtype,
    source: row.source,
    isPending: row.fundSubtype === "buy_failed" || (row.fundConfirmDate == null && row.fundSubtype === "buy"),
    confirmDate: row.fundConfirmDate ? ymd(row.fundConfirmDate) : null,
    arrivalDate: row.fundArrivalDate ? ymd(row.fundArrivalDate) : null,
  };
}

async function findNavOnOrBefore(fundCodes: string[], targetDate: Date) {
  const rows = await prisma.fundNavCache.findMany({
    where: {
      fundCode: { in: fundCodes },
      navDate: { lte: targetDate },
    },
    orderBy: [{ fundCode: "asc" }, { navDate: "desc" }],
    select: { fundCode: true, navDate: true, nav: true, name: true },
  });
  const result = new Map<string, { nav: number; navDate: string; name: string | null }>();
  for (const row of rows) {
    if (result.has(row.fundCode)) continue;
    result.set(row.fundCode, {
      nav: toNumber(row.nav),
      navDate: ymd(row.navDate),
      name: row.name ?? null,
    });
  }
  return result;
}

async function buildAccountSnapshot(params: {
  account: { id: string; name: string; costBasisMethod: string | null; fundUnitsDecimals: number };
  entries: FundPositionEntryLike[];
  fundNameByCode: Map<string, string>;
  date: Date;
}) {
  const fundUnitsDecimals = normalizeFundUnitsDecimals(params.account.fundUnitsDecimals);
  const entriesToDate = params.entries.filter((entry) => {
    const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
    const calcDate = subtype === "buy" || subtype === "dividend_reinvest"
      ? (entry.confirmDate ?? entry.arrivalDate)
      : entry.confirmDate;
    return !!calcDate && calcDate <= ymd(params.date);
  });
  const calc = calculateFundPositionsFromEntries(entriesToDate, fundUnitsDecimals, params.account.costBasisMethod);
  const fundCodes = [...calc.holdings.entries()]
    .filter(([, holding]) => holding.units > 0.0001 || holding.pendingCost > 0.01)
    .map(([fundCode]) => fundCode);
  const navByCode = fundCodes.length ? await findNavOnOrBefore(fundCodes, params.date) : new Map();

  let totalCost = 0;
  let marketValue = 0;
  const missingNavCodes: string[] = [];
  const positions: SnapshotPosition[] = [];

  for (const [fundCode, holding] of calc.holdings) {
    const units = roundFundUnits(holding.units, fundUnitsDecimals);
    const cost = roundMoney(holding.cost + holding.pendingCost);
    if (units <= 0.0001 && cost <= 0.01) continue;
    const navInfo = navByCode.get(fundCode);
    if (!navInfo && units > 0.0001) missingNavCodes.push(fundCode);
    const confirmedCost = holding.cost;
    const confirmedMarketValue = navInfo && units > 0 ? units * navInfo.nav : confirmedCost;
    const rowMarketValue = roundMoney(confirmedMarketValue + holding.pendingCost);
    const floatingPnL = roundMoney(rowMarketValue - cost);
    totalCost += cost;
    marketValue += rowMarketValue;
    positions.push({
      fundCode,
      fundName: navInfo?.name ?? params.fundNameByCode.get(fundCode) ?? null,
      units,
      cost,
      nav: navInfo?.nav ?? null,
      navDate: navInfo?.navDate ?? null,
      marketValue: rowMarketValue,
      floatingPnL,
    });
  }

  const roundedCost = roundMoney(totalCost);
  const roundedMarketValue = roundMoney(marketValue);
  return {
    accountId: params.account.id,
    accountName: params.account.name,
    date: ymd(params.date),
    totalCost: roundedCost,
    marketValue: roundedMarketValue,
    floatingPnL: roundMoney(roundedMarketValue - roundedCost),
    missingNavCodes,
    positions: positions.sort((a, b) => b.marketValue - a.marketValue),
  } satisfies AccountSnapshot;
}

/**
 * GET /api/v1/invest/monthly-floating-pnl?month=YYYY-MM&accounts=id1,id2
 *
 * Rebuilds investment fund positions from TxRecord at the previous month-end and
 * current month-end, then values positions with FundNavCache on or before each
 * date. This does not require FundSnapshot rows.
 */
export async function GET(req: NextRequest) {
  try {
    const parsed = parseTargetMonth(req);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: "请提供 month=YYYY-MM，或 year=YYYY&monthNumber=M" }, { status: 400 });
    }

    const ctx = await getHouseholdScope();
    const accountFilter = req.nextUrl.searchParams.get("accounts")?.trim()
      ? req.nextUrl.searchParams.get("accounts")!.split(",").map((item) => item.trim()).filter(Boolean)
      : null;

    const monthStart = new Date(Date.UTC(parsed.year, parsed.month - 1, 1));
    const monthEnd = new Date(Date.UTC(parsed.year, parsed.month, 0));
    const baselineDate = monthStart;

    const accounts = await prisma.account.findMany({
      where: {
        ...ctx.hidFilter,
        kind: AccountKind.investment,
        ...(accountFilter ? { id: { in: accountFilter } } : {}),
      },
      select: { id: true, name: true, kind: true, investProductType: true, costBasisMethod: true, fundUnitsDecimals: true },
      orderBy: { name: "asc" },
    });
    const investmentAccounts = accounts.filter(isPureInvestmentAccount);
    const accountIds = investmentAccounts.map((account) => account.id);
    if (accountIds.length === 0) {
      return NextResponse.json({
        ok: true,
        data: {
          month: `${parsed.year}-${String(parsed.month).padStart(2, "0")}`,
          baselineDate: ymd(baselineDate),
          endDate: ymd(monthEnd),
          floatingPnLChange: 0,
          accounts: [],
        },
      });
    }

    const txRows = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        fundCode: { not: null },
        OR: [{ toAccountId: { in: accountIds } }, { accountId: { in: accountIds } }],
        ...ctx.hidFilter,
      },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        fundCode: true,
        fundName: true,
        amount: true,
        fundFee: true,
        fundArrivalAmount: true,
        fundUnits: true,
        fundSubtype: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
        source: true,
        date: true,
        createdAt: true,
      },
      orderBy: [{ fundConfirmDate: "asc" }, { date: "asc" }, { createdAt: "asc" }],
    });

    const entriesByAccountId = new Map<string, FundPositionEntryLike[]>();
    const fundNameByCode = new Map<string, string>();
    for (const row of txRows) {
      const accountId = accountIds.includes(row.toAccountId ?? "") ? row.toAccountId! : row.accountId;
      if (!accountIds.includes(accountId)) continue;
      const entry = toEntryLike(row);
      if (entry.units != null) entry.units = roundFundUnits(entry.units, 6);
      const list = entriesByAccountId.get(accountId) ?? [];
      list.push(entry);
      entriesByAccountId.set(accountId, list);
      const code = row.fundCode?.trim();
      const name = row.fundName?.trim();
      if (code && name && name !== code && !fundNameByCode.has(code)) fundNameByCode.set(code, name);
    }

    const accountResults: AccountMonthlyFloatingPnL[] = [];
    let baselineFloatingPnL = 0;
    let endFloatingPnL = 0;
    for (const account of investmentAccounts) {
      const entries = entriesByAccountId.get(account.id) ?? [];
      const baseline = await buildAccountSnapshot({ account, entries, fundNameByCode, date: baselineDate });
      const end = await buildAccountSnapshot({ account, entries, fundNameByCode, date: monthEnd });
      baselineFloatingPnL += baseline.floatingPnL;
      endFloatingPnL += end.floatingPnL;
      accountResults.push({
        accountId: account.id,
        accountName: account.name,
        baseline,
        end,
        floatingPnLChange: roundMoney(end.floatingPnL - baseline.floatingPnL),
      });
    }

    return NextResponse.json({
      ok: true,
      data: {
        month: `${parsed.year}-${String(parsed.month).padStart(2, "0")}`,
        baselineDate: ymd(baselineDate),
        endDate: ymd(monthEnd),
        baselineFloatingPnL: roundMoney(baselineFloatingPnL),
        endFloatingPnL: roundMoney(endFloatingPnL),
        floatingPnLChange: roundMoney(endFloatingPnL - baselineFloatingPnL),
        accounts: accountResults,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "月度浮盈计算失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
