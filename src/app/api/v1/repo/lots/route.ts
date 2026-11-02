import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { loadRepoShellData } from "@/lib/server/repo-shell-data";

/**
 * 逆回购未回款存单下拉数据源。
 *
 * 逆回购录入现在挂在「新增债券记录」窗口的逆回购页签里，该窗口可能从页面直接打开
 * （服务端已有数据），也可能从全局记账入口打开（没有页面数据），所以存单按需取。
 */
export async function GET(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const url = new URL(req.url);
    const requestedAccountId = url.searchParams.get("accountId")?.trim() ?? "";
    const accountIds = requestedAccountId
      ? [requestedAccountId]
      : (await prisma.account.findMany({
          where: { ...ctx.hidFilter, isPlaceholder: { not: true }, investProductType: "bond" },
          select: { id: true },
        })).map((account) => account.id);

    const lots: Array<{
      id: string;
      accountId: string;
      name: string;
      startDate: string | null;
      maturityDate: string | null;
      principal: number;
      annualRate: number | null;
      termDays: number | null;
      expectedInterest: number | null;
      remainingDays: number | null;
    }> = [];
    let defaultCashAccountId: string | null = null;

    for (const accountId of accountIds) {
      const data = await loadRepoShellData({ householdId: ctx.householdId, accountId });
      if (!data) continue;
      defaultCashAccountId ??= data.defaultCashAccountId;
      for (const lot of data.lots) {
        if (lot.status !== "open") continue;
        lots.push({
          id: lot.id,
          accountId,
          name: lot.name,
          startDate: lot.startDate,
          maturityDate: lot.maturityDate,
          principal: lot.principal,
          annualRate: lot.annualRate,
          termDays: lot.termDays,
          expectedInterest: lot.expectedInterest,
          remainingDays: lot.remainingDays,
        });
      }
    }

    lots.sort((a, b) => (a.startDate ?? "").localeCompare(b.startDate ?? ""));
    return NextResponse.json({ ok: true, lots, defaultCashAccountId });
  } catch (e) {
    console.error("[repo/lots]", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "获取逆回购存单失败" },
      { status: 500 },
    );
  }
}
