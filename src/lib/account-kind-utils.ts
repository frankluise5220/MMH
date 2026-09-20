import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";
import { isFixedAssetAccountLike } from "@/lib/fixed-asset";

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

export type InvestmentAccountView = "investfund" | "investmoney" | "investwealth" | "investbond" | "investstock" | "investproperty" | "detail";

/**
 * Fund/cash family kinds that may still change among themselves after an
 * account already has active records. Cross-family changes stay locked.
 */
export const FUND_CASH_ACCOUNT_KINDS = [
  "bank_debit",
  "cash",
  "ewallet",
  "settlement",
  "bank_credit",
  "other",
] as const;

export type FundCashAccountKind = (typeof FUND_CASH_ACCOUNT_KINDS)[number];

export function isFundCashAccountKind(kind: string | null | undefined): kind is FundCashAccountKind {
  return FUND_CASH_ACCOUNT_KINDS.includes(String(kind ?? "") as FundCashAccountKind);
}

export function canChangeAccountKindWithRecords(
  fromKind: string | null | undefined,
  toKind: string | null | undefined,
) {
  const from = normalizeUserFacingAccountKind(fromKind);
  const to = normalizeUserFacingAccountKind(toKind);
  if (!from || !to || from === to) return true;
  return isFundCashAccountKind(from) && isFundCashAccountKind(to);
}

/**
 * Map stored or requested account identity to the kind the UI shows.
 * Legacy deposit (`investment` + `deposit`) and fixed assets
 * (`investment` + `property`, or `fixed_asset`) compare as `deposit` /
 * `fixed_asset` so unchanged saves do not look like a type change.
 */
export function normalizeUserFacingAccountKind(
  account: Pick<AccountKindLike, "kind" | "investProductType"> | string | null | undefined,
): string {
  if (account == null) return "";
  if (typeof account === "string") {
    const kind = account.trim();
    if (kind === "fixed_asset") return "fixed_asset";
    if (kind === "deposit") return "deposit";
    return kind;
  }
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  if (isDepositAccount(account)) return "deposit";
  return String(account.kind ?? "").trim();
}

export function resolveRequestedUserFacingAccountKind(params: {
  existing: Pick<AccountKindLike, "kind" | "investProductType">;
  requestedKind?: string | null;
  requestedInvestProductType?: string | null;
}): string {
  const requestedKind = params.requestedKind == null ? "" : String(params.requestedKind).trim();
  if (!requestedKind) return normalizeUserFacingAccountKind(params.existing);
  const requestedInvestProductType = params.requestedInvestProductType == null
    ? params.existing.investProductType
    : String(params.requestedInvestProductType).trim() || null;
  return normalizeUserFacingAccountKind({
    kind: requestedKind,
    investProductType: requestedInvestProductType,
  });
}

export function accountKindOptionsForEdit(params: {
  currentKind: string | null | undefined;
  hasRecords: boolean;
  emptyAccountKinds: readonly string[];
}): { options: string[]; kindSelectDisabled: boolean } {
  const current = normalizeUserFacingAccountKind(params.currentKind);
  if (!params.hasRecords) {
    const options = [...params.emptyAccountKinds];
    if (current && !options.includes(current)) options.push(current);
    return { options, kindSelectDisabled: false };
  }
  if (isFundCashAccountKind(current)) {
    return { options: [...FUND_CASH_ACCOUNT_KINDS], kindSelectDisabled: false };
  }
  return { options: current ? [current] : [], kindSelectDisabled: true };
}

export function accountRecordLockErrorKey(code: string | null | undefined): string | null {
  if (code === "ACCOUNT_KIND_LOCKED") return "settings.accounts.kindLocked";
  if (code === "ACCOUNT_CURRENCY_LOCKED") return "settings.accounts.currencyLocked";
  if (code === "ACCOUNT_INVEST_TYPE_LOCKED") return "settings.accounts.investTypeLocked";
  return null;
}


export function isLegacyDepositAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType === "deposit";
}

export function isDepositAccount(account: AccountKindLike | null | undefined) {
  if (!account) return false;
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
  // 债券有自己的视图（BondShell）：债券是「债单 + 票面利率 + 到期日 + 付息」模型，
  // 与基金的份额/净值模型不同，不复用 investwealth。
  if (account?.investProductType === "bond") return "investbond";
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
 * 存款账户参与收支记账时的分类白名单（2026-09-18 用户口径）：
 * 收入侧只能「存款利息」（利息收入）；支出侧「存款手续费」「利息支出」。
 * 转账不受此限制——资金侧来回转账走 isOrdinaryTransferAccount 已放行。
 */
export const DEPOSIT_POSTING_INCOME_CATEGORY_NAMES = ["存款利息", "利息"];
export const DEPOSIT_POSTING_EXPENSE_CATEGORY_NAMES = ["存款手续费", "利息支出", "手续费"];

/** 收入/支出弹窗的落账账户候选：普通账户全放行，存款账户也放行（分类在提交时校验白名单）。 */
export function isIncomeExpensePostingOrDepositAccount(account: AccountKindLike | null | undefined) {
  if (!account) return false;
  if (isIncomeExpensePostingAccount(account)) return true;
  return isDepositAccount(account);
}

/** 已选分类是否满足存款账户的收支白名单（用于提交校验与下拉过滤）。 */
export function isDepositPostingCategoryAllowed(categoryName: string | null | undefined, type: "income" | "expense") {
  const name = String(categoryName ?? "").trim();
  if (!name) return false;
  const whitelist = type === "income" ? DEPOSIT_POSTING_INCOME_CATEGORY_NAMES : DEPOSIT_POSTING_EXPENSE_CATEGORY_NAMES;
  return whitelist.some((allowed) => name === allowed || name.endsWith(`.${allowed}`) || name.includes(allowed));
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
    // 债券账户与理财账户同样打开理财录入窗口（交易链路共用），表单内部再按债券模式分流。
    if (account.investProductType === "wealth" || account.investProductType === "bond") return "wealth";
    return "investment";
  }
  if (isLoanOrSettlementAccountKind(account.kind)) return "debt";
  return "transfer";
}

export function isSpecialCashTargetAccount(account: AccountKindLike | null | undefined) {
  return getCashTargetOperation(account) !== "transfer";
}
