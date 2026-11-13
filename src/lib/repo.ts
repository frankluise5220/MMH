import { estimateBondInterestForDays } from "@/lib/bond";
import { addDaysUtc, formatDateUtc, isTradingClosedDate, parseDateInputToUtc } from "@/lib/date-utils";
import type { RepoOccupiedDaysMode } from "@/lib/preferences";

/**
 * 逆回购（GC / R-）—— 券商账户里的「借出资金、到期还本付息」。
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

/**
 * 存单/明细上显示的名字：`GC001 · 1天期`，占款天数与期限不同时补成
 * `GC001 · 1天期（占款3天）`。
 *
 * 期限是品种属性（GC001 = 1 天期），占款是钱实际被占用/计息的自然日数：周五做
 * 1 天期，到期日顺延到下周一，占款是 3 天。只写「1天」会被读成「这笔钱只占 1 天」，
 * 所以两者不一致时把占款一并写出来。
 */
export function repoProductLabel(item: RepoProduct, occupiedDays?: number | null): string {
  return repoLabelFor(item.name, item.termDays, occupiedDays);
}

/** 只有名字与期限时的同一份规则（编辑自定义品种、品种清单还没加载完时用）。 */
export function repoLabelFor(name: string, termDays: number, occupiedDays?: number | null): string {
  const safeTerm = Number.isFinite(termDays) && termDays > 0 ? Math.round(termDays) : 1;
  const term = `${safeTerm}天期`;
  const occupied = Number(occupiedDays ?? 0);
  if (!Number.isFinite(occupied) || occupied <= 0 || Math.round(occupied) === safeTerm) {
    return `${name} · ${term}`;
  }
  return `${name} · ${term}（占款${Math.round(occupied)}天）`;
}

/**
 * 明细备注里剥掉系统拼的前缀，只留用户自己写的部分。
 *
 * `buildBondCashFlowNote` 会把「逆回购借出 <品种名>」拼在用户备注前面；编辑时把
 * 一整串回填进备注框再保存，就会滚成「逆回购借出 X；逆回购借出 X；…」。
 */
export function stripRepoNotePrefix(
  note: string | null | undefined,
  productName: string | null | undefined,
): string {
  const text = String(note ?? "").trim();
  const name = String(productName ?? "").trim();
  if (!text || !name) return text;
  for (const action of ["逆回购借出", "逆回购到期回款", "逆回购利息", "逆回购核销"]) {
    const prefix = `${action} ${name}`;
    if (!text.startsWith(prefix)) continue;
    const rest = text.slice(prefix.length).trim();
    return rest.startsWith("；") ? rest.slice(1).trim() : rest;
  }
  return text;
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
 * 与债券存单共用同一个公式（@/lib/bond 的 estimateBondInterestForDays），年化按 365 天折算；
 * 天数取 `repoOccupiedDays`（自然日口径：周五 1 天期顺延到周一算 3 天，与券商实付一致）。
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

/**
 * 占款天数。同一天同一张存单，三种口径能算出三个数，所以由账簿设置决定
 * （`HouseholdPreference.repoOccupiedDaysMode`，详见 `RepoOccupiedDaysMode`）：
 *
 * - `actual`（默认，与券商实付一致）：成交日 → 到期日（回款日）的自然日差。周五做
 *   1 天期，T+1 落在周六，实际到账顺延到下周一，占款 3 天（周末照付利息）；跨长假同理。
 * - `term`：只按品种期限，顺延回款不加天（周五的 1 天期就是 1 天）。
 * - `arrival_gap`：期限 + 回款日之后到下个交易日的休市天数。回款日落在周五就 +2，
 *   表达「钱周五回来、周末动不了」；周四买 1 天期 = 3 天，周五买 1 天期 = 1 天，
 *   周二买 3 天期 = 5 天。
 *
 * 三种口径都必须保留：账本里「预计利息」要对得上对账单（actual），也有人只想看
 * 合约期限（term），还有按资金实际不可用天数做资金规划的（arrival_gap）。
 */
export function repoOccupiedDays(
  tradeDateKey: string | null,
  maturityKey: string | null,
  termDays?: number | null,
  mode: RepoOccupiedDaysMode = "actual",
): number {
  const from = parseDateInputToUtc(tradeDateKey ?? "");
  const to = parseDateInputToUtc(maturityKey ?? "");
  if (!from || !to) return 0;
  const calendarDays = Math.max(0, Math.round((to.getTime() - from.getTime()) / 86400000));
  if (calendarDays <= 0) return 0;
  if (mode === "actual") return calendarDays;

  // 期限是另外两种口径的基数；拿不到期限（旧数据、清单外品种）只能退回自然日。
  const term = Math.round(Number(termDays ?? 0));
  if (!(term > 0)) return calendarDays;
  if (mode === "term") return term;
  // 延期回款（回款日被拖到推算到期日之后）照样把多出来的自然日补上，
  // 否则「拖到下周才回款」反而显示得比按时回款还短。
  const scheduled = parseDateInputToUtc(estimateRepoMaturityDateKey(tradeDateKey ?? "", term));
  const delay = scheduled ? Math.max(0, Math.round((to.getTime() - scheduled.getTime()) / 86400000)) : 0;
  return term + repoClosedDaysAfter(maturityKey ?? "") + delay;
}

/**
 * 回款日之后紧跟着的休市天数（周六、周日、A 股法定节假日都算）。
 * 只看回款日之后：钱在回款日当天已经可用，被算作占款的是它之后动不了的那几天。
 */
function repoClosedDaysAfter(arrivalKey: string): number {
  let cursor = parseDateInputToUtc(arrivalKey);
  if (!cursor) return 0;
  let closed = 0;
  // 最多数 10 天，防止脏数据把长假循环拉长。
  for (let step = 0; step < 10; step += 1) {
    cursor = addDaysUtc(cursor, 1);
    if (!isTradingClosedDate(formatDateUtc(cursor), "cn_fund")) break;
    closed += 1;
  }
  return closed;
}

/**
 * 到期日 = 成交日 + 期限（自然日），落在非交易日则顺延到下一个交易日。
 *
 * 到期日必须是交易日：周五做 1 天期，T+1 落在周六，实际到账是下周一；占款几天由
 * 账簿的 `RepoOccupiedDaysMode` 决定（见 `repoOccupiedDays`）。非交易日取「周末 + A 股
 * 法定节假日」（`isTradingClosedDate(..., "cn_fund")`）；节假日表覆盖 2024 年起，
 * 更早的日期退化成只跳周末，用户可在到期日字段上手动改。
 */
export function estimateRepoMaturityDateKey(tradeDateKey: string, termDays: number): string {
  const trade = parseDateInputToUtc(tradeDateKey);
  if (!trade) return tradeDateKey;
  const days = Number.isFinite(termDays) && termDays > 0 ? Math.round(termDays) : 1;
  let cursor = addDaysUtc(trade, days);
  // 最多顺延 10 天，防止脏数据死循环。
  for (let step = 0; step < 10 && isTradingClosedDate(formatDateUtc(cursor), "cn_fund"); step += 1) {
    cursor = addDaysUtc(cursor, 1);
  }
  return formatDateUtc(cursor);
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
