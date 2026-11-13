import { NextResponse } from "next/server";

import { formatDateUtc } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * 贵金属「可卖持仓」数据源。
 *
 * 赎回页签需要知道某个贵金属账户里某品种/单位还剩多少克，才能回填可用量并挡住超卖。
 * 页面首次渲染由 RSC 把持仓交给壳层，但保存后当前路由不重渲染（见
 * `revalidateAfterFundShellChange`），所以弹窗自己取一次，口径与
 * `PreciousMetalHolding`（recalc 写入的账面持仓）完全一致，不在这里另算。
 */
export async function GET(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const accountId = new URL(req.url).searchParams.get("accountId")?.trim() || null;

    const rows = await prisma.preciousMetalHolding.findMany({
      where: {
        ...ctx.hidFilter,
        ...(accountId ? { accountId } : {}),
        quantity: { gt: 0 },
      },
      select: {
        accountId: true,
        metalTypeId: true,
        metalTypeName: true,
        metalUnitId: true,
        metalUnitName: true,
        quantity: true,
        avgCost: true,
        latestPrice: true,
        latestPriceDate: true,
      },
      orderBy: [{ metalTypeId: "asc" }, { metalUnitId: "asc" }],
    });

    return NextResponse.json({
      ok: true,
      holdings: rows.map((row) => ({
        accountId: row.accountId,
        metalTypeId: row.metalTypeId,
        metalTypeName: row.metalTypeName,
        metalUnitId: row.metalUnitId,
        metalUnitName: row.metalUnitName,
        quantity: Number(row.quantity),
        avgCost: Number(row.avgCost),
        latestPrice: row.latestPrice == null ? null : Number(row.latestPrice),
        latestPriceDate: row.latestPriceDate ? formatDateUtc(row.latestPriceDate) : null,
      })),
    });
  } catch (e) {
    console.error("[precious-metals/holdings]", e);
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "获取贵金属持仓失败" },
      { status: 500 },
    );
  }
}
