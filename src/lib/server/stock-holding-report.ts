import { buildAccountDisplayOption } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import type { HouseholdContext } from "@/lib/server/household-scope";

export type StockHoldingReportRow = {
  id: string;
  accountId: string;
  /** 按「账户显示格式」渲染好的标签（含机构），不是数据库裸名。 */
  accountName: string;
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
      }, undefined, { baseCurrency });
      const quantity = roundQuantity(toNumber(item.quantity));
      const cost = roundMoney(toNumber(item.cost));
      const marketValue = roundMoney(toNumber(item.marketValue));
      const floatingPnL = roundMoney(marketValue - cost);
      const historicalProfit = roundMoney(toNumber(item.historicalProfit));
      return {
        id: item.id,
        accountId: item.accountId,
        accountName: accountDisplay.listLabel,
        accountHoverTitle: accountDisplay.tableHoverTitle,
        securityId: item.securityId,
        market: item.market,
        stockCode: item.stockCode,
        stockName: item.stockName?.trim() || item.stockCode,
        quantity,
        avgCost: toNumber(item.avgCost),
        cost,
        latestPrice: item.latestPrice == null ? null : toNumber(item.latestPrice),
        latestPriceDate: item.latestPriceDate ? item.latestPriceDate.toISOString().slice(0, 10) : null,
        marketValue,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        historicalProfit,
        totalProfit: roundMoney(floatingPnL + historicalProfit),
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
      holdingCount: 0,
    },
  );
  totals.floatingPnLRate = totals.cost > 0 ? totals.floatingPnL / totals.cost : 0;

  return { rows, totals };
}
