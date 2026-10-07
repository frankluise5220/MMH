export type LiabilityDirectionValue = "payable" | "receivable";

export const LIABILITY_DIRECTION_LABELS: Record<LiabilityDirectionValue, string> = {
  payable: "我欠别人",
  receivable: "别人欠我",
};

export function isLiabilityAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit" || isLoanOrSettlementAccountKind(kind);
}

export function isLoanOrSettlementAccountKind(kind: string | null | undefined) {
  return kind === "loan" || kind === "settlement";
}

export function normalizeLiabilityDirection(
  kind: string | null | undefined,
  raw: unknown,
): LiabilityDirectionValue | null {
  if (!isLiabilityAccountKind(kind)) return null;
  if (kind === "bank_credit") return "payable";
  const value = String(raw ?? "").trim();
  return value === "receivable" ? "receivable" : "payable";
}

export function liabilityDirectionLabel(raw: string | null | undefined) {
  return raw === "receivable" ? LIABILITY_DIRECTION_LABELS.receivable : LIABILITY_DIRECTION_LABELS.payable;
}

export function liabilityActionLabel(params: {
  direction: string | null | undefined;
  isLiabilityAccountFromSide: boolean;
}) {
  if (params.direction === "receivable") {
    return params.isLiabilityAccountFromSide ? "收回" : "出借";
  }
  return params.isLiabilityAccountFromSide ? "借入" : "还款";
}

export type LiabilityActivityMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

/** 还回/还出/提前还款才允许利息；借入/借出没有利息。 */
export function allowsLiabilityInterest(mode: string | null | undefined) {
  return mode === "repay_out" || mode === "prepay_out" || mode === "collect_in";
}

export function liabilityInterestAmountForRecord(mode: string | null | undefined, rawInterest: number) {
  const interest = Math.abs(Number.isFinite(rawInterest) ? rawInterest : 0);
  if (!allowsLiabilityInterest(mode) || interest <= 0) return 0;
  return interest;
}

/**
 * 还回利息 = 收入（正）；还出 / 提前还款利息 = 支出（负）。
 * 借入 / 借出强制无利息。
 */
export function liabilityRealizedProfitForRecord(mode: string | null | undefined, rawInterest: number) {
  const interest = liabilityInterestAmountForRecord(mode, rawInterest);
  if (interest <= 0) return null;
  if (mode === "collect_in") return interest;
  if (mode === "repay_out" || mode === "prepay_out") return -interest;
  return null;
}

/** 交换流出/流入时保留「本金往来 vs 还本付息」，不靠利息有无改语义。 */
export function swapLiabilityFlowDirection(mode: LiabilityActivityMode): LiabilityActivityMode {
  if (mode === "borrow_in") return "lend_out";
  if (mode === "lend_out") return "borrow_in";
  if (mode === "collect_in") return "repay_out";
  if (mode === "repay_out") return "collect_in";
  return mode;
}

export type LiabilityPrincipalEntryLike = {
  amount: unknown;
  principalAmount?: unknown;
  source?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
};

function liabilityNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function liabilityPrincipalForAccountSide(
  entry: LiabilityPrincipalEntryLike,
  liabilityAccountIdOrIds: string | Set<string>,
) {
  const amount = liabilityNumber(entry.amount);
  const principal = entry.principalAmount == null ? Math.abs(amount) : liabilityNumber(entry.principalAmount);
  const source = String(entry.source ?? "");
  if (source === "liability_borrow_in" || source === "liability_financed_purchase") return -principal;
  if (source === "liability_repay_out" || source === "liability_prepay_out") return principal;
  if (source === "liability_lend_out") return principal;
  if (source === "liability_collect_in") return -principal;
  if (source === "scheduled_task") return principal;
  if (source === "reimbursement") return -principal;

  const isToLiabilityAccount = typeof liabilityAccountIdOrIds === "string"
    ? entry.toAccountId === liabilityAccountIdOrIds
    : liabilityAccountIdOrIds.has(entry.toAccountId ?? "");
  if (!isToLiabilityAccount) return amount;
  return principal;
}
