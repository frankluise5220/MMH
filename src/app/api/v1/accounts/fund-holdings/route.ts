import { NextRequest, NextResponse } from "next/server";
import { FundProductType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * 电子钱包关联货基时，「基金代码」下拉的数据源（2026-11-18）。
 * 只返回该货币基金账户名下的持仓，避免手输代码串到别的账户。
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const accountId = (req.nextUrl.searchParams.get("accountId") ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT", error: "缺少 accountId" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: "investment", investProductType: FundProductType.money },
      select: { id: true, institutionId: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "货币基金账户不存在" }, { status: 404 });
    }

    const holdings = await prisma.fundHolding.findMany({
      where: { accountId },
      select: { fundCode: true, fundName: true, units: true },
      orderBy: [{ units: "desc" }, { fundCode: "asc" }],
    });

    return NextResponse.json({
      ok: true,
      institutionId: account.institutionId,
      holdings: holdings.map((holding) => ({
        fundCode: holding.fundCode,
        fundName: holding.fundName ?? "",
        units: Number(holding.units ?? 0),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "QUERY_FAILED", error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 },
    );
  }
}
