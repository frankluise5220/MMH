export function startOfDayUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDaysUtc(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function addMonthsUtc(date: Date, months: number) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

export function toStatementMonth(date: Date, billingDay: number) {
  const day = date.getUTCDate();
  const monthBase = day < billingDay ? date : addMonthsUtc(date, 1);
  const y = monthBase.getUTCFullYear();
  const m = String(monthBase.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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

  const thisStart = new Date(Date.UTC(y, m, clampDay(y, m, billingDay)));
  const start =
    today.getTime() >= thisStart.getTime()
      ? thisStart
      : new Date(Date.UTC(y, m - 1, clampDay(y, m - 1, billingDay)));
  const nextStart = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, clampDay(start.getUTCFullYear(), start.getUTCMonth() + 1, billingDay)),
  );
  const end = addDaysUtc(nextStart, -1);
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

export function formatDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

function isWeekendUtc(ms: number) {
  const dow = new Date(ms).getUTCDay();
  return dow === 0 || dow === 6;
}

function isCnFundHoliday(dateStr: string) {
  return CN_FUND_HOLIDAYS.has(dateStr);
}

export function isTradingClosedDate(dateStr: string, tradingCalendar?: string | null) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const ms = Date.UTC(y, (m || 1) - 1, d || 1);
  if (isWeekendUtc(ms)) return true;
  if (tradingCalendar === "cn_fund") return isCnFundHoliday(dateStr);
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

export function addWorkdaysUtc(dateStr: string, n: number) {
  return addTradingDaysUtc(dateStr, n, "generic_weekday");
}
