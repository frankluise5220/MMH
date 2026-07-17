import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { TransactionType, RegularInvestStatus, IntervalUnit } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { getFundConfirmDays, getFundArrivalDays, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";
import { getFundFeeRate, getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { getFundNavFromCacheOnly } from "@/lib/fund/navCache";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { REGULAR_INVEST_CATEGORY_NAME, regularInvestBuyNote } from "@/lib/fund/regular-invest-display";
import { addWorkdaysUtc, formatDateUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { decodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import { executeNonFundScheduledTaskPlan, isNonFundScheduledTask } from "@/lib/server/scheduled-task-executor";
import { resolveCategorySnapshot } from "@/lib/default-categories";

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function calcNextRunDate(
  fromDate: Date,
  intervalUnit: string,
  intervalValue: number,
  executionDay?: number | null
): Date {
  return calcNextScheduledRunDate(fromDate, intervalUnit as IntervalUnit, intervalValue, executionDay, true);
}

/**
 * 批量执行定投计划：从开始日期到现在，生成所有到期的交易明细
 * POST /api/v1/regular-invest/batch-execute
 * Body: { planId: string }
 *
 * 防重机制：
 * 1. 查询该定投计划已生成的所有 TxRecord（通过regularInvestPlanId）
 * 2. 获取申请日期
 * 3. 构建已有日期集合
 * 4. 只生成缺失的记录
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const { planId } = body;

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

    if (plan.status !== RegularInvestStatus.active) {
      // 允许已完成但从未执行过的计划补生成记录
      if (plan.status === RegularInvestStatus.completed && plan.executedRuns === 0) {
        // 临时恢复为 active，允许生成记录
        await prisma.regularInvestPlan.update({
          where: { id: planId },
          data: { status: RegularInvestStatus.active },
        });
      } else {
        return NextResponse.json({
          ok: false,
          error: `计划状态为 ${plan.status}，只有 active 状态才能执行`,
        }, { status: 400 });
      }
    }

    const now = new Date();
    // endDate 已过期时仍允许生成历史记录（startDate → endDate），只是生成后标记为完成
    // 不再提前拒绝，避免"已完成但无记录"的情况

    if (plan.totalRuns && plan.executedRuns >= plan.totalRuns) {
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.completed },
      });
      return NextResponse.json({ ok: false, error: "计划已达到执行次数，自动标记为已完成" }, { status: 400 });
    }

    const scheduledTask = decodeScheduledTaskMemo(plan.memo);
    if (isNonFundScheduledTask(scheduledTask.type)) {
      const result = await executeNonFundScheduledTaskPlan({
        householdId,
        plan,
        task: scheduledTask,
        now,
      });
      return NextResponse.json({
        ok: true,
        message: result.message,
        executedCount: result.generatedCount,
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

    const amountNum = parseFloat(String(plan.amount));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    // 防重机制：查询该定投计划已生成的所有 TxRecord
    const existingTxRecords = await prisma.txRecord.findMany({
      where: {
        regularInvestPlanId: planId,
        source: "regular_invest",
      },
      select: {
        id: true,
        date: true,
      },
    });

    // 构建已有交易日期的集合
    const existingDates = new Set<string>();
    for (const tx of existingTxRecords) {
      if (tx.date) {
        const dateStr = formatDateUtc(tx.date);
        existingDates.add(dateStr);
      }
    }

    const signedAmount = -amountNum;

    // 从最近一次已执行日期之后开始（不补充历史）
    let currentDate: Date;
    if (existingTxRecords.length > 0) {
      // 找到最近一条记录的日期，从其后开始
      const latestDate = existingTxRecords.reduce((max, r) => (r.date > max ? r.date : max), new Date(0));
      currentDate = calcNextRunDate(latestDate, plan.intervalUnit, plan.intervalValue, plan.executionDay);
    } else {
      currentDate = calcInitialScheduledRunDate(
        new Date(plan.startDate),
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        true,
      );
    }

    // 生成范围上限：endDate（如果已过期）或 now，取较早者
    const effectiveEndDate = plan.endDate && plan.endDate < now ? plan.endDate : now;

    // 收集所有应该执行但还没有执行的日期
    const datesToExecute: Date[] = [];
    while (currentDate <= effectiveEndDate) {
      const dateStr = formatDateUtc(currentDate);
      if (!existingDates.has(dateStr)) {
        datesToExecute.push(new Date(currentDate));
      }
      currentDate = calcNextRunDate(currentDate, plan.intervalUnit, plan.intervalValue, plan.executionDay);
    }

    if (datesToExecute.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "所有到期的交易明细已存在，无需重复生成",
        executedCount: 0,
      });
    }

    // 计算本次需要生成的记录数（不超过总次数限制）
    const maxToExecute = plan.totalRuns ? plan.totalRuns - plan.executedRuns : datesToExecute.length;
    let datesToProcess = datesToExecute.slice(0, maxToExecute);
    let skippedCount = 0;

    // ── 预计算 NAV：同时过滤暂停申购和无净值间隙 ──
    const confirmDays = normalizeNonNegativeDays(plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode), 0);
    const arrivalDays = normalizeNonNegativeDays(plan.arrivalDays ?? await getFundArrivalDays(plan.accountId, plan.fundCode), 2);
    const todayStr = formatDateUtc(now);
    const navResultMap = new Map<string, { hasNav: boolean; sgzt: string; confirmDateStr: string }>();
    for (const d of datesToProcess) {
      const ds = formatDateUtc(d);
      let confirmDateStr = addWorkdaysUtc(ds, confirmDays);
      if (confirmDateStr < ds) {
        logger.warn(`[pre-calc] confirmDate ${confirmDateStr} < runDate ${ds}, confirmDays=${confirmDays}`, "batch-execute");
        confirmDateStr = ds;
      }
      const foundNav = await getFundNavFromCacheOnly(plan.fundCode, utcDate(confirmDateStr));
      navResultMap.set(ds, {
        hasNav: foundNav != null && foundNav.nav != null && foundNav.nav > 0,
        sgzt: foundNav?.sgzt ?? "",
        confirmDateStr,
      });
    }

    const filtered: Date[] = [];
    const arr = datesToProcess;
    let skippedPaused = 0;
    let skippedGap = 0;
    for (let i = 0; i < arr.length; i++) {
      const ds = formatDateUtc(arr[i]!);
      const cur = navResultMap.get(ds);

      // skipPendingPreceding: 跳过暂停申购 + 历史无净值（假期休市）
      if (plan.skipPendingPreceding !== false) {
        // 跳过暂停申购日期（不生成任何记录）
        if (cur && cur.sgzt === "暂停申购") {
          skippedPaused++;
          continue;
        }

        // 确认日无净值：如果确认日已过且无净值 → 市场休市（假期等），跳过
        // 如果确认日尚未到或为今天 → 净值未公布是正常的，保留（nav=null 后续补填）
        const noNav = !cur || (!cur.hasNav && cur.sgzt !== "暂停申购");
        const confirmDateStr = cur?.confirmDateStr ?? addWorkdaysUtc(ds, confirmDays);
        if (noNav && confirmDateStr < todayStr) {
          skippedGap++;
          continue;
        }
      }
      filtered.push(arr[i]!);
    }
    skippedCount = skippedPaused + skippedGap;
    datesToProcess = filtered;

    const newRecordsCount = datesToProcess.length;

    if (newRecordsCount === 0) {
      return NextResponse.json({
        ok: true,
        message: `所有到期的交易明细已处理${skippedCount > 0 ? `（跳过 ${skippedCount} 个无净值间隙日期）` : ""}`,
        executedCount: 0,
        skippedCount,
      });
    }

    // 净值数据从缓存库读取（前端已先调 /api/v1/fund/preload-nav 扩充了净值库）
    await prisma.$transaction(async (tx) => {
      const changedFundEntryIds: string[] = [];
      for (const runDate of datesToProcess) {
        // 计算 T+N 确认日期（使用工作日计算）
        const runDateStr = formatDateUtc(runDate);
        const confirmDays = normalizeNonNegativeDays(plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode), 0);
        let confirmDateStr = addWorkdaysUtc(runDateStr, confirmDays);
        if (confirmDateStr < runDateStr) {
          logger.warn(`[create] confirmDate ${confirmDateStr} < runDate ${runDateStr}, confirmDays=${confirmDays}`, "batch-execute");
          confirmDateStr = runDateStr;
        }
        const confirmDate = utcDate(confirmDateStr);
        const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDateStr, arrivalDays) : confirmDateStr;
        const arrivalDate = utcDate(arrivalDateStr);

        // 从净值缓存库查询确认日期的净值及申购状态
        const foundNav = await getFundNavFromCacheOnly(plan.fundCode, confirmDate);
        const sgzt = foundNav?.sgzt ?? "";

        // 暂停申购：创建两条记录，合计对冲为 0
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
              amount: -amountNum, // 从资金账户向基金账户 -100
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
              amount: -amountNum, // 从基金账户往资金账户 -100
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
          changedFundEntryIds.push(failedBuy.id, refund.id);
          continue;
        }

        // 从费率库查询手续费率（按申请日期查询）
        // 费率库存储的是百分数值（0.15 = 0.15%），需除以100转为小数
        let feeRateRaw = await getFundFeeRateByDate(plan.accountId, plan.fundCode, runDate, "buy");
        if (feeRateRaw === 0) {
          feeRateRaw = await getFundFeeRate(plan.accountId, plan.fundCode, "buy");
        }
        const feeRate = feeRateRaw / 100;
        const feeAmount = feeRate > 0 ? amountNum * feeRate : null;
        const feeAmountNumber = feeAmount ?? 0;

        // 从净值缓存库查找对应确认日期的净值
        let fundNav: number | null = null;
        let fundUnits: number | null = null;

        if (foundNav && foundNav.nav > 0) {
          fundNav = foundNav.nav;
          fundUnits = calculateConfirmedBuyUnits({
            grossAmount: amountNum,
            refundAmount: 0,
            fee: feeAmountNumber,
            nav: foundNav.nav,
            roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
          });
        }

        // 构建备注：限制大额申购时记录状态提醒用户
        let note = regularInvestBuyNote(plan.fundCode, plan.fundName || plan.fundCode);
        if (sgzt && (sgzt.includes("限制") || sgzt.includes("限额"))) {
          note += `（${sgzt}，请确认定投金额是否超限）`;
        }

        const category = await resolveCategorySnapshot(tx, householdId, {
          categoryName: REGULAR_INVEST_CATEGORY_NAME,
          type: "investment",
        });

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
            amount: signedAmount,
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
            note,
          },
        });
        changedFundEntryIds.push(createdBuy.id);
      }

      // 更新定投计划状态
      const finalExecutedRuns = plan.executedRuns + newRecordsCount;
      const finalLastRunDate = datesToProcess[datesToProcess.length - 1];
      const nextRunDate = calcNextRunDate(finalLastRunDate, plan.intervalUnit, plan.intervalValue, plan.executionDay);

      const willComplete =
        (plan.totalRuns && finalExecutedRuns >= plan.totalRuns) ||
        (plan.endDate && plan.endDate < skipWeekend(nextRunDate));

      await tx.regularInvestPlan.update({
        where: { id: planId },
        data: {
          lastRunDate: finalLastRunDate,
          nextRunDate: skipWeekend(nextRunDate),
          executedRuns: finalExecutedRuns,
          status: willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active,
        },
      });
      await syncFundTransactionsFromTxRecords(changedFundEntryIds, tx);
    });

    await recalcFundPositions(fundAcc.id, [plan.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));

    // 查询更新后的统计数据
    const updatedEntries = await prisma.txRecord.findMany({
      where: {
        regularInvestPlanId: planId,
        source: { in: ["regular_invest", "regular_invest_refund"] },
        deletedAt: null,
      },
      select: { amount: true, fundUnits: true, fundSubtype: true, source: true },
    });

    const totalExecutedCount = updatedEntries.filter((e) => e.fundSubtype !== "buy_failed").length;
    const totalExecutedAmount = updatedEntries.filter((e) => e.fundSubtype !== "buy_failed").reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0);
    const confirmedEntries = updatedEntries.filter((e) => e.fundSubtype !== "buy_failed" && e.fundUnits != null && Number(e.fundUnits) > 0);
    const totalConfirmedCount = confirmedEntries.length;
    const totalConfirmedAmount = confirmedEntries.reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0);
    const failedEntries = updatedEntries.filter((e) => e.fundSubtype === "buy_failed");
    const totalFailedCount = failedEntries.filter((e) => e.source === "regular_invest_refund").length; // 退回记录条数
    const totalFailedAmount = failedEntries.filter((e) => e.source === "regular_invest_refund").reduce((sum, e) => sum + Math.abs(Number(e.amount)), 0); // 退回金额

    const updatedPlan = await prisma.regularInvestPlan.findUnique({
      where: { id: planId },
    });

    return NextResponse.json({
      ok: true,
      message: `已执行基金定投 ${plan.fundCode}，生成 ${newRecordsCount} 条交易明细${totalFailedCount > 0 ? `（暂停申购退回 ${totalFailedCount} 笔）` : ""}${skippedCount > 0 ? `（跳过 ${skippedCount} 个无净值间隙日期）` : ""}`,
      executedCount: newRecordsCount,
      skippedCount,
      completed: plan.totalRuns && plan.executedRuns + newRecordsCount >= plan.totalRuns,
      stats: {
        executedCount: totalExecutedCount,
        executedAmount: totalExecutedAmount,
        confirmedCount: totalConfirmedCount,
        confirmedAmount: totalConfirmedAmount,
        failedCount: totalFailedCount,
        failedRefundAmount: totalFailedAmount,
        plan: updatedPlan ? {
          executedRuns: updatedPlan.executedRuns,
          lastRunDate: updatedPlan.lastRunDate?.toISOString() ?? null,
          nextRunDate: updatedPlan.nextRunDate?.toISOString() ?? null,
          status: updatedPlan.status,
        } : null,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}
