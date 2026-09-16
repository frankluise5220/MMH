"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import {
  applyAssetCurveIncludes,
  DEFAULT_ASSET_CURVE_INCLUDES,
  type AssetCurveIncludes,
} from "@/lib/asset-curve-includes";

export type AssetFlowPoint = {
  /** YYYY-MM */
  month: string;
  /** Month-end net assets (assets − liabilities), fixed assets at cost price */
  netAssetCost: number;
  /** Month-end net assets (assets − liabilities), fixed assets at market valuation */
  netAssetMarketValue: number;
  insurance: number;
  propertyCost: number;
  propertyMarket: number;
  settlement: number;
  /** Month income (same basis as the monthly bars) */
  income: number;
  /** Month expense */
  expense: number;
  investPnL?: number;
  netTotal?: number;
};

type Props = {
  points: AssetFlowPoint[];
  isRedUp: boolean;
};

const ASSET_COST_COLOR = "#64748b";
const ASSET_MARKET_COLOR = "#3b82f6";
const NET_COLOR = "#3b82f6";
const STORAGE_KEY = "mmh:stats:assetCurveIncludes";

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

function readStoredIncludes(): AssetCurveIncludes {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ASSET_CURVE_INCLUDES;
    const parsed = JSON.parse(raw) as Partial<AssetCurveIncludes>;
    return {
      insurance: parsed.insurance !== false,
      property: parsed.property !== false,
      settlement: parsed.settlement !== false,
    };
  } catch {
    return DEFAULT_ASSET_CURVE_INCLUDES;
  }
}

/**
 * Merged 资金 / 资产 block for /statistics:
 *   - 资金: monthly income/expense bars (same time range as the page filter)
 *   - 资产: month-end net-asset curves, with checkboxes to drop insurance /
 *     fixed assets / 往来款 from the totals
 */
export default function AssetFlowStatisticsTable({ points, isRedUp }: Props) {
  const { t } = useI18n();
  const incomeColor = isRedUp ? "#dc2626" : "#10b981";
  const expenseColor = isRedUp ? "#10b981" : "#dc2626";
  const [includes, setIncludes] = useState<AssetCurveIncludes>(DEFAULT_ASSET_CURVE_INCLUDES);

  useEffect(() => {
    setIncludes(readStoredIncludes());
  }, []);

  function toggleInclude(key: keyof AssetCurveIncludes) {
    setIncludes((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota / private-mode failures
      }
      return next;
    });
  }

  const cashPoints = useMemo(
    () => points.map((point) => ({
      month: point.month,
      income: point.income,
      expense: point.expense,
      netTotal: point.netTotal ?? (point.income - point.expense + (point.investPnL ?? 0)),
    })),
    [points],
  );

  const assetPoints = useMemo(
    () => points.map((point) => {
      const adjusted = applyAssetCurveIncludes(point, includes);
      return {
        month: point.month,
        netAssetCost: adjusted.netAssetCost,
        netAssetMarketValue: adjusted.netAssetMarketValue,
      };
    }),
    [points, includes],
  );

  if (points.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">{t("stats.assetFlow.title")}</div>
        </div>
        <p className="px-4 py-8 text-xs text-slate-400 text-center">{t("stats.assetFlow.empty")}</p>
      </div>
    );
  }

  const includeOptions: Array<{ key: keyof AssetCurveIncludes; label: string }> = [
    { key: "insurance", label: t("stats.assetFlow.includeInsurance") },
    { key: "property", label: t("stats.assetFlow.includeProperty") },
    { key: "settlement", label: t("stats.assetFlow.includeSettlement") },
  ];

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
        <div className="text-sm font-semibold text-slate-800">{t("stats.assetFlow.title")}</div>
        <p className="mt-1 text-[11px] leading-4 text-slate-400">{t("stats.assetFlow.note")}</p>
      </div>

      <div className="p-3 border-b border-slate-100">
        <div className="text-xs font-semibold text-slate-600 mb-2">{t("stats.monthlyIncomeExpense")}</div>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={cashPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis
              dataKey="month"
              tickFormatter={(value: string) => value.slice(5)}
              tick={{ fontSize: 11, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => compactTick(v, t("common.compactUnit"))}
              tick={{ fontSize: 11, fill: "#64748b" }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip content={<FlowTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="income" name={t("stats.income")} fill={incomeColor} radius={[3, 3, 0, 0]} barSize={16} />
            <Bar dataKey="expense" name={t("stats.expense")} fill={expenseColor} radius={[3, 3, 0, 0]} barSize={16} />
            <Line type="monotone" dataKey="netTotal" name={t("stats.totalPnL")} stroke={NET_COLOR} strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="p-3">
        <div className="text-xs font-semibold text-slate-600 mb-2">{t("stats.assetFlow.assetTitle")}</div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={assetPoints} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="month"
                tickFormatter={(value: string) => value.slice(5)}
                tick={{ fontSize: 11, fill: "#64748b" }}
                tickLine={false}
                axisLine={{ stroke: "#e2e8f0" }}
              />
              <YAxis
                tickFormatter={(v: number) => compactTick(v, t("common.compactUnit"))}
                tick={{ fontSize: 11, fill: "#64748b" }}
                tickLine={false}
                axisLine={false}
                width={56}
              />
              <Tooltip content={<FlowTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line
                type="monotone"
                dataKey="netAssetMarketValue"
                name={t("stats.assetFlow.assetMarketValue")}
                stroke={ASSET_MARKET_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="netAssetCost"
                name={t("stats.assetFlow.assetCost")}
                stroke={ASSET_COST_COLOR}
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                activeDot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {includeOptions.map((option) => (
            <label key={option.key} className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-slate-300"
                checked={includes[option.key]}
                onChange={() => toggleInclude(option.key)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
