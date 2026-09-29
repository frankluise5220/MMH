/**
 * Pure helpers for deposit maturity auto-processing (no DB access).
 *
 * A matured deposit lot is processed according to its stored maturity action:
 *   - "redeem"                  → one redemption: principal (+ interest unless
 *                                 interest was paid out periodically) back to
 *                                 the original funding cash account
 *   - "renew_principal"         → roll the term forward one original term per
 *                                 round; each round pays out that term's
 *                                 accrued interest to the funding account
 *   - "renew_principal_interest"→ roll forward one original term per round;
 *                                 interest compounds into the principal
 */

import { addCalendarYearsUtc, addDaysUtc, formatDateUtc } from "@/lib/date-utils";

import { addMonthsClampedUtc, type DepositInterestPayoutUnit } from "@/lib/deposit-interest-payout";
import { splitTermDays } from "@/lib/deposit-term";

const DAY_MS = 86_400_000;

export function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Day difference matching payDepositInterest's convention: raw timestamp
 * difference rounded to whole days. Lots may store dates as either UTC
 * midnight or local-midnight-as-UTC (legacy rows), so rounding (not
 * day-flooring) keeps mixed-convention diffs correct.
 */
export function dayDiffDays(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

/**
 * Interest day count for one deposit segment under the 存入日计息 convention:
 * the deposit day itself counts, and the count follows real calendar days
 * (a year spanning Feb 29 accrues 366 days, otherwise 365).
 *
 * Spans whose maturity sits one day before the Nth calendar anniversary encode
 * that convention (maturity = 起存日 + N 年 − 1 天, e.g. 2025-01-20 → 2026-01-19
 * = 365 days; 2019-03-20 → 2020-03-19 = 366 days), so they count inclusively
 * (raw difference + 1). Legacy same-day-anniversary spans already contain the
 * full span in the raw difference and stay unchanged, as do day/month/week
 * based terms.
 */
export function depositInterestDaysUtc(start: Date, maturity: Date): number {
  const days = Math.max(0, dayDiffDays(maturity, start));
  if (days < 364) return days;
  const maxYears = Math.floor(days / 365) + 1;
  for (let years = maxYears; years >= 1; years--) {
    const anniversaryDays = dayDiffDays(addCalendarYearsUtc(start, years), start);
    if (anniversaryDays === days) return days;
    if (anniversaryDays - 1 === days) return days + 1;
  }
  return days;
}

/**
 * Legacy month-term maturity normalisation. The old rule stored month terms as
 * 起存日 + N 月 − 1 天 (2026-01-15 + 6 个月 → 2026-07-14), which made the segment
 * fall back to a day count (180/365 → 12.82) instead of the month rule
 * (6/12 → 13.00) and pushed every renewal one day earlier. This maps such an
 * `end` back onto its anniversary. Whole-year spans (N % 12 === 0) keep their
 * −1 天 convention (存入日计息) and are returned untouched, as is anything that
 * is not exactly one day before an anniversary.
 */
export function normalizeDepositMonthTermEndUtc(start: Date, end: Date): Date {
  const spanMonths =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (spanMonths <= 0 || spanMonths % 12 === 0) return end;
  const anniversary = addMonthsClampedUtc(start, spanMonths);
  return formatDateUtc(addDaysUtc(anniversary, -1)) === formatDateUtc(end) ? anniversary : end;
}

/**
 * Whole-month span detector: returns N when `end` lands exactly N calendar
 * months after `start` (month-end starts clamp, so 2026-01-31 → 2026-02-28
 * reads as 1 month), otherwise null.
 */
export function depositWholeMonthsUtc(start: Date, end: Date): number | null {
  if (!(end.getTime() > start.getTime())) return null;
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (months <= 0) return null;
  return formatDateUtc(addMonthsClampedUtc(start, months)) === formatDateUtc(end) ? months : null;
}

/**
 * Interest for one deposit segment. Whole-month spans are prorated by calendar
 * months (N/12) — a 6-month term at 1.3% on 2000 pays
 * 2000 × 1.3% × 6/12 = 13.00 — everything else keeps the day-count convention
 * (principal × rate × days / 365).
 */
export function depositSegmentInterest(params: {
  principal: number;
  annualRatePercent: number | null | undefined;
  startDate: Date | null | undefined;
  endDate: Date | null | undefined;
}): number {
  const { principal, annualRatePercent, startDate, endDate } = params;
  if (!(principal > 0) || !(annualRatePercent && annualRatePercent > 0) || !startDate || !endDate) return 0;
  if (endDate.getTime() <= startDate.getTime()) return 0;
  // 遗留的「起存日 + N 月 − 1 天」到期日先归一到周年，再按 月数/12 计息。
  const normalizedEnd = normalizeDepositMonthTermEndUtc(startDate, endDate);
  const months = depositWholeMonthsUtc(startDate, endDate) ?? depositWholeMonthsUtc(startDate, normalizedEnd);
  if (months != null) return round2((principal * (annualRatePercent / 100) * months) / 12);
  const days = depositInterestDaysUtc(startDate, endDate);
  return days > 0 ? round2((principal * (annualRatePercent / 100) * days) / 365) : 0;
}

export function calculateDepositAccruedInterest(params: {
  principal: number;
  annualRatePercent: number | null | undefined;
  startDate: Date | null | undefined;
  endDate: Date | null | undefined;
}): number {
  return depositSegmentInterest(params);
}

/**
 * Roll a deposit's maturity forward by one term, calendar-aware. Three span
 * shapes are recognized between start → current maturity:
 *   - exact N calendar months (anniversary-aligned span, the month-term rule):
 *     roll keeps the anniversary (2031-01-15 + 60 months → 2036-01-15, leap
 *     years included);
 *   - N whole years minus one day (存入日计息 convention, maturity =
 *     起存日 + N 年 − 1 天): the renewed term starts on the previous maturity
 *     day, so its maturity is the next anniversary − 1 day, i.e. exactly
 *     `currentMaturity + N months` (no second −1, which would drift a day
 *     earlier per renewal);
 *   - anything else rolls by raw days — using `originalTermDays` (the lot's
 *     original term length) when provided so multi-round catch-ups advance one
 *     term per round instead of the accumulated span.
 *
 * The roll length always comes from the lot's ORIGINAL term, never from the
 * accumulated start → maturity span, so the second and later renewals advance
 * one term instead of the whole chain (a 6-month lot stays 6 months).
 */
export function nextDepositTermMaturityUtc(
  startDate: Date,
  currentMaturity: Date,
  originalTermDays?: number,
): Date {
  const spanMonths =
    (currentMaturity.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (currentMaturity.getUTCMonth() - startDate.getUTCMonth());
  if (spanMonths > 0) {
    const anniversary = addMonthsClampedUtc(startDate, spanMonths);
    const maturityStr = formatDateUtc(currentMaturity);
    const anniversaryAligned =
      formatDateUtc(anniversary) === maturityStr ||
      formatDateUtc(addDaysUtc(anniversary, -1)) === maturityStr;
    if (anniversaryAligned) {
      const termMonths = originalTermMonthsUtc(startDate, originalTermDays) ?? spanMonths;
      // 月周期锚在原始起存日的周年上：遗留的「−1 天」月到期日（旧规则 起存日 +
      // N 月 − 1 天）若不回到周年，后续每期都会比周年早一天。整年（12 的倍数）
      // 保持 存入日计息 的 −1 天语义，继续从当前到期日滚动。
      return addMonthsClampedUtc(normalizeDepositMonthTermEndUtc(startDate, currentMaturity), termMonths);
    }
  }
  const termDays =
    originalTermDays != null
      ? Math.max(1, Math.trunc(originalTermDays))
      : Math.max(1, dayDiffDays(currentMaturity, startDate));
  return addDaysUtc(currentMaturity, termDays);
}

/**
 * The date a renewed certificate starts on: the old certificate's maturity
 * date, pulled back onto its anniversary when it is a legacy month term that
 * sits one day early (2026-07-14 → 2026-07-15). Renewals therefore keep the
 * anniversary and the successor's own segment stays a whole number of months.
 */
export function depositRenewalStartUtc(startDate: Date, currentMaturity: Date): Date {
  return normalizeDepositMonthTermEndUtc(startDate, currentMaturity);
}

/**
 * The lot's original term expressed in whole calendar months, derived from its
 * day length (mirrors the unit-first term picker's decomposition so 181 → 6
 * months and 364/1825 → 12/60 months). Returns null when the span is not a
 * whole number of calendar months (day/week terms).
 */
function originalTermMonthsUtc(startDate: Date, originalTermDays?: number): number | null {
  if (originalTermDays == null) return null;
  const days = Math.trunc(originalTermDays);
  if (!(days > 0)) return null;
  const split = splitTermDays(days, formatDateUtc(startDate));
  if (split.unit === "month") return split.count;
  if (split.unit === "year") return split.count * 12;
  return null;
}

/**
 * Interest accrued from segmentStart to maturityDate for one deposit segment.
 * Periodic-payout deposits return 0 (interest was already paid during the
 * term; at maturity only the principal returns — matches the UI hint).
 * Whole-month segments are prorated by months (N/12), others by days/365.
 */
export function computeDepositMaturityInterest(params: {
  principal: number;
  annualRatePercent: number | null;
  segmentStart: Date | null;
  maturityDate: Date;
  periodicPayout: boolean;
}): number {
  const { principal, annualRatePercent, maturityDate, periodicPayout } = params;
  if (periodicPayout) return 0;
  const segmentStart = params.segmentStart ?? null;
  if (!segmentStart) return 0;
  return depositSegmentInterest({
    principal,
    annualRatePercent,
    startDate: segmentStart,
    endDate: maturityDate,
  });
}

/** How many times a lot must roll one original term forward to pass `now`. */
export function depositRenewRoundsNeeded(params: {
  maturityDate: Date;
  originalTermDays: number;
  now: Date;
}): number {
  const overdueDays = dayDiffDays(params.now, params.maturityDate);
  if (overdueDays < 0) return 0;
  const term = Math.max(1, Math.trunc(params.originalTermDays));
  return Math.floor(overdueDays / term) + 1;
}

/** Unit-day approximation used only for maturity pacing (week=7, month=30, year=365). */
export function payoutUnitDaysForMaturityPace(unit: DepositInterestPayoutUnit): number {
  return unit === "week" ? 7 : unit === "month" ? 30 : 365;
}
