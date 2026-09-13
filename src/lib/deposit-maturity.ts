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

import { addDaysUtc, addMonthsUtc, formatDateUtc } from "@/lib/date-utils";

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
 * Roll a deposit's maturity forward by one term, calendar-aware:
 * when the original span (start → current maturity) is exactly N calendar
 * months, the next maturity keeps the anniversary (2031-01-15 + 60 months →
 * 2036-01-15, leap years included). Non-calendar spans roll by raw days.
 */
export function nextDepositTermMaturityUtc(startDate: Date, currentMaturity: Date): Date {
  const months =
    (currentMaturity.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
    (currentMaturity.getUTCMonth() - startDate.getUTCMonth());
  if (months > 0 && formatDateUtc(addMonthsUtc(startDate, months)) === formatDateUtc(currentMaturity)) {
    return addMonthsUtc(currentMaturity, months);
  }
  const termDays = Math.max(1, dayDiffDays(currentMaturity, startDate));
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
  const segmentDays = Math.max(0, dayDiffDays(maturityDate, segmentStart));
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
