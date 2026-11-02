import { toNumber } from "@/lib/date-utils";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import {
  inferLiabilityActivityMode,
  isLiabilityActivityEntry as isCanonicalLiabilityActivityEntry,
  type LiabilityAccountFact,
  type LiabilityActivityMode,
} from "@/lib/liability";

/**
 * Shared liability activity detection and edit-event construction.
 *
 * Used by every detail table that renders TxRecord rows outside the liability
 * module (account detail view, fixed-asset transaction details, ...) so a
 * liability transfer record always opens the loan/settlement dialog for editing
 * instead of the generic expense/income form.
 */

export type LiabilityMode = LiabilityActivityMode;

type LiabilityActivityAccountOption = LiabilityAccountFact & {
  id: string;
};

type LiabilityActivityEntryLike = {
  id: string;
  type: string;
  source: string | null;
  entryKind?: "transfer" | "liability" | null;
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

type LiabilityActivityEditFacts = {
  date: string;
  postedAt?: string | null;
  amount: number;
  categoryId?: string | null;
  principalAmount?: number | null;
  interestAmount?: number | null;
  feeAmount?: number | null;
  realizedProfit?: number | null;
  toNote?: string | null;
  entryTags?: Array<{
    tagId?: string | null;
    Tag?: { name?: string | null; color?: string | null } | null;
  }>;
};

export function inferLiabilityMode(
  entry: LiabilityActivityEntryLike,
  accountById?: Map<string, LiabilityActivityAccountOption>,
): LiabilityMode | null {
  return inferLiabilityActivityMode(entry, accountById);
}

export function isLiabilityActivityEntry(
  entry: LiabilityActivityEntryLike,
  accountById?: Map<string, LiabilityActivityAccountOption>,
) {
  return isCanonicalLiabilityActivityEntry(entry, accountById);
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
  const principalAmount = Math.abs(
    entry.principalAmount == null ? toNumber(entry.amount) : toNumber(entry.principalAmount),
  );
  const interestAmount = Math.abs(toNumber(entry.interestAmount ?? entry.realizedProfit ?? 0));
  const feeAmount = Math.abs(toNumber(entry.feeAmount ?? 0));
  const tagIds = Array.from(new Set(
    (entry.entryTags ?? [])
      .map((item) => item.tagId ?? "")
      .filter(Boolean),
  ));
  const tags = (entry.entryTags ?? [])
    .filter((item) => item.tagId)
    .map((item) => ({
      id: item.tagId,
      name: item.Tag?.name ?? "",
      color: item.Tag?.color ?? null,
    }));
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
      requestId: `edit-${entry.id}-${Date.now()}`,
      editEntryId: entry.id,
      liabilityConversionEntryId: entry.id,
      entryKind: "liability",
      mode,
      dialogType,
      defaultLiabilityAccountId: liabilityAccountId,
      defaultCashAccountId: cashAccountId,
      defaultFromAccountId: entry.accountId ?? "",
      defaultToAccountId: entry.toAccountId ?? "",
      defaultAmount: Math.abs(toNumber(entry.amount)),
      defaultLoanFundingMode: entry.source === "liability_financed_purchase" ? "financed_purchase" : "cash_disbursement",
      defaultDate: entry.date,
      postedAt: entry.postedAt ?? entry.date,
      defaultPrincipal: principalAmount,
      defaultInterest: interestAmount,
      defaultPenalty: feeAmount,
      defaultLoanPurposeCategoryId: mode === "borrow_in" ? (entry.categoryId ?? null) : null,
      defaultNote: entry.note ?? "",
      source: entry.source ?? null,
      tagIds,
      tags,
      defaultPrepayStrategy: entry.source === "liability_prepay_out"
        ? parseLoanPrepayStrategy(entry.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
        : undefined,
    },
  };
}
