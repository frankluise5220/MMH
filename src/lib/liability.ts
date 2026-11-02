export type LiabilityDirectionValue = "payable" | "receivable";
export type LiabilityEntryKind = "transfer" | "liability";
export type LiabilityActivityMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";

export type LiabilityAccountFact = {
  kind?: string | null;
  liabilityDirection?: string | null;
  isSettlementAccount?: boolean | null;
};

export const ORDINARY_TRANSFER_SOURCE = "ordinary_transfer_explicit";

export type LiabilityActivityEntryLike = {
  type?: string | null;
  source?: string | null;
  note?: string | null;
  entryKind?: LiabilityEntryKind | null;
  accountId?: string | null;
  accountKind?: string | null;
  accountLiabilityDirection?: string | null;
  accountIsSettlementAccount?: boolean | null;
  toAccountId?: string | null;
  toAccountKind?: string | null;
  toAccountLiabilityDirection?: string | null;
  toAccountIsSettlementAccount?: boolean | null;
};

const LIABILITY_DIRECTION_LABELS: Record<LiabilityDirectionValue, string> = {
  payable: "我欠别人",
  receivable: "别人欠我",
};

export function isLiabilityAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit" || isLoanOrSettlementAccountKind(kind);
}

export function isLoanOrSettlementAccountKind(kind: string | null | undefined) {
  return kind === "loan" || kind === "settlement";
}

