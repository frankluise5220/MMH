/**
 * 一条资金流水该用哪个业务编辑窗（基金 / 理财 / 存款 / 债券 / 贵金属 / 保险）。
 *
 * 背景（2026-10-17）：`TxRecord.fundProductType` 在历史数据里几乎全为 NULL
 * （本库 6103 条投资流水里 6092 条为 NULL），所以「双击编辑打开哪个窗」长期
 * 靠运行时拼凑：先看 `fundProductType`，再看业务关联标签，最后看宿主页面
 * 传进来的账户 → 产品类型映射。三处推导散在 `DetailViewClient` 与
 * `linkDetailCashFlow` 里，任意一处口径不同，同一笔记录就会渲染成两种窗口。
 *
 * 这里把推导收敛成唯一入口，并且**账户侧同时看 kind**：新式存款账户是
 * `kind = "deposit"` + `investProductType = NULL`，只看 `investProductType`
 * 永远推不出 deposit —— 这正是「同一笔存款，关联业务前后打开两个不同窗口」
 * 的根因（关联后靠业务标签推出 deposit，关联前推出 NULL 落到基金窗）。
 */

export type EntryProductType =
  | "fund"
  | "money"
  | "wealth"
  | "bond"
  | "deposit"
  | "metal"
  | "stock"
  | "property"
  | "insurance";

const ENTRY_PRODUCT_TYPES: readonly string[] = [
  "fund",
  "money",
  "wealth",
  "bond",
  "deposit",
  "metal",
  "stock",
  "property",
  "insurance",
];

function normalizeProductType(value: string | null | undefined): EntryProductType | null {
  const text = String(value ?? "").trim();
  return text && ENTRY_PRODUCT_TYPES.includes(text) ? (text as EntryProductType) : null;
}

/** 账户（含 legacy `investment + deposit`）→ 业务产品类型。 */
export function resolveAccountProductType(
  account: { kind?: string | null; investProductType?: string | null } | null | undefined,
): EntryProductType | null {
  if (!account) return null;
  const kind = String(account.kind ?? "").trim();
  const investProductType = normalizeProductType(account.investProductType);
  if (kind === "deposit") return "deposit";
  if (kind === "insurance") return "insurance";
  if (kind === "investment") return investProductType;
  return null;
}

/** 业务关联标签（`buildEntryBusinessLinkSummary` 的 labels）→ 业务产品类型。 */
function productTypeFromBusinessLabels(labels: readonly string[] | null | undefined): EntryProductType | null {
  for (const label of labels ?? []) {
    const text = String(label ?? "").trim();
    if (!text) continue;
    if (text.includes("存款交易")) return "deposit";
    if (text.includes("理财交易")) return "wealth";
    if (text.includes("债券交易")) return "bond";
    if (text.includes("贵金属交易")) return "metal";
    if (text.includes("保险交易")) return "insurance";
    if (text.includes("股票交易")) return "stock";
    if (text.includes("房产交易")) return "property";
    if (text.includes("基金交易")) return "fund";
  }
  return null;
}

/**
 * 解析一条流水的业务产品类型。优先级与既有行为一致，只在账户环节补上 `kind`：
 * 记录自身字段 → 业务关联标签 → 收款/付款账户的产品类型。
 */
export function resolveEntryProductType(entry: {
  fundProductType?: string | null;
  businessLinkLabels?: readonly string[] | null;
  accountProductType?: string | null;
  toAccountProductType?: string | null;
}): EntryProductType | null {
  return (
    normalizeProductType(entry.fundProductType) ??
    productTypeFromBusinessLabels(entry.businessLinkLabels) ??
    normalizeProductType(entry.toAccountProductType) ??
    normalizeProductType(entry.accountProductType) ??
    null
  );
}

/** `link-cash-flow` 接口接受 businessType；货币基金归基金，债券走理财链路。 */
export function toBusinessLinkType(
  productType: EntryProductType | null,
): "fund" | "wealth" | "deposit" | "metal" | "insurance" | "stock" | "property" | null {
  if (!productType) return null;
  if (productType === "money") return "fund";
  if (productType === "bond") return "wealth";
  return productType;
}
