import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

/**
 * POST /api/v1/cleanup/dividend-cash
 * 清理旧版现金红利重复记录：
 * 1. 删除 type=income 且 note 以"现金红利"开头的重复记录
 * 2. 修复 fundSubtype=dividend_cash 且 amount<0 的旧投资记录（改为新方向）
 */
export async function POST() {
  const results = { deletedIncome: 0, fixedInvestment: 0, errors: [] as string[] };

  try {
    // 1. 删除重复的 income 记录
    const incomeRecords = await prisma.txRecord.findMany({
      where: {
        type: "income",
        note: { startsWith: "现金红利" },
        deletedAt: null,
      },
      select: { id: true },
    });

    if (incomeRecords.length > 0) {
      await prisma.txRecord.deleteMany({
        where: { id: { in: incomeRecords.map(r => r.id) } },
      });
      results.deletedIncome = incomeRecords.length;
    }

    // 2. 修复旧版 dividend_cash investment 记录：amount<0 说明是旧方向(accountId=现金)
    const oldRecords = await prisma.txRecord.findMany({
      where: {
        fundSubtype: "dividend_cash",
        amount: { lt: 0 },
        deletedAt: null,
      },
      select: { id: true, accountId: true, toAccountId: true, amount: true },
    });

    for (const rec of oldRecords) {
      const oldAmount = toNumber(rec.amount);
      const newAmount = Math.abs(oldAmount);
      // 旧记录: accountId=现金账户, toAccountId=投资账户, amount负
      // 新记录: accountId=投资账户, toAccountId=现金账户, amount正
      await prisma.txRecord.update({
        where: { id: rec.id },
        data: {
          accountId: rec.toAccountId!,  // 交换: 投资账户变accountId
          toAccountId: rec.accountId,   // 现金账户变toAccountId
          amount: newAmount,
        },
      });
      results.fixedInvestment++;
    }

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "清理失败" }, { status: 500 });
  }
}
