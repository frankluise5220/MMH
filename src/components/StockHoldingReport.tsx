"use client";

import { formatCurrencyMoney, formatMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import type {
  StockHoldingReportRow,
  StockHoldingReportTotals,
} from "@/lib/server/stock-holding-report";
import { stockMarketLabel } from "@/lib/stock/market";
import { useI18n } from "@/lib/i18n";

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
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2">
          <div className="text-sm font-medium text-slate-800">{t("stockHoldingReport.title")}</div>
          <div className="text-xs text-slate-500">
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
        {rows.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="px-3 py-2 text-left font-medium">{t("stockHoldingReport.colStock")}</th>
                  <th className="px-3 py-2 text-left font-medium">{t("stockHoldingReport.colAccount")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colQuantity")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colAvgCost")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colCost")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colClosePrice")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colMarketValue")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colFloatingPnL")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colFloatingPnLRate")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colRealized")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("stockHoldingReport.colTotalPnL")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      {renderReportStockNameCode(row)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{row.accountName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.avgCost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(row.cost, row.currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.latestPrice == null ? "-" : formatMoney(row.latestPrice)}{row.latestPriceDate ? <span className="ml-1 text-xs text-slate-400">({compactDate(row.latestPriceDate)})</span> : null}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(row.marketValue, row.currency)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueClass(row.floatingPnL, isRedUp)}`}>
                      {signedMoney(row.floatingPnL, row.currency)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueClass(row.floatingPnLRate, isRedUp)}`}>
                      {formatRate(row.floatingPnLRate)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueClass(row.historicalProfit, isRedUp)}`}>
                      {signedMoney(row.historicalProfit, row.currency)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${valueClass(row.totalProfit, isRedUp)}`}>
                      {signedMoney(row.totalProfit, row.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0 bg-slate-50">
                <tr>
                  <td className="px-3 py-2 text-xs font-medium text-slate-700" colSpan={2}>{t("common.total")}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-700">{formatMoney(totals.quantity)}</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-700">{formatCurrencyMoney(totals.cost, currency)}</td>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-700">{formatCurrencyMoney(totals.marketValue, currency)}</td>
                  <td className={`px-3 py-2 text-right text-xs tabular-nums ${valueClass(totals.floatingPnL, isRedUp)}`}>
                    {signedMoney(totals.floatingPnL, currency)}
                  </td>
                  <td className={`px-3 py-2 text-right text-xs tabular-nums ${valueClass(totals.floatingPnLRate, isRedUp)}`}>
                    {formatRate(totals.floatingPnLRate)}
                  </td>
                  <td className={`px-3 py-2 text-right text-xs tabular-nums ${valueClass(totals.historicalProfit, isRedUp)}`}>
                    {signedMoney(totals.historicalProfit, currency)}
                  </td>
                  <td className={`px-3 py-2 text-right text-xs tabular-nums ${valueClass(totals.totalProfit, isRedUp)}`}>
                    {signedMoney(totals.totalProfit, currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="flex min-h-[260px] flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="text-sm font-medium text-slate-900">{t("stockHoldingReport.empty")}</div>
            <div className="mt-2 max-w-md text-xs leading-5 text-slate-500">
              {t("stockHoldingReport.emptyDesc")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
