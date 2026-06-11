import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { RegularInvestClient } from "./RegularInvestClient";

export default async function RegularInvestPage() {
  const { hidFilter } = await getHouseholdScope();

  const [plans, accounts] = await Promise.all([
    prisma.regularInvestPlan.findMany({
      where: hidFilter,
      orderBy: { nextRunDate: "asc" },
    }),
    prisma.account.findMany({
      where: hidFilter,
      include: { Institution: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
  ]);

  // 批量查询所有计划执行统计（一次查询，避免 N+1）
  const planIds = plans.map(p => p.id);
  const allEntries = planIds.length > 0 ? await prisma.txRecord.findMany({
    where: {
      regularInvestPlanId: { in: planIds },
      source: "regular_invest",
      deletedAt: null,
    },
    select: {
      regularInvestPlanId: true,
      amount: true,
      fundUnits: true,
    },
  }) : [];

  // 按 planId 聚合
  const statsByPlanId = new Map<string, { executedCount: number; executedAmount: number; confirmedCount: number; confirmedAmount: number }>();
  for (const e of allEntries) {
    const pid = e.regularInvestPlanId;
    if (!pid) continue;
    if (!statsByPlanId.has(pid)) statsByPlanId.set(pid, { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 });
    const s = statsByPlanId.get(pid)!;
    s.executedCount++;
    s.executedAmount += Math.abs(Number(e.amount));
    if (e.fundUnits != null && Number(e.fundUnits) > 0) {
      s.confirmedCount++;
      s.confirmedAmount += Math.abs(Number(e.amount));
    }
  }

  // 将 Decimal 类型转换为 Number，以便传递给客户端组件
  const plansData = plans.map((p) => {
    const stats = statsByPlanId.get(p.id) || { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 };
    return {
      ...p,
      amount: Number(p.amount),
      feeRate: p.feeRate ? Number(p.feeRate) : null,
      startDate: p.startDate && Number.isFinite(p.startDate.getTime()) ? p.startDate.toISOString() : null,
      endDate: p.endDate && Number.isFinite(p.endDate.getTime()) ? p.endDate.toISOString() : null,
      nextRunDate: p.nextRunDate && Number.isFinite(p.nextRunDate.getTime()) ? p.nextRunDate.toISOString() : null,
      lastRunDate: p.lastRunDate && Number.isFinite(p.lastRunDate.getTime()) ? p.lastRunDate.toISOString() : null,
      createdAt: p.createdAt && Number.isFinite(p.createdAt.getTime()) ? p.createdAt.toISOString() : null,
      updatedAt: p.updatedAt && Number.isFinite(p.updatedAt.getTime()) ? p.updatedAt.toISOString() : null,
      executedCount: stats.executedCount,
      executedAmount: stats.executedAmount,
      confirmedCount: stats.confirmedCount,
      confirmedAmount: stats.confirmedAmount,
    };
  });

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