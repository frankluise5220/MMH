import { NextResponse } from "next/server";
import { FundProductType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getLatestMoneyFundYield, loadMoneyFundYieldMap, shiftYmd, upsertMoneyFundYields } from "@/lib/fund/moneyFundYield";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { logger } from "@/lib/logger";

/**
 * GET  /api/v1/fund/money-yield?fundCode=000198&days=30
 * POST /api/v1/fund/money-yield  { fundCode, date, incomePer10k }
 *
 * 货币基金「每万份收益」的查询与手工补录。收益结转（份额增加）由
 * /api/v1/fund/money-income/accrue 负责，这里只维护收益数据本身。
 */

async function belongsToMoneyFundAccount(householdId: string, fundCode: string): Promise<boolean> {
  const holding = await prisma.fundHolding.findFirst({
    where: {
      fundCode,
      Account: { householdId, investProductType: FundProductType.money },
    },
    select: { id: true },
  });
  if (holding) return true;
  const entry = await prisma.fundTransaction.findFirst({
    where: { householdId, fundCode, fundProductType: FundProductType.money, deletedAt: null },
    select: { id: true },
  });
  return Boolean(entry);
}

export async function GET(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const url = new URL(request.url);
    const fundCode = (url.searchParams.get("fundCode") ?? "").trim();
    if (!/^\d{6}$/.test(fundCode)) {
      return NextResponse.json({ ok: false, error: "基金代码不合法" }, { status: 400 });
    }
    if (!(await belongsToMoneyFundAccount(householdId, fundCode))) {
      return NextResponse.json({ ok: false, error: "该基金不在货币基金账户下" }, { status: 404 });
    }

    const daysRaw = Number(url.searchParams.get("days") ?? 30);
    const days = Math.min(180, Math.max(7, Number.isFinite(daysRaw) ? Math.trunc(daysRaw) : 30));
    // 「今天」用账簿业务时区的日历日，不用进程 UTC 日期（见 AGENTS.md 时间口径契约）。
    const todayKey = todayDateBusinessYmd(await getHouseholdTimeZone(householdId));
    const [map, latest] = await Promise.all([
      loadMoneyFundYieldMap(fundCode, shiftYmd(todayKey, -(days + 2)), shiftYmd(todayKey, 1)),
      getLatestMoneyFundYield(fundCode),
    ]);
    const rows = [...map.entries()]
      .map(([date, incomePer10k]) => ({ date, incomePer10k }))
      .sort((left, right) => right.date.localeCompare(left.date));
    return NextResponse.json({ ok: true, data: { rows, latest } });
  } catch (error) {
    logger.error("Money fund yield query failed", "money-fund-yield", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await request.json().catch(() => null)) as
      | { fundCode?: unknown; date?: unknown; incomePer10k?: unknown }
      | null;
    const fundCode = typeof body?.fundCode === "string" ? body.fundCode.trim() : "";
    const date = typeof body?.date === "string" ? body.date.trim() : "";
    const incomePer10k = Number(body?.incomePer10k);

    if (!/^\d{6}$/.test(fundCode)) {
      return NextResponse.json({ ok: false, error: "基金代码不合法" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ ok: false, error: "日期格式应为 YYYY-MM-DD" }, { status: 400 });
    }
    if (!Number.isFinite(incomePer10k) || Math.abs(incomePer10k) > 100) {
      return NextResponse.json({ ok: false, error: "每万份收益超出合理范围" }, { status: 400 });
    }
    if (!(await belongsToMoneyFundAccount(householdId, fundCode))) {
      return NextResponse.json({ ok: false, error: "该基金不在货币基金账户下" }, { status: 404 });
    }

    await upsertMoneyFundYields(fundCode, [{ date, incomePer10k }], "manual");
    return NextResponse.json({ ok: true, data: { fundCode, date, incomePer10k } });
  } catch (error) {
    logger.error("Money fund yield save failed", "money-fund-yield", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "保存失败" },
      { status: 500 },
    );
  }
}