export function isLiabilityPrincipalAccount(account: LiabilityAccountFact | null | undefined) {
  return account?.isSettlementAccount === true || isLoanOrSettlementAccountKind(account?.kind);
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

export function liabilityModeFromSource(source: string | null | undefined, note?: string | null): LiabilityActivityMode | null {
  if (source === "liability_borrow_in") return "borrow_in";
  if (source === "liability_financed_purchase") return "borrow_in";
  if (source === "liability_lend_out") return "lend_out";
  if (source === "liability_repay_out") return "repay_out";
  if (source === "liability_prepay_out") return "prepay_out";
  if (source === "liability_collect_in") return "collect_in";
  if (source === "scheduled_task" && String(note ?? "").includes("还贷款")) return "repay_out";
  return null;
}

export function liabilitySourceForMode(mode: LiabilityActivityMode) {
  return `liability_${mode}`;
}

function accountFactForSide(
  entry: LiabilityActivityEntryLike,
  accountById: ReadonlyMap<string, LiabilityAccountFact> | undefined,
  side: "source" | "target",
) {
  const accountId = side === "source" ? entry.accountId : entry.toAccountId;
  const mapped = accountById?.get(accountId ?? "");
  return {
    kind: (side === "source" ? entry.accountKind : entry.toAccountKind) ?? mapped?.kind ?? null,
    liabilityDirection:
      (side === "source" ? entry.accountLiabilityDirection : entry.toAccountLiabilityDirection) ??
      mapped?.liabilityDirection ??
      null,
    isSettlementAccount:
      (side === "source" ? entry.accountIsSettlementAccount : entry.toAccountIsSettlementAccount) ??
      mapped?.isSettlementAccount ??
      null,
  } satisfies LiabilityAccountFact;
}

/**
 * Resolve a transfer's liability meaning from current account facts.
 *
 * Historical `source` is only a fallback when account facts are unavailable.
 * `entryKind` is request metadata: an explicit ordinary-transfer request must
 * never be promoted back to liability semantics by a stale source. Legacy
 * `manual_transfer` rows are deliberately not treated as ordinary transfers:
 * they predate the explicit marker and must be re-read from current accounts.
 */
export function inferLiabilityActivityMode(
  entry: LiabilityActivityEntryLike | null | undefined,
  accountById?: ReadonlyMap<string, LiabilityAccountFact>,
): LiabilityActivityMode | null {
  if (!entry || entry.type !== "transfer") return null;
  if (entry.entryKind === "transfer") return null;
  if (entry.entryKind !== "liability" && (entry.source === ORDINARY_TRANSFER_SOURCE || entry.source === "advance")) {
    return null;
  }

  const sourceAccount = accountFactForSide(entry, accountById, "source");
  const targetAccount = accountFactForSide(entry, accountById, "target");
  const hasAccountInfo = Boolean(
    sourceAccount.kind ||
    targetAccount.kind ||
    sourceAccount.isSettlementAccount != null ||
    targetAccount.isSettlementAccount != null,
  );
  const sourceIsLiability = isLiabilityPrincipalAccount(sourceAccount);
  const targetIsLiability = isLiabilityPrincipalAccount(targetAccount);

  if (sourceIsLiability && targetIsLiability) return null;
  if (sourceIsLiability) {
    return sourceAccount.liabilityDirection === "receivable" ? "collect_in" : "borrow_in";
  }
  if (targetIsLiability) {
    return targetAccount.liabilityDirection === "receivable" ? "lend_out" : "repay_out";
  }
  if (hasAccountInfo) return null;
  return liabilityModeFromSource(entry.source, entry.note);
}

export function inferTransferLiabilityMode(params: {
  fromAccount: LiabilityAccountFact | null | undefined;
  toAccount: LiabilityAccountFact | null | undefined;
  entryKind?: LiabilityEntryKind | null;
  source?: string | null;
  note?: string | null;
}) {
  return inferLiabilityActivityMode({
    type: "transfer",
    source: params.source,
    note: params.note,
    entryKind: params.entryKind,
    accountKind: params.fromAccount?.kind,
    accountLiabilityDirection: params.fromAccount?.liabilityDirection,
    accountIsSettlementAccount: params.fromAccount?.isSettlementAccount,
    toAccountKind: params.toAccount?.kind,
    toAccountLiabilityDirection: params.toAccount?.liabilityDirection,
    toAccountIsSettlementAccount: params.toAccount?.isSettlementAccount,
  });
}

export function isLiabilityActivityEntry(
  entry: LiabilityActivityEntryLike | null | undefined,
  accountById?: ReadonlyMap<string, LiabilityAccountFact>,
) {
  return inferLiabilityActivityMode(entry, accountById) != null;
}

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

type LiabilityPrincipalEntryLike = {
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
  if (source === "liability_financed_purchase") return -Math.abs(principal);
  if (source === "scheduled_task") return principal;
  if (source === "reimbursement") return -Math.abs(principal);

  const isToLiabilityAccount = typeof liabilityAccountIdOrIds === "string"
    ? entry.toAccountId === liabilityAccountIdOrIds
    : liabilityAccountIdOrIds.has(entry.toAccountId ?? "");
  if (isToLiabilityAccount) return principal;
  const isFromLiabilityAccount = typeof liabilityAccountIdOrIds === "string"
    ? entry.accountId === liabilityAccountIdOrIds
    : liabilityAccountIdOrIds.has(entry.accountId ?? "");
  if (isFromLiabilityAccount) return -principal;

  const sourceMode = liabilityModeFromSource(source);
  if (sourceMode === "borrow_in" || sourceMode === "collect_in") return -principal;
  if (sourceMode) return principal;
  return amount;
}

/**
 * Cash-flow sign for a principal-liability account:
 * liability side is the source when cash enters it, and the target when cash
 * leaves it. The account side therefore wins over historical source labels.
 */
export function liabilityCashFlowForAccountSide(
  entry: LiabilityPrincipalEntryLike,
  liabilityAccountIdOrIds: string | Set<string>,
) {
  const amount = liabilityNumber(entry.amount);
  const principal = entry.principalAmount == null ? Math.abs(amount) : liabilityNumber(entry.principalAmount);
  const source = String(entry.source ?? "");
  if (source === "liability_financed_purchase") return 0;

  const isFromLiabilityAccount = typeof liabilityAccountIdOrIds === "string"
    ? entry.accountId === liabilityAccountIdOrIds
    : liabilityAccountIdOrIds.has(entry.accountId ?? "");
  if (isFromLiabilityAccount) return principal;
  const isToLiabilityAccount = typeof liabilityAccountIdOrIds === "string"
    ? entry.toAccountId === liabilityAccountIdOrIds
    : liabilityAccountIdOrIds.has(entry.toAccountId ?? "");
  if (isToLiabilityAccount) return -principal;

  const sourceMode = liabilityModeFromSource(source);
  if (sourceMode === "borrow_in" || sourceMode === "collect_in") return principal;
  if (sourceMode) return -principal;
  return amount;
}
