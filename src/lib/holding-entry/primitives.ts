/**
 * 持仓型记账（holding entry）的中性纯函数。
 *
 * 这里只放与"品种"无关的能力：赎回本金推断、按日期回放持仓金额/份额、
 * 入账账户判据、带符号数字解析。理财（wealth）与债券（bond）等具体领域
 * 各自保留自己的表单与术语，只从这里取这些通用能力，避免任意一方把
 * 另一方的领域词汇带进自己的实现。
 */

type Movement = { date: string; delta: number };

export type HoldingAmountLike = {
  remainingAmount: number;
  movements?: Movement[];
};

export type HoldingUnitsLike = {
  remainingUnits?: number | null;
  unitMovements?: Movement[];
};

export type ArrivalAccountLike = {
  kind?: string | null;
  institutionId?: string | null;
};

/**
 * 赎回记录的"本金"推断：当本金与到账金额被记成同一个数时，需要扣掉利息，
 * 否则回填的赎回本金会虚高。
 */
export function inferRedeemPrincipalAmount(input: {
  amount?: number | null;
  fundArrivalAmount?: number | null;
  depositInterest?: number | null;
  fundSubtype?: string | null;
}) {
  const rawAmount = Math.abs(input.amount ?? 0);
  const isRedeem = input.fundSubtype === "redeem" || input.fundSubtype === "switch_out";
  if (!isRedeem) return rawAmount;

  const arrivalAmount = input.fundArrivalAmount == null ? null : Math.abs(input.fundArrivalAmount);
  const interest = input.depositInterest ?? 0;
  if (arrivalAmount != null && Math.abs(rawAmount - arrivalAmount) < 0.005) {
    return Math.max(0, arrivalAmount - interest);
  }
  return rawAmount;
}

/** 合并主/备两份产品选项，按 id 去重，保持主列表顺序优先。 */
export function mergeProductOptions<T extends { id: string }>(primary: T[], fallback: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const product of [...primary, ...fallback]) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    merged.push(product);
  }
  return merged;
}

/** 某日期上该持仓的剩余金额：有流水按日期回放，无流水直接取当前剩余。 */
export function holdingAmountAt(holding: HoldingAmountLike, date: string) {
  const movements = holding.movements ?? [];
  if (movements.length === 0) return holding.remainingAmount;
  return Number(
    movements
      .filter((movement) => !date || movement.date <= date)
      .reduce((sum, movement) => sum + movement.delta, 0)
      .toFixed(2),
  );
}

/** 某日期上该持仓的剩余份额：有流水按日期回放，无流水直接取当前剩余。 */
export function holdingUnitsAt(holding: HoldingUnitsLike, date: string) {
  const movements = holding.unitMovements ?? [];
  if (movements.length === 0) return holding.remainingUnits ?? 0;
  return Number(
    movements
      .filter((movement) => !date || movement.date <= date)
      .reduce((sum, movement) => sum + movement.delta, 0)
      .toFixed(6),
  );
}

/** 赎回入账账户：任意借记卡，或同机构的电子钱包。 */
export function isRedeemArrivalAccount(account: ArrivalAccountLike, institutionId?: string | null) {
  if (account.kind === "bank_debit") return true;
  return account.kind === "ewallet" && !!institutionId && account.institutionId === institutionId;
}

/** 分红入账账户：同机构（未限定机构时任意）的借记卡。 */
export function isDividendArrivalAccount(account: ArrivalAccountLike, institutionId?: string | null) {
  return account.kind === "bank_debit" && (!institutionId || account.institutionId === institutionId);
}

/** 解析可能带千分位的带符号数字，非法值归零。 */
export function parseSignedNumber(value: string) {
  const n = parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
