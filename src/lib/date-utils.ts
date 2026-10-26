export function startOfDayUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDaysUtc(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/** Add calendar years while preserving month/day; clamp Feb 29 to Feb 28 when needed. */
export function addCalendarYearsUtc(date: Date, years: number) {
  const year = date.getUTCFullYear() + Math.trunc(years);
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), lastDayOfMonthUtc(year, month));
  return new Date(Date.UTC(year, month, day));
}

/**
 * Calculate a term-deposit maturity date. Short terms remain day-based, while
 * whole-year terms follow the 对年对月对日 rule: the maturity lands on the Nth
 * calendar anniversary (2026-12-21 + 1 年 → 2027-12-21).
 *
 * 「算头不算尾」只约束计息天数（含存入日、不含到期日），不提前到期日。
 * 2026-10-01 更正：旧实现返回 anniversary − 1 天，与 `depositTermMaturityUtc`
 * 的现行口径不一致；两者必须同口径（`depositTermMaturityUtc` 是存单主路径，
 * 本函数是等价的按天入口）。
 */

export function addMonthsUtc(date: Date, months: number) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Statement month for a transaction date. With txPeriod="next" (billing-day
 * transactions count into the next statement) the boundary shifts one day
 * earlier: day < billingDay belongs to this month's statement, day >= billing
 * day to the next one. Defaults to "current" (day <= billingDay).
 *
 * Uses pure month arithmetic — addMonthsUtc would overflow month-end dates
 * (e.g. 2026-08-31 + 1 month rolled into October instead of September).
 */
export function toStatementMonth(date: Date, billingDay: number, txPeriod?: string | null) {
  const normalizedDate = startOfDayUtc(date);
  const year = normalizedDate.getUTCFullYear();
  const month = normalizedDate.getUTCMonth();
  const statementDay = clampDay(year, month, Math.trunc(billingDay));
  const statementDate = new Date(Date.UTC(year, month, statementDay));
  const cycleEnd = txPeriod === "next" ? addDaysUtc(statementDate, -1) : statementDate;
  const monthOffset = normalizedDate.getTime() <= cycleEnd.getTime() ? 0 : 1;
  const absoluteMonth = year * 12 + month + monthOffset;
  const statementYear = Math.floor(absoluteMonth / 12);
  const statementMonthIndex = absoluteMonth % 12;
  return `${statementYear}-${String(statementMonthIndex + 1).padStart(2, "0")}`;
}

export function lastDayOfMonthUtc(y: number, m: number) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export function clampDay(y: number, m: number, day: number) {
  return Math.max(1, Math.min(day, lastDayOfMonthUtc(y, m)));
}

export function creditCardCycle(now: Date, billingDay: number, repaymentDay?: number | null) {
  const today = startOfDayUtc(now);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();

  const thisEnd = new Date(Date.UTC(y, m, clampDay(y, m, billingDay)));
  const end =
    today.getTime() <= thisEnd.getTime()
      ? thisEnd
      : new Date(Date.UTC(y, m + 1, clampDay(y, m + 1, billingDay)));
  const previousEnd = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, clampDay(end.getUTCFullYear(), end.getUTCMonth() - 1, billingDay)),
  );
  const start = addDaysUtc(previousEnd, 1);
  const nextEnd = addDaysUtc(end, 1);
  const isCurrentCycle = today.getTime() >= start.getTime() && today.getTime() < nextEnd.getTime();

  const due =
    repaymentDay && repaymentDay >= 1
      ? (() => {
          const dueMonthOffset = repaymentDay <= billingDay ? 1 : 0;
          const dueMonth = end.getUTCMonth() + dueMonthOffset;
          const dueYear = end.getUTCFullYear() + Math.floor(dueMonth / 12);
          const dueMonthNorm = ((dueMonth % 12) + 12) % 12;
          return new Date(Date.UTC(dueYear, dueMonthNorm, clampDay(dueYear, dueMonthNorm, repaymentDay)));
        })()
      : null;

  return { start, end, due, today, isCurrentCycle };
}

export function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "toNumber" in value) {
    const v = value as { toNumber: () => number };
    return v.toNumber();
  }
  return Number(value ?? 0);
}

export function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type DateDisplayFormat = "yyyy-mm-dd" | "yyyy/mm/dd" | "mm/dd/yyyy" | "dd/mm/yyyy";

export const DEFAULT_DATE_DISPLAY_FORMAT: DateDisplayFormat = "yyyy-mm-dd";

export function normalizeDateDisplayFormat(value: unknown): DateDisplayFormat {
  if (value === "yyyy/mm/dd" || value === "mm/dd/yyyy" || value === "dd/mm/yyyy") return value;
  return DEFAULT_DATE_DISPLAY_FORMAT;
}

