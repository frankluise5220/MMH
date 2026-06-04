import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { TransactionType, RegularInvestStatus } from "@prisma/client";
import { isWeekend, nextMonday, addDays, addWeeks, addMonths, getDay, setDate } from "date-fns";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundNavFromCacheOnly } from "@/lib/fund/navCache";
import { addWorkdaysUtc, formatDateLocal } from "@/lib/date-utils";

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function skipWeekend(date: Date): Date {
  if (isWeekend(date)) return nextMonday(date);
  return date;
}

/**
 * 调整日期到指定的星期几（用于周/双周模式）
 * @param date 基准日期
 * @param targetDay 目标星期几（1=周一，5=周五）
 * @returns 调整后的日期
 */
function adjustToWeekday(date: Date, targetDay: number): Date {
  const currentDay = getDay(date); // 0=周日，1=周一，..., 6=周六
  // JavaScript的getDay返回0-6，我们需要转换为1-5（周一到周五）
  const adjustedCurrentDay = currentDay === 0 ? 7 : currentDay; // 转换为1-7（周一到周日）
  const diff = targetDay - adjustedCurrentDay;
  return addDays(date, diff);
}

/**
 * 调整日期到每月的指定日期（用于月模式）
 * @param date 基准日期
 * @param targetDayOfMonth 目标日期（1-31）
 * @returns 调整后的日期
 */
function adjustToDayOfMonth(date: Date, targetDayOfMonth: number): Date {
  // 使用date-fns的setDate函数设置日期到指定日期
  return setDate(date, targetDayOfMonth);
}

/**
 * 根据executionDay计算实际执行日期
 * @param fromDate 起始日期
 * @param intervalUnit 间隔单位
 * @param intervalValue 间隔值
 * @param executionDay 执行日（可选）
 * @returns 计算后的执行日期
 */
