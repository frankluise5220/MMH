import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";

/**
 * 获取账户设置页面所需全部数据（按当前账簿筛选）
 * GET /api/v1/accounts/internal
 *
 * Query:
 * - balances=false 时只返回账户/所有人/机构基础资料，不计算显示余额。
 */
export async function GET(request: Request) {
  try {
    const includeBalances = request.url ? new URL(request.url).searchParams.get("balances") !== "false" : true;
    const { hidFilter } = await getHouseholdScope();

    const [accounts, groups, institutions] = await Promise.all([
      prisma.account.findMany({
        where: { isPlaceholder: { not: true }, ...hidFilter },
        include: { Institution: true, AccountGroup: true },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.accountGroup.findMany({
        where: hidFilter,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      prisma.institution.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
    ]);

    if (!includeBalances) {
      return NextResponse.json({ ok: true, accounts, groups, institutions });
    }

    // For investment accounts, use market value instead of raw balance
    const investBalByAccountId = await computeInvestBalances({ hidFilter, householdId: hidFilter.householdId ?? "", user: null });
    const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
      accounts
        .filter((account) => account.kind !== AccountKind.investment)
        .map((account) => ({ id: account.id, kind: account.kind, billingDay: account.billingDay })),
      hidFilter,
    );
    const enrichedAccounts = accounts.map((a) => {
      if (a.kind === AccountKind.investment) {
        const detail = investBalByAccountId.get(a.id);
        if (detail) return { ...a, balance: detail.marketValue };
      }
      const displayBalance = cashDisplayBalanceByAccountId.get(a.id);
      return displayBalance == null ? a : { ...a, balance: displayBalance };
    });

    return NextResponse.json({ ok: true, accounts: enrichedAccounts, groups, institutions });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}
