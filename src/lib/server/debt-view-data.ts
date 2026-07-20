import { AccountKind, DebtDirection, IntervalUnit, TransactionType } from "@prisma/client";

import { toNumber, formatDateUtc } from "@/lib/date-utils";
import { debtPrincipalForAccountSide as canonicalDebtPrincipalForAccountSide } from "@/lib/debt";
import { normalizeSettlementTransferCategoryName } from "@/lib/default-categories";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import {
  calcLoanRunPartsWithRateAdjustments,
  calcLoanScheduledAmountForPeriodStart,
  getEffectiveLoanAnnualRate,
  normalizeLoanRateAdjustments,
} from "@/lib/loan-repayment";
import { inferMortgageLprDiscountFromRateAdjustments } from "@/lib/loan-lpr";
import { decodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";

export const ACTIVE_DEBT_EPSILON = 0.005;

export type DebtViewAccount = {
  id: string;
  name: string;
  balance: unknown;
  kind: AccountKind;
  isActive: boolean;
  debtDirection?: DebtDirection | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  Institution?: {
    name?: string | null;
    shortName?: string | null;
    type?: string | null;
  } | null;
  Counterparty?: {
    name?: string | null;
    shortName?: string | null;
    type?: string | null;
  } | null;
};

export type DebtViewPlan = {
  id: string;
  accountId: string;
  amount: unknown;
  intervalUnit: IntervalUnit;
  intervalValue: number;
  executionDay: number | null;
  memo: string | null;
  startDate: Date;
  nextRunDate: Date;
  lastRunDate: Date | null;
  cashAccountId: string | null;
  totalRuns: number | null;
  executedRuns: number | null;
  status: string;
};

export type DebtViewRow = {
  key: string;
  name: string;
  objectType: string;
  objectName: string;
  itemName: string;
  accountId: string;
  institutionId: string;
  counterpartyId: string;
  itemType: string;
  repaymentMethod: string;
  repaymentCycle: string;
  annualRate: number | null;
  mortgageLprDiscount: number | null;
  remainingRuns: number | null;
  paidPrincipal: number;
  paidInterest: number;
  remainingPrincipal: number;
  remainingInterest: number;
  nextRepaymentDate: string;
  nextRepaymentPrincipal: number | null;
  nextRepaymentInterest: number | null;
  nextRepaymentCashAccountId: string;
  loanRateAdjustments: Array<{ effectiveDate: string; annualRate: number }>;
  payable: number;
  receivable: number;
  net: number;
  accountCount: number;
  accountIds: string[];
  accountLabels: string[];
  parentKey: string | null;
  depth: number;
  isGroup: boolean;
};

export type DebtRepaymentScheduleRow = {
  rowType: "payment" | "rate_adjustment";
  status?: "paid" | "planned";
  eventType?: "repayment" | "prepayment" | "rate_adjustment";
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  remainingPrincipal: number;
  annualRate: number | null;
};

export type DebtDetailEntry = {
  id: string;
  date: string;
  typeLabel: string;
  relatedAccountLabel: string;
  note: string;
  amount: number;
  principal: number;
  interest: number;
  paymentTotal: number | null;
  balance: number;
  debtEdit?: {
    editEntryId: string;
    mode: "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
    defaultDebtAccountId: string;
    defaultCashAccountId: string;
    defaultDate: string;
    defaultPrincipal: number;
    defaultInterest: number;
    defaultPenalty?: number;
    defaultRecalculateStartDate?: string | null;
    defaultPrepayStrategy?: string;
    defaultLoanFundingMode?: "cash_disbursement" | "financed_purchase";
  };
  edit?: {
    type: "expense" | "income" | "advance" | "transfer" | "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    categoryId?: string;
    counterpartyInstitutionId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  };
};

type DebtEntryMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

function formatDebtEntryType(type: string) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "advance") return "代付";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
  return type;
}

function bankDebtTransferTypeLabel(source: string | null | undefined, mode: DebtEntryMode) {
  if (source === "debt_financed_purchase") return "消费分期";
  if (mode === "borrow_in") return "贷款发放";
  if (mode === "repay_out") return "贷款还款";
  if (mode === "prepay_out") return "提前还款";
  if (mode === "lend_out") return "银行放款";
  if (mode === "collect_in") return "银行收回";
  return "银行贷款";
}

export type DebtMetricEntry = {
  id: string;
  date: Date;
  createdAt: Date;
  dayOrder?: number | null;
  type: TransactionType;
  amount: unknown;
  accountId?: string | null;
  toAccountId?: string | null;
  source?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  counterpartyInstitutionId?: string | null;
  note?: string | null;
  toNote?: string | null;
  debtPrincipalAmount?: unknown;
  debtInterestAmount?: unknown;
  debtFeeAmount?: unknown;
  regularInvestPlanId?: string | null;
  fundSubtype?: string | null;
  fundConfirmDate?: Date | null;
  fundArrivalDate?: Date | null;
};

export function debtPrincipalForAccountSide(
  entry: { amount: unknown; debtPrincipalAmount?: unknown; source?: string | null; accountId?: string | null; toAccountId?: string | null },
  debtAccountIds: Set<string>,
) {
  return canonicalDebtPrincipalForAccountSide(entry, debtAccountIds);
}

