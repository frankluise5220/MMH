import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadRepoShellData } from "@/lib/server/repo-shell-data";

export const runtime = "nodejs";

/**
 * GET /api/v1/repo/overview?accountId=… —— 股票视图「逆回购」页签的数据源。
 *
 * 返回某个证券账户下的逆回购存单（持有中 + 已回款）、未回款本金、预计利息与
 * 已实现收益。与页面首屏共用 `loadRepoShellData` 口径，避免两处算法分叉。
 */
export async function GET(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const url = new URL(req.url);
    const accountId = url.searchParams.get("accountId")?.trim() ?? "";
    if (!accountId) {
      return NextResponse.json({ ok: false, error: "缺少账户" }, { status: 400 });
    }

    const data = await loadRepoShellData({ householdId, accountId });
    if (!data) {
      return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      data: {
        lots: data.lots,
        totalPrincipal: data.totalPrincipal,
        totalExpectedInterest: data.totalExpectedInterest,
        totalRealizedProfit: data.totalRealizedProfit,
        openCount: data.openCount,
        defaultCashAccountId: data.defaultCashAccountId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取逆回购数据失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
