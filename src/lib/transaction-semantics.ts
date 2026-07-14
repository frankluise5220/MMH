import { toStatementMonth } from "@/lib/date-utils";

type CreditCardRepaymentLike = {
  readonly type?: string | null;
  readonly accountKind?: string | null;
  readonly toAccountKind?: string | null;
};

type StatementAccountLike = {
  readonly kind?: string | null;
  readonly billingDay?: number | null;
};

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
