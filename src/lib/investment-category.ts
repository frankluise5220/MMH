export const SYSTEM_FUND_INVESTMENT_CATEGORY = "基金投资";
export const SYSTEM_WEALTH_INVESTMENT_CATEGORY = "理财投资";
export const SYSTEM_DEPOSIT_INVESTMENT_CATEGORY = "存款投资";
export const SYSTEM_METAL_INVESTMENT_CATEGORY = "贵金属投资";
export const SYSTEM_OTHER_INVESTMENT_CATEGORY = "其他投资";

export const SYSTEM_INVESTMENT_CATEGORIES = [
  SYSTEM_FUND_INVESTMENT_CATEGORY,
  SYSTEM_WEALTH_INVESTMENT_CATEGORY,
  SYSTEM_DEPOSIT_INVESTMENT_CATEGORY,
  SYSTEM_METAL_INVESTMENT_CATEGORY,
  SYSTEM_OTHER_INVESTMENT_CATEGORY,
] as const;

export function getInvestmentCategoryName(entry: {
  fundProductType?: string | null;
  source?: string | null;
  insuranceProductId?: string | null;
}) {
  if (entry.source === "insurance" || entry.insuranceProductId) return null;
  if (entry.fundProductType === "wealth") return SYSTEM_WEALTH_INVESTMENT_CATEGORY;
  if (entry.fundProductType === "deposit") return SYSTEM_DEPOSIT_INVESTMENT_CATEGORY;
  if (entry.fundProductType === "metal") return SYSTEM_METAL_INVESTMENT_CATEGORY;
  if (entry.fundProductType === "fund" || entry.fundProductType === "money") return SYSTEM_FUND_INVESTMENT_CATEGORY;
  return SYSTEM_OTHER_INVESTMENT_CATEGORY;
}
