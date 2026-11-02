import { estimateBondInterestForDays } from "@/lib/bond";
import { addDaysUtc, parseDateInputToUtc } from "@/lib/date-utils";

/**
 * 国债逆回购（GC / R-）—— 券商账户里的「借出资金、到期还本付息」。
 *
 * 为什么放在债券下面：逆回购在账务上就是**一张到期一次还本付息的存单**
 * （本金固定、年化固定、有到期日），与债券的存单模型完全同构，因此复用
 * bond_transactions（instrumentKind = "repo"），而不是新造一套交易表。
 *
 * 品种、期限、费率都是交易所规则常量，不入库：券商 App 里用户看到的也是
 * 这一份清单（代码 + 期限 + 起投），录入时选品种就等于填好了期限与费率。
 */

export const BOND_INSTRUMENT_KIND = "bond";
export const REPO_INSTRUMENT_KIND = "repo";

export type RepoMarket = "sh" | "sz";

export type RepoProduct = {
  /** 交易代码，如 204001 / 131810。 */
  code: string;
  /** 品种简称，如 GC001 / R-001。 */
  name: string;
  market: RepoMarket;
  /** 期限（自然日），决定到期日与计息天数。 */
  termDays: number;
  /** 起投金额（元）。只做提示，不做硬校验（各券商口径有差异）。 */
  minAmount: number;
  /** 递增单位（元）。 */
  stepAmount: number;
  /** 手续费率（% of 成交金额，单向），交易所按期限分档定价。 */
  feeRatePercent: number;
};

export const REPO_MARKET_LABEL: Record<RepoMarket, string> = {
  sh: "沪市",
  sz: "深市",
};

/** 费率档位：1/2/3/4 天 0.001%，7 天 0.005%，14 天 0.010%，28 天 0.020%，91/182 天 0.030%。 */
const REPO_FEE_RATE_BY_TERM: Record<number, number> = {
  1: 0.001,
  2: 0.001,
  3: 0.001,
  4: 0.001,
  7: 0.005,
  14: 0.01,
  28: 0.02,
  91: 0.03,
  182: 0.03,
};

function product(
  market: RepoMarket,
  code: string,
  name: string,
  termDays: number,
): RepoProduct {
  return {
    code,
    name,
    market,
    termDays,
    // 沪深两市逆回购均以 1,000 元为申报单位；部分券商对沪市另有 10 万元起的限制，
    // 因此这里只作为「提示」使用，绝不阻断用户录入。
    minAmount: 1000,
    stepAmount: 1000,
    feeRatePercent: REPO_FEE_RATE_BY_TERM[termDays] ?? 0.03,
  };
}

export const REPO_PRODUCTS: readonly RepoProduct[] = [
  product("sh", "204001", "GC001", 1),
  product("sh", "204002", "GC002", 2),
  product("sh", "204003", "GC003", 3),
  product("sh", "204004", "GC004", 4),
  product("sh", "204007", "GC007", 7),
  product("sh", "204014", "GC014", 14),
  product("sh", "204028", "GC028", 28),
  product("sh", "204091", "GC091", 91),
  product("sh", "204182", "GC182", 182),
  product("sz", "131810", "R-001", 1),
  product("sz", "131811", "R-002", 2),
  product("sz", "131800", "R-003", 3),
  product("sz", "131809", "R-004", 4),
  product("sz", "131801", "R-007", 7),
  product("sz", "131802", "R-014", 14),
  product("sz", "131803", "R-028", 28),
  product("sz", "131805", "R-091", 91),
  product("sz", "131806", "R-182", 182),
];

export function repoProductByCode(code: string | null | undefined): RepoProduct | null {
  const normalized = String(code ?? "").trim();
  if (!normalized) return null;
  return REPO_PRODUCTS.find((item) => item.code === normalized) ?? null;
}

export function repoProductByName(name: string | null | undefined): RepoProduct | null {
  const normalized = String(name ?? "").trim().toUpperCase();
  if (!normalized) return null;
  return REPO_PRODUCTS.find((item) => item.name.toUpperCase() === normalized) ?? null;
}

