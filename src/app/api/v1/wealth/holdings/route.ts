import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { loadWealthTransactionEntryLike } from "@/lib/server/business-transaction-entries";
import { getServerT } from "@/lib/server/i18n";
import { buildWealthHoldingOptions } from "@/lib/wealth-holdings";

export const runtime = "nodejs";

/**
 * 理财「可赎回持仓」下拉数据源。
 *
 * 页面首次渲染由 RSC 直接把持仓传给 `WealthFormModal`；但理财保存只做 tag 失效、
 * 不重渲染当前路由（见 `revalidateAfterFundShellChange`），所以弹窗保存后必须自己
 * 重新取一次，否则新增的买入在赎回页签里看不到可赎回份额，只能手动刷新浏览器。
 *
 * 聚合口径与页面共用 `buildWealthHoldingOptions`，不在这里另算一套。
 */
export async function GET(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const accounts = await prisma.account.findMany({
      where: {
        ...ctx.hidFilter,
        isPlaceholder: { not: true },
        isAggregate: { not: true },
        investProductType: "wealth",
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });

    const entries = accounts.length > 0
      ? await loadWealthTransactionEntryLike({
          householdId: ctx.householdId,
          accountIds: accounts.map((account) => account.id),
        })
      : [];
    const t = await getServerT();

    return NextResponse.json({
      ok: true,
      holdings: buildWealthHoldingOptions({
        entries,
        accounts,
        unnamedFallback: t("sidebar.wealthHolding.unnamed"),
      }),
    });
  } catch (e) {
    console.error("[wealth/holdings]", e);
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "获取可赎回持仓失败" },
      { status: 500 },
    );
  }
}
