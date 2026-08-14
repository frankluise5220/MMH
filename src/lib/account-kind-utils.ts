export type AccountKindLike = {
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
};

export type CashTargetOperation = "transfer" | "investment" | "wealth" | "deposit" | "debt";

export type InvestmentAccountView = "investfund" | "investmoney" | "investwealth" | "investstock" | "investproperty";


export function isLegacyDepositAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType === "deposit";
}

export function isDepositAccount(account: AccountKindLike) {
  return account.kind === "deposit" || isLegacyDepositAccount(account);
}

export function isPureInvestmentAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType !== "deposit";
}

export function getInvestmentAccountView(account: Pick<AccountKindLike, "investProductType"> | null | undefined): InvestmentAccountView {
  if (account?.investProductType === "money") return "investmoney";
  if (account?.investProductType === "wealth") return "investwealth";
  if (account?.investProductType === "stock") return "investstock";
  if (account?.investProductType === "property") return "investproperty";
  return "investfund";
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
    // 投资账户（含股票）不参与普通转账，只能用各自的专用记账窗口
    if (account.investProductType === "wealth") return "wealth";
    return "investment";
  }
  if (account.kind === "loan") return "debt";
  return "transfer";
}

export function isSpecialCashTargetAccount(account: AccountKindLike | null | undefined) {
  return getCashTargetOperation(account) !== "transfer";
}
