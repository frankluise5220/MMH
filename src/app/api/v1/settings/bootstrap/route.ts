import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

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
 * 返回: { ok, accounts, groups, institutions, users, categories, tags }
 */
export async function GET() {
  try {
    const { hidFilter } = await getHouseholdScope();
    const [accounts, groups, institutions, users, categories, tags] = await Promise.all([
      prisma.account.findMany({
        where: { isPlaceholder: { not: true }, ...hidFilter },
        include: { Institution: true, AccountGroup: true, AccountAlias: true },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.accountGroup.findMany({
        where: hidFilter,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      prisma.institution.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
      prisma.user.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
      prisma.category.findMany({
        where: hidFilter,
        orderBy: [{ type: "asc" }, { name: "asc" }],
        select: { id: true, name: true, type: true, parentId: true, isSystem: true },
      }),
      prisma.tag.findMany({
        where: hidFilter,
        orderBy: { name: "asc" },
      }),
    ]);

    return NextResponse.json({
      ok: true,
      accounts: accounts.map(normalizeReturnedAccountKind),
      groups,
      institutions,
      users,
      categories,
      tags,
    });
  } catch (error) {
    console.error("GET /api/v1/settings/bootstrap error:", error);
    return NextResponse.json({ ok: false, error: "查询失败" }, { status: 500 });
  }
}