export function debtCashFlowForAccountSide(
  entry: { amount: unknown; debtPrincipalAmount?: unknown; source?: string | null; accountId?: string | null; toAccountId?: string | null },
  debtAccountIds: Set<string>,
) {
  const amount = toNumber(entry.amount);
  const principal = entry.debtPrincipalAmount == null ? Math.abs(amount) : toNumber(entry.debtPrincipalAmount);
  const source = String(entry.source ?? "");
  if (source === "debt_borrow_in") return principal;
  if (source === "debt_financed_purchase") return 0;
  if (source === "debt_repay_out" || source === "debt_prepay_out" || source === "debt_lend_out" || source === "scheduled_task") return -principal;
  if (source === "debt_collect_in") return principal;
  return debtAccountIds.has(entry.accountId ?? "") ? -amount : amount;
}

export function debtPaymentTotal(
  entry: { amount: unknown; debtPrincipalAmount?: unknown; debtInterestAmount?: unknown; debtFeeAmount?: unknown },
  fallbackInterest = 0,
  fallbackFee = 0,
) {
  const hasStructuredSplit =
    entry.debtPrincipalAmount != null ||
    entry.debtInterestAmount != null ||
    entry.debtFeeAmount != null;
  const principal = entry.debtPrincipalAmount == null ? Math.abs(toNumber(entry.amount)) : toNumber(entry.debtPrincipalAmount);
  const interest = Math.abs(toNumber(entry.debtInterestAmount));
  const fee = Math.abs(toNumber(entry.debtFeeAmount));
  if (!hasStructuredSplit) return principal + fallbackInterest + fallbackFee;
  return principal + interest + fee;
}

function debtMetricDisplayDate(entry: DebtMetricEntry, displayAccountId?: string | null) {
  return getDetailEntryDisplayDate(entry, displayAccountId);
}

function debtPrincipalKey(entry: DebtMetricEntry, debtAccountIds: Set<string>, displayAccountId?: string | null) {
  const dateKey = debtMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10);
  if (entry.regularInvestPlanId) return `plan:${entry.regularInvestPlanId}:${dateKey}`;
  const debtAccountId = debtAccountIds.has(entry.toAccountId ?? "")
    ? entry.toAccountId
    : debtAccountIds.has(entry.accountId ?? "")
      ? entry.accountId
      : "";
  const cashSideAccountId = debtAccountIds.has(entry.toAccountId ?? "")
    ? entry.accountId
    : entry.toAccountId;
  return `account:${debtAccountId ?? ""}:${dateKey}:${cashSideAccountId ?? ""}`;
}

