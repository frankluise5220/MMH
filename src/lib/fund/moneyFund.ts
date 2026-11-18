import { FundProductType } from "@prisma/client";

/**
 * 货币基金面值：1 元/份。
 *
 * 货基按摊余成本法核算、按面值报价，份额净值恒为 1.00 元；每日收益只能通过
 * 红利再投结转为份额（见 money-fund-income-accrual）。所以「净值」对货基不是
 * 可变量，而是常量——任何买入/赎回/估值都必须走这个常量，不能读净值缓存：
 * 净值缓存里货基代码对应的是「每万份收益」（0.2~0.7），拿它当净值会放大份额。
 */
export const MONEY_FUND_NAV = 1;

export function isMoneyFundProductType(value: unknown): boolean {
  return value === FundProductType.money || value === "money" || value === "money_fund";
}

/**
 * 记账用的净值：货基恒为 1，其余产品沿用传入值（非法值归一为 0）。
 */
export function effectiveFundNav(productType: unknown, nav: number | null | undefined): number {
  if (isMoneyFundProductType(productType)) return MONEY_FUND_NAV;
  const value = Number(nav ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
