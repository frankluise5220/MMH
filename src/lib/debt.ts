export type DebtDirectionValue = "payable" | "receivable";

export const DEBT_DIRECTION_LABELS: Record<DebtDirectionValue, string> = {
  payable: "我欠别人",
  receivable: "别人欠我",
};

export function isDebtAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit" || kind === "loan";
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
