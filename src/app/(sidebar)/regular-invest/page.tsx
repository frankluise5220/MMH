import { prisma } from "@/lib/db/prisma";
import { RegularInvestClient } from "./RegularInvestClient";

export default async function RegularInvestPage() {
  const [plans, accounts] = await Promise.all([
    prisma.regularInvestPlan.findMany({
      orderBy: { nextRunDate: "asc" },
    }),
    prisma.account.findMany({
      include: { Institution: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
  ]);

  // 查询每个定投计划的执行统计（从TxRecord汇总）
  const planStats = await Promise.all(
    plans.map(async (plan) => {
      if (!plan.id) return { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 };

      const entries = await prisma.txRecord.findMany({
        where: {
          regularInvestPlanId: plan.id,
          source: "regular_invest",
          deletedAt: null,
        },
        select: {
          amount: true,
          fundUnits: true,
        },
      });

      // 已执行：所有记录（无论是否确认）
      const executedCount = entries.length;
      const executedAmount = entries.reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0);

      // 已确认：有份额（fundUnits > 0）
      const confirmedEntries = entries.filter((e) => e.fundUnits != null && Number(e.fundUnits) > 0);
      const confirmedCount = confirmedEntries.length;
      const confirmedAmount = confirmedEntries.reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0);

      return { executedCount, executedAmount, confirmedCount, confirmedAmount };
    })
  );

  // 将 Decimal 类型转换为 Number，以便传递给客户端组件
  const plansData = plans.map((p, index) => ({
    ...p,
    amount: Number(p.amount),
    feeRate: p.feeRate ? Number(p.feeRate) : null,
    startDate: p.startDate && Number.isFinite(p.startDate.getTime()) ? p.startDate.toISOString() : null,
    endDate: p.endDate && Number.isFinite(p.endDate.getTime()) ? p.endDate.toISOString() : null,
    nextRunDate: p.nextRunDate && Number.isFinite(p.nextRunDate.getTime()) ? p.nextRunDate.toISOString() : null,
    lastRunDate: p.lastRunDate && Number.isFinite(p.lastRunDate.getTime()) ? p.lastRunDate.toISOString() : null,
    createdAt: p.createdAt && Number.isFinite(p.createdAt.getTime()) ? p.createdAt.toISOString() : null,
    updatedAt: p.updatedAt && Number.isFinite(p.updatedAt.getTime()) ? p.updatedAt.toISOString() : null,
    // 添加汇总统计
    executedCount: planStats[index].executedCount,
    executedAmount: planStats[index].executedAmount,
    confirmedCount: planStats[index].confirmedCount,
    confirmedAmount: planStats[index].confirmedAmount,
  }));

  const investmentAccounts = accounts
    .filter((a) => a.kind === "investment" && a.investProductType === "fund")
    .map((a) => ({
      id: a.id,
      name: a.name,
      label: a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name,
    }));

  const cashAccounts = accounts
    .filter((a) => ["bank_debit", "ewallet", "cash"].includes(a.kind))
    .map((a) => ({
      id: a.id,
      name: a.name,
      label: a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name,
    }));

  return (
    <RegularInvestClient
      initialPlans={plansData}
      investmentAccounts={investmentAccounts}
      cashAccounts={cashAccounts}
    />
  );
}