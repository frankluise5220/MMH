/**
 * 固定资产折旧 / 折损口径（全项目唯一实现）。
 *
 * 一个固定资产有两个价值口径，别混用：
 * - **账面成本 `cost`**：购入 + 改良追加的累计投入，是不动值（处置/出售不改它）。
 * - **账面净值**：`cost − 累计折旧/折损`。售出、处置的损益都按净值算，
 *   否则「车开了四年、折损 20 万」还会被当成全额损失，等于折旧白记。
 *
 * 累计折旧/折损的生效规则（只有这一个口径，调用点不要各自推算）：
 * - 已售 / 已处置（status = sold | disposed）：一律以库里存的 `accumulatedDepreciation`
 *   为准。终止时的数字是当时结算出来的（直线法推算值 + 本次额外折损），
 *   之后再按时间推算会凭空长出折旧。
 * - `depreciationMethod = none`：`accumulatedDepreciation` 就是用户手填的累计折旧/折损。
 * - `depreciationMethod = straight_line`：按 `purchaseDate → asOfDate` 的整月数直线推算
 *   `(cost − 残值) × 已用月数 / 折旧年限月数`，再叠加手填的「额外折损/减值」，上限为成本。
 *
 * 日期一律按 UTC 日键（`YYYY-MM-DD`）比较：项目里 date-only 字段都存 UTC 零点
 * （见 AGENTS.md 的日期契约），这里不碰本地时区。
 */

/** 折旧方式：不计提（手填累计折旧）/ 按年限直线法。 */
export const DepreciationMethod = {
  none: "none",
  straightLine: "straight_line",
} as const;
export type DepreciationMethod = (typeof DepreciationMethod)[keyof typeof DepreciationMethod];

export const DEPRECIATION_METHODS: DepreciationMethod[] = [DepreciationMethod.none, DepreciationMethod.straightLine];

/** 重量单位（只影响展示，库里存的是用户填的数字 + 单位本身）。 */
export const WEIGHT_UNITS = ["kg", "t", "g"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];

export type AssetDepreciationInput = {
  cost?: unknown;
  purchaseDate?: Date | string | null;
  status?: string | null;
  depreciationMethod?: string | null;
  usefulLifeMonths?: number | null;
  salvageValue?: unknown;
  accumulatedDepreciation?: unknown;
  /**
   * 已落账的台账累计折旧（`property_asset_depreciations` 之和）。
   *
   * 传了就以它为准（直线法、未终止时），不再按日期推算：改过折旧年限 / 残值 / 成本
   * 的资产，历史期间按当时基数落账（会计估计变更＝未来适用法），从头推算会和台账不一致。
   * 调用方必须保证这个数是**结算日为止**的累计（期间没覆盖到位就别传）。
   */
  recordedAccumulated?: unknown;
};

export type AssetDepreciation = {
  method: DepreciationMethod;
  /** 是否已终止（已售/已处置）：true 时 accumulated 直接取库里存的值。 */
  settled: boolean;
  /** 折旧年限（月），0 = 未设置。 */
  usefulLifeMonths: number;
  /** 预计残值，已夹在 [0, cost] 内。 */
  salvageValue: number;
  /** 可折旧基数 = cost − 残值。 */
  depreciableBase: number;
  /** 每月折旧额（直线法且年限>0 时才有值）。 */
  monthly: number;
  /** 直线法按日期推算出的累计折旧（none 方式为 0）。 */
  autoAccumulated: number;
  /** 手工登记部分：none = 累计折旧；straight_line = 额外折损/减值。 */
  manualAccumulated: number;
  /** 生效的累计折旧/折损（已夹在 [0, cost]）。 */
  accumulated: number;
  /** 账面净值 = cost − accumulated。 */
  netBookValue: number;
  /** 已用整月数（purchaseDate → asOf）。 */
  monthsUsed: number;
};

function num(value: unknown): number {
  const parsed = Number(typeof value === "string" ? value.replace(/,/g, "") : value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function normalizeDepreciationMethod(value: unknown): DepreciationMethod {
  const raw = String(value ?? "").trim();
  return DEPRECIATION_METHODS.includes(raw as DepreciationMethod)
    ? (raw as DepreciationMethod)
    : DepreciationMethod.none;
}

export function normalizeWeightUnit(value: unknown): WeightUnit {
  const raw = String(value ?? "").trim().toLowerCase();
  return (WEIGHT_UNITS as readonly string[]).includes(raw) ? (raw as WeightUnit) : "kg";
}

/** `YYYY-MM-DD` → { y, m, d }；拿不到就返回 null。 */
function dateParts(value: unknown): { y: number; m: number; d: number } | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

/** 两个日键之间的整月数（未满一个月不计）。 */
export function monthsBetween(from: unknown, to: unknown): number {
  const start = dateParts(from);
  const end = dateParts(to);
  if (!start || !end) return 0;
  let months = (end.y - start.y) * 12 + (end.m - start.m);
  if (end.d < start.d) months -= 1;
  return Math.max(0, months);
}

export function resolveAssetDepreciation(
  input: AssetDepreciationInput,
  asOfDateKey?: string | null,
): AssetDepreciation {
  const cost = Math.max(0, num(input.cost));
  const method = normalizeDepreciationMethod(input.depreciationMethod);
  const settled = input.status === "sold" || input.status === "disposed";
  const usefulLifeMonths = Math.max(0, Math.round(num(input.usefulLifeMonths)));
  const salvageValue = clamp(num(input.salvageValue), 0, cost);
  const depreciableBase = Math.max(0, cost - salvageValue);
  const manualAccumulated = clamp(num(input.accumulatedDepreciation), 0, cost);
  const monthsUsed = monthsBetween(input.purchaseDate, asOfDateKey);
  const monthly = method === DepreciationMethod.straightLine && usefulLifeMonths > 0
    ? depreciableBase / usefulLifeMonths
    : 0;
  // 台账累计优先（直线法、未终止）：改过折旧年限 / 残值 / 成本后，历史期间是按
  // 当时基数落账的，从头推算会把历史一起重算，和台账对不上。
  const recordedAccumulated = clamp(num(input.recordedAccumulated), 0, depreciableBase);
  const autoAccumulated = method === DepreciationMethod.straightLine && !settled && recordedAccumulated > 0
    ? recordedAccumulated
    : monthly > 0
      ? Math.min(depreciableBase, monthly * Math.min(monthsUsed, usefulLifeMonths))
      : 0;

  let accumulated: number;
  if (settled) {
    accumulated = manualAccumulated;
  } else if (method === DepreciationMethod.straightLine) {
    accumulated = clamp(autoAccumulated + manualAccumulated, 0, cost);
  } else {
    accumulated = manualAccumulated;
  }

  return {
    method,
    settled,
    usefulLifeMonths,
    salvageValue,
    depreciableBase: round2(depreciableBase),
    monthly: round2(monthly),
    autoAccumulated: round2(autoAccumulated),
    manualAccumulated: round2(manualAccumulated),
    accumulated: round2(accumulated),
    netBookValue: round2(Math.max(0, cost - accumulated)),
    monthsUsed,
  };
}

/** 重量展示：数字 + 单位（没填就是空串）。 */
export function formatAssetWeight(weight: unknown, unit?: unknown) {
  const value = num(weight);
  if (!weight || value <= 0) return "";
  const suffix = normalizeWeightUnit(unit);
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
  return `${text} ${suffix}`;
}
