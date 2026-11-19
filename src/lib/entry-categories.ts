/**
 * 明细行的「交易类型」分类口径：收支 / 转账 / 收益 / 其他。
 *
 * 为什么要单独分「收益交易」：货基按万份收益逐日结转，一年就是几百条 `money_fund_income`
 * 流水，基金分红也是同样性质，条数确实多。但这类行**真实改变账户余额**（货基份额每天
 * 按万份收益增长），默认藏起来会让明细的余额列凭空跳动、账对不上，所以明细页默认全选，
 * 嫌吵的用户自己在「交易类型」下拉里取消勾选。
 */

export type EntryCategory = "incomeExpense" | "transfer" | "yield" | "other";

export const ENTRY_CATEGORY_VALUES: readonly EntryCategory[] = [
  "incomeExpense",
  "transfer",
  "yield",
  "other",
];

export const ENTRY_CATEGORY_LABEL_KEYS: Record<EntryCategory, string> = {
  incomeExpense: "entryCategory.incomeExpense",
  transfer: "entryCategory.transfer",
  yield: "entryCategory.yield",
  other: "entryCategory.other",
};

/**
 * 默认视图：全部分类（含收益）。
 * 收益行会改变余额（货基每日结转、基金分红入账），藏起来等于让余额列对不上账。
 */
export const DEFAULT_ENTRY_CATEGORIES: EntryCategory[] = [...ENTRY_CATEGORY_VALUES];

/** 收益性质的来源：货基收益结转、分红。 */
const YIELD_SOURCES = new Set(["money_fund_income", "dividend"]);
/** 收益性质的基金业务子类型：现金分红 / 红利再投资。 */
const YIELD_FUND_SUBTYPES = new Set(["dividend_cash", "dividend_reinvest"]);

type CategorizableRow = {
  type?: string | null;
  source?: string | null;
  fundSubtype?: string | null;
};

/**
 * 一条明细属于哪一类。判定顺序：收益 → 转账 → 收支 → 其他。
 * 投资买入/赎回、借款还款等没有单列的，都落到「其他交易」。
 */
export function entryCategoryOf(row: CategorizableRow | null | undefined): EntryCategory {
  if (!row) return "other";
  const source = (row.source ?? "").trim();
  const fundSubtype = (row.fundSubtype ?? "").trim();
  if (YIELD_SOURCES.has(source) || YIELD_FUND_SUBTYPES.has(fundSubtype)) return "yield";

  const type = (row.type ?? "").trim();
  if (type === "transfer") return "transfer";
  if (type === "income" || type === "expense") return "incomeExpense";
  return "other";
}

/**
 * 选中的分类是否放行这一行。全选视为「全部」；空选择是「一条都不显示」——
 * 「交易类型」面板右上角的「全部交易」按钮就是靠这两个端点做 全选↔全不选 切换
 * （与表头字段筛选一致），所以这里不能把空选择当成全部。
 */
export function matchesEntryCategories(
  row: CategorizableRow | null | undefined,
  categories: readonly string[],
): boolean {
  if (categories.length === 0) return false;
  if (categories.length >= ENTRY_CATEGORY_VALUES.length) return true;
  return categories.includes(entryCategoryOf(row));
}

/** 把任意来源（URL / 本地存储）的值收敛成合法分类，保持固定顺序。 */
export function normalizeEntryCategories(input: unknown): EntryCategory[] {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const wanted = new Set(raw.map((item) => String(item).trim()));
  return ENTRY_CATEGORY_VALUES.filter((value) => wanted.has(value));
}
