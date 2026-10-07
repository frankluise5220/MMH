import { AccountKind, LiabilityDirection, IntervalUnit, TransactionType } from "@prisma/client";

import { toNumber, formatDateUtc, formatDateLocal, parseDateInputToUtc } from "@/lib/date-utils";
import { liabilityPrincipalForAccountSide as canonicalLiabilityPrincipalForAccountSide } from "@/lib/liability";
import { normalizeSettlementTransferCategoryName } from "@/lib/default-categories";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import {
  calcLoanRunPartsWithRateAdjustments,
  getEffectiveLoanAnnualRate,
  normalizeLoanRateAdjustments,
  normalizeLoanRepaymentMethod,
} from "@/lib/loan-repayment";
import { resolveLoanRepaymentCoverage, resolveLoanRepaymentPeriodForDate } from "@/lib/loan-repayment-period";
import { inferMortgageLprDiscountFromRateAdjustments } from "@/lib/loan-lpr";
import { decodeScheduledTaskMemo, getLoanScheduledPlanRole } from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { resolveLoanType } from "@/lib/account-kind-utils";
import { normalizeLoanType, type LoanTypeValue } from "@/lib/loan-type";
import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  getBalanceReconcileTarget,
} from "@/lib/balance-reconcile";

export const ACTIVE_LIABILITY_EPSILON = 0.005;

const SETTLEMENT_ACCOUNT_SUFFIX = "\u7684\u5f80\u6765\u6b3e";
const SETTLEMENT_ITEM_NAME = "\u5f80\u6765\u6b3e";
const BANK_LOAN_OBJECT_TYPE = "\u94f6\u884c\u8d37\u6b3e";
const BANK_RECEIVABLE_OBJECT_TYPE = "\u94f6\u884c\u5e94\u6536";
const PERSONAL_SETTLEMENT_OBJECT_TYPE = "\u4e2a\u4eba\u5f80\u6765";
const ORGANIZATION_SETTLEMENT_OBJECT_TYPE = "\u7ec4\u7ec7\u5f80\u6765";
const RECEIVABLE_ITEM_TYPE = "\u3010\u503a\u6743\u3011\u5e94\u6536\u6b3e";
const PAYABLE_ITEM_TYPE = "\u3010\u503a\u52a1\u3011\u5e94\u4ed8\u6b3e";
const FINANCED_PURCHASE_LABEL = "\u6d88\u8d39\u5206\u671f";
const LOAN_DISBURSEMENT_LABEL = "\u8d37\u6b3e\u53d1\u653e";
const LOAN_REPAYMENT_LABEL = "\u8d37\u6b3e\u8fd8\u6b3e";
const LOAN_PREPAYMENT_LABEL = "\u63d0\u524d\u8fd8\u6b3e";
const BANK_LENDING_LABEL = "\u94f6\u884c\u653e\u6b3e";
const BANK_COLLECTION_LABEL = "\u94f6\u884c\u6536\u56de";

function roundLiabilityDisplayMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function signedRemainingTotal(net: number, remainingPrincipal: number, remainingInterest: number) {
  const total = roundLiabilityDisplayMoney(Math.abs(remainingPrincipal) + Math.abs(remainingInterest));
  if (Math.abs(net) < ACTIVE_LIABILITY_EPSILON) return 0;
  return net < 0 ? -total : total;
}

/** Keep this aligned with LiabilityShell.isSettledLiabilityRow (SETTLED_LIABILITY_EPSILON = 0.005). */
function isSettledLiabilityViewRow(row: LiabilityViewRow) {
  return Math.abs(row.net) < ACTIVE_LIABILITY_EPSILON && row.payable + row.receivable < ACTIVE_LIABILITY_EPSILON;
}

export type LiabilityViewAccount = {
  id: string;
  name: string;
  balance: unknown;
  kind: AccountKind;
  isActive: boolean;
  liabilityDirection?: LiabilityDirection | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
  Institution?: {
    name?: string | null;
    shortName?: string | null;
    type?: string | null;
  } | null;
  Counterparty?: {
    name?: string | null;
    shortName?: string | null;
    type?: string | null;
    isReimbursable?: boolean | null;
  } | null;
};

