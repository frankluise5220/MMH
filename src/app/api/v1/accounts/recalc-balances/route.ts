import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * 重算当前账簿下所有活跃账户的余额并写回数据库。
 * POST /api/v1/accounts/recalc-balances
 */
export async function POST() {
  try {
    const { hidFilter } = await getHouseholdScope();
    const accounts = await prisma.account.findMany({
      where: { ...hidFilter, isActive: true },
      select: { id: true, name: true, kind: true, balance: true },
    });

    for (const a of accounts) {
      await recalcAndSaveAccountBalance(a.id);
    }

    // 返回更新后的余额用于验证
    const updated = await prisma.account.findMany({
      where: { ...hidFilter, isActive: true },
      select: { id: true, name: true, kind: true, balance: true },
    });

    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "重算失败" },
      { status: 500 },
    );
  }
}