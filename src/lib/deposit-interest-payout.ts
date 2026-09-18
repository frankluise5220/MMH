/**
 * Deposit interest payout frequency encoding.
 *
 * Stored on TxRecord.depositInterestPayoutFrequency / DepositTransaction.interestPayoutFrequency
 * as a free-form string:
 *   - "maturity"                 → pay once at maturity
 *   - "weekly" | "monthly" | "yearly" → every 1 unit (legacy + default)
 *   - "weekly:2" | "monthly:3" | "yearly:2" → every N units
 *
 * Interval N is always a positive integer. When N is omitted it means 1.
 * Callers that only need "is periodic?" can keep treating anything other than
 * "maturity"/null as periodic — the prefix before ":" is enough.
 */

export type DepositInterestPayoutUnit = "week" | "month" | "year";
export type DepositInterestPayoutFrequency =
  | { kind: "maturity" }
  | { kind: "periodic"; unit: DepositInterestPayoutUnit; interval: number };

/** Approximate day lengths used only for UI max-interval clamping (same as deposit term picker). */
export const DEPOSIT_PAYOUT_UNIT_DAYS: Record<DepositInterestPayoutUnit, number> = {
  week: 7,
  month: 30,
  year: 365,
};

const UNIT_ALIASES: Record<string, DepositInterestPayoutUnit> = {
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  year: "year",
  yearly: "year",
};

export function parseDepositInterestPayout(
  raw: string | null | undefined,
): DepositInterestPayoutFrequency {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text || text === "maturity") return { kind: "maturity" };

  const [unitPart, intervalPart] = text.split(":");
  const unit = UNIT_ALIASES[unitPart];
  if (!unit) return { kind: "maturity" };

  const parsedInterval = intervalPart != null && intervalPart !== ""
    ? Number.parseInt(intervalPart, 10)
    : 1;
  const interval = Number.isFinite(parsedInterval) && parsedInterval >= 1
    ? Math.trunc(parsedInterval)
    : 1;
  return { kind: "periodic", unit, interval };
}

export function encodeDepositInterestPayout(
  frequency: DepositInterestPayoutFrequency,
): string {
  if (frequency.kind === "maturity") return "maturity";
  const interval = Math.max(1, Math.trunc(frequency.interval || 1));
  // Keep the legacy bare token when interval is 1 so existing rows stay readable.
  if (interval === 1) {
    return frequency.unit === "week" ? "weekly" : frequency.unit === "month" ? "monthly" : "yearly";
  }
  return `${frequency.unit === "week" ? "weekly" : frequency.unit === "month" ? "monthly" : "yearly"}:${interval}`;
}

/** True when the deposit pays interest during the term (not only at maturity). */
export function isPeriodicDepositInterestPayout(raw: string | null | undefined): boolean {
  return parseDepositInterestPayout(raw).kind === "periodic";
}

/**
 * Max allowed interval so one payout cycle does not exceed the deposit term.
 * Returns at least 1 when the term can fit a single unit; otherwise 0 (unit too large).
 */
export function maxDepositInterestPayoutInterval(
  termDays: number,
  unit: DepositInterestPayoutUnit,
): number {
  const days = Math.max(0, Math.trunc(termDays));
  if (days <= 0) return 1;
  const unitDays = DEPOSIT_PAYOUT_UNIT_DAYS[unit];
  return Math.max(0, Math.floor(days / unitDays));
}

export function clampDepositInterestPayoutInterval(
  termDays: number,
  unit: DepositInterestPayoutUnit,
  interval: number,
): number {
  const max = maxDepositInterestPayoutInterval(termDays, unit);
  if (max <= 0) return 1;
  const value = Math.max(1, Math.trunc(interval || 1));
  return Math.min(value, max);
}

/** Accepts either a bare unit token or unit:N; rejects unknown values as null. */
export function normalizeDepositInterestPayoutInput(
  raw: string | null | undefined,
): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parsed = parseDepositInterestPayout(text);
  if (parsed.kind === "maturity") {
    // Only accept explicit maturity; bare garbage falls through as null.
    return text.toLowerCase() === "maturity" ? "maturity" : null;
  }
  return encodeDepositInterestPayout(parsed);
}

/**
 * Month arithmetic clamped to the target month's last day: Jan 31 + 1 month →
 * Feb 28 (not Mar 3, which plain setUTCMonth rolls into).
 */
function addMonthsClampedUtc(date: Date, months: number): Date {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

/**
 * 存入日计息的付息锚点：起存日 + N 周期 − 1 天。18 号存、按月取息 → 每月
 * 17 号生息（满一个月的利息在次月同日前一天完整，与存期到期「起存日 +
 * N 年 − 1 天」同口径）。月末起存（如 1-31）的周年日钳制到目标月末再减一天
 * （1-31 → 2-27）。排程（计划任务 nextRunDate）与执行器（生成记录日期）必须
 * 共用本函数，两处日期永远一致。
 */
export function depositPayoutAnchorUtc(
  startDate: Date,
  frequency: { unit: "week" | "month" | "year"; interval: number },
  periods: number,
): Date {
  const base = frequency.unit === "month"
    ? addMonthsClampedUtc(startDate, periods * frequency.interval)
    : new Date(startDate.getTime() + (frequency.unit === "week" ? 7 : 365) * frequency.interval * periods * 86400000);
  return new Date(base.getTime() - 86400000);
}
