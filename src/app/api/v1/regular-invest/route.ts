import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { IntervalUnit, TransactionType, RegularInvestStatus } from "@prisma/client";
import { addDays, addWeeks, addMonths, isWeekend, nextMonday } from "date-fns";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { normalizeNonNegativeDays, setFundConfirmDays, setFundConfirmDaysInTx, setFundArrivalDays, setFundArrivalDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRate, setFundFeeRateInTx } from "@/lib/fund/feeRate";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";

function skipWeekend(date: Date): Date {
  if (isWeekend(date)) return nextMonday(date);
  return date;
}

function calcNextRunDate(
  fromDate: Date,
  unit: IntervalUnit,
  value: number,
  executionDay?: number | null
): Date {
  let nextDate: Date;

  switch (unit) {
    case "day":
      nextDate = addDays(fromDate, value);
      break;
    case "week":
      nextDate = addWeeks(fromDate, value);
      break;
    case "biweek":
      nextDate = addWeeks(fromDate, value * 2);
      break;
    case "month":
      nextDate = addMonths(fromDate, value);
      break;
    default:
      nextDate = addMonths(fromDate, value);
  }

  // 如果指定了执行日，调整到指定日期
  if (executionDay != null) {
    if (unit === "month" && executionDay >= 1 && executionDay <= 31) {
      // 月模式：调整到每月指定号数
      const daysInMonth = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, 0).getDate();
      const targetDay = Math.min(executionDay, daysInMonth);
      nextDate = new Date(nextDate.getFullYear(), nextDate.getMonth(), targetDay);
    } else if ((unit === "week" || unit === "biweek") && executionDay >= 1 && executionDay <= 5) {
      // 周/双周模式：调整到指定星期几（1=周一，5=周五）
      const currentDay = nextDate.getDay(); // 0=周日，6=周六
      const adjustedCurrentDay = currentDay === 0 ? 7 : currentDay; // 转换为1-7
      const diff = executionDay - adjustedCurrentDay;
      nextDate = addDays(nextDate, diff);
    }
  }

  // 跳过周末
  if (isWeekend(nextDate)) {
    nextDate = nextMonday(nextDate);
  }

  return nextDate;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
    const accountId = req.nextUrl.searchParams.get("accountId");
    const status = req.nextUrl.searchParams.get("status") as RegularInvestStatus | null;

    const plans = await prisma.regularInvestPlan.findMany({
      where: {
        ...hidFilter,
        ...(accountId ? { accountId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        Account_RegularInvestPlan_accountIdToAccount: {
          include: { Institution: { select: { name: true } } },
        },
        Account_RegularInvestPlan_cashAccountIdToAccount: {
          include: { Institution: { select: { name: true } } },
        },
      },
      orderBy: { nextRunDate: "asc" },
    });

    return NextResponse.json({
      ok: true,
      plans: plans.map((plan) => ({
        ...plan,
        accountInstitutionName: plan.Account_RegularInvestPlan_accountIdToAccount.Institution?.name ?? "",
        cashAccountInstitutionName: plan.Account_RegularInvestPlan_cashAccountIdToAccount?.Institution?.name ?? "",
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const {
      accountId,
      cashAccountId,
      fundCode,
      fundName,
      fundProductType,
      amount,
      intervalUnit = "month" as IntervalUnit,
      intervalValue = 1,
      startDate,
      endDate,
      totalRuns,
      executionDay,
      feeRate,
      confirmDays,
      arrivalDays,
      memo,
      skipPendingPreceding,
    } = body;

    if (!accountId || !fundCode || !amount || !startDate) {
      return NextResponse.json({ ok: false, error: "缺少必填字段" }, { status: 400 });
    }

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    const fundAcc = await prisma.account.findUnique({ where: { id: accountId } });
    if (!fundAcc) return NextResponse.json({ ok: false, error: "基金账户不存在" }, { status: 400 });
    if (fundAcc.householdId !== householdId) return NextResponse.json({ ok: false, error: "基金账户不属于当前账簿" }, { status: 403 });

    const cashAcc = cashAccountId
      ? await prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, householdId: true } })
      : null;
    if (cashAcc && cashAcc.householdId !== householdId) return NextResponse.json({ ok: false, error: "资金账户不属于当前账簿" }, { status: 403 });

    const start = skipWeekend(new Date(startDate));
    const unitVal = parseInt(intervalValue) || 1;
    const now = new Date();
    const totalRunsInt = totalRuns ? parseInt(totalRuns) : null;
    const executionDayInt = executionDay ? parseInt(executionDay) : null;

    const safeConfirmDays = confirmDays != null ? normalizeNonNegativeDays(confirmDays, 0) : null;
    const safeArrivalDays = arrivalDays != null ? normalizeNonNegativeDays(arrivalDays, 2) : null;

    await prisma.$transaction(async (tx) => {
      const plan = await tx.regularInvestPlan.create({
        data: {
          householdId,
          accountId,
          accountName: fundAcc.name,
          cashAccountId: cashAccountId || null,
          cashAccountName: cashAcc?.name || null,
          fundCode,
          fundName: fundName || fundCode,
          fundProductType: fundProductType || fundAcc.investProductType || null,
          amount: amountNum,
          intervalUnit,
          intervalValue: unitVal,
          executionDay: executionDayInt,
          startDate: start,
          endDate: endDate ? new Date(endDate) : null,
          totalRuns: totalRunsInt,
          executedRuns: 0,
          nextRunDate: start,
          status: RegularInvestStatus.active,
          feeRate: feeRate != null ? parseFloat(feeRate) : null,
          confirmDays: safeConfirmDays,
          arrivalDays: safeArrivalDays,
          memo: memo || null,
          skipPendingPreceding: skipPendingPreceding !== false,
        },
      });

      // 更新确认天数表
      const newDays = safeConfirmDays ?? 0;
      if (accountId && fundCode) {
        await setFundConfirmDaysInTx(tx, accountId, fundCode, newDays);
      }

      // 更新手续费率表
      const newRate = feeRate != null ? parseFloat(feeRate) : 0;
      if (accountId && fundCode) {
        await setFundFeeRateInTx(tx, accountId, fundCode, newRate);
      }

      // 更新入账天数表
      const newArrivalDays = safeArrivalDays ?? 2;
      if (accountId && fundCode) {
        await setFundArrivalDaysInTx(tx, accountId, fundCode, newArrivalDays);
      }

      // 不预生成交易明细，等用户点击"批量生成"按钮后再生成
      return plan;
    });

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      message: "定投计划已创建，请点击批量生成按钮生成交易明细",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const {
      id,
      action,
      fundName,
      accountId,
      amount,
      intervalUnit,
      intervalValue,
      startDate,
      nextRunDate,
      endDate,
      totalRuns,
      executionDay,
      feeRate,
      confirmDays,
      arrivalDays,
      cashAccountId,
      memo,
      skipPendingPreceding,
    } = body;

    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const existing = await prisma.regularInvestPlan.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, error: "计划不存在" }, { status: 404 });
    if (existing.householdId && existing.householdId !== householdId) return NextResponse.json({ ok: false, error: "计划不属于当前账簿" }, { status: 403 });

    // 状态操作
    if (action === "pause") {
      if (existing.status !== RegularInvestStatus.active) {
        return NextResponse.json({ ok: false, error: "只有活跃状态的计划才能暂停" }, { status: 400 });
      }
      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: { status: RegularInvestStatus.paused },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "定投计划已暂停" });
    }

    if (action === "resume") {
      if (existing.status !== RegularInvestStatus.paused) {
        return NextResponse.json({ ok: false, error: "只有暂停状态的计划才能恢复" }, { status: 400 });
      }
      // 恢复时重新计算下次执行日期（从当前日期或上次执行日期开始）
      const now = new Date();
      const nextRun = existing.lastRunDate
        ? calcNextRunDate(existing.lastRunDate, existing.intervalUnit, existing.intervalValue)
        : existing.nextRunDate;
      const actualNextRun = nextRun < now ? calcNextRunDate(now, existing.intervalUnit, existing.intervalValue) : nextRun;

      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: {
          status: RegularInvestStatus.active,
          nextRunDate: skipWeekend(actualNextRun),
        },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "定投计划已恢复" });
    }

    if (action === "stop") {
      if (existing.status === RegularInvestStatus.stopped || existing.status === RegularInvestStatus.completed) {
        return NextResponse.json({ ok: false, error: "计划已终止或已完成" }, { status: 400 });
      }
      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: { status: RegularInvestStatus.stopped },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "定投计划已终止" });
    }

    // 普通更新
    const updateData: any = {};

    if (accountId != null) {
      updateData.accountId = accountId;
      const fundAcc = await prisma.account.findUnique({ where: { id: accountId }, select: { name: true } });
      updateData.accountName = fundAcc?.name || null;
    }
    if (startDate != null) updateData.startDate = skipWeekend(new Date(startDate));
    if (fundName != null) updateData.fundName = fundName;
    if (amount != null) updateData.amount = parseFloat(amount);
    if (intervalUnit) updateData.intervalUnit = intervalUnit;
    if (intervalValue != null) updateData.intervalValue = parseInt(intervalValue);
    if (executionDay != null) updateData.executionDay = executionDay ? parseInt(executionDay) : null; // 执行日更新
    if (nextRunDate) updateData.nextRunDate = new Date(nextRunDate);
    if (endDate != null) updateData.endDate = endDate ? new Date(endDate) : null;
    if (totalRuns != null) updateData.totalRuns = totalRuns ? parseInt(totalRuns) : null;
    if (feeRate != null) updateData.feeRate = parseFloat(feeRate);
    if (confirmDays != null) updateData.confirmDays = normalizeNonNegativeDays(confirmDays, 0);
    if (arrivalDays != null) updateData.arrivalDays = normalizeNonNegativeDays(arrivalDays, 2);
    if (cashAccountId != null) {
      updateData.cashAccountId = cashAccountId || null;
      // 更新资金账户名称
      if (cashAccountId) {
        const cashAcc = await prisma.account.findUnique({ where: { id: cashAccountId }, select: { name: true } });
        updateData.cashAccountName = cashAcc?.name || null;
      } else {
        updateData.cashAccountName = null;
      }
    }
    if (memo != null) updateData.memo = memo || null;
    if (skipPendingPreceding !== undefined) (updateData as any).skipPendingPreceding = skipPendingPreceding;

    const plan = await prisma.regularInvestPlan.update({
      where: { id },
      data: updateData,
    });

    // 同步确认天数和费率到统一库
    const effectiveAccountId = accountId || existing.accountId;
    const effectiveFundCode = existing.fundCode;
    if (confirmDays != null && effectiveAccountId && effectiveFundCode) {
      await setFundConfirmDays(effectiveAccountId, effectiveFundCode, normalizeNonNegativeDays(confirmDays, 0));
    }
    if (arrivalDays != null && effectiveAccountId && effectiveFundCode) {
      await setFundArrivalDays(effectiveAccountId, effectiveFundCode, normalizeNonNegativeDays(arrivalDays, 2));
    }
    if (feeRate != null && effectiveAccountId && effectiveFundCode) {
      await setFundFeeRate(effectiveAccountId, effectiveFundCode, parseFloat(feeRate));
    }

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, plan });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "更新失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const { searchParams } = req.nextUrl;
    const id = searchParams.get("id");
    const deleteMode = searchParams.get("deleteRecords") ?? "0";
    const deleteEntries = deleteMode === "1";
    const deleteRecordsOnly = deleteMode === "records";

    if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

    const plan = await prisma.regularInvestPlan.findUnique({ where: { id } });
    if (!plan) return NextResponse.json({ ok: false, error: "计划不存在" }, { status: 404 });
    if (plan.householdId && plan.householdId !== householdId) return NextResponse.json({ ok: false, error: "计划不属于当前账簿" }, { status: 403 });

    // 仅删除交易记录，保留计划，并把计划恢复为未执行状态
    if (deleteRecordsOnly) {
      const affectedRecords = await prisma.txRecord.findMany({
        where: { regularInvestPlanId: id, householdId },
        select: { accountId: true, toAccountId: true },
      });
      const resetPlan = await prisma.$transaction(async (tx) => {
        await tx.txRecord.deleteMany({ where: { regularInvestPlanId: id, householdId } });
        return tx.regularInvestPlan.update({
          where: { id },
          data: {
            status: RegularInvestStatus.active,
            executedRuns: 0,
            lastRunDate: null,
            nextRunDate: plan.startDate,
          },
          select: {
            id: true,
            status: true,
            executedRuns: true,
            lastRunDate: true,
            nextRunDate: true,
          },
        });
      });

      const accountsToRecalc = new Set<string>();
      accountsToRecalc.add(plan.accountId);
      if (plan.cashAccountId) accountsToRecalc.add(plan.cashAccountId);
      for (const r of affectedRecords) {
        if (r.accountId) accountsToRecalc.add(r.accountId);
        if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
      }
      if (plan.accountId && plan.fundCode) {
        await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
      }
      for (const acctId of accountsToRecalc) {
        if (acctId) await recalcAndSaveAccountBalance(acctId).catch(() => {});
      }
      // Client-side handles page refresh
      return NextResponse.json({
        ok: true,
        deletedEntries: true,
        reset: true,
        plan: {
          ...resetPlan,
          lastRunDate: resetPlan.lastRunDate?.toISOString() ?? null,
          nextRunDate: resetPlan.nextRunDate.toISOString(),
        },
      });
    }

    // 如果删除了交易明细，先收集涉及的账户ID（事务后记录已被删除）
    const affectedRecords = deleteEntries
      ? await prisma.txRecord.findMany({
          where: { regularInvestPlanId: id },
          select: { accountId: true, toAccountId: true },
        })
      : [];
    const accountsToRecalc = new Set<string>();
    accountsToRecalc.add(plan.accountId);
    if (plan.cashAccountId) accountsToRecalc.add(plan.cashAccountId);
    for (const r of affectedRecords) {
      if (r.accountId) accountsToRecalc.add(r.accountId);
      if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
    }

    // 如果要求删除关联的交易明细
    if (deleteEntries) {
      await prisma.$transaction(async (tx) => {
        // 先删除关联的 TxRecord
        await tx.txRecord.deleteMany({
          where: { regularInvestPlanId: id },
        });
        // 再删除定投计划
        await tx.regularInvestPlan.delete({ where: { id } });
      });
    } else {
      // 仅删除定投计划，保留交易明细（但清除关联）
      await prisma.$transaction(async (tx) => {
        // 清除交易明细的关联字段
        await tx.txRecord.updateMany({
          where: { regularInvestPlanId: id },
          data: { regularInvestPlanId: null },
        });
        // 删除定投计划
        await tx.regularInvestPlan.delete({ where: { id } });
      });
    }

    if (plan.accountId && plan.fundCode) {
      await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
    }

    // 刷新涉及的账户余额
    for (const acctId of accountsToRecalc) {
      if (acctId) await recalcAndSaveAccountBalance(acctId).catch(() => {});
    }

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, deletedEntries: deleteEntries });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}