export function applyDebtRowEntryMetrics({
  debtRows,
  debtEntriesRaw,
  loanRepaymentPlans,
  loanRepaymentPlanByAccountId,
  loanRateAdjustmentsByAccountId,
  displayAccountId,
}: {
  debtRows: DebtViewRow[];
  debtEntriesRaw: DebtMetricEntry[];
  loanRepaymentPlans: DebtViewPlan[];
  loanRepaymentPlanByAccountId: Map<string, DebtViewPlan>;
  loanRateAdjustmentsByAccountId: Map<string, Array<{ effectiveDate: string; annualRate: number }>>;
  displayAccountId?: string | null;
}) {
  for (const row of debtRows) {
    const rowAccountIds = new Set(row.accountIds);
    const rowPlanIds = new Set(
      loanRepaymentPlans
        .filter((plan) => rowAccountIds.has(plan.accountId))
        .map((plan) => plan.id),
    );
    const rowPrincipalEntries = debtEntriesRaw.filter(
      (entry) =>
        entry.type === TransactionType.transfer &&
        (rowAccountIds.has(entry.accountId ?? "") || rowAccountIds.has(entry.toAccountId ?? "")),
    );
    const rowPrincipalKey = (entry: DebtMetricEntry) => debtPrincipalKey(entry, rowAccountIds, displayAccountId);
    const rowLockedInterestKeys = new Set<string>();
    for (const entry of debtEntriesRaw) {
      if (
        entry.type === TransactionType.transfer ||
        !(
          rowAccountIds.has(entry.toAccountId ?? "") ||
          (entry.regularInvestPlanId ? rowPlanIds.has(entry.regularInvestPlanId) : false)
        ) ||
        !(
          String(entry.source ?? "").includes("interest") ||
          String(entry.categoryName ?? "").includes("利息") ||
          String(entry.note ?? "").includes("利息")
        )
      ) {
        continue;
      }
      const source = String(entry.source ?? "");
      if (source.startsWith("debt_") && source.includes("interest")) {
        rowLockedInterestKeys.add(rowPrincipalKey(entry));
      }
    }
    const rowInterestByPrincipalKey = new Map<string, number>();
    for (const entry of debtEntriesRaw) {
      if (
        entry.type === TransactionType.transfer ||
        !(
          rowAccountIds.has(entry.toAccountId ?? "") ||
          (entry.regularInvestPlanId ? rowPlanIds.has(entry.regularInvestPlanId) : false)
        ) ||
        !(
          String(entry.source ?? "").includes("interest") ||
          String(entry.categoryName ?? "").includes("利息") ||
          String(entry.note ?? "").includes("利息")
        )
      ) {
        continue;
      }
      const key = rowPrincipalKey(entry);
      if (String(entry.source ?? "") === "scheduled_task" && rowLockedInterestKeys.has(key)) continue;
      rowInterestByPrincipalKey.set(key, (rowInterestByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
    }
    const paidEntries = rowPrincipalEntries.filter((entry) => {
      const displayAmount = debtPrincipalForAccountSide(entry, rowAccountIds);
      if (displayAmount <= 0) return false;
      const source = String(entry.source ?? "");
      return (
        source === "debt_repay_out" ||
        source === "debt_prepay_out" ||
        source === "scheduled_task" ||
        (entry.regularInvestPlanId ? rowPlanIds.has(entry.regularInvestPlanId) : false)
      );
    });
    row.paidPrincipal = paidEntries.reduce((sum, entry) => {
      return sum + Math.abs(debtPrincipalForAccountSide(entry, rowAccountIds));
    }, 0);
    row.paidInterest = paidEntries.reduce(
      (sum, entry) => sum + Math.abs(toNumber(entry.debtInterestAmount)) + (rowInterestByPrincipalKey.get(rowPrincipalKey(entry)) ?? 0),
      0,
    );
    row.remainingPrincipal = Math.abs(row.net);

    const plan = loanRepaymentPlanByAccountId.get(row.accountId);
    const memo = plan ? decodeScheduledTaskMemo(plan.memo) : null;
    row.remainingInterest = 0;
    if (plan && memo && row.net < -ACTIVE_DEBT_EPSILON && plan.nextRunDate) {
      let remainingPrincipal = Math.abs(row.net);
      let runDate = plan.nextRunDate;
      let lastScheduleDate = plan.lastRunDate ?? plan.startDate;
      const remainingRuns = plan.totalRuns == null
        ? null
        : Math.max(0, plan.totalRuns - Math.max(0, plan.executedRuns ?? 0));
      const maxRuns = Math.min(remainingRuns ?? 24, 360);
      const intervalMonths = memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : null);
      const adjustments = resolveLoanRateAdjustments({
        tableAdjustments: loanRateAdjustmentsByAccountId.get(row.accountId),
        memoAdjustments: memo.loanRateAdjustments,
      });
      let scheduledAmountForRun = calcLoanScheduledAmountForPeriodStart({
        repaymentMethod: memo.repaymentMethod,
        baseAnnualRate: memo.annualRate,
        adjustments,
        intervalMonths,
        scheduledAmount: toNumber(plan.amount),
        remainingPrincipal,
        remainingRuns: remainingRuns ?? maxRuns,
        periodStartDate: formatDateUtc(lastScheduleDate),
      });
      for (let index = 0; index < maxRuns && remainingPrincipal > ACTIVE_DEBT_EPSILON; index++) {
        const remainingRunsForThisRun = remainingRuns == null ? Math.max(1, maxRuns - index) : Math.max(1, remainingRuns - index);
        const parts = calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: memo.repaymentMethod,
          baseAnnualRate: memo.annualRate,
          adjustments,
          intervalMonths,
          scheduledAmount: scheduledAmountForRun,
          remainingPrincipal,
          remainingRuns: remainingRunsForThisRun,
          previousRunDate: formatDateUtc(lastScheduleDate),
          runDate: formatDateUtc(runDate),
        });
        row.remainingInterest += parts.interest;
        scheduledAmountForRun = parts.scheduledAmount;
        remainingPrincipal = Math.max(0, Math.round((remainingPrincipal - parts.principal) * 100) / 100);
        lastScheduleDate = runDate;
        runDate = calcNextScheduledRunDate(
          runDate,
          plan.intervalUnit,
          plan.intervalValue,
          plan.executionDay,
          false,
        );
      }
    }
  }
}

