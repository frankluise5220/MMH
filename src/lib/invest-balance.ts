/**
 * 投资余额与持仓显示层计算
 *
 * 显示层规则：基金类显示数据从 FundHolding 读取，贵金属从 PreciousMetalHolding 读取。
 * 不同资产类型保持独立数据源，避免把贵金属混入基金持仓。
 * 读取时不再触发重算，避免重复计算。
 */

import { prisma } from "@/lib/db/prisma";
import { cache } from "react";
import { toNumber } from "@/lib/date-utils";
import { AccountKind } from "@prisma/client";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { getLatestFundNavMap } from "@/lib/fund/navCache";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";

export type InvestBalanceDetail = {
  marketValue: number;
  totalCost: number;
  floatingPnL: number;
};

/** 持仓明细显示行 — 从 fundHolding 表直接读取生成 */
export type PositionDisplayRow = {
  fundCode: string;
  name: string;
  units: number;
  avgCost: number;
  cost: number;
  nav: number | null;
  navDate: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  pendingCost: number;
  historicalProfit: number;
};

export type ClearedPositionRow = {
  fundCode: string;
  name: string;
  historicalProfit: number;
  totalInvested: number;
  returnRate: number;
  firstBuyDate: string;
  clearedDate: string;
  totalBuyAmount: number;
  totalRedeemAmount: number;
};

/**
 * 计算所有投资账户的余额汇总（显示层）
 *
 * 数据源：fundHolding 表（由 recalcFundPositions 在写入时维护）
 * 不再在此处调用 recalcFundPositions，避免读取时触发全量重算
 */
