export type DebtDirectionValue = "payable" | "receivable";

export const DEBT_DIRECTION_LABELS: Record<DebtDirectionValue, string> = {
  payable: "我欠别人",
  receivable: "别人欠我",
};

export function isDebtAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit" || isLoanOrSettlementAccountKind(kind);
}

export function isLoanOrSettlementAccountKind(kind: string | null | undefined) {
  return kind === "loan" || kind === "settlement";
}

export function normalizeDebtDirection(
  kind: string | null | undefined,
  raw: unknown,
): DebtDirectionValue | null {
  if (!isDebtAccountKind(kind)) return null;
  if (kind === "bank_credit") return "payable";
  const value = String(raw ?? "").trim();
  return value === "receivable" ? "receivable" : "payable";
}

export function debtDirectionLabel(raw: string | null | undefined) {
  return raw === "receivable" ? DEBT_DIRECTION_LABELS.receivable : DEBT_DIRECTION_LABELS.payable;
}

export function debtActionLabel(params: {
  direction: string | null | undefined;
  isDebtAccountFromSide: boolean;
}) {
  if (params.direction === "receivable") {
    return params.isDebtAccountFromSide ? "收回" : "出借";
  }
  return params.isDebtAccountFromSide ? "借入" : "还款";
}

export type DebtActivityMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

/** 还回/还出/提前还款才允许利息；借入/借出没有利息。 */
export function allowsDebtInterest(mode: string | null | undefined) {
  return mode === "repay_out" || mode === "prepay_out" || mode === "collect_in";
}

export function debtInterestAmountForRecord(mode: string | null | undefined, rawInterest: number) {
  const interest = Math.abs(Number.isFinite(rawInterest) ? rawInterest : 0);
  if (!allowsDebtInterest(mode) || interest <= 0) return 0;
  return interest;
}

/**
 * 还回利息 = 收入（正）；还出 / 提前还款利息 = 支出（负）。
 * 借入 / 借出强制无利息。
 */
export function debtRealizedProfitForRecord(mode: string | null | undefined, rawInterest: number) {
  const interest = debtInterestAmountForRecord(mode, rawInterest);
  if (interest <= 0) return null;
  if (mode === "collect_in") return interest;
  if (mode === "repay_out" || mode === "prepay_out") return -interest;
  return null;
}

/** 交换流出/流入时保留「本金往来 vs 还本付息」，不靠利息有无改语义。 */
export function swapDebtFlowDirection(mode: DebtActivityMode): DebtActivityMode {
  if (mode === "borrow_in") return "lend_out";
  if (mode === "lend_out") return "borrow_in";
  if (mode === "collect_in") return "repay_out";
  if (mode === "repay_out") return "collect_in";
  return mode;
}

export type DebtPrincipalEntryLike = {
  amount: unknown;
  debtPrincipalAmount?: unknown;
  source?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
};

function debtNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function debtPrincipalForAccountSide(
  entry: DebtPrincipalEntryLike,
  debtAccountIdOrIds: string | Set<string>,
) {
  const amount = debtNumber(entry.amount);
  const principal = entry.debtPrincipalAmount == null ? Math.abs(amount) : debtNumber(entry.debtPrincipalAmount);
  const source = String(entry.source ?? "");
  if (source === "debt_borrow_in" || source === "debt_financed_purchase") return -principal;
  if (source === "debt_repay_out" || source === "debt_prepay_out") return principal;
  if (source === "debt_lend_out") return principal;
  if (source === "debt_collect_in") return -principal;
  if (source === "scheduled_task") return principal;

  const isToDebtAccount = typeof debtAccountIdOrIds === "string"
    ? entry.toAccountId === debtAccountIdOrIds
    : debtAccountIdOrIds.has(entry.toAccountId ?? "");
  if (!isToDebtAccount) return amount;
  return principal;
}
