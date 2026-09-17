import { addMonthsUtc } from "@/lib/date-utils";
import {
  DEPOSIT_PAYOUT_UNIT_DAYS,
  parseDepositInterestPayout,
  type DepositInterestPayoutFrequency,
} from "@/lib/deposit-interest-payout";

/**
 * 城投债（理财 bond 类型）条款工具。
 *
 * 付息方式编码与存款完全一致（复用 deposit-interest-payout）：
 *   "maturity" | "weekly[:N]" | "monthly[:N]" | "yearly[:N]"
 *
 * 语义对齐 Sharesight 的 Fixed Interest 模型：
 *   - 首次付息日（firstPayoutDate）是付息锚点，后续每过一个周期一档；
 *   - 到期日（maturityDate）封顶：不生成晚于到期日的付息期；
 *   - 全部到账以手工确认（WealthTransaction.dividend_cash）为准，
 *     这里只产出"预期"日期与估算金额，供展示与提醒。
 */

export type BondTermLike = {
  annualRate?: number | null;
  termDays?: number | null;
  maturityDate?: Date | string | null;
  payoutFrequency?: string | null;
  firstPayoutDate?: Date | string | null;
};

export type BondPayoutExpectation = {
  frequency: DepositInterestPayoutFrequency;
  /** 预期付息日序列（含到期日；maturity 频率只有到期日一项） */
  expectedDates: string[];
  /** 下一预期付息日（严格晚于 after；无 = null） */
  nextPayoutDate: string | null;
  /** 下一期估算利息（金额；无法估算 = null） */
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

/** 一个付息周期的估算利息：本金 × 年利率 × 周期天数 / 365（与存款计息口径一致）。 */
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
 * 从首次付息日出发，生成截至到期日的全部预期付息日（YYYY-MM-DD，升序）。
 * firstPayoutDate 缺省时回退：到期日倒退一个周期 / 或起息日 + 一个周期。
 */
export function bondPayoutExpectation(params: {
  term: BondTermLike;
  /** 起息日（首笔买入日）；firstPayoutDate 缺省时的锚点回退 */
  start?: Date | string | null;
  /** 计算严格晚于该日（含 "YYYY-MM-DD"）之后的付息期；缺省 = 全部期次 */
  after?: Date | string | null;
  /** 当前持仓本金（估算利息用） */
  principal: number;
}): BondPayoutExpectation {
  const frequency = parseDepositInterestPayout(params.term.payoutFrequency);
  const maturity = toUtcDay(params.term.maturityDate);
  const rate = Number(params.term.annualRate ?? 0);
  const start = toUtcDay(params.term.firstPayoutDate) ?? toUtcDay(params.start) ?? null;
  const after = toUtcDay(params.after);

  if (frequency.kind === "maturity" || !start) {
    // 到期一次付息：预期日 = 到期日（无到期日则无法给出预期）
    const expectedDates = maturity && (!after || maturity.getTime() > after.getTime())
      ? [maturity.toISOString().slice(0, 10)]
      : [];
    const interest = expectedDates.length
      ? estimateBondInterestForDays({
          principal: params.principal,
          annualRate: rate,
          days: params.term.termDays ?? (maturity ? Math.round((maturity.getTime() - (start ?? maturity).getTime()) / 86400000) : 0),
        })
      : 0;
    return { frequency, expectedDates, nextPayoutDate: expectedDates[0] ?? null, nextExpectedInterest: interest > 0 ? interest : null };
  }

  const stepDays = periodDays(frequency);
  const nextDateForStep = (step: number): Date =>
    frequency.unit === "month" ? addMonthsUtc(start, step) : new Date(start.getTime() + step * stepDays * 86400000);

  const expectedDates: string[] = [];
  let nextPayoutDate: string | null = null;
  let nextExpectedInterest: number | null = null;
  // step=0 即首次付息日本身（Sharesight 语义：First Payment Date 是第一期），
  // 之后每过一个周期一档；到期日封顶。
  for (let step = 0; step <= frequency.interval * 12 * 30; step += frequency.interval) {
    const date = step === 0 ? start : nextDateForStep(step);
    if (maturity && date.getTime() > maturity.getTime()) break;
    const key = date.toISOString().slice(0, 10);
    if (after && date.getTime() <= after.getTime()) continue;
    if (!nextPayoutDate) {
      nextPayoutDate = key;
      const interest = estimateBondInterestForDays({ principal: params.principal, annualRate: rate, days: stepDays });
      nextExpectedInterest = interest > 0 ? interest : null;
    }
    expectedDates.push(key);
    if (expectedDates.length >= 24) break;
  }

  return { frequency, expectedDates, nextPayoutDate, nextExpectedInterest };
}

/** 付息周期对应的 RegularInvestPlan interval 字段（仅供计划行展示）。 */
export function bondPlanInterval(frequency: DepositInterestPayoutFrequency): { unit: "week" | "month"; value: number } {
  if (frequency.kind !== "periodic") return { unit: "month", value: 1 };
  if (frequency.unit === "week") return { unit: "week", value: frequency.interval };
  if (frequency.unit === "month") return { unit: "month", value: frequency.interval };
  return { unit: "month", value: Math.max(1, 12 * frequency.interval) };
}

/** 付息方式的原始编码 → 标准档位值（用于表单 select 回显）；未知值回退 maturity。 */
export function parseBondPayoutLabel(raw: string | null | undefined): string {
  const frequency = parseDepositInterestPayout(raw);
  if (frequency.kind === "maturity") return "maturity";
  if (frequency.unit === "week") return frequency.interval === 1 ? "weekly" : `weekly:${frequency.interval}`;
  if (frequency.unit === "month") return frequency.interval === 1 ? "monthly" : `monthly:${frequency.interval}`;
  return frequency.interval === 1 ? "yearly" : `yearly:${frequency.interval}`;
}