export const computeInvestBalances = cache(
  async (ctx: HouseholdContext): Promise<Map<string, InvestBalanceDetail>> => {
  const accounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, ...ctx.hidFilter },
    select: { id: true, kind: true, investProductType: true },
  });
  const investIds = accounts.filter(isPureInvestmentAccount).map(a => a.id);
  if (investIds.length === 0) return new Map();

  const metalAccountIds = accounts
    .filter((account) => isPureInvestmentAccount(account) && account.investProductType === "metal")
    .map((account) => account.id);
  const fundAccountIds = investIds.filter((id) => !metalAccountIds.includes(id));

  const allHoldings = await prisma.fundHolding.findMany({
    where: { accountId: { in: fundAccountIds } },
  });
  const allMetalHoldings = await prisma.preciousMetalHolding.findMany({
    where: { accountId: { in: metalAccountIds } },
  });

  const holdingsByAccountId = new Map<string, typeof allHoldings>();
  for (const holding of allHoldings) {
    const holdings = holdingsByAccountId.get(holding.accountId);
    if (holdings) {
      holdings.push(holding);
    } else {
      holdingsByAccountId.set(holding.accountId, [holding]);
    }
  }

  const fundCodes = [...new Set(allHoldings.map(h => h.fundCode))];
  const latestNavByCode = new Map<string, { nav: number; date: string }>();
  if (fundCodes.length > 0) {
    const caches = await getLatestFundNavMap(fundCodes);
    for (const [fundCode, c] of caches) {
      const d = c.navDate;
      const dateStr = `${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
      latestNavByCode.set(fundCode, { nav: c.nav, date: dateStr });
    }
  }

  const result = new Map<string, InvestBalanceDetail>();

  for (const acctId of investIds) {
    const holdings = holdingsByAccountId.get(acctId) ?? [];
    let marketValue = 0;
    let totalCost = 0;

    for (const h of holdings) {
      const units = toNumber(h.units);
      const cost = toNumber(h.cost);
      const pending = toNumber(h.pendingCost);
      const navInfo = latestNavByCode.get(h.fundCode);
      const latestNav = navInfo?.nav ?? toNumber(h.nav ?? 0);
      const confirmedCost = cost - pending;
      const confirmedMV = latestNav > 0 && units > 0 ? units * latestNav : confirmedCost;
      marketValue += confirmedMV + pending;
      totalCost += cost;
    }

    const floatingPnL = marketValue - totalCost;
    result.set(acctId, { marketValue, totalCost, floatingPnL });
  }

  for (const acctId of metalAccountIds) {
    const holdings = allMetalHoldings.filter((holding) => holding.accountId === acctId);
    const marketValue = holdings.reduce((sum, holding) => sum + toNumber(holding.marketValue), 0);
    const totalCost = holdings.reduce((sum, holding) => sum + toNumber(holding.cost), 0);
    result.set(acctId, { marketValue, totalCost, floatingPnL: marketValue - totalCost });
  }

  return result;
},
);

/**
 * 计算单个投资账户的持仓明细显示数据（显示层）
 *
 * 数据源：基金账户读 FundHolding + FundNavCache；贵金属账户读 PreciousMetalHolding。
 * 不再从 entries 逐条累加计算，保证与 Sidebar/invest 页面数字一致
 */
/** 缓存版本：同一 HTTP 请求内不重复计算 */
export const computePositionDisplay = cache(
  async (
    ctx: HouseholdContext,
    accountId: string,
  ): Promise<{
    positions: PositionDisplayRow[];
    clearedPositions: ClearedPositionRow[];
    totalMarketValue: number;
    totalCost: number;
    totalHistoricalProfit: number;
  }> => {
  const account = await prisma.account.findFirst({
    where: { id: accountId, ...ctx.hidFilter },
    select: { investProductType: true },
  });
  if (!account) {
    return { positions: [], clearedPositions: [], totalMarketValue: 0, totalCost: 0, totalHistoricalProfit: 0 };
  }

  if (account.investProductType === "metal") {
    const metalHoldings = await prisma.preciousMetalHolding.findMany({
      where: { accountId },
      orderBy: [{ metalTypeName: "asc" }, { metalUnitName: "asc" }],
    });
    const positions: PositionDisplayRow[] = metalHoldings
      .filter((holding) => toNumber(holding.quantity) > 0.000001)
      .map((holding) => {
        const quantity = toNumber(holding.quantity);
        const cost = toNumber(holding.cost);
        const unitPrice = holding.unitPrice != null ? toNumber(holding.unitPrice) : null;
        const marketValue = toNumber(holding.marketValue);
        const floatingPnL = marketValue - cost;
        return {
          fundCode: holding.metalTypeId,
          name: `${holding.metalTypeName} · ${holding.metalUnitName}`,
          units: quantity,
          avgCost: toNumber(holding.avgCost),
          cost,
          nav: unitPrice,
          navDate: "",
          marketValue,
          floatingPnL,
          floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
          pendingCost: 0,
          historicalProfit: toNumber(holding.historicalProfit),
        };
      });
    const totalMarketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
    const totalCost = positions.reduce((sum, row) => sum + row.cost, 0);
    const totalHistoricalProfit = positions.reduce((sum, row) => sum + row.historicalProfit, 0);
    return { positions, clearedPositions: [], totalMarketValue, totalCost, totalHistoricalProfit };
  }

  const holdings = await prisma.fundHolding.findMany({
    where: { accountId },
  });

  // Check if this is a money fund account (NAV always 1)
  const isMoney = account?.investProductType === "money";

  const fundCodes = [...new Set(holdings.map(h => h.fundCode))];
  const latestNavByCode = new Map<string, { nav: number; date: string; name: string | null }>();
  if (fundCodes.length > 0 && !isMoney) {
    const caches = await getLatestFundNavMap(fundCodes);
    for (const [fundCode, c] of caches) {
      const d = c.navDate;
      const dateStr = `${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
      latestNavByCode.set(fundCode, { nav: c.nav, date: dateStr, name: c.name });
    }
  }

  const positions: PositionDisplayRow[] = [];
  const clearedPositions: ClearedPositionRow[] = [];

  for (const h of holdings) {
    const units = toNumber(h.units);
    const cost = toNumber(h.cost);
    const pending = toNumber(h.pendingCost);
    const avgCost = toNumber(h.avgCost);
    const navInfo = isMoney ? { nav: 1, date: "", name: null } : latestNavByCode.get(h.fundCode);
    const latestNav = navInfo?.nav ?? (h.nav != null ? toNumber(h.nav) : 0);
    const navDateStr = navInfo?.date ?? "";
    const displayName = navInfo?.name ?? h.fundName ?? h.fundCode;
    const historicalProfit = toNumber(h.historicalProfit);

    const confirmedCost = cost - pending;
    const confirmedMV = latestNav > 0 && units > 0 ? units * latestNav : confirmedCost;
    const marketValue = confirmedMV + pending;
    const floatingPnL = marketValue - cost;
    const floatingPnLRate = cost > 0 ? floatingPnL / cost : 0;

    if (units > 0.0001 || pending > 0.01) {
      positions.push({
        fundCode: h.fundCode,
        name: displayName,
        units,
        avgCost,
        cost,
        nav: latestNav > 0 ? latestNav : null,
        navDate: navDateStr,
        marketValue,
        floatingPnL,
        floatingPnLRate,
        pendingCost: pending,
        historicalProfit,
      });
    } else {
      clearedPositions.push({
        fundCode: h.fundCode,
        name: displayName,
        historicalProfit,
        totalInvested: 0,
        returnRate: 0,
        firstBuyDate: "",
        clearedDate: "",
        totalBuyAmount: 0,
        totalRedeemAmount: 0,
      });
    }
  }

  positions.sort((a, b) => b.marketValue - a.marketValue);
  clearedPositions.sort((a, b) => b.clearedDate.localeCompare(a.clearedDate) || b.historicalProfit - a.historicalProfit);

  // 批量查询清仓基金：总投入金额 + 初次购买时间 + 清仓时间 + 申购/赎回金额
  if (clearedPositions.length > 0) {
    const clearedCodes = clearedPositions.map(c => c.fundCode);
    // 总投入金额（所有买入交易的 ABS(amount) 之和）
    const investedRows = await prisma.txRecord.groupBy({
      by: ["fundCode"],
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundSubtype: "buy",
        toAccountId: accountId,
        deletedAt: null,
      },
      _sum: { amount: true },
    });
    const investedMap = new Map<string, number>();
    for (const row of investedRows) {
      if (row.fundCode) {
        investedMap.set(row.fundCode, Math.abs(toNumber(row._sum.amount ?? 0)));
      }
    }
    // 初次购买时间（最早买入交易的日期）
    const firstBuyRows = await prisma.txRecord.groupBy({
      by: ["fundCode"],
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundSubtype: "buy",
        toAccountId: accountId,
        deletedAt: null,
      },
      _min: { date: true },
    });
    const firstBuyMap = new Map<string, string>();
    for (const row of firstBuyRows) {
      if (row.fundCode && row._min.date) {
        firstBuyMap.set(row.fundCode, row._min.date.toISOString().slice(0, 10));
      }
    }
    // 清仓时间（最后赎回的日期）
    const clearedDateRows = await prisma.txRecord.groupBy({
      by: ["fundCode"],
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundSubtype: { in: ["redeem"] },
        accountId: accountId,
        deletedAt: null,
      },
      _max: { date: true },
    });
    const clearedDateMap = new Map<string, string>();
    for (const row of clearedDateRows) {
      if (row.fundCode && row._max.date) {
        clearedDateMap.set(row.fundCode, row._max.date.toISOString().slice(0, 10));
      }
    }
    // 申购金额和回收金额：只统计清仓日期之前的交易
    // 回收金额 = 赎回到账 + 现金分红到账，和清仓收益保持同一现金流口径
    const clearedTxRows = await prisma.txRecord.findMany({
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        OR: [
          { toAccountId: accountId, fundSubtype: "buy" },
          { accountId: accountId, fundSubtype: { in: ["redeem", "dividend_cash"] } },
        ],
        deletedAt: null,
      },
      select: { fundCode: true, fundSubtype: true, amount: true, fundArrivalAmount: true, date: true },
    });
    const buyAmountMap = new Map<string, number>();
    const redeemAmountMap = new Map<string, number>();
    for (const row of clearedTxRows) {
      if (!row.fundCode) continue;
      const clearedDate = clearedDateMap.get(row.fundCode);
      const txDate = row.date.toISOString().slice(0, 10);
      if (clearedDate && txDate > clearedDate) continue;
      if (row.fundSubtype === "buy") {
        buyAmountMap.set(row.fundCode, (buyAmountMap.get(row.fundCode) ?? 0) + Math.abs(toNumber(row.amount)));
      } else {
        const arrival = toNumber(row.fundArrivalAmount ?? 0);
        const amt = Math.abs(toNumber(row.amount));
        redeemAmountMap.set(row.fundCode, (redeemAmountMap.get(row.fundCode) ?? 0) + (arrival > 0 ? arrival : amt));
      }
    }
    for (const c of clearedPositions) {
      c.totalInvested = investedMap.get(c.fundCode) ?? 0;
      c.firstBuyDate = firstBuyMap.get(c.fundCode) ?? "";
      c.clearedDate = clearedDateMap.get(c.fundCode) ?? "";
      c.totalBuyAmount = buyAmountMap.get(c.fundCode) ?? 0;
      c.totalRedeemAmount = redeemAmountMap.get(c.fundCode) ?? 0;
      c.historicalProfit = c.totalRedeemAmount - c.totalBuyAmount;
      c.returnRate = c.totalInvested > 0 ? c.historicalProfit / c.totalInvested : 0;
    }
  }

  const totalMarketValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const totalCost = positions.reduce((s, p) => s + p.cost, 0);
  const totalHistoricalProfit =
    positions.reduce((s, p) => s + p.historicalProfit, 0) +
    clearedPositions.reduce((s, c) => s + c.historicalProfit, 0);

  return { positions, clearedPositions, totalMarketValue, totalCost, totalHistoricalProfit };
},
);
