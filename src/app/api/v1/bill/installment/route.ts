/**
 * API: /api/v1/bill/installment
 *
 * POST JSON body:
 *   accountId: Account.id for a credit-card account
 *   statementMonth: string (YYYY-MM), a posted statement month
 *   amount: number, the partial unpaid statement amount to finance
 *   totalRuns: number (2-120)
 *   rateType: "period_fee" | "annual_interest"
 *   rate: number (0-100)
 *
 * Returns { ok: true, data } or { ok: false, error }.
 */
import { AccountKind, CreditCardInstallmentSourceType } from "@prisma/client";
import { NextResponse } from "next/server";

import { addStatementMonths, type CreditCardInstallmentRateType } from "@/lib/credit/installment";
import { cycleForStatementMonth } from "@/lib/credit/billing";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { createCreditCardInstallmentPlan } from "@/lib/server/credit-card-installment";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });

    const accountId = String(body.accountId ?? "").trim();
    const statementMonth = String(body.statementMonth ?? "").trim();
    const amount = roundMoney(Number(body.amount));
    const totalRuns = Number(body.totalRuns);
    const rate = Number(body.rate ?? 0);
    const rateType = String(body.rateType ?? "period_fee") as CreditCardInstallmentRateType;

    if (!accountId) return NextResponse.json({ ok: false, error: "缺少信用卡账户" }, { status: 400 });
    if (!/^\d{4}-\d{2}$/.test(statementMonth)) {
      return NextResponse.json({ ok: false, error: "账单月份格式不正确" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ ok: false, error: "分期金额必须大于 0" }, { status: 400 });
    }
    if (!Number.isInteger(totalRuns) || totalRuns < 2 || totalRuns > 120) {
      return NextResponse.json({ ok: false, error: "分期期数应为 2 至 120 期" }, { status: 400 });
    }
    if (rateType !== "period_fee" && rateType !== "annual_interest") {
      return NextResponse.json({ ok: false, error: "分期费率类型不正确" }, { status: 400 });
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ ok: false, error: "费率应为 0 至 100" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit, isActive: true },
      select: {
        id: true,
        name: true,
        householdId: true,
        institutionId: true,
        kind: true,
        creditBillMode: true,
        billingDay: true,
        repaymentDay: true,
      },
    });
    if (!account) return NextResponse.json({ ok: false, error: "信用卡账户不存在" }, { status: 404 });
    if (!account.billingDay) {
      return NextResponse.json({ ok: false, error: "信用卡缺少账单日，无法创建账单分期" }, { status: 400 });
    }

    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const storageAccountId = billAccountIds[0] ?? account.id;
    const [cycle, existingPlan] = await Promise.all([
      prisma.creditCardCycle.findUnique({
        where: { accountId_statementMonth: { accountId: storageAccountId, statementMonth } },
      }),
      prisma.creditCardInstallmentPlan.findFirst({
        where: {
          householdId,
          accountId: { in: billAccountIds },
          sourceType: CreditCardInstallmentSourceType.statement,
          sourceStatementMonth: statementMonth,
          status: "active",
        },
        select: { id: true },
      }),
    ]);
    if (!cycle) {
      return NextResponse.json({ ok: false, error: "这一期账单尚未生成，请先打开账单列表" }, { status: 404 });
    }
    if (cycle.isCurrentCycle) {
      return NextResponse.json({ ok: false, error: "当前账期尚未出账，请在消费记录中使用消费分期" }, { status: 400 });
    }
    if (existingPlan) {
      return NextResponse.json({ ok: false, error: "这一期账单已经创建过账单分期" }, { status: 409 });
    }

    const eligibleAmount = roundMoney(Math.max(0, toNumber(cycle.effectiveBill) - toNumber(cycle.paid)));
    if (eligibleAmount <= 0) {
      return NextResponse.json({ ok: false, error: "这一期账单已结清，没有可分期金额" }, { status: 400 });
    }
    if (amount > eligibleAmount) {
      return NextResponse.json(
        { ok: false, error: `分期金额不能超过当前未还金额 ${eligibleAmount.toFixed(2)}` },
        { status: 400 },
      );
    }

    const firstPaymentStatementMonth = addStatementMonths(statementMonth, 1);
    const firstCycle = cycleForStatementMonth(
      firstPaymentStatementMonth,
      account.billingDay,
      account.repaymentDay,
      new Date(),
    );
    if (!firstCycle) {
      return NextResponse.json({ ok: false, error: "无法计算首期账单日期" }, { status: 400 });
    }

    const created = await prisma.$transaction((tx) => createCreditCardInstallmentPlan(tx, {
      householdId,
      account: { id: account.id, name: account.name },
      sourceType: CreditCardInstallmentSourceType.statement,
      sourceStatementMonth: statementMonth,
      originalAmount: eligibleAmount,
      principal: amount,
      totalRuns,
      rateType,
      rate,
      adjustmentDate: cycle.periodEnd,
      adjustmentStatementMonth: statementMonth,
      firstPaymentDate: firstCycle.end,
      firstPaymentStatementMonth,
      label: `${statementMonth} 账单`,
    }));

    await recalcAndSaveAccountBalance(account.id);
    await invalidateCreditCardCycleCacheForAccountIds(billAccountIds);
    revalidateAfterTxChange();

    return NextResponse.json({
      ok: true,
      data: {
        planId: created.plan.id,
        sourceType: created.plan.sourceType,
        sourceStatementMonth: statementMonth,
        installmentPrincipal: amount,
        firstStatementMonth: firstPaymentStatementMonth,
        totalRuns,
      },
    });
  } catch (error) {
    console.error("[bill-installment] failed to create statement installment", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "创建账单分期失败" },
      { status: 500 },
    );
  }
}
