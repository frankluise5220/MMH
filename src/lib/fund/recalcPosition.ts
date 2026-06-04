import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getLatestFundNav } from "@/lib/fund/navCache";

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "toNumber" in Object.getPrototypeOf(v as object)) return toNumber(v as { toNumber: () => number });
  return Number(v);
}

type Lot = { units: number; costPerUnit: number };

type EntryLike = {
  id: string;
  fundCode: string | null;
  fundName: string | null;
  amount: number;
  fee: number;
  arrivalAmount: number | null;
  units: number | null;
  subtype: string | null;
  source: string | null;
  isPending: boolean;
};

type HoldingCalc = { fundName: string; units: number; cost: number; pendingCost: number; historicalProfit: number };

type PositionCalcResult = {
  holdings: Map<string, HoldingCalc>;
  realizedProfitByEntryId: Map<string, number>;
};

function calcByMovingAvg(entries: EntryLike[]): PositionCalcResult {
  const map = new Map<string, HoldingCalc>();
  const realizedProfitByEntryId = new Map<string, number>();
  for (const e of entries) {
    if (!e.fundCode) continue;
    const code = e.fundCode;
    const fundName = e.fundName ?? code;
    const amount = toNum(e.amount);
    const subtype = e.subtype ?? (amount < 0 ? "buy" : "redeem");
    // buy_failed（暂停申购）：支出增加待确认金额，退回减少待确认金额，两者对冲为0
    if (subtype === "buy_failed") {
      const rec = map.get(code) ?? { fundName, units: 0, cost: 0, pendingCost: 0, historicalProfit: 0 };
      const principal = Math.abs(amount);
      if (e.source === "regular_invest_refund") {
        rec.pendingCost -= principal;
      } else {
        rec.pendingCost += principal;
      }
      // 仅最后 clamp，不每步夹紧（否则 refund 在前时会被吞掉）
      map.set(code, rec);
      continue;
    }

    const rec = map.get(code) ?? { fundName, units: 0, cost: 0, pendingCost: 0, historicalProfit: 0 };

    if (subtype === "buy") {
      const principal = Math.abs(amount);
      const u = e.units ?? 0;
      // 未确认定义：份额为0（无论是否有确认日期）
      if (u === 0) {
        rec.pendingCost += principal;
      } else {
        rec.cost += principal;
        rec.units += u;
      }
    } else if (subtype === "dividend_cash") {
      // 现金红利：直接累加到历史收益（不涉及份额/成本变动）
      rec.historicalProfit += Math.abs(amount);
    } else if (subtype === "redeem" || subtype === "switch_out") {
      if (e.units != null && e.units > 0) {
        const confirmedCost = rec.cost;
        const confirmedUnits = rec.units;
        const avgCost = confirmedUnits > 0 ? confirmedCost / confirmedUnits : 0;
        const costReduced = avgCost * e.units;
        const proceeds = e.arrivalAmount ?? Math.max(0, amount - e.fee);
        const realizedProfit = proceeds - costReduced;
        rec.cost -= costReduced;
        rec.units -= e.units;
        rec.historicalProfit += realizedProfit;
        realizedProfitByEntryId.set(e.id, realizedProfit);
      }
    }

    rec.cost = Math.max(0, rec.cost);
    rec.units = Math.max(0, rec.units);
    if (!rec.fundName || rec.fundName === code) rec.fundName = fundName;
    map.set(code, rec);
  }
  // 最后 clamp pendingCost（仅一次，避免 refund 在前时被吞掉）
  for (const rec of map.values()) {
    rec.pendingCost = Math.max(0, rec.pendingCost);
  }
  return { holdings: map, realizedProfitByEntryId };
}

