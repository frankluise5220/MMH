import { NextResponse } from "next/server";
import { RegularInvestStatus, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, shouldPreferLoanScheduledPlan } from "@/lib/scheduled-task";
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
import { buildMortgageLprRateAdjustments } from "@/lib/loan-lpr";
import { formatDateUtc, toNumber } from "@/lib/date-utils";

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
    let replacementAdjustments = parseAdjustmentList(body?.adjustments);
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const annualRate = Number(body?.annualRate);
    const mortgageLprDiscountRaw = body?.mortgageLprDiscount;
    const mortgageLprDiscount =
      mortgageLprDiscountRaw == null || mortgageLprDiscountRaw === ""
        ? null
        : Number(mortgageLprDiscountRaw);
    const loanStartDate = parseDateOnly(body?.loanStartDate);

    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_LOAN_ACCOUNT", error: "缺少贷款账户" }, { status: 400 });
    if (
      mortgageLprDiscountRaw != null &&
      mortgageLprDiscountRaw !== "" &&
      (mortgageLprDiscount == null || !Number.isFinite(mortgageLprDiscount) || mortgageLprDiscount <= 0)
    ) {
      return NextResponse.json({ ok: false, code: "INVALID_LPR_DISCOUNT", error: "LPR 利率折扣不正确" }, { status: 400 });
    }
    if (!replacementAdjustments) {
      if (!effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "生效日期不正确" }, { status: 400 });
      if (!Number.isFinite(annualRate) || annualRate <= 0) {
        return NextResponse.json({ ok: false, code: "INVALID_ANNUAL_RATE", error: "年利率不正确" }, { status: 400 });
      }
    }

    const plans = await prisma.regularInvestPlan.findMany({
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
    let plan: (typeof plans)[number] | null = null;
    for (const item of plans) {
      if (shouldPreferLoanScheduledPlan(item, plan)) plan = item;
    }
    if (!plan) return NextResponse.json({ ok: false, code: "LOAN_PLAN_NOT_FOUND", error: "未找到贷款还款计划" }, { status: 404 });

    const memo = decodeScheduledTaskMemo(plan.memo);
    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const currentAdjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
    });
    const lprDiscountForGeneration = mortgageLprDiscount ?? memo.mortgageLprDiscount ?? null;
    if (replacementAdjustments && replacementAdjustments.length === 0 && lprDiscountForGeneration != null && lprDiscountForGeneration > 0) {
      const loanStartEntry = loanStartDate
        ? null
        : await prisma.txRecord.findFirst({
            where: {
              householdId,
              accountId: plan.accountId,
              type: TransactionType.transfer,
              source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
              deletedAt: null,
            },
            orderBy: [{ date: "asc" }, { createdAt: "asc" }],
            select: { date: true },
          });
      replacementAdjustments = buildMortgageLprRateAdjustments({
        discount: lprDiscountForGeneration,
        throughDate: formatDateUtc(new Date()),
        fromDate: loanStartDate || (loanStartEntry ? formatDateUtc(loanStartEntry.date) : plan.startDate ? formatDateUtc(plan.startDate) : undefined),
        includeUnchanged: true,
        basis: "lpr_quote",
      });
    }
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
      { ok: false, code: "SAVE_FAILED", error: error instanceof Error ? error.message : "保存利率调整失败" },
      { status: 500 },
    );
  }
}
