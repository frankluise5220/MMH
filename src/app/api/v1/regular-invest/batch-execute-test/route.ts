import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/**
 * 测试批量执行API的逻辑
 * GET /api/v1/regular-invest/batch-execute-test?planId=xxx
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const planId = searchParams.get("planId");

    if (!planId) {
      return NextResponse.json({ ok: false, error: "缺少 planId" });
    }

    const plan = await prisma.regularInvestPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      return NextResponse.json({ ok: false, error: "计划不存在" });
    }

    // 查询该定投计划关联的所有 TxRecord
    const existingEntries = await prisma.txRecord.findMany({
      where: {
        regularInvestPlanId: planId,
        deletedAt: null,
      },
      select: {
        id: true,
        fundCode: true,
        fundSubtype: true,
        amount: true,
        regularInvestPlanId: true,
      },
    });

    // 查询所有该基金代码的 TxRecord
    const allFundEntries = await prisma.txRecord.findMany({
      where: {
        OR: [{ toAccountId: plan.accountId }, { accountId: plan.accountId }],
        fundCode: plan.fundCode,
        source: "regular_invest",
        deletedAt: null,
      },
      select: {
        id: true,
        fundCode: true,
        amount: true,
        regularInvestPlanId: true,
      },
    });

    return NextResponse.json({
      ok: true,
      plan: {
        id: plan.id,
        fundCode: plan.fundCode,
        amount: Number(plan.amount),
        startDate: plan.startDate?.toISOString(),
        intervalUnit: plan.intervalUnit,
        intervalValue: plan.intervalValue,
        status: plan.status,
      },
      entriesWithPlanId: existingEntries.length,
      allEntriesForFund: allFundEntries.length,
      entriesWithPlanIdData: existingEntries,
      allEntriesForFundData: allFundEntries,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "查询失败",
    });
  }
}