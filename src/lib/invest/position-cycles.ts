/**
 * 通用「持仓周期」重放：把一串加减数量的事件折成若干「建仓 → 清仓」周期。
 *
 * 清仓是事件而不是状态：同一个产品清仓后又买，就该多出一条清仓记录，
 * 各自带自己的首买日、清仓日、投入与回收。若按产品聚合（holding 一行一条），
 * 第二轮的数字会把第一轮吞掉，清仓次数和每轮收益率都失真。
 *
 * 基金侧有货基收益结转这类特殊来源，用 `@/lib/fund/closed-cycles`；
 * 这里是股票、贵金属这类「数量 + 现金流」产品的通用版本。
 */

export type PositionCycleEvent = {
  /** 产品键（股票用 securityId，贵金属用 metalTypeId::metalUnitId）。 */
  key: string;
  /** 业务日 YYYY-MM-DD。 */
  date: string;
  /** 同一业务日内的先后次序。 */
  order: number;
  /** 数量增量：买入/送股/拆股为正，卖出/并股为负；无法判定时传 null（该行不参与重放）。 */
  delta: number | null;
  /** 现金流：投入（买入金额 + 费用）。 */
  invest?: number;
  /** 现金流：回收（卖出净额、现金分红、退税）。 */
  redeem?: number;
};

export type PositionCycle = {
  key: string;
  firstBuyDate: string;
  clearedDate: string;
  totalInvestAmount: number;
  totalRedeemAmount: number;
  realizedProfit: number;
  returnRate: number;
};

const QUANTITY_EPS = 0.000001;

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundQuantity(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type CycleState = {
  quantity: number;
  invest: number;
  redeem: number;
  firstBuyDate: string;
};

function emptyState(): CycleState {
  return { quantity: 0, invest: 0, redeem: 0, firstBuyDate: "" };
}

function toCycle(key: string, state: CycleState, clearedDate: string): PositionCycle {
  const totalInvestAmount = roundMoney(state.invest);
  const totalRedeemAmount = roundMoney(state.redeem);
  const realizedProfit = roundMoney(totalRedeemAmount - totalInvestAmount);
  return {
    key,
    firstBuyDate: state.firstBuyDate,
    clearedDate,
    totalInvestAmount,
    totalRedeemAmount,
    realizedProfit,
    returnRate: totalInvestAmount > 0 ? realizedProfit / totalInvestAmount : 0,
  };
}

/**
 * @param events 该产品在同一账户下的全部数量事件（调用方已按 deletedAt 过滤）
 * @returns 按清仓日倒序排列的周期；尚未清仓的批次不会返回
 */
export function derivePositionCycles(events: PositionCycleEvent[]): PositionCycle[] {
  const byKey = new Map<string, PositionCycleEvent[]>();
  for (const event of events) {
    if (!event.key) continue;
    const list = byKey.get(event.key);
    if (list) list.push(event);
    else byKey.set(event.key, [event]);
  }

  const cycles: PositionCycle[] = [];

  for (const [key, list] of byKey) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

    let state = emptyState();
    let open = false;

    for (const event of list) {
      // 分红只影响收益，不改变数量：归到当前这一轮，没有持仓就当没有发生。
      if (event.delta == null || Math.abs(event.delta) <= QUANTITY_EPS) {
        if (open && event.redeem != null) state.redeem += event.redeem;
        continue;
      }

      if (event.delta > 0) {
        if (!open) {
          state = emptyState();
          state.firstBuyDate = event.date;
          open = true;
        }
        state.quantity = roundQuantity(state.quantity + event.delta);
        if (event.invest != null) state.invest += event.invest;
        continue;
      }

      if (!open) continue;
      state.quantity = roundQuantity(state.quantity + event.delta);
      if (event.redeem != null) state.redeem += event.redeem;
      if (state.quantity <= QUANTITY_EPS) {
        cycles.push(toCycle(key, state, event.date));
        state = emptyState();
        open = false;
      }
    }
  }

  return cycles.sort((a, b) => b.clearedDate.localeCompare(a.clearedDate) || a.key.localeCompare(b.key));
}
