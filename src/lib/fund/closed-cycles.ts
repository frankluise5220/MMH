/**
 * 持仓周期（cycle）推导。
 *
 * 「清仓」是一件事件，不是产品的一种状态：同一只基金买 → 清仓 → 再买 → 再清仓，
 * 应该留下两条清仓记录，各自带着自己的首买日、清仓日、买入金额、赎回金额和已实现收益。
 * 若按产品聚合（FundHolding 一行一条），第二次建仓会把上一次的清仓记录顶掉，
 * 清仓次数、每次的收益率、持有天数都随之消失。
 *
 * 这里不引入新表：清仓周期完全可以从基金流水重放出来——份额从 0 出发、回到 0
 * 就是一个周期。货基的收益结转只增份额、不产生现金流，算作周期内的份额增量，
 * 但不计入买入金额。
 */

export type CycleEntryInput = {
  fundCode: string | null;
  fundSubtype: string | null;
  /** 交易来源；货基收益结转（money_fund_income）只增份额、不计金额。 */
  source?: string | null;
  units: number | null;
  grossAmount: number | null;
  arrivalAmount: number | null;
  /** 业务日 YYYY-MM-DD（UTC 午夜契约）。 */
  date: string;
  /** 同一业务日内的先后次序（createdAt 毫秒）。 */
  order: number;
};

export type ClosedCycle = {
  /** 同一基金多次清仓时用于区分行：fundCode#首买日~清仓日。 */
  key: string;
  fundCode: string;
  firstBuyDate: string;
  clearedDate: string;
  totalBuyAmount: number;
  totalRedeemAmount: number;
  realizedProfit: number;
  returnRate: number;
};

const UNIT_EPS = 1e-6;
const MONEY_INCOME_SOURCE = "money_fund_income";

type Direction = 1 | -1 | 0;

function directionOf(subtype: string | null | undefined): Direction {
  if (subtype === "buy" || subtype === "switch_in") return 1;
  if (subtype === "redeem" || subtype === "switch_out") return -1;
  return 0;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function roundUnits(value: number) {
  return Number(value.toFixed(6));
}

type CycleState = {
  units: number;
  buyAmount: number;
  redeemAmount: number;
  firstBuyDate: string;
  lastDate: string;
};

function emptyState(): CycleState {
  return { units: 0, buyAmount: 0, redeemAmount: 0, firstBuyDate: "", lastDate: "" };
}

function toClosedCycle(fundCode: string, state: CycleState, clearedDate: string): ClosedCycle {
  const totalBuyAmount = roundMoney(state.buyAmount);
  const totalRedeemAmount = roundMoney(state.redeemAmount);
  const realizedProfit = roundMoney(totalRedeemAmount - totalBuyAmount);
  return {
    key: `${fundCode}#${state.firstBuyDate}~${clearedDate}`,
    fundCode,
    firstBuyDate: state.firstBuyDate,
    clearedDate,
    totalBuyAmount,
    totalRedeemAmount,
    realizedProfit,
    returnRate: totalBuyAmount > 0 ? realizedProfit / totalBuyAmount : 0,
  };
}

/**
 * @param entries     该账户的全部基金流水（调用方已按 deletedAt 过滤）
 * @param clearedCodes 显示层判定为「已清仓」的基金代码。流水里份额没有归零、
 *                     但持仓表已归零（历史缺赎回记录）时，用它把这些周期强制封存，
 *                     避免整段清仓记录凭空消失。
 */
export function deriveClosedCycles(
  entries: CycleEntryInput[],
  clearedCodes: Iterable<string> = [],
): ClosedCycle[] {
  const forced = new Set(Array.from(clearedCodes).map((code) => String(code ?? "").trim()).filter(Boolean));

  const byCode = new Map<string, CycleEntryInput[]>();
  for (const entry of entries) {
    const code = String(entry.fundCode ?? "").trim();
    if (!code) continue;
    // 认购失败只有现金流，从不形成份额，也不可能构成持仓周期。
    if (entry.fundSubtype === "buy_failed") continue;
    const list = byCode.get(code);
    if (list) list.push(entry);
    else byCode.set(code, [entry]);
  }

  const closed: ClosedCycle[] = [];

  for (const [code, list] of byCode) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

    let state = emptyState();
    let open = false;

    for (const entry of list) {
      const units = Math.abs(entry.units ?? 0);
      const gross = Math.abs(entry.grossAmount ?? 0);
      const arrival = Math.abs(entry.arrivalAmount ?? 0);
      const direction = directionOf(entry.fundSubtype);

      // 收益结转：净值恒 1、只增份额，既没有现金流，也不该被当成一次申购。
      if (entry.source === MONEY_INCOME_SOURCE) {
        // 周期已封存后的补记结转不参与任何周期，否则会给下一轮凭空多出份额。
        if (open && units > UNIT_EPS) {
          state.units = roundUnits(state.units + units);
          state.lastDate = entry.date;
        }
        continue;
      }

      if (direction > 0) {
        if (units > UNIT_EPS) {
          if (!open) {
            state = emptyState();
            state.firstBuyDate = entry.date;
            open = true;
          }
          state.units = roundUnits(state.units + units);
          state.buyAmount += gross;
          state.lastDate = entry.date;
        } else if (open) {
          // 在途申购（份额未确认）只占资金，不开周期，但属于本轮投入。
          state.buyAmount += gross;
          state.lastDate = entry.date;
        }
        continue;
      }

      if (direction < 0) {
        if (!open) continue;
        state.units = roundUnits(state.units - units);
        state.redeemAmount += arrival > 0 ? arrival : gross;
        state.lastDate = entry.date;
        if (state.units <= UNIT_EPS) {
          closed.push(toClosedCycle(code, state, entry.date));
          state = emptyState();
          open = false;
        }
        continue;
      }

      // 现金分红：份额不变，回收金额照计（与「清仓收益 = 回收 − 投入」的口径一致）。
      if (entry.fundSubtype === "dividend_cash" && open) {
        state.redeemAmount += gross;
        state.lastDate = entry.date;
      }
    }

    // 持仓表说已经清零、流水却还留着份额：按最后一笔业务日封存，别把记录丢掉。
    if (open && forced.has(code)) {
      closed.push(toClosedCycle(code, state, state.lastDate || state.firstBuyDate));
    }
  }

  return closed.sort((a, b) => b.clearedDate.localeCompare(a.clearedDate) || a.fundCode.localeCompare(b.fundCode));
}
