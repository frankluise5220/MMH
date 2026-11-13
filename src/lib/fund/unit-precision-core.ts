export const DEFAULT_FUND_UNITS_DECIMALS = 2;
export const MIN_FUND_UNITS_DECIMALS = 0;
export const MAX_FUND_UNITS_DECIMALS = 6;

/**
 * 贵金属数量（克 / 盎司 / 千克）的下限小数位。
 * 基金份额默认 2 位够用，贵金属不够：单位字典是 3 位、提取实物 / 积存按 4 位落库、
 * 数据库列本身是 Decimal(20,6)。前端录入、展示与服务端落库必须同口径，
 * 否则用户填的 0.0001 克会在提交时被 round 成 0.00。
 */
export const METAL_QUANTITY_DECIMALS = 4;

/** 按投资产品类型解析数量小数位；账户上设得比下限更精细时尊重账户设置。 */
export function resolveQuantityDecimals(
  productType: string | null | undefined,
  rawDecimals: unknown,
): number {
  const base = normalizeFundUnitsDecimals(rawDecimals);
  return productType === "metal" ? Math.max(base, METAL_QUANTITY_DECIMALS) : base;
}

export function normalizeFundUnitsDecimals(
  raw: unknown,
  fallback = DEFAULT_FUND_UNITS_DECIMALS,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    Math.max(Math.round(value), MIN_FUND_UNITS_DECIMALS),
    MAX_FUND_UNITS_DECIMALS,
  );
}

export function roundFundUnits(
  value: number,
  decimals = DEFAULT_FUND_UNITS_DECIMALS,
): number {
  if (!Number.isFinite(value)) return value;
  const normalizedDecimals = normalizeFundUnitsDecimals(decimals);
  const factor = 10 ** normalizedDecimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function formatFundUnitsValue(
  value: number,
  decimals = DEFAULT_FUND_UNITS_DECIMALS,
): string {
  return roundFundUnits(value, decimals).toFixed(normalizeFundUnitsDecimals(decimals));
}

export function roundNullableFundUnits(
  value: number | null | undefined,
  decimals = DEFAULT_FUND_UNITS_DECIMALS,
): number | null {
  if (value == null) return null;
  return roundFundUnits(value, decimals);
}
