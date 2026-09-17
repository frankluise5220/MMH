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

import { addCalendarYearsUtc, addDaysUtc, addMonthsUtc, formatDateUtc } from "@/lib/date-utils";

import { type DepositInterestPayoutUnit } from "@/lib/deposit-interest-payout";

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
 * Roll a deposit's maturity forward by one term, calendar-aware. Three span
 * shapes are recognized between start → current maturity:
 *   - exact N calendar months (legacy same-day anniversary): roll keeps the
 *     anniversary (2031-01-15 + 60 months → 2036-01-15, leap years included);
 *   - N whole years minus one day (存入日计息 convention, maturity =
 *     起存日 + N 年 − 1 天): re-apply the same rule to the renewed term, whose
 *     start is the previous maturity day;
 *   - anything else rolls by raw days — using `originalTermDays` (the lot's
 *     original term length) when provided so multi-round catch-ups advance one
 *     term per round instead of the accumulated span.
 */
export function nextDepositTermMaturityUtc(
  startDate: Date,
  currentMaturity: Date,
  originalTermDays?: number,
): Date {
  const months =
    (currentMaturity.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (currentMaturity.getUTCMonth() - startDate.getUTCMonth());
  if (months > 0) {
    const anniversary = addMonthsUtc(startDate, months);
    const anniversaryStr = formatDateUtc(anniversary);
    const maturityStr = formatDateUtc(currentMaturity);
    if (anniversaryStr === maturityStr) {
      if (originalTermDays != null && Math.trunc(originalTermDays) % 365 === 0 && originalTermDays > 0) {
        return addMonthsUtc(currentMaturity, 12 * (Math.trunc(originalTermDays) / 365));
      }
      return addMonthsUtc(currentMaturity, months);
    }
    if (
      formatDateUtc(addDaysUtc(anniversary, -1)) === maturityStr
    ) {
      // 存入日计息 convention: maturity = calendar anniversary − 1 day. Re-apply
      // the same rule to the renewed term, whose start is the previous maturity
      // day (works for whole-year and month calendar spans alike).
      return addDaysUtc(addMonthsUtc(currentMaturity, months), -1);
    }
  }
  const termDays =
    originalTermDays != null
      ? Math.max(1, Math.trunc(originalTermDays))
      : Math.max(1, dayDiffDays(currentMaturity, startDate));
  return addDaysUtc(currentMaturity, termDays);
}

/**
 * Interest accrued from segmentStart to maturityDate for one deposit segment.
 * Periodic-payout deposits return 0 (interest was already paid during the
 * term; at maturity only the principal returns — matches the UI hint).
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
  if (!(principal > 0)) return 0;
  if (annualRatePercent == null || !(annualRatePercent > 0)) return 0;
  const segmentStart = params.segmentStart ?? null;
  if (!segmentStart) return 0;
  const segmentDays = depositInterestDaysUtc(segmentStart, maturityDate);
  if (segmentDays <= 0) return 0;
  return round2((principal * (annualRatePercent / 100) * segmentDays) / 365);
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
