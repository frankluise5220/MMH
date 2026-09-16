import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";

export { isDebtAccountKind, isLoanOrSettlementAccountKind } from "@/lib/debt";

export type AccountKindLike = {
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
  institutionType?: string | null;
  Institution?: { type?: string | null; name?: string | null; shortName?: string | null } | null;
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

export function isFundLikeInvestmentAccount(account: AccountKindLike) {
  return isPureInvestmentAccount(account) && (account.investProductType === "fund" || account.investProductType === "money");
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

export function isConsumerLoanAccount(account: AccountKindLike | null | undefined) {
  return account?.kind === "loan" && account.isConsumerLoan === true;
}

/**
 * Resolve the effective loan type for a loan account. Falls back to a derived
 * value from isConsumerLoan when loanType is not stored yet (legacy data).
 */
export function resolveLoanType(account: { kind?: string | null; isConsumerLoan?: boolean | null; loanType?: string | null } | null | undefined): LoanTypeValue | null {
  if (!account || account.kind !== "loan") return null;
  return resolveLoanTypeValue(account.loanType, account.isConsumerLoan);
}

export function isSpendableAccount(account: AccountKindLike | null | undefined) {
  return account?.kind === "cash" ||
    account?.kind === "bank_debit" ||
    account?.kind === "ewallet" ||
    account?.kind === "bank_credit" ||
    isConsumerLoanAccount(account);
}

const INVESTMENT_FUNDING_INSTITUTION_TYPES = new Set(["brokerage", "fund_company"]);

export function accountInstitutionType(account: AccountKindLike | null | undefined) {
  return account?.institutionType ?? account?.Institution?.type ?? null;
}

/**
 * 基金资金 / 股票资金：挂在证券或基金公司名下的现金、借记卡、电子钱包。
 * 这类账户只走银证转账/申赎资金，不参与普通收支记账。
 */
export function isInvestmentFundingAccount(account: AccountKindLike | null | undefined) {
  if (!account) return false;
  const kind = account.kind;
  if (kind !== "cash" && kind !== "bank_debit" && kind !== "ewallet") return false;
  return INVESTMENT_FUNDING_INSTITUTION_TYPES.has(String(accountInstitutionType(account) ?? "").trim());
}

/** 普通收入/支出（含明细改账户）允许落到的账户。贷款、定期存款、基金/股票资金、基金持仓账户都不算。 */
export function isIncomeExpensePostingAccount(account: AccountKindLike | null | undefined) {
  if (!account) return false;
  if (account.kind === "loan") return false;
  if (isDepositAccount(account) || isPureInvestmentAccount(account) || isInvestmentFundingAccount(account)) return false;
  return true;
}

/**
 * 资金类账户（含信用卡）：现金、借记卡、电子钱包，以及信用卡。
 * 不含贷款、往来款、存款、保险、基金/股票资金和持仓。
 */
export function isCashLedgerAccount(account: AccountKindLike | null | undefined) {
  if (!account) return false;
  if (account.kind === "bank_credit") return true;
  if (account.kind !== "cash" && account.kind !== "bank_debit" && account.kind !== "ewallet") return false;
  return !isInvestmentFundingAccount(account);
}

/** 代付资金侧：普通资金账户。贷款、往来款、存款、基金/股票资金、持仓都不算。 */
export function isAdvanceFundingAccount(account: AccountKindLike | null | undefined) {
  if (!isIncomeExpensePostingAccount(account)) return false;
  return !isLoanOrSettlementAccountKind(account?.kind);
}

/** 普通转账下拉：贷款走专用窗口，基金持仓也不进转账。存款/往来款仍可出现并跳到对应专用窗。 */
export function isOrdinaryTransferAccount(account: AccountKindLike | null | undefined) {
  if (!account) return false;
  if (account.kind === "loan") return false;
  if (isPureInvestmentAccount(account)) return false;
  return true;
}

export function isBillLikeAccount(account: Pick<AccountKindLike, "kind"> & { billingDay?: number | null }) {
  return account.kind === "bank_credit" && !!account.billingDay;
}

export function getCashTargetOperation(account: AccountKindLike | null | undefined): CashTargetOperation {
  if (!account) return "transfer";
  if (isDepositAccount(account)) return "deposit";
  if (isPureInvestmentAccount(account)) {
    // Investment accounts (including stock) do not participate in normal transfers; they only use their dedicated entry windows
    if (account.investProductType === "wealth") return "wealth";
    return "investment";
  }
  if (isLoanOrSettlementAccountKind(account.kind)) return "debt";
  return "transfer";
}

export function isSpecialCashTargetAccount(account: AccountKindLike | null | undefined) {
  return getCashTargetOperation(account) !== "transfer";
}
