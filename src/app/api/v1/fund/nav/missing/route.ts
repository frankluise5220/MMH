import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { refreshFundNavCacheRanges, type FundNavCacheRangeRequest } from "@/lib/fund/navCache";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

/**
 * POST /api/v1/fund/nav/missing
 *
 * 补齐当前账簿已有基金代码的历史净值缓存，主要供投资收益表在
 * 发现持仓基金缺失工作日净值时使用。
 *
 * Body:
 *   { items: [{ fundCode, date }] }
 *   或 { ranges: [{ fundCode, startDate, endDate }] }
 *
 * Success:
 *   { ok: true, requested, rangeCount, fundCount, fetched, written, failed, ranges }
 */
type MissingNavItem = {
  fundCode?: unknown;
  date?: unknown;
};

type MissingNavRange = {
  fundCode?: unknown;
  startDate?: unknown;
  endDate?: unknown;
};

function cleanYmd(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function cleanFundCode(value: unknown) {
  return String(value ?? "").trim().replace(/\D/g, "").slice(0, 12);
}

function utcDate(dateStr: string) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function requestKey(item: Pick<FundNavCacheRangeRequest, "fundCode" | "startDate">) {
  return `${item.fundCode}|${item.startDate}`;
}

function normalizeRequests(body: { items?: MissingNavItem[]; ranges?: MissingNavRange[] }) {
  const requests: FundNavCacheRangeRequest[] = [];
  for (const item of Array.isArray(body.items) ? body.items : []) {
    const fundCode = cleanFundCode(item.fundCode);
    const date = cleanYmd(item.date);
    if (fundCode && date) requests.push({ fundCode, startDate: date, endDate: date });
  }
  for (const range of Array.isArray(body.ranges) ? body.ranges : []) {
    const fundCode = cleanFundCode(range.fundCode);
    const startDate = cleanYmd(range.startDate);
    const endDate = cleanYmd(range.endDate);
    if (fundCode && startDate && endDate) requests.push({ fundCode, startDate, endDate });
  }
  return requests.slice(0, 1000);
}

async function resolveExactRequestStatus(requests: FundNavCacheRangeRequest[]) {
  const exactRequests = requests.filter((item) => item.startDate === item.endDate);
  if (exactRequests.length === 0) return { resolvedItems: [], unresolvedItems: [] };

  const requestByKey = new Map<string, FundNavCacheRangeRequest>();
  for (const request of exactRequests) {
    requestByKey.set(requestKey(request), request);
  }

  const datesByCode = new Map<string, Set<string>>();
  for (const request of requestByKey.values()) {
    const dates = datesByCode.get(request.fundCode) ?? new Set<string>();
    dates.add(request.startDate);
    datesByCode.set(request.fundCode, dates);
  }

  const cachedRows = await prisma.fundNavCache.findMany({
    where: {
      OR: Array.from(datesByCode.entries()).map(([fundCode, dates]) => ({
        fundCode,
        navDate: { in: Array.from(dates).map(utcDate) },
      })),
    },
    select: { fundCode: true, navDate: true },
  });

  const resolvedKeys = new Set(cachedRows.map((row) => `${row.fundCode}|${ymd(row.navDate)}`));
  const resolvedItems: MissingNavItem[] = [];
  const unresolvedItems: MissingNavItem[] = [];
  for (const request of requestByKey.values()) {
    const item = { fundCode: request.fundCode, date: request.startDate };
    if (resolvedKeys.has(requestKey(request))) resolvedItems.push(item);
    else unresolvedItems.push(item);
  }

  return { resolvedItems, unresolvedItems };
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const requests = normalizeRequests(body);
    if (requests.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少要补齐的基金净值日期" }, { status: 400 });
    }

    const requestedCodes = Array.from(new Set(requests.map((item) => item.fundCode)));
    const [txCodes, holdingCodes] = await Promise.all([
      prisma.txRecord.findMany({
        where: {
          ...ctx.hidFilter,
          deletedAt: null,
          type: TransactionType.investment,
          fundCode: { in: requestedCodes },
        },
        select: { fundCode: true },
        distinct: ["fundCode"],
      }),
      prisma.fundHolding.findMany({
        where: {
          fundCode: { in: requestedCodes },
          Account: { ...ctx.hidFilter },
        },
        select: { fundCode: true },
        distinct: ["fundCode"],
      }),
    ]);
    const allowedCodes = new Set(
      [...txCodes, ...holdingCodes]
        .map((row) => row.fundCode?.trim())
        .filter((code): code is string => Boolean(code)),
    );
    const allowedRequests = requests.filter((item) => allowedCodes.has(item.fundCode));
    if (allowedRequests.length === 0) {
      return NextResponse.json({ ok: false, error: "没有可补齐的当前账簿基金代码" }, { status: 403 });
    }

    const result = await refreshFundNavCacheRanges(allowedRequests);
    const exactStatus = await resolveExactRequestStatus(allowedRequests);
    if (result.written > 0) {
      revalidateAfterInvestChange();
      revalidatePath("/reports");
    }

    return NextResponse.json({
      ok: true,
      ...result,
      ...exactStatus,
      resolved: exactStatus.resolvedItems.length,
      unresolved: exactStatus.unresolvedItems.length,
      skipped: requests.length - allowedRequests.length,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "获取缺失净值失败" },
      { status: 500 },
    );
  }
}
