import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { buildAccountDisplayOption, buildFlatAccountOptions, buildGroupedAccountOptions } from "@/lib/account-display";
import { RegularInvestClient } from "./RegularInvestClient";

export default async function RegularInvestPage() {
  const { hidFilter } = await getHouseholdScope();

  const [plans, accounts, groups, institutions] = await Promise.all([
    prisma.regularInvestPlan.findMany({
      where: hidFilter,
      orderBy: { nextRunDate: "asc" },
    }),
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, ...hidFilter },
      include: { Institution: true, AccountGroup: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    prisma.accountGroup.findMany({
      where: hidFilter,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: hidFilter,
      orderBy: { name: "asc" },
    }),
  ]);

  const planIds = plans.map((plan) => plan.id);
  const allEntries = planIds.length > 0
    ? await prisma.txRecord.findMany({
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
      })
    : [];

  const statsByPlanId = new Map<string, { executedCount: number; executedAmount: number; confirmedCount: number; confirmedAmount: number }>();
  for (const entry of allEntries) {
    const planId = entry.regularInvestPlanId;
    if (!planId) continue;
    if (!statsByPlanId.has(planId)) {
      statsByPlanId.set(planId, { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 });
    }
    const stats = statsByPlanId.get(planId)!;
    stats.executedCount++;
    stats.executedAmount += Math.abs(Number(entry.amount));
    if (entry.fundUnits != null && Number(entry.fundUnits) > 0) {
      stats.confirmedCount++;
      stats.confirmedAmount += Math.abs(Number(entry.amount));
    }
  }

  const accountOptions = accounts.map((account) => buildAccountDisplayOption(account));
  const accountById = new Map(accountOptions.map((account) => [account.id, account]));

  const plansData = plans.map((plan) => {
    const stats = statsByPlanId.get(plan.id) ?? { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 };
    const fundAccount = accountById.get(plan.accountId);
    const cashAccount = plan.cashAccountId ? accountById.get(plan.cashAccountId) : null;

    return {
      ...plan,
      amount: Number(plan.amount),
      feeRate: plan.feeRate ? Number(plan.feeRate) : null,
      startDate: plan.startDate && Number.isFinite(plan.startDate.getTime()) ? plan.startDate.toISOString() : null,
      endDate: plan.endDate && Number.isFinite(plan.endDate.getTime()) ? plan.endDate.toISOString() : null,
      nextRunDate: plan.nextRunDate && Number.isFinite(plan.nextRunDate.getTime()) ? plan.nextRunDate.toISOString() : null,
      lastRunDate: plan.lastRunDate && Number.isFinite(plan.lastRunDate.getTime()) ? plan.lastRunDate.toISOString() : null,
      createdAt: plan.createdAt && Number.isFinite(plan.createdAt.getTime()) ? plan.createdAt.toISOString() : null,
      updatedAt: plan.updatedAt && Number.isFinite(plan.updatedAt.getTime()) ? plan.updatedAt.toISOString() : null,
      executedCount: stats.executedCount,
      executedAmount: stats.executedAmount,
      confirmedCount: stats.confirmedCount,
      confirmedAmount: stats.confirmedAmount,
      accountLabel: fundAccount?.label ?? plan.accountName,
      accountFullLabel: fundAccount?.fullLabel ?? plan.accountName,
      accountGroupName: fundAccount?.groupName ?? "",
      cashAccountLabel: cashAccount?.label ?? plan.cashAccountName,
      cashAccountFullLabel: cashAccount?.fullLabel ?? plan.cashAccountName,
      cashAccountGroupName: cashAccount?.groupName ?? "",
    };
  });

  const investmentAccounts = accountOptions.filter((account) => account.kind === "investment" && account.investProductType === "fund");
  const cashAccounts = accountOptions.filter((account) => ["bank_debit", "ewallet", "cash"].includes(account.kind));

  return (
    <RegularInvestClient
      initialPlans={plansData}
      investmentAccounts={investmentAccounts}
      cashAccounts={cashAccounts}
      investmentAccountSSOptions={buildFlatAccountOptions(investmentAccounts)}
      cashAccountSSOptions={buildGroupedAccountOptions(cashAccounts)}
      nestedFieldData={{
        groupId: groups.map((group) => ({ id: group.id, name: group.name })),
        institutionId: institutions.map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? undefined })),
      }}
    />
  );
}
