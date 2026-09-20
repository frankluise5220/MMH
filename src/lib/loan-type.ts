export const LOAN_TYPES = ["home", "mortgage", "consumer", "other"] as const;
export type LoanTypeValue = (typeof LOAN_TYPES)[number];

export function normalizeLoanType(raw: unknown): LoanTypeValue | null {
  const value = String(raw ?? "").trim();
  return LOAN_TYPES.includes(value as LoanTypeValue) ? (value as LoanTypeValue) : null;
}

export function resolveLoanTypeValue(raw: unknown, isConsumerLoan?: boolean | null): LoanTypeValue {
  return normalizeLoanType(raw) ?? (isConsumerLoan === true ? "consumer" : "home");
}

export function isHomeLoanType(raw: unknown) {
  return normalizeLoanType(raw) === "home";
}

export function isCollateralLoanType(raw: unknown) {
  return normalizeLoanType(raw) === "mortgage";
}

/**
 * 「其他贷款」（loanType=other）放宽口径（2026-09-19 用户定版）：
 * 允许年利率 0（亲友借款常见），允许总期数 0 —— 期数为 0 表示没有固定还款计划，
 * 不生成计划任务，后续还款也不依赖计划期数定位。
 */
export function isOtherLoanType(raw: unknown) {
  return normalizeLoanType(raw) === "other";
}
