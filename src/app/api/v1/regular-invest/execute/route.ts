import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { Prisma, TransactionType, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays, getFundArrivalDays, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";
import { getFundFeeRate, getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { getFundNavFromCacheOnly } from "@/lib/fund/navCache";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { REGULAR_INVEST_CATEGORY_NAME, regularInvestBuyNote } from "@/lib/fund/regular-invest-display";
import { addWorkdaysUtc, formatDateUtc, startOfDayUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { decodeScheduledTaskMemo, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { calcInitialScheduledRunDate as calcInitialRunDate, calcNextScheduledRunDate as calcNextRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import { executeNonFundScheduledTaskPlan, isNonFundScheduledTask } from "@/lib/server/scheduled-task-executor";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { acquireScheduledTaskPlanLock } from "@/lib/server/scheduled-task-lock";

const SCHEDULED_EXECUTE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
};

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const { planId, overrideDate, overrideAmount } = body;

    if (!planId) {
      return NextResponse.json({ ok: false, error: "缺少 planId" }, { status: 400 });
    }

    const plan = await prisma.regularInvestPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      return NextResponse.json({ ok: false, error: "计划不存在" }, { status: 404 });
    }

    if (plan.householdId && plan.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "计划不属于当前账簿" }, { status: 403 });
    }

    const scheduledTask = decodeScheduledTaskMemo(plan.memo);
    const isNonFundTask = isNonFundScheduledTask(scheduledTask.type);
    const canBackfillCompletedNonFundTask = isNonFundTask && plan.status === RegularInvestStatus.completed && plan.executedRuns === 0;

    // 状态检查：历史转账/还贷/保险缴费计划可能结束日在过去，但仍需要先补生成记录。
    if (plan.status !== RegularInvestStatus.active && !canBackfillCompletedNonFundTask) {
      return NextResponse.json({
        ok: false,
        error: `计划状态为 ${plan.status}，只有 active 状态才能执行`,
      }, { status: 400 });
    }

    // 基金定投按当前日期执行；非基金计划由执行器按 startDate → endDate/today 补生成历史记录。
    const now = new Date();
    if (!isNonFundTask && plan.endDate && plan.endDate < now) {
      // 达到结束日期，自动标记为 completed
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.completed },
      });
      return NextResponse.json({ ok: false, error: "计划已达到结束日期，自动标记为已完成" }, { status: 400 });
    }

    if (plan.totalRuns && plan.executedRuns >= plan.totalRuns) {
      // 达到执行次数，自动标记为 completed
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.completed },
      });
      return NextResponse.json({ ok: false, error: "计划已达到执行次数，自动标记为已完成" }, { status: 400 });
    }

    if (isNonFundTask) {
      const parsedOverrideAmount = overrideAmount ? parseFloat(overrideAmount) : null;
      const result = await executeNonFundScheduledTaskPlan({
        householdId,
        plan,
        task: scheduledTask,
        overrideDate: overrideDate ? new Date(overrideDate) : null,
        overrideAmount: parsedOverrideAmount && Number.isFinite(parsedOverrideAmount) ? parsedOverrideAmount : null,
        now,
      });
      return NextResponse.json({
        ok: true,
        message: result.message,
        date: result.date,
        executedCount: result.generatedCount,
        executedRuns: result.executedRuns,
        completed: result.completed,
        stats: result.stats,
      });
    }

    const fundAcc = await prisma.account.findUnique({ where: { id: plan.accountId } });
    if (!fundAcc) {
      return NextResponse.json({ ok: false, error: "基金账户不存在" }, { status: 400 });
    }
    const fundUnitsDecimals = normalizeFundUnitsDecimals(fundAcc.fundUnitsDecimals);

    const cashAcc = plan.cashAccountId
      ? await prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true } })
      : null;

    const task = decodeScheduledTaskMemo(plan.memo);
    const runDateBase = overrideDate
      ? startOfDayUtc(new Date(overrideDate))
      : task.type === "fund_regular_invest"
        ? startOfDayUtc(new Date())
        : startOfDayUtc(new Date(plan.nextRunDate));
    const runDate = task.type === "fund_regular_invest" ? skipWeekend(runDateBase) : runDateBase;
    const amountNum = overrideAmount ? parseFloat(overrideAmount) : parseFloat(String(plan.amount));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    const usesBusinessDays = task.type === "fund_regular_invest";

    if (task.type !== "fund_regular_invest") {
      if (!cashAcc?.id) {
        return NextResponse.json({ ok: false, error: "计划缺少资金账户" }, { status: 400 });
      }

      const today = startOfDayUtc(now);
      const effectiveEndDate = plan.endDate && startOfDayUtc(plan.endDate) < today ? startOfDayUtc(plan.endDate) : today;
      const sourceFilter = task.type === "insurance_premium" ? ["insurance"] : ["scheduled_task"];
      const existingTxRecords = await prisma.txRecord.findMany({
        where: {
          householdId,
          regularInvestPlanId: planId,
          source: { in: sourceFilter },
          deletedAt: null,
        },
        select: { date: true },
      });
      const existingDates = new Set(existingTxRecords.map((record) => formatDateUtc(record.date)));
      const remainingRuns = plan.totalRuns ? Math.max(0, plan.totalRuns - plan.executedRuns) : Number.POSITIVE_INFINITY;
      const datesToProcess: Date[] = [];

      if (overrideDate) {
        const dateStr = formatDateUtc(runDate);
        if (!existingDates.has(dateStr) && remainingRuns > 0) datesToProcess.push(runDate);
      } else {
        let currentDate = calcInitialRunDate(
          plan.nextRunDate,
          plan.intervalUnit as IntervalUnit,
          plan.intervalValue,
          plan.executionDay,
          false,
        );
        let guard = 0;
        while (currentDate <= effectiveEndDate && datesToProcess.length < remainingRuns) {
          const dateStr = formatDateUtc(currentDate);
          if (!existingDates.has(dateStr)) datesToProcess.push(currentDate);
          currentDate = calcNextRunDate(
            currentDate,
            plan.intervalUnit as IntervalUnit,
            plan.intervalValue,
            plan.executionDay,
            false,
          );
          guard++;
          if (guard > 1200) throw new Error("计划周期异常，已停止生成以避免无限循环");
        }
      }

      if (datesToProcess.length === 0) {
        return NextResponse.json({
          ok: true,
          message: "所有到期的计划记录已存在，无需重复生成",
          executedCount: 0,
          date: formatDateUtc(runDate),
          executedRuns: plan.executedRuns,
          completed: false,
        });
      }

      const insuranceProduct = task.type === "insurance_premium"
        ? await prisma.insuranceProduct.findFirst({
            where: { id: task.insuranceProductId || "", householdId },
          })
        : null;
      if (task.type === "insurance_premium" && !task.insuranceProductId) {
        return NextResponse.json({ ok: false, error: "计划缺少保险产品" }, { status: 400 });
      }
      if (task.type === "insurance_premium" && !insuranceProduct) {
        return NextResponse.json({ ok: false, error: "保险产品不存在" }, { status: 400 });
      }

      const finalLastRunDate = datesToProcess[datesToProcess.length - 1]!;
      const finalExecutedRuns = plan.executedRuns + datesToProcess.length;
      const nextRun = calcNextRunDate(
        finalLastRunDate,
        plan.intervalUnit as IntervalUnit,
        plan.intervalValue,
        plan.executionDay,
        false,
      );
      const willComplete = !!(
        (plan.totalRuns && finalExecutedRuns >= plan.totalRuns) ||
        (plan.endDate && startOfDayUtc(plan.endDate) < nextRun)
      );

      await prisma.$transaction(async (tx) => {
        for (const scheduledRunDate of datesToProcess) {
          if (task.type === "transfer" || task.type === "loan_repayment") {
            await tx.txRecord.create({
              data: {
                householdId,
                type: TransactionType.transfer,
                date: scheduledRunDate,
                accountId: cashAcc.id,
                accountName: cashAcc.name,
                toAccountId: fundAcc.id,
                toAccountName: fundAcc.name,
                amount: -amountNum,
                source: "scheduled_task",
                regularInvestPlanId: planId,
                note: task.type === "loan_repayment" ? "计划任务：还贷款" : "计划任务：转账",
              },
            });
          } else if (task.type === "insurance_premium" && insuranceProduct) {
            await tx.txRecord.create({
              data: {
                householdId,
                type: TransactionType.investment,
                date: scheduledRunDate,
                accountId: cashAcc.id,
                accountName: cashAcc.name,
                toAccountId: insuranceProduct.accountId,
                toAccountName: fundAcc.name,
                amount: -amountNum,
                fundName: insuranceProduct.name,
                fundSubtype: "buy",
                insuranceAction: "premium",
                insuranceProductName: insuranceProduct.name,
                source: "insurance",
                insuranceProductId: insuranceProduct.id,
                regularInvestPlanId: planId,
                note: `计划任务：保险缴费：${insuranceProduct.name}`,
              },
            });
          }
        }

        await tx.regularInvestPlan.update({
          where: { id: planId },
          data: {
            lastRunDate: finalLastRunDate,
            nextRunDate: nextRun,
            executedRuns: finalExecutedRuns,
            status: willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active,
          },
        });
      }, SCHEDULED_EXECUTE_TRANSACTION_OPTIONS);

      await recalcAndSaveAccountBalance(cashAcc.id).catch(logger.catchLog("操作失败", "route.ts"));
      await recalcAndSaveAccountBalance(fundAcc.id).catch(logger.catchLog("操作失败", "route.ts"));
      if (task.type === "insurance_premium") revalidateAfterInvestChange();
      else revalidateAfterTxChange();

      return NextResponse.json({
        ok: true,
        message: `已执行${scheduledTaskTypeLabel(task.type)}，生成 ${datesToProcess.length} 条交易明细，金额 ${amountNum.toFixed(2)}，累计第 ${finalExecutedRuns} 次`,
        date: formatDateUtc(finalLastRunDate),
        executedCount: datesToProcess.length,
        executedRuns: finalExecutedRuns,
        completed: willComplete,
      });
    }

    const newExecutedRuns = plan.executedRuns + 1;
    const nextRun = calcNextRunDate(
      runDate,
      plan.intervalUnit as IntervalUnit,
      plan.intervalValue,
      plan.executionDay,
      usesBusinessDays,
    );

    // 判断执行后是否达到结束条件
    const willComplete =
      (plan.totalRuns && newExecutedRuns >= plan.totalRuns) ||
      (plan.endDate && plan.endDate < nextRun);

    // 事务外预计算，避免把净值、费率、分类查询耗时计入 Prisma 交互式事务。
    const runDateStr = formatDateUtc(runDate);
    const confirmDays = normalizeNonNegativeDays(plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode), 0);
    let confirmDateStr = addWorkdaysUtc(runDateStr, confirmDays);
    if (confirmDateStr < runDateStr) {
      logger.warn(`confirmDate ${confirmDateStr} < runDate ${runDateStr}, confirmDays=${confirmDays}, planId=${planId}`, "execute");
      confirmDateStr = runDateStr;
    }
    const confirmDate = new Date(Date.UTC(
      parseInt(confirmDateStr.slice(0, 4)),
      parseInt(confirmDateStr.slice(5, 7)) - 1,
      parseInt(confirmDateStr.slice(8, 10))
    ));
    const arrivalDays = normalizeNonNegativeDays(plan.arrivalDays ?? await getFundArrivalDays(plan.accountId, plan.fundCode), 2);
    const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDateStr, arrivalDays) : confirmDateStr;
    const arrivalDate = new Date(Date.UTC(
      parseInt(arrivalDateStr.slice(0, 4)),
      parseInt(arrivalDateStr.slice(5, 7)) - 1,
      parseInt(arrivalDateStr.slice(8, 10))
    ));
    const foundNav = await getFundNavFromCacheOnly(plan.fundCode, confirmDate);
    const sgzt = foundNav?.sgzt ?? "";
    let feeRateRaw = await getFundFeeRateByDate(plan.accountId, plan.fundCode, runDate, "buy");
    if (feeRateRaw === 0) {
      feeRateRaw = await getFundFeeRate(plan.accountId, plan.fundCode, "buy");
    }
    const feeRate = feeRateRaw / 100;
    const feeAmountNumber = feeRate > 0 ? amountNum * feeRate : 0;
    const feeAmount = feeAmountNumber > 0 ? new Prisma.Decimal(feeAmountNumber) : null;
    let fundNav: number | null = null;
    let fundUnits: number | null = null;
    const foundNavInfo = await getFundNavFromCacheOnly(plan.fundCode, confirmDate);
    if (foundNavInfo && foundNavInfo.nav > 0) {
      fundNav = foundNavInfo.nav;
      fundUnits = calculateConfirmedBuyUnits({
        grossAmount: amountNum,
        refundAmount: 0,
        fee: feeAmountNumber,
        nav: foundNavInfo.nav,
        roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
      });
    }
    const category = await resolveCategorySnapshot(prisma, householdId, {
      categoryName: REGULAR_INVEST_CATEGORY_NAME,
      type: "investment",
    });

    const result = await prisma.$transaction(async (tx) => {
      await acquireScheduledTaskPlanLock(tx, planId);

      const existingForRunDate = await tx.txRecord.findFirst({
        where: {
          householdId,
          regularInvestPlanId: planId,
          source: "regular_invest",
          deletedAt: null,
          date: runDate,
        },
        select: { id: true },
      });
      if (existingForRunDate) return { skippedDuplicate: true, buyFailed: false };

      // 暂停申购：创建两条对冲记录，合计为 0
      // 记录1：定投(暂停申购) — 从资金账户向基金账户，金额 -100
      // 记录2：定投(退回) — 从基金账户往资金账户，金额 -100
      // 资金账户视角：记录1为流出，记录2为流入，对冲为 0
      // 基金账户视角：两条 buy_failed 在持仓计算中跳过，不影响持仓
      if (sgzt === "暂停申购") {
        const failedBuy = await tx.txRecord.create({
          data: {
            householdId,
            type: TransactionType.investment,
            date: runDate,
            accountId: cashAcc?.id ?? fundAcc.id,
            accountName: cashAcc?.name ?? fundAcc.name,
            toAccountId: fundAcc.id,
            toAccountName: fundAcc.name,
            amount: -amountNum,
            fundCode: plan.fundCode,
            fundName: plan.fundName || plan.fundCode,
            fundProductType: plan.fundProductType || fundAcc.investProductType,
            fundSubtype: "buy_failed",
            source: "regular_invest",
            fundFee: null,
            fundConfirmDate: confirmDate,
            fundArrivalDate: arrivalDate,
            fundNav: null,
            fundUnits: null,
            regularInvestPlanId: planId,
            note: `基金暂停申购 ${plan.fundCode}`,
          },
        });
        const refund = await tx.txRecord.create({
          data: {
            householdId,
            type: TransactionType.investment,
            date: runDate,
            accountId: fundAcc.id,
            accountName: fundAcc.name,
            toAccountId: cashAcc?.id ?? fundAcc.id,
            toAccountName: cashAcc?.name ?? fundAcc.name,
            amount: -amountNum,
            fundCode: plan.fundCode,
            fundName: plan.fundName || plan.fundCode,
            fundProductType: plan.fundProductType || fundAcc.investProductType,
            fundSubtype: "buy_failed",
            source: "regular_invest_refund",
            fundFee: null,
            fundConfirmDate: confirmDate,
            fundArrivalDate: arrivalDate,
            fundNav: null,
            fundUnits: null,
            fundSourceEntryId: failedBuy.id,
            regularInvestPlanId: planId,
            note: `基金暂停申购，资金退回 ${plan.fundCode}`,
          },
        });
        await syncFundTransactionsFromTxRecords([failedBuy.id, refund.id], tx);

        // 更新定投计划（暂停申购也算一次执行）
        await tx.regularInvestPlan.update({
          where: { id: planId },
          data: {
            lastRunDate: runDate,
            nextRunDate: skipWeekend(nextRun),
            executedRuns: newExecutedRuns,
            status: willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active,
          },
        });
        return { buyFailed: true };
      }

      // 创建 TxRecord，直接包含所有基金字段
      const createdBuy = await tx.txRecord.create({
        data: {
          householdId,
          type: TransactionType.investment,
          date: runDate,
          accountId: cashAcc?.id ?? fundAcc.id,
          accountName: cashAcc?.name ?? fundAcc.name,
          toAccountId: fundAcc.id,
          toAccountName: fundAcc.name,
          amount: -amountNum,
          fundCode: plan.fundCode,
          fundName: plan.fundName || plan.fundCode,
          fundProductType: plan.fundProductType || fundAcc.investProductType,
          fundSubtype: "buy",
          source: "regular_invest",
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? REGULAR_INVEST_CATEGORY_NAME,
          fundFee: feeAmount,
          fundConfirmDate: confirmDate,
          fundArrivalDate: arrivalDate,
          fundNav: fundNav,
          fundUnits: fundUnits,
          regularInvestPlanId: planId,
          note: regularInvestBuyNote(plan.fundCode, plan.fundName || plan.fundCode),
        },
      });
      await syncFundTransactionsFromTxRecords([createdBuy.id], tx);

      // 更新定投计划
      await tx.regularInvestPlan.update({
        where: { id: planId },
        data: {
          lastRunDate: runDate,
          nextRunDate: skipWeekend(nextRun),
          executedRuns: newExecutedRuns,
          status: willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active,
        },
      });

      return { buyFailed: false };
    }, SCHEDULED_EXECUTE_TRANSACTION_OPTIONS);

    if (result.skippedDuplicate) {
      return NextResponse.json({
        ok: true,
        message: "该执行日期的交易明细已存在，无需重复生成",
        date: formatDateUtc(runDate),
        executedRuns: plan.executedRuns,
        completed: false,
        executedCount: 0,
      });
    }

    await recalcFundPositions(fundAcc.id, [plan.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));
    // 刷新涉及的账户余额（资金账户和投资账户）
    if (cashAcc?.id) await recalcAndSaveAccountBalance(cashAcc.id).catch(logger.catchLog("操作失败", "route.ts"));
    await recalcAndSaveAccountBalance(fundAcc.id).catch(logger.catchLog("操作失败", "route.ts"));
    revalidateAfterInvestChange();

    // Client-side handles page refresh via mmh:fund:refresh

    if (result.buyFailed) {
      return NextResponse.json({
        ok: true,
        buyFailed: true,
        message: `基金暂停申购 ${plan.fundCode}，已生成两条对冲记录，金额 ${amountNum.toFixed(2)}，第 ${newExecutedRuns} 次`,
        date: formatDateUtc(runDate),
        executedRuns: newExecutedRuns,
        completed: willComplete,
      });
    }

    return NextResponse.json({
      ok: true,
      message: `已执行基金定投 ${plan.fundCode}，金额 ${amountNum.toFixed(2)}，第 ${newExecutedRuns} 次`,
      date: formatDateUtc(runDate),
      executedRuns: newExecutedRuns,
      completed: willComplete,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}
