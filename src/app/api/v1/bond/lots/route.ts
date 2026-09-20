import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { loadBondLotOptions } from "@/lib/server/bond-shell-data";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * 债券存单下拉数据源。
 *
 * 债券是存单粒度（一笔买入 = 一张存单 = 一个持仓），付息/赎回/核销必须指明所属
 * 存单。债券视图所在页面直接走服务端装载；全局记账入口（BondEntryHost）没有页面
 * 数据，按需从这里取。
 */
export async function GET(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    const url = new URL(req.url);
    const accountIdsParam = url.searchParams.get("accountIds");
    const accountIds = accountIdsParam
      ? accountIdsParam.split(",").map((id) => id.trim()).filter(Boolean)
      : (await prisma.account.findMany({
          where: { ...ctx.hidFilter, isPlaceholder: { not: true }, investProductType: "bond" },
          select: { id: true },
        })).map((account) => account.id);

    const lots = await loadBondLotOptions({ householdId: ctx.householdId, accountIds });
    return NextResponse.json({ ok: true, lots });
  } catch (e) {
    console.error("[bond/lots]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "获取存单失败" },
      { status: 500 },
    );
  }
}