function datePartsForDisplay(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }
  const raw = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (match) return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (value == null || raw === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

export function formatDateDisplay(
  value: Date | string | number | null | undefined,
  format: DateDisplayFormat = DEFAULT_DATE_DISPLAY_FORMAT,
): string {
  const parts = datePartsForDisplay(value);
  if (!parts) return "";
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  if (format === "yyyy/mm/dd") return `${year}/${month}/${day}`;
  if (format === "mm/dd/yyyy") return `${month}/${day}/${year}`;
  if (format === "dd/mm/yyyy") return `${day}/${month}/${year}`;
  return `${year}-${month}-${day}`;
}

/**
 * 浏览器本地「今天」（YYYY-MM-DD），**只允许前端表单默认值使用**。
 *
 * 服务端（`src/lib/server/**`、`src/app/api/**`、服务端组件）禁止调用：
 * 容器进程时区通常是 UTC，会与业务时区差 8 小时。服务端一律用
 * `todayDateBusinessYmd()`。
 */
export function todayDateLocalYmd(): string {
  return formatDateLocal(new Date());
}

/**
 * 业务默认时区。生产容器（Docker）通常没有设置 TZ，进程时区就是 UTC，
 * 于是 `formatDateLocal(new Date())` 会在北京时间 00:00–08:00 返回「昨天」，
 * 明细列表的「今天之前可见」过滤会把当天刚记的流水隐藏掉。
 * 服务端判断「今天」必须走显式时区，而不是进程时区。
 */
const DEFAULT_BUSINESS_TIME_ZONE = "Asia/Shanghai";

export function resolveBusinessTimeZone(): string {
  const configured = typeof process !== "undefined" ? process.env.MMH_TIME_ZONE?.trim() : "";
  if (!configured) return DEFAULT_BUSINESS_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: configured }).format(new Date());
    return configured;
  } catch {
    return DEFAULT_BUSINESS_TIME_ZONE;
  }
}

/** 指定时区下的 YYYY-MM-DD（时区非法时回退到业务默认时区）。 */
export function formatDateInTimeZone(d: Date, timeZone: string = resolveBusinessTimeZone()): string {
  if (!Number.isFinite(d.getTime())) return "";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
  } catch {
    return timeZone === DEFAULT_BUSINESS_TIME_ZONE
      ? formatDateLocal(d)
      : formatDateInTimeZone(d, DEFAULT_BUSINESS_TIME_ZONE);
  }
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  if (!year || !month || !day) return formatDateLocal(d);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * 业务时区下的「今天」（服务端专用，不依赖容器 TZ）。
 * 前端表单默认值仍应使用 `todayDateLocalYmd()`，跟随浏览器本地时区。
 */
export function todayDateBusinessYmd(timeZone?: string): string {
  return formatDateInTimeZone(new Date(), timeZone ?? resolveBusinessTimeZone());
}

/**
 * 某一时刻在业务时区下的「当天」UTC 零点。
 * 替换服务端所有 `startOfDayUtc(new Date())` / `utcDayStart(now)`：
 * 那些取的是 UTC 今天，北京时间 00:00–08:00 会少一天。
 */
export function businessDayStartUtc(date: Date = new Date(), timeZone?: string): Date {
  const tz = timeZone ?? resolveBusinessTimeZone();
  return parseDateInputToUtc(formatDateInTimeZone(date, tz)) ?? startOfDayUtc(date);
}

/** 业务时区「今天」的 UTC 零点（Prisma 区间比较 / 日期落库用）。 */
export function businessTodayUtcStart(timeZone?: string): Date {
  return businessDayStartUtc(new Date(), timeZone);
}

/**
 * 存储契约：DB 里所有「日历日」字段一律是 **UTC 零点**。
 * 读回来必须用本函数（= `formatDateUtc`），不要用 `formatDateLocal`。
 */
export function businessDateKey(value: Date): string {
  return formatDateUtc(value);
}

export function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse a YYYY-MM-DD date input value into a UTC-midnight Date; invalid
 * formats return null. Date inputs (<input type="date">) and date-string
 * parsing all go through here to avoid timezone drift.
 */
export function parseDateInputToUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

const FLEXIBLE_DATE_ISO_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/;
const FLEXIBLE_DATE_CN_RE = /^(\d{4})\s*\u5e74\s*(\d{1,2})\s*\u6708\s*(\d{1,2})\s*\u65e5?(?:[T\s].*)?$/;
const FLEXIBLE_DATE_COMPACT_RE = /^(\d{4})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[T\s].*)?$/;
const FLEXIBLE_DATE_MDY_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s].*)?$/;

