import { addCalendarYearsUtc, addDaysUtc } from "@/lib/date-utils";
import { addMonthsClampedUtc } from "@/lib/deposit-interest-payout";

export type DepositTermUnit = "day" | "week" | "month" | "year";

export const TERM_UNIT_DAYS: Record<DepositTermUnit, number> = { day: 1, week: 7, month: 30, year: 365 };

export const DEFAULT_DEPOSIT_TERM_DAYS = 365;

/**
 * Maturity date for a deposit term, calendar-aware for periodic units:
 *   - year  → Nth calendar anniversary (2026-12-21 存 1 年 → 2027-12-21);
 *   - month → Nth calendar month anniversary, month-end starts clamp
 *     (2026-01-15 存 6 个月 → 2026-07-15; 2026-01-31 存 1 个月 → 2026-02-28).
 *     Whole-year month spans (12/24/36…) are the same rule as `year`;
 *   - week/day → raw day math (no shift).
 * Never approximate months as 30-day blocks: 24 × 30 days lands 10 days early.
 *
 * **到期日 = 对年对月对日**（银行业惯例：自存入日至次年同月同日为一对年）。
 * 「算头不算尾」说的是**计息天数**（含存入日、不含到期日），不是到期日本身：
 * 2026-12-21 存 1 年 → 到期日 2027-12-21，计息 365 天。
 *
 * 2026-10-01 用户裁定更正：旧实现把 −1 天写进了到期日（2026-12-21 → 2027-12-20），
 * 再靠 `depositInterestDaysUtc` 的 +1 补偿把利息修回 365 天 —— 结果是**利息对、到期日早一天**，
 * 且与已经定版的付息锚点口径（`depositPayoutAnchorUtc`：对应日、不提前一天）自相矛盾。
 * 存量已按旧口径落库的存单由 `prisma/migrations` 的 data migration 迁回对日。
 */
export function depositTermMaturityUtc(start: Date, unit: DepositTermUnit, count: number): Date {
  const n = Math.max(0, Math.trunc(count));
  if (unit === "year") return addCalendarYearsUtc(start, n);
  if (unit === "month") return addMonthsClampedUtc(start, n);
  return addDaysUtc(start, n * TERM_UNIT_DAYS[unit]);
}

/**
 * Decompose a day count into unit + count for the unit-first term picker.
 * When the deposit's start date is known, calendar units win over naive day
 * math: a 2026-01-15 → 2031-01-15 span (1826 days across a leap year) reads
 * as 5 年, not 1826 天.
 *
 * **两种到期日口径都识别为整年**，因为存量数据里两者并存：
 *   - 对年对月对日（现行，2026-10-01 起）：anniversaryDays === d；
 *   - 旧口径「周年 − 1 天」（2026-10-01 前落库）：anniversaryDays - 1 === d。
 * 保留旧口径分支是**刻意的**：迁移是幂等的、按账簿逐步生效，未迁移的账簿仍要能正确
 * 反解出「整年」，否则一张 2 年存单会被读成 729 天而退化成按天计息。
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
    // start (month-end starts clamp), or one day before it (整年 存入日计息
    // month convention). Same month rule as depositTermMaturityUtc.
    for (let m = Math.floor(d / 28) + 1; m >= 1; m--) {
      const anniversary = addMonthsClampedUtc(start, m);
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
