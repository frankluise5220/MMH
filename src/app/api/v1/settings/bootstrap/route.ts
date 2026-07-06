import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadCommonData } from "@/lib/server/cached-data";

export const runtime = "nodejs";

function normalizeReturnedAccountKind<T extends { kind: AccountKind; investProductType?: string | null }>(account: T): T {
  if (account.kind === AccountKind.investment && account.investProductType === "deposit") {
    return { ...account, kind: AccountKind.deposit };
  }
  return account;
}

/**
 * GET /api/v1/settings/bootstrap
 * 读取设置区常用基础资料，供系统设置页共享缓存使用。
 *
 * 返回: { ok, accounts, groups, institutions, counterparties, users, categories, tags }
 */
export async function GET() {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);
    const [{ accounts, groups, institutions, counterparties, categories, tags }, users] = await Promise.all([
      loadCommonData(hidFilter),
      prisma.user.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
    ]);

    return NextResponse.json({
      ok: true,
      accounts: accounts.map(normalizeReturnedAccountKind),
      groups,
      institutions,
      counterparties,
      users,
      categories,
      tags,
    });
  } catch (error) {
    console.error("GET /api/v1/settings/bootstrap error:", error);
    return NextResponse.json({ ok: false, error: "查询失败" }, { status: 500 });
  }
}
