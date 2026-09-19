import { addDaysUtc, addMonthsUtc } from "@/lib/date-utils";
import {
  DEPOSIT_PAYOUT_UNIT_DAYS,
  parseDepositInterestPayout,
  type DepositInterestPayoutFrequency,
} from "@/lib/deposit-interest-payout";

export type BondTermLike = {
  annualRate?: number | null;
  termDays?: number | null;
  maturityDate?: Date | string | null;
  payoutFrequency?: string | null;
  firstPayoutDate?: Date | string | null;
  /** 计息方式：monthly = 月均计息（每期固定 本金×年利率÷12×期数）；其他/缺省 = 按日。 */
  interestCalcBasis?: string | null;
};

export type BondPayoutExpectation = {
  frequency: DepositInterestPayoutFrequency;
  expectedDates: string[];
  nextPayoutDate: string | null;
  nextExpectedInterest: number | null;
};

function toUtcDay(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function bondDateKey(value: Date | string | null | undefined): string | null {
  const date = toUtcDay(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function periodDays(frequency: DepositInterestPayoutFrequency): number {
  if (frequency.kind !== "periodic") return 0;
  return DEPOSIT_PAYOUT_UNIT_DAYS[frequency.unit] * frequency.interval;
}

export function estimateBondInterestForDays(params: {
  principal: number;
  annualRate?: number | null;
  days: number;
}): number {
  const principal = Number(params.principal ?? 0);
  const rate = Number(params.annualRate ?? 0);
  if (!(principal > 0) || !(rate > 0) || !(params.days > 0)) return 0;
  return Number((principal * (rate / 100) * (params.days / 365)).toFixed(2));
}

/**
 * 单期利息 —— 计划行显示与实际落账**共用同一个公式**，避免两处漂移。
 *
 *   - 月均计息（interestCalcBasis="monthly" 且按月付息）：本金×年利率÷12×期数，不受当月天数影响；
 *   - 其余（按日）：本金×年利率×周期天数÷365。
 */
export function estimateBondPeriodInterest(params: {
  principal: number;
  annualRate?: number | null;
  frequency: DepositInterestPayoutFrequency;
  interestCalcBasis?: string | null;
}): number {
  if (params.frequency.kind !== "periodic") return 0;
  const principal = Number(params.principal ?? 0);
  const rate = Number(params.annualRate ?? 0);
  if (!(principal > 0) || !(rate > 0)) return 0;
  if (params.interestCalcBasis === "monthly" && params.frequency.unit === "month") {
    return Number(((principal * (rate / 100) * params.frequency.interval) / 12).toFixed(2));
  }
  return estimateBondInterestForDays({ principal, annualRate: rate, days: periodDays(params.frequency) });
}

export function bondPayoutExpectation(params: {
  term: BondTermLike;
  start?: Date | string | null;
  after?: Date | string | null;
  principal: number;
}): BondPayoutExpectation {
  const frequency = parseDepositInterestPayout(params.term.payoutFrequency);
  const maturity = toUtcDay(params.term.maturityDate);
  const rate = Number(params.term.annualRate ?? 0);
  const start = toUtcDay(params.term.firstPayoutDate) ?? toUtcDay(params.start) ?? null;
  const after = toUtcDay(params.after);

  if (frequency.kind === "maturity") {
    const expectedDates = maturity && (!after || maturity.getTime() > after.getTime())
      ? [maturity.toISOString().slice(0, 10)]
      : [];
    const interest = expectedDates.length
      ? estimateBondInterestForDays({
          principal: params.principal,
          annualRate: rate,
          days: params.term.termDays ?? (maturity
            ? Math.max(1, Math.round((maturity.getTime() - (start ?? maturity).getTime()) / 86400000))
            : 0),
        })
      : 0;
    return { frequency, expectedDates, nextPayoutDate: expectedDates[0] ?? null, nextExpectedInterest: interest > 0 ? interest : null };
  }

  if (!start) return { frequency, expectedDates: [], nextPayoutDate: null, nextExpectedInterest: null };

  // 步进规则只有一处实现（bondPayoutDatesUpTo），显示与实际落账共用，避免漂移。
  const slots = bondPayoutDatesUpTo({
    term: params.term,
    start: params.start,
    untilKey: maturity ? maturity.toISOString().slice(0, 10) : "9999-12-31",
    limit: 48,
  });

  const expectedDates: string[] = [];
  let nextPayoutDate: string | null = null;
  let nextExpectedInterest: number | null = null;
  for (const slot of slots) {
    if (after && slot.date.getTime() <= after.getTime()) continue;
    if (!nextPayoutDate) {
      nextPayoutDate = slot.key;
      const interest = estimateBondPeriodInterest({
        principal: params.principal,
        annualRate: rate,
        frequency,
        interestCalcBasis: params.term.interestCalcBasis,
      });
      nextExpectedInterest = interest > 0 ? interest : null;
    }
    expectedDates.push(slot.key);
    if (expectedDates.length >= 24) break;
  }

  return { frequency, expectedDates, nextPayoutDate, nextExpectedInterest };
}

/**
 * 从首次付息日按付息周期步进的**全部应付息日**（含到期日尾差），只取不晚于 `untilKey` 的期次。
 *
 * 与 bondPayoutExpectation 共用同一套步进规则：到期一次付息只返回到期日一天；
 * 周期付息从「首次付息日」起按 interval 步进，遇到期日截断，最后补到期日尾差。
 */
export function bondPayoutDatesUpTo(params: {
  term: BondTermLike;
  start?: Date | string | null;
  untilKey: string;
  limit?: number;
}): Array<{ key: string; date: Date }> {
  const frequency = parseDepositInterestPayout(params.term.payoutFrequency);
  const maturity = toUtcDay(params.term.maturityDate);
  const start = toUtcDay(params.term.firstPayoutDate) ?? toUtcDay(params.start) ?? null;
  const out: Array<{ key: string; date: Date }> = [];
  const limit = params.limit ?? 600;

  if (frequency.kind === "maturity") {
    if (maturity) {
      const key = maturity.toISOString().slice(0, 10);
      if (key <= params.untilKey) out.push({ key, date: maturity });
    }
    return out;
  }
  if (!start) return out;

  const stepDays = periodDays(frequency);
  for (let step = 0; step <= frequency.interval * 12 * 80 && out.length < limit; step += frequency.interval) {
    const date = frequency.unit === "month"
      ? addMonthsUtc(start, step)
      : new Date(start.getTime() + step * stepDays * 86400000);
    if (maturity && date.getTime() > maturity.getTime()) break;
    const key = date.toISOString().slice(0, 10);
    if (key > params.untilKey) break;
    out.push({ key, date });
  }
  // 到期日尾差：最后一个付息日之后、到期日之前的天数在到期日一次结清。
  if (maturity && out.length < limit) {
    const key = maturity.toISOString().slice(0, 10);
    if (key <= params.untilKey && !out.some((slot) => slot.key === key)) out.push({ key, date: maturity });
  }
  return out;
}

/**
 * 把「首次付息日」夹到存单自己的时间轴上。
 *
 * 老存单没有条款快照时会回退债单主数据，债单的首次付息日可能早于本存单起息日
 * （同一债单里后买的存单尤其明显：起息日比债单首期付息日晚）。付息不可能发生在
 * 起息日之前，所以按付息周期顺延到第一个晚于起息日的付息日。到期一次付息不动。
 */
export function clampBondFirstPayoutToStart(params: {
  firstPayoutDate: Date | string | null | undefined;
  startDate: Date | string | null | undefined;
  payoutFrequency: string | null | undefined;
}): Date | null {
  const first = toUtcDay(params.firstPayoutDate);
  if (!first) return null;
  const start = toUtcDay(params.startDate);
  if (!start || first.getTime() > start.getTime()) return first;
  const frequency = parseDepositInterestPayout(params.payoutFrequency);
  if (frequency.kind !== "periodic") return first;
  const stepDays = periodDays(frequency);
  let cursor = first;
  // 600 期上限只是防脏数据死循环，正常最多顺延几十期。
  for (let step = 0; step < 600 && cursor.getTime() <= start.getTime(); step += 1) {
    cursor = frequency.unit === "month"
      ? addMonthsUtc(cursor, frequency.interval)
      : addDaysUtc(cursor, stepDays);
  }
  return cursor;
}

export function bondPlanInterval(frequency: DepositInterestPayoutFrequency): { unit: "week" | "month"; value: number } {  if (frequency.kind !== "periodic") return { unit: "month", value: 1 };
  if (frequency.unit === "week") return { unit: "week", value: frequency.interval };
  if (frequency.unit === "month") return { unit: "month", value: frequency.interval };
  return { unit: "month", value: Math.max(1, 12 * frequency.interval) };
}

export function parseBondPayoutLabel(raw: string | null | undefined): string {
  const frequency = parseDepositInterestPayout(raw);
  if (frequency.kind === "maturity") return "maturity";
  if (frequency.unit === "week") return frequency.interval === 1 ? "weekly" : `weekly:${frequency.interval}`;
  if (frequency.unit === "month") return frequency.interval === 1 ? "monthly" : `monthly:${frequency.interval}`;
  return frequency.interval === 1 ? "yearly" : `yearly:${frequency.interval}`;
}