function ymdFromCalendarParts(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return formatDateUtc(date);
}

export function parseFlexibleDateToYmd(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? formatDateUtc(value) : null;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  let match = FLEXIBLE_DATE_ISO_RE.exec(raw);
  if (match) return ymdFromCalendarParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = FLEXIBLE_DATE_CN_RE.exec(raw);
  if (match) return ymdFromCalendarParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = FLEXIBLE_DATE_COMPACT_RE.exec(raw);
  if (match) return ymdFromCalendarParts(Number(match[1]), Number(match[2]), Number(match[3]));

  match = FLEXIBLE_DATE_MDY_RE.exec(raw);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    return first > 12 && second <= 12
      ? ymdFromCalendarParts(year, second, first)
      : ymdFromCalendarParts(year, first, second);
  }

  if (raw.length >= 8 && /\d{4}/.test(raw)) {
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return null;
    // 统一 UTC 口径（与函数其它分支一致），不要用进程本地时区。
    return formatDateUtc(date);
  }
  return null;
}

const CN_FUND_HOLIDAYS = new Set<string>([
  "2024-01-01",
  "2024-02-10", "2024-02-11", "2024-02-12", "2024-02-13", "2024-02-14", "2024-02-15", "2024-02-16", "2024-02-17",
  "2024-04-04", "2024-04-05", "2024-04-06",
  "2024-05-01", "2024-05-02", "2024-05-03", "2024-05-04", "2024-05-05",
  "2024-06-10",
  "2024-09-15", "2024-09-16", "2024-09-17",
  "2024-10-01", "2024-10-02", "2024-10-03", "2024-10-04", "2024-10-05", "2024-10-06", "2024-10-07",
  "2025-01-01",
  "2025-01-28", "2025-01-29", "2025-01-30", "2025-01-31", "2025-02-01", "2025-02-02", "2025-02-03", "2025-02-04",
  "2025-04-04",
  "2025-05-01", "2025-05-02",
  "2025-05-31",
  "2025-10-01", "2025-10-02", "2025-10-03", "2025-10-04", "2025-10-05", "2025-10-06", "2025-10-07",
  "2026-01-01",
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  "2026-04-05", "2026-04-06",
  "2026-05-01",
  "2026-06-19",
  "2026-09-25",
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
]);

// US stock market (NYSE) holidays, used for QDII funds whose NAV follows the
// US trading calendar and publishes with a lag.
const US_FUND_HOLIDAYS = new Set<string>([
  "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27", "2024-06-19",
  "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19",
  "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

// Hong Kong securities market holidays for HK-linked funds.
const HK_FUND_HOLIDAYS = new Set<string>([
  "2024-01-01",
  "2024-02-12", "2024-02-13",
  "2024-03-29", "2024-04-01", "2024-04-04",
  "2024-05-01", "2024-05-15",
  "2024-06-10",
  "2024-07-01",
  "2024-09-18",
  "2024-10-01", "2024-10-11",
  "2024-12-25", "2024-12-26",
  "2025-01-01",
  "2025-01-29", "2025-01-30", "2025-01-31",
  "2025-04-04", "2025-04-18", "2025-04-21",
  "2025-05-01", "2025-05-05", "2025-05-31",
  "2025-07-01",
  "2025-10-01", "2025-10-07", "2025-10-29",
  "2025-12-25", "2025-12-26",
  "2026-01-01",
  "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-04-03", "2026-04-06", "2026-04-07",
  "2026-05-01", "2026-05-25",
  "2026-06-19",
  "2026-07-01",
  "2026-10-01", "2026-10-19",
  "2026-12-25",
]);

// Japan Exchange Group market holidays for Japan-linked funds.
const JP_FUND_HOLIDAYS = new Set<string>([
  "2024-01-01", "2024-01-02", "2024-01-03", "2024-01-08", "2024-02-12", "2024-02-23",
  "2024-03-20", "2024-04-29", "2024-05-03", "2024-05-06", "2024-07-15", "2024-08-12",
  "2024-09-16", "2024-09-23", "2024-10-14", "2024-11-04", "2024-12-31",
  "2025-01-01", "2025-01-02", "2025-01-03", "2025-01-13", "2025-02-11", "2025-02-24",
  "2025-03-20", "2025-04-29", "2025-05-05", "2025-05-06", "2025-07-21", "2025-08-11",
  "2025-09-15", "2025-09-23", "2025-10-13", "2025-11-03", "2025-11-24", "2025-12-31",
  "2026-01-01", "2026-01-02", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20",
  "2026-04-29", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11",
  "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23",
  "2026-12-31",
]);

function isWeekendUtc(ms: number) {
  const dow = new Date(ms).getUTCDay();
  return dow === 0 || dow === 6;
}

function isCnFundHoliday(dateStr: string) {
  return CN_FUND_HOLIDAYS.has(dateStr);
}

function isUsFundHoliday(dateStr: string) {
  return US_FUND_HOLIDAYS.has(dateStr);
}

function isHkFundHoliday(dateStr: string) {
  return HK_FUND_HOLIDAYS.has(dateStr);
}

function isJpFundHoliday(dateStr: string) {
  return JP_FUND_HOLIDAYS.has(dateStr);
}

export function isTradingClosedDate(dateStr: string, tradingCalendar?: string | null) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ms = Date.UTC(y, (m || 1) - 1, d || 1);
  if (isWeekendUtc(ms)) return true;
  if (tradingCalendar === "cn_fund") return isCnFundHoliday(dateStr);
  if (tradingCalendar === "hk_fund") return isHkFundHoliday(dateStr);
  if (tradingCalendar === "jp_fund") return isJpFundHoliday(dateStr);
  if (tradingCalendar === "us_fund") return isUsFundHoliday(dateStr);
  return false;
}

export function addTradingDaysUtc(dateStr: string, n: number, tradingCalendar?: string | null) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let ms = Date.UTC(y, m - 1, d);
  let added = 0;
  while (added < n) {
    ms += 24 * 60 * 60 * 1000;
    const nextDate = formatDateUtc(new Date(ms));
    if (!isTradingClosedDate(nextDate, tradingCalendar)) added++;
  }
  const result = new Date(ms);
  const ry = result.getUTCFullYear();
  const rm = String(result.getUTCMonth() + 1).padStart(2, "0");
  const rd = String(result.getUTCDate()).padStart(2, "0");
  return `${ry}-${rm}-${rd}`;
}

