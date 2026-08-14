"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCcw } from "lucide-react";

import { formatCurrencyMoney, formatMoney } from "@/lib/format";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";
import { StockFeeRuleSettingsButton } from "@/components/StockFeeRuleSettingsButton";

type StockPosition = {
  stockCode: string;
  market?: string | null;
  securityId?: string | null;
  name: string;
  units: number;
  avgCost: number;
  cost: number;
  nav: number | null;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit?: number;
};

type StockTransaction = {
  id: string;
  tradeDate: string;
  settleDate?: string | null;
  action: string;
  quantity?: number | null;
  price?: number | null;
  grossAmount?: number | null;
  netAmount?: number | null;
  fee?: number | null;
  commission?: number | null;
  stampTax?: number | null;
  transferFee?: number | null;
  exchangeFee?: number | null;
  regulatoryFee?: number | null;
  otherFee?: number | null;
  realizedProfit?: number | null;
  brokerTradeId?: string | null;
  note?: string | null;
};

type RefreshPriceHolding = {
  securityId?: string | null;
  market: string;
  stockCode: string;
  stockName?: string | null;
  quantity: number;
  avgCost: number;
  cost: number;
  latestPrice?: number | null;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit?: number;
};

type RefreshPriceResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    refreshed?: number;
    failed?: Array<{ stockCode?: string; error?: string }>;
    holdings?: RefreshPriceHolding[];
    totalMarketValue?: number;
    totalCost?: number;
  };
};

type StockTransactionsResponse = {
  ok?: boolean;
  error?: string;
  data?: { transactions?: StockTransaction[] };
};

function pnlClass(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
  if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
  return "text-slate-600";
}

function positionKey(position: StockPosition) {
  return position.securityId || `${position.market ?? ""}:${position.stockCode}`;
}

function actionLabel(action: string) {
  if (action === "buy") return "买入";
  if (action === "sell") return "卖出";
  if (action === "dividend") return "分红";
  if (action === "bonus_share") return "送股";
  if (action === "split_share") return "拆股";
  if (action === "merge_share") return "并股";
  if (action === "fee_adjustment") return "费用调整";
  if (action === "tax_adjustment") return "税费调整";
  return action || "-";
}

function totalFee(tx: StockTransaction) {
  return (
    Number(tx.fee ?? 0) +
    Number(tx.commission ?? 0) +
    Number(tx.stampTax ?? 0) +
    Number(tx.transferFee ?? 0) +
    Number(tx.exchangeFee ?? 0) +
    Number(tx.regulatoryFee ?? 0) +
    Number(tx.otherFee ?? 0)
  );
}

function cashAmount(tx: StockTransaction) {
  const gross = Math.abs(Number(tx.grossAmount ?? 0));
  const net = tx.netAmount == null ? null : Math.abs(Number(tx.netAmount));
  const fees = totalFee(tx);
  if (tx.action === "buy") return -(gross + fees);
  if (tx.action === "sell" || tx.action === "dividend") return net ?? Math.max(0, gross - fees);
  if (tx.action === "fee_adjustment" || tx.action === "tax_adjustment") return -(net ?? gross);
  return 0;
}

function mapApiHolding(item: RefreshPriceHolding): StockPosition {
  return {
    stockCode: item.stockCode,
    market: item.market,
    securityId: item.securityId ?? undefined,
    name: item.stockName || item.stockCode,
    units: Number(item.quantity ?? 0),
    avgCost: Number(item.avgCost ?? 0),
    cost: Number(item.cost ?? 0),
    nav: item.latestPrice == null ? null : Number(item.latestPrice),
    marketValue: Number(item.marketValue ?? 0),
    floatingPnL: Number(item.floatingPnL ?? 0),
    floatingPnLRate: Number(item.floatingPnLRate ?? 0),
    historicalProfit: Number(item.historicalProfit ?? 0),
  };
}

