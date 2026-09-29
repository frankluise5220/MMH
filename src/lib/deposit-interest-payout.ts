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
 * Feb 28 (not Mar 3, which plain setUTCMonth rolls into). Shared with the
 * deposit term picker so 到期日 and 计息天数 use one month rule.
 */
export function addMonthsClampedUtc(date: Date, months: number): Date {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

/**
 * 按期付息的付息锚点：起存日 + N 周期（**对应日**，不再提前一天）。
 *
 * 2026-09-29 用户定版：1 月 1 日起存、7 天取息 → 1 月 8 日、1 月 15 日……；
 * 18 号存、按月取息 → 次月 18 号；2026-03-01 存、每年取息 → 2027-03-01。
 *
 * 为什么不能提前一天：锚点提前一天会让**第一期少一天**（1-01 起存 7 天取息，
 * 首期只有 1-01→1-07 共 6 天），于是首期利息与后续各期不等；按年周期用 365 天
 * 近似还会逐期漂移（2027-02-28 → 2029-02-27）。改成对应日后每期都是完整周期。
 *
 * 日历日按 **UTC 日**取（与 `formatDateUtc` 的展示口径一致），并保留起存日自身
 * 的「日内偏移」：数据库里存量日期既有 UTC 零点也有本地零点（旧客户端写入）两种
 * 口径，保留偏移可让新锚点与存单自身日期同口径，避免同一期被判定成两天。
 * 月/年周期走日历加法（月末钳制到目标月末，1-31 存 → 2-28），周周期按 7×N 天。
 * 排程（计划任务 nextRunDate）与执行器（生成记录日期）必须共用本函数。
 */
export function depositPayoutAnchorUtc(
  startDate: Date,
  frequency: { unit: "week" | "month" | "year"; interval: number },
  periods: number,
): Date {
  const interval = Math.max(1, Math.trunc(frequency.interval || 1));
  const dayOffset = startDate.getTime()
    - Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const base = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const shifted = frequency.unit === "week"
    ? new Date(base.getTime() + 7 * interval * periods * 86400000)
    : addMonthsClampedUtc(base, periods * interval * (frequency.unit === "year" ? 12 : 1));
  return new Date(shifted.getTime() + dayOffset);
}

/**
 * 付息锚点最多枚举多少期（约 80 年）—— 排程与执行器的循环上界共用，
 * 避免按周取息被「80 期」这类按月的常量提前截断。
 */
export function depositPayoutMaxPeriods(
  frequency: { unit: "week" | "month" | "year"; interval: number },
): number {
  const perYear = frequency.unit === "week" ? 52 : frequency.unit === "month" ? 12 : 1;
  const interval = Math.max(1, Math.trunc(frequency.interval || 1));
  return Math.max(1, Math.floor((80 * perYear) / interval) + 1);
}