function calcByFifo(entries: EntryLike[], lifo = false): PositionCalcResult {
  const lots = new Map<string, Lot[]>();
  const result = new Map<string, HoldingCalc>();
  const realizedProfitByEntryId = new Map<string, number>();

  for (const e of entries) {
    if (!e.fundCode) continue;
    const code = e.fundCode;
    const fundName = e.fundName ?? code;
    const amount = toNum(e.amount);
    const subtype = e.subtype ?? (amount < 0 ? "buy" : "redeem");

    // buy_failed（暂停申购）：支出增加待确认金额，退回减少待确认金额，两者对冲为0
    if (subtype === "buy_failed") {
      const rec = result.get(code) ?? { fundName, units: 0, cost: 0, pendingCost: 0, historicalProfit: 0 };
      const principal = Math.abs(amount);
      if (e.source === "regular_invest_refund") {
        rec.pendingCost -= principal;
      } else {
        rec.pendingCost += principal;
      }
      result.set(code, rec);
      continue;
    }

    if (!lots.has(code)) lots.set(code, []);
    const codeLots = lots.get(code)!;
    const rec = result.get(code) ?? { fundName, units: 0, cost: 0, pendingCost: 0, historicalProfit: 0 };

    if (subtype === "buy") {
      const principal = Math.abs(amount);
      const u = e.units ?? 0;
      // 未确认定义：份额为0（无论是否有确认日期）
      if (u === 0) {
        rec.pendingCost += principal;
      } else {
        const costPerUnit = principal / u;
        codeLots.push({ units: u, costPerUnit });
        rec.units += u;
        rec.cost += principal;
      }
    } else if (subtype === "dividend_cash") {
      // 现金红利：直接累加到历史收益（不涉及份额/成本变动）
      rec.historicalProfit += Math.abs(amount);
    } else if (subtype === "redeem" || subtype === "switch_out") {
      let toRedeem = e.units ?? 0;
      let costReduced = 0;
      const queue = lifo ? [...codeLots].reverse() : codeLots;
      for (const lot of queue) {
        if (toRedeem <= 0) break;
        const take = Math.min(lot.units, toRedeem);
        costReduced += take * lot.costPerUnit;
        lot.units -= take;
        toRedeem -= take;
      }
      lots.set(code, codeLots.filter(l => l.units > 0.0001));
      rec.units = Math.max(0, rec.units - (e.units ?? 0));
      rec.cost = Math.max(0, rec.cost - costReduced);
      const proceeds = e.arrivalAmount ?? Math.max(0, amount - e.fee);
      const realizedProfit = proceeds - costReduced;
      rec.historicalProfit += realizedProfit;
      realizedProfitByEntryId.set(e.id, realizedProfit);
    }

    if (!rec.fundName || rec.fundName === code) rec.fundName = fundName;
    result.set(code, rec);
  }
  return { holdings: result, realizedProfitByEntryId };
}

