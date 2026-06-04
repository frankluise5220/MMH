import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { Prisma, TransactionType, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { isWeekend, nextMonday, addDays, addWeeks, addMonths } from "date-fns";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundNav, getFundNavFromCacheOnly } from "@/lib/fund/navCache";
import { addWorkdaysUtc, formatDateLocal } from "@/lib/date-utils";

function skipWeekend(date: Date): Date {
  if (isWeekend(date)) return nextMonday(date);
  return date;
}

function calcNextRunDate(fromDate: Date, unit: IntervalUnit, value: number): Date {
  switch (unit) {
    case "day": return addDays(fromDate, value);
    case "week": return addWeeks(fromDate, value);
    case "biweek": return addWeeks(fromDate, value * 2);
    case "month": return addMonths(fromDate, value);
    default: return addMonths(fromDate, value);
  }
}

export async function POST(req: NextRequest) {
  try {
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

    // 状态检查：只有 active 状态才能执行
    if (plan.status !== RegularInvestStatus.active) {
      return NextResponse.json({
        ok: false,
        error: `计划状态为 ${plan.status}，只有 active 状态才能执行`,
      }, { status: 400 });
    }

    // 结束条件检查
    const now = new Date();
    if (plan.endDate && plan.endDate < now) {
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

    const fundAcc = await prisma.account.findUnique({ where: { id: plan.accountId } });
    if (!fundAcc) {
      return NextResponse.json({ ok: false, error: "基金账户不存在" }, { status: 400 });
    }

    const cashAcc = plan.cashAccountId
      ? await prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true } })
      : null;

    const runDate = skipWeekend(overrideDate ? new Date(overrideDate) : new Date());
    const amountNum = overrideAmount ? parseFloat(overrideAmount) : parseFloat(String(plan.amount));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    const newExecutedRuns = plan.executedRuns + 1;

    // 判断执行后是否达到结束条件
    const willComplete =
      (plan.totalRuns && newExecutedRuns >= plan.totalRuns) ||
      (plan.endDate && plan.endDate < calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue));

    const result = await prisma.$transaction(async (tx) => {
      // 计算 T+N 确认日期
      const runDateStr = formatDateLocal(runDate);
      const confirmDays = plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode);
      const confirmDateStr = addWorkdaysUtc(runDateStr, confirmDays);
      const confirmDate = new Date(Date.UTC(
        parseInt(confirmDateStr.slice(0, 4)),
        parseInt(confirmDateStr.slice(5, 7)) - 1,
        parseInt(confirmDateStr.slice(8, 10))
      ));

      // 从净值缓存库查询确认日期的申购状态
      const foundNav = await getFundNavFromCacheOnly(plan.fundCode, confirmDate);
      const sgzt = foundNav?.sgzt ?? "";

      // 暂停申购：创建两条对冲记录，合计为 0
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
            amount: -amountNum,
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
            amount: -amountNum,
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

        // 更新定投计划（暂停申购也算一次执行）
        const nextRun = calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue);
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

      // 从费率库查询手续费率（按申请日期查询）
      // 费率库存储的是百分数值（0.15 = 0.15%），需除以100转为小数
      const feeRateRaw = await getFundFeeRateByDate(plan.accountId, plan.fundCode, runDate, "buy");
      const feeRate = feeRateRaw / 100;
      const feeAmount = feeRate > 0 ? new Prisma.Decimal(amountNum * feeRate) : null;
      const principal = feeRate > 0 ? amountNum * (1 - feeRate) : amountNum;

      // 查询确认日净值（先查缓存，缓存没有则调API查并写回缓存）
      // 只有净值日期与确认日期一致（dateMatch=true）时才计算份额
      let fundNav: number | null = null;
      let fundUnits: number | null = null;
      try {
        const navData = await getFundNav(plan.fundCode, confirmDate);
        if (navData && navData.nav > 0 && navData.dateMatch) {
          fundNav = navData.nav;
          fundUnits = principal / navData.nav;
        }
      } catch {
        // 获取净值失败
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
          amount: -amountNum,
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
          note: `基金定期定额申购 ${plan.fundCode}`,
        },
      });

      // 更新定投计划
      const nextRun = calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue);
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
    });

    await recalcFundPositions(fundAcc.id, [plan.fundCode]).catch(() => {});
    // 刷新涉及的账户余额（资金账户和投资账户）
    if (cashAcc?.id) await recalcAndSaveAccountBalance(cashAcc.id).catch(() => {});
    await recalcAndSaveAccountBalance(fundAcc.id).catch(() => {});

    revalidateAfterInvestChange();

    if (result.buyFailed) {
      return NextResponse.json({
        ok: true,
        buyFailed: true,
        message: `基金暂停申购 ${plan.fundCode}，已生成两条对冲记录，金额 ${amountNum.toFixed(2)}，第 ${newExecutedRuns} 次`,
        date: formatDateLocal(runDate),
        executedRuns: newExecutedRuns,
        completed: willComplete,
      });
    }

    return NextResponse.json({
      ok: true,
      message: `已执行定投 ${plan.fundCode}，金额 ${amountNum.toFixed(2)}，第 ${newExecutedRuns} 次`,
      date: formatDateLocal(runDate),
      executedRuns: newExecutedRuns,
      completed: willComplete,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}