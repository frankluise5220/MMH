export const FIXED_ASSET_EXPENSE_CATEGORY_NAME = "\u56fa\u5b9a\u8d44\u4ea7";
export const FIXED_ASSET_INVEST_PRODUCT_TYPE = "property";
export const FIXED_ASSET_ACCOUNT_KIND = "fixed_asset";

export const FIXED_ASSET_TYPES = [
  "property",
  "vehicle",
  "equipment",
  "furniture",
  "collectible",
  "other",
] as const;

export type FixedAssetType = (typeof FIXED_ASSET_TYPES)[number];

export function isFixedAssetType(value: string | null | undefined): value is FixedAssetType {
  return FIXED_ASSET_TYPES.includes(value as FixedAssetType);
}

export function normalizeFixedAssetType(value: unknown): FixedAssetType {
  return isFixedAssetType(String(value ?? "").trim()) ? (String(value ?? "").trim() as FixedAssetType) : "property";
}

/**
 * 一组资产行（`PropertyAsset.assetType`）里占多数的类型，没有合法值则返回 `null`。
 *
 * 为什么需要它：`Account.fixedAssetType` 是**后来才加的列**（迁移
 * `20260828_add_fixed_asset_type` 只 `ADD COLUMN`、没有回填），存量固定资产账户
 * 全是 `NULL`，真实类型只存在于资产行上。分组/入口一律用
 * `account.fixedAssetType ?? "property"` 兜底的话，车辆、设备会被整体塞进「房产」，
 * 而按类型过滤的视图又只认资产行的 `assetType` —— 结果就是**这些资产从入口消失**。
 * 读侧必须回退到这里，写侧必须把资产行的真实类型回写账户。
 */
export function dominantFixedAssetType(
  types: ReadonlyArray<string | null | undefined>,
): FixedAssetType | null {
  const counts = new Map<FixedAssetType, number>();
  for (const raw of types) {
    const value = String(raw ?? "").trim();
    if (!isFixedAssetType(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: FixedAssetType | null = null;
  let bestCount = 0;
  // 并列时取 FIXED_ASSET_TYPES 里的靠前者（property 优先），保证结果稳定。
  for (const type of FIXED_ASSET_TYPES) {
    const count = counts.get(type) ?? 0;
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

export type FixedAssetAccountLike = {
  kind?: string | null;
  investProductType?: string | null;
};

export function isFixedAssetExpenseCategoryName(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const leaf = raw.includes(".") ? raw.split(".").pop() ?? raw : raw;
  return leaf.trim() === FIXED_ASSET_EXPENSE_CATEGORY_NAME;
}

export function isFixedAssetExpenseCategoryPath(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  return raw.split(".").some((part) => part.trim() === FIXED_ASSET_EXPENSE_CATEGORY_NAME);
}

export function isFixedAssetAccountLike(account: FixedAssetAccountLike | null | undefined) {
  return account?.kind === FIXED_ASSET_ACCOUNT_KIND || (account?.kind === "investment" && account.investProductType === FIXED_ASSET_INVEST_PRODUCT_TYPE);
}

export function userFacingAccountKind(account: FixedAssetAccountLike | null | undefined): string {
  return isFixedAssetAccountLike(account) ? FIXED_ASSET_ACCOUNT_KIND : (account?.kind ?? "other");
}
