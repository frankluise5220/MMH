import { FundSubtype, RegularInvestStatus, TransactionType, type RegularInvestPlan } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { businessDayStartUtc, formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { applyEntryChangesToAccountBalances } from "@/lib/server/account-balance";
import { ENTRY_ORIGIN_SCHEDULED_TASK } from "@/lib/transaction-semantics";
import { METAL_QUANTITY_DECIMALS, roundFundUnits } from "@/lib/fund/unit-precision-core";
import type { ScheduledTaskPayload } from "@/lib/scheduled-task";
import { logger } from "@/lib/logger";

/** 贵金属积存计划：按金额每期买入，克数由执行日最新报价折算。 */
export function isMetalPlanTask(type?: string | null): boolean {
  return type === "metal_regular_invest";
}

const METAL_PLAN_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
};

export type MetalPlanExecutionResult = {
  ok: true;
  taskType: "metal_regular_invest";
  generatedCount: number;
  skipped: boolean;
  message: string;
  date: string | null;
  executedRuns: number;
  completed: boolean;
  stats: {
    executedCount: number;
    executedAmount: number;
    confirmedCount: number;
    confirmedAmount: number;
    plan: {
      executedRuns: number;
      lastRunDate: string | null;
      nextRunDate: string | null;
      status: RegularInvestStatus;
    };
  };
};

/** 执行日的折算单价：账户该品种的最新持仓价优先，其次最近一笔成交价。 */
async function resolveMetalUnitPrice(params: {
  householdId: string;
  accountId: string;
  metalTypeId: string;
  metalUnitId: string;
}) {
  const holding = await prisma.preciousMetalHolding.findFirst({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      metalTypeId: params.metalTypeId,
      metalUnitId: params.metalUnitId,
    },
    select: { latestPrice: true },
  });
  const holdingPrice = holding?.latestPrice == null ? null : toNumber(holding.latestPrice);
  if (holdingPrice && holdingPrice > 0) return holdingPrice;

  const lastTrade = await prisma.preciousMetalTransaction.findFirst({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      metalTypeId: params.metalTypeId,
      unitPrice: { gt: 0 },
    },
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
    select: { unitPrice: true },
  });
  const tradePrice = lastTrade?.unitPrice == null ? null : toNumber(lastTrade.unitPrice);
  return tradePrice && tradePrice > 0 ? tradePrice : null;
}

