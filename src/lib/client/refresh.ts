"use client";

export const FINANCE_DATA_CHANGED_EVENT = "mmh:finance:changed";

export type FinanceDataChangedDetail = {
  reason?: string;
  accountIds?: string[];
  entryIds?: string[];
  deletedEntryIds?: string[];
  statementMonth?: string;
  /**
   * false = this change does NOT affect any account balance (e.g. a remark-only
   * edit). Heavy listeners (sidebar balances, top summary, holdings) must skip
   * their refresh in that case and only the affected record area refreshes.
   * Absent/true keeps the previous full-refresh behavior.
   */
  balanceChanged?: boolean;
};

/**
 * Broadcast a scoped finance-data change.
 *
 * Views should refresh only their affected rows, balances, and summaries.
 * A single event is dispatched: listeners must use FINANCE_DATA_CHANGED_EVENT.
 * (The legacy `mmh:fund:refresh` event and its dual-listening pattern were
 * removed so one save does not trigger every view's refresh twice.)
 */
export function compactFinanceAccountIds(ids: Array<string | null | undefined>) {
  return Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

export function dispatchFinanceDataChanged(detail: FinanceDataChangedDetail = {}) {
  window.dispatchEvent(new CustomEvent(FINANCE_DATA_CHANGED_EVENT, { detail }));
}

/**
 * 明确「不会新增 / 修改 / 删除流水明细行」的事件。
 *
 * 只放开机巡检与行情 / 净值类：它们改的是行情缓存、持仓市值，明细行的集合、
 * 金额、文本、余额都不变。清单必须保守 —— 导入、定投执行、撤销、通知强制落账
 * 这类会真实写流水但可能不带 entryIds 的 reason 一律不能放进来；未知 reason
 * 也按「会改明细」处理。宁可多刷一次当前页，也不能让刚记的一笔不出现。
 */
const ENTRY_NEUTRAL_REASONS = new Set([
  "startup-check",
  "nav-add",
  "wealth-nav-add",
  "nav-refresh",
  "fund-nav-refilled",
  "stock-price-refresh",
  "invest-header-sync",
]);

/** 这次事件会不会动到流水明细行（决定要不要刷明细、要不要作废整份缓存）。 */
export function financeChangeTouchesEntries(detail: FinanceDataChangedDetail): boolean {
  return !detail.reason || !ENTRY_NEUTRAL_REASONS.has(detail.reason);
}

/**
 * 事件是否命中某个账户视图。
 *
 * `accountIds` 缺省 / 为空 = 影响域未知，按全局处理（保守刷新）；带账户时只有
 * 明确命中的视图才刷，避免「在 A 账户记一笔，B 账户也跟着重取」。
 */
export function financeChangeAffectsAccount(
  detail: FinanceDataChangedDetail,
  accountId: string,
  scopeAccountIds?: readonly string[] | null,
): boolean {
  const ids = detail.accountIds ?? [];
  if (ids.length === 0) return true;
  if (ids.includes(accountId)) return true;
  return !!scopeAccountIds?.some((id) => ids.includes(id));
}

/**
 * 会大范围改写明细、必须连「在途分块任务」一起中止的事件。
 * 普通单笔新增 / 编辑不动在途任务（它们拉的就是最新数据，中途打断才是卡顿源）。
 */
export function isBulkFinanceEntryChange(detail: FinanceDataChangedDetail): boolean {
  return /import|batch|reconcile|undo|scheduled-task-execute|force-execute/.test(detail.reason ?? "");
}

export type FinanceEntryImpact = "none" | "text" | "structure";

/**
 * 交易记录被修改后，按「会不会改变行集合 / 排序 / 余额」分档，决定刷新范围。
 *
 * - `none`：行情、净值、开机巡检，明细行一行没变 → 完全不刷。
 * - `text`：编辑了已有记录，且余额相关字段（类型 / 金额 / 日期 / 账户）未变。
 *   行数、排序、逐笔余额、总条数都不变，只有行内文本可能变。索引分页视图只需
 *   取回当前页、按 id 覆盖那几行；缓存不作废、期初余额不重算、其它账户不动。
 *   注意这不是「只改了文本」的严格证明（生产端的 `balanceChanged` 只比较余额
 *   字段），所以这条路径仍然取服务端列表口径的**完整行**，不猜字段白名单。
 * - `structure`：新增 / 删除 / 金额 / 日期 / 账户 / 类型 / 导入 / 对账 / 批量等 →
 *   按账户影响域作废缓存并重取。
 *
 * 索引「全部」视图与筛选 / 标签视图不适用 `text` 档：前者编辑的行可能不在当前页，
 * 后者改了筛选列值会让该行进出结果集，两者都必须重算整个结果集。
 */
export function classifyFinanceEntryChange(detail: FinanceDataChangedDetail): FinanceEntryImpact {
  if (!financeChangeTouchesEntries(detail)) return "none";
  if (
    detail.balanceChanged === false
    && (detail.entryIds?.length ?? 0) > 0
    && (detail.deletedEntryIds?.length ?? 0) === 0
  ) return "text";
  return "structure";
}