export function buildDebtDetailEntriesViewData({
  debtEntriesRaw,
  selectedDebtAccountIds,
  selectedLoanRepaymentPlanIds,
  selectedDebtRow,
  selectedRepaymentPlan,
  repaymentScheduleRows,
  accountLabelById,
  debtDirectionByAccountId,
  displayAccountId,
}: {
  debtEntriesRaw: DebtMetricEntry[];
  selectedDebtAccountIds: Set<string>;
  selectedLoanRepaymentPlanIds: Set<string>;
  selectedDebtRow: DebtViewRow | null;
  selectedRepaymentPlan: DebtViewPlan | null;
  repaymentScheduleRows: DebtRepaymentScheduleRow[];
  accountLabelById: Map<string, string>;
  debtDirectionByAccountId: Map<string, DebtDirection | string | null>;
  displayAccountId?: string | null;
}) {
  const filteredDebtEntries = debtEntriesRaw.filter(
    (entry) => selectedDebtAccountIds.has(entry.accountId ?? "") || selectedDebtAccountIds.has(entry.toAccountId ?? ""),
  );
  const filteredDebtInterestEntries = debtEntriesRaw.filter(
    (entry) =>
      entry.type !== TransactionType.transfer &&
      (
        selectedDebtAccountIds.has(entry.toAccountId ?? "") ||
        (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
      ) &&
      (
        String(entry.source ?? "").includes("interest") ||
        String(entry.categoryName ?? "").includes("利息") ||
        String(entry.note ?? "").includes("利息")
      ),
  );
  const filteredDebtFeeEntries = debtEntriesRaw.filter(
    (entry) =>
      entry.type !== TransactionType.transfer &&
      (
        selectedDebtAccountIds.has(entry.toAccountId ?? "") ||
        (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
      ) &&
      (
        String(entry.source ?? "").includes("fee") ||
        String(entry.categoryName ?? "").includes("手续费") ||
        String(entry.note ?? "").includes("违约金")
      ),
  );
  const principalKey = (entry: DebtMetricEntry) => debtPrincipalKey(entry, selectedDebtAccountIds, displayAccountId);
  const debtInterestByPrincipalKey = new Map<string, number>();
  const lockedDebtInterestKeys = new Set<string>();
  for (const entry of filteredDebtInterestEntries) {
    const source = String(entry.source ?? "");
    if (source.startsWith("debt_") && source.includes("interest")) {
      lockedDebtInterestKeys.add(principalKey(entry));
    }
  }
  for (const entry of filteredDebtInterestEntries) {
    const key = principalKey(entry);
    if (String(entry.source ?? "") === "scheduled_task" && lockedDebtInterestKeys.has(key)) continue;
    debtInterestByPrincipalKey.set(key, (debtInterestByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
  }
  const debtFeeByPrincipalKey = new Map<string, number>();
  for (const entry of filteredDebtFeeEntries) {
    const key = principalKey(entry);
    debtFeeByPrincipalKey.set(key, (debtFeeByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
  }
  const filteredDebtPrincipalEntries = filteredDebtEntries.filter((entry) => entry.type === TransactionType.transfer);
  const debtBalanceByEntryId = new Map<string, number>();
  const debtBalanceTimeline: Array<{ date: string; balance: number }> = [];
  let runningDebtBalance = 0;
  for (const entry of [...filteredDebtPrincipalEntries].sort((a, b) => compareDetailEntriesAsc(a, b, displayAccountId))) {
    const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
    runningDebtBalance += displayAmount;
    debtBalanceByEntryId.set(entry.id, runningDebtBalance);
    debtBalanceTimeline.push({
      date: debtMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10),
      balance: runningDebtBalance,
    });
  }
  const getDebtRemainingPrincipalBeforeDate = (dateKey: string) => {
    let balanceBeforeDate: number | null = null;
    for (const item of debtBalanceTimeline) {
      if (item.date >= dateKey) break;
      balanceBeforeDate = item.balance;
    }
    return Math.abs(balanceBeforeDate ?? selectedDebtRow?.net ?? 0);
  };

  const debtDetailEntries: DebtDetailEntry[] = filteredDebtPrincipalEntries.map((entry) => {
    const amount = toNumber(entry.amount);
    const isToDebtAccount = selectedDebtAccountIds.has(entry.toAccountId ?? "");
    const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
    const cashFlowAmount = debtCashFlowForAccountSide(entry, selectedDebtAccountIds);
    const interestAmount = Math.abs(toNumber(entry.debtInterestAmount)) + (debtInterestByPrincipalKey.get(principalKey(entry)) ?? 0);
    const feeAmount = Math.abs(toNumber(entry.debtFeeAmount)) + (debtFeeByPrincipalKey.get(principalKey(entry)) ?? 0);
    const isSelectedBankLoan = selectedDebtRow?.objectType === "银行贷款";
    const paymentTotal = isSelectedBankLoan
      ? interestAmount > 0 || feeAmount > 0 || entry.source === "debt_repay_out" || entry.source === "debt_prepay_out" || entry.source === "debt_collect_in" || entry.source === "scheduled_task"
        ? debtPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount
        : null
      : cashFlowAmount > 0
        ? Math.abs(cashFlowAmount) + interestAmount + feeAmount
        : null;
    const debtSideAccountId = isToDebtAccount ? (entry.toAccountId ?? "") : (entry.accountId ?? "");
    const cashSideAccountId = isToDebtAccount ? (entry.accountId ?? "") : (entry.toAccountId ?? "");
    const relatedDebtDirection =
      debtDirectionByAccountId.get(debtSideAccountId) ??
      ((selectedDebtRow?.net ?? 0) >= 0 ? "receivable" : "payable");
    const inferredDirection = relatedDebtDirection ?? ((selectedDebtRow?.net ?? 0) >= 0 ? "receivable" : "payable");
    const debtEditMode =
      entry.source === "debt_borrow_in" || entry.source === "debt_financed_purchase"
        ? ("borrow_in" as const)
        : entry.source === "debt_lend_out"
          ? ("lend_out" as const)
          : entry.source === "debt_collect_in"
            ? ("collect_in" as const)
            : entry.source === "debt_prepay_out"
              ? ("prepay_out" as const)
              : entry.source === "debt_repay_out" || entry.source === "scheduled_task"
                ? ("repay_out" as const)
                : isToDebtAccount
                  ? (inferredDirection === "receivable" ? ("lend_out" as const) : ("repay_out" as const))
                  : (inferredDirection === "receivable" ? ("collect_in" as const) : ("borrow_in" as const));
    const entryDate = debtMetricDisplayDate(entry, displayAccountId);
    const entryDateKey = entryDate.toISOString().slice(0, 10);
    const defaultRecalculateStartDate =
      selectedRepaymentPlan &&
      (entry.regularInvestPlanId
        ? entry.regularInvestPlanId === selectedRepaymentPlan.id
        : selectedDebtAccountIds.has(debtSideAccountId))
        ? formatDateUtc(
            entry.regularInvestPlanId
              ? calcNextScheduledRunDate(
                  entryDate,
                  selectedRepaymentPlan.intervalUnit,
                  selectedRepaymentPlan.intervalValue,
                  selectedRepaymentPlan.executionDay,
                  false,
                )
              : calcInitialScheduledRunDate(
                  entryDate,
                  selectedRepaymentPlan.intervalUnit,
                  selectedRepaymentPlan.intervalValue,
                  selectedRepaymentPlan.executionDay,
                  false,
                ),
          )
        : null;

    return {
      id: entry.id,
      date: entryDateKey,
      typeLabel: entry.source === "advance"
        ? (entry.categoryName || "代付")
        : entry.type === TransactionType.transfer
          ? isSelectedBankLoan
            ? bankDebtTransferTypeLabel(entry.source, debtEditMode)
            : normalizeSettlementTransferCategoryName(entry.categoryName)
          : (entry.categoryName || formatDebtEntryType(entry.type)),
      relatedAccountLabel: accountLabelById.get(cashSideAccountId) ?? "-",
      note: entry.note ?? "",
      amount: displayAmount,
      principal: cashFlowAmount,
      interest: interestAmount,
      paymentTotal,
      balance: debtBalanceByEntryId.get(entry.id) ?? 0,
      debtEdit: entry.type === TransactionType.transfer && entry.source !== "advance"
        ? {
            editEntryId: entry.id,
            mode: debtEditMode,
            defaultDebtAccountId: debtSideAccountId,
            defaultCashAccountId: entry.source === "debt_financed_purchase" ? (selectedRepaymentPlan?.cashAccountId ?? "") : cashSideAccountId,
            defaultLoanFundingMode: entry.source === "debt_financed_purchase" ? "financed_purchase" as const : "cash_disbursement" as const,
            defaultDate: entryDateKey,
            defaultPrincipal: displayAmount,
            defaultInterest: interestAmount,
            defaultPenalty: Math.abs(toNumber(entry.debtFeeAmount)),
            defaultRecalculateStartDate,
            defaultPrepayStrategy: entry.source === "debt_prepay_out"
              ? parseLoanPrepayStrategy(entry.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
              : undefined,
          }
        : undefined,
      edit: entry.source === "advance"
        ? {
            type: "advance" as const,
            date: entryDateKey,
            amount: isToDebtAccount ? Math.abs(amount) : -Math.abs(amount),
            note: entry.note ?? "",
            accountId: cashSideAccountId,
            categoryId: entry.categoryId ?? "",
            counterpartyInstitutionId: entry.counterpartyInstitutionId ?? "",
          }
        : entry.type === TransactionType.transfer
          ? {
              type: "transfer" as const,
              date: entryDateKey,
              amount: Math.abs(amount),
              note: entry.note ?? "",
              fromAccountId: entry.accountId ?? "",
              toAccountId: entry.toAccountId ?? "",
            }
          : {
              type: entry.type === TransactionType.income ? "income" as const : "expense" as const,
              date: entryDateKey,
              amount: Math.abs(amount),
              note: entry.note ?? "",
              accountId: entry.accountId ?? "",
              categoryId: entry.categoryId ?? "",
            },
    };
  });

  if (selectedDebtRow && selectedRepaymentPlan) {
    const paidPrincipalEntries = [...filteredDebtPrincipalEntries]
      .sort((a, b) => compareDetailEntriesAsc(a, b, displayAccountId))
      .filter((entry) => {
        const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
        if (displayAmount <= 0) return false;
        const source = String(entry.source ?? "");
        return (
          source === "debt_repay_out" ||
          source === "debt_prepay_out" ||
          source === "scheduled_task" ||
          (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
        );
      });
    let paidRepaymentPeriod = 0;
    for (const entry of paidPrincipalEntries) {
      const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
      const interestAmount = Math.abs(toNumber(entry.debtInterestAmount)) + (debtInterestByPrincipalKey.get(principalKey(entry)) ?? 0);
      const feeAmount = Math.abs(toNumber(entry.debtFeeAmount)) + (debtFeeByPrincipalKey.get(principalKey(entry)) ?? 0);
      const isPrepayment = entry.source === "debt_prepay_out";
      if (!isPrepayment) paidRepaymentPeriod += 1;
      repaymentScheduleRows.push({
        rowType: "payment",
        status: "paid",
        eventType: isPrepayment ? "prepayment" : "repayment",
        period: isPrepayment ? 0 : paidRepaymentPeriod,
        date: debtMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10),
        payment: debtPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount,
        principal: Math.abs(displayAmount),
        interest: interestAmount,
        remainingPrincipal: Math.abs(debtBalanceByEntryId.get(entry.id) ?? 0),
        annualRate: null,
      });
    }

    const existingRateRows = new Set(repaymentScheduleRows.filter((row) => row.rowType === "rate_adjustment").map((row) => row.date));
    const nextRunDateKey = selectedRepaymentPlan.nextRunDate ? formatDateUtc(selectedRepaymentPlan.nextRunDate) : "";
    for (const adjustment of normalizeLoanRateAdjustments(selectedDebtRow.loanRateAdjustments)) {
      if (existingRateRows.has(adjustment.effectiveDate)) continue;
      repaymentScheduleRows.push({
        rowType: "rate_adjustment",
        status: nextRunDateKey && adjustment.effectiveDate >= nextRunDateKey ? "planned" : "paid",
        eventType: "rate_adjustment",
        period: 0,
        date: adjustment.effectiveDate,
        payment: 0,
        principal: 0,
        interest: 0,
        remainingPrincipal: getDebtRemainingPrincipalBeforeDate(adjustment.effectiveDate),
        annualRate: adjustment.annualRate,
      });
    }
    repaymentScheduleRows.sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate !== 0) return byDate;
      const rank = (row: DebtRepaymentScheduleRow) => row.rowType === "rate_adjustment" ? 0 : row.status === "paid" ? 1 : 2;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return a.period - b.period;
    });
  }

  return { debtDetailEntries, repaymentScheduleRows };
}

export function buildDebtRowsViewData({
  debtAccounts,
  cashDisplayBalanceByAccountId,
  loanRepaymentPlanByAccountId,
  loanRateAdjustmentsByAccountId,
  debtBorrowLprDiscountByAccountId,
  selectedAccountId,
  selectedAccountKind,
  debtPersonParam,
}: {
  debtAccounts: DebtViewAccount[];
  cashDisplayBalanceByAccountId: Map<string, number>;
  loanRepaymentPlanByAccountId: Map<string, DebtViewPlan>;
  loanRateAdjustmentsByAccountId: Map<string, Array<{ effectiveDate: string; annualRate: number }>>;
  debtBorrowLprDiscountByAccountId: Map<string, number>;
  selectedAccountId?: string | null;
  selectedAccountKind?: AccountKind | null;
  debtPersonParam: string;
}) {
  const debtRowMap = new Map<string, DebtViewRow>();
  const debtGroupKeyByAccountId = new Map<string, string>();
  const debtGroupKeyByInstitutionId = new Map<string, string>();
  const debtGroupKeyByCounterpartyId = new Map<string, string>();
  const ordinaryDebtAccountIds: string[] = [];

  for (const account of debtAccounts) {
    const institutionName = (account.Institution?.shortName?.trim() || account.Institution?.name || "").trim();
    const counterpartyName = (account.Counterparty?.shortName?.trim() || account.Counterparty?.name || "").trim();
    const objectName = counterpartyName || institutionName || account.name;
    const defaultItemName = objectName ? `${objectName}的往来款` : "";
    const itemName = objectName && (account.name === defaultItemName || account.name === objectName)
      ? "往来款"
      : account.name;
    const balance = cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    const loanPlan = loanRepaymentPlanByAccountId.get(account.id);
    const isBankSettlementAccount = !!account.institutionId && account.Institution?.type === "bank";
    if (isBankSettlementAccount && Math.abs(balance) < ACTIVE_DEBT_EPSILON) continue;
    if (!isBankSettlementAccount && !account.isActive && Math.abs(balance) < ACTIVE_DEBT_EPSILON) continue;
    if (!isBankSettlementAccount) ordinaryDebtAccountIds.push(account.id);

    const accountRowKey = `account:${account.id}`;
    const accountRowName = objectName && objectName !== itemName ? `${objectName} | ${itemName}` : account.name;
    const accountObjectType = isBankSettlementAccount
      ? account.debtDirection === DebtDirection.receivable ? "银行应收" : "银行贷款"
      : account.Counterparty?.type === "person" || account.Institution?.type === "person"
        ? "个人往来"
        : "组织往来";
    debtGroupKeyByAccountId.set(account.id, accountRowKey);
    if (account.institutionId) debtGroupKeyByInstitutionId.set(account.institutionId, accountRowKey);
    if (account.counterpartyId) debtGroupKeyByCounterpartyId.set(account.counterpartyId, accountRowKey);

    const loanMemo = loanPlan ? decodeScheduledTaskMemo(loanPlan.memo) : null;
    const loanRateAdjustments = resolveLoanRateAdjustments({
      tableAdjustments: loanPlan ? loanRateAdjustmentsByAccountId.get(account.id) : [],
      memoAdjustments: loanMemo?.loanRateAdjustments,
    });
    const remainingRuns = loanPlan?.totalRuns == null
      ? null
      : Math.max(0, loanPlan.totalRuns - Math.max(0, loanPlan.executedRuns ?? 0));
    const nextRunDateKey = loanPlan?.nextRunDate ? formatDateUtc(loanPlan.nextRunDate) : "";
    const nextEffectiveAnnualRate = loanMemo
      ? getEffectiveLoanAnnualRate({
          baseAnnualRate: loanMemo.annualRate,
          adjustments: loanRateAdjustments,
          date: nextRunDateKey,
        })
      : null;
    const loanIntervalMonths = loanMemo?.repaymentIntervalMonths ?? (loanPlan?.intervalUnit === IntervalUnit.month ? loanPlan.intervalValue : null);
    const nextPreviousRunDateKey = loanPlan?.lastRunDate
      ? formatDateUtc(loanPlan.lastRunDate)
      : loanPlan?.startDate
        ? formatDateUtc(loanPlan.startDate)
        : null;
    const nextPeriodStartScheduledAmount = loanPlan && balance < 0
      ? calcLoanScheduledAmountForPeriodStart({
          repaymentMethod: loanMemo?.repaymentMethod,
          baseAnnualRate: loanMemo?.annualRate,
          adjustments: loanRateAdjustments,
          intervalMonths: loanIntervalMonths,
          scheduledAmount: toNumber(loanPlan.amount),
          remainingPrincipal: Math.abs(balance),
          remainingRuns: remainingRuns ?? 1,
          periodStartDate: nextPreviousRunDateKey,
        })
      : 0;
    const nextRepaymentParts = loanPlan && balance < 0
      ? calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: loanMemo?.repaymentMethod,
          baseAnnualRate: loanMemo?.annualRate,
          adjustments: loanRateAdjustments,
          intervalMonths: loanIntervalMonths,
          scheduledAmount: nextPeriodStartScheduledAmount,
          remainingPrincipal: Math.abs(balance),
          remainingRuns: remainingRuns ?? 1,
          previousRunDate: nextPreviousRunDateKey,
          runDate: nextRunDateKey,
        })
      : null;
    const repaymentCycle = loanPlan
      ? (() => {
          const intervalMonths = loanMemo?.repaymentIntervalMonths ?? (loanPlan.intervalUnit === IntervalUnit.month ? loanPlan.intervalValue : null);
          if (intervalMonths === 1) return "每月";
          if (intervalMonths === 3) return "每季度";
          if (intervalMonths === 6) return "每半年";
          if (intervalMonths === 12 || loanPlan.intervalUnit === IntervalUnit.year) return "每年";
          if (intervalMonths && intervalMonths > 0) return `每${intervalMonths}个月`;
          return loanPlan.intervalUnit === IntervalUnit.day ? `每${loanPlan.intervalValue}天` : "";
        })()
      : "";

    const current = debtRowMap.get(accountRowKey) ?? {
      key: accountRowKey,
      name: accountRowName,
      objectType: accountObjectType,
      objectName,
      itemName,
      accountId: account.id,
      institutionId: account.institutionId ?? "",
      counterpartyId: account.counterpartyId ?? "",
      itemType: balance >= 0 ? "【债权】应收款" : "【债务】应付款",
      repaymentMethod: "",
      repaymentCycle: "",
      annualRate: null,
      mortgageLprDiscount: null,
      remainingRuns: null,
      paidPrincipal: 0,
      paidInterest: 0,
      remainingPrincipal: 0,
      remainingInterest: 0,
      nextRepaymentDate: "",
      nextRepaymentPrincipal: null,
      nextRepaymentInterest: null,
      nextRepaymentCashAccountId: "",
      loanRateAdjustments: [],
      payable: 0,
      receivable: 0,
      net: 0,
      accountCount: 0,
      accountIds: [],
      accountLabels: [],
      parentKey: null,
      depth: 0,
      isGroup: false,
    } satisfies DebtViewRow;

    current.accountCount += 1;
    current.accountIds.push(account.id);
    current.accountLabels.push(accountRowName);
    current.net += balance;
    if (balance >= 0) current.receivable += balance;
    else current.payable += Math.abs(balance);
    if (loanPlan) {
      current.repaymentMethod = loanMemo?.repaymentMethod || current.repaymentMethod;
      current.repaymentCycle = repaymentCycle || current.repaymentCycle;
      current.annualRate = nextEffectiveAnnualRate ?? current.annualRate;
      current.mortgageLprDiscount =
        loanMemo?.mortgageLprDiscount ??
        debtBorrowLprDiscountByAccountId.get(account.id) ??
        inferMortgageLprDiscountFromRateAdjustments(loanRateAdjustments) ??
        current.mortgageLprDiscount;
      current.remainingRuns = remainingRuns ?? current.remainingRuns;
      current.nextRepaymentDate = loanPlan.nextRunDate ? formatDateUtc(loanPlan.nextRunDate) : current.nextRepaymentDate;
      current.nextRepaymentPrincipal = nextRepaymentParts?.principal ?? current.nextRepaymentPrincipal;
      current.nextRepaymentInterest = nextRepaymentParts?.interest ?? current.nextRepaymentInterest;
      current.nextRepaymentCashAccountId = loanPlan.cashAccountId ?? current.nextRepaymentCashAccountId;
      current.loanRateAdjustments = loanRateAdjustments;
    }
    current.itemType = current.net >= 0 ? "【债权】应收款" : "【债务】应付款";
    current.remainingPrincipal = Math.abs(current.net);
    debtRowMap.set(accountRowKey, current);
  }

  const debtRows = Array.from(debtRowMap.values()).sort((a, b) => {
    const amountDiff = (b.payable + b.receivable) - (a.payable + a.receivable);
    if (Math.abs(amountDiff) > ACTIVE_DEBT_EPSILON) return amountDiff;
    return a.name.localeCompare(b.name, "zh-CN");
  });
  const derivedDebtKey = selectedAccountKind === AccountKind.loan && selectedAccountId
    ? debtGroupKeyByAccountId.get(selectedAccountId) ?? `account:${selectedAccountId}`
    : "";
  const legacyInstitutionDebtRow = debtPersonParam.startsWith("institution:")
    ? debtRows.find((row) => row.key === debtGroupKeyByInstitutionId.get(debtPersonParam.slice("institution:".length)))
    : null;
  const legacyCounterpartyDebtRow = debtPersonParam.startsWith("counterparty:")
    ? debtRows.find((row) => row.key === debtGroupKeyByCounterpartyId.get(debtPersonParam.slice("counterparty:".length)))
    : null;
  const selectedDebtKey = debtRows.some((row) => row.key === debtPersonParam)
    ? debtPersonParam
    : legacyInstitutionDebtRow
      ? legacyInstitutionDebtRow.key
    : legacyCounterpartyDebtRow
      ? legacyCounterpartyDebtRow.key
    : debtRows.some((row) => row.key === derivedDebtKey)
      ? derivedDebtKey
      : "";
  const selectedDebtRow = debtRows.find((row) => row.key === selectedDebtKey) ?? null;
  const ordinaryDebtAccountIdSet = new Set(ordinaryDebtAccountIds);
  const selectedDebtRowIsOrdinary = !!selectedDebtRow?.accountIds?.some((id) => ordinaryDebtAccountIdSet.has(id));
  const ordinaryDebtRows = debtRows.filter((row) => row.accountIds.some((id) => ordinaryDebtAccountIdSet.has(id)));
  const debtRowsForShell = selectedDebtRow && !selectedDebtRowIsOrdinary
    ? debtRows.filter((row) => row.key === selectedDebtRow.key)
    : ordinaryDebtRows;
  const selectedDebtObjectValue = selectedDebtRow?.counterpartyId
    ? `counterparty:${selectedDebtRow.counterpartyId}`
    : selectedDebtRow?.institutionId
      ? `institution:${selectedDebtRow.institutionId}`
      : "";
  const totalDebtPayable = debtRows.reduce((sum, row) => sum + row.payable, 0);
  const totalDebtReceivable = debtRows.reduce((sum, row) => sum + row.receivable, 0);

  return {
    debtRows,
    debtRowsForShell,
    selectedDebtKey,
    selectedDebtRow,
    selectedDebtObjectValue,
    ordinaryDebtAccountIds,
    totalDebtPayable,
    totalDebtReceivable,
  };
}

export function buildDebtRepaymentScheduleRows({
  selectedDebtRow,
  selectedRepaymentPlan,
}: {
  selectedDebtRow: DebtViewRow | null;
  selectedRepaymentPlan: DebtViewPlan | null;
}): DebtRepaymentScheduleRow[] {
  const selectedRepaymentMemo = selectedRepaymentPlan ? decodeScheduledTaskMemo(selectedRepaymentPlan.memo) : null;
  const selectedRemainingRuns = selectedRepaymentPlan?.totalRuns == null
    ? null
    : Math.max(0, selectedRepaymentPlan.totalRuns - Math.max(0, selectedRepaymentPlan.executedRuns ?? 0));
  const repaymentScheduleRows: DebtRepaymentScheduleRow[] = [];
  if (!selectedDebtRow || !selectedRepaymentPlan || selectedDebtRow.net >= -ACTIVE_DEBT_EPSILON) return repaymentScheduleRows;

  let remainingPrincipal = Math.abs(selectedDebtRow.net);
  let runDate = selectedRepaymentPlan.nextRunDate;
  let lastScheduleDate = selectedRepaymentPlan.lastRunDate ?? selectedRepaymentPlan.startDate;
  const rateAdjustments = normalizeLoanRateAdjustments(selectedDebtRow.loanRateAdjustments);
  const emittedAdjustmentKeys = new Set<string>();
  const maxRuns = Math.min(selectedRemainingRuns ?? 24, 360);
  let scheduledAmountForRun = calcLoanScheduledAmountForPeriodStart({
    repaymentMethod: selectedRepaymentMemo?.repaymentMethod,
    baseAnnualRate: selectedRepaymentMemo?.annualRate,
    adjustments: rateAdjustments,
    intervalMonths: selectedRepaymentMemo?.repaymentIntervalMonths ?? (selectedRepaymentPlan.intervalUnit === IntervalUnit.month ? selectedRepaymentPlan.intervalValue : null),
    scheduledAmount: toNumber(selectedRepaymentPlan.amount),
    remainingPrincipal,
    remainingRuns: selectedRemainingRuns ?? maxRuns,
    periodStartDate: formatDateUtc(lastScheduleDate),
  });
  for (let index = 0; index < maxRuns && remainingPrincipal > ACTIVE_DEBT_EPSILON; index++) {
    const runDateKey = formatDateUtc(runDate);
    const lastScheduleDateKey = formatDateUtc(lastScheduleDate);
    for (const adjustment of rateAdjustments) {
      if (
        adjustment.effectiveDate > lastScheduleDateKey &&
        adjustment.effectiveDate <= runDateKey &&
        !emittedAdjustmentKeys.has(adjustment.effectiveDate)
      ) {
        repaymentScheduleRows.push({
          rowType: "rate_adjustment",
          status: "planned",
          eventType: "rate_adjustment",
          period: 0,
          date: adjustment.effectiveDate,
          payment: 0,
          principal: 0,
          interest: 0,
          remainingPrincipal,
          annualRate: adjustment.annualRate,
        });
        emittedAdjustmentKeys.add(adjustment.effectiveDate);
      }
    }
    const remainingRunsForThisRun = selectedRemainingRuns == null ? Math.max(1, maxRuns - index) : Math.max(1, selectedRemainingRuns - index);
    const parts = calcLoanRunPartsWithRateAdjustments({
      repaymentMethod: selectedRepaymentMemo?.repaymentMethod,
      baseAnnualRate: selectedRepaymentMemo?.annualRate,
      adjustments: rateAdjustments,
      intervalMonths: selectedRepaymentMemo?.repaymentIntervalMonths ?? (selectedRepaymentPlan.intervalUnit === IntervalUnit.month ? selectedRepaymentPlan.intervalValue : null),
      scheduledAmount: scheduledAmountForRun,
      remainingPrincipal,
      remainingRuns: remainingRunsForThisRun,
      previousRunDate: lastScheduleDateKey,
      runDate: runDateKey,
    });
    scheduledAmountForRun = parts.scheduledAmount;
    const nextRemainingPrincipal = Math.max(0, Math.round((remainingPrincipal - parts.principal) * 100) / 100);
    repaymentScheduleRows.push({
      rowType: "payment",
      status: "planned",
      eventType: "repayment",
      period: Math.max(0, selectedRepaymentPlan.executedRuns ?? 0) + index + 1,
      date: runDateKey,
      payment: parts.payment,
      principal: parts.principal,
      interest: parts.interest,
      remainingPrincipal: nextRemainingPrincipal,
      annualRate: parts.annualRate,
    });
    remainingPrincipal = nextRemainingPrincipal;
    lastScheduleDate = runDate;
    runDate = calcNextScheduledRunDate(
      runDate,
      selectedRepaymentPlan.intervalUnit,
      selectedRepaymentPlan.intervalValue,
      selectedRepaymentPlan.executionDay,
      false,
    );
  }

  return repaymentScheduleRows;
}
