import { toStatementMonth } from "@/lib/date-utils";
export const ENTRY_ORIGIN_MANUAL = "manual" as const;
export const ENTRY_ORIGIN_AI_IMPORT = "ai_import" as const;
export const ENTRY_ORIGIN_EXCEL_IMPORT = "excel_import" as const;
export const ENTRY_ORIGIN_SCHEDULED_TASK = "scheduled_task" as const;
export const ENTRY_ORIGIN_EMAIL_IMPORT = "email_import" as const;

type CreditCardRepaymentLike = {
  readonly type?: string | null;
  readonly accountKind?: string | null;
  readonly toAccountKind?: string | null;
};

type StatementAccountLike = {
  readonly kind?: string | null;
  readonly billingDay?: number | null;
};

export const ENTRY_ORIGIN_VALUES = [
  ENTRY_ORIGIN_MANUAL,
  ENTRY_ORIGIN_AI_IMPORT,
  ENTRY_ORIGIN_EXCEL_IMPORT,
  ENTRY_ORIGIN_SCHEDULED_TASK,
  ENTRY_ORIGIN_EMAIL_IMPORT,
] as const;

export type EntryOrigin = (typeof ENTRY_ORIGIN_VALUES)[number];

export function isEntryOrigin(value: unknown): value is EntryOrigin {
  return ENTRY_ORIGIN_VALUES.includes(value as EntryOrigin);
}

export function normalizeEntryOrigin(value: string | null | undefined): EntryOrigin {
  return isEntryOrigin(value) ? value : ENTRY_ORIGIN_MANUAL;
}

export const TRANSACTION_SOURCE_MANUAL = "manual" as const;
export const TRANSACTION_SOURCE_INSURANCE = "insurance" as const;
export const TRANSACTION_SOURCE_REGULAR_INVEST = "regular_invest" as const;
export const TRANSACTION_SOURCE_REGULAR_INVEST_REFUND = "regular_invest_refund" as const;
export const TRANSACTION_SOURCE_FUND_UNITS_RECONCILE = "fund_units_reconcile" as const;
export const TRANSACTION_SOURCE_SCHEDULED_TASK = "scheduled_task" as const;
export const TRANSACTION_SOURCE_STATEMENT_IMPORT = "statement_import" as const;

export function isLicensedInsuranceEntry(entry: { source?: string | null; insuranceProductId?: string | null }) {
  return entry.source === TRANSACTION_SOURCE_INSURANCE || Boolean(entry.insuranceProductId);
}

export function isRegularInvestRefundEntry(entry: { source?: string | null; fundSubtype?: string | null }) {
  return entry.fundSubtype === "buy_failed" && entry.source === TRANSACTION_SOURCE_REGULAR_INVEST_REFUND;
}

export function isFundUnitsReconcileEntry(entry: { source?: string | null }) {
  return entry.source === TRANSACTION_SOURCE_FUND_UNITS_RECONCILE;
}

export function isGeneratedScheduledRecord(entry: { source?: string | null; entryOrigin?: string | null; regularInvestPlanId?: string | null }) {
  return entry.entryOrigin === ENTRY_ORIGIN_SCHEDULED_TASK || entry.source === TRANSACTION_SOURCE_SCHEDULED_TASK;
}

export function recordMatchesRegularInvestPlan(taskType: string | null | undefined, entry: { source?: string | null }) {
  if (taskType === "fund_regular_invest") return entry.source === TRANSACTION_SOURCE_REGULAR_INVEST;
  if (taskType === "insurance_premium") return entry.source === TRANSACTION_SOURCE_INSURANCE;
  return entry.source === TRANSACTION_SOURCE_SCHEDULED_TASK;
}

export const CREDIT_CARD_REPAYMENT_BUSINESS_TYPE = "credit_card_repayment" as const;
export const CREDIT_CARD_REPAYMENT_CATEGORY_NAME = "信用卡还款" as const;
export type CreditCardRepaymentBusinessType = typeof CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;

const REPAYMENT_SOURCE_ACCOUNT_KINDS = new Set(["cash", "bank_debit", "ewallet"]);
const REPAYMENT_IMPORT_SOURCE_ACCOUNT_KINDS = new Set(["bank_debit", "ewallet"]);

export function isCreditCardRepaymentBusinessType(value: unknown) {
  return value === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;
}

export function isCreditCardRepaymentSourceAccountKind(kind: string | null | undefined) {
  return REPAYMENT_SOURCE_ACCOUNT_KINDS.has(kind ?? "");
}

export function isCreditCardRepaymentImportSourceAccountKind(kind: string | null | undefined) {
  return REPAYMENT_IMPORT_SOURCE_ACCOUNT_KINDS.has(kind ?? "");
}

export function isCreditCardRepaymentTargetAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit";
}

export function isCreditCardRepaymentTransfer(entry: CreditCardRepaymentLike) {
  return (
    entry.type === "transfer" &&
    isCreditCardRepaymentSourceAccountKind(entry.accountKind) &&
    isCreditCardRepaymentTargetAccountKind(entry.toAccountKind)
  );
}

function statementMonthForBillSide(date: Date, account: StatementAccountLike | null | undefined) {
  if (!account?.billingDay) return null;
  if (account.kind !== "bank_credit" && account.kind !== "loan") return null;
  return toStatementMonth(date, account.billingDay);
}

export function statementMonthForTransfer(
  date: Date,
  fromAccount: StatementAccountLike | null | undefined,
  toAccount: StatementAccountLike | null | undefined,
) {
  return statementMonthForBillSide(date, toAccount) ?? statementMonthForBillSide(date, fromAccount);
}