export type LiabilityViewPlan = {
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

export type LiabilityViewRow = {
  key: string;
  name: string;
  objectType: string;
  objectName: string;
  itemName: string;
  /**
   * The account's real stored name. `name` is the row display name, which
   * prepends the object name for non-grouped rows; edit dialogs must prefill
   * from `accountName` so saving never writes the display prefix back into
   * the account name (that is how "农行 | 农行 | 材料款" accumulated).
   */
  accountName: string;
  accountId: string;
  institutionId: string;
  counterpartyId: string;
  /** Whether this row's counterparty allows reimbursements; gates the row toolbar entry. */
  counterpartyReimbursementEnabled: boolean;
  isConsumerLoan?: boolean | null;
  loanType?: LoanTypeValue | null;
  itemType: string;
  repaymentMethod: string;
  repaymentCycle: string;
  baseAnnualRate: number | null;
  annualRate: number | null;
  mortgageLprDiscount: number | null;
  loanStartDate: string;
  remainingRuns: number | null;
  paidPrincipal: number;
  paidInterest: number;
  remainingPrincipal: number;
  remainingInterest: number;
  remainingTotal: number;
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
  isLoan: boolean;
};

export type LiabilityRepaymentScheduleRow = {
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

export type LiabilityDetailEntry = {
  id: string;
  date: string;
  typeLabel: string;
  relatedAccountLabel: string;
  relatedAccountTitle?: string;
  collateralLabel?: string | null;
  note: string;
  amount: number;
  principal: number;
  interest: number;
  paymentTotal: number | null;
  balance: number;
  balanceReconcileEdit?: {
    entryId: string;
    accountId: string;
    accountName: string;
    date: string;
    amount: number;
  };
  liabilityEdit?: {
    editEntryId: string;
    mode: "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
    defaultLiabilityAccountId: string;
    defaultLiabilityAccountName?: string | null;
    defaultLoanPurposeCategoryId?: string | null;
    defaultCashAccountId: string;
    defaultAutoDebitCashAccountId?: string;
    defaultFixedAssetAccountId?: string;
    defaultFixedAssetAssetId?: string;
    defaultDate: string;
    defaultPrincipal: number;
    defaultInterest: number;
    defaultNote?: string | null;
    defaultPenalty?: number;
    defaultRecalculateStartDate?: string | null;
    defaultPrepayStrategy?: string;
    defaultLoanFundingMode?: "cash_disbursement" | "financed_purchase";
    defaultRepaymentMethod?: string | null;
    defaultAnnualRate?: number | null;
    defaultMortgageLprDiscount?: number | null;
    defaultRepaymentIntervalMonths?: number | null;
    defaultLoanTotalRuns?: number | null;
    defaultFirstBillDate?: string | null;
    defaultFirstRepaymentDate?: string | null;
    defaultAutoDebit?: boolean | null;
    defaultAutoDebitFirstDate?: string | null;
    defaultLoanRateAdjustments?: Array<{ effectiveDate: string; annualRate: number }>;
    defaultTagIds?: string[] | null;
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

type LiabilityEntryMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

function formatLiabilityEntryType(type: string) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "advance") return "代付";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
  return type;
}

function bankLiabilityTransferTypeLabel(source: string | null | undefined, mode: LiabilityEntryMode) {
  if (source === "liability_financed_purchase") return FINANCED_PURCHASE_LABEL;
  if (mode === "borrow_in") return LOAN_DISBURSEMENT_LABEL;
  if (mode === "repay_out") return LOAN_REPAYMENT_LABEL;
  if (mode === "prepay_out") return LOAN_PREPAYMENT_LABEL;
  if (mode === "lend_out") return BANK_LENDING_LABEL;
  if (mode === "collect_in") return BANK_COLLECTION_LABEL;
  return BANK_LOAN_OBJECT_TYPE;
}

export type LiabilityMetricEntry = {
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
  principalAmount?: unknown;
  interestAmount?: unknown;
  feeAmount?: unknown;
  regularInvestPlanId?: string | null;
  installmentNo?: number | null;
  fundSubtype?: string | null;
  fundConfirmDate?: Date | null;
  fundArrivalDate?: Date | null;
  EntryTag?: Array<{ tagId?: string | null }>;
};

function getLiabilityBalanceReconcileTarget(entry: LiabilityMetricEntry) {
  if (entry.source !== BALANCE_RECONCILE_SOURCE && entry.source !== BALANCE_INITIALIZATION_SOURCE) return null;
  return getBalanceReconcileTarget(entry);
}

export function liabilityPrincipalForAccountSide(
  entry: { amount: unknown; principalAmount?: unknown; source?: string | null; accountId?: string | null; toAccountId?: string | null },
  liabilityAccountIds: Set<string>,
) {
  return canonicalLiabilityPrincipalForAccountSide(entry, liabilityAccountIds);
}

export function liabilityCashFlowForAccountSide(
  entry: { amount: unknown; principalAmount?: unknown; source?: string | null; accountId?: string | null; toAccountId?: string | null },
  liabilityAccountIds: Set<string>,
) {
  const amount = toNumber(entry.amount);
  const principal = entry.principalAmount == null ? Math.abs(amount) : toNumber(entry.principalAmount);
  const source = String(entry.source ?? "");
  if (source === "liability_borrow_in") return principal;
  if (source === "liability_financed_purchase") return 0;
  if (source === "liability_repay_out" || source === "liability_prepay_out" || source === "liability_lend_out" || source === "scheduled_task") return -principal;
  if (source === "liability_collect_in") return principal;
  return liabilityAccountIds.has(entry.accountId ?? "") ? -amount : amount;
}

export function liabilityPaymentTotal(
  entry: { amount: unknown; principalAmount?: unknown; interestAmount?: unknown; feeAmount?: unknown },
  fallbackInterest = 0,
  fallbackFee = 0,
) {
  const hasStructuredSplit =
    entry.principalAmount != null ||
    entry.interestAmount != null ||
    entry.feeAmount != null;
  const principal = entry.principalAmount == null ? Math.abs(toNumber(entry.amount)) : toNumber(entry.principalAmount);
  const interest = Math.abs(toNumber(entry.interestAmount));
  const fee = Math.abs(toNumber(entry.feeAmount));
  if (!hasStructuredSplit) return principal + fallbackInterest + fallbackFee;
  return principal + interest + fee;
}

function liabilityMetricDisplayDate(entry: LiabilityMetricEntry, displayAccountId?: string | null) {
  return getDetailEntryDisplayDate(entry, displayAccountId);
}

function repaymentScheduleStartDate(plan: LiabilityViewPlan) {
  const savedDate = decodeScheduledTaskMemo(plan.memo).firstRepaymentDate;
  return savedDate ? parseDateInputToUtc(savedDate) ?? plan.startDate : plan.startDate;
}

function liabilityPrincipalKey(entry: LiabilityMetricEntry, liabilityAccountIds: Set<string>, displayAccountId?: string | null) {
  const dateKey = liabilityMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10);
  if (entry.regularInvestPlanId) return `plan:${entry.regularInvestPlanId}:${dateKey}`;
  const liabilityAccountId = liabilityAccountIds.has(entry.toAccountId ?? "")
    ? entry.toAccountId
    : liabilityAccountIds.has(entry.accountId ?? "")
      ? entry.accountId
      : "";
  const cashSideAccountId = liabilityAccountIds.has(entry.toAccountId ?? "")
    ? entry.accountId
    : entry.toAccountId;
  return `account:${liabilityAccountId ?? ""}:${dateKey}:${cashSideAccountId ?? ""}`;
}

export function applyLiabilityRowEntryMetrics({
  liabilityRows,
  liabilityEntriesRaw,
  loanRepaymentPlans,
  loanRepaymentPlanByAccountId,
  loanRateAdjustmentsByAccountId,
  displayAccountId,
}: {
  liabilityRows: LiabilityViewRow[];
  liabilityEntriesRaw: LiabilityMetricEntry[];
  loanRepaymentPlans: LiabilityViewPlan[];
  loanRepaymentPlanByAccountId: Map<string, LiabilityViewPlan>;
  loanRateAdjustmentsByAccountId: Map<string, Array<{ effectiveDate: string; annualRate: number }>>;
  displayAccountId?: string | null;
}) {
  const automaticRepaymentPlanIds = new Set(
    loanRepaymentPlans
      .filter((plan) => getLoanScheduledPlanRole(decodeScheduledTaskMemo(plan.memo)) === "auto_debit")
      .map((plan) => plan.id),
  );
  for (const row of liabilityRows) {
    if (row.isGroup) continue;
    const rowAccountIds = new Set(row.accountIds);
    const rowPlanIds = new Set(
      loanRepaymentPlans
        .filter((plan) => rowAccountIds.has(plan.accountId))
        .map((plan) => plan.id),
    );
    const rowPrincipalEntries = liabilityEntriesRaw.filter(
      (entry) =>
        entry.type === TransactionType.transfer &&
        (rowAccountIds.has(entry.accountId ?? "") || rowAccountIds.has(entry.toAccountId ?? "")),
    );
    const rowPrincipalKey = (entry: LiabilityMetricEntry) => liabilityPrincipalKey(entry, rowAccountIds, displayAccountId);
    const rowLockedInterestKeys = new Set<string>();
    for (const entry of liabilityEntriesRaw) {
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
      if (source.startsWith("liability_") && source.includes("interest")) {
        rowLockedInterestKeys.add(rowPrincipalKey(entry));
      }
    }
    const rowInterestByPrincipalKey = new Map<string, number>();
    for (const entry of liabilityEntriesRaw) {
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
      const displayAmount = liabilityPrincipalForAccountSide(entry, rowAccountIds);
      if (displayAmount <= 0) return false;
      const source = String(entry.source ?? "");
      return (
        source === "liability_repay_out" ||
        source === "liability_prepay_out" ||
        (source === "scheduled_task" && !!entry.regularInvestPlanId && automaticRepaymentPlanIds.has(entry.regularInvestPlanId))
      );
    });
    row.paidPrincipal = paidEntries.reduce((sum, entry) => {
      return sum + Math.abs(liabilityPrincipalForAccountSide(entry, rowAccountIds));
    }, 0);
    row.paidInterest = paidEntries.reduce(
      (sum, entry) => sum + Math.abs(toNumber(entry.interestAmount)) + (rowInterestByPrincipalKey.get(rowPrincipalKey(entry)) ?? 0),
      0,
    );
    row.remainingPrincipal = Math.abs(row.net);

    const plan = loanRepaymentPlanByAccountId.get(row.accountId);
    const memo = plan ? decodeScheduledTaskMemo(plan.memo) : null;
    row.remainingInterest = 0;
    if (plan && memo && row.net < -ACTIVE_LIABILITY_EPSILON && plan.nextRunDate) {
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
        mortgageLprDiscount: row.mortgageLprDiscount,
        loanStartDate: row.loanStartDate,
      });
      let scheduledAmountForRun = toNumber(plan.amount);
      for (let index = 0; index < maxRuns && remainingPrincipal > ACTIVE_LIABILITY_EPSILON; index++) {
        const remainingRunsForThisRun = remainingRuns == null ? Math.max(1, maxRuns - index) : Math.max(1, remainingRuns - index);
        const parts = calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: memo.repaymentMethod,
          baseAnnualRate: memo.annualRate,
          adjustments,
          intervalMonths,
          scheduledAmount: scheduledAmountForRun,
          preserveScheduledAmount: true,
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
    row.remainingTotal = signedRemainingTotal(row.net, row.remainingPrincipal, row.remainingInterest);
  }

  const childRowsByParentKey = new Map<string, LiabilityViewRow[]>();
  for (const row of liabilityRows) {
    if (!row.parentKey) continue;
    const childRows = childRowsByParentKey.get(row.parentKey) ?? [];
    childRows.push(row);
    childRowsByParentKey.set(row.parentKey, childRows);
  }
  for (const row of liabilityRows) {
    if (!row.isGroup) continue;
    const childRows = childRowsByParentKey.get(row.key) ?? [];
    if (childRows.length === 0) continue;
    row.payable = childRows.reduce((sum, child) => sum + child.payable, 0);
    row.receivable = childRows.reduce((sum, child) => sum + child.receivable, 0);
    row.net = childRows.reduce((sum, child) => sum + child.net, 0);
    row.paidPrincipal = childRows.reduce((sum, child) => sum + Math.abs(child.paidPrincipal), 0);
    row.paidInterest = childRows.reduce((sum, child) => sum + Math.abs(child.paidInterest), 0);
    row.remainingPrincipal = Math.abs(row.net);
    row.remainingInterest = childRows.reduce((sum, child) => sum + Math.abs(child.remainingInterest), 0);
    row.remainingTotal = signedRemainingTotal(row.net, row.remainingPrincipal, row.remainingInterest);
    row.itemType = row.net >= 0 ? RECEIVABLE_ITEM_TYPE : PAYABLE_ITEM_TYPE;
    row.accountCount = childRows.reduce((sum, child) => sum + child.accountCount, 0);
    row.accountIds = childRows.flatMap((child) => child.accountIds);
    row.accountLabels = childRows.flatMap((child) => child.accountLabels);
  }
}

