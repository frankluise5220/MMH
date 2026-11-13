"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

export type MonthlyCashFlowItem = {
  /** `YYYY-MM`，直接当 X 轴刻度用：跨年也不会歧义，省掉一套月份名的 i18n。 */
  month: string;
  income: number;
  expense: number;
};

function CashFlowTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-lg">
      <div className="mb-1 font-medium text-slate-700">{label}</div>
      {payload.map((item: any, index: number) => (
        <div key={`${item.name}-${index}`} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: item.color }} />
          <span className="text-slate-500">{item.name}:</span>
          <span className="font-medium tabular-nums">{formatMoney(Number(item.value ?? 0))}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 近 12 个月收支柱形图。桌面与移动端共用：
 * - `compact` 给手机：刻度只留 `MM`，12 个格子才挤得下；
 * - `masked` 跟随移动端的「隐藏金额」开关，直接不画柱子（否则眼睛图标点了仍会露金额）。
 */
export function MonthlyCashFlowChart({
  rows,
  isRedUp,
  compact = false,
  masked = false,
}: {
  rows: MonthlyCashFlowItem[];
  isRedUp: boolean;
  compact?: boolean;
  masked?: boolean;
}) {
  const { t } = useI18n();
  const height = compact ? 180 : 220;
  const incomeColor = isRedUp ? "#dc2626" : "#10b981";
  const expenseColor = isRedUp ? "#10b981" : "#dc2626";
  const compactTick = (value: number) =>
    Math.abs(value) >= 10000 ? `${(value / 10000).toFixed(1)}${t("common.compactUnit")}` : String(Math.round(value));

  if (masked) {
    return (
      <div className="flex items-center justify-center text-xs tabular-nums text-slate-400" style={{ height }}>
        ****
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-slate-400" style={{ height }}>
        {t("table.empty")}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={compact ? (value: string) => String(value).slice(5) : undefined}
          interval={compact ? 0 : "preserveStartEnd"}
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
          tickMargin={6}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#94a3b8" }}
          axisLine={false}
          tickLine={false}
          width={52}
          tickFormatter={compactTick}
        />
        <Tooltip content={<CashFlowTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {/* barGap 收窄同月「支出/收入」两根柱的缝；柱子放到接近类目带宽，
            月份与月份之间才不会留出一条宽白带（Recharts 会按带宽自动收缩）。 */}
        <Bar dataKey="income" name={t("stats.income")} fill={incomeColor} radius={[3, 3, 0, 0]} maxBarSize={compact ? 12 : 24} />
        <Bar dataKey="expense" name={t("stats.expense")} fill={expenseColor} radius={[3, 3, 0, 0]} maxBarSize={compact ? 12 : 24} />
      </BarChart>
    </ResponsiveContainer>
  );
}
