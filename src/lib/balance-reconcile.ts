import { toNumber } from "@/lib/date-utils";

export const BALANCE_RECONCILE_SOURCE = "balance_reconcile";
export const BALANCE_INITIALIZATION_SOURCE = "initialization";

export const BALANCE_RECONCILE_TARGET_PREFIX = "balance_reconcile_target:";

type BalanceReconcileEntryLike = {
  source?: string | null;
  toNote?: string | null;
};

type AccountFlowEntryLike = BalanceReconcileEntryLike & {
  amount: unknown;
  principalAmount?: unknown;
  fundArrivalAmount?: unknown;
  toAccountId?: string | null;
};

/** 负债账户是转入方：还款/提前还款/借出。资金账户是转入方的收回/借入不能走本金。 */
const LIABILITY_ACCOUNT_RECEIVING_SOURCES = new Set([
  "liability_repay_out",
  "liability_prepay_out",
  "liability_lend_out",
  "scheduled_task",
]);

function isLiabilityAccountReceivingSide(entry: AccountFlowEntryLike, accountId?: string | null) {
  if (!accountId || entry.toAccountId !== accountId || entry.principalAmount == null) return false;
  const source = String(entry.source ?? "");
  // 收回/借入：toAccount 是资金账户，资金侧必须走本息合计（amount），不能用本金覆盖。
  if (source === "liability_collect_in" || source === "liability_borrow_in" || source === "liability_financed_purchase" || source === "reimbursement") {
    return false;
  }
  // 有明确负债 source 时，只有负债账户转入才用本金；无 source 的历史行沿用「转入方=本金」旧启发式。
  return !source || LIABILITY_ACCOUNT_RECEIVING_SOURCES.has(source);
}

export function encodeBalanceReconcileTarget(balance: number) {
  return `${BALANCE_RECONCILE_TARGET_PREFIX}${Number(balance).toFixed(2)}`;
}

export function getBalanceReconcileTarget(entry: BalanceReconcileEntryLike) {
  const raw = String(entry.toNote ?? "").trim();
  if (!raw.startsWith(BALANCE_RECONCILE_TARGET_PREFIX)) return null;
  const value = Number(raw.slice(BALANCE_RECONCILE_TARGET_PREFIX.length));
  return Number.isFinite(value) ? value : null;
}

export function effectiveAmountForAccount(entry: AccountFlowEntryLike, accountId?: string | null) {
  const target = getBalanceReconcileTarget(entry);
  if (target != null) return 0;
  const amount = toNumber(entry.amount);
  if (isLiabilityAccountReceivingSide(entry, accountId)) return toNumber(entry.principalAmount);
  return accountId && entry.toAccountId === accountId
    ? Math.abs(toNumber(entry.fundArrivalAmount ?? amount))
    : amount;
}

export function applyBalanceReconcileEntry(
  currentBalance: number,
  entry: AccountFlowEntryLike,
  accountId?: string | null,
) {
  const target = getBalanceReconcileTarget(entry);
  if (target != null) return target;
  return currentBalance + effectiveAmountForAccount(entry, accountId);
}
