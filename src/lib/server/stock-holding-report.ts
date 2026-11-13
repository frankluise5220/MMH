import { accountRenderSettings, buildAccountDisplayOption } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import type { HouseholdContext } from "@/lib/server/household-scope";

export type StockHoldingReportRow = {
  id: string;
  accountId: string;
  /** 按「账户显示格式」渲染好的标签（含机构），不是数据库裸名。 */
  accountName: string;
  /** 调用方（按当前请求的 cookie 设置）重渲染后的标签，优先于 `accountName`。 */
  accountLabel?: string;
  /** 行内看不到的信息（机构/币种/卡号），作为列 hover。 */
  accountHoverTitle: string;
  securityId: string;
  market: string;
  stockCode: string;
  stockName: string;
  quantity: number;
  avgCost: number;
  cost: number;
  latestPrice: number | null;
  latestPriceDate: string | null;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit: number;
  totalProfit: number;
  /**
   * 摊薄成本 = 剩余持仓成本 − 已实现盈亏（≈ 累计买入支出 − 累计卖出回款）。
   * 券商/同花顺默认的「摊薄成本」口径把已实现盈亏摊回剩余股数，
   * 所以它们的浮动盈亏等于本表的 totalProfit、浮亏率等于 totalPnLRate。
   */
  dilutedCost: number;
  totalPnLRate: number;
  currency: string;
};

export type StockHoldingReportTotals = {
  quantity: number;
  cost: number;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit: number;
  totalProfit: number;
  dilutedCost: number;
  totalPnLRate: number;
  holdingCount: number;
};

export type StockHoldingReport = {
  rows: StockHoldingReportRow[];
  totals: StockHoldingReportTotals;
};

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundQuantity(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export async function loadStockHoldingReport(
  ctx: HouseholdContext,
  options: { accountIds?: string[] } = {},
): Promise<StockHoldingReport> {
  const accountFilter = options.accountIds && options.accountIds.length > 0
    ? { id: { in: options.accountIds } }
    : {};
  const accounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      ...accountFilter,
      kind: "investment",
      investProductType: "stock",
      isActive: true,
      isPlaceholder: { not: true },
    },
    select: {
      id: true,
      name: true,
      currency: true,
      numberMasked: true,
      groupId: true,
      Institution: { select: { name: true, shortName: true } },
    },
    orderBy: [{ name: "asc" }],
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  // 非本位币要在标签/hover 里有出处：只传 fields 时币种会整条丢失。
  const baseCurrency = await getHouseholdBaseCurrency(ctx.householdId);
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) {
    return {
      rows: [],
      totals: {
        quantity: 0,
        cost: 0,
        marketValue: 0,
        floatingPnL: 0,
        floatingPnLRate: 0,
        historicalProfit: 0,
        totalProfit: 0,
        dilutedCost: 0,
        totalPnLRate: 0,
        holdingCount: 0,
      },
    };
  }

  const holdings = await prisma.stockHolding.findMany({
    where: {
      householdId: ctx.householdId,
      accountId: { in: accountIds },
      quantity: { gt: 0 },
    },
    orderBy: [{ market: "asc" }, { stockCode: "asc" }],
    include: { StockSecurity: { select: { stockName: true } } },
  });

  const rows = holdings
    .map((item) => {
      const account = accountById.get(item.accountId);
      const accountDisplay = buildAccountDisplayOption({
        id: item.accountId,
        name: account?.name ?? item.accountId,
        kind: "investment",
        numberMasked: account?.numberMasked,
        currency: account?.currency,
        groupId: account?.groupId,
        Institution: account?.Institution,
        // 这里在 unstable_cache 里跑，读不到 cookie（账户显示格式），只能按默认字段渲染；
        // 报表页会用当前请求的设置重新渲染 accountLabel/accountHoverTitle 覆盖。
      }, undefined, accountRenderSettings(undefined, baseCurrency));
      const quantity = roundQuantity(toNumber(item.quantity));
      const cost = roundMoney(toNumber(item.cost));
      const marketValue = roundMoney(toNumber(item.marketValue));
      const floatingPnL = roundMoney(marketValue - cost);
      const historicalProfit = roundMoney(toNumber(item.historicalProfit));
      const totalProfit = roundMoney(floatingPnL + historicalProfit);
      // 摊薄成本把已实现盈亏摊回剩余股数：亏损时成本更高、盈利时成本更低（甚至为负）。
      // 券商的「浮动盈亏」正是这个口径（= 本表的综合盈亏），故另给一列便于核对。
      const dilutedCost = roundMoney(cost - historicalProfit);
      return {
        id: item.id,
        accountId: item.accountId,
        accountName: accountDisplay.listLabel,
        accountHoverTitle: accountDisplay.tableHoverTitle,
        securityId: item.securityId,
        market: item.market,
        stockCode: item.stockCode,
        // 名字优先认 StockSecurity；持仓行的 stockName 是历史快照，仅资料库缺行时兜底。
        stockName: item.StockSecurity?.stockName?.trim() || item.stockName?.trim() || item.stockCode,
        quantity,
        avgCost: toNumber(item.avgCost),
        cost,
        latestPrice: item.latestPrice == null ? null : toNumber(item.latestPrice),
        latestPriceDate: item.latestPriceDate ? item.latestPriceDate.toISOString().slice(0, 10) : null,
        marketValue,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        historicalProfit,
        totalProfit,
        dilutedCost,
        // 摊薄成本 ≤ 0 时（已回本）比例没有意义，保持 0 而不是 Infinity。
        totalPnLRate: dilutedCost > 0 ? totalProfit / dilutedCost : 0,
        currency: account?.currency || "CNY",
      };
    })
    .sort((left, right) => {
      if (right.marketValue !== left.marketValue) return right.marketValue - left.marketValue;
      return left.stockCode.localeCompare(right.stockCode) || left.accountName.localeCompare(right.accountName, "zh-Hans-CN");
    });

  const totals = rows.reduce(
    (sum, row) => ({
      quantity: roundQuantity(sum.quantity + row.quantity),
      cost: roundMoney(sum.cost + row.cost),
      marketValue: roundMoney(sum.marketValue + row.marketValue),
      floatingPnL: roundMoney(sum.floatingPnL + row.floatingPnL),
      floatingPnLRate: 0,
      historicalProfit: roundMoney(sum.historicalProfit + row.historicalProfit),
      totalProfit: roundMoney(sum.totalProfit + row.totalProfit),
      dilutedCost: roundMoney(sum.dilutedCost + row.dilutedCost),
      totalPnLRate: 0,
      holdingCount: sum.holdingCount + 1,
    }),
    {
      quantity: 0,
      cost: 0,
      marketValue: 0,
      floatingPnL: 0,
      floatingPnLRate: 0,
      historicalProfit: 0,
      totalProfit: 0,
      dilutedCost: 0,
      totalPnLRate: 0,
      holdingCount: 0,
    },
  );
  totals.floatingPnLRate = totals.cost > 0 ? totals.floatingPnL / totals.cost : 0;
  totals.totalPnLRate = totals.dilutedCost > 0 ? totals.totalProfit / totals.dilutedCost : 0;

  return { rows, totals };
}
