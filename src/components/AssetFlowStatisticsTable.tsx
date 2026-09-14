"use client";

import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

export type AssetFlowPoint = {
  /** YYYY-MM */
  month: string;
  /** Month-end net assets (assets − liabilities), fixed assets at cost price */
  netAssetCost: number;
  /** Month-end net assets (assets − liabilities), fixed assets at market valuation */
  netAssetMarketValue: number;
  /** Month income (same basis as the monthly bars above) */
  income: number;
  /** Month expense */
  expense: number;
};

type Props = {
  points: AssetFlowPoint[];
  isRedUp: boolean;
};

const ASSET_COST_COLOR = "#64748b";      // slate-500
const ASSET_MARKET_COLOR = "#3b82f6";    // blue-500

function compactTick(v: number, unit: string) {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(0)}${unit}`;
  return String(Math.round(v));
}

function FlowTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs">
      <div className="font-medium text-slate-700 mb-1">{label}</div>
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="tabular-nums font-medium">{formatMoney(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 资金统计表 — month-end net assets (cost basis vs market value) alongside
 * the month's income and expense. Data comes from the RSC prefetch on the
 * statistics page; income/expense reuse the exact monthly aggregation that
 * feeds the existing charts on this page.
 */
export default function AssetFlowStatisticsTable({ points, isRedUp }: Props) {
  const { t } = useI18n();
  const incomeColor = isRedUp ? "#dc2626" : "#10b981";
  const expenseColor = isRedUp ? "#10b981" : "#dc2626";

  if (points.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-slate-700">{t("stats.assetFlow.title")}</h2>
        <p className="mt-1 text-[11px] text-slate-400">{t("stats.assetFlow.empty")}</p>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-slate-700">{t("stats.assetFlow.title")}</h2>
      <p className="mt-1 text-[11px] leading-4 text-slate-400">{t("stats.assetFlow.note")}</p>

      {points.length >= 2 && (
        <div className="mt-3 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(value: string) => value.slice(5)}
                tick={{ fontSize: 11, fill: "#64748b" }}
                tickLine={false}
                axisLine={{ stroke: "#e2e8f0" }}
              />
              <YAxis
                yAxisId="assets"
                tickFormatter={(v: number) => compactTick(v, t("common.compactUnit"))}
                tick={{ fontSize: 11, fill: "#64748b" }}
                tickLine={false}
                axisLine={false}
                width={56}
              />
              <YAxis
                yAxisId="flows"
                orientation="right"
                tickFormatter={(v: number) => compactTick(v, t("common.compactUnit"))}
                tick={{ fontSize: 11, fill: "#94a3b8" }}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip content={<FlowTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                yAxisId="assets"
                type="monotone"
                dataKey="netAssetMarketValue"
                name={t("stats.assetFlow.assetMarketValue")}
                stroke={ASSET_MARKET_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
              <Line
                yAxisId="assets"
                type="monotone"
                dataKey="netAssetCost"
                name={t("stats.assetFlow.assetCost")}
                stroke={ASSET_COST_COLOR}
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                activeDot={{ r: 3 }}
              />
              <Line
                yAxisId="flows"
                type="monotone"
                dataKey="income"
                name={t("stats.assetFlow.income")}
                stroke={incomeColor}
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                yAxisId="flows"
                type="monotone"
                dataKey="expense"
                name={t("stats.assetFlow.expense")}
                stroke={expenseColor}
                strokeWidth={1.5}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