export function buildLiabilityDetailEntriesViewData({
  liabilityEntriesRaw,
  selectedLiabilityAccountIds,
  selectedLoanRepaymentPlanIds,
  selectedLiabilityRow,
  selectedRepaymentPlan,
  selectedAutoDebitPlan,
  repaymentScheduleRows,
  accountLabelById,
  accountTitleById,
  liabilityDirectionByAccountId,
  displayAccountId,
  mortgagedAssetByLoanAccountId,
  collateralNameByLoanAccountId,
}: {
  liabilityEntriesRaw: LiabilityMetricEntry[];
  selectedLiabilityAccountIds: Set<string>;
  selectedLoanRepaymentPlanIds: Set<string>;
  selectedLiabilityRow: LiabilityViewRow | null;
  selectedRepaymentPlan: LiabilityViewPlan | null;
  selectedAutoDebitPlan?: LiabilityViewPlan | null;
  repaymentScheduleRows: LiabilityRepaymentScheduleRow[];
  accountLabelById: Map<string, string>;
  accountTitleById?: Map<string, string>;
  liabilityDirectionByAccountId: Map<string, LiabilityDirection | string | null>;
  displayAccountId?: string | null;
  mortgagedAssetByLoanAccountId?: Map<string, { accountId: string; id: string }>;
  collateralNameByLoanAccountId?: Map<string, string>;
}) {
  const automaticRepaymentPlanIds = new Set<string>();
  if (selectedAutoDebitPlan?.id) automaticRepaymentPlanIds.add(selectedAutoDebitPlan.id);
  if (selectedRepaymentPlan && getLoanScheduledPlanRole(decodeScheduledTaskMemo(selectedRepaymentPlan.memo)) === "auto_debit") {
    automaticRepaymentPlanIds.add(selectedRepaymentPlan.id);
  }
  const filteredLiabilityEntries = liabilityEntriesRaw.filter(
    (entry) => selectedLiabilityAccountIds.has(entry.accountId ?? "") || selectedLiabilityAccountIds.has(entry.toAccountId ?? ""),
  );
  const filteredLiabilityInterestEntries = liabilityEntriesRaw.filter(
    (entry) =>
      entry.type !== TransactionType.transfer &&
      String(entry.source ?? "") !== "loan_bill" &&
      (
        selectedLiabilityAccountIds.has(entry.toAccountId ?? "") ||
        (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
      ) &&
      (
        String(entry.source ?? "").includes("interest") ||
        String(entry.categoryName ?? "").includes("利息") ||
        String(entry.note ?? "").includes("利息")
      ),
  );
  const filteredLiabilityFeeEntries = liabilityEntriesRaw.filter(
    (entry) =>
      entry.type !== TransactionType.transfer &&
      String(entry.source ?? "") !== "loan_bill" &&
      (
        selectedLiabilityAccountIds.has(entry.toAccountId ?? "") ||
        (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
      ) &&
      (
        String(entry.source ?? "").includes("fee") ||
        String(entry.categoryName ?? "").includes("手续费") ||
        String(entry.note ?? "").includes("违约金")
      ),
  );
  const principalKey = (entry: LiabilityMetricEntry) => liabilityPrincipalKey(entry, selectedLiabilityAccountIds, displayAccountId);
  const liabilityInterestByPrincipalKey = new Map<string, number>();
  const lockedLiabilityInterestKeys = new Set<string>();
  for (const entry of filteredLiabilityInterestEntries) {
    const source = String(entry.source ?? "");
    if (source.startsWith("liability_") && source.includes("interest")) {
      lockedLiabilityInterestKeys.add(principalKey(entry));
    }
  }
  for (const entry of filteredLiabilityInterestEntries) {
    const key = principalKey(entry);
    if (String(entry.source ?? "") === "scheduled_task" && lockedLiabilityInterestKeys.has(key)) continue;
    liabilityInterestByPrincipalKey.set(key, (liabilityInterestByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
  }
  const liabilityFeeByPrincipalKey = new Map<string, number>();
  for (const entry of filteredLiabilityFeeEntries) {
    const key = principalKey(entry);
    liabilityFeeByPrincipalKey.set(key, (liabilityFeeByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
  }
  const filteredLiabilityPrincipalEntries = filteredLiabilityEntries.filter(
    (entry) => entry.type === TransactionType.transfer || getLiabilityBalanceReconcileTarget(entry) != null,
  );
  const liabilityBalanceByEntryId = new Map<string, number>();
  const liabilityDisplayAmountByEntryId = new Map<string, number>();
  const liabilityBalanceTimeline: Array<{ date: string; balance: number }> = [];
  let runningLiabilityBalance = 0;
  for (const entry of [...filteredLiabilityPrincipalEntries].sort((a, b) => compareDetailEntriesAsc(a, b, displayAccountId))) {
    const reconcileTarget = getLiabilityBalanceReconcileTarget(entry);
    const displayAmount = reconcileTarget == null
      ? liabilityPrincipalForAccountSide(entry, selectedLiabilityAccountIds)
      : reconcileTarget - runningLiabilityBalance;
    runningLiabilityBalance = reconcileTarget == null ? runningLiabilityBalance + displayAmount : reconcileTarget;
    liabilityDisplayAmountByEntryId.set(entry.id, displayAmount);
    liabilityBalanceByEntryId.set(entry.id, runningLiabilityBalance);
    liabilityBalanceTimeline.push({
      date: liabilityMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10),
      balance: runningLiabilityBalance,
    });
  }
  const getLiabilityRemainingPrincipalBeforeDate = (dateKey: string) => {
    let balanceBeforeDate: number | null = null;
    for (const item of liabilityBalanceTimeline) {
      if (item.date >= dateKey) break;
      balanceBeforeDate = item.balance;
    }
    return Math.abs(balanceBeforeDate ?? selectedLiabilityRow?.net ?? 0);
  };

  const liabilityDetailEntries: LiabilityDetailEntry[] = filteredLiabilityPrincipalEntries.map((entry) => {
    const amount = toNumber(entry.amount);
    const reconcileTarget = getLiabilityBalanceReconcileTarget(entry);
    const isBalanceReconcile = reconcileTarget != null;
    const isToLiabilityAccount = selectedLiabilityAccountIds.has(entry.toAccountId ?? "");
    const displayAmount = liabilityDisplayAmountByEntryId.get(entry.id) ?? liabilityPrincipalForAccountSide(entry, selectedLiabilityAccountIds);
    const cashFlowAmount = isBalanceReconcile ? displayAmount : liabilityCashFlowForAccountSide(entry, selectedLiabilityAccountIds);
    const interestAmount = Math.abs(toNumber(entry.interestAmount)) + (liabilityInterestByPrincipalKey.get(principalKey(entry)) ?? 0);
    const feeAmount = Math.abs(toNumber(entry.feeAmount)) + (liabilityFeeByPrincipalKey.get(principalKey(entry)) ?? 0);
    const isSelectedBankLoan = selectedLiabilityRow?.isLoan === true;
    const paymentTotal = isSelectedBankLoan
      ? interestAmount > 0 || feeAmount > 0 || entry.source === "liability_repay_out" || entry.source === "liability_prepay_out" || entry.source === "liability_collect_in" || entry.source === "scheduled_task"
        ? liabilityPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount
        : null
      : cashFlowAmount > 0
        ? Math.abs(cashFlowAmount) + interestAmount + feeAmount
        : null;
    const liabilitySideAccountId = isToLiabilityAccount ? (entry.toAccountId ?? "") : (entry.accountId ?? "");
    const cashSideAccountId = isToLiabilityAccount ? (entry.accountId ?? "") : (entry.toAccountId ?? "");
    const relatedLiabilityDirection =
      liabilityDirectionByAccountId.get(liabilitySideAccountId) ??
      ((selectedLiabilityRow?.net ?? 0) >= 0 ? "receivable" : "payable");
    const inferredDirection = relatedLiabilityDirection ?? ((selectedLiabilityRow?.net ?? 0) >= 0 ? "receivable" : "payable");
    const liabilityEditMode =
      entry.source === "liability_borrow_in" || entry.source === "liability_financed_purchase"
        ? ("borrow_in" as const)
        : entry.source === "liability_lend_out"
          ? ("lend_out" as const)
          : entry.source === "liability_collect_in"
            ? ("collect_in" as const)
            : entry.source === "liability_prepay_out"
              ? ("prepay_out" as const)
              : entry.source === "liability_repay_out" || entry.source === "scheduled_task"
                ? ("repay_out" as const)
                : isToLiabilityAccount
                  ? (inferredDirection === "receivable" ? ("lend_out" as const) : ("repay_out" as const))
                  : (inferredDirection === "receivable" ? ("collect_in" as const) : ("borrow_in" as const));
    const entryDate = liabilityMetricDisplayDate(entry, displayAccountId);
    const entryDateKey = entryDate.toISOString().slice(0, 10);
    const defaultRecalculateStartDate =
      selectedRepaymentPlan &&
      (entry.regularInvestPlanId
        ? entry.regularInvestPlanId === selectedRepaymentPlan.id
        : selectedLiabilityAccountIds.has(liabilitySideAccountId))
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
      typeLabel: isBalanceReconcile
        ? (entry.source === BALANCE_INITIALIZATION_SOURCE ? "初始余额" : "余额校准")
        : entry.type === TransactionType.income
        ? formatLiabilityEntryType(entry.type)
        : entry.source === "advance"
        ? (entry.categoryName || "代付")
        : entry.type === TransactionType.transfer
          ? isSelectedBankLoan
            ? bankLiabilityTransferTypeLabel(entry.source, liabilityEditMode)
            : normalizeSettlementTransferCategoryName(entry.categoryName)
          : (entry.categoryName || formatLiabilityEntryType(entry.type)),
      relatedAccountLabel: isBalanceReconcile ? "-" : (accountLabelById.get(cashSideAccountId) ?? "-"),
      relatedAccountTitle: isBalanceReconcile ? "" : (accountTitleById?.get(cashSideAccountId) ?? ""),
      collateralLabel: collateralNameByLoanAccountId?.get(liabilitySideAccountId) ?? null,
      note: entry.note ?? "",
      amount: displayAmount,
      principal: cashFlowAmount,
      interest: interestAmount,
      paymentTotal: isBalanceReconcile ? null : paymentTotal,
      balance: liabilityBalanceByEntryId.get(entry.id) ?? 0,
      balanceReconcileEdit: isBalanceReconcile
        ? {
            entryId: entry.id,
            accountId: liabilitySideAccountId,
            accountName: selectedLiabilityRow?.name ?? entry.accountId ?? "",
            date: entryDateKey,
            amount: reconcileTarget,
          }
        : undefined,
      liabilityEdit: !isBalanceReconcile && entry.type === TransactionType.transfer && entry.source !== "advance"
        ? (() => {
            const repaymentMemo = selectedRepaymentPlan ? decodeScheduledTaskMemo(selectedRepaymentPlan.memo) : null;
            const autoDebitMemo = selectedAutoDebitPlan ? decodeScheduledTaskMemo(selectedAutoDebitPlan.memo) : null;
            const isLoanRepaymentPlan = repaymentMemo?.type === "loan_repayment";
            const isLoanAutoDebitPlan = autoDebitMemo?.type === "loan_repayment";
            const defaultAutoDebitCashAccountId = selectedAutoDebitPlan?.cashAccountId ?? selectedRepaymentPlan?.cashAccountId ?? "";
            const mortgagedAsset = mortgagedAssetByLoanAccountId?.get(liabilitySideAccountId);
            const defaultTagIds = Array.from(new Set(
              (entry.EntryTag ?? [])
                .map((item) => item.tagId ?? "")
                .filter(Boolean),
            ));
            return {
              editEntryId: entry.id,
              mode: liabilityEditMode,
              dialogType: isSelectedBankLoan ? "loan" : "settlement",
              defaultLiabilityAccountId: liabilitySideAccountId,
              // Prefill the account's real stored name, not the row display
              // name: `name` already contains the `objectName | itemName`
              // prefix, and writing it back on save re-prepends the
              // institution on every edit (the tripled "农行" bug).
              defaultLiabilityAccountName: selectedLiabilityRow?.accountName ?? null,
              defaultLoanPurposeCategoryId: liabilityEditMode === "borrow_in" ? (entry.categoryId ?? null) : null,
              defaultCashAccountId: entry.source === "liability_financed_purchase" ? defaultAutoDebitCashAccountId : cashSideAccountId,
              defaultAutoDebitCashAccountId,
              defaultFixedAssetAccountId: mortgagedAsset?.accountId,
              defaultFixedAssetAssetId: mortgagedAsset?.id,
              defaultLoanFundingMode: entry.source === "liability_financed_purchase" ? "financed_purchase" as const : "cash_disbursement" as const,
              defaultDate: entryDateKey,
              defaultPrincipal: displayAmount,
              defaultInterest: interestAmount,
              defaultNote: entry.note ?? "",
              defaultPenalty: Math.abs(toNumber(entry.feeAmount)),
              defaultRecalculateStartDate,
              defaultPrepayStrategy: entry.source === "liability_prepay_out"
                ? parseLoanPrepayStrategy(entry.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
                : undefined,
              defaultRepaymentMethod: isLoanRepaymentPlan ? (repaymentMemo.repaymentMethod ?? null) : null,
              defaultAnnualRate: isLoanRepaymentPlan ? (repaymentMemo.annualRate ?? null) : null,
              defaultMortgageLprDiscount: isLoanRepaymentPlan ? (repaymentMemo.mortgageLprDiscount ?? null) : null,
              defaultRepaymentIntervalMonths: isLoanRepaymentPlan ? (repaymentMemo.repaymentIntervalMonths ?? null) : null,
              defaultLoanTotalRuns: isLoanRepaymentPlan ? (repaymentMemo.originalTotalRuns ?? null) : null,
              defaultFirstBillDate: isLoanRepaymentPlan
                ? repaymentMemo.firstBillDate ?? (selectedRepaymentPlan?.startDate ? formatDateUtc(selectedRepaymentPlan.startDate) : null)
                : null,
              defaultFirstRepaymentDate: isLoanRepaymentPlan
                ? repaymentMemo.firstRepaymentDate ?? (selectedRepaymentPlan?.startDate ? formatDateUtc(selectedRepaymentPlan.startDate) : null)
                : null,
              defaultAutoDebit: isLoanRepaymentPlan && (entry.source === "liability_financed_purchase" || entry.source === "liability_borrow_in")
                ? isLoanAutoDebitPlan
                : undefined,
              defaultAutoDebitFirstDate: isLoanRepaymentPlan && isLoanAutoDebitPlan && selectedAutoDebitPlan?.startDate
                ? formatDateUtc(selectedAutoDebitPlan.startDate)
                : isLoanRepaymentPlan && repaymentMemo.firstRepaymentDate
                  ? repaymentMemo.firstRepaymentDate
                  : isLoanRepaymentPlan && selectedRepaymentPlan?.startDate
                    ? formatDateUtc(selectedRepaymentPlan.startDate)
                  : null,
              defaultLoanRateAdjustments: isLoanRepaymentPlan
                ? (selectedLiabilityRow?.loanRateAdjustments ?? repaymentMemo.loanRateAdjustments ?? [])
                : [],
              defaultTagIds,
            };
          })()
        : undefined,
      edit: isBalanceReconcile
        ? undefined
        : entry.source === "advance"
        ? {
            type: "advance" as const,
            date: entryDateKey,
            amount: isToLiabilityAccount ? Math.abs(amount) : -Math.abs(amount),
            note: entry.note ?? "",
            accountId: cashSideAccountId,
            advanceAccountId: liabilitySideAccountId,
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

  if (selectedLiabilityRow && selectedRepaymentPlan) {
    const paidPrincipalEntries = [...filteredLiabilityPrincipalEntries]
      .sort((a, b) => compareDetailEntriesAsc(a, b, displayAccountId))
      .filter((entry) => {
        const displayAmount = liabilityPrincipalForAccountSide(entry, selectedLiabilityAccountIds);
        if (displayAmount <= 0) return false;
        const source = String(entry.source ?? "");
        return (
          source === "liability_repay_out" ||
          source === "liability_prepay_out" ||
          (source === "scheduled_task" && !!entry.regularInvestPlanId && automaticRepaymentPlanIds.has(entry.regularInvestPlanId))
        );
      });
    const paymentByPeriod = new Map<number, {
      principal: number;
      interest: number;
      total: number;
      latestDate: string;
      remainingPrincipal: number;
    }>();
    const prepaymentEntries: LiabilityMetricEntry[] = [];
    for (const entry of paidPrincipalEntries) {
      const displayAmount = liabilityPrincipalForAccountSide(entry, selectedLiabilityAccountIds);
      const interestAmount = Math.abs(toNumber(entry.interestAmount)) + (liabilityInterestByPrincipalKey.get(principalKey(entry)) ?? 0);
      const feeAmount = Math.abs(toNumber(entry.feeAmount)) + (liabilityFeeByPrincipalKey.get(principalKey(entry)) ?? 0);
      const isPrepayment = entry.source === "liability_prepay_out";
      if (isPrepayment) {
        prepaymentEntries.push(entry);
        continue;
      }
      const resolvedPeriod = entry.installmentNo && entry.installmentNo > 0
        ? entry.installmentNo
        : resolveLoanRepaymentPeriodForDate({
            startDate: repaymentScheduleStartDate(selectedRepaymentPlan),
            intervalUnit: selectedRepaymentPlan.intervalUnit,
            intervalValue: selectedRepaymentPlan.intervalValue,
            executionDay: selectedRepaymentPlan.executionDay,
            totalRuns: selectedRepaymentPlan.totalRuns,
          }, liabilityMetricDisplayDate(entry, displayAccountId))?.period ?? null;
      if (!resolvedPeriod) continue;
      const date = liabilityMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10);
      const current = paymentByPeriod.get(resolvedPeriod) ?? {
        principal: 0,
        interest: 0,
        total: 0,
        latestDate: date,
        remainingPrincipal: Math.abs(liabilityBalanceByEntryId.get(entry.id) ?? 0),
      };
      paymentByPeriod.set(resolvedPeriod, {
        principal: current.principal + Math.abs(displayAmount),
        interest: current.interest + interestAmount,
        total: current.total + (liabilityPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount),
        latestDate: current.latestDate > date ? current.latestDate : date,
        remainingPrincipal: Math.abs(liabilityBalanceByEntryId.get(entry.id) ?? current.remainingPrincipal),
      });
    }

    const billByPeriod = new Map<number, LiabilityMetricEntry>();
    for (const entry of liabilityEntriesRaw) {
      if (
        entry.source !== "loan_bill" ||
        entry.regularInvestPlanId !== selectedRepaymentPlan.id ||
        !entry.installmentNo ||
        entry.installmentNo <= 0
      ) continue;
      billByPeriod.set(entry.installmentNo, entry);
    }

    const matchedPaymentPeriods = new Set<number>();
    for (const row of repaymentScheduleRows) {
      if (row.rowType !== "payment" || row.eventType === "prepayment" || row.period <= 0) continue;
      const bill = billByPeriod.get(row.period);
      if (bill) {
        row.principal = Math.abs(toNumber(bill.principalAmount));
        row.interest = Math.abs(toNumber(bill.interestAmount));
        row.payment = Math.max(row.principal + row.interest, Math.abs(toNumber(bill.amount)));
      }
      const paid = paymentByPeriod.get(row.period);
      if (!paid) continue;
      matchedPaymentPeriods.add(row.period);
      const coverage = resolveLoanRepaymentCoverage({
        scheduledPrincipal: row.principal,
        scheduledInterest: row.interest,
        paidPrincipal: paid.principal,
        paidInterest: paid.interest,
        paidTotal: paid.total,
      });
      if (!coverage.paid) continue;
      row.status = "paid";
      row.date = paid.latestDate;
      row.remainingPrincipal = paid.remainingPrincipal;
    }

    for (const [period, paid] of paymentByPeriod) {
      if (matchedPaymentPeriods.has(period)) continue;
      repaymentScheduleRows.push({
        rowType: "payment",
        status: "paid",
        eventType: "repayment",
        period,
        date: paid.latestDate,
        payment: paid.total,
        principal: paid.principal,
        interest: paid.interest,
        remainingPrincipal: paid.remainingPrincipal,
        annualRate: null,
      });
    }

    for (const entry of prepaymentEntries) {
      const displayAmount = liabilityPrincipalForAccountSide(entry, selectedLiabilityAccountIds);
      const interestAmount = Math.abs(toNumber(entry.interestAmount)) + (liabilityInterestByPrincipalKey.get(principalKey(entry)) ?? 0);
      const feeAmount = Math.abs(toNumber(entry.feeAmount)) + (liabilityFeeByPrincipalKey.get(principalKey(entry)) ?? 0);
      repaymentScheduleRows.push({
        rowType: "payment",
        status: "paid",
        eventType: "prepayment",
        period: 0,
        date: liabilityMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10),
        payment: liabilityPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount,
        principal: Math.abs(displayAmount),
        interest: interestAmount,
        remainingPrincipal: Math.abs(liabilityBalanceByEntryId.get(entry.id) ?? 0),
        annualRate: null,
      });
    }

    const existingRateRows = new Set(repaymentScheduleRows.filter((row) => row.rowType === "rate_adjustment").map((row) => row.date));
    const latestPaidRepaymentDate = Array.from(paymentByPeriod.values()).reduce(
      (latest, payment) => payment.latestDate > latest ? payment.latestDate : latest,
      "",
    );
    for (const adjustment of normalizeLoanRateAdjustments(selectedLiabilityRow.loanRateAdjustments)) {
      if (existingRateRows.has(adjustment.effectiveDate)) continue;
      repaymentScheduleRows.push({
        rowType: "rate_adjustment",
        status: latestPaidRepaymentDate && adjustment.effectiveDate <= latestPaidRepaymentDate ? "paid" : "planned",
        eventType: "rate_adjustment",
        period: 0,
        date: adjustment.effectiveDate,
        payment: 0,
        principal: 0,
        interest: 0,
        remainingPrincipal: getLiabilityRemainingPrincipalBeforeDate(adjustment.effectiveDate),
        annualRate: adjustment.annualRate,
      });
    }
    repaymentScheduleRows.sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate !== 0) return byDate;
      const rank = (row: LiabilityRepaymentScheduleRow) => row.rowType === "rate_adjustment" ? 0 : row.status === "paid" ? 1 : 2;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return a.period - b.period;
    });
  }

  return { liabilityDetailEntries, repaymentScheduleRows };
}

export function buildLiabilityRowsViewData({
  liabilityAccounts,
  cashDisplayBalanceByAccountId,
  loanRepaymentPlanByAccountId,
  loanRateAdjustmentsByAccountId,
  liabilityBorrowLprDiscountByAccountId,
  liabilityBorrowStartDateByAccountId,
  selectedAccountId,
  selectedAccountKind,
  liabilityPersonParam,
  liabilityLoanTypeParam,
}: {
  liabilityAccounts: LiabilityViewAccount[];
  cashDisplayBalanceByAccountId: Map<string, number>;
  loanRepaymentPlanByAccountId: Map<string, LiabilityViewPlan>;
  loanRateAdjustmentsByAccountId: Map<string, Array<{ effectiveDate: string; annualRate: number }>>;
  liabilityBorrowLprDiscountByAccountId: Map<string, number>;
  liabilityBorrowStartDateByAccountId?: Map<string, string>;
  selectedAccountId?: string | null;
  selectedAccountKind?: AccountKind | null;
  liabilityPersonParam: string;
  liabilityLoanTypeParam?: string | null;
}) {
  const selectedLiabilityLoanType = normalizeLoanType(liabilityLoanTypeParam);
  const liabilityRowMap = new Map<string, LiabilityViewRow>();
  const liabilityGroupKeyByAccountId = new Map<string, string>();
  const liabilityGroupKeyByInstitutionId = new Map<string, string>();
  const liabilityGroupKeyByCounterpartyId = new Map<string, string>();
  const ordinaryLiabilityAccountIds: string[] = [];
  const visibleLiabilityAccounts: Array<{
    account: LiabilityViewAccount;
    institutionName: string;
    counterpartyName: string;
    objectName: string;
    balance: number;
    isInstitutionLoanAccount: boolean;
    isLoanAccount: boolean;
    ordinaryGroupKey: string;
  }> = [];
  const ordinaryAccountIdsByGroupKey = new Map<string, string[]>();

  for (const account of liabilityAccounts) {
    const institutionName = (account.Institution?.shortName?.trim() || account.Institution?.name || "").trim();
    const counterpartyName = (account.Counterparty?.shortName?.trim() || account.Counterparty?.name || "").trim();
    const objectName = counterpartyName || institutionName || account.name;
    const balance = cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    const isInstitutionLoanAccount = account.kind === AccountKind.loan && !account.counterpartyId;
    const isLoanAccount = isInstitutionLoanAccount && account.liabilityDirection !== LiabilityDirection.receivable;
    if (isInstitutionLoanAccount && Math.abs(balance) < ACTIVE_LIABILITY_EPSILON) continue;
    if (!isInstitutionLoanAccount && !account.isActive && Math.abs(balance) < ACTIVE_LIABILITY_EPSILON) continue;
    const ordinaryGroupKey = objectName ? `settlement-object:${objectName}` : `settlement-account:${account.id}`;
    visibleLiabilityAccounts.push({
      account,
      institutionName,
      counterpartyName,
      objectName,
      balance,
      isInstitutionLoanAccount,
      isLoanAccount,
      ordinaryGroupKey,
    });
    if (!isInstitutionLoanAccount) {
      const accountIds = ordinaryAccountIdsByGroupKey.get(ordinaryGroupKey) ?? [];
      accountIds.push(account.id);
      ordinaryAccountIdsByGroupKey.set(ordinaryGroupKey, accountIds);
    }
  }

  for (const visibleAccount of visibleLiabilityAccounts) {
    const {
      account,
      objectName,
      balance,
      isInstitutionLoanAccount,
      isLoanAccount,
      ordinaryGroupKey,
    } = visibleAccount;
    const loanPlan = loanRepaymentPlanByAccountId.get(account.id);
    if (!isInstitutionLoanAccount) ordinaryLiabilityAccountIds.push(account.id);

    const groupedOrdinaryAccount = !isInstitutionLoanAccount && (ordinaryAccountIdsByGroupKey.get(ordinaryGroupKey)?.length ?? 0) > 1;
    const defaultItemName = objectName ? `${objectName}${SETTLEMENT_ACCOUNT_SUFFIX}` : "";
    const itemName = groupedOrdinaryAccount
      ? account.name
      : objectName && (account.name === defaultItemName || account.name === objectName)
        ? SETTLEMENT_ITEM_NAME
        : account.name;
    const accountRowKey = `account:${account.id}`;
    const accountRowName = groupedOrdinaryAccount
      ? account.name
      : objectName && objectName !== itemName ? `${objectName} | ${itemName}` : account.name;
    const rowKey = accountRowKey;
    const accountObjectType = isInstitutionLoanAccount
      ? isLoanAccount ? BANK_LOAN_OBJECT_TYPE : BANK_RECEIVABLE_OBJECT_TYPE
      : account.Counterparty?.type === "person" || account.Institution?.type === "person"
        ? PERSONAL_SETTLEMENT_OBJECT_TYPE
        : ORGANIZATION_SETTLEMENT_OBJECT_TYPE;
    const accountLoanType = isInstitutionLoanAccount ? resolveLoanType(account) ?? "home" : null;
    const isMortgageLoanAccount = accountLoanType === "home" || accountLoanType === "mortgage";
    liabilityGroupKeyByAccountId.set(account.id, accountRowKey);
    if (account.institutionId) liabilityGroupKeyByInstitutionId.set(account.institutionId, groupedOrdinaryAccount ? ordinaryGroupKey : accountRowKey);
    if (account.counterpartyId) liabilityGroupKeyByCounterpartyId.set(account.counterpartyId, groupedOrdinaryAccount ? ordinaryGroupKey : accountRowKey);

    const loanMemo = loanPlan ? decodeScheduledTaskMemo(loanPlan.memo) : null;
    const rawLoanRateAdjustments = resolveLoanRateAdjustments({
      tableAdjustments: loanPlan ? loanRateAdjustmentsByAccountId.get(account.id) : [],
      memoAdjustments: loanMemo?.loanRateAdjustments,
    });
    const loanStartDate = liabilityBorrowStartDateByAccountId?.get(account.id) ?? (loanPlan?.startDate ? formatDateUtc(loanPlan.startDate) : "");
    const mortgageLprDiscount = isMortgageLoanAccount
      ? loanMemo?.mortgageLprDiscount ??
        liabilityBorrowLprDiscountByAccountId.get(account.id) ??
        inferMortgageLprDiscountFromRateAdjustments(rawLoanRateAdjustments, { skipOnOrBefore: loanStartDate }) ??
        null
      : null;
    let loanRateAdjustments = resolveLoanRateAdjustments({
      tableAdjustments: loanPlan ? loanRateAdjustmentsByAccountId.get(account.id) : [],
      memoAdjustments: loanMemo?.loanRateAdjustments,
      mortgageLprDiscount,
      loanStartDate,
    });
    // 利率调整历史从放款日开始：老数据表里第一条是第一次变动，
    // 展示时补上放款日当天的执行利率（与基础利率同值，不参与重算口径）。
    const loanBaseAnnualRate = loanMemo?.annualRate ?? null;
    if (
      isMortgageLoanAccount &&
      loanStartDate &&
      loanBaseAnnualRate != null &&
      Number.isFinite(loanBaseAnnualRate) &&
      loanRateAdjustments.length > 0 &&
      !loanRateAdjustments.some((item) => item.effectiveDate <= loanStartDate)
    ) {
      loanRateAdjustments = [
        { effectiveDate: loanStartDate, annualRate: loanBaseAnnualRate },
        ...loanRateAdjustments,
      ];
    }
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
    const nextPeriodStartScheduledAmount = loanPlan && balance < 0 ? toNumber(loanPlan.amount) : 0;
    const nextRepaymentParts = loanPlan && balance < 0
      ? calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: loanMemo?.repaymentMethod,
          baseAnnualRate: loanMemo?.annualRate,
          adjustments: loanRateAdjustments,
          intervalMonths: loanIntervalMonths,
          scheduledAmount: nextPeriodStartScheduledAmount,
          preserveScheduledAmount: true,
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

    const current = liabilityRowMap.get(rowKey) ?? {
      key: rowKey,
      name: accountRowName,
      objectType: accountObjectType,
      objectName,
      itemName,
      accountName: account.name,
      accountId: account.id,
      institutionId: account.institutionId ?? "",
      counterpartyId: account.counterpartyId ?? "",
      counterpartyReimbursementEnabled: account.Counterparty?.isReimbursable === true,
      itemType: balance >= 0 ? "应收款" : "应付款",
      repaymentMethod: "",
      repaymentCycle: "",
      baseAnnualRate: loanMemo?.annualRate ?? null,
      annualRate: null,
      mortgageLprDiscount: null,
      loanStartDate,
      remainingRuns: null,
      paidPrincipal: 0,
      paidInterest: 0,
      remainingPrincipal: 0,
      remainingInterest: 0,
      remainingTotal: 0,
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
      parentKey: groupedOrdinaryAccount ? ordinaryGroupKey : null,
      depth: groupedOrdinaryAccount ? 1 : 0,
      isGroup: false,
      isLoan: isInstitutionLoanAccount,
      isConsumerLoan: account.isConsumerLoan === true,
      loanType: accountLoanType,
    } satisfies LiabilityViewRow;

    current.accountCount += 1;
    current.accountIds.push(account.id);
    current.accountLabels.push(accountRowName);
    current.net += balance;
    if (balance >= 0) current.receivable += balance;
    else current.payable += Math.abs(balance);
    if (loanPlan) {
      current.repaymentMethod = loanMemo?.repaymentMethod ? normalizeLoanRepaymentMethod(loanMemo.repaymentMethod) : current.repaymentMethod;
      current.repaymentCycle = repaymentCycle || current.repaymentCycle;
      current.baseAnnualRate = loanMemo?.annualRate ?? current.baseAnnualRate;
      current.annualRate = nextEffectiveAnnualRate ?? current.annualRate;
      current.mortgageLprDiscount = mortgageLprDiscount ?? current.mortgageLprDiscount;
      current.loanStartDate = loanStartDate || current.loanStartDate;
      current.remainingRuns = remainingRuns ?? current.remainingRuns;
      current.nextRepaymentDate = loanPlan.nextRunDate ? formatDateUtc(loanPlan.nextRunDate) : current.nextRepaymentDate;
      current.nextRepaymentPrincipal = nextRepaymentParts?.principal ?? current.nextRepaymentPrincipal;
      current.nextRepaymentInterest = nextRepaymentParts?.interest ?? current.nextRepaymentInterest;
      current.nextRepaymentCashAccountId = loanPlan.cashAccountId ?? current.nextRepaymentCashAccountId;
      current.loanRateAdjustments = loanRateAdjustments;
    }
    current.itemType = current.net >= 0 ? "应收款" : "应付款";
    current.remainingPrincipal = Math.abs(current.net);
    current.remainingTotal = signedRemainingTotal(current.net, current.remainingPrincipal, current.remainingInterest);
    liabilityRowMap.set(rowKey, current);
  }

  const childRowsByParentKey = new Map<string, LiabilityViewRow[]>();
  for (const row of liabilityRowMap.values()) {
    if (!row.parentKey) continue;
    const childRows = childRowsByParentKey.get(row.parentKey) ?? [];
    childRows.push(row);
    childRowsByParentKey.set(row.parentKey, childRows);
  }

  for (const [parentKey, childRows] of childRowsByParentKey) {
    const first = childRows[0];
    if (!first) continue;
    const net = childRows.reduce((sum, row) => sum + row.net, 0);
    const payable = childRows.reduce((sum, row) => sum + row.payable, 0);
    const receivable = childRows.reduce((sum, row) => sum + row.receivable, 0);
    const counterpartyIds = childRows.map((row) => row.counterpartyId).filter(Boolean);
    const institutionIds = childRows.map((row) => row.institutionId).filter(Boolean);
    const remainingPrincipal = Math.abs(net);
    liabilityRowMap.set(parentKey, {
      key: parentKey,
      name: first.objectName || first.name,
      objectType: first.objectType,
      objectName: first.objectName,
      itemName: SETTLEMENT_ITEM_NAME,
      accountName: "",
      accountId: "",
      institutionId: institutionIds[0] ?? "",
      counterpartyId: counterpartyIds[0] ?? "",
      counterpartyReimbursementEnabled: childRows.some((row) => row.counterpartyReimbursementEnabled),
      itemType: net >= 0 ? RECEIVABLE_ITEM_TYPE : PAYABLE_ITEM_TYPE,
      repaymentMethod: "",
      repaymentCycle: "",
      baseAnnualRate: null,
      annualRate: null,
      mortgageLprDiscount: null,
      loanStartDate: "",
      remainingRuns: null,
      paidPrincipal: childRows.reduce((sum, row) => sum + Math.abs(row.paidPrincipal), 0),
      paidInterest: childRows.reduce((sum, row) => sum + Math.abs(row.paidInterest), 0),
      remainingPrincipal,
      remainingInterest: childRows.reduce((sum, row) => sum + Math.abs(row.remainingInterest), 0),
      remainingTotal: signedRemainingTotal(net, remainingPrincipal, childRows.reduce((sum, row) => sum + Math.abs(row.remainingInterest), 0)),
      nextRepaymentDate: "",
      nextRepaymentPrincipal: null,
      nextRepaymentInterest: null,
      nextRepaymentCashAccountId: "",
      loanRateAdjustments: [],
      payable,
      receivable,
      net,
      accountCount: childRows.reduce((sum, row) => sum + row.accountCount, 0),
      accountIds: childRows.flatMap((row) => row.accountIds),
      accountLabels: childRows.flatMap((row) => row.accountLabels),
      parentKey: null,
      depth: 0,
      isGroup: true,
      isLoan: false,
      loanType: null,
    } satisfies LiabilityViewRow);
  }

  const compareLiabilityRows = (a: LiabilityViewRow, b: LiabilityViewRow) => {
    const amountDiff = (b.payable + b.receivable) - (a.payable + a.receivable);
    if (Math.abs(amountDiff) > ACTIVE_LIABILITY_EPSILON) return amountDiff;
    return a.name.localeCompare(b.name, "zh-CN");
  };
  const topLiabilityRows = Array.from(liabilityRowMap.values())
    .filter((row) => !row.parentKey)
    .sort(compareLiabilityRows);
  const liabilityRows: LiabilityViewRow[] = [];
  for (const row of topLiabilityRows) {
    liabilityRows.push(row);
    const childRows = childRowsByParentKey.get(row.key);
    if (childRows?.length) liabilityRows.push(...[...childRows].sort(compareLiabilityRows));
  }
  const derivedLiabilityKey = (selectedAccountKind === AccountKind.loan || selectedAccountKind === AccountKind.settlement) && selectedAccountId
    ? liabilityGroupKeyByAccountId.get(selectedAccountId) ?? `account:${selectedAccountId}`
    : "";
  const legacyInstitutionLiabilityRow = liabilityPersonParam.startsWith("institution:")
    ? liabilityRows.find((row) => row.key === liabilityGroupKeyByInstitutionId.get(liabilityPersonParam.slice("institution:".length)))
    : null;
  const legacyCounterpartyLiabilityRow = liabilityPersonParam.startsWith("counterparty:")
    ? liabilityRows.find((row) => row.key === liabilityGroupKeyByCounterpartyId.get(liabilityPersonParam.slice("counterparty:".length)))
    : null;
  const explicitSelectedLiabilityKey = liabilityRows.some((row) => row.key === liabilityPersonParam)
    ? liabilityPersonParam
    : legacyInstitutionLiabilityRow
      ? legacyInstitutionLiabilityRow.key
    : legacyCounterpartyLiabilityRow
      ? legacyCounterpartyLiabilityRow.key
    : liabilityRows.some((row) => row.key === derivedLiabilityKey)
      ? derivedLiabilityKey
      : "";
  const ordinaryLiabilityAccountIdSet = new Set(ordinaryLiabilityAccountIds);
  const ordinaryLiabilityRows = liabilityRows.filter((row) => row.accountIds.some((id) => ordinaryLiabilityAccountIdSet.has(id)));
  const selectedLoanTypeRows = selectedLiabilityLoanType
    ? liabilityRows.filter((row) => !row.parentKey && row.isLoan && row.loanType === selectedLiabilityLoanType)
    : [];
  // When no liabilityPerson query explicitly selects a row, select the first visible
  // shell row by default (skipping settled rows) so details are visible on open.
  // The fallback comes from the unselected shell list, so the default selection
  // does not narrow the table above.
  const fallbackShellRows = selectedLiabilityLoanType ? selectedLoanTypeRows : ordinaryLiabilityRows;
  const fallbackSelectedLiabilityRow =
    fallbackShellRows.find((row) => !isSettledLiabilityViewRow(row)) ?? fallbackShellRows[0] ?? null;
  const selectedLiabilityKey = explicitSelectedLiabilityKey || fallbackSelectedLiabilityRow?.key || "";
  const selectedLiabilityRow = liabilityRows.find((row) => row.key === selectedLiabilityKey) ?? null;
  const selectedLiabilityRowIsOrdinary = !!selectedLiabilityRow?.accountIds?.some((id) => ordinaryLiabilityAccountIdSet.has(id));
  // Selecting a specific loan should only highlight it and focus the detail
  // panel. Keep the list showing all same-type loan rows so other loans do not
  // appear to disappear after a click.
  const liabilityRowsForShell = selectedLiabilityLoanType
    ? selectedLoanTypeRows
    : selectedLiabilityRow && !selectedLiabilityRowIsOrdinary
      ? liabilityRows.filter((row) => !row.parentKey && (row.isLoan || row.key === selectedLiabilityRow.key))
      : ordinaryLiabilityRows;
  const selectedLiabilityObjectValue = selectedLiabilityRow?.counterpartyId
    ? `counterparty:${selectedLiabilityRow.counterpartyId}`
    : selectedLiabilityRow?.institutionId
      ? `institution:${selectedLiabilityRow.institutionId}`
      : "";
  const totalLiabilityPayable = liabilityRows.filter((row) => !row.parentKey).reduce((sum, row) => sum + row.payable, 0);
  const totalLiabilityReceivable = liabilityRows.filter((row) => !row.parentKey).reduce((sum, row) => sum + row.receivable, 0);

  return {
    liabilityRows,
    liabilityRowsForShell,
    selectedLiabilityKey,
    selectedLiabilityRow,
    selectedLiabilityObjectValue,
    ordinaryLiabilityAccountIds,
    totalLiabilityPayable,
    totalLiabilityReceivable,
  };
}

export function buildLiabilityRepaymentScheduleRows({
  selectedLiabilityRow,
  selectedRepaymentPlan,
  liabilityEntriesRaw = [],
  selectedLiabilityAccountIds,
  displayAccountId,
}: {
  selectedLiabilityRow: LiabilityViewRow | null;
  selectedRepaymentPlan: LiabilityViewPlan | null;
  liabilityEntriesRaw?: LiabilityMetricEntry[];
  selectedLiabilityAccountIds?: Set<string>;
  displayAccountId?: string | null;
}): LiabilityRepaymentScheduleRow[] {
  const selectedRepaymentMemo = selectedRepaymentPlan ? decodeScheduledTaskMemo(selectedRepaymentPlan.memo) : null;
  const selectedRemainingRuns = selectedRepaymentPlan?.totalRuns == null
    ? null
    : Math.max(0, selectedRepaymentPlan.totalRuns - Math.max(0, selectedRepaymentPlan.executedRuns ?? 0));
  const repaymentScheduleRows: LiabilityRepaymentScheduleRow[] = [];
  if (!selectedLiabilityRow || !selectedRepaymentPlan || selectedLiabilityRow.net >= -ACTIVE_LIABILITY_EPSILON) return repaymentScheduleRows;

  const scheduleLiabilityAccountIds = selectedLiabilityAccountIds ?? new Set(selectedLiabilityRow.accountIds);
  const prepaymentAdjustments = liabilityEntriesRaw
    .filter(
      (entry) =>
        entry.type === TransactionType.transfer &&
        entry.source === "liability_prepay_out" &&
        (scheduleLiabilityAccountIds.has(entry.accountId ?? "") || scheduleLiabilityAccountIds.has(entry.toAccountId ?? "")),
    )
    .map((entry) => ({
      date: liabilityMetricDisplayDate(entry, displayAccountId).toISOString().slice(0, 10),
      amount: Math.abs(liabilityPrincipalForAccountSide(entry, scheduleLiabilityAccountIds)),
    }))
    .filter((item) => item.amount > ACTIVE_LIABILITY_EPSILON)
    .sort((a, b) => a.date.localeCompare(b.date));
  const todayKey = formatDateLocal(new Date());

  let remainingPrincipal = Math.abs(selectedLiabilityRow.net);
  let runDate = selectedRepaymentPlan.nextRunDate;
  let lastScheduleDate =
    selectedRepaymentPlan.lastRunDate ??
    parseDateInputToUtc(selectedLiabilityRow.loanStartDate) ??
    selectedRepaymentPlan.startDate;
  if (!selectedRepaymentPlan.lastRunDate) {
    const executedRuns = Math.max(0, selectedRepaymentPlan.executedRuns ?? 0);
    let derivedRunDate = calcInitialScheduledRunDate(
      repaymentScheduleStartDate(selectedRepaymentPlan),
      selectedRepaymentPlan.intervalUnit,
      selectedRepaymentPlan.intervalValue,
      selectedRepaymentPlan.executionDay,
      false,
    );
    for (let index = 0; index < executedRuns; index += 1) {
      lastScheduleDate = derivedRunDate;
      derivedRunDate = calcNextScheduledRunDate(
        derivedRunDate,
        selectedRepaymentPlan.intervalUnit,
        selectedRepaymentPlan.intervalValue,
        selectedRepaymentPlan.executionDay,
        false,
      );
    }
  }
  const rateAdjustments = normalizeLoanRateAdjustments(selectedLiabilityRow.loanRateAdjustments);
  const emittedAdjustmentKeys = new Set<string>();
  const maxRuns = Math.min(selectedRemainingRuns ?? 24, 360);
  let scheduledAmountForRun = toNumber(selectedRepaymentPlan.amount);
  for (let index = 0; index < maxRuns && remainingPrincipal > ACTIVE_LIABILITY_EPSILON; index++) {
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
    const principalAdjustments = prepaymentAdjustments.filter(
      (item) => item.date > lastScheduleDateKey && item.date <= runDateKey,
    );
    const principalAdjustmentTotal = principalAdjustments.reduce((sum, item) => sum + item.amount, 0);
    const reflectedPrincipalAdjustmentTotal = principalAdjustments
      .filter((item) => item.date <= todayKey)
      .reduce((sum, item) => sum + item.amount, 0);
    const periodStartingPrincipal = remainingPrincipal + reflectedPrincipalAdjustmentTotal;
    const remainingRunsForThisRun = selectedRemainingRuns == null ? Math.max(1, maxRuns - index) : Math.max(1, selectedRemainingRuns - index);
    const parts = calcLoanRunPartsWithRateAdjustments({
      repaymentMethod: selectedRepaymentMemo?.repaymentMethod,
      baseAnnualRate: selectedRepaymentMemo?.annualRate,
      adjustments: rateAdjustments,
      principalAdjustments,
      intervalMonths: selectedRepaymentMemo?.repaymentIntervalMonths ?? (selectedRepaymentPlan.intervalUnit === IntervalUnit.month ? selectedRepaymentPlan.intervalValue : null),
      scheduledAmount: scheduledAmountForRun,
      preserveScheduledAmount: true,
      remainingPrincipal: periodStartingPrincipal,
      remainingRuns: remainingRunsForThisRun,
      previousRunDate: lastScheduleDateKey,
      runDate: runDateKey,
    });
    scheduledAmountForRun = parts.scheduledAmount;
    const nextRemainingPrincipal = Math.max(
      0,
      Math.round((periodStartingPrincipal - parts.principal - principalAdjustmentTotal) * 100) / 100,
    );
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
