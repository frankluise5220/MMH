import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { buildAccountDisplayOption, buildFlatAccountOptions, buildGroupedAccountOptions } from "@/lib/account-display";
import { decodeScheduledTaskMemo, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { AccountKind, TransactionType } from "@prisma/client";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { toStatementMonth } from "@/lib/date-utils";
import { allocateBuyFailedRefunds, getConfirmedBuyAmount } from "@/lib/fund/refund-link";
import { RegularInvestClient } from "./RegularInvestClient";

async function unavailableCreateTransaction(_formData: FormData) {
  "use server";
  void _formData;
  return { ok: false as const, error: "计划任务页只支持编辑已生成记录" };
}

async function updateScheduledTransferRecord(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();

  const entryId = String(formData.get("entryId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = Number(String(formData.get("amount") ?? "").trim());
  const fromAccountId = String(formData.get("fromAccountId") ?? "").trim();
  const toAccountId = String(formData.get("toAccountId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();

  if (!entryId) return { ok: false as const, error: "缺少记录ID" };
  if (!dateStr || Number.isNaN(new Date(dateStr).getTime())) return { ok: false as const, error: "日期不正确" };
  const amountAbs = Number.isFinite(amountRaw) ? Math.abs(amountRaw) : 0;
  if (amountAbs <= 0) return { ok: false as const, error: "金额不正确" };
  if (!fromAccountId || !toAccountId) return { ok: false as const, error: "转账需要选择转出/转入账户" };
  if (fromAccountId === toAccountId) return { ok: false as const, error: "转出/转入账户不能相同" };

  try {
    const date = new Date(dateStr);
    const updated = await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({ where: { id: entryId } });
      if (!entry) throw new Error("记录不存在");
      if (entry.householdId && entry.householdId !== householdId) throw new Error("记录不属于当前账簿");
      if (!entry.regularInvestPlanId || entry.source !== "scheduled_task") throw new Error("这不是计划任务生成的转账记录");

      const [fromAcc, toAcc] = await Promise.all([
        tx.account.findUnique({ where: { id: fromAccountId } }),
        tx.account.findUnique({ where: { id: toAccountId } }),
      ]);
      if (!fromAcc || !toAcc) throw new Error("账户不存在");
      if (fromAcc.householdId !== householdId || toAcc.householdId !== householdId) throw new Error("账户不属于当前账簿");

      const statementMonth =
        (toAcc.kind === AccountKind.bank_credit || toAcc.kind === AccountKind.loan) && toAcc.billingDay
          ? toStatementMonth(date, toAcc.billingDay)
          : null;

      const updated = await tx.txRecord.update({
        where: { id: entryId },
        data: {
          type: TransactionType.transfer,
          date,
          amount: -amountAbs,
          accountId: fromAcc.id,
          accountName: fromAcc.name,
          toAccountId: toAcc.id,
          toAccountName: toAcc.name,
          categoryId: null,
          categoryName: null,
          statementMonth,
          note: note || null,
          toNote: (toNote || note) || null,
        },
        select: {
          accountId: true,
          toAccountId: true,
        },
      });
      return {
        oldAccountId: entry.accountId,
        oldToAccountId: entry.toAccountId,
        accountId: updated.accountId,
        toAccountId: updated.toAccountId,
      };
    });

    const accountsToRecalc = new Set([updated.oldAccountId, updated.oldToAccountId, updated.accountId, updated.toAccountId].filter(Boolean));
    await Promise.all([...accountsToRecalc].map((accountId) => recalcAndSaveAccountBalance(accountId!).catch(() => {})));
    revalidateAfterTxChange();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "保存失败" };
  }
}

function recordMatchesTask(taskType: string, entry: { source: string | null }) {
  if (taskType === "fund_regular_invest") return entry.source === "regular_invest";
  if (taskType === "insurance_premium") return entry.source === "insurance";
  return entry.source === "scheduled_task";
}

export default async function RegularInvestPage() {
  const { hidFilter } = await getHouseholdScope();

  const [plans, accounts, groups, institutions, insuranceProducts] = await Promise.all([
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
    prisma.insuranceProduct.findMany({
      where: hidFilter,
      include: {
        Account: true,
        Institution: true,
        OwnerGroup: true,
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
  ]);

  const scheduledTaskByPlanId = new Map(plans.map((plan) => [plan.id, decodeScheduledTaskMemo(plan.memo)]));
  const planIds = plans.map((plan) => plan.id);
  const allEntries = planIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          regularInvestPlanId: { in: planIds },
          deletedAt: null,
        },
        select: {
          id: true,
          date: true,
          createdAt: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          accountId: true,
          toAccountId: true,
          fundCode: true,
          fundSubtype: true,
          fundSourceEntryId: true,
          regularInvestPlanId: true,
          source: true,
          amount: true,
          fundUnits: true,
        },
      })
    : [];

  const { refundAmountByBuyId } = allocateBuyFailedRefunds(allEntries.map((entry) => ({
    id: entry.id,
    date: entry.date,
    createdAt: entry.createdAt,
    fundConfirmDate: entry.fundConfirmDate,
    fundArrivalDate: entry.fundArrivalDate,
    accountId: entry.accountId,
    toAccountId: entry.toAccountId,
    fundCode: entry.fundCode,
    fundSubtype: entry.fundSubtype,
    source: entry.source,
    amount: Number(entry.amount),
    fundSourceEntryId: entry.fundSourceEntryId,
  })));

  const statsByPlanId = new Map<string, { executedCount: number; executedAmount: number; confirmedCount: number; confirmedAmount: number }>();
  for (const entry of allEntries) {
    const planId = entry.regularInvestPlanId;
    if (!planId) continue;
    const task = scheduledTaskByPlanId.get(planId);
    if (!recordMatchesTask(task?.type ?? "fund_regular_invest", entry)) continue;
    if (!statsByPlanId.has(planId)) {
      statsByPlanId.set(planId, { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 });
    }
    const stats = statsByPlanId.get(planId)!;
    stats.executedCount++;
    stats.executedAmount += Math.abs(Number(entry.amount));
    if (entry.fundUnits != null && Number(entry.fundUnits) > 0) {
      stats.confirmedCount++;
      stats.confirmedAmount += getConfirmedBuyAmount(
        Number(entry.amount),
        refundAmountByBuyId.get(entry.id) ?? 0,
      );
    }
  }

  const accountOptions = accounts.map((account) => buildAccountDisplayOption(account));
  const accountById = new Map(accountOptions.map((account) => [account.id, account]));

  const plansData = plans.map((plan) => {
    const stats = statsByPlanId.get(plan.id) ?? { executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 };
    const fundAccount = accountById.get(plan.accountId);
    const cashAccount = plan.cashAccountId ? accountById.get(plan.cashAccountId) : null;
    const scheduledTask = scheduledTaskByPlanId.get(plan.id) ?? decodeScheduledTaskMemo(plan.memo);
    const taskType = normalizeScheduledTaskType(plan.taskType ?? scheduledTask.type);

    return {
      ...plan,
      taskType,
      taskTypeLabel: scheduledTaskTypeLabel(taskType),
      taskTitle: plan.targetName ?? scheduledTask.title ?? null,
      targetName: plan.targetName ?? null,
      insuranceProductName: plan.insuranceProductName ?? null,
      taskFromAccountId: scheduledTask.fromAccountId ?? null,
      taskToAccountId: scheduledTask.toAccountId ?? null,
      taskInsuranceProductId: scheduledTask.insuranceProductId ?? null,
      taskAnnualRate: scheduledTask.annualRate ?? null,
      taskRepaymentMethod: scheduledTask.repaymentMethod ?? null,
      taskRepaymentIntervalMonths: scheduledTask.repaymentIntervalMonths ?? null,
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
  const loanAccounts = accountOptions.filter((account) => account.kind === "loan");
  const transferTargetAccounts = accountOptions.filter((account) => !account.id || !["insurance"].includes(account.kind));
  const insuranceProductOptions = insuranceProducts.map((product) => ({
    id: product.id,
    label: product.name,
    accountId: product.accountId,
    accountLabel: accountById.get(product.accountId)?.label ?? product.Account?.name ?? "",
    ownerGroupId: product.ownerGroupId ?? null,
    ownerGroupName: product.OwnerGroup?.name ?? null,
    premiumAmount: product.premiumAmount == null ? null : Number(product.premiumAmount),
    subLabel: [
      product.Institution?.shortName || product.Institution?.name,
      product.OwnerGroup?.name,
    ].filter(Boolean).join(" · "),
  }));

  return (
    <RegularInvestClient
      initialPlans={plansData}
      investmentAccounts={investmentAccounts}
      cashAccounts={cashAccounts}
      loanAccounts={loanAccounts}
      transferTargetAccounts={transferTargetAccounts}
      insuranceProductOptions={insuranceProductOptions}
      investmentAccountSSOptions={buildFlatAccountOptions(investmentAccounts)}
      cashAccountSSOptions={buildGroupedAccountOptions(cashAccounts)}
      transferTargetAccountSSOptions={buildGroupedAccountOptions(transferTargetAccounts)}
      allAccountSSOptions={buildGroupedAccountOptions(accountOptions)}
      nestedFieldData={{
        groupId: groups.map((group) => ({ id: group.id, name: group.name })),
        institutionId: institutions.map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? undefined })),
      }}
      transactionCreateAction={unavailableCreateTransaction}
      transactionEditAction={updateScheduledTransferRecord}
    />
  );
}
