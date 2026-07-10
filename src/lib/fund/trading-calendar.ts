export const TRADING_CALENDARS = ["cn_fund", "hk_fund", "us_fund", "generic_weekday"] as const;

export type TradingCalendarValue = (typeof TRADING_CALENDARS)[number];

export const TRADING_CALENDAR_LABELS: Record<TradingCalendarValue, string> = {
  cn_fund: "中国基金",
  hk_fund: "香港基金",
  us_fund: "美国基金",
  generic_weekday: "仅跳周末",
};

export function normalizeTradingCalendar(raw: unknown, fallback: TradingCalendarValue = "cn_fund"): TradingCalendarValue {
  const value = String(raw ?? "").trim();
  return TRADING_CALENDARS.includes(value as TradingCalendarValue) ? (value as TradingCalendarValue) : fallback;
}

export function supportsTradingCalendarForAccount(kind: string | null | undefined, investProductType: string | null | undefined) {
  return kind === "investment" && (investProductType === "fund" || investProductType === "money");
}

export function getDefaultTradingCalendarForAccount(kind: string | null | undefined, investProductType: string | null | undefined) {
  return supportsTradingCalendarForAccount(kind, investProductType) ? "cn_fund" : null;
}

export function resolveTradingCalendarForAccount(
  kind: string | null | undefined,
  investProductType: string | null | undefined,
  raw: unknown,
) {
  const fallback = getDefaultTradingCalendarForAccount(kind, investProductType);
  if (!fallback) return null;
  return normalizeTradingCalendar(raw, fallback);
}
