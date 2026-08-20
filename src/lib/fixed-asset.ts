export const FIXED_ASSET_EXPENSE_CATEGORY_NAME = "\u56fa\u5b9a\u8d44\u4ea7";
export const FIXED_ASSET_INVEST_PRODUCT_TYPE = "property";

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
  return account?.kind === "investment" && account.investProductType === FIXED_ASSET_INVEST_PRODUCT_TYPE;
}
