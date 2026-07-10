type CreditCardRepaymentLike = {
  readonly type?: string | null;
  readonly accountKind?: string | null;
  readonly toAccountKind?: string | null;
};

const REPAYMENT_SOURCE_ACCOUNT_KINDS = new Set(["cash", "bank_debit", "ewallet"]);

export function isCreditCardRepaymentTransfer(entry: CreditCardRepaymentLike) {
  return (
    entry.type === "transfer" &&
    REPAYMENT_SOURCE_ACCOUNT_KINDS.has(entry.accountKind ?? "") &&
    entry.toAccountKind === "bank_credit"
  );
}
