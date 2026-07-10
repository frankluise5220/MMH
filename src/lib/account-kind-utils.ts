export type AccountKindLike = {
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
};

export type CashTargetOperation = "transfer" | "investment" | "wealth" | "deposit" | "debt";


export function isLegacyDepositAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType === "deposit";
}

export function isDepositAccount(account: AccountKindLike) {
  return account.kind === "deposit" || isLegacyDepositAccount(account);
}

export function isPureInvestmentAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType !== "deposit";
}

export function isInsuranceAccount(account: AccountKindLike) {
  return account.kind === "insurance";
}

export function isBillLikeAccount(account: Pick<AccountKindLike, "kind"> & { billingDay?: number | null }) {
  return account.kind === "bank_credit" && !!account.billingDay;
}

export function getCashTargetOperation(account: AccountKindLike | null | undefined): CashTargetOperation {
  if (!account) return "transfer";
  if (isDepositAccount(account)) return "deposit";
  if (isPureInvestmentAccount(account)) {
    return account.investProductType === "wealth" ? "wealth" : "investment";
  }
  if (account.kind === "loan") return "debt";
  return "transfer";
}

export function isSpecialCashTargetAccount(account: AccountKindLike | null | undefined) {
  return getCashTargetOperation(account) !== "transfer";
}
