import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { Prisma, TransactionType, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { isWeekend, nextMonday, addDays, addWeeks, addMonths, isToday, isBefore } from "date-fns";
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
    const now = new Date();
    const todayStr = formatDateLocal(now);

    // 只查询 active 状态的计划
    const plans = await prisma.regularInvestPlan.findMany({
      where: {
        status: RegularInvestStatus.active,
        nextRunDate: { lte: now },
      },
    });

    if (plans.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "没有需要执行的定投计划",
        executedCount: 0,
        skippedCount: 0,
      });
    }

    const executed: string[] = [];
    const skipped: string[] = [];
    const completed: string[] = [];
    const details: { planId: string; fundCode: string; action: string; reason?: string }[] = [];

    for (const plan of plans) {
      // 检查结束条件
      if (plan.endDate && plan.endDate < now) {
        await prisma.regularInvestPlan.update({
          where: { id: plan.id },
          data: { status: RegularInvestStatus.completed },
        });
        completed.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "completed",
          reason: "达到结束日期",
        });
        continue;
      }

      if (plan.totalRuns && plan.executedRuns >= plan.totalRuns) {
        await prisma.regularInvestPlan.update({
          where: { id: plan.id },
          data: { status: RegularInvestStatus.completed },
        });
        completed.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "completed",
          reason: "达到执行次数",
        });
        continue;
      }

      const nextRunDate = new Date(plan.nextRunDate);
      const nextRunStr = formatDateLocal(nextRunDate);

      // 检查今日是否已执行
      const alreadyRunToday = await prisma.txRecord.findFirst({
        where: {
          toAccountId: plan.accountId,
          fundCode: plan.fundCode,
          source: "regular_invest",
          deletedAt: null,
          date: {
            gte: new Date(todayStr + "T00:00:00Z"),
            lte: new Date(todayStr + "T23:59:59Z"),
          },
        },
      });

      if (alreadyRunToday) {
        skipped.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "skipped",
          reason: "今日已执行",
        });
        continue;
      }

      const runDate = skipWeekend(nextRunDate);
      const amountNum = parseFloat(String(plan.amount));

      const fundAcc = await prisma.account.findUnique({ where: { id: plan.accountId } });
      if (!fundAcc) {
        skipped.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "skipped",
          reason: "基金账户不存在",
        });
        continue;
      }

      const cashAcc = plan.cashAccountId
        ? await prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true } })
        : null;

      const newExecutedRuns = plan.executedRuns + 1;
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
              regularInvestPlanId: plan.id,
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
              regularInvestPlanId: plan.id,
              note: `基金暂停申购，资金退回 ${plan.fundCode}`,
            },
          });

          // 更新定投计划（暂停申购也算一次执行）
          const nextRun = calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue);
          await tx.regularInvestPlan.update({
            where: { id: plan.id },
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
            regularInvestPlanId: plan.id,
            note: `基金定期定额申购 ${plan.fundCode}`,
          },
        });

        // 更新定投计划
        const nextRun = calcNextRunDate(runDate, plan.intervalUnit as IntervalUnit, plan.intervalValue);
        await tx.regularInvestPlan.update({
          where: { id: plan.id },
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
      if (cashAcc?.id) await recalcAndSaveAccountBalance(cashAcc.id).catch(() => {});
      await recalcAndSaveAccountBalance(fundAcc.id).catch(() => {});

      if (willComplete) {
        completed.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "completed",
          reason: result.buyFailed ? "暂停申购后达到结束条件" : "达到结束条件",
        });
      } else if (result.buyFailed) {
        executed.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "buy_failed",
          reason: "基金暂停申购，已生成两条对冲记录",
        });
      } else {
        executed.push(plan.id);
        details.push({
          planId: plan.id,
          fundCode: plan.fundCode,
          action: "executed",
        });
      }
    }

    revalidateAfterInvestChange();
    return NextResponse.json({
      ok: true,
      message: `执行完成：${executed.length} 条已执行，${skipped.length} 条已跳过，${completed.length} 条已完成`,
      executedCount: executed.length,
      skippedCount: skipped.length,
      completedCount: completed.length,
      details,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}