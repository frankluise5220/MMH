/**
 * Deposit interest payout frequency encoding.
 *
 * Stored on TxRecord.depositInterestPayoutFrequency / DepositTransaction.interestPayoutFrequency
 * as a free-form string:
 *   - "maturity"                 → pay once at maturity
 *   - "daily" | "weekly" | "monthly" | "yearly" → every 1 unit (legacy + default)
 *   - "daily:7" | "monthly:3" | "yearly:2" → every N units
 *
 * Interval N is always a positive integer. When N is omitted it means 1.
 * Callers that only need "is periodic?" can keep treating anything other than
 * "maturity"/null as periodic — the prefix before ":" is enough.
 *
 * 2026-10-03: the deposit payout picker offers 天/月/年; "周" is no longer a
 * selectable unit (1 周 = 7 天, so nothing is lost). The "week"/"weekly" token is
 * kept as a legacy alias because bond (债券) products still store it and older
 * deposit rows were saved as "weekly". `foldDepositPayoutWeekToDay` lets the
 * deposit UI treat those legacy rows as the equivalent day interval.
 */

export type DepositInterestPayoutUnit = "day" | "week" | "month" | "year";
export type DepositInterestPayoutFrequency =
  | { kind: "maturity" }
  | { kind: "periodic"; unit: DepositInterestPayoutUnit; interval: number };

/** Approximate day lengths used only for UI max-interval clamping (same as deposit term picker). */
export const DEPOSIT_PAYOUT_UNIT_DAYS: Record<DepositInterestPayoutUnit, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const UNIT_ALIASES: Record<string, DepositInterestPayoutUnit> = {
  day: "day",
  daily: "day",
  week: "week",
  weekly: "week",
  month: "month",
  monthly: "month",
  year: "year",
  yearly: "year",
};

/** Canonical stored token for each unit (the prefix before an optional ":N"). */
const UNIT_TOKENS: Record<DepositInterestPayoutUnit, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
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
  const token = UNIT_TOKENS[frequency.unit];
  // Keep the legacy bare token when interval is 1 so existing rows stay readable.
  return interval === 1 ? token : `${token}:${interval}`;
}

/**
 * Fold the legacy "week" unit into the equivalent "day" interval (1 周 = 7 天).
 *
 * The deposit payout picker no longer offers 周, so a row stored as
 * "weekly:2" (每 2 周) must load into the form as 每 14 天 instead of pointing at
 * a unit the <select> no longer renders. Bonds keep using "week" as a real unit
 * and must NOT be folded.
 */
export function foldDepositPayoutWeekToDay(
  frequency: DepositInterestPayoutFrequency,
): DepositInterestPayoutFrequency {
  if (frequency.kind !== "periodic" || frequency.unit !== "week") return frequency;
  return {
    kind: "periodic",
    unit: "day",
    interval: Math.max(1, Math.trunc(frequency.interval || 1)) * DEPOSIT_PAYOUT_UNIT_DAYS.week,
  };
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
 * 月/年周期走日历加法（月末钳制到目标月末，1-31 存 → 2-28），天/周周期按 1×N / 7×N 天。
 * 排程（计划任务 nextRunDate）与执行器（生成记录日期）必须共用本函数。
 */
export function depositPayoutAnchorUtc(
  startDate: Date,
  frequency: { unit: DepositInterestPayoutUnit; interval: number },
  periods: number,
): Date {
  const interval = Math.max(1, Math.trunc(frequency.interval || 1));
  const dayOffset = startDate.getTime()
    - Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const base = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const shifted = frequency.unit === "month" || frequency.unit === "year"
    ? addMonthsClampedUtc(base, periods * interval * (frequency.unit === "year" ? 12 : 1))
    : new Date(base.getTime() + DEPOSIT_PAYOUT_UNIT_DAYS[frequency.unit] * interval * periods * 86400000);
  return new Date(shifted.getTime() + dayOffset);
}

/** Prisma `IntervalUnit` 字符串 → 存款取息单位；未知值返回 null（调用方回退存单条款）。 */
const INTERVAL_UNIT_TO_PAYOUT_UNIT: Record<string, DepositInterestPayoutUnit> = {
  day: "day",
  week: "week",
  month: "month",
  year: "year",
};

export function depositPayoutUnitFromIntervalUnit(
  raw: string | null | undefined,
): DepositInterestPayoutUnit | null {
  return INTERVAL_UNIT_TO_PAYOUT_UNIT[String(raw ?? "")] ?? null;
}

/**
 * 手动覆盖（`manualOverride`）后的付息**相位基准**。
 *
 * 计划行的 `nextRunDate` 每期按 interval 前进，所以它本身就是一个稳定的「相位代表」：
 * 相位集合 = { nextRunDate + k×interval | k ≥ 0 }。用户改「下一执行日」= 改相位起点，
 * 之后的每一期都从新相位顺延 —— 不需要额外存相位原点，也不受存单起存日牵引。
 *
 * 未手动覆盖时返回存单起存日，与旧口径（起存日 + N 周期）完全一致。
 */
export function depositPayoutPhaseBase(
  manualNextRunDate: Date | null | undefined,
  fallbackStartDate: Date,
): Date {
  return manualNextRunDate ?? fallbackStartDate;
}

/**
 * 相位基准下、严格晚于 `after` 的第一个付息日（基准自身算第 0 期）。
 *
 * 与 `depositPayoutAnchorUtc` 一样支持负/零期数。手动覆盖时相位基准就是计划行的
 * `nextRunDate`，若 `after` 还落在基准之前，必须原样返回基准（否则会把用户刚设的
 * 日期直接跳过去）。
 */
export function nextDepositPayoutDateFromPhase(
  phaseBase: Date,
  frequency: { unit: DepositInterestPayoutUnit; interval: number },
  after: Date,
): Date {
  const maxPeriods = depositPayoutMaxPeriods(frequency);
  for (let periods = 0; periods <= maxPeriods; periods++) {
    const date = depositPayoutAnchorUtc(phaseBase, frequency, periods);
    if (date.getTime() > after.getTime()) return date;
  }
  // 兜底（超过 ~80 年仍未匹配）：从基准再推进一期。
  return depositPayoutAnchorUtc(phaseBase, frequency, maxPeriods + 1);
}

/**
 * 付息锚点最多枚举多少期（约 80 年）—— 排程与执行器的循环上界共用，
 * 避免按天/按周取息被「80 期」这类按月的常量提前截断。
 */
export function depositPayoutMaxPeriods(
  frequency: { unit: DepositInterestPayoutUnit; interval: number },
): number {
  const perYear = frequency.unit === "day" ? 365 : frequency.unit === "week" ? 52 : frequency.unit === "month" ? 12 : 1;
  const interval = Math.max(1, Math.trunc(frequency.interval || 1));
  return Math.max(1, Math.floor((80 * perYear) / interval) + 1);
}