/** 存单/明细上显示的名字：`GC001 · 1天`。 */
export function repoProductLabel(item: RepoProduct): string {
  return `${item.name} · ${item.termDays}天`;
}

/** 从历史名字里回推品种（明细只见名字，没有代码列）。 */
export function repoProductFromLabel(label: string | null | undefined): RepoProduct | null {
  const text = String(label ?? "").trim();
  if (!text) return null;
  const name = text.split(/[·\s]/)[0] ?? "";
  return repoProductByName(name);
}

export function repoFeeRatePercent(termDays: number | null | undefined): number {
  const days = Number(termDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return 0;
  if (REPO_FEE_RATE_BY_TERM[days] != null) return REPO_FEE_RATE_BY_TERM[days];
  // 非标准期限（用户手填）按最长档保守估算。
  return 0.03;
}

/**
 * 手续费 = 成交金额 × 费率，四舍五入到分；有成交至少收 0.01（券商口径）。
 */
export function estimateRepoFee(principal: number, termDays: number | null | undefined): number {
  const amount = Number(principal ?? 0);
  if (!(amount > 0)) return 0;
  const rate = repoFeeRatePercent(termDays);
  const fee = Number(((amount * rate) / 100).toFixed(2));
  return fee > 0 ? Math.max(0.01, fee) : 0;
}

/**
 * 利息 = 本金 × 年化 × 实际占款天数 ÷ 365。
 *
 * 与债券存单共用同一个公式（@/lib/bond 的 estimateBondInterestForDays），
 * 逆回购的交易所计息口径正好也是 365 天的自然日计息。
 */
export function estimateRepoInterest(params: {
  principal: number;
  annualRate: number | null | undefined;
  occupiedDays: number;
}): number {
  return estimateBondInterestForDays({
    principal: params.principal,
    annualRate: params.annualRate,
    days: params.occupiedDays,
  });
}

/** 占款天数 = 到期日 − 成交日（自然日）。周五做 1 天期因此是 3 天。 */
export function repoOccupiedDays(tradeDateKey: string | null, maturityKey: string | null): number {
  const from = parseDateInputToUtc(tradeDateKey ?? "");
  const to = parseDateInputToUtc(maturityKey ?? "");
  if (!from || !to) return 0;
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86400000));
}

function isWeekendUtc(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * 到期日 = 成交日 + 期限（自然日），落在周末则顺延到下一个工作日。
 *
 * 交易所的准确规则还要避开法定节假日；项目里没有可用的交易日历表，
 * 所以这里只处理周末，节假日由用户在到期日字段上手动改一天（表单里可编辑）。
 */
export function estimateRepoMaturityDateKey(tradeDateKey: string, termDays: number): string {
  const trade = parseDateInputToUtc(tradeDateKey);
  if (!trade) return tradeDateKey;
  const days = Number.isFinite(termDays) && termDays > 0 ? Math.round(termDays) : 1;
  let cursor = addDaysUtc(trade, days);
  // 最多顺延 10 天，防止脏数据死循环。
  for (let step = 0; step < 10 && isWeekendUtc(cursor); step += 1) {
    cursor = addDaysUtc(cursor, 1);
  }
  return cursor.toISOString().slice(0, 10);
}

export function estimateRepoMaturityDate(tradeDateKey: string, termDays: number): Date | null {
  return parseDateInputToUtc(estimateRepoMaturityDateKey(tradeDateKey, termDays));
}

/** 「全部可用」按递增单位向下取整（券商 App 的可用金额通常已是整数倍）。 */
export function repoAmountByAvailable(available: number, stepAmount: number): number {
  const amount = Number(available ?? 0);
  const step = Number(stepAmount ?? 0);
  if (!(amount > 0)) return 0;
  if (!(step > 0)) return Number(amount.toFixed(2));
  return Math.floor(amount / step) * step;
}
