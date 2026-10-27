"use client";

import { useMemo } from "react";
import { formatCurrencyMoney, formatMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import type {
  StockHoldingReportRow,
  StockHoldingReportTotals,
} from "@/lib/server/stock-holding-report";
import { stockMarketLabel } from "@/lib/stock/market";
import { useI18n } from "@/lib/i18n";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSummaryRow } from "@/components/AdvancedDataTable";

type Props = {
  rows: StockHoldingReportRow[];
  totals: StockHoldingReportTotals;
  isRedUp: boolean;
};

function valueClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "muted");
}

function signedMoney(value: number, currency = "CNY") {
  return `${value > 0 ? "+" : ""}${formatCurrencyMoney(value, currency)}`;
}

function formatRate(value: number) {
  return formatPercent(value);
}

function compactDate(value: string | null) {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}.${date.slice(8, 10)}` : String(value ?? "");
}

/** 移动端卡片里的小指标格：label 一行 + 数值一行。 */
function MobileMetric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] leading-4 text-slate-500">{label}</div>
      <div className={`truncate text-xs font-medium leading-5 tabular-nums ${className ?? "text-slate-700"}`}>{value}</div>
    </div>
  );
}

function renderReportStockNameCode(row: StockHoldingReportRow) {
  const displayName = String(row.stockName || row.stockCode || "-").trim() || "-";
  const code = [stockMarketLabel(row.market), row.stockCode].filter(Boolean).join(" ");
  return (
    <div className="flex min-w-0 items-center gap-1.5" title={[displayName, code].filter(Boolean).join(" ")}>
      <span className="min-w-0 truncate font-medium text-slate-900">{displayName}</span>
      {code ? (
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] leading-none text-slate-500">
          {code}
        </span>
      ) : null}
    </div>
  );
}

export function StockHoldingReport({ rows, totals, isRedUp }: Props) {
  const currency = rows[0]?.currency || "CNY";
  const best = [...rows].sort((a, b) => b.totalProfit - a.totalProfit)[0] ?? null;
  const worst = [...rows].sort((a, b) => a.totalProfit - b.totalProfit)[0] ?? null;
  const { t } = useI18n();
  const stockReportDefaultSort = useMemo(() => ({ key: "marketValue", direction: "desc" as const }), []);
  const columns = useMemo<AdvancedDataTableColumn<StockHoldingReportRow>[]>(() => [
    {
      key: "stock",
      label: t("stockHoldingReport.colStock"),
      width: 190,
      minWidth: 150,
      headerClassName: "text-left",
      filterText: (row) => `${row.stockName} ${row.stockCode}`,
      filterSearchText: (row) => `${stockMarketLabel(row.market)} ${row.stockCode} ${row.stockName}`,
      sortValue: (row) => `${row.market}:${row.stockCode}:${row.stockName}`,
      render: renderReportStockNameCode,
    },
    {
      key: "account",
      label: t("stockHoldingReport.colAccount"),
      width: 160,
      minWidth: 120,
      headerClassName: "text-left",
      className: "text-slate-600",
      filterText: (row) => row.accountLabel ?? row.accountName,
      sortValue: (row) => row.accountLabel ?? row.accountName,
      render: (row) => (
        <span className="block truncate" title={row.accountHoverTitle || row.accountLabel || row.accountName}>
          {row.accountLabel ?? row.accountName}
        </span>
      ),
    },
    {
      key: "quantity",
      label: t("stockHoldingReport.colQuantity"),
      width: 92,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.quantity),
      sortValue: (row) => row.quantity,
      render: (row) => formatMoney(row.quantity),
    },
    {
      key: "avgCost",
      label: t("stockHoldingReport.colAvgCost"),
      width: 92,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.avgCost),
      sortValue: (row) => row.avgCost,
      render: (row) => formatMoney(row.avgCost),
    },
    {
      key: "cost",
      label: t("stockHoldingReport.colCost"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.cost),
      sortValue: (row) => row.cost,
      render: (row) => formatCurrencyMoney(row.cost, row.currency),
    },
    {
      key: "closePrice",
      label: t("stockHoldingReport.colClosePrice"),
      width: 120,
      minWidth: 96,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => row.latestPrice == null ? "-" : String(row.latestPrice),
      sortValue: (row) => row.latestPrice ?? null,
      render: (row) => (
        <>
          {row.latestPrice == null ? "-" : formatMoney(row.latestPrice)}
          {row.latestPriceDate ? <span className="ml-1 text-xs text-slate-400">({compactDate(row.latestPriceDate)})</span> : null}
        </>
      ),
    },
    {
      key: "marketValue",
      label: t("stockHoldingReport.colMarketValue"),
      width: 116,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.marketValue),
      sortValue: (row) => row.marketValue,
      render: (row) => formatCurrencyMoney(row.marketValue, row.currency),
    },
    {
      key: "floatingPnL",
      label: t("stockHoldingReport.colFloatingPnL"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.floatingPnL),
      sortValue: (row) => row.floatingPnL,
      render: (row) => <span className={valueClass(row.floatingPnL, isRedUp)}>{signedMoney(row.floatingPnL, row.currency)}</span>,
    },
    {
      key: "floatingPnLRate",
      label: t("stockHoldingReport.colFloatingPnLRate"),
      width: 104,
      minWidth: 82,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.floatingPnLRate),
      sortValue: (row) => row.floatingPnLRate,
      render: (row) => <span className={valueClass(row.floatingPnLRate, isRedUp)}>{formatRate(row.floatingPnLRate)}</span>,
    },
    {
      key: "historicalProfit",
      label: t("stockHoldingReport.colRealized"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.historicalProfit),
      sortValue: (row) => row.historicalProfit,
      render: (row) => <span className={valueClass(row.historicalProfit, isRedUp)}>{signedMoney(row.historicalProfit, row.currency)}</span>,
    },
    {
      key: "totalProfit",
      label: t("stockHoldingReport.colTotalPnL"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.totalProfit),
      sortValue: (row) => row.totalProfit,
      render: (row) => <span className={valueClass(row.totalProfit, isRedUp)}>{signedMoney(row.totalProfit, row.currency)}</span>,
    },
  ], [isRedUp, t]);
  const summaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (rows.length === 0) return undefined;
    return {
      cells: {
        stock: <span className="text-xs font-medium text-slate-700">{t("common.total")}</span>,
        quantity: <span className="tabular-nums text-xs text-slate-700">{formatMoney(totals.quantity)}</span>,
        cost: <span className="tabular-nums text-xs text-slate-700">{formatCurrencyMoney(totals.cost, currency)}</span>,
        marketValue: <span className="tabular-nums text-xs text-slate-700">{formatCurrencyMoney(totals.marketValue, currency)}</span>,
        floatingPnL: <span className={`tabular-nums text-xs ${valueClass(totals.floatingPnL, isRedUp)}`}>{signedMoney(totals.floatingPnL, currency)}</span>,
        floatingPnLRate: <span className={`tabular-nums text-xs ${valueClass(totals.floatingPnLRate, isRedUp)}`}>{formatRate(totals.floatingPnLRate)}</span>,
        historicalProfit: <span className={`tabular-nums text-xs ${valueClass(totals.historicalProfit, isRedUp)}`}>{signedMoney(totals.historicalProfit, currency)}</span>,
        totalProfit: <span className={`tabular-nums text-xs ${valueClass(totals.totalProfit, isRedUp)}`}>{signedMoney(totals.totalProfit, currency)}</span>,
      },
      rowClassName: "bg-slate-50",
      cellClassName: "text-xs",
    };
  }, [currency, isRedUp, rows.length, t, totals]);
  const emptyText = (
    <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
      <div className="text-sm font-medium text-slate-900">{t("stockHoldingReport.empty")}</div>
      <div className="mt-2 max-w-md text-xs leading-5 text-slate-500">
        {t("stockHoldingReport.emptyDesc")}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { key: "marketValue", labelKey: "stockHoldingReport.summary.marketValue", value: formatCurrencyMoney(totals.marketValue, currency), className: "text-slate-800" },
          { key: "cost", labelKey: "stockHoldingReport.summary.cost", value: formatCurrencyMoney(totals.cost, currency), className: "text-slate-800" },
          { key: "floatingPnL", labelKey: "stockHoldingReport.summary.floatingPnL", value: signedMoney(totals.floatingPnL, currency), className: valueClass(totals.floatingPnL, isRedUp) },
          { key: "realizedProfit", labelKey: "stockHoldingReport.summary.realizedProfit", value: signedMoney(totals.historicalProfit, currency), className: valueClass(totals.historicalProfit, isRedUp) },
          { key: "holdingCount", labelKey: "stockHoldingReport.summary.holdingCount", value: String(totals.holdingCount), className: "text-slate-800" },
        ].map((item) => (
          <div key={item.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-[11px] text-slate-500">{t(item.labelKey)}</div>
            <div className={`mt-1 text-base font-semibold tabular-nums ${item.className}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-2 border-b border-slate-100 px-3 py-2">
          <div className="shrink-0 whitespace-nowrap text-sm font-medium text-slate-800">{t("stockHoldingReport.title")}</div>
          <div className="min-w-0 text-xs text-slate-500">
            {best
              ? t("stockHoldingReport.bestHolding")
                  .replace("{name}", best.stockName)
                  .replace("{amount}", signedMoney(best.totalProfit, best.currency))
              : t("stockHoldingReport.noHoldings")}
            {worst && worst.id !== best?.id
              ? ` · ${t("stockHoldingReport.worstHolding")
                  .replace("{name}", worst.stockName)
                  .replace("{amount}", signedMoney(worst.totalProfit, worst.currency))}`
              : ""}
          </div>
        </div>
        {/* 移动端：持仓卡片（11 列表格 minTableWidth=1280，手机横向滚看不清） */}
        {rows.length === 0 ? (
          <div className="md:hidden">{emptyText}</div>
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto md:hidden">
            {rows.map((row) => (
              <div key={row.id} className="px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  {renderReportStockNameCode(row)}
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                    {formatCurrencyMoney(row.marketValue, row.currency)}
                  </span>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-slate-500">
                  <span className="min-w-0 truncate" title={row.accountHoverTitle || row.accountLabel || row.accountName}>
                    {row.accountLabel ?? row.accountName}
                  </span>
                  <span className="shrink-0 text-slate-300">·</span>
                  <span className="shrink-0 tabular-nums">
                    {formatMoney(row.quantity)} × {formatMoney(row.avgCost)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                  <MobileMetric label={t("stockHoldingReport.colCost")} value={formatCurrencyMoney(row.cost, row.currency)} className="text-slate-700" />
                  <MobileMetric label={t("stockHoldingReport.colClosePrice")} value={row.latestPrice == null ? "-" : `${formatMoney(row.latestPrice)}${row.latestPriceDate ? ` (${compactDate(row.latestPriceDate)})` : ""}`} className="text-slate-700" />
                  <MobileMetric
                    label={t("stockHoldingReport.colFloatingPnL")}
                    value={`${signedMoney(row.floatingPnL, row.currency)} (${formatRate(row.floatingPnLRate)})`}
                    className={valueClass(row.floatingPnL, isRedUp)}
                  />
                  <MobileMetric label={t("stockHoldingReport.colRealized")} value={signedMoney(row.historicalProfit, row.currency)} className={valueClass(row.historicalProfit, isRedUp)} />
                  <MobileMetric label={t("stockHoldingReport.colTotalPnL")} value={signedMoney(row.totalProfit, row.currency)} className={valueClass(row.totalProfit, isRedUp)} />
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between bg-slate-50 px-3 py-2.5">
              <span className="text-xs font-semibold text-slate-700">{t("common.total")}</span>
              <span className={`text-sm font-semibold tabular-nums ${valueClass(totals.totalProfit, isRedUp)}`}>{signedMoney(totals.totalProfit, currency)}</span>
            </div>
          </div>
        )}
        <div className="hidden min-h-0 flex-1 md:block">
          <AdvancedDataTable
            storageKey="mmh_stock_holding_report_v1"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            emptyText={emptyText}
            minTableWidth={1280}
            rowClassName={() => "hover:bg-slate-50"}
            showFilters={false}
            fillHeight
            toolbarMode="none"
            draggableRows={false}
            defaultSort={stockReportDefaultSort}
            summaryRow={summaryRow}
          />
        </div>
      </div>
    </div>
  );
}
