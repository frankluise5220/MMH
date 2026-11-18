import { FundCashFlowKind, FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber, todayDateBusinessYmd } from "@/lib/date-utils";

/**
 * 已确认未到期的买入（确认日在未来）。
 *
 * 产品口径：份额只在**确认日当天及之后**才算进持仓。基金/定投记录允许提前带上
 * 净值与份额（确认日的净值已公布时就会写入），但在确认日到来前，这笔钱只能算
 * 「在途申购」，既不能计入份额，也不参与浮动盈亏。
 *
 * `FundHolding` 是全量回放的结果，无法区分「已确认」与「还没到确认日」，
 * 所以读持仓的地方统一调用这里，按今天的日期把未来确认的份额扣掉，
 * 并把对应的净申购金额转成在途金额（pendingCost）。
 */
type FutureConfirmedBuy = { units: number; cost: number };

/** 与 invest-balance 内 holdingKey 相同的口径：accountId + fundCode。 */
export function futureConfirmHoldingKey(accountId: string, fundCode: string) {
  return `${accountId}::${fundCode}`;
}

function netBuyCost(row: {
  grossAmount: unknown;
  refundAmount: unknown;
  cashFlows: Array<{ kind: FundCashFlowKind; amount: unknown }>;
}) {
  const gross = Math.abs(toNumber(row.grossAmount));
  const refundByRow = Math.abs(toNumber(row.refundAmount));
  const refundByFlows = row.cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(toNumber(flow.amount)), 0);
  return Math.max(0, gross - Math.max(refundByRow, refundByFlows));
}

/**
 * 读取一批基金账户里「确认日仍未来、但已经带份额」的买入记录，按
 * accountId::fundCode 聚合。没有这种情况时返回空 Map，不会产生多余开销。
 */
export async function loadFutureConfirmedBuyMap(
  accountIds: readonly string[],
  todayKey: string = todayDateBusinessYmd(),
): Promise<Map<string, FutureConfirmedBuy>> {
  const ids = Array.from(new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  const result = new Map<string, FutureConfirmedBuy>();
  if (ids.length === 0) return result;

  // 确认日按账簿业务时区的「今天」比较：库里的 confirmDate 存的是 UTC 零点。
  // 调用方（RSC / 服务端库）必须传业务日，缺省只兜底部署默认值。
  const todayUtc = new Date(`${todayKey}T00:00:00.000Z`);

  const rows = await prisma.fundTransaction.findMany({
    where: {
      fundAccountId: { in: ids },
      deletedAt: null,
      fundSubtype: FundSubtype.buy,
      units: { gt: 0 },
      confirmDate: { gt: todayUtc },
    },
    select: {
      fundAccountId: true,
      fundCode: true,
      units: true,
      grossAmount: true,
      refundAmount: true,
      cashFlows: { select: { kind: true, amount: true } },
    },
  });

  for (const row of rows) {
    if (!row.fundAccountId || !row.fundCode) continue;
    const key = futureConfirmHoldingKey(row.fundAccountId, row.fundCode);
    const current = result.get(key) ?? { units: 0, cost: 0 };
    current.units += Math.max(0, toNumber(row.units));
    current.cost += netBuyCost(row);
    result.set(key, current);
  }

  return result;
}

/**
 * 已提交、确认日仍在未来的赎回（含转换转出）。
 *
 * 买 / 卖两侧不对称：`FundHolding` 是全量回放且不看日期，未来确认日的赎回在写库
 * 那一刻就已经从份额里扣掉了；而赎回款要到 `arrivalDate` 才进现金账户。中间这段
 * 时间总资产会凭空少一笔，份额也与真实渠道（确认日才扣份额）不一致。
 *
 * 读持仓的地方用它把份额加回去，确认日一过自然消失。成本按当前 `avgCost` 还原：
 * 移动平均法下赎回本身不改平均成本，所以 `avgCost × 赎回份额` 精确等于当时被扣掉
 * 的那部分成本（FIFO/LIFO 账户是近似口径）。
 */
type FutureConfirmedRedeem = { units: number; proceeds: number };

export async function loadFutureConfirmedRedeemMap(
  accountIds: readonly string[],
  todayKey: string = todayDateBusinessYmd(),
): Promise<Map<string, FutureConfirmedRedeem>> {
  const ids = Array.from(new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  const result = new Map<string, FutureConfirmedRedeem>();
  if (ids.length === 0) return result;

  const todayUtc = new Date(`${todayKey}T00:00:00.000Z`);

  const rows = await prisma.fundTransaction.findMany({
    where: {
      fundAccountId: { in: ids },
      deletedAt: null,
      fundSubtype: { in: [FundSubtype.redeem, FundSubtype.switch_out] },
      units: { gt: 0 },
      confirmDate: { gt: todayUtc },
    },
    select: {
      fundAccountId: true,
      fundCode: true,
      units: true,
      grossAmount: true,
      arrivalAmount: true,
    },
  });

  for (const row of rows) {
    if (!row.fundAccountId || !row.fundCode) continue;
    const key = futureConfirmHoldingKey(row.fundAccountId, row.fundCode);
    const current = result.get(key) ?? { units: 0, proceeds: 0 };
    current.units += Math.max(0, toNumber(row.units));
    current.proceeds += Math.abs(toNumber(row.arrivalAmount ?? row.grossAmount));
    result.set(key, current);
  }

  return result;
}
