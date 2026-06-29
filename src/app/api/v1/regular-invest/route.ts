import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { normalizeNonNegativeDays, setFundConfirmDays, setFundConfirmDaysInTx, setFundArrivalDays, setFundArrivalDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRate, setFundFeeRateInTx } from "@/lib/fund/feeRate";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { calcInitialScheduledRunDate as calcInitialRunDate, calcNextScheduledRunDate as calcNextRunDate, skipWeekend } from "@/lib/scheduled-task-date";

export async function GET(req: NextRequest) {
  try {
    const { hidFilter } = await getHouseholdScope();
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
      taskType = "fund_regular_invest",
      insuranceProductId,
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
      skipPendingPreceding,
    } = body;

    const scheduledTaskType = normalizeScheduledTaskType(taskType);
    const isFundTask = scheduledTaskType === "fund_regular_invest";

    if (!accountId || !amount || !startDate || (isFundTask && !fundCode)) {
      return NextResponse.json({ ok: false, error: "缺少必填字段" }, { status: 400 });
    }

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    const targetAcc = await prisma.account.findUnique({ where: { id: accountId } });
    if (!targetAcc) return NextResponse.json({ ok: false, error: "目标账户不存在" }, { status: 400 });
    if (targetAcc.householdId !== householdId) return NextResponse.json({ ok: false, error: "目标账户不属于当前账簿" }, { status: 403 });

    const cashAcc = cashAccountId
      ? await prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, householdId: true } })
      : null;
    if (cashAcc && cashAcc.householdId !== householdId) return NextResponse.json({ ok: false, error: "资金账户不属于当前账簿" }, { status: 403 });

    const unitVal = parseInt(intervalValue) || 1;
    const totalRunsInt = totalRuns ? parseInt(totalRuns) : null;
    const executionDayInt = executionDay ? parseInt(executionDay) : null;
    const intervalUnitValue = intervalUnit as IntervalUnit;
    const start = isFundTask ? skipWeekend(new Date(startDate)) : new Date(startDate);
    const initialRunDate = calcInitialRunDate(new Date(startDate), intervalUnitValue, unitVal, executionDayInt, isFundTask);

    const safeConfirmDays = confirmDays != null ? normalizeNonNegativeDays(confirmDays, 0) : null;
    const safeArrivalDays = arrivalDays != null ? normalizeNonNegativeDays(arrivalDays, 2) : null;

    await prisma.$transaction(async (tx) => {
      const plan = await tx.regularInvestPlan.create({
        data: {
          householdId,
          accountId,
          accountName: targetAcc.name,
          cashAccountId: cashAccountId || null,
          cashAccountName: cashAcc?.name || null,
          fundCode: isFundTask ? fundCode : scheduledTaskType,
          fundName: fundName || (isFundTask ? fundCode : scheduledTaskTypeLabel(scheduledTaskType)),
          fundProductType: isFundTask ? (fundProductType || targetAcc.investProductType || null) : null,
          amount: amountNum,
          intervalUnit: intervalUnitValue,
          intervalValue: unitVal,
          executionDay: executionDayInt,
          startDate: start,
          endDate: endDate ? new Date(endDate) : null,
          totalRuns: totalRunsInt,
          executedRuns: 0,
          nextRunDate: initialRunDate,
          status: RegularInvestStatus.active,
          feeRate: feeRate != null ? parseFloat(feeRate) : null,
          confirmDays: safeConfirmDays,
          arrivalDays: safeArrivalDays,
          memo: encodeScheduledTaskMemo({
            type: scheduledTaskType,
            title: fundName || (isFundTask ? fundCode : scheduledTaskTypeLabel(scheduledTaskType)),
            fromAccountId: cashAccountId || null,
            toAccountId: accountId,
            insuranceProductId: insuranceProductId || null,
          }),
          skipPendingPreceding: isFundTask ? skipPendingPreceding !== false : false,
        },
      });

      // 更新确认天数表
      const newDays = safeConfirmDays ?? 0;
      if (isFundTask && accountId && fundCode) {
        await setFundConfirmDaysInTx(tx, accountId, fundCode, newDays);
      }

      // 更新手续费率表
      const newRate = feeRate != null ? parseFloat(feeRate) : 0;
      if (isFundTask && accountId && fundCode) {
        await setFundFeeRateInTx(tx, accountId, fundCode, newRate);
      }

      // 更新入账天数表
      const newArrivalDays = safeArrivalDays ?? 2;
      if (isFundTask && accountId && fundCode) {
        await setFundArrivalDaysInTx(tx, accountId, fundCode, newArrivalDays);
      }

      // 不预生成交易明细，等用户点击"批量生成"按钮后再生成
      return plan;
    });

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      message: "计划任务已创建，请点击执行按钮生成到期交易明细",
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
      taskType,
      insuranceProductId,
      fundCode,
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
    const existingTaskForAction = decodeScheduledTaskMemo(existing.memo);
    const actionUsesBusinessDays = existingTaskForAction.type === "fund_regular_invest";

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
      return NextResponse.json({ ok: true, plan, message: "计划任务已暂停" });
    }

    if (action === "resume") {
      if (existing.status !== RegularInvestStatus.paused) {
        return NextResponse.json({ ok: false, error: "只有暂停状态的计划才能恢复" }, { status: 400 });
      }
      // 恢复时重新计算下次执行日期（从当前日期或上次执行日期开始）
      const now = new Date();
      const nextRun = existing.lastRunDate
        ? calcNextRunDate(existing.lastRunDate, existing.intervalUnit, existing.intervalValue, existing.executionDay, actionUsesBusinessDays)
        : calcInitialRunDate(existing.startDate, existing.intervalUnit, existing.intervalValue, existing.executionDay, actionUsesBusinessDays);
      const actualNextRun = nextRun < now
        ? calcInitialRunDate(now, existing.intervalUnit, existing.intervalValue, existing.executionDay, actionUsesBusinessDays)
        : nextRun;

      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: {
          status: RegularInvestStatus.active,
          nextRunDate: actualNextRun,
        },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "计划任务已恢复" });
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
      return NextResponse.json({ ok: true, plan, message: "计划任务已终止" });
    }

    // 普通更新
    const updateData: any = {};
    const existingTask = decodeScheduledTaskMemo(existing.memo);
    const nextTaskType = normalizeScheduledTaskType(taskType || existingTask.type);
    const isFundTask = nextTaskType === "fund_regular_invest";

    if (accountId != null) {
      updateData.accountId = accountId;
      const fundAcc = await prisma.account.findUnique({ where: { id: accountId }, select: { name: true } });
      updateData.accountName = fundAcc?.name || null;
    }
    const effectiveStartDate = startDate != null ? new Date(startDate) : existing.startDate;
    const effectiveIntervalUnit = (intervalUnit || existing.intervalUnit) as IntervalUnit;
    const effectiveIntervalValue = intervalValue != null ? parseInt(intervalValue) || 1 : existing.intervalValue;
    const effectiveExecutionDay = executionDay != null
      ? (executionDay ? parseInt(executionDay) : null)
      : existing.executionDay;

    if (startDate != null) updateData.startDate = isFundTask ? skipWeekend(new Date(startDate)) : new Date(startDate);
    if (fundCode != null && isFundTask) updateData.fundCode = fundCode;
    if (fundName != null) updateData.fundName = fundName;
    if (amount != null) updateData.amount = parseFloat(amount);
    if (intervalUnit) updateData.intervalUnit = intervalUnit;
    if (intervalValue != null) updateData.intervalValue = parseInt(intervalValue);
    if (executionDay != null) updateData.executionDay = executionDay ? parseInt(executionDay) : null; // 执行日更新
    if (nextRunDate) {
      updateData.nextRunDate = new Date(nextRunDate);
    } else if (startDate != null || intervalUnit || intervalValue != null || executionDay != null || taskType) {
      updateData.nextRunDate = calcInitialRunDate(
        effectiveStartDate,
        effectiveIntervalUnit,
        effectiveIntervalValue,
        effectiveExecutionDay,
        isFundTask,
      );
    }
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
    updateData.memo = encodeScheduledTaskMemo({
      type: nextTaskType,
      title: fundName || existing.fundName || scheduledTaskTypeLabel(nextTaskType),
      fromAccountId: cashAccountId != null ? cashAccountId || null : existing.cashAccountId,
      toAccountId: accountId || existing.accountId,
      insuranceProductId: insuranceProductId || existingTask.insuranceProductId || null,
    });
    if (!isFundTask) {
      updateData.fundCode = nextTaskType;
      updateData.fundProductType = null;
      updateData.confirmDays = 0;
      updateData.arrivalDays = 0;
      updateData.feeRate = 0;
      updateData.skipPendingPreceding = false;
    }

    const plan = await prisma.regularInvestPlan.update({
      where: { id },
      data: updateData,
    });

    // 同步确认天数和费率到统一库
    const effectiveAccountId = accountId || existing.accountId;
    const effectiveFundCode = fundCode || existing.fundCode;
    if (isFundTask && confirmDays != null && effectiveAccountId && effectiveFundCode) {
      await setFundConfirmDays(effectiveAccountId, effectiveFundCode, normalizeNonNegativeDays(confirmDays, 0));
    }
    if (isFundTask && arrivalDays != null && effectiveAccountId && effectiveFundCode) {
      await setFundArrivalDays(effectiveAccountId, effectiveFundCode, normalizeNonNegativeDays(arrivalDays, 2));
    }
    if (isFundTask && feeRate != null && effectiveAccountId && effectiveFundCode) {
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
      const task = decodeScheduledTaskMemo(plan.memo);
      const resetNextRunDate = calcInitialRunDate(
        plan.startDate,
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        task.type === "fund_regular_invest",
      );
      const resetPlan = await prisma.$transaction(async (tx) => {
        await tx.txRecord.deleteMany({ where: { regularInvestPlanId: id, householdId } });
        return tx.regularInvestPlan.update({
          where: { id },
          data: {
            status: RegularInvestStatus.active,
            executedRuns: 0,
            lastRunDate: null,
            nextRunDate: resetNextRunDate,
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
      if (task.type === "fund_regular_invest" || task.type === "insurance_premium") revalidateAfterInvestChange();
      else revalidateAfterTxChange();
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
    const task = decodeScheduledTaskMemo(plan.memo);
    if (deleteEntries) {
      if (task.type === "fund_regular_invest" || task.type === "insurance_premium") revalidateAfterInvestChange();
      else revalidateAfterTxChange();
    }

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, deletedEntries: deleteEntries });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}
