"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pencil, RefreshCcw, Trash2 } from "lucide-react";

import { formatCurrencyMoney, formatMoney } from "@/lib/format";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";
import { StockFeeRuleSettingsButton } from "@/components/StockFeeRuleSettingsButton";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";

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
  stockAccountId?: string;
  cashAccountId?: string | null;
  securityId?: string | null;
  market?: string | null;
  stockCode: string;
  stockName?: string | null;
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
  totalMarketValue,
  totalCost,
  isRedUp,
  stockCashAccountId,
  stockCashAccountName,
}: {
  accountId: string;
  accountLabel: string;
  currency: string;
  positions: StockPosition[];
  cashBalance: number;
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
  stockCashAccountId?: string;
  stockCashAccountName?: string | null;
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [detailPage, setDetailPage] = useState(1);
  const [detailPageSize, setDetailPageSize] = useState(20);
  const [detailTableRowCount, setDetailTableRowCount] = useState(0);

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
      setSelectedIds(new Set());
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
    setSelectedIds(new Set());
    setDetailPage(1);
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

  useEffect(() => {
    function onEditSaved() {
      if (!selectedPosition) return;
      void loadTransactions(selectedPosition);
    }
    window.addEventListener("mmh:stock:edit:success", onEditSaved);
    return () => window.removeEventListener("mmh:stock:edit:success", onEditSaved);
  }, [loadTransactions, selectedPosition]);

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

  const deleteTransaction = useCallback(async (id: string) => {
    if (!id || deletingIds.has(id)) return;
    setDeletingIds((prev) => new Set(prev).add(id));
    setDeleteMessage("");
    try {
      const res = await fetch(`/api/v1/stocks/transactions?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "删除股票交易失败");
      setTransactions((prev) => prev.filter((tx) => tx.id !== id));
      setDeleteMessage("已删除该股票交易");
      dispatchFinanceDataChanged({ reason: "stock-transaction-delete", accountIds: [accountId] });
      if (selectedPosition) void loadTransactions(selectedPosition);
    } catch (error) {
      setDeleteMessage(error instanceof Error ? error.message : "删除股票交易失败");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [accountId, deletingIds, loadTransactions, selectedPosition]);

  async function applyBatchDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || batchDeleting) return;
    const ok = window.confirm(`确认删除已勾选 ${ids.length} 条股票交易？删除后会同时删除关联资金流水并重算持仓。`);
    if (!ok) return;
    setBatchDeleting(true);
    setDeleteMessage("");
    try {
      let deleted = 0;
      for (const id of ids) {
        const res = await fetch(`/api/v1/stocks/transactions?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
          cache: "no-store",
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (res.ok && data?.ok) deleted += 1;
      }
      setTransactions((prev) => prev.filter((tx) => !selectedIds.has(tx.id)));
      setSelectedIds(new Set());
      setDeleteMessage(`已删除 ${deleted} 条股票交易`);
      dispatchFinanceDataChanged({ reason: "stock-transaction-batch-delete", accountIds: [accountId] });
      if (selectedPosition) void loadTransactions(selectedPosition);
    } catch {
      setDeleteMessage("批量删除失败");
    } finally {
      setBatchDeleting(false);
    }
  }

  const batchTargetIds = useMemo(
    () => Array.from(selectedIds).filter((id) => transactions.some((tx) => tx.id === id)),
    [selectedIds, transactions],
  );

  const batchFields = useMemo<BatchReplaceFieldConfig<"note" | "brokerTradeId">[]>(() => [
    { value: "note", label: "备注", kind: "text", placeholder: "输入替换内容，可留空清除备注", allowEmpty: true },
    { value: "brokerTradeId", label: "券商成交号", kind: "text", placeholder: "输入替换内容，可留空清除", allowEmpty: true },
  ], []);

  async function applyBatch(field: "note" | "brokerTradeId", value: string) {
    const ids = batchTargetIds;
    if (ids.length === 0) throw new Error("请先勾选记录");
    const updates = ids.map((id) => ({ id, [field]: value }));
    const res = await fetch("/api/v1/stocks/transactions/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "批量修改失败" })) as { ok?: boolean; error?: string; data?: { updatedCount?: number } } | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error ?? "批量修改失败");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    dispatchFinanceDataChanged({ reason: "stock-transaction-batch-update", accountIds: [accountId] });
    if (selectedPosition) void loadTransactions(selectedPosition);
    return `已修改 ${data.data?.updatedCount ?? ids.length} 条记录`;
  }

  const detailTotalPages = Math.max(1, Math.ceil(detailTableRowCount / detailPageSize));
  const detailSafePage = Math.min(detailPage, detailTotalPages);
  const allDetailPageSize = Math.max(1, detailTableRowCount);

  const positionColumns = useMemo<AdvancedDataTableColumn<StockPosition>[]>(() => [
    {
      key: "stock",
      label: "股票",
      width: 220,
      minWidth: 140,
      headerClassName: "text-left",
      className: "px-4",
      sortValue: (p) => `${p.stockCode} ${p.name}`,
      render: (p) => {
        const active = positionKey(p) === selectedKey;
        return (
          <div className="min-w-0">
            <div className={`truncate text-xs font-medium ${active ? "text-blue-700" : "text-slate-700"}`} title={p.name}>
              {p.name}
            </div>
            <div className="truncate text-[11px] text-slate-400">{p.stockCode}</div>
          </div>
        );
      },
    },
    {
      key: "units",
      label: "数量",
      width: 100,
      minWidth: 72,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.units),
      filterNumber: (p) => p.units,
      sortValue: (p) => p.units,
      render: (p) => <span className="text-xs text-slate-700">{formatMoney(p.units)}</span>,
    },
    {
      key: "avgCost",
      label: "成本价",
      width: 100,
      minWidth: 72,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.avgCost),
      filterNumber: (p) => p.avgCost,
      sortValue: (p) => p.avgCost,
      render: (p) => <span className="text-xs text-slate-700">{p.avgCost.toFixed(4)}</span>,
    },
    {
      key: "cost",
      label: "成本",
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.cost),
      filterNumber: (p) => p.cost,
      sortValue: (p) => p.cost,
      render: (p) => <span className="text-xs text-slate-700">{formatCurrencyMoney(p.cost, currency)}</span>,
    },
    {
      key: "nav",
      label: "收盘价",
      width: 110,
      minWidth: 84,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => (p.nav == null ? null : String(p.nav)),
      filterNumber: (p) => p.nav ?? null,
      sortValue: (p) => p.nav ?? null,
      render: (p) => (
        <span className="text-xs text-slate-700">{p.nav == null ? <span className="text-slate-300">-</span> : p.nav.toFixed(4)}</span>
      ),
    },
    {
      key: "marketValue",
      label: "市值",
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.marketValue),
      filterNumber: (p) => p.marketValue,
      sortValue: (p) => p.marketValue,
      render: (p) => <span className={`text-xs ${pnlClass(p.marketValue, isRedUp)}`}>{formatCurrencyMoney(p.marketValue, currency)}</span>,
    },
    {
      key: "floatingPnL",
      label: "浮动盈亏",
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.floatingPnL),
      filterNumber: (p) => p.floatingPnL,
      sortValue: (p) => p.floatingPnL,
      render: (p) => <span className={`text-xs ${pnlClass(p.floatingPnL, isRedUp)}`}>{formatCurrencyMoney(p.floatingPnL, currency)}</span>,
    },
    {
      key: "floatingRate",
      label: "浮盈率",
      width: 88,
      minWidth: 64,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.floatingPnLRate),
      filterNumber: (p) => p.floatingPnLRate,
      sortValue: (p) => p.floatingPnLRate,
      render: (p) => <span className={`text-xs ${pnlClass(p.floatingPnLRate, isRedUp)}`}>{(p.floatingPnLRate * 100).toFixed(2)}%</span>,
    },
    {
      key: "historical",
      label: "历史收益",
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.historicalProfit ?? 0),
      filterNumber: (p) => p.historicalProfit ?? 0,
      sortValue: (p) => p.historicalProfit ?? 0,
      render: (p) => (
        <span className={`text-xs ${pnlClass(p.historicalProfit ?? 0, isRedUp)}`}>
          {formatCurrencyMoney(p.historicalProfit ?? 0, currency)}
        </span>
      ),
    },
  ], [currency, isRedUp, selectedKey]);

  const positionSummaryRow = useMemo(() => {
    if (positions.length === 0) return undefined;
    const totalFloating = marketValue - cost;
    const totalHistorical = positions.reduce((sum, p) => sum + (p.historicalProfit ?? 0), 0);
    return {
      cells: {
        stock: "汇总",
        units: <span className="tabular-nums text-slate-800">{positions.length} 只</span>,
        cost: <span className="tabular-nums text-slate-800">{formatCurrencyMoney(cost, currency)}</span>,
        marketValue: <span className={`tabular-nums ${pnlClass(marketValue, isRedUp)}`}>{formatCurrencyMoney(marketValue, currency)}</span>,
        floatingPnL: <span className={`tabular-nums ${pnlClass(totalFloating, isRedUp)}`}>{formatCurrencyMoney(totalFloating, currency)}</span>,
        floatingRate: <span className={`tabular-nums ${pnlClass(cost !== 0 ? totalFloating / cost : 0, isRedUp)}`}>{cost !== 0 ? `${((totalFloating / cost) * 100).toFixed(2)}%` : "-"}</span>,
        historical: <span className={`tabular-nums ${pnlClass(totalHistorical, isRedUp)}`}>{formatCurrencyMoney(totalHistorical, currency)}</span>,
      },
    };
  }, [cost, currency, isRedUp, marketValue, positions]);

  const transactionColumns = useMemo<AdvancedDataTableColumn<StockTransaction>[]>(() => {
    const numberFilterText = (value: number | null | undefined) =>
      value == null || !Number.isFinite(value) ? null : String(value);
    return [
      {
        key: "tradeDate",
        label: "日期",
        width: 112,
        minWidth: 96,
        filterKind: "dateRange",
        filterText: (tx) => tx.tradeDate || "",
        sortValue: (tx) => tx.tradeDate || null,
        render: (tx) => <span className="tabular-nums text-xs text-slate-600">{tx.tradeDate}</span>,
      },
      {
        key: "action",
        label: "动作",
        width: 88,
        minWidth: 72,
        filterText: (tx) => actionLabel(tx.action),
        sortValue: (tx) => actionLabel(tx.action),
        render: (tx) => <span className="text-xs text-slate-700">{actionLabel(tx.action)}</span>,
      },
      {
        key: "quantity",
        label: "数量",
        width: 104,
        minWidth: 84,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(tx.quantity == null ? null : Number(tx.quantity)),
        filterNumber: (tx) => (tx.quantity == null ? null : Number(tx.quantity)),
        sortValue: (tx) => (tx.quantity == null ? null : Number(tx.quantity)),
        render: (tx) => (
          <span className="whitespace-nowrap tabular-nums text-xs text-slate-700">
            {tx.quantity == null ? <span className="text-slate-300">-</span> : formatMoney(Number(tx.quantity))}
          </span>
        ),
      },
      {
        key: "price",
        label: "价格",
        width: 100,
        minWidth: 80,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(tx.price == null ? null : Number(tx.price)),
        filterNumber: (tx) => (tx.price == null ? null : Number(tx.price)),
        sortValue: (tx) => (tx.price == null ? null : Number(tx.price)),
        render: (tx) => (
          <span className="whitespace-nowrap tabular-nums text-xs text-slate-700">
            {tx.price == null ? <span className="text-slate-300">-</span> : Number(tx.price).toFixed(4)}
          </span>
        ),
      },
      {
        key: "grossAmount",
        label: "成交金额",
        width: 120,
        minWidth: 92,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(Math.abs(Number(tx.grossAmount ?? 0))),
        filterNumber: (tx) => Math.abs(Number(tx.grossAmount ?? 0)),
        sortValue: (tx) => Math.abs(Number(tx.grossAmount ?? 0)),
        render: (tx) => <span className="tabular-nums text-xs text-slate-700">{formatCurrencyMoney(Number(tx.grossAmount ?? 0), currency)}</span>,
      },
      {
        key: "fee",
        label: "费用",
        width: 96,
        minWidth: 76,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(totalFee(tx)),
        filterNumber: (tx) => totalFee(tx),
        sortValue: (tx) => totalFee(tx),
        render: (tx) => <span className="tabular-nums text-xs text-slate-600">{formatCurrencyMoney(totalFee(tx), currency)}</span>,
      },
      {
        key: "cash",
        label: "资金流",
        width: 120,
        minWidth: 92,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(cashAmount(tx)),
        filterNumber: (tx) => cashAmount(tx),
        sortValue: (tx) => cashAmount(tx),
        render: (tx) => (
          <span className={`tabular-nums text-xs ${pnlClass(cashAmount(tx), isRedUp)}`}>{formatCurrencyMoney(cashAmount(tx), currency)}</span>
        ),
      },
      {
        key: "realized",
        label: "已实现",
        width: 110,
        minWidth: 84,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(tx.realizedProfit == null ? null : Number(tx.realizedProfit)),
        filterNumber: (tx) => (tx.realizedProfit == null ? null : Number(tx.realizedProfit)),
        sortValue: (tx) => (tx.realizedProfit == null ? null : Number(tx.realizedProfit)),
        render: (tx) => (
          <span className={`tabular-nums text-xs ${pnlClass(Number(tx.realizedProfit ?? 0), isRedUp)}`}>
            {tx.realizedProfit == null ? <span className="text-slate-300">-</span> : formatCurrencyMoney(Number(tx.realizedProfit), currency)}
          </span>
        ),
      },
      {
        key: "note",
        label: "备注",
        width: 180,
        minWidth: 110,
        filterKind: "text",
        filterText: (tx) => String(tx.note ?? tx.brokerTradeId ?? "").trim(),
        sortValue: (tx) => String(tx.note ?? "").trim() || null,
        truncate: true,
        cellTitle: (tx) => String(tx.note ?? tx.brokerTradeId ?? "").trim(),
        render: (tx) => {
          const note = String(tx.note ?? tx.brokerTradeId ?? "").trim();
          return note ? <span className="text-xs text-slate-600">{note}</span> : <span className="text-slate-300">-</span>;
        },
      },
    ];
  }, [currency, isRedUp]);

  const openEditTransaction = useCallback((tx: StockTransaction) => {
    window.dispatchEvent(new CustomEvent("mmh:stock:edit", {
      detail: {
        requestId: `edit-${tx.id}`,
        transaction: {
          id: tx.id,
          stockAccountId: tx.stockAccountId ?? accountId,
          cashAccountId: tx.cashAccountId ?? null,
          securityId: tx.securityId ?? null,
          market: tx.market ?? "",
          stockCode: tx.stockCode,
          stockName: tx.stockName ?? null,
          action: tx.action,
          tradeDate: tx.tradeDate,
          settleDate: tx.settleDate ?? null,
          grossAmount: tx.grossAmount == null ? null : Number(tx.grossAmount),
          netAmount: tx.netAmount == null ? null : Number(tx.netAmount),
          quantity: tx.quantity == null ? null : Number(tx.quantity),
          price: tx.price == null ? null : Number(tx.price),
          brokerTradeId: tx.brokerTradeId ?? null,
          note: tx.note ?? null,
        },
      },
    }));
  }, [accountId]);

  const transactionRowActions = useCallback((tx: StockTransaction) => {
    const deleting = deletingIds.has(tx.id);
    return (
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => openEditTransaction(tx)}
          className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
          title="编辑该股票交易"
          aria-label="编辑该股票交易"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { void deleteTransaction(tx.id); }}
          disabled={deleting}
          className="flex h-7 w-7 items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
          title={deleting ? "删除中..." : "删除该股票交易"}
          aria-label={deleting ? "删除中..." : "删除该股票交易"}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }, [deleteTransaction, deletingIds, openEditTransaction]);

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
                  className="secondary-button h-9 w-9 justify-center px-0 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  title="获取当前持仓股票的最新收盘价"
                  aria-label="获取当前持仓股票的最新收盘价"
                >
                  <RefreshCcw className={`h-4 w-4 ${refreshingPrice ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("mmh:create-transaction:open", {
                      detail: {
                        requestId: `stock-transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                        source: "launcher",
                        item: { type: "transfer", remark: "银证转账" },
                        lockedType: "transfer",
                        stockTransferMode: true,
                        stockCashAccountId: stockCashAccountId ?? "",
                        stockCashAccountName: stockCashAccountName || "",
                        defaultFromAccountId: "",
                        defaultToAccountId: stockCashAccountId ?? "",
                      },
                    }));
                  }}
                  className="secondary-button h-9 px-2.5 text-xs"
                  title="银证转账：银行资金账户与当前股票机构证券资金账户互转"
                >
                  银证转账
                </button>
                {refreshMessage ? <span className="text-[11px] text-slate-500">{refreshMessage}</span> : null}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-6 text-right text-xs">
              <div>
                <div className="text-slate-500">证券现金</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{formatCurrencyMoney(cashBalance, currency)}</div>
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

        <div className="min-h-0 flex-1">
          <AdvancedDataTable
            storageKey="mmh_stock_shell_positions_advanced_v1"
            columns={positionColumns}
            rows={positions}
            rowKey={(p) => positionKey(p)}
            emptyText="暂无股票持仓"
            minTableWidth={900}
            rowClassName={(p) => {
              const active = positionKey(p) === selectedKey;
              return `cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
            }}
            onRowClick={(p) => void loadTransactions(p)}
            showFilters={false}
            fillHeight
            compactRows
            toolbarMode="none"
            draggableRows={false}
            defaultSort={{ key: "marketValue", direction: "desc" }}
            summaryRow={positionSummaryRow}
          />
        </div>
      </div>

      {selectedPosition ? (
        <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
            <div className="panel-header h-12 shrink-0">
              <div className="flex min-w-0 items-center gap-1 text-sm font-semibold text-slate-800">
                {batchTargetIds.length > 0 ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="shrink-0 text-xs font-medium tabular-nums text-blue-700">
                      已选 {batchTargetIds.length} 条
                    </span>
                    <BatchReplacePopoverButton
                      fields={batchFields}
                      targetCount={batchTargetIds.length}
                      targetLabel="已选"
                      buttonTitle="编辑"
                      buttonClassName="h-6 w-6 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"
                      onApply={applyBatch}
                    />
                    <button
                      type="button"
                      onClick={() => void applyBatchDelete()}
                      disabled={batchDeleting}
                      className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title="删除已选股票交易"
                      aria-label="删除已选股票交易"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <span className="mx-1 h-4 w-px bg-slate-200" />
                  </div>
                ) : null}
                <span className="shrink-0">交易明细</span>
                <span className="ml-2 truncate text-xs font-normal text-slate-500">{selectedPosition.name}</span>
                <span className="ml-2 text-xs font-normal text-slate-400">{transactions.length} 条</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                {deleteMessage ? <span className="text-[11px] text-slate-500">{deleteMessage}</span> : null}
                <div className="flex items-center gap-1">
                  <span className="text-slate-300">|</span>
                  {[10, 20, 40].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => { setDetailPageSize(n); setDetailPage(1); }}
                      className={`h-6 px-1.5 rounded border ${detailPageSize === n ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setDetailPageSize(allDetailPageSize); setDetailPage(1); }}
                    className={`h-6 px-1.5 rounded border ${detailPageSize === allDetailPageSize ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                  >
                    所有
                  </button>
                  <span className="text-slate-300">|</span>
                  {detailSafePage > 1 ? (<>
                    <button
                      type="button"
                      onClick={() => setDetailPage(1)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"
                    >
                      <ChevronsLeft className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetailPage(detailSafePage - 1)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                  </>) : (<>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronsLeft className="h-3 w-3" /></span>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronLeft className="h-3 w-3" /></span>
                  </>)}
                  <span className="text-slate-500 px-0.5">{detailSafePage}/{detailTotalPages}</span>
                  {detailSafePage < detailTotalPages ? (<>
                    <button
                      type="button"
                      onClick={() => setDetailPage(detailSafePage + 1)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetailPage(detailTotalPages)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"
                    >
                      <ChevronsRight className="h-3 w-3" />
                    </button>
                  </>) : (<>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronRight className="h-3 w-3" /></span>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronsRight className="h-3 w-3" /></span>
                  </>)}
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {transactionsLoading ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-slate-500">交易明细加载中...</div>
              ) : transactionsError ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-rose-600">{transactionsError}</div>
              ) : transactions.length === 0 ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-slate-500">暂无该股票交易明细</div>
              ) : (
                <AdvancedDataTable
                  storageKey="mmh_stock_shell_detail_advanced_table_v1"
                  resetKey={`${accountId}:${selectedPosition.stockCode}`}
                  columns={transactionColumns}
                  rows={transactions}
                  rowKey={(tx) => tx.id}
                  minTableWidth={1000}
                  emptyText="暂无该股票交易明细"
                  selectable
                  selectOnRowClick
                  selectAllScope="renderedRows"
                  selectedKeys={selectedIds}
                  onSelectionChange={setSelectedIds}
                  onRowDoubleClick={(tx) => openEditTransaction(tx)}
                  rowActions={transactionRowActions}
                  rowActionsWidth={88}
                  rowActionsMinWidth={72}
                  rowClassName={(tx) => (selectedIds.has(tx.id) ? "bg-blue-50/70 hover:bg-blue-50/70" : "hover:bg-blue-50/40")}
                  fillHeight
                  compactRows
                  toolbarMode="none"
                  showFilters
                  showColumnVisibilityButton={false}
                  sortable
                  defaultSort={{ key: "tradeDate", direction: "desc" }}
                  pagination={{
                    page: detailSafePage,
                    pageSize: detailPageSize,
                    onPageChange: setDetailPage,
                    onRowCountChange: setDetailTableRowCount,
                  }}
                />
              )}
            </div>
        </div>
      ) : null}
      </ResizableVerticalSplit>
    </div>
  );
}