export function subtractTradingDaysUtc(dateStr: string, n: number, tradingCalendar?: string | null) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let ms = Date.UTC(y, m - 1, d);
  while (isTradingClosedDate(formatDateUtc(new Date(ms)), tradingCalendar)) {
    ms -= 24 * 60 * 60 * 1000;
  }
  let subtracted = 0;
  while (subtracted < n) {
    ms -= 24 * 60 * 60 * 1000;
    const nextDate = formatDateUtc(new Date(ms));
    if (!isTradingClosedDate(nextDate, tradingCalendar)) subtracted++;
  }
  return formatDateUtc(new Date(ms));
}

export function countTradingDaysUtc(startDateStr: string, endDateStr: string, tradingCalendar?: string | null) {
  const start = String(startDateStr ?? "").trim();
  const end = String(endDateStr ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startMs = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  const endMs = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  let count = 0;
  for (let ms = startMs + 24 * 60 * 60 * 1000; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
    const dateStr = formatDateUtc(new Date(ms));
    if (!isTradingClosedDate(dateStr, tradingCalendar)) count++;
  }
  return count;
}

/**
 * Returns whether a date is within the current day or the previous N trading
 * days relative to the reference date. The target date itself is not required
 * to be an open trading day because imported/manual records may use a calendar
 * date while their confirmation date is derived separately.
 */
export function isWithinRecentTradingDaysUtc(
  targetDateStr: string,
  referenceDateStr: string = todayDateBusinessYmd(),
  maxTradingDays = 2,
  tradingCalendar?: string | null,
) {
  const target = String(targetDateStr ?? "").trim();
  const reference = String(referenceDateStr ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target) || !/^\d{4}-\d{2}-\d{2}$/.test(reference)) return false;
  if (!Number.isFinite(maxTradingDays) || maxTradingDays < 0) return false;

  const targetMs = Date.UTC(Number(target.slice(0, 4)), Number(target.slice(5, 7)) - 1, Number(target.slice(8, 10)));
  const referenceMs = Date.UTC(Number(reference.slice(0, 4)), Number(reference.slice(5, 7)) - 1, Number(reference.slice(8, 10)));
  if (!Number.isFinite(targetMs) || !Number.isFinite(referenceMs) || targetMs > referenceMs) return false;

  let tradingDaysAfterTarget = 0;
  for (let ms = targetMs + 24 * 60 * 60 * 1000; ms <= referenceMs; ms += 24 * 60 * 60 * 1000) {
    if (!isTradingClosedDate(formatDateUtc(new Date(ms)), tradingCalendar)) tradingDaysAfterTarget++;
  }
  return tradingDaysAfterTarget <= Math.trunc(maxTradingDays);
}

