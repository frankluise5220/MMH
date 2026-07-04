import { FundSubtype, Prisma, RegularInvestStatus, TransactionType, type Account, type IntervalUnit, type RegularInvestPlan } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { calcLoanRunPartsWithRateAdjustments, calcLoanScheduledAmountForPeriodStart, roundLoanMoney } from "@/lib/loan-repayment";
import { decodeScheduledTaskMemo, scheduledTaskTypeLabel, type ScheduledTaskPayload, type ScheduledTaskType } from "@/lib/scheduled-task";
import { calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { listLoanRateAdjustmentsByAccountIds, resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";

type AccountRef = Pick<Account, "id" | "name">;
type NonFundTaskType = Exclude<ScheduledTaskType, "fund_regular_invest">;

export type NonFundScheduledTaskResult = {
  ok: true;
  taskType: NonFundTaskType;
  generatedCount: number;
  skipped: boolean;
  message: string;
  date: string | null;
  executedRuns: number;
  completed: boolean;
  stats: {
    plan: {
      executedRuns: number;
      lastRunDate: string | null;
      nextRunDate: string | null;
      status: RegularInvestStatus;
    };
  };
};

export function isNonFundScheduledTask(type: ScheduledTaskType): type is NonFundTaskType {
  return type !== "fund_regular_invest";
}

export function getScheduledTaskSourceFilter(type: NonFundTaskType) {
  return type === "insurance_premium" ? ["insurance"] : ["scheduled_task"];
}

function toPositiveAmount(value: unknown) {
  const amount = value instanceof Prisma.Decimal ? value.toNumber() : Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function getTaskNote(type: NonFundTaskType, label?: string | null) {
  if (type === "loan_repayment") return "计划任务：还贷款";
  if (type === "insurance_premium") return label ? `计划任务：保险缴费：${label}` : "计划任务：保险缴费";
  return "计划任务：转账";
}

function makeNextRunDate(plan: RegularInvestPlan, fromDate: Date) {
  return calcNextScheduledRunDate(
    fromDate,
    plan.intervalUnit as IntervalUnit,
    plan.intervalValue,
    plan.executionDay,
    false,
  );
}

async function loadTaskAccounts(plan: RegularInvestPlan) {
  const [targetAcc, cashAcc] = await Promise.all([
    prisma.account.findUnique({ where: { id: plan.accountId }, select: { id: true, name: true } }),
    plan.cashAccountId
      ? prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true } })
      : Promise.resolve(null),
  ]);
  return { targetAcc, cashAcc };
}

export async function executeNonFundScheduledTaskPlan(params: {
  householdId: string;
  plan: RegularInvestPlan;
  task?: ScheduledTaskPayload;
  overrideDate?: Date | null;
  overrideAmount?: number | null;
  now?: Date;
}): Promise<NonFundScheduledTaskResult> {
  const { householdId, plan } = params;
  const task = params.task ?? decodeScheduledTaskMemo(plan.memo);
  if (!isNonFundScheduledTask(task.type)) {
    throw new Error("executeNonFundScheduledTaskPlan only accepts non-fund scheduled tasks");
  }
  const loanRateAdjustments = task.type === "loan_repayment"
    ? resolveLoanRateAdjustments({
        tableAdjustments: (await listLoanRateAdjustmentsByAccountIds({
          householdId,
          accountIds: [plan.accountId],
        })).get(plan.accountId),
        memoAdjustments: task.loanRateAdjustments,
      })
    : [];

  const { targetAcc, cashAcc } = await loadTaskAccounts(plan);
  if (!targetAcc) throw new Error("目标账户不存在");
  if (!cashAcc) throw new Error("计划任务缺少资金账户");

  const amountNum = params.overrideAmount && params.overrideAmount > 0
    ? params.overrideAmount
    : toPositiveAmount(plan.amount);
  if (!amountNum) throw new Error("金额不正确");

  const sourceFilter = getScheduledTaskSourceFilter(task.type);
  const existingTxRecords = await prisma.txRecord.findMany({
    where: task.type === "insurance_premium" && task.insuranceProductId
      ? {
          householdId,
          insuranceProductId: task.insuranceProductId,
          source: { in: sourceFilter },
          type: TransactionType.investment,
          fundSubtype: FundSubtype.buy,
          deletedAt: null,
        }
      : {
          householdId,
          regularInvestPlanId: plan.id,
          source: { in: sourceFilter },
          deletedAt: null,
        },
    select: { date: true },
  });
  const existingDates = new Set(existingTxRecords.map((record) => formatDateUtc(record.date)));
  const remainingRuns = plan.totalRuns ? Math.max(0, plan.totalRuns - plan.executedRuns) : Number.POSITIVE_INFINITY;
  const datesToProcess: Date[] = [];
  const firstExistingDate = existingTxRecords[0]?.date ?? null;
  const latestExistingDate = firstExistingDate
    ? existingTxRecords.reduce((latest, record) => (record.date > latest ? record.date : latest), firstExistingDate)
    : null;

  if (params.overrideDate) {
    const overrideRunDate = startOfDayUtc(params.overrideDate);
    if (!existingDates.has(formatDateUtc(overrideRunDate)) && remainingRuns > 0) {
      datesToProcess.push(overrideRunDate);
    }
  } else {
    const today = startOfDayUtc(params.now ?? new Date());
    const effectiveEndDate = plan.endDate && startOfDayUtc(plan.endDate) < today ? startOfDayUtc(plan.endDate) : today;
    let currentDate = latestExistingDate
      ? makeNextRunDate(plan, latestExistingDate)
      : startOfDayUtc(plan.nextRunDate);
    let guard = 0;
    while (currentDate <= effectiveEndDate && datesToProcess.length < remainingRuns) {
      const dateStr = formatDateUtc(currentDate);
      if (!existingDates.has(dateStr)) datesToProcess.push(currentDate);
      currentDate = makeNextRunDate(plan, currentDate);
      guard++;
      if (guard > 1200) throw new Error("计划周期异常，已停止生成以避免无限循环");
    }
  }

  if (datesToProcess.length === 0) {
    return {
      ok: true,
      taskType: task.type,
      generatedCount: 0,
      skipped: true,
      message: "所有到期的计划记录已存在，无需重复生成",
      date: null,
      executedRuns: plan.executedRuns,
      completed: false,
      stats: {
        plan: {
          executedRuns: plan.executedRuns,
          lastRunDate: plan.lastRunDate?.toISOString() ?? null,
          nextRunDate: plan.nextRunDate?.toISOString() ?? null,
          status: plan.status,
        },
      },
    };
  }

  const insuranceProduct = task.type === "insurance_premium"
    ? await prisma.insuranceProduct.findFirst({ where: { id: task.insuranceProductId || "", householdId } })
    : null;
  if (task.type === "insurance_premium" && !task.insuranceProductId) throw new Error("计划缺少保险产品");
  if (task.type === "insurance_premium" && !insuranceProduct) throw new Error("保险产品不存在");

  const finalLastRunDate = datesToProcess[datesToProcess.length - 1]!;
  const finalExecutedRuns = plan.executedRuns + datesToProcess.length;
  const nextRunDate = makeNextRunDate(plan, finalLastRunDate);
  const willComplete = !!(
    (plan.totalRuns && finalExecutedRuns >= plan.totalRuns) ||
    (plan.endDate && startOfDayUtc(plan.endDate) < nextRunDate)
  );
  const nextStatus = willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active;

  const initialDebtAccount =
    task.type === "loan_repayment"
      ? await prisma.account.findUnique({
          where: { id: targetAcc.id },
          select: { balance: true },
        })
      : null;
  let rollingRemainingPrincipal = Math.abs(toNumber(initialDebtAccount?.balance ?? 0));
  let rollingPreviousRunDate = latestExistingDate
    ? startOfDayUtc(latestExistingDate)
    : plan.lastRunDate
      ? startOfDayUtc(plan.lastRunDate)
      : startOfDayUtc(plan.startDate);
  let rollingScheduledAmount = task.type === "loan_repayment"
    ? calcLoanScheduledAmountForPeriodStart({
        repaymentMethod: task.repaymentMethod,
        baseAnnualRate: task.annualRate,
        adjustments: loanRateAdjustments,
        intervalMonths: task.repaymentIntervalMonths,
        scheduledAmount: amountNum,
        remainingPrincipal: rollingRemainingPrincipal,
        remainingRuns: plan.totalRuns ? Math.max(1, plan.totalRuns - plan.executedRuns) : 1,
        periodStartDate: formatDateUtc(rollingPreviousRunDate),
      })
    : amountNum;
  const affectedAccountIds = new Set<string>([cashAcc.id, targetAcc.id]);
  await prisma.$transaction(async (tx) => {
    for (const [runIndex, runDate] of datesToProcess.entries()) {
      if (task.type === "loan_repayment") {
        const remainingRunsForThisRun = plan.totalRuns
          ? Math.max(1, plan.totalRuns - plan.executedRuns - runIndex)
          : 1;
        const runDateKey = formatDateUtc(runDate);
        const parts = calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: task.repaymentMethod,
          baseAnnualRate: task.annualRate,
          adjustments: loanRateAdjustments,
          intervalMonths: task.repaymentIntervalMonths,
          scheduledAmount: rollingScheduledAmount,
          remainingPrincipal: rollingRemainingPrincipal,
          remainingRuns: remainingRunsForThisRun,
          previousRunDate: formatDateUtc(rollingPreviousRunDate),
          runDate: runDateKey,
        });
        rollingScheduledAmount = parts.scheduledAmount;
        rollingRemainingPrincipal = Math.max(0, roundLoanMoney(rollingRemainingPrincipal - parts.principal));
        rollingPreviousRunDate = runDate;

        if (parts.principal > 0) {
          await tx.txRecord.create({
            data: {
              householdId,
              type: TransactionType.transfer,
              date: runDate,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              toAccountId: targetAcc.id,
              toAccountName: targetAcc.name,
              amount: -parts.principal,
              source: "scheduled_task",
              regularInvestPlanId: plan.id,
              note: `${getTaskNote(task.type)}：本金`,
            },
          });
        }

        if (parts.interest > 0) {
          const interestCategory = await tx.category.findFirst({
            where: {
              householdId,
              type: "expense",
              name: "利息支出",
            },
            select: { id: true, name: true },
          });
          await tx.txRecord.create({
            data: {
              householdId,
              type: TransactionType.expense,
              date: runDate,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              amount: -parts.interest,
              categoryId: interestCategory?.id ?? null,
              categoryName: interestCategory?.name ?? "利息支出",
              source: "scheduled_task",
              regularInvestPlanId: plan.id,
              note: `${getTaskNote(task.type)}：利息`,
            },
          });
        }
      } else if (task.type === "transfer") {
        await tx.txRecord.create({
          data: {
            householdId,
            type: TransactionType.transfer,
            date: runDate,
            accountId: cashAcc.id,
            accountName: cashAcc.name,
            toAccountId: targetAcc.id,
            toAccountName: targetAcc.name,
            amount: -amountNum,
            source: "scheduled_task",
            regularInvestPlanId: plan.id,
            note: getTaskNote(task.type),
          },
        });
      } else if (task.type === "insurance_premium" && insuranceProduct) {
        affectedAccountIds.add(insuranceProduct.accountId);
        await tx.txRecord.create({
          data: {
            householdId,
            type: TransactionType.investment,
            date: runDate,
            accountId: cashAcc.id,
            accountName: cashAcc.name,
            toAccountId: insuranceProduct.accountId,
            toAccountName: targetAcc.name,
            amount: -amountNum,
            fundName: insuranceProduct.name,
            fundProductType: "wealth",
            fundSubtype: "buy",
            source: "insurance",
            insuranceProductId: insuranceProduct.id,
            regularInvestPlanId: plan.id,
            note: getTaskNote(task.type, insuranceProduct.name),
          },
        });
      }
    }

    await tx.regularInvestPlan.update({
      where: { id: plan.id },
      data: {
        lastRunDate: finalLastRunDate,
        nextRunDate,
        executedRuns: finalExecutedRuns,
        status: nextStatus,
      },
    });
  });

  for (const accountId of affectedAccountIds) {
    await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("balance", "scheduled-task-executor"));
  }
  if (task.type === "insurance_premium") revalidateAfterInvestChange();
  else revalidateAfterTxChange();

  return {
    ok: true,
    taskType: task.type,
    generatedCount: datesToProcess.length,
    skipped: false,
    message: `已执行${scheduledTaskTypeLabel(task.type)}，生成 ${datesToProcess.length} 条交易明细，金额 ${amountNum.toFixed(2)}，累计第 ${finalExecutedRuns} 次`,
    date: formatDateUtc(finalLastRunDate),
    executedRuns: finalExecutedRuns,
    completed: willComplete,
    stats: {
      plan: {
        executedRuns: finalExecutedRuns,
        lastRunDate: finalLastRunDate.toISOString(),
        nextRunDate: nextRunDate.toISOString(),
        status: nextStatus,
      },
    },
  };
}