export async function recalcFundPositions(accountId: string, fundCodes?: string[]) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return;
  if (account.kind !== "investment") return;

  // 从 TxRecord 查询基金交易
  // 买入类：投资账户在 toAccountId（资金接收方）
  // 赎回类：投资账户在 accountId（发起方）
  const rawEntries = await prisma.txRecord.findMany({
    where: {
      OR: [
        { toAccountId: accountId },
        { accountId: accountId },
      ],
      fundCode: { not: null },
      deletedAt: null,
    },
    select: {
      id: true,
      fundCode: true,
      fundName: true,
      toAccountName: true,
      amount: true,
      fundFee: true,
      fundArrivalAmount: true,
      fundUnits: true,
      fundSubtype: true,
      fundConfirmDate: true,
      source: true,
      date: true,
      createdAt: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  // 提取每个基金代码的名称：优先从净值缓存库（权威来源），其次从明细记录
  // 这切断持仓→明细的名称传播循环
  const navNameByCode = new Map<string, string>();
  for (const code of new Set(rawEntries.map(e => e.fundCode).filter(Boolean))) {
    const latestNav = await getLatestFundNav(code!);
    if (latestNav?.name) navNameByCode.set(code!, latestNav.name);
  }
  const latestFundNameByCode = new Map<string, string>();
  for (const e of rawEntries) {
    if (e.fundCode && e.fundName) {
      // 只在没有权威名称时才用明细名称作为兜底
      if (!navNameByCode.has(e.fundCode)) {
        latestFundNameByCode.set(e.fundCode, e.fundName);
      }
    }
  }

  const entries: EntryLike[] = rawEntries
    .filter(e => !fundCodes || (e.fundCode && fundCodes.includes(e.fundCode)))
    .map(e => ({
      id: e.id,
      fundCode: e.fundCode,
      fundName: navNameByCode.get(e.fundCode ?? "") ?? latestFundNameByCode.get(e.fundCode ?? "") ?? e.fundCode ?? "",
      amount: toNum(e.amount),
      fee: toNum(e.fundFee ?? 0),
      arrivalAmount: e.fundArrivalAmount != null ? toNum(e.fundArrivalAmount) : null,
      units: e.fundUnits != null ? toNum(e.fundUnits) : null,
      subtype: e.fundSubtype ?? null,
      source: e.source ?? null,
      isPending: e.fundSubtype === "buy_failed" || (e.fundConfirmDate == null && e.fundSubtype === "buy"),
    }));

  const codesToCalc = fundCodes ?? [...new Set(entries.map(e => e.fundCode).filter(Boolean))] as string[];

  const costBasisMethod = account.costBasisMethod ?? "moving_avg";
  let calcResult: PositionCalcResult;
  if (costBasisMethod === "fifo") {
    calcResult = calcByFifo(entries);
  } else if (costBasisMethod === "lifo") {
    calcResult = calcByFifo(entries, true);
  } else {
    calcResult = calcByMovingAvg(entries);
  }
  const symbolMap = calcResult.holdings;

  for (const e of rawEntries) {
    if (e.fundSubtype !== "redeem" && e.fundSubtype !== "switch_out") continue;
    if (fundCodes && e.fundCode && !fundCodes.includes(e.fundCode)) continue;
    const realizedProfit = calcResult.realizedProfitByEntryId.get(e.id) ?? null;
    await prisma.txRecord.update({
      where: { id: e.id },
      data: { realizedProfit },
    });
  }

  const navCaches = await prisma.fundNavCache.findMany({
    where: { fundCode: { in: codesToCalc } },
    orderBy: { navDate: "desc" },
  });
  const navCacheMap = new Map<string, number>();
  for (const c of navCaches) {
    if (!navCacheMap.has(c.fundCode)) navCacheMap.set(c.fundCode, toNum(c.nav));
  }

  for (const code of codesToCalc) {
    const rec = symbolMap.get(code);
    if (!rec) {
      // 没有活跃明细数据，删除持仓
      await prisma.fundHolding.deleteMany({ where: { accountId, fundCode: code } });
      continue;
    }

    const avgCost = rec.units > 0 ? rec.cost / rec.units : 0;

    const latestNavFromHolding = await prisma.fundHolding.findFirst({
      where: { accountId, fundCode: code, nav: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { nav: true },
    });

    const navFromCache = navCacheMap.get(code);
    const navFromHolding = latestNavFromHolding?.nav != null ? toNum(latestNavFromHolding.nav) : null;
    const navToUse = navFromCache ?? navFromHolding;

    const existing = await prisma.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode: code } },
    });

    const holdingData = {
      fundName: rec.fundName,
      units: rec.units,
      avgCost,
      cost: rec.cost + rec.pendingCost,
      nav: navToUse ?? undefined,
      pendingCost: rec.pendingCost,
      historicalProfit: rec.historicalProfit,
    };

    if (existing) {
      await prisma.fundHolding.update({
        where: { accountId_fundCode: { accountId, fundCode: code } },
        data: holdingData,
      });
    } else {
      await prisma.fundHolding.create({
        data: {
          accountId,
          fundCode: code,
          ...holdingData,
        },
      });
    }
  }
}