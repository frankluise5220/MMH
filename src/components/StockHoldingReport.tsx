import { formatCurrencyMoney, formatMoney } from "@/lib/format";
import type {
  StockHoldingReportRow,
  StockHoldingReportTotals,
} from "@/lib/server/stock-holding-report";
import { stockMarketLabel } from "@/lib/stock/market";

type Props = {
  rows: StockHoldingReportRow[];
  totals: StockHoldingReportTotals;
  isRedUp: boolean;
};

function valueClass(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-700";
  if (value < 0) return isRedUp ? "text-emerald-700" : "text-red-600";
  return "text-slate-500";
}

function signedMoney(value: number, currency = "CNY") {
  return `${value > 0 ? "+" : ""}${formatCurrencyMoney(value, currency)}`;
}

function formatRate(value: number) {
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

export function StockHoldingReport({ rows, totals, isRedUp }: Props) {
  const currency = rows[0]?.currency || "CNY";
  const best = [...rows].sort((a, b) => b.totalProfit - a.totalProfit)[0] ?? null;
  const worst = [...rows].sort((a, b) => a.totalProfit - b.totalProfit)[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: "持仓市值", value: formatCurrencyMoney(totals.marketValue, currency), className: "text-slate-800" },
          { label: "持仓成本", value: formatCurrencyMoney(totals.cost, currency), className: "text-slate-800" },
          { label: "浮动盈亏", value: signedMoney(totals.floatingPnL, currency), className: valueClass(totals.floatingPnL, isRedUp) },
          { label: "已实现收益", value: signedMoney(totals.historicalProfit, currency), className: valueClass(totals.historicalProfit, isRedUp) },
          { label: "持仓只数", value: String(totals.holdingCount), className: "text-slate-800" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-[11px] text-slate-500">{item.label}</div>
            <div className={`mt-1 text-base font-semibold tabular-nums ${item.className}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2">
          <div className="text-sm font-medium text-slate-800">股票持仓盈亏</div>
          <div className="text-xs text-slate-500">
            {best ? `最高 ${best.stockName} ${signedMoney(best.totalProfit, best.currency)}` : "暂无持仓"}
            {worst && worst.id !== best?.id ? ` · 最低 ${worst.stockName} ${signedMoney(worst.totalProfit, worst.currency)}` : ""}
          </div>
        </div>
        {rows.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs text-slate-500">
                <tr className="border-b border-slate-200">
                  <th className="px-3 py-2 text-left font-medium">股票</th>
                  <th className="px-3 py-2 text-left font-medium">账户</th>
                  <th className="px-3 py-2 text-right font-medium">数量</th>
                  <th className="px-3 py-2 text-right font-medium">成本价</th>
                  <th className="px-3 py-2 text-right font-medium">成本</th>
                  <th className="px-3 py-2 text-right font-medium">收盘价</th>
                  <th className="px-3 py-2 text-right font-medium">市值</th>
                  <th className="px-3 py-2 text-right font-medium">浮动盈亏</th>
                  <th className="px-3 py-2 text-right font-medium">浮盈率</th>
                  <th className="px-3 py-2 text-right font-medium">已实现</th>
                  <th className="px-3 py-2 text-right font-medium">综合盈亏</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900">{row.stockName}</div>
                      <div className="text-xs text-slate-500">{stockMarketLabel(row.market)} {row.stockCode}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">{row.accountName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.quantity)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.avgCost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrencyMoney(row.cost, row.currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.latestPrice == null ? "-" : formatMoney(row.latestPrice)}</td>
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
                  <td className="px-3 py-2 text-xs font-medium text-slate-700" colSpan={2}>合计</td>
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
            <div className="text-sm font-medium text-slate-900">暂无股票持仓</div>
            <div className="mt-2 max-w-md text-xs leading-5 text-slate-500">
              股票买入后会写入独立 StockHolding。市值、浮动盈亏和已实现收益都来自股票持仓重算，不从基金字段推断。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
