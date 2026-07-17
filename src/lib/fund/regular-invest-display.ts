import { SYSTEM_FUND_REGULAR_INVEST_CATEGORY } from "@/lib/investment-category";

export const REGULAR_INVEST_CATEGORY_NAME = SYSTEM_FUND_REGULAR_INVEST_CATEGORY;

export function regularInvestBuyNote(fundCode: string | null | undefined, fundName: string | null | undefined) {
  const code = String(fundCode ?? "").trim();
  const name = String(fundName ?? "").trim();
  const displayName = name && name !== code ? `${code}${name}` : code;
  return displayName ? `定投 ${displayName}` : "定投";
}