import { addCalendarYearsUtc, addDaysUtc, addMonthsUtc } from "@/lib/date-utils";

export type DepositTermUnit = "day" | "week" | "month" | "year";

export const TERM_UNIT_DAYS: Record<DepositTermUnit, number> = { day: 1, week: 7, month: 30, year: 365 };

export const DEFAULT_DEPOSIT_TERM_DAYS = 365;

/**
 * Maturity date for a deposit term, calendar-aware for periodic units:
 *   - year  → Nth calendar anniversary − 1 day (存入日计息: 2025-01-20 存 1 年 → 2026-01-19);
 *   - month → N calendar months later minus 1 day (2024-09-17 存 24 个月 → 2026-09-16);
 *   - week/day → raw day math (no −1 shift).
 * Never approximate months as 30-day blocks: 24 × 30 days lands 10 days early.
 */
export function depositTermMaturityUtc(start: Date, unit: DepositTermUnit, count: number): Date {
  const n = Math.max(0, Math.trunc(count));
  if (unit === "year") return addDaysUtc(addCalendarYearsUtc(start, n), -1);
  if (unit === "month") return addDaysUtc(addMonthsUtc(start, n), -1);
  return addDaysUtc(start, n * TERM_UNIT_DAYS[unit]);
}

/**
 * Decompose a day count into unit + count for the unit-first term picker.
 * When the deposit's start date is known, calendar units win over naive day
 * math: a 2026-01-15 → 2031-01-15 span (1826 days across a leap year) reads
 * as 5 年, not 1826 天, and the 存入日计息 convention (maturity = 起存日 +
 * N 年 − 1 天, e.g. 2025-01-20 → 2026-01-19) also reads as whole years.
 * Whole years win over months, months over weeks, so 90 -> 3 months,
 * 14 -> 2 weeks, and anything else stays in days.
 */
export function splitTermDays(days: number, startDate?: string | null): { unit: DepositTermUnit; count: number } {
  const d = Math.max(0, Math.trunc(days));
  if (d <= 0) return { unit: "day", count: 0 };
  const start = startDate ? new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`) : null;
  if (start && Number.isFinite(start.getTime())) {
    // Calendar years: the maturity lands exactly on the Nth anniversary, or
    // one day before it (存入日计息 convention).
    for (let y = Math.floor(d / 365) + 1; y >= 1; y--) {
      const anniversary = addCalendarYearsUtc(start, y);
      const anniversaryDays = Math.round((anniversary.getTime() - start.getTime()) / 86400000);
      if (anniversaryDays === d || anniversaryDays - 1 === d) {
        return { unit: "year", count: y };
      }
    }
    // Calendar months: the maturity lands exactly N calendar months after the
    // start, or one day before it (存入日计息 month convention).
    for (let m = Math.floor(d / 28) + 1; m >= 1; m--) {
      const anniversary = addMonthsUtc(start, m);
      const anniversaryDays = Math.round((anniversary.getTime() - start.getTime()) / 86400000);
      if (anniversaryDays === d || anniversaryDays - 1 === d) {
        return { unit: "month", count: m };
      }
    }
  }
  if (d % 365 === 0) return { unit: "year", count: d / 365 };
  if (d % 30 === 0) return { unit: "month", count: d / 30 };
  if (d % 7 === 0) return { unit: "week", count: d / 7 };
  return { unit: "day", count: d };
}