export async function executeMetalScheduledTaskPlan(params: {
  householdId: string;
  plan: RegularInvestPlan;
  task: ScheduledTaskPayload;
  overrideDate?: Date | null;
  overrideAmount?: number | null;
  now?: Date;
}): Promise<MetalPlanExecutionResult> {
  const { householdId, plan, task } = params;
  const now = params.now ?? new Date();

  const metalTypeId = task.metalTypeId ?? null;
  const metalUnitId = task.metalUnitId ?? null;
  if (!metalTypeId || !metalUnitId) throw new Error("贵金属积存计划缺少品种或单位");
  if (!plan.cashAccountId) throw new Error("贵金属积存计划缺少资金账户");

  const amount = params.overrideAmount && params.overrideAmount > 0 ? params.overrideAmount : toNumber(plan.amount);
  if (!(amount > 0)) throw new Error("计划金额不正确");

  const unitPrice = await resolveMetalUnitPrice({
    householdId,
    accountId: plan.accountId,
    metalTypeId,
    metalUnitId,
  });
  if (!unitPrice) throw new Error("缺少贵金属报价，无法折算克数（请先在贵金属账户补一笔成交或刷新行情）");

  const [metalAccount, cashAccount] = await Promise.all([
    prisma.account.findFirst({ where: { id: plan.accountId, householdId }, select: { id: true, name: true, currency: true } }),
    prisma.account.findFirst({ where: { id: plan.cashAccountId, householdId }, select: { id: true, name: true, currency: true } }),
  ]);
  if (!metalAccount) throw new Error("贵金属账户不存在");
  if (!cashAccount) throw new Error("资金账户不存在");

  // 幂等：以「计划 id + 生效日」判重，与基金定投的 regularInvestPlanId 口径一致。
  const existingEntries = await prisma.txRecord.findMany({
    where: { householdId, regularInvestPlanId: plan.id, deletedAt: null },
    select: { date: true },
  });
  const existingDates = new Set(existingEntries.map((entry) => formatDateUtc(entry.date)));
  const remainingRuns = plan.totalRuns ? Math.max(0, plan.totalRuns - plan.executedRuns) : Number.POSITIVE_INFINITY;

  const nextRunDateFrom = (from: Date) =>
    calcNextScheduledRunDate(from, plan.intervalUnit, plan.intervalValue, plan.executionDay, true, null);

  const datesToProcess: Date[] = [];
  if (params.overrideDate) {
    const overrideRunDate = startOfDayUtc(params.overrideDate);
    if (!existingDates.has(formatDateUtc(overrideRunDate)) && remainingRuns > 0) datesToProcess.push(overrideRunDate);
  } else {
    const today = businessDayStartUtc(now, await getHouseholdTimeZone(householdId));
    const effectiveEndDate = plan.endDate && startOfDayUtc(plan.endDate) < today ? startOfDayUtc(plan.endDate) : today;
    let currentDate = startOfDayUtc(plan.nextRunDate);
    let guard = 0;
    while (currentDate <= effectiveEndDate && datesToProcess.length < remainingRuns) {
      if (!existingDates.has(formatDateUtc(currentDate))) datesToProcess.push(currentDate);
      currentDate = nextRunDateFrom(currentDate);
      guard += 1;
      if (guard > 1200) throw new Error("计划周期异常，已停止生成以避免无限循环");
    }
  }

  const lastRunDate = plan.lastRunDate ?? null;
  if (datesToProcess.length === 0) {
    return {
      ok: true,
      taskType: "metal_regular_invest",
      generatedCount: 0,
      skipped: true,
      message: "所有到期的计划记录已存在，无需重复生成",
      date: null,
      executedRuns: plan.executedRuns,
      completed: false,
      stats: {
        executedCount: existingEntries.length,
        executedAmount: existingEntries.length * amount,
        confirmedCount: 0,
        confirmedAmount: 0,
        plan: {
          executedRuns: plan.executedRuns,
          lastRunDate: lastRunDate ? lastRunDate.toISOString() : null,
          nextRunDate: plan.nextRunDate ? plan.nextRunDate.toISOString() : null,
          status: plan.status,
        },
      },
    };
  }

  const finalLastRunDate = datesToProcess[datesToProcess.length - 1]!;
  const finalExecutedRuns = plan.executedRuns + datesToProcess.length;
  const nextRunDate = nextRunDateFrom(finalLastRunDate);
  const willComplete = !!(
    (plan.totalRuns && finalExecutedRuns >= plan.totalRuns) ||
    (plan.endDate && startOfDayUtc(plan.endDate) < nextRunDate)
  );
  const nextStatus = willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active;

  const metalTypeName = task.metalTypeName ?? null;
  const metalUnitName = task.metalUnitName ?? null;
  const quantity = roundFundUnits(amount / unitPrice, METAL_QUANTITY_DECIMALS);
  const displayName = metalTypeName ? `贵金属积存 ${metalTypeName}` : "贵金属积存";
  const categoryName = getInvestmentCategoryName({
    fundProductType: "metal",
    fundSubtype: FundSubtype.buy,
    source: "scheduled_task",
  });

  const createdEntryIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const category = categoryName
      ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: TransactionType.investment })
      : null;

    for (const runDate of datesToProcess) {
      const entry = await tx.txRecord.create({
        data: {
          householdId,
          date: runDate,
          type: TransactionType.investment,
          // 投资买入与手工记账同构：资金账户(出) → 贵金属账户(入)，金额记负数。
          accountId: cashAccount.id,
          accountName: cashAccount.name,
          toAccountId: metalAccount.id,
          toAccountName: metalAccount.name,
          amount: -amount,
          currency: cashAccount.currency ?? metalAccount.currency ?? "CNY",
          fundName: metalTypeName,
          metalTypeId,
          metalTypeName,
          metalUnitId,
          metalUnitName,
          metalQuantity: quantity,
          metalUnitPrice: unitPrice,
          fundProductType: "metal",
          fundSubtype: FundSubtype.buy,
          source: "scheduled_task",
          entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
          regularInvestPlanId: plan.id,
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? categoryName ?? null,
          note: `计划任务：${displayName}`,
        },
        select: { id: true },
      });
      createdEntryIds.push(entry.id);
    }
  }, METAL_PLAN_TRANSACTION_OPTIONS);

  for (const entryId of createdEntryIds) {
    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: entryId }).catch((error) => {
      logger.error(`metal plan sync business transaction failed entry=${entryId}: ${String(error)}`);
    });
  }
  await recalcPreciousMetalPositions(metalAccount.id).catch((error) => {
    logger.error(`metal plan recalc position failed account=${metalAccount.id}: ${String(error)}`);
  });
  await applyEntryChangesToAccountBalances(createdEntryIds.map((entryId) => ({ entryId }))).catch((error) => {
    logger.error(`metal plan apply balances failed cash=${cashAccount.id}: ${String(error)}`);
  });

  await prisma.regularInvestPlan.update({
    where: { id: plan.id },
    data: {
      executedRuns: finalExecutedRuns,
      lastRunDate: finalLastRunDate,
      nextRunDate,
      status: nextStatus,
    },
  });

  return {
    ok: true,
    taskType: "metal_regular_invest",
    generatedCount: datesToProcess.length,
    skipped: false,
    message: willComplete
      ? `已生成 ${datesToProcess.length} 笔贵金属积存记录，计划已完成`
      : `已生成 ${datesToProcess.length} 笔贵金属积存记录`,
    date: formatDateUtc(finalLastRunDate),
    executedRuns: finalExecutedRuns,
    completed: willComplete,
    stats: {
      executedCount: finalExecutedRuns,
      executedAmount: finalExecutedRuns * amount,
      confirmedCount: 0,
      confirmedAmount: 0,
      plan: {
        executedRuns: finalExecutedRuns,
        lastRunDate: finalLastRunDate.toISOString(),
        nextRunDate: nextRunDate.toISOString(),
        status: nextStatus,
      },
    },
  };
}
