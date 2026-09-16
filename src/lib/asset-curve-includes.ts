/** Client-safe helpers for the /statistics asset curve checkboxes. */

export type AssetCurveIncludes = {
  insurance: boolean;
  property: boolean;
  settlement: boolean;
};

export const DEFAULT_ASSET_CURVE_INCLUDES: AssetCurveIncludes = {
  insurance: true,
  property: true,
  settlement: true,
};

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Subtract opted-out buckets from the month-end net (default = all included). */
export function applyAssetCurveIncludes(
  level: {
    netAssetCost: number;
    netAssetMarketValue: number;
    insurance: number;
    propertyCost: number;
    propertyMarket: number;
    settlement: number;
  },
  includes: AssetCurveIncludes,
): { netAssetCost: number; netAssetMarketValue: number } {
  const insurance = includes.insurance ? 0 : level.insurance;
  const propertyCost = includes.property ? 0 : level.propertyCost;
  const propertyMarket = includes.property ? 0 : level.propertyMarket;
  const settlement = includes.settlement ? 0 : level.settlement;
  return {
    netAssetCost: round2(level.netAssetCost - insurance - propertyCost - settlement),
    netAssetMarketValue: round2(level.netAssetMarketValue - insurance - propertyMarket - settlement),
  };
}
