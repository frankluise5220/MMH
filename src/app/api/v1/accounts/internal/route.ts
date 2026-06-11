import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * 获取账户设置页面所需全部数据（按当前账簿筛选）
 * GET /api/v1/accounts/internal
 */
export async function GET() {
  try {
    const { hidFilter } = await getHouseholdScope();

    const [accounts, groups, institutions] = await Promise.all([
      prisma.account.findMany({
        where: hidFilter,
        include: { Institution: true, AccountGroup: true },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.accountGroup.findMany({
        where: hidFilter,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      prisma.institution.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
    ]);

    return NextResponse.json({ ok: true, accounts, groups, institutions });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}