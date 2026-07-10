import { NextResponse } from "next/server";
import { IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber, formatDateUtc } from "@/lib/date-utils";
import {
  calcLoanRunPartsWithRateAdjustments,
  calcLoanScheduledAmount,
  calcLoanScheduledAmountExact,
  estimateLoanEqualPaymentRemainingRuns,
  getEffectiveLoanAnnualRate,
  roundLoanMoney,
} from "@/lib/loan-repayment";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo } from "@/lib/scheduled-task";
import {
  DEFAULT_LOAN_PREPAY_STRATEGY,
  parseLoanPrepayStrategy,
} from "@/lib/loan-prepay-strategy";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { listLoanRateAdjustmentsByAccountIds, resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";

export const runtime = "nodejs";

const AUTO_LOAN_REPAYMENT_SOURCE = "scheduled_task";
const LOCKED_LOAN_REPAYMENT_SOURCE = "debt_repay_out";
const LOAN_REPAYMENT_BOUNDARY_SOURCES = [AUTO_LOAN_REPAYMENT_SOURCE, LOCKED_LOAN_REPAYMENT_SOURCE] as const;

/**
 * POST /api/v1/loan-repayment/recalculate
 * Body: { accountId: string, startDate?: "YYYY-MM-DD" }
 * If startDate points to a prepayment record, the recalculation strategy is read from that record.
 * Recalculates only the future loan repayment plan from the current loan balance,
 * existing executed count, selected start date, and stored loan rate adjustments.
 */
function parseDateOnlyUtc(value: unknown) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function parseLoanTotalRunsFromNote(note?: string | null) {
  const match = String(note ?? "").match(/期数[：:]\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function alignToRepaymentRunDate(
  date: Date,
  plan: { intervalUnit: IntervalUnit; intervalValue: number; executionDay?: number | null },
) {
  return calcInitialScheduledRunDate(date, plan.intervalUnit, plan.intervalValue, plan.executionDay, false);
}

async function getPrepaymentStrategyForStartDate(params: {
  householdId: string;
  accountId: string;
  date: Date | null;
}) {
  if (!params.date) return null;
  const row = await prisma.txRecord.findFirst({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      source: "debt_prepay_out",
      type: TransactionType.transfer,
      toAccountId: params.accountId,
      date: params.date,
    },
    orderBy: { id: "desc" },
    select: { toNote: true },
  });
  return parseLoanPrepayStrategy(row?.toNote) ?? null;
}

async function getLoanBalanceBeforeDate(params: {
  householdId: string;
  accountId: string;
  date: Date;
}) {
  const rows = await prisma.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      type: TransactionType.transfer,
      date: { lt: params.date },
      OR: [{ accountId: params.accountId }, { toAccountId: params.accountId }],
    },
    select: {
      accountId: true,
      toAccountId: true,
      amount: true,
      debtPrincipalAmount: true,
    },
  });

  return rows.reduce((sum, row) => (
    sum + (
      row.toAccountId === params.accountId
        ? Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount))
        : toNumber(row.amount)
    )
  ), 0);
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const accountId = String(body?.accountId ?? "").trim();
    const requestedStartDate = body?.startDate ? parseDateOnlyUtc(body.startDate) : null;

    if (!accountId) return NextResponse.json({ ok: false, error: "缺少贷款账户" }, { status: 400 });
    if (body?.startDate && !requestedStartDate) {
      return NextResponse.json({ ok: false, error: "重算起始日期不正确" }, { status: 400 });
    }

    const plan = await prisma.regularInvestPlan.findFirst({
      where: {
        householdId,
        accountId,
        fundCode: "loan_repayment",
        status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
      },
      include: {
        Account_RegularInvestPlan_accountIdToAccount: {
          select: { id: true, balance: true },
        },
      },
      orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
    });
    if (!plan) return NextResponse.json({ ok: false, error: "未找到可重算的还款计划" }, { status: 404 });

    const memo = decodeScheduledTaskMemo(plan.memo);
    if (memo.type !== "loan_repayment") {
      return NextResponse.json({ ok: false, error: "当前计划不是贷款还款计划" }, { status: 400 });
    }
    if (memo.repaymentMethod === "自由还款") {
      return NextResponse.json({ ok: false, error: "自由还款没有固定计划，不需要重算" }, { status: 400 });
    }

    const originalBorrow = await prisma.txRecord.findFirst({
      where: {
        householdId,
        deletedAt: null,
        source: "debt_borrow_in",
        type: TransactionType.transfer,
        accountId: plan.accountId,
      },
      orderBy: { date: "asc" },
      select: { note: true },
    });
    const originalTotalRuns = memo.originalTotalRuns ?? parseLoanTotalRunsFromNote(originalBorrow?.note);
    const remainingPrincipal = Math.abs(toNumber(plan.Account_RegularInvestPlan_accountIdToAccount.balance));
    const executedRuns = Math.max(0, plan.executedRuns ?? 0);
    const remainingRuns = plan.totalRuns == null ? null : Math.max(0, plan.totalRuns - executedRuns);
    const originalRemainingRuns = originalTotalRuns == null ? null : Math.max(0, originalTotalRuns - executedRuns);
    const intervalMonths = memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : 1);
    const rawRecalculateStartDate = requestedStartDate ?? plan.nextRunDate;
    const recalculateStartDate = requestedStartDate
      ? alignToRepaymentRunDate(requestedStartDate, plan)
      : plan.nextRunDate;
    const strategy =
      await getPrepaymentStrategyForStartDate({
        householdId,
        accountId: plan.accountId,
        date: requestedStartDate,
      }) ?? DEFAULT_LOAN_PREPAY_STRATEGY;
    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const adjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
    });

    if (formatDateUtc(recalculateStartDate) < formatDateUtc(plan.nextRunDate)) {
      const historicalExistingRows = await prisma.txRecord.findMany({
        where: {
          householdId,
          regularInvestPlanId: plan.id,
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          source: { in: [...LOAN_REPAYMENT_BOUNDARY_SOURCES] },
          date: { gte: recalculateStartDate },
          deletedAt: null,
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        select: { date: true, source: true, amount: true, debtPrincipalAmount: true },
      });

      const historicalExistingByDate = new Map<string, (typeof historicalExistingRows)[number]>();
      for (const row of historicalExistingRows) {
        const key = formatDateUtc(row.date);
        const existing = historicalExistingByDate.get(key);
        if (!existing || row.source === LOCKED_LOAN_REPAYMENT_SOURCE) {
          historicalExistingByDate.set(key, row);
        }
      }

      const historicalRuns: Array<{
        date: Date;
        source: typeof AUTO_LOAN_REPAYMENT_SOURCE | typeof LOCKED_LOAN_REPAYMENT_SOURCE;
        amount: unknown;
        debtPrincipalAmount: unknown;
      }> = [];
      let historicalRunDate = recalculateStartDate;
      let historicalGuard = 0;
      while (formatDateUtc(historicalRunDate) < formatDateUtc(plan.nextRunDate)) {
        const existing = historicalExistingByDate.get(formatDateUtc(historicalRunDate));
        historicalRuns.push({
          date: historicalRunDate,
          source: existing?.source === LOCKED_LOAN_REPAYMENT_SOURCE ? LOCKED_LOAN_REPAYMENT_SOURCE : AUTO_LOAN_REPAYMENT_SOURCE,
          amount: existing?.amount ?? null,
          debtPrincipalAmount: existing?.debtPrincipalAmount ?? null,
        });
        historicalRunDate = calcNextScheduledRunDate(
          historicalRunDate,
          plan.intervalUnit,
          plan.intervalValue,
          plan.executionDay,
          false,
        );
        historicalGuard += 1;
        if (historicalGuard > 1200) {
          return NextResponse.json({ ok: false, error: "计划周期异常，已停止重算以避免无限循环" }, { status: 400 });
        }
      }
      if (historicalRuns.length === 0) {
        return NextResponse.json({ ok: false, error: "起始日期之后没有可重算的计划期次" }, { status: 400 });
      }

      const firstRunDate = historicalRuns[0]!.date;
      const finalRunDate = historicalRuns[historicalRuns.length - 1]!.date;
      const previousPrincipalRow = await prisma.txRecord.findFirst({
        where: {
          householdId,
          regularInvestPlanId: plan.id,
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          source: { in: [...LOAN_REPAYMENT_BOUNDARY_SOURCES] },
          date: { lt: firstRunDate },
          deletedAt: null,
        },
        orderBy: { date: "desc" },
        select: { date: true, amount: true, debtPrincipalAmount: true, debtInterestAmount: true },
      });
      const previousRunDate = previousPrincipalRow?.date ?? plan.startDate;
      const previousScheduledAmount =
        previousPrincipalRow &&
        (toNumber(previousPrincipalRow.debtPrincipalAmount) > 0 || toNumber(previousPrincipalRow.debtInterestAmount) > 0)
          ? roundLoanMoney(Math.abs(toNumber(previousPrincipalRow.debtPrincipalAmount)) + Math.abs(toNumber(previousPrincipalRow.debtInterestAmount)))
          : previousPrincipalRow
            ? Math.abs(toNumber(previousPrincipalRow.amount))
            : toNumber(plan.amount);
      const existingExecutedBefore = await prisma.txRecord.count({
        where: {
          householdId,
          regularInvestPlanId: plan.id,
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          source: { in: [...LOAN_REPAYMENT_BOUNDARY_SOURCES] },
          date: { lt: firstRunDate },
          deletedAt: null,
        },
      });
      let scheduledRunsBefore = 0;
      let scheduledBeforeDate = plan.startDate;
      let scheduledBeforeGuard = 0;
      while (formatDateUtc(scheduledBeforeDate) < formatDateUtc(firstRunDate)) {
        scheduledRunsBefore += 1;
        scheduledBeforeDate = calcNextScheduledRunDate(
          scheduledBeforeDate,
          plan.intervalUnit,
          plan.intervalValue,
          plan.executionDay,
          false,
        );
        scheduledBeforeGuard += 1;
        if (scheduledBeforeGuard > 1200) break;
      }
      const executedBefore = Math.max(
        existingExecutedBefore,
        Math.min(scheduledRunsBefore, Math.max(0, plan.executedRuns ?? 0)),
      );
      const prepaymentBeforeStart = await prisma.txRecord.findFirst({
        where: {
          householdId,
          deletedAt: null,
          source: "debt_prepay_out",
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          date: { lte: previousRunDate },
        },
        select: { id: true },
      });
      const totalRunsForHistoricalStart = strategy === "reduce_payment"
        ? (originalTotalRuns ?? plan.totalRuns)
        : prepaymentBeforeStart
        ? plan.totalRuns
        : (originalTotalRuns ?? plan.totalRuns);
      const remainingRunsAtStart = totalRunsForHistoricalStart == null ? null : Math.max(0, totalRunsForHistoricalStart - executedBefore);
      if (!remainingRunsAtStart || remainingRunsAtStart <= 0) {
        return NextResponse.json({ ok: false, error: "起始日期后的剩余期数不足，无法重算历史记录" }, { status: 400 });
      }

      let rollingRemainingPrincipal = Math.abs(await getLoanBalanceBeforeDate({
        householdId,
        accountId: plan.accountId,
        date: firstRunDate,
      }));
      if (rollingRemainingPrincipal <= 0.005) {
        if (strategy === "settle") {
          const cashAccount = plan.cashAccountId
            ? await prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true } })
            : null;
          const targetAccount = await prisma.account.findUnique({ where: { id: plan.accountId }, select: { id: true } });
          await prisma.$transaction(async (tx) => {
            await tx.txRecord.updateMany({
              where: {
                householdId,
                regularInvestPlanId: plan.id,
                source: AUTO_LOAN_REPAYMENT_SOURCE,
                OR: [
                  { type: TransactionType.transfer, toAccountId: plan.accountId },
                  { type: TransactionType.expense },
                ],
                deletedAt: null,
                date: { gte: rawRecalculateStartDate },
              },
              data: { deletedAt: new Date() },
            });
            await tx.regularInvestPlan.update({
              where: { id: plan.id },
              data: {
                status: RegularInvestStatus.completed,
                endDate: rawRecalculateStartDate,
                memo: encodeScheduledTaskMemo({ ...memo, originalTotalRuns: originalTotalRuns ?? memo.originalTotalRuns ?? null, loanRateAdjustments: [] }),
              },
            });
          });
          if (cashAccount) await recalcAndSaveAccountBalance(cashAccount.id);
          if (targetAccount) await recalcAndSaveAccountBalance(targetAccount.id);
          revalidateAfterTxChange();
          return NextResponse.json({ ok: true, data: { status: "completed", nextAmount: 0, remainingRuns: 0 } });
        }
        return NextResponse.json({ ok: false, error: "起始日期前贷款余额已为 0，无法重算历史记录" }, { status: 400 });
      }
      if (strategy === "settle") {
        return NextResponse.json({ ok: false, error: "全部结清要求贷款余额为 0，请检查提前还本金金额" }, { status: 400 });
      }
      let rollingExactRemainingPrincipal = rollingRemainingPrincipal;

      let rollingPreviousRunDate = previousRunDate;
      const prepaymentRows = await prisma.txRecord.findMany({
        where: {
          householdId,
          deletedAt: null,
          source: "debt_prepay_out",
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          date: { gt: previousRunDate, lte: finalRunDate },
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        select: { date: true, amount: true, debtPrincipalAmount: true },
      });
      const inPeriodPrepaymentsAlreadyInBalance = prepaymentRows
        .filter((row) => row.date < firstRunDate)
        .reduce((sum, row) => sum + Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)), 0);
      if (inPeriodPrepaymentsAlreadyInBalance > 0) {
        rollingExactRemainingPrincipal += inPeriodPrepaymentsAlreadyInBalance;
        rollingRemainingPrincipal = Math.round((rollingRemainingPrincipal + inPeriodPrepaymentsAlreadyInBalance) * 100) / 100;
      }
      const annualRateAtHistoricalStart = getEffectiveLoanAnnualRate({
        baseAnnualRate: memo.annualRate,
        adjustments,
        date: formatDateUtc(previousRunDate),
      });
      let rollingScheduledAmount = strategy === "reduce_payment"
        ? (
            calcLoanScheduledAmount({
              repaymentMethod: memo.repaymentMethod,
              annualRate: annualRateAtHistoricalStart,
              principal: rollingRemainingPrincipal,
              totalRuns: remainingRunsAtStart,
              intervalMonths,
            }) ?? toNumber(plan.amount)
          )
        : previousScheduledAmount || toNumber(plan.amount);
      let rollingScheduledAmountExact = strategy === "reduce_payment"
        ? (
            calcLoanScheduledAmountExact({
              repaymentMethod: memo.repaymentMethod,
              annualRate: annualRateAtHistoricalStart,
              principal: rollingExactRemainingPrincipal,
              totalRuns: remainingRunsAtStart,
              intervalMonths,
            }) ?? rollingScheduledAmount
          )
        : previousScheduledAmount || toNumber(plan.amount);
      let rollingRemainingRunsForReduceTerm = remainingRunsAtStart;
      const cashAccount = plan.cashAccountId
        ? await prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true } })
        : null;
      if (!cashAccount) {
        return NextResponse.json({ ok: false, error: "计划缺少还款资金账户，无法重算历史记录" }, { status: 400 });
      }
      const targetAccount = await prisma.account.findUnique({ where: { id: plan.accountId }, select: { id: true, name: true } });
      if (!targetAccount) {
        return NextResponse.json({ ok: false, error: "贷款账户不存在" }, { status: 404 });
      }
      let nextPrepaymentIndex = 0;
      const applyPrepaymentsBefore = (previousRunDate: Date) => {
        while (
          nextPrepaymentIndex < prepaymentRows.length &&
          prepaymentRows[nextPrepaymentIndex]!.date <= previousRunDate
        ) {
          rollingExactRemainingPrincipal = Math.max(
            0,
            rollingExactRemainingPrincipal - Math.abs(toNumber(prepaymentRows[nextPrepaymentIndex]!.debtPrincipalAmount ?? prepaymentRows[nextPrepaymentIndex]!.amount)),
          );
          rollingRemainingPrincipal = Math.max(
            0,
            Math.round((rollingRemainingPrincipal - Math.abs(toNumber(prepaymentRows[nextPrepaymentIndex]!.debtPrincipalAmount ?? prepaymentRows[nextPrepaymentIndex]!.amount))) * 100) / 100,
          );
          nextPrepaymentIndex += 1;
        }
      };

      if (historicalRuns.length === 0) {
        return NextResponse.json({ ok: false, error: "没有可重算的历史期次" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        if (formatDateUtc(rawRecalculateStartDate) < formatDateUtc(firstRunDate)) {
          await tx.txRecord.updateMany({
            where: {
              householdId,
              regularInvestPlanId: plan.id,
              source: AUTO_LOAN_REPAYMENT_SOURCE,
              OR: [
                { type: TransactionType.transfer, toAccountId: plan.accountId },
                { type: TransactionType.expense },
              ],
              deletedAt: null,
              date: { gte: rawRecalculateStartDate, lt: firstRunDate },
            },
            data: { deletedAt: new Date() },
          });
        }

        await tx.txRecord.updateMany({
          where: {
            householdId,
            regularInvestPlanId: plan.id,
            source: AUTO_LOAN_REPAYMENT_SOURCE,
            OR: [
              { type: TransactionType.transfer, toAccountId: plan.accountId },
              { type: TransactionType.expense },
            ],
            deletedAt: null,
            date: { gte: firstRunDate, lte: finalRunDate },
          },
          data: { deletedAt: new Date() },
        });

        for (const [index, currentRun] of historicalRuns.entries()) {
          const currentRunDate = currentRun.date;
          applyPrepaymentsBefore(rollingPreviousRunDate);
          const runDateKey = formatDateUtc(currentRunDate);
          const remainingRunsForThisRun = strategy === "reduce_term"
            ? Math.max(1, rollingRemainingRunsForReduceTerm)
            : Math.max(1, remainingRunsAtStart - index);
          const parts = calcLoanRunPartsWithRateAdjustments({
            repaymentMethod: memo.repaymentMethod,
            baseAnnualRate: memo.annualRate,
            adjustments,
            principalAdjustments: prepaymentRows
              .filter((row) => row.date > rollingPreviousRunDate && row.date <= currentRunDate)
              .map((row) => ({
                date: formatDateUtc(row.date),
                amount: Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)),
              })),
            intervalMonths,
            scheduledAmount: rollingScheduledAmount,
            scheduledAmountExact: rollingScheduledAmountExact,
            preserveScheduledAmount: strategy === "reduce_term",
            remainingPrincipal: rollingExactRemainingPrincipal,
            remainingRuns: remainingRunsForThisRun,
            previousRunDate: formatDateUtc(rollingPreviousRunDate),
            runDate: runDateKey,
          });
          rollingScheduledAmount = parts.scheduledAmount;
          rollingScheduledAmountExact = parts.scheduledAmountExact ?? rollingScheduledAmountExact;
          if (currentRun.source === LOCKED_LOAN_REPAYMENT_SOURCE) {
            const lockedPrincipal = toNumber(currentRun.debtPrincipalAmount ?? currentRun.amount);
            rollingExactRemainingPrincipal = Math.max(
              0,
              rollingExactRemainingPrincipal - Math.abs(lockedPrincipal),
            );
            rollingRemainingPrincipal = Math.max(
              0,
              Math.round((rollingRemainingPrincipal - Math.abs(lockedPrincipal)) * 100) / 100,
            );
            if (strategy === "reduce_term") {
              rollingRemainingRunsForReduceTerm = Math.max(0, rollingRemainingRunsForReduceTerm - 1);
            }
            rollingPreviousRunDate = currentRunDate;
            continue;
          }
          if (currentRun.source !== AUTO_LOAN_REPAYMENT_SOURCE) continue;

          if (parts.principal > 0 || parts.interest > 0) {
            await tx.txRecord.create({
              data: {
                householdId,
                date: currentRunDate,
                type: TransactionType.transfer,
                accountId: cashAccount.id,
                accountName: cashAccount.name,
                toAccountId: targetAccount.id,
                toAccountName: targetAccount.name,
                amount: -roundLoanMoney(parts.principal + parts.interest),
                debtPrincipalAmount: Math.abs(parts.principal),
                debtInterestAmount: Math.abs(parts.interest),
                debtFeeAmount: 0,
                source: AUTO_LOAN_REPAYMENT_SOURCE,
                regularInvestPlanId: plan.id,
                note: "计划任务：还贷款",
              },
            });
          }
          const inPeriodPrepaymentTotal = prepaymentRows
            .filter((row) => row.date > rollingPreviousRunDate && row.date <= currentRunDate)
            .reduce((sum, row) => sum + Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)), 0);
          rollingExactRemainingPrincipal = Math.max(0, rollingExactRemainingPrincipal - (parts.principalExact ?? parts.principal));
          rollingRemainingPrincipal = Math.max(0, Math.round((rollingRemainingPrincipal - parts.principal) * 100) / 100);
          if (inPeriodPrepaymentTotal > 0) {
            rollingExactRemainingPrincipal = Math.max(0, rollingExactRemainingPrincipal - inPeriodPrepaymentTotal);
            rollingRemainingPrincipal = Math.max(0, Math.round((rollingRemainingPrincipal - inPeriodPrepaymentTotal) * 100) / 100);
            while (
              nextPrepaymentIndex < prepaymentRows.length &&
              prepaymentRows[nextPrepaymentIndex]!.date <= currentRunDate
            ) {
              nextPrepaymentIndex += 1;
            }
            if (strategy === "reduce_term" && rollingExactRemainingPrincipal > 0.005) {
              const annualRateForEstimate = getEffectiveLoanAnnualRate({
                baseAnnualRate: memo.annualRate,
                adjustments,
                date: runDateKey,
              });
              rollingRemainingRunsForReduceTerm = estimateLoanEqualPaymentRemainingRuns({
                annualRate: annualRateForEstimate,
                intervalMonths,
                scheduledAmount: rollingScheduledAmount,
                remainingPrincipal: rollingExactRemainingPrincipal,
                maxRemainingRuns: Math.max(1, rollingRemainingRunsForReduceTerm - 1),
              }) + 1;
            }
          }
          if (strategy === "reduce_term") {
            rollingRemainingRunsForReduceTerm = Math.max(0, rollingRemainingRunsForReduceTerm - 1);
          }
          rollingPreviousRunDate = currentRunDate;
        }

        const executedAfterHistorical = executedBefore + historicalRuns.length;
        let totalRunsAfterHistorical = strategy === "reduce_payment" && originalTotalRuns != null ? originalTotalRuns : plan.totalRuns;
        if (strategy === "reduce_term") {
          const maxRemainingRuns = Math.min(
            Math.max(
              totalRunsForHistoricalStart == null
                ? 600
                : Math.max(0, totalRunsForHistoricalStart - executedAfterHistorical),
              1,
            ),
            600,
          );
          const annualRateForEstimate = getEffectiveLoanAnnualRate({
            baseAnnualRate: memo.annualRate,
            adjustments,
            date: formatDateUtc(historicalRuns[historicalRuns.length - 1]!.date),
          });
          const estimatedRuns = estimateLoanEqualPaymentRemainingRuns({
            annualRate: annualRateForEstimate,
            intervalMonths,
            scheduledAmount: rollingScheduledAmount,
            remainingPrincipal: rollingExactRemainingPrincipal,
            maxRemainingRuns,
          });
          totalRunsAfterHistorical = executedAfterHistorical + estimatedRuns;
        }

        await tx.regularInvestPlan.update({
          where: { id: plan.id },
          data: {
            amount: rollingScheduledAmount,
            totalRuns: totalRunsAfterHistorical,
            executedRuns: executedAfterHistorical,
            lastRunDate: historicalRuns[historicalRuns.length - 1]!.date,
            nextRunDate: calcNextScheduledRunDate(
              historicalRuns[historicalRuns.length - 1]!.date,
              plan.intervalUnit,
              plan.intervalValue,
              plan.executionDay,
              false,
            ),
            memo: encodeScheduledTaskMemo({ ...memo, originalTotalRuns: originalTotalRuns ?? memo.originalTotalRuns ?? null, loanRateAdjustments: [] }),
          },
        });
      });

      await recalcAndSaveAccountBalance(cashAccount.id);
      await recalcAndSaveAccountBalance(targetAccount.id);
      revalidateAfterTxChange();
      return NextResponse.json({
        ok: true,
        data: {
          status: "historical_recalculated",
          regeneratedCount: historicalRuns.filter((row) => row.source === AUTO_LOAN_REPAYMENT_SOURCE).length,
          lockedCount: historicalRuns.filter((row) => row.source === LOCKED_LOAN_REPAYMENT_SOURCE).length,
          startDate: formatDateUtc(firstRunDate),
          endDate: formatDateUtc(historicalRuns[historicalRuns.length - 1]!.date),
        },
      });
    }

    if (remainingPrincipal <= 0.005) {
      await prisma.regularInvestPlan.update({
        where: { id: plan.id },
        data: {
          status: RegularInvestStatus.completed,
          endDate: new Date(),
          memo: encodeScheduledTaskMemo({ ...memo, originalTotalRuns: originalTotalRuns ?? memo.originalTotalRuns ?? null, loanRateAdjustments: [] }),
        },
      });
      revalidateAfterTxChange();
      return NextResponse.json({ ok: true, data: { status: "completed", nextAmount: 0, remainingRuns: 0 } });
    }
    if (strategy === "settle") {
      return NextResponse.json({ ok: false, error: "全部结清要求贷款余额为 0，请检查提前还本金金额" }, { status: 400 });
    }

    const availableRemainingRuns = strategy === "reduce_payment" ? (originalRemainingRuns ?? remainingRuns) : remainingRuns;
    if (!availableRemainingRuns || availableRemainingRuns <= 0) {
      return NextResponse.json({ ok: false, error: "计划剩余期数不足，无法重算" }, { status: 400 });
    }

    const nextRunDateKey = formatDateUtc(recalculateStartDate);
    const effectiveAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: memo.annualRate,
      adjustments,
      date: nextRunDateKey,
    });
    const currentAmount = toNumber(plan.amount);
    const updateData: { amount?: number; totalRuns?: number; nextRunDate: Date; memo: string } = {
      nextRunDate: recalculateStartDate,
      memo: encodeScheduledTaskMemo({ ...memo, originalTotalRuns: originalTotalRuns ?? memo.originalTotalRuns ?? null, loanRateAdjustments: [] }),
    };

    if (strategy === "reduce_payment") {
      const fixedTermRemainingRuns = originalRemainingRuns ?? remainingRuns;
      if (!fixedTermRemainingRuns || fixedTermRemainingRuns <= 0) {
        return NextResponse.json({ ok: false, error: "原始贷款期限不足，无法按期限不变重算月供" }, { status: 400 });
      }
      const nextAmount = calcLoanScheduledAmount({
        repaymentMethod: memo.repaymentMethod,
        annualRate: effectiveAnnualRate,
        principal: remainingPrincipal,
        totalRuns: fixedTermRemainingRuns,
        intervalMonths,
      });
      if (!nextAmount || nextAmount <= 0) {
        return NextResponse.json({ ok: false, error: "无法重算月供，请检查利率、剩余本金和剩余期数" }, { status: 400 });
      }
      updateData.amount = nextAmount;
      if (originalTotalRuns != null && originalTotalRuns > executedRuns) {
        updateData.totalRuns = originalTotalRuns;
      }
    } else {
      const termRemainingRuns = remainingRuns ?? 0;
      if (currentAmount <= 0) {
        return NextResponse.json({ ok: false, error: "当前计划金额不正确，无法按月供不变重算" }, { status: 400 });
      }
      const estimatedRuns = estimateLoanEqualPaymentRemainingRuns({
        annualRate: effectiveAnnualRate,
        intervalMonths,
        scheduledAmount: currentAmount,
        remainingPrincipal,
        maxRemainingRuns: termRemainingRuns || originalRemainingRuns || 600,
      });
      if (estimatedRuns <= 0) {
        return NextResponse.json({ ok: false, error: "剩余本金已为 0，无法按月供不变重算" }, { status: 400 });
      }
      updateData.totalRuns = executedRuns + estimatedRuns;
    }

    const updatedPlan = await prisma.regularInvestPlan.update({
      where: { id: plan.id },
      data: updateData,
      select: { amount: true, totalRuns: true, executedRuns: true },
    });

    revalidateAfterTxChange();
    return NextResponse.json({
      ok: true,
      data: {
        status: "active",
        nextAmount: toNumber(updatedPlan.amount),
        totalRuns: updatedPlan.totalRuns,
        remainingRuns: updatedPlan.totalRuns == null ? null : Math.max(0, updatedPlan.totalRuns - Math.max(0, updatedPlan.executedRuns ?? 0)),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "重算还款计划失败" },
      { status: 500 },
    );
  }
}
