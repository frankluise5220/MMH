import { NextResponse } from "next/server";
import { IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber, formatDateUtc } from "@/lib/date-utils";
import {
  calcLoanRunParts,
  calcLoanRunPartsWithRateAdjustments,
  calcLoanScheduledAmount,
  calcLoanScheduledAmountForPeriodStart,
  getEffectiveLoanAnnualRate,
} from "@/lib/loan-repayment";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { listLoanRateAdjustmentsByAccountIds, resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { calcNextScheduledRunDate } from "@/lib/scheduled-task-date";

export const runtime = "nodejs";

type RecalculateStrategy = "reduce_payment" | "reduce_term";

function normalizeStrategy(value: unknown): RecalculateStrategy {
  return value === "reduce_term" ? "reduce_term" : "reduce_payment";
}

/**
 * POST /api/v1/loan-repayment/recalculate
 * Body: { accountId: string, strategy?: "reduce_payment" | "reduce_term", startDate?: "YYYY-MM-DD" }
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

async function getLoanBalanceBeforeDate(params: {
  householdId: string;
  accountId: string;
  date: Date;
}) {
  const rows = await prisma.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      date: { lt: params.date },
      OR: [{ accountId: params.accountId }, { toAccountId: params.accountId }],
    },
    select: {
      accountId: true,
      toAccountId: true,
      amount: true,
    },
  });

  return rows.reduce((sum, row) => (
    sum + (row.toAccountId === params.accountId ? Math.abs(toNumber(row.amount)) : toNumber(row.amount))
  ), 0);
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const accountId = String(body?.accountId ?? "").trim();
    const strategy = normalizeStrategy(body?.strategy);
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

    const remainingPrincipal = Math.abs(toNumber(plan.Account_RegularInvestPlan_accountIdToAccount.balance));
    const executedRuns = Math.max(0, plan.executedRuns ?? 0);
    const remainingRuns = plan.totalRuns == null ? null : Math.max(0, plan.totalRuns - executedRuns);
    const intervalMonths = memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : 1);
    const recalculateStartDate = requestedStartDate ?? plan.nextRunDate;
    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const adjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
    });

    if (formatDateUtc(recalculateStartDate) < formatDateUtc(plan.nextRunDate)) {
      const historicalPrincipalRows = await prisma.txRecord.findMany({
        where: {
          householdId,
          regularInvestPlanId: plan.id,
          source: "scheduled_task",
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          date: { gte: recalculateStartDate },
          deletedAt: null,
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        select: { date: true },
      });
      if (historicalPrincipalRows.length === 0) {
        return NextResponse.json({ ok: false, error: "起始日期之后没有可重算的计划还款记录" }, { status: 400 });
      }

      const firstRunDate = historicalPrincipalRows[0]!.date;
      const finalRunDate = historicalPrincipalRows[historicalPrincipalRows.length - 1]!.date;
      const previousPrincipalRow = await prisma.txRecord.findFirst({
        where: {
          householdId,
          regularInvestPlanId: plan.id,
          source: "scheduled_task",
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          date: { lt: firstRunDate },
          deletedAt: null,
        },
        orderBy: { date: "desc" },
        select: { date: true },
      });
      const executedBefore = await prisma.txRecord.count({
        where: {
          householdId,
          regularInvestPlanId: plan.id,
          source: "scheduled_task",
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          date: { lt: firstRunDate },
          deletedAt: null,
        },
      });
      const remainingRunsAtStart = plan.totalRuns == null ? null : Math.max(0, plan.totalRuns - executedBefore);
      if (!remainingRunsAtStart || remainingRunsAtStart <= 0) {
        return NextResponse.json({ ok: false, error: "起始日期后的剩余期数不足，无法重算历史记录" }, { status: 400 });
      }

      let rollingRemainingPrincipal = Math.abs(await getLoanBalanceBeforeDate({
        householdId,
        accountId: plan.accountId,
        date: firstRunDate,
      }));
      if (rollingRemainingPrincipal <= 0.005) {
        return NextResponse.json({ ok: false, error: "起始日期前贷款余额已为 0，无法重算历史记录" }, { status: 400 });
      }

      const previousRunDate = previousPrincipalRow?.date ?? plan.startDate;
      let rollingPreviousRunDate = previousRunDate;
      let rollingScheduledAmount = strategy === "reduce_payment"
        ? calcLoanScheduledAmountForPeriodStart({
            repaymentMethod: memo.repaymentMethod,
            baseAnnualRate: memo.annualRate,
            adjustments,
            intervalMonths,
            scheduledAmount: toNumber(plan.amount),
            remainingPrincipal: rollingRemainingPrincipal,
            remainingRuns: remainingRunsAtStart,
            periodStartDate: formatDateUtc(previousRunDate),
          })
        : toNumber(plan.amount);
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
      const interestCategory = await prisma.category.findFirst({
        where: { householdId, type: "expense", name: "利息支出" },
        select: { id: true, name: true },
      });

      const generatedDates: Date[] = [];
      let runDate = firstRunDate;
      let guard = 0;
      while (runDate <= finalRunDate && generatedDates.length < remainingRunsAtStart) {
        generatedDates.push(runDate);
        runDate = calcNextScheduledRunDate(runDate, plan.intervalUnit, plan.intervalValue, plan.executionDay, false);
        guard += 1;
        if (guard > 1200) throw new Error("计划周期异常，已停止重算以避免无限循环");
      }
      if (generatedDates.length === 0) {
        return NextResponse.json({ ok: false, error: "没有可重算的历史期次" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        await tx.txRecord.updateMany({
          where: {
            householdId,
            regularInvestPlanId: plan.id,
            source: "scheduled_task",
            deletedAt: null,
            date: { gte: firstRunDate, lte: finalRunDate },
          },
          data: { deletedAt: new Date() },
        });

        for (const [index, currentRunDate] of generatedDates.entries()) {
          const runDateKey = formatDateUtc(currentRunDate);
          const remainingRunsForThisRun = Math.max(1, remainingRunsAtStart - index);
          const parts = calcLoanRunPartsWithRateAdjustments({
            repaymentMethod: memo.repaymentMethod,
            baseAnnualRate: memo.annualRate,
            adjustments,
            intervalMonths,
            scheduledAmount: rollingScheduledAmount,
            remainingPrincipal: rollingRemainingPrincipal,
            remainingRuns: remainingRunsForThisRun,
            previousRunDate: formatDateUtc(rollingPreviousRunDate),
            runDate: runDateKey,
          });
          rollingScheduledAmount = parts.scheduledAmount;

          if (parts.principal > 0) {
            await tx.txRecord.create({
              data: {
                householdId,
                date: currentRunDate,
                type: TransactionType.transfer,
                accountId: cashAccount.id,
                accountName: cashAccount.name,
                toAccountId: targetAccount.id,
                toAccountName: targetAccount.name,
                amount: -parts.principal,
                source: "scheduled_task",
                regularInvestPlanId: plan.id,
                note: "计划任务：还贷款：本金",
              },
            });
          }
          if (parts.interest > 0) {
            await tx.txRecord.create({
              data: {
                householdId,
                date: currentRunDate,
                type: TransactionType.expense,
                accountId: cashAccount.id,
                accountName: cashAccount.name,
                categoryId: interestCategory?.id ?? null,
                categoryName: interestCategory?.name ?? "利息支出",
                amount: -parts.interest,
                source: "scheduled_task",
                regularInvestPlanId: plan.id,
                note: "计划任务：还贷款：利息",
              },
            });
          }
          rollingRemainingPrincipal = Math.max(0, Math.round((rollingRemainingPrincipal - parts.principal) * 100) / 100);
          rollingPreviousRunDate = currentRunDate;
        }

        await tx.regularInvestPlan.update({
          where: { id: plan.id },
          data: {
            amount: rollingScheduledAmount,
            executedRuns: executedBefore + generatedDates.length,
            lastRunDate: generatedDates[generatedDates.length - 1]!,
            nextRunDate: calcNextScheduledRunDate(
              generatedDates[generatedDates.length - 1]!,
              plan.intervalUnit,
              plan.intervalValue,
              plan.executionDay,
              false,
            ),
            memo: encodeScheduledTaskMemo({ ...memo, loanRateAdjustments: [] }),
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
          regeneratedCount: generatedDates.length,
          startDate: formatDateUtc(firstRunDate),
          endDate: formatDateUtc(generatedDates[generatedDates.length - 1]!),
        },
      });
    }

    if (remainingPrincipal <= 0.005) {
      await prisma.regularInvestPlan.update({
        where: { id: plan.id },
        data: {
          status: RegularInvestStatus.completed,
          endDate: new Date(),
          memo: encodeScheduledTaskMemo({ ...memo, loanRateAdjustments: [] }),
        },
      });
      revalidateAfterTxChange();
      return NextResponse.json({ ok: true, data: { status: "completed", nextAmount: 0, remainingRuns: 0 } });
    }

    if (!remainingRuns || remainingRuns <= 0) {
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
      memo: encodeScheduledTaskMemo({ ...memo, loanRateAdjustments: [] }),
    };

    if (strategy === "reduce_payment") {
      const nextAmount = calcLoanScheduledAmount({
        repaymentMethod: memo.repaymentMethod,
        annualRate: effectiveAnnualRate,
        principal: remainingPrincipal,
        totalRuns: remainingRuns,
        intervalMonths,
      });
      if (!nextAmount || nextAmount <= 0) {
        return NextResponse.json({ ok: false, error: "无法重算月供，请检查利率、剩余本金和剩余期数" }, { status: 400 });
      }
      updateData.amount = nextAmount;
    } else {
      let simulatedPrincipal = remainingPrincipal;
      let simulatedRuns = 0;
      let runDate = recalculateStartDate;
      if (currentAmount <= 0) {
        return NextResponse.json({ ok: false, error: "当前计划金额不正确，无法按月供不变重算" }, { status: 400 });
      }
      const maxRuns = Math.min(Math.max(remainingRuns, 1), 600);
      while (simulatedRuns < maxRuns && simulatedPrincipal > 0.005) {
        const runDateKey = formatDateUtc(runDate);
        const annualRateForRun = getEffectiveLoanAnnualRate({
          baseAnnualRate: memo.annualRate,
          adjustments,
          date: runDateKey,
        });
        const parts = calcLoanRunParts({
          repaymentMethod: memo.repaymentMethod,
          annualRate: annualRateForRun,
          intervalMonths,
          scheduledAmount: currentAmount,
          remainingPrincipal: simulatedPrincipal,
          remainingRuns: Math.max(1, remainingRuns - simulatedRuns),
        });
        if (parts.principal <= 0.005) {
          return NextResponse.json({ ok: false, error: "当前月供不足以冲减本金，无法缩短期限" }, { status: 400 });
        }
        simulatedPrincipal = Math.max(0, Math.round((simulatedPrincipal - parts.principal) * 100) / 100);
        simulatedRuns += 1;
        runDate = calcNextScheduledRunDate(runDate, plan.intervalUnit, plan.intervalValue, plan.executionDay, false);
      }
      if (simulatedPrincipal > 0.005) {
        return NextResponse.json({ ok: false, error: "当前月供在剩余期数内无法还清本金，请改用“期限不变，重算月供”" }, { status: 400 });
      }
      updateData.totalRuns = executedRuns + simulatedRuns;
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
