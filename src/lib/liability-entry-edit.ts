import { toNumber } from "@/lib/date-utils";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";

/**
 * Shared liability activity detection and edit-event construction.
 *
 * Used by every detail table that renders TxRecord rows outside the liability
 * module (account detail view, fixed-asset transaction details, ...) so a
 * liability transfer record always opens the loan/settlement dialog for editing
 * instead of the generic expense/income form.
 */

export type LiabilityMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

export type LiabilityActivityAccountOption = {
  id: string;
  kind?: string | null;
  liabilityDirection?: string | null;
  isSettlementAccount?: boolean | null;
};

export type LiabilityActivityEntryLike = {
  id: string;
  type: string;
  source: string | null;
  note?: string | null;
  accountId?: string | null;
  accountKind?: string | null;
  accountLiabilityDirection?: string | null;
  accountIsSettlementAccount?: boolean | null;
  toAccountId?: string | null;
  toAccountKind?: string | null;
  toAccountLiabilityDirection?: string | null;
  toAccountIsSettlementAccount?: boolean | null;
};

export type LiabilityActivityEditFacts = {
  date: string;
  amount: number;
  categoryId?: string | null;
  principalAmount?: number | null;
  interestAmount?: number | null;
  feeAmount?: number | null;
  realizedProfit?: number | null;
  toNote?: string | null;
};

function liabilityModeFromSource(source: string, note?: string | null): LiabilityMode | null {
  if (source === "liability_borrow_in") return "borrow_in";
  if (source === "liability_financed_purchase") return "borrow_in";
  if (source === "liability_lend_out") return "lend_out";
  if (source === "liability_repay_out") return "repay_out";
  if (source === "liability_prepay_out") return "prepay_out";
  if (source === "liability_collect_in") return "collect_in";
  if (source === "scheduled_task" && String(note ?? "").includes("还贷款")) return "repay_out";
  return null;
}

/** 账户现状是否仍是负债账户（往来款 settlement / 贷款 loan）。 */
function isLiabilityAccountSide(kind?: string | null, isSettlementAccount?: boolean | null) {
  return isSettlementAccount === true || kind === "settlement" || kind === "loan";
}

export function inferLiabilityMode(
  entry: LiabilityActivityEntryLike,
  accountById?: Map<string, LiabilityActivityAccountOption>,
): LiabilityMode | null {
  if (entry.type !== "transfer") return null;
  if (entry.source === "advance") return null;
  const sourceAccount = accountById?.get(entry.accountId ?? "");
  const targetAccount = accountById?.get(entry.toAccountId ?? "");
  const sourceKind = entry.accountKind ?? sourceAccount?.kind ?? null;
  const targetKind = entry.toAccountKind ?? targetAccount?.kind ?? null;
  const sourceMode = liabilityModeFromSource(String(entry.source ?? ""), entry.note);
  if (sourceMode) {
    // `source` 只记录写入时的业务语义；账户被改成普通资金账户后，历史 source 不应再让该行
    // 按负债口径展示/编辑（分类列、类型列、编辑入口都走这里）。账户信息缺失时维持原行为。
    const hasAccountInfo = Boolean(
      sourceKind || targetKind || entry.accountIsSettlementAccount != null || entry.toAccountIsSettlementAccount != null,
    );
    if (!hasAccountInfo) return sourceMode;
    const involvesLiabilityAccount = isLiabilityAccountSide(sourceKind, entry.accountIsSettlementAccount)
      || isLiabilityAccountSide(targetKind, entry.toAccountIsSettlementAccount);
    if (involvesLiabilityAccount) return sourceMode;
  }
  const sourceDirection = entry.accountLiabilityDirection ?? sourceAccount?.liabilityDirection ?? null;
  const targetDirection = entry.toAccountLiabilityDirection ?? targetAccount?.liabilityDirection ?? null;
  if (sourceKind === "loan") return sourceDirection === "receivable" ? "collect_in" : "borrow_in";
  if (targetKind === "loan") return targetDirection === "receivable" ? "lend_out" : "repay_out";
  return null;
}

export function isLiabilityActivityEntry(
  entry: LiabilityActivityEntryLike,
  accountById?: Map<string, LiabilityActivityAccountOption>,
) {
  if (entry.type !== "transfer") return false;
  return inferLiabilityMode(entry, accountById) != null;
}

/**
 * Build the `mmh:loan:create` / `mmh:settlement:create` edit event for a liability
 * activity transfer record. Returns null for non-liability rows so callers can
 * fall back to their generic edit path. The payload mirrors what the liability
 * view (liability-view-data) passes when editing the same record; the dialog
 * itself fetches the repayment plan and the linked fixed asset when the
 * event carries no schedule defaults (edit opened outside the liability module).
 */
export function buildLiabilityActivityEditEvent(
  entry: LiabilityActivityEntryLike & LiabilityActivityEditFacts,
  accountById?: Map<string, LiabilityActivityAccountOption>,
): { name: string; detail: Record<string, unknown> } | null {
  const mode = inferLiabilityMode(entry, accountById);
  if (!mode) return null;
  const principalAmount = entry.principalAmount == null
    ? Math.abs(toNumber(entry.amount))
    : toNumber(entry.principalAmount);
  const interestAmount = Math.abs(toNumber(entry.realizedProfit ?? entry.interestAmount ?? 0));
  const feeAmount = Math.abs(toNumber(entry.feeAmount ?? 0));
  const isLiabilityAccountFromSide = mode === "borrow_in" || mode === "collect_in";
  const liabilityAccountId = (isLiabilityAccountFromSide ? entry.accountId : entry.toAccountId) ?? "";
  const cashAccountId = (isLiabilityAccountFromSide ? entry.toAccountId : entry.accountId) ?? "";
  const sourceOption = accountById?.get(entry.accountId ?? "");
  const targetOption = accountById?.get(entry.toAccountId ?? "");
  const sourceIsLoanDialog = (entry.accountKind ?? sourceOption?.kind) === "loan"
    && !(entry.accountIsSettlementAccount ?? sourceOption?.isSettlementAccount);
  const targetIsLoanDialog = (entry.toAccountKind ?? targetOption?.kind) === "loan"
    && !(entry.toAccountIsSettlementAccount ?? targetOption?.isSettlementAccount);
  const dialogType: "loan" | "settlement" = sourceIsLoanDialog || targetIsLoanDialog ? "loan" : "settlement";
  return {
    name: dialogType === "loan" ? "mmh:loan:create" : "mmh:settlement:create",
    detail: {
      editEntryId: entry.id,
      mode,
      dialogType,
      defaultLiabilityAccountId: liabilityAccountId,
      defaultCashAccountId: cashAccountId,
      defaultLoanFundingMode: entry.source === "liability_financed_purchase" ? "financed_purchase" : "cash_disbursement",
      defaultDate: entry.date,
      defaultPrincipal: principalAmount,
      defaultInterest: interestAmount,
      defaultPenalty: feeAmount,
      defaultLoanPurposeCategoryId: mode === "borrow_in" ? (entry.categoryId ?? null) : null,
      defaultNote: entry.note ?? "",
      defaultPrepayStrategy: entry.source === "liability_prepay_out"
        ? parseLoanPrepayStrategy(entry.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
        : undefined,
    },
  };
}
