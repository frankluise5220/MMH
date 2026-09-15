import { toNumber } from "@/lib/date-utils";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";

/**
 * Shared debt/loan activity detection and edit-event construction.
 *
 * Used by every detail table that renders TxRecord rows outside the debt
 * module (account detail view, fixed-asset transaction details, ...) so a
 * debt/loan transfer record always opens the debt/loan dialog for editing
 * instead of the generic expense/income form.
 */

export type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

export type DebtActivityAccountOption = {
  id: string;
  kind?: string | null;
  debtDirection?: string | null;
  isSettlementDebt?: boolean | null;
};

export type DebtActivityEntryLike = {
  id: string;
  type: string;
  source: string | null;
  note?: string | null;
  accountId?: string | null;
  accountKind?: string | null;
  accountDebtDirection?: string | null;
  accountIsSettlementDebt?: boolean | null;
  toAccountId?: string | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
  toAccountIsSettlementDebt?: boolean | null;
};

export type DebtActivityEditFacts = {
  date: string;
  amount: number;
  categoryId?: string | null;
  debtPrincipalAmount?: number | null;
  debtInterestAmount?: number | null;
  debtFeeAmount?: number | null;
  realizedProfit?: number | null;
  toNote?: string | null;
};

function debtModeFromSource(source: string, note?: string | null): DebtMode | null {
  if (source === "debt_borrow_in") return "borrow_in";
  if (source === "debt_financed_purchase") return "borrow_in";
  if (source === "debt_lend_out") return "lend_out";
  if (source === "debt_repay_out") return "repay_out";
  if (source === "debt_prepay_out") return "prepay_out";
  if (source === "debt_collect_in") return "collect_in";
  if (source === "scheduled_task" && String(note ?? "").includes("还贷款")) return "repay_out";
  return null;
}

/** 账户现状是否仍是债务账户（往来款 settlement / 贷款 loan）。 */
function isDebtAccountSide(kind?: string | null, isSettlementDebt?: boolean | null) {
  return isSettlementDebt === true || kind === "settlement" || kind === "loan";
}

export function inferDebtMode(
  entry: DebtActivityEntryLike,
  accountById?: Map<string, DebtActivityAccountOption>,
): DebtMode | null {
  if (entry.type !== "transfer") return null;
  if (entry.source === "advance") return null;
  const sourceAccount = accountById?.get(entry.accountId ?? "");
  const targetAccount = accountById?.get(entry.toAccountId ?? "");
  const sourceKind = entry.accountKind ?? sourceAccount?.kind ?? null;
  const targetKind = entry.toAccountKind ?? targetAccount?.kind ?? null;
  const sourceMode = debtModeFromSource(String(entry.source ?? ""), entry.note);
  if (sourceMode) {
    // `source` 只记录写入时的业务语义；账户被改成普通资金账户后，历史 source 不应再让该行
    // 按债务口径展示/编辑（分类列、类型列、编辑入口都走这里）。账户信息缺失时维持原行为。
    const hasAccountInfo = Boolean(
      sourceKind || targetKind || entry.accountIsSettlementDebt != null || entry.toAccountIsSettlementDebt != null,
    );
    if (!hasAccountInfo) return sourceMode;
    const involvesDebtAccount = isDebtAccountSide(sourceKind, entry.accountIsSettlementDebt)
      || isDebtAccountSide(targetKind, entry.toAccountIsSettlementDebt);
    if (involvesDebtAccount) return sourceMode;
  }
  const sourceDirection = entry.accountDebtDirection ?? sourceAccount?.debtDirection ?? null;
  const targetDirection = entry.toAccountDebtDirection ?? targetAccount?.debtDirection ?? null;
  if (sourceKind === "loan") return sourceDirection === "receivable" ? "collect_in" : "borrow_in";
  if (targetKind === "loan") return targetDirection === "receivable" ? "lend_out" : "repay_out";
  return null;
}

export function isDebtActivityEntry(
  entry: DebtActivityEntryLike,
  accountById?: Map<string, DebtActivityAccountOption>,
) {
  if (entry.type !== "transfer") return false;
  return inferDebtMode(entry, accountById) != null;
}

/**
 * Build the `mmh:loan:create` / `mmh:debt:create` edit event for a debt
 * activity transfer record. Returns null for non-debt rows so callers can
 * fall back to their generic edit path. The payload mirrors what the debt
 * view (debt-view-data) passes when editing the same record; the dialog
 * itself fetches the repayment plan and the linked fixed asset when the
 * event carries no schedule defaults (edit opened outside the debt module).
 */
export function buildDebtActivityEditEvent(
  entry: DebtActivityEntryLike & DebtActivityEditFacts,
  accountById?: Map<string, DebtActivityAccountOption>,
): { name: string; detail: Record<string, unknown> } | null {
  const mode = inferDebtMode(entry, accountById);
  if (!mode) return null;
  const principalAmount = entry.debtPrincipalAmount == null
    ? Math.abs(toNumber(entry.amount))
    : toNumber(entry.debtPrincipalAmount);
  const interestAmount = Math.abs(toNumber(entry.realizedProfit ?? entry.debtInterestAmount ?? 0));
  const feeAmount = Math.abs(toNumber(entry.debtFeeAmount ?? 0));
  const isDebtAccountFromSide = mode === "borrow_in" || mode === "collect_in";
  const debtAccountId = (isDebtAccountFromSide ? entry.accountId : entry.toAccountId) ?? "";
  const cashAccountId = (isDebtAccountFromSide ? entry.toAccountId : entry.accountId) ?? "";
  const sourceOption = accountById?.get(entry.accountId ?? "");
  const targetOption = accountById?.get(entry.toAccountId ?? "");
  const sourceIsLoanDialog = (entry.accountKind ?? sourceOption?.kind) === "loan"
    && !(entry.accountIsSettlementDebt ?? sourceOption?.isSettlementDebt);
  const targetIsLoanDialog = (entry.toAccountKind ?? targetOption?.kind) === "loan"
    && !(entry.toAccountIsSettlementDebt ?? targetOption?.isSettlementDebt);
  const dialogType: "loan" | "debt" = sourceIsLoanDialog || targetIsLoanDialog ? "loan" : "debt";
  return {
    name: dialogType === "loan" ? "mmh:loan:create" : "mmh:debt:create",
    detail: {
      editEntryId: entry.id,
      mode,
      dialogType,
      defaultDebtAccountId: debtAccountId,
      defaultCashAccountId: cashAccountId,
      defaultLoanFundingMode: entry.source === "debt_financed_purchase" ? "financed_purchase" : "cash_disbursement",
      defaultDate: entry.date,
      defaultPrincipal: principalAmount,
      defaultInterest: interestAmount,
      defaultPenalty: feeAmount,
      defaultLoanPurposeCategoryId: mode === "borrow_in" ? (entry.categoryId ?? null) : null,
      defaultNote: entry.note ?? "",
      defaultPrepayStrategy: entry.source === "debt_prepay_out"
        ? parseLoanPrepayStrategy(entry.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
        : undefined,
    },
  };
}
