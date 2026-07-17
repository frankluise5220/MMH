export const SYSTEM_FUND_INVESTMENT_CATEGORY = "基金投资";
export const SYSTEM_WEALTH_INVESTMENT_CATEGORY = "理财投资";
export const SYSTEM_DEPOSIT_INVESTMENT_CATEGORY = "存款投资";
export const SYSTEM_METAL_INVESTMENT_CATEGORY = "贵金属投资";
export const SYSTEM_FUND_BUY_CATEGORY = "基金买入";
export const SYSTEM_FUND_REGULAR_INVEST_CATEGORY = "基金定投";
export const SYSTEM_FUND_REDEEM_CATEGORY = "基金赎回";
export const SYSTEM_FUND_CASH_DIVIDEND_CATEGORY = "现金分红";
export const SYSTEM_FUND_REINVEST_DIVIDEND_CATEGORY = "分红再投资";
export const SYSTEM_INVESTMENT_BUY_REFUND_CATEGORY = "买入退回";
export const SYSTEM_INVESTMENT_BUY_FAILED_CATEGORY = "买入失败";
export const SYSTEM_WEALTH_BUY_CATEGORY = "理财买入";
export const SYSTEM_WEALTH_REDEEM_CATEGORY = "理财赎回";
export const SYSTEM_WEALTH_DIVIDEND_CATEGORY = "理财分红";
export const SYSTEM_DEPOSIT_BUY_CATEGORY = "存款存入";
export const SYSTEM_DEPOSIT_REDEEM_CATEGORY = "存款取出";
export const SYSTEM_METAL_BUY_CATEGORY = "贵金属买入";
export const SYSTEM_METAL_REDEEM_CATEGORY = "贵金属卖出";
export const SYSTEM_OTHER_INVESTMENT_CATEGORY = "其他投资";

export const SYSTEM_INVESTMENT_CATEGORIES = [
  SYSTEM_FUND_INVESTMENT_CATEGORY,
  SYSTEM_WEALTH_INVESTMENT_CATEGORY,
  SYSTEM_DEPOSIT_INVESTMENT_CATEGORY,
  SYSTEM_METAL_INVESTMENT_CATEGORY,
  SYSTEM_OTHER_INVESTMENT_CATEGORY,
] as const;

export const SYSTEM_FUND_INVESTMENT_ACTION_CATEGORIES = [
  SYSTEM_FUND_REGULAR_INVEST_CATEGORY,
  SYSTEM_FUND_BUY_CATEGORY,
  SYSTEM_FUND_REDEEM_CATEGORY,
  SYSTEM_FUND_CASH_DIVIDEND_CATEGORY,
  SYSTEM_FUND_REINVEST_DIVIDEND_CATEGORY,
  SYSTEM_INVESTMENT_BUY_REFUND_CATEGORY,
  SYSTEM_INVESTMENT_BUY_FAILED_CATEGORY,
] as const;

export const SYSTEM_WEALTH_INVESTMENT_ACTION_CATEGORIES = [
  SYSTEM_WEALTH_BUY_CATEGORY,
  SYSTEM_WEALTH_REDEEM_CATEGORY,
  SYSTEM_WEALTH_DIVIDEND_CATEGORY,
] as const;

export const SYSTEM_DEPOSIT_INVESTMENT_ACTION_CATEGORIES = [
  SYSTEM_DEPOSIT_BUY_CATEGORY,
  SYSTEM_DEPOSIT_REDEEM_CATEGORY,
] as const;

export const SYSTEM_METAL_INVESTMENT_ACTION_CATEGORIES = [
  SYSTEM_METAL_BUY_CATEGORY,
  SYSTEM_METAL_REDEEM_CATEGORY,
] as const;

export const SYSTEM_INVESTMENT_ACTION_CATEGORIES = [
  ...SYSTEM_FUND_INVESTMENT_ACTION_CATEGORIES,
  ...SYSTEM_WEALTH_INVESTMENT_ACTION_CATEGORIES,
  ...SYSTEM_DEPOSIT_INVESTMENT_ACTION_CATEGORIES,
  ...SYSTEM_METAL_INVESTMENT_ACTION_CATEGORIES,
] as const;

export function getInvestmentCategoryName(entry: {
  fundProductType?: string | null;
  fundSubtype?: string | null;
  source?: string | null;
  insuranceProductId?: string | null;
}) {
  if (entry.source === "insurance" || entry.insuranceProductId) return null;
  const productType = entry.fundProductType ?? null;
  const subtype = entry.fundSubtype ?? null;
  const source = entry.source ?? null;

  if (subtype === "buy_failed" && source === "regular_invest_refund") return SYSTEM_INVESTMENT_BUY_REFUND_CATEGORY;
  if (subtype === "buy_failed") return SYSTEM_INVESTMENT_BUY_FAILED_CATEGORY;

  if (productType === "wealth") {
    if (subtype === "redeem" || subtype === "switch_out") return SYSTEM_WEALTH_REDEEM_CATEGORY;
    if (subtype === "dividend_cash") return SYSTEM_WEALTH_DIVIDEND_CATEGORY;
    return SYSTEM_WEALTH_BUY_CATEGORY;
  }

  if (productType === "deposit") {
    if (subtype === "redeem" || subtype === "switch_out") return SYSTEM_DEPOSIT_REDEEM_CATEGORY;
    return SYSTEM_DEPOSIT_BUY_CATEGORY;
  }

  if (productType === "metal") {
    if (subtype === "redeem" || subtype === "switch_out") return SYSTEM_METAL_REDEEM_CATEGORY;
    return SYSTEM_METAL_BUY_CATEGORY;
  }

  if (productType === "fund" || productType === "money" || !productType) {
    if ((subtype === "buy" || subtype === "regular_invest") && source === "regular_invest") return SYSTEM_FUND_REGULAR_INVEST_CATEGORY;
    if (subtype === "redeem" || subtype === "switch_out") return SYSTEM_FUND_REDEEM_CATEGORY;
    if (subtype === "dividend_cash") return SYSTEM_FUND_CASH_DIVIDEND_CATEGORY;
    if (subtype === "dividend_reinvest" || (subtype === "buy" && source === "dividend")) return SYSTEM_FUND_REINVEST_DIVIDEND_CATEGORY;
    if (subtype === "buy" || !subtype) return SYSTEM_FUND_BUY_CATEGORY;
  }

  return SYSTEM_OTHER_INVESTMENT_CATEGORY;
}
