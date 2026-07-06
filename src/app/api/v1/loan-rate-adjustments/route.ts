import { NextResponse } from "next/server";
import { RegularInvestStatus } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo } from "@/lib/scheduled-task";
import {
  listLoanRateAdjustmentsByAccountIds,
  replaceLoanRateAdjustmentsForAccount,
  resolveLoanRateAdjustments,
} from "@/lib/server/loan-rate-adjustments";
import {
  calcLoanScheduledAmount,
  getEffectiveLoanAnnualRate,
  normalizeLoanRateAdjustments,
} from "@/lib/loan-repayment";
import { toNumber } from "@/lib/date-utils";

export const runtime = "nodejs";

function parseDateOnly(value: unknown) {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function parseAdjustmentList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => ({
    effectiveDate: parseDateOnly(item?.effectiveDate),
    annualRate: Number(item?.annualRate),
  }));
  const invalid = items.find((item) => !item.effectiveDate || !Number.isFinite(item.annualRate) || item.annualRate <= 0);
  if (invalid) throw new Error("利率调整记录不正确");
  return normalizeLoanRateAdjustments(items);
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const accountId = String(body?.accountId ?? "").trim();
    const replacementAdjustments = parseAdjustmentList(body?.adjustments);
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const annualRate = Number(body?.annualRate);
    const mortgageLprDiscountRaw = body?.mortgageLprDiscount;
    const mortgageLprDiscount =
      mortgageLprDiscountRaw == null || mortgageLprDiscountRaw === ""
        ? null
        : Number(mortgageLprDiscountRaw);

    if (!accountId) return NextResponse.json({ ok: false, error: "缺少贷款账户" }, { status: 400 });
    if (
      mortgageLprDiscountRaw != null &&
      mortgageLprDiscountRaw !== "" &&
      (mortgageLprDiscount == null || !Number.isFinite(mortgageLprDiscount) || mortgageLprDiscount <= 0)
    ) {
      return NextResponse.json({ ok: false, error: "LPR 利率折扣不正确" }, { status: 400 });
    }
    if (!replacementAdjustments) {
      if (!effectiveDate) return NextResponse.json({ ok: false, error: "生效日期不正确" }, { status: 400 });
      if (!Number.isFinite(annualRate) || annualRate <= 0) {
        return NextResponse.json({ ok: false, error: "年利率不正确" }, { status: 400 });
      }
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
          select: { balance: true },
        },
      },
      orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
    });
    if (!plan) return NextResponse.json({ ok: false, error: "未找到贷款还款计划" }, { status: 404 });

    const memo = decodeScheduledTaskMemo(plan.memo);
    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const currentAdjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
    });
    const adjustments = replacementAdjustments ?? currentAdjustments
      .filter((item) => item.effectiveDate !== effectiveDate);
    if (!replacementAdjustments) adjustments.push({ effectiveDate, annualRate });
    adjustments.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

    const nextRunDate = plan.nextRunDate.toISOString().slice(0, 10);
    const remainingRuns = plan.totalRuns == null
      ? null
      : Math.max(1, plan.totalRuns - Math.max(0, plan.executedRuns ?? 0));
    const remainingPrincipal = Math.abs(toNumber(plan.Account_RegularInvestPlan_accountIdToAccount.balance));
    const effectiveAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: memo.annualRate,
      adjustments,
      date: nextRunDate,
    });
    const nextAmount = remainingRuns
      ? calcLoanScheduledAmount({
          repaymentMethod: memo.repaymentMethod,
          annualRate: effectiveAnnualRate,
          principal: remainingPrincipal,
          totalRuns: remainingRuns,
          intervalMonths: memo.repaymentIntervalMonths ?? (plan.intervalValue || 1),
        })
      : null;

    await prisma.$transaction(async (tx) => {
      await replaceLoanRateAdjustmentsForAccount(tx, {
        householdId,
        accountId: plan.accountId,
        regularInvestPlanId: plan.id,
        adjustments,
      });
      await tx.regularInvestPlan.update({
        where: { id: plan.id },
        data: {
          amount: nextAmount ?? plan.amount,
          memo: encodeScheduledTaskMemo({
            ...memo,
            mortgageLprDiscount: mortgageLprDiscount ?? memo.mortgageLprDiscount ?? null,
            loanRateAdjustments: [],
          }),
        },
      });
    });

    revalidateAfterTxChange();
    return NextResponse.json({ ok: true, data: { adjustments, nextAmount } });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "保存利率调整失败" },
      { status: 500 },
    );
  }
}
