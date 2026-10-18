import { addTradingDaysUtc } from "@/lib/date-utils";

/**
 * 基金 T+N 的**纯函数**层：只做「申请日 + N 个交易日」这类计算，不碰数据库。
 *
 * 客户端组件（交易表单、定投页等）必须从这里取日期工具；
 * 带查询的 `confirmDays.ts` 会 import `@/lib/db/prisma`，被打进浏览器包时
 * 会连锁拉入 better-sqlite3 的原生 `fs` 依赖，直接构建失败。
 */

export type FundConfirmRule = {
  days: number;
  arrivalDays: number;
  /** 赎回成本天数：与买入口径分开保存的赎回侧天数。 */
  redeemCostDays: number;
  /** 规则生效日期（YYYY-MM-DD）；规则行不存在时为 null。 */
  effectiveDate: string | null;
  /** 设置页已保存过 → 其它界面不再能改。 */
  manualOverride: boolean;
  /** 库里是否已有该 accountId + fundCode 的规则行：有行即锁定，交易表单只能改日期。 */
  exists: boolean;
};

export type FundDates = {
  days: number;
  arrivalDays: number;
  tradingCalendar: string;
  confirmDate: string;
  arrivalDate: string;
};

export const DEFAULT_FUND_TRADING_CALENDAR = "cn_fund";
export const DEFAULT_FUND_REDEEM_COST_DAYS = 1;

export function normalizeNonNegativeDays(value: unknown, fallback: number): number {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.max(0, Math.trunc(days));
}

/** 生效日期按 date-only 存取（UTC 零点），与其它按天存储的字段一致。 */
export function formatFundEffectiveDate(value: Date | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function fundUnitsProfitStartDate(
  navDate: string | null | undefined,
  tradingCalendar?: string | null,
): string | null {
  const date = String(navDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return addTradingDaysUtc(date, 1, tradingCalendar ?? DEFAULT_FUND_TRADING_CALENDAR);
}

export function resolveFundTradingCalendar(value?: string | null): string {
  const calendar = String(value ?? "").trim();
  return calendar || DEFAULT_FUND_TRADING_CALENDAR;
}

/** 确认日：申请日 + N 个交易日。 */
export function fundConfirmDate(applyDateYmd: string, days: number, tradingCalendar?: string | null): string {
  const safeDays = normalizeNonNegativeDays(days, 0);
  if (safeDays <= 0) return applyDateYmd;
  return addTradingDaysUtc(applyDateYmd, safeDays, resolveFundTradingCalendar(tradingCalendar));
}

/** 到账日：确认日 + N 个交易日（买、卖、现金分红统一口径）。 */
export function fundArrivalDate(confirmDateYmd: string, arrivalDays: number, tradingCalendar?: string | null): string {
  const safeDays = normalizeNonNegativeDays(arrivalDays, 2);
  if (safeDays <= 0) return confirmDateYmd;
  return addTradingDaysUtc(confirmDateYmd, safeDays, resolveFundTradingCalendar(tradingCalendar));
}
