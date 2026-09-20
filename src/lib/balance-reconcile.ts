import { toNumber } from "@/lib/date-utils";

export const BALANCE_RECONCILE_SOURCE = "balance_reconcile";
export const BALANCE_INITIALIZATION_SOURCE = "initialization";

const TARGET_PREFIX = "balance_reconcile_target:";

type BalanceReconcileEntryLike = {
  source?: string | null;
  toNote?: string | null;
};

type AccountFlowEntryLike = BalanceReconcileEntryLike & {
  amount: unknown;
  debtPrincipalAmount?: unknown;
  fundArrivalAmount?: unknown;
  toAccountId?: string | null;
};

/** 债务账户是转入方：还款/提前还款/借出。资金账户是转入方的收回/借入不能走本金。 */
const DEBT_ACCOUNT_RECEIVING_SOURCES = new Set([
  "debt_repay_out",
  "debt_prepay_out",
  "debt_lend_out",
  "scheduled_task",
]);

function isDebtAccountReceivingSide(entry: AccountFlowEntryLike, accountId?: string | null) {
  if (!accountId || entry.toAccountId !== accountId || entry.debtPrincipalAmount == null) return false;
  const source = String(entry.source ?? "");
  // 收回/借入：toAccount 是资金账户，资金侧必须走本息合计（amount），不能用本金覆盖。
  if (source === "debt_collect_in" || source === "debt_borrow_in" || source === "debt_financed_purchase") {
    return false;
  }
  // 有明确债务 source 时，只有债务账户转入才用本金；无 source 的历史行沿用「转入方=本金」旧启发式。
  return !source || DEBT_ACCOUNT_RECEIVING_SOURCES.has(source);
}

export function encodeBalanceReconcileTarget(balance: number) {
  return `${TARGET_PREFIX}${Number(balance).toFixed(2)}`;
}

export function getBalanceReconcileTarget(entry: BalanceReconcileEntryLike) {
  const raw = String(entry.toNote ?? "").trim();
  if (!raw.startsWith(TARGET_PREFIX)) return null;
  const value = Number(raw.slice(TARGET_PREFIX.length));
  return Number.isFinite(value) ? value : null;
}

export function effectiveAmountForAccount(entry: AccountFlowEntryLike, accountId?: string | null) {
  const target = getBalanceReconcileTarget(entry);
  if (target != null) return 0;
  const amount = toNumber(entry.amount);
  if (isDebtAccountReceivingSide(entry, accountId)) return toNumber(entry.debtPrincipalAmount);
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
