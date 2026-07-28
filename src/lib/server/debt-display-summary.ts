import { AccountKind, RegularInvestStatus } from "@prisma/client";

import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import {
  applyDebtRowEntryMetrics,
  buildDebtRowsViewData,
  type DebtMetricEntry,
  type DebtViewAccount,
} from "@/lib/server/debt-view-data";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { listLoanRateAdjustmentsByAccountIds } from "@/lib/server/loan-rate-adjustments";

function parseMortgageLprDiscountFromText(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/LPR\s*折扣\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return null;
  const discount = Number(match[1]);
  return Number.isFinite(discount) && discount > 0 ? discount : null;
}

export type DebtDisplaySummary = {
  balanceByAccountId: Map<string, number>;
  totalPayable: number;
  totalReceivable: number;
  net: number;
};

export async function computeDebtDisplaySummary(ctx: Pick<HouseholdContext, "householdId" | "hidFilter">): Promise<DebtDisplaySummary> {
  const debtAccounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      kind: AccountKind.loan,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      balance: true,
      kind: true,
      isActive: true,
      debtDirection: true,
      institutionId: true,
      counterpartyId: true,
      Institution: { select: { name: true, shortName: true, type: true } },
      Counterparty: { select: { name: true, shortName: true, type: true } },
    },
  });
  if (debtAccounts.length === 0) {
    return { balanceByAccountId: new Map(), totalPayable: 0, totalReceivable: 0, net: 0 };
  }

  const debtAccountIds = debtAccounts.map((account) => account.id);
  const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    debtAccounts.map((account) => ({
      id: account.id,
      kind: account.kind,
      investProductType: null,
      billingDay: null,
    })),
    ctx.hidFilter,
  );

  const loanRepaymentPlans = await prisma.regularInvestPlan.findMany({
    where: {
      ...ctx.hidFilter,
      accountId: { in: debtAccountIds },
      fundCode: "loan_repayment",
      status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
    },
    select: {
      id: true,
      accountId: true,
      amount: true,
      intervalUnit: true,
      intervalValue: true,
      executionDay: true,
      memo: true,
      startDate: true,
      nextRunDate: true,
      lastRunDate: true,
      cashAccountId: true,
      totalRuns: true,
      executedRuns: true,
      status: true,
    },
    orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
  });
  const loanRepaymentPlanByAccountId = new Map<string, (typeof loanRepaymentPlans)[number]>();
  for (const plan of loanRepaymentPlans) {
    const existing = loanRepaymentPlanByAccountId.get(plan.accountId);
    if (!existing || (existing.status !== RegularInvestStatus.active && plan.status === RegularInvestStatus.active)) {
      loanRepaymentPlanByAccountId.set(plan.accountId, plan);
    }
  }
  const loanRateAdjustmentsByAccountId = await listLoanRateAdjustmentsByAccountIds({
    householdId: ctx.householdId,
    accountIds: loanRepaymentPlans.map((plan) => plan.accountId),
  });
  const debtBorrowLprDiscountEntries = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...ctx.hidFilter,
      source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
      accountId: { in: debtAccountIds },
    },
    select: { accountId: true, note: true, toNote: true },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: debtAccountIds.length * 5,
  });
  const debtBorrowLprDiscountByAccountId = new Map<string, number>();
  for (const entry of debtBorrowLprDiscountEntries) {
    const discount = parseMortgageLprDiscountFromText(entry.note) ?? parseMortgageLprDiscountFromText(entry.toNote);
    if (discount != null && !debtBorrowLprDiscountByAccountId.has(entry.accountId)) {
      debtBorrowLprDiscountByAccountId.set(entry.accountId, discount);
    }
  }

  const { debtRows } = buildDebtRowsViewData({
    debtAccounts: debtAccounts satisfies DebtViewAccount[],
    cashDisplayBalanceByAccountId,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
    debtBorrowLprDiscountByAccountId,
    selectedAccountId: null,
    selectedAccountKind: null,
    debtPersonParam: "",
  });

  const loanRepaymentPlanIds = loanRepaymentPlans.map((plan) => plan.id);
  const debtEntriesRaw: DebtMetricEntry[] = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...ctx.hidFilter,
      OR: [
        { accountId: { in: debtAccountIds } },
        { toAccountId: { in: debtAccountIds } },
        ...(loanRepaymentPlanIds.length > 0 ? [{ regularInvestPlanId: { in: loanRepaymentPlanIds } }] : []),
      ],
    },
    select: {
      id: true,
      date: true,
      createdAt: true,
      dayOrder: true,
      type: true,
      amount: true,
      accountId: true,
      toAccountId: true,
      source: true,
      categoryId: true,
      categoryName: true,
      counterpartyInstitutionId: true,
      note: true,
      toNote: true,
      debtPrincipalAmount: true,
      debtInterestAmount: true,
      debtFeeAmount: true,
      regularInvestPlanId: true,
      fundSubtype: true,
      fundConfirmDate: true,
      fundArrivalDate: true,
    },
  });
  applyDebtRowEntryMetrics({
    debtRows,
    debtEntriesRaw,
    loanRepaymentPlans,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
  });

  const balanceByAccountId = new Map<string, number>();
  let totalPayable = 0;
  let totalReceivable = 0;
  for (const row of debtRows) {
    const value = Number.isFinite(row.remainingTotal) && Math.abs(row.remainingTotal) > 0
      ? row.remainingTotal
      : row.net;
    if (value < 0) totalPayable += Math.abs(value);
    if (value > 0) totalReceivable += value;
    if (row.accountIds.length === 1) {
      balanceByAccountId.set(row.accountIds[0], value);
      continue;
    }
    for (const accountId of row.accountIds) {
      const fallback = cashDisplayBalanceByAccountId.get(accountId) ?? toNumber(debtAccounts.find((account) => account.id === accountId)?.balance);
      balanceByAccountId.set(accountId, fallback);
    }
  }

  return {
    balanceByAccountId,
    totalPayable,
    totalReceivable,
    net: totalReceivable - totalPayable,
  };
}
