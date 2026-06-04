import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/**
 * 获取账户设置页面所需全部数据
 * GET /api/v1/accounts/internal
 */
export async function GET() {
  try {
    const [accounts, groups, institutions] = await Promise.all([
      prisma.account.findMany({
        include: { Institution: true, AccountGroup: true },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.accountGroup.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
      prisma.institution.findMany({ orderBy: { name: "asc" } }),
    ]);

    return NextResponse.json({ ok: true, accounts, groups, institutions });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}