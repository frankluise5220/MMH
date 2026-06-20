import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { computePositionDisplay } from "@/lib/invest-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function GET(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;
    const url = new URL(req.url);
    const accountId = url.searchParams.get("accountId");
    const fundCodeParam = url.searchParams.get("fundCode") || undefined;
    const showCleared = url.searchParams.get("showCleared") === "1";

    if (!accountId) {
      return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });
    }

    // Verify account exists and is investment type
    const account = await prisma.account.findUnique({
      where: { id: accountId, ...hidFilter },
    });
    if (!account) {
      return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    }

    // Compute positions
    const positionDisplay = await computePositionDisplay(ctx, accountId);

    const selectedFundCode = fundCodeParam || (positionDisplay.positions.length > 0
      ? [...positionDisplay.positions].sort((a, b) => b.marketValue - a.marketValue)[0]?.fundCode
      : (positionDisplay.clearedPositions.length > 0
        ? [...positionDisplay.clearedPositions].sort((a, b) => b.clearedDate.localeCompare(a.clearedDate))[0]?.fundCode
        : ""));

    // Get entries for selected fund only, to avoid returning full account history on each view switch
    const fundEntries = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        fundCode: selectedFundCode || undefined,
        OR: [{ toAccountId: accountId }, { accountId: accountId }],
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 16,
    });

    // Fee rates
    const feeRateRecords = await prisma.fundFeeRate.findMany({
      where: { accountId },
      orderBy: { effectiveDate: "desc" },
    });
    const feeRateMap: Record<string, string> = {};
    for (const fr of feeRateRecords) {
      const key = `${fr.fundCode}:${fr.feeType}`;
      if (!(key in feeRateMap)) feeRateMap[key] = String(fr.rate);
    }

    // Confirm days
    const confirmDaysRecords = await prisma.fundConfirmDays.findMany({
      where: { accountId },
    });
    const confirmDaysMap: Record<string, number> = {};
    for (const cd of confirmDaysRecords) {
      confirmDaysMap[cd.fundCode] = cd.days ?? 0;
    }

    // Pending by code
    const pendingByCode: Record<string, number> = {};
    for (const p of positionDisplay.positions) {
      if (p.pendingCost > 0) {
        pendingByCode[p.fundCode] = p.pendingCost;
      }
    }

    // Sort positions
    const sortedPositions = [...positionDisplay.positions].sort((a, b) => b.marketValue - a.marketValue);
    const sortedCleared = [...positionDisplay.clearedPositions].sort((a, b) => b.clearedDate.localeCompare(a.clearedDate));
    const totalMarketValue = sortedPositions.reduce((sum, p) => sum + p.marketValue, 0);
    const totalCost = sortedPositions.reduce((sum, p) => sum + p.cost, 0);
    const totalHistoricalProfit = sortedPositions.reduce((sum, p) => sum + p.historicalProfit, 0)
      + sortedCleared.reduce((sum, p) => sum + p.historicalProfit, 0);

    return NextResponse.json({
      ok: true,
      positions: sortedPositions,
      clearedPositions: sortedCleared,
      allEntries: fundEntries,
      selectedFundCode,
      totalMarketValue,
      totalCost,
      totalHistoricalProfit,
      confirmDaysMap,
      feeRateMap,
      pendingByCode,
    });
  } catch (e) {
    console.error("[fund/shell-data]", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "获取数据失败" }, { status: 500 });
  }
}
