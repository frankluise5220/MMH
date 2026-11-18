export const FIXED_ASSET_EXPENSE_CATEGORY_NAME = "\u56fa\u5b9a\u8d44\u4ea7";
const FIXED_ASSET_INVEST_PRODUCT_TYPE = "property";
const FIXED_ASSET_ACCOUNT_KIND = "fixed_asset";

export const FIXED_ASSET_TYPES = [
  "property",
  "vehicle",
  "equipment",
  "furniture",
  "collectible",
  "other",
] as const;

export type FixedAssetType = (typeof FIXED_ASSET_TYPES)[number];

function isFixedAssetType(value: string | null | undefined): value is FixedAssetType {
  return FIXED_ASSET_TYPES.includes(value as FixedAssetType);
}

export function normalizeFixedAssetType(value: unknown): FixedAssetType {
  return isFixedAssetType(String(value ?? "").trim()) ? (String(value ?? "").trim() as FixedAssetType) : "property";
}

/** 各类型的专属登记属性：表单标签、列表列头、保存时的清理共用这一份清单。 */
export type FixedAssetAttributeField = {
  /** 存放位置：`PropertyAsset.attributes` JSON 的键。 */
  key: string;
  /** i18n key。 */
  labelKey: string;
};

/**
 * 固定资产按类型登记不同属性（2026-11-17 用户裁定「房产的属性与设备、车辆应该不一样」）。
 *
 * 房产的「房产类型 / 地址」是独立列（`propertyType` / `address`），不在这里；
 * 这里只放塞进 `attributes` JSON 的键。空数组 = 该类型没有额外登记属性，
 * 列表退回「明细」合成列，编辑窗也不显示这几格。
 */
export const FIXED_ASSET_ATTRIBUTE_FIELDS: Record<FixedAssetType, readonly FixedAssetAttributeField[]> = {
  property: [],
  vehicle: [
    { key: "plateNo", labelKey: "fixedAssetEdit.attr.plateNo" },
    { key: "brandModel", labelKey: "fixedAssetEdit.attr.brandModel" },
  ],
  equipment: [
    { key: "brand", labelKey: "fixedAssetEdit.attr.brand" },
    { key: "model", labelKey: "fixedAssetEdit.attr.model" },
  ],
  furniture: [
    { key: "brand", labelKey: "fixedAssetEdit.attr.brand" },
    { key: "model", labelKey: "fixedAssetEdit.attr.model" },
  ],
  collectible: [
    { key: "category", labelKey: "fixedAssetEdit.attr.category" },
    { key: "origin", labelKey: "fixedAssetEdit.attr.origin" },
  ],
  other: [],
};

/**
 * 该类型是否按重量登记。
 *
 * 房子、车没有「重量」这个属性（整车整备质量、建筑面积都不是用户记账关心的口径），
 * 重量只给设备 / 家具 / 收藏品（金条、玉石）这类按量计价的资产。
 */
export function fixedAssetSupportsWeight(assetType: FixedAssetType): boolean {
  return assetType !== "property" && assetType !== "vehicle";
}

/** 生产日期的类型化叫法：房子是「建成年份」、车是「出厂日期」，其余仍叫生产日期。 */
export function fixedAssetProductionDateLabelKey(assetType: FixedAssetType): string {
  if (assetType === "property") return "fixedAssetEdit.productionDateProperty";
  if (assetType === "vehicle") return "fixedAssetEdit.productionDateVehicle";
  return "fixedAssetEdit.productionDate";
}

/** 切换类型时要丢弃的属性键（新类型用不到的那些），避免隐藏值继续留在库里。 */
export function fixedAssetAttributeKeysToDrop(from: FixedAssetType, to: FixedAssetType): string[] {
  const keep = new Set(FIXED_ASSET_ATTRIBUTE_FIELDS[to].map((field) => field.key));
  return FIXED_ASSET_ATTRIBUTE_FIELDS[from]
    .map((field) => field.key)
    .filter((key) => !keep.has(key));
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

type FixedAssetAccountLike = {
  kind?: string | null;
  investProductType?: string | null;
};


export function isFixedAssetExpenseCategoryPath(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  return raw.split(".").some((part) => part.trim() === FIXED_ASSET_EXPENSE_CATEGORY_NAME);
}

export function isFixedAssetAccountLike(account: FixedAssetAccountLike | null | undefined) {
  return account?.kind === FIXED_ASSET_ACCOUNT_KIND || (account?.kind === "investment" && account.investProductType === FIXED_ASSET_INVEST_PRODUCT_TYPE);
}