export function StockHoldingsPanel({
  accountId,
  accountLabel,
  currency,
  positions: initialPositions,
  cashBalance,
  cashAccountName,
  totalMarketValue,
  totalCost,
  isRedUp,
}: {
  accountId: string;
  accountLabel: string;
  currency: string;
  positions: StockPosition[];
  cashBalance: number;
  cashAccountName?: string | null;
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
}) {
  const [positions, setPositions] = useState<StockPosition[]>(initialPositions);
  const [marketValue, setMarketValue] = useState(totalMarketValue);
  const [cost, setCost] = useState(totalCost);
  const [selectedKey, setSelectedKey] = useState("");
  const [transactions, setTransactions] = useState<StockTransaction[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState("");
  const [refreshingPrice, setRefreshingPrice] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");

  useEffect(() => {
    setPositions(initialPositions);
    setMarketValue(totalMarketValue);
    setCost(totalCost);
  }, [initialPositions, totalCost, totalMarketValue]);

  const selectedPosition = useMemo(
    () => positions.find((position) => positionKey(position) === selectedKey) ?? null,
    [positions, selectedKey],
  );

  useEffect(() => {
    if (selectedKey && !selectedPosition) {
      setSelectedKey("");
      setTransactions([]);
    }
  }, [selectedKey, selectedPosition]);

  const floatingPnL = marketValue - cost;
  const assetValue = marketValue + cashBalance;

  const loadTransactions = useCallback(async (position: StockPosition) => {
    const market = position.market ?? "";
    const stockCode = position.stockCode;
    if (!stockCode) return;
    setSelectedKey(positionKey(position));
    setTransactionsLoading(true);
    setTransactionsError("");
    try {
      const params = new URLSearchParams({
        accountId,
        stockCode,
        limit: "200",
      });
      if (market) params.set("market", market);
      const res = await fetch(`/api/v1/stocks/transactions?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as StockTransactionsResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "股票交易明细加载失败");
      setTransactions(data.data?.transactions ?? []);
    } catch (error) {
      setTransactions([]);
      setTransactionsError(error instanceof Error ? error.message : "股票交易明细加载失败");
    } finally {
      setTransactionsLoading(false);
    }
  }, [accountId]);

  async function refreshClosingPrices() {
    if (positions.length === 0 || refreshingPrice) return;
    setRefreshingPrice(true);
    setRefreshMessage("");
    try {
      const res = await fetch("/api/v1/stocks/prices/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => null) as RefreshPriceResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "获取收盘价失败");
      if (Array.isArray(data.data?.holdings)) {
        setPositions(data.data.holdings.map(mapApiHolding));
        setMarketValue(Number(data.data.totalMarketValue ?? 0));
        setCost(Number(data.data.totalCost ?? 0));
      }
      const refreshed = Number(data.data?.refreshed ?? 0);
      const failedCount = data.data?.failed?.length ?? 0;
      if (refreshed > 0) {
        dispatchFinanceDataChanged({ reason: "stock-price-refresh", accountIds: [accountId] });
      }
      setRefreshMessage(failedCount > 0 ? `已获取 ${refreshed} 个，${failedCount} 个失败` : `已获取 ${refreshed} 个收盘价`);
    } catch (error) {
      setRefreshMessage(error instanceof Error ? error.message : "获取收盘价失败");
    } finally {
      setRefreshingPrice(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey={`mmh:stock-shell:${accountId}:split-height`}
        hasLowerPane={Boolean(selectedPosition)}
        defaultUpperHeight={360}
        separatorLabel="调整股票持仓和明细高度"
        separatorTitle="拖动调整股票持仓和明细高度"
        stackOnMobile
      >
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-slate-200 px-4 py-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="text-xs text-slate-500">股票账户</div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">{accountLabel}</h2>
                <StockFeeRuleSettingsButton accountId={accountId} accountLabel={accountLabel} currency={currency} />
                <button
                  type="button"
                  onClick={() => void refreshClosingPrices()}
                  disabled={refreshingPrice || positions.length === 0}
                  className="secondary-button h-8 gap-1 px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  title="获取当前持仓股票的最新收盘价"
                >
                  <RefreshCcw className={`h-3.5 w-3.5 ${refreshingPrice ? "animate-spin" : ""}`} />
                  获取收盘价
                </button>
                {refreshMessage ? <span className="text-[11px] text-slate-500">{refreshMessage}</span> : null}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-6 text-right text-xs">
              <div>
                <div className="text-slate-500">证券现金</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCurrencyMoney(cashBalance, currency)}</div>
                {cashAccountName ? <div className="mt-0.5 max-w-[9rem] truncate text-[11px] text-slate-400">{cashAccountName}</div> : null}
              </div>
              <div>
                <div className="text-slate-500">持仓市值</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCurrencyMoney(marketValue, currency)}</div>
              </div>
              <div>
                <div className="text-slate-500">总资产</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCurrencyMoney(assetValue, currency)}</div>
              </div>
              <div>
                <div className="text-slate-500">浮动盈亏</div>
                <div className={`mt-1 text-sm font-semibold tabular-nums ${pnlClass(floatingPnL, isRedUp)}`}>
                  {formatCurrencyMoney(floatingPnL, currency)}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {positions.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="px-4 py-2 text-left font-medium">股票</th>
                  <th className="px-3 py-2 text-right font-medium">数量</th>
                  <th className="px-3 py-2 text-right font-medium">成本价</th>
                  <th className="px-3 py-2 text-right font-medium">成本</th>
                  <th className="px-3 py-2 text-right font-medium">收盘价</th>
                  <th className="px-3 py-2 text-right font-medium">市值</th>
                  <th className="px-4 py-2 text-right font-medium">浮动盈亏</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => {
                  const active = positionKey(position) === selectedKey;
                  return (
                    <tr
                      key={positionKey(position)}
                      onClick={() => void loadTransactions(position)}
                      className={`cursor-pointer border-b border-slate-100 ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
                    >
                      <td className="px-4 py-2">
                        <div className={`font-medium ${active ? "text-blue-700" : "text-slate-900"}`}>{position.name}</div>
                        <div className="text-xs text-slate-500">{position.stockCode}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(position.units)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(position.avgCost)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(position.cost, currency)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{position.nav == null ? "-" : formatMoney(position.nav)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(position.marketValue, currency)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${pnlClass(position.floatingPnL, isRedUp)}`}>
                        {formatCurrencyMoney(position.floatingPnL, currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-6 text-center">
              <div className="text-sm font-medium text-slate-900">暂无股票持仓</div>
              <div className="mt-2 max-w-md text-xs leading-5 text-slate-500">
                买入股票后会形成独立 StockHolding；收盘价刷新后会更新持仓市值。
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedPosition ? (
        <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2">
              <div className="min-w-0 text-sm font-semibold text-slate-800">
                交易明细
                {selectedPosition ? <span className="ml-2 text-xs font-normal text-slate-500">{selectedPosition.name}</span> : null}
              </div>
              {selectedPosition ? <div className="text-xs text-slate-400">{transactions.length} 条</div> : null}
            </div>
            <div className="h-[calc(100%-41px)] overflow-auto">
              {!selectedPosition ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-slate-500">点击上方某只股票持仓查看交易明细</div>
              ) : transactionsLoading ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-slate-500">交易明细加载中...</div>
              ) : transactionsError ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-rose-600">{transactionsError}</div>
              ) : transactions.length === 0 ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-slate-500">暂无该股票交易明细</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
                    <tr className="border-b border-slate-200">
                      <th className="px-4 py-2 text-left font-medium">日期</th>
                      <th className="px-3 py-2 text-left font-medium">动作</th>
                      <th className="px-3 py-2 text-right font-medium">数量</th>
                      <th className="px-3 py-2 text-right font-medium">价格</th>
                      <th className="px-3 py-2 text-right font-medium">成交金额</th>
                      <th className="px-3 py-2 text-right font-medium">费用</th>
                      <th className="px-3 py-2 text-right font-medium">资金流</th>
                      <th className="px-3 py-2 text-right font-medium">已实现</th>
                      <th className="px-4 py-2 text-left font-medium">备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((tx) => {
                      const cash = cashAmount(tx);
                      const realized = Number(tx.realizedProfit ?? 0);
                      return (
                        <tr key={tx.id} className="border-b border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-2 tabular-nums text-slate-600">{tx.tradeDate}</td>
                          <td className="px-3 py-2 text-slate-700">{actionLabel(tx.action)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{tx.quantity == null ? "-" : formatMoney(Number(tx.quantity))}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{tx.price == null ? "-" : formatMoney(Number(tx.price))}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(Number(tx.grossAmount ?? 0), currency)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(totalFee(tx), currency)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${pnlClass(cash, isRedUp)}`}>{formatCurrencyMoney(cash, currency)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${pnlClass(realized, isRedUp)}`}>{tx.realizedProfit == null ? "-" : formatCurrencyMoney(realized, currency)}</td>
                          <td className="max-w-[14rem] truncate px-4 py-2 text-slate-500" title={tx.note ?? tx.brokerTradeId ?? ""}>
                            {tx.note || tx.brokerTradeId || "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
        </div>
      ) : null}
      </ResizableVerticalSplit>
    </div>
  );
}
