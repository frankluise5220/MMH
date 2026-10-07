import { AccountKind, RegularInvestStatus } from "@prisma/client";

import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { getMaintainedAccountBalances } from "@/lib/server/account-balance";
import {
  applyLiabilityRowEntryMetrics,
  buildLiabilityRowsViewData,
  type LiabilityMetricEntry,
  type LiabilityViewAccount,
} from "@/lib/server/liability-view-data";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { listLoanRateAdjustmentsByAccountIds } from "@/lib/server/loan-rate-adjustments";
import { shouldPreferLoanScheduledPlan } from "@/lib/scheduled-task";

function parseMortgageLprDiscountFromText(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/LPR\s*折扣\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return null;
  const discount = Number(match[1]);
  return Number.isFinite(discount) && discount > 0 ? discount : null;
}

export type LiabilityDisplaySummary = {
  /** Balances in each account's own currency. */
  balanceByAccountId: Map<string, number>;
  /** Totals in the household base currency when an `fx` converter is supplied, otherwise raw sums. */
  totalPayable: number;
  totalReceivable: number;
  net: number;
};

export type LiabilityDisplayFxConverter = {
  /** Restate an amount into the base currency; missing-rate amounts must contribute 0, not 1:1. */
  convertForTotal: (amount: number, currency?: string | null) => number;
};

export async function computeLiabilityDisplaySummary(
  ctx: Pick<HouseholdContext, "householdId" | "hidFilter">,
  fx?: LiabilityDisplayFxConverter | null,
): Promise<LiabilityDisplaySummary> {
  const liabilityAccounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      kind: { in: [AccountKind.settlement, AccountKind.loan] },
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      balance: true,
      currency: true,
      kind: true,
      isActive: true,
      liabilityDirection: true,
      institutionId: true,
      counterpartyId: true,
      Institution: { select: { name: true, shortName: true, type: true } },
      Counterparty: { select: { name: true, shortName: true, type: true } },
    },
  });
  if (liabilityAccounts.length === 0) {
    return {
      balanceByAccountId: new Map(),
      totalPayable: 0,
      totalReceivable: 0,
      net: 0,
    };
  }
  const liabilityCurrencyByAccountId = new Map(liabilityAccounts.map((account) => [account.id, account.currency]));
  const convertRow = (amount: number, rowAccountIds: string[]) => {
    if (!fx) return amount;
    return fx.convertForTotal(amount, liabilityCurrencyByAccountId.get(rowAccountIds[0]) ?? null);
  };

  const liabilityAccountIds = liabilityAccounts.map((account) => account.id);
  const cashDisplayBalanceByAccountId = await getMaintainedAccountBalances(
    liabilityAccounts.map((account) => ({
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
      accountId: { in: liabilityAccountIds },
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
    if (shouldPreferLoanScheduledPlan(plan, existing)) {
      loanRepaymentPlanByAccountId.set(plan.accountId, plan);
    }
  }
  const loanRateAdjustmentsByAccountId = await listLoanRateAdjustmentsByAccountIds({
    householdId: ctx.householdId,
    accountIds: loanRepaymentPlans.map((plan) => plan.accountId),
  });
  const liabilityBorrowLprDiscountEntries = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...ctx.hidFilter,
      source: { in: ["liability_borrow_in", "liability_financed_purchase"] },
      accountId: { in: liabilityAccountIds },
    },
    select: { accountId: true, date: true, note: true, toNote: true },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  const liabilityBorrowLprDiscountByAccountId = new Map<string, number>();
  const liabilityBorrowStartDateByAccountId = new Map<string, string>();
  for (const entry of liabilityBorrowLprDiscountEntries) {
    const discount = parseMortgageLprDiscountFromText(entry.note) ?? parseMortgageLprDiscountFromText(entry.toNote);
    if (discount != null && !liabilityBorrowLprDiscountByAccountId.has(entry.accountId)) {
      liabilityBorrowLprDiscountByAccountId.set(entry.accountId, discount);
    }
    const dateKey = formatDateUtc(entry.date);
    const existingDate = liabilityBorrowStartDateByAccountId.get(entry.accountId);
    if (!existingDate || dateKey < existingDate) {
      liabilityBorrowStartDateByAccountId.set(entry.accountId, dateKey);
    }
  }

  const { liabilityRows } = buildLiabilityRowsViewData({
    liabilityAccounts: liabilityAccounts satisfies LiabilityViewAccount[],
    cashDisplayBalanceByAccountId,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
    liabilityBorrowLprDiscountByAccountId,
    liabilityBorrowStartDateByAccountId,
    selectedAccountId: null,
    selectedAccountKind: null,
    liabilityPersonParam: "",
  });

  const loanRepaymentPlanIds = loanRepaymentPlans.map((plan) => plan.id);
  const liabilityEntriesRaw: LiabilityMetricEntry[] = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...ctx.hidFilter,
      OR: [
        { accountId: { in: liabilityAccountIds } },
        { toAccountId: { in: liabilityAccountIds } },
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
      principalAmount: true,
      interestAmount: true,
      feeAmount: true,
      regularInvestPlanId: true,
      fundSubtype: true,
      fundConfirmDate: true,
      fundArrivalDate: true,
    },
  });
  applyLiabilityRowEntryMetrics({
    liabilityRows,
    liabilityEntriesRaw,
    loanRepaymentPlans,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
  });

  const balanceByAccountId = new Map<string, number>();
  let totalPayable = 0;
  let totalReceivable = 0;
  for (const row of liabilityRows) {
    if (row.parentKey) continue;
    const value = Number.isFinite(row.remainingTotal) && Math.abs(row.remainingTotal) > 0
      ? row.remainingTotal
      : row.net;
    const totalValue = convertRow(value, row.accountIds);
    if (totalValue < 0) totalPayable += Math.abs(totalValue);
    if (totalValue > 0) totalReceivable += totalValue;
    if (row.accountIds.length === 1) {
      balanceByAccountId.set(row.accountIds[0], value);
      continue;
    }
    for (const accountId of row.accountIds) {
      const fallback = cashDisplayBalanceByAccountId.get(accountId) ?? toNumber(liabilityAccounts.find((account) => account.id === accountId)?.balance);
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
