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

/**
 * 与服务端明细 SQL 的 `isAnchor` 判定保持一致（detail-page-query.ts）：
 * 来源必须是「余额校准」或「期初余额」，**并且**备注里带目标值。
 *
 * 只带备注前缀、来源不对的行，服务端不当锚点，客户端也不能当——否则本页余额
 * 重算会和服务端的窗口函数口径分叉，出现「前端一个数字、刷新后另一个数字」。
 */
export function getBalanceAnchorTarget(entry: BalanceReconcileEntryLike) {
  const source = String(entry.source ?? "");
  if (source !== BALANCE_RECONCILE_SOURCE && source !== BALANCE_INITIALIZATION_SOURCE) return null;
  return getBalanceReconcileTarget(entry);
}

function amountForAccount(entry: AccountFlowEntryLike, accountId?: string | null) {
  const amount = toNumber(entry.amount);
  if (isLiabilityAccountReceivingSide(entry, accountId)) return toNumber(entry.principalAmount);
  return accountId && entry.toAccountId === accountId
    ? Math.abs(toNumber(entry.fundArrivalAmount ?? amount))
    : amount;
}

export function effectiveAmountForAccount(entry: AccountFlowEntryLike, accountId?: string | null) {
  const target = getBalanceReconcileTarget(entry);
  if (target != null) return 0;
  return amountForAccount(entry, accountId);
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

/**
 * 锚点口径版折叠，与服务端明细 SQL 完全一致（detail-page-query.ts 的 isAnchor）。
 *
 * 备注带目标值、但来源不是「余额校准 / 期初余额」的行：服务端不认它是锚点，
 * 这里也必须按普通流水累加；直接沿用 applyBalanceReconcileEntry 会把它误判为
 * 锚点（那条函数只看备注），本页余额重算就会和服务端分叉。
 */
export function applyBalanceAnchorEntry(
  currentBalance: number,
  entry: AccountFlowEntryLike,
  accountId?: string | null,
) {
  const anchorTarget = getBalanceAnchorTarget(entry);
  if (anchorTarget != null) return anchorTarget;
  if (getBalanceReconcileTarget(entry) != null) return currentBalance + amountForAccount(entry, accountId);
  return applyBalanceReconcileEntry(currentBalance, entry, accountId);
}