function calcNextRunDate(
  fromDate: Date,
  intervalUnit: string,
  intervalValue: number,
  executionDay?: number | null
): Date {
  let nextDate: Date;

  switch (intervalUnit) {
    case "day":
      nextDate = addDays(fromDate, intervalValue);
      break;
    case "week":
      nextDate = addWeeks(fromDate, intervalValue);
      if (executionDay && executionDay >= 1 && executionDay <= 5) {
        nextDate = adjustToWeekday(nextDate, executionDay);
      }
      break;
    case "biweek":
      nextDate = addWeeks(fromDate, intervalValue * 2);
      if (executionDay && executionDay >= 1 && executionDay <= 5) {
        nextDate = adjustToWeekday(nextDate, executionDay);
      }
      break;
    case "month":
      nextDate = addMonths(fromDate, intervalValue);
      if (executionDay && executionDay >= 1 && executionDay <= 31) {
        nextDate = adjustToDayOfMonth(nextDate, executionDay);
      }
      break;
    default:
      nextDate = addMonths(fromDate, intervalValue);
  }

  // 如果没有指定executionDay，则跳过周末
  if (!executionDay) {
    nextDate = skipWeekend(nextDate);
  }

  return nextDate;
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

    const fundAcc = await prisma.account.findUnique({ where: { id: plan.accountId } });
    if (!fundAcc) {
      return NextResponse.json({ ok: false, error: "基金账户不存在" }, { status: 400 });
    }

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
        deletedAt: null,
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
        const dateStr = formatDateLocal(tx.date);
        existingDates.add(dateStr);
      }
    }

    const signedAmount = -amountNum;

    // 计算应该执行的日期范围
    let currentDate = skipWeekend(new Date(plan.startDate));
    const datesToExecute: Date[] = [];

    // 生成范围上限：endDate（如果已过期）或 now，取较早者
    const effectiveEndDate = plan.endDate && plan.endDate < now ? plan.endDate : now;

    // 收集所有应该执行但还没有执行的日期
    while (currentDate <= effectiveEndDate) {
      const dateStr = formatDateLocal(currentDate);
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

    // ── 预计算 NAV：避开下一日有净值而本日无净值的间隙日期 ──
    if (plan.skipPendingPreceding !== false) {
      const confirmDays = plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode);
      const navResultMap = new Map<string, { hasNav: boolean; sgzt: string }>();
      for (const d of datesToProcess) {
        const ds = formatDateLocal(d);
        const confirmDateStr = addWorkdaysUtc(ds, confirmDays);
        const foundNav = await getFundNavFromCacheOnly(plan.fundCode, utcDate(confirmDateStr));
        navResultMap.set(ds, {
          hasNav: foundNav != null && foundNav.nav != null && foundNav.nav > 0,
          sgzt: foundNav?.sgzt ?? "",
        });
      }

      const filtered: Date[] = [];
      const arr = datesToProcess;
      const totalBeforeFilter = arr.length;
      for (let i = 0; i < arr.length; i++) {
        const ds = formatDateLocal(arr[i]!);
        const cur = navResultMap.get(ds);
        const noNav = !cur || (!cur.hasNav && cur.sgzt !== "暂停申购");

        // 本日无净值 且 下一日有净值 → 跳过
        if (noNav && i + 1 < arr.length) {
          const nextDs = formatDateLocal(arr[i + 1]!);
          const next = navResultMap.get(nextDs);
          if (next && next.hasNav) continue;
        }
        filtered.push(arr[i]!);
      }
      skippedCount = totalBeforeFilter - filtered.length;
      datesToProcess = filtered;
    }

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
      for (const runDate of datesToProcess) {
        // 计算 T+N 确认日期（使用工作日计算）
        const runDateStr = formatDateLocal(runDate);
        const confirmDays = plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode);
        const confirmDateStr = addWorkdaysUtc(runDateStr, confirmDays);
        const confirmDate = utcDate(confirmDateStr);

        // 从净值缓存库查询确认日期的净值及申购状态
        const foundNav = await getFundNavFromCacheOnly(plan.fundCode, confirmDate);
        const sgzt = foundNav?.sgzt ?? "";

        // 暂停申购：创建两条记录，合计对冲为 0
        // 记录1：定投(暂停申购) — 从资金账户向基金账户，金额 -100
        // 记录2：定投(退回) — 从基金账户往资金账户，金额 -100
        // 资金账户视角：记录1为流出，记录2为流入，对冲为 0
        // 基金账户视角：两条 buy_failed 在持仓计算中跳过，不影响持仓
        if (sgzt === "暂停申购") {
          await tx.txRecord.create({
            data: {
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
              fundNav: null,
              fundUnits: null,
              regularInvestPlanId: planId,
              note: `基金暂停申购 ${plan.fundCode}`,
            },
          });
          await tx.txRecord.create({
            data: {
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
              fundNav: null,
              fundUnits: null,
              regularInvestPlanId: planId,
              note: `基金暂停申购，资金退回 ${plan.fundCode}`,
            },
          });
          continue;
        }

        // 从费率库查询手续费率（按申请日期查询）
        // 费率库存储的是百分数值（0.15 = 0.15%），需除以100转为小数
        const feeRateRaw = await getFundFeeRateByDate(plan.accountId, plan.fundCode, runDate, "buy");
        const feeRate = feeRateRaw / 100;
        const feeAmount = feeRate > 0 ? amountNum * feeRate : null;
        const principal = feeAmount != null ? amountNum - feeAmount : amountNum;

        // 从净值缓存库查找对应确认日期的净值
        let fundNav: number | null = null;
        let fundUnits: number | null = null;

        if (foundNav && foundNav.nav > 0) {
          fundNav = foundNav.nav;
          fundUnits = principal / foundNav.nav;
        }

        // 构建备注：限制大额申购时记录状态提醒用户
        let note = `基金定期定额申购 ${plan.fundCode}`;
        if (sgzt && (sgzt.includes("限制") || sgzt.includes("限额"))) {
          note += `（${sgzt}，请确认定投金额是否超限）`;
        }

        // 创建 TxRecord，直接包含所有基金字段
        await tx.txRecord.create({
          data: {
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
            fundFee: feeAmount,
            fundConfirmDate: confirmDate,
            fundNav: fundNav,
            fundUnits: fundUnits,
            regularInvestPlanId: planId,
            note,
          },
        });
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
    });

    await recalcFundPositions(fundAcc.id, [plan.fundCode]).catch(() => {});
    revalidateAfterInvestChange();

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
      message: `已执行定投 ${plan.fundCode}，生成 ${newRecordsCount} 条交易明细${totalFailedCount > 0 ? `（暂停申购退回 ${totalFailedCount} 笔）` : ""}${skippedCount > 0 ? `（跳过 ${skippedCount} 个无净值间隙日期）` : ""}`,
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