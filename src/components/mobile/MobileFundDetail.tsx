"use client";

import Link from "next/link";
import { ArrowLeft, CalendarDays, TrendingUp } from "lucide-react";
import { formatMoneyYuan } from "@/lib/format";

type FundEntry = {
  id: string;
  date: string;
  subtype: string;
  amount: number;
  units: number | null;
  note: string;
};

export function MobileFundDetail({
  accountLabel,
  fundCode,
  fundName,
  cost,
  marketValue,
  floatingPnL,
  floatingPnLRate,
  entries,
  isRedUp,
}: {
  accountLabel: string;
  fundCode: string;
  fundName: string;
  cost: number;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  entries: FundEntry[];
  isRedUp: boolean;
}) {
  const pnlClass = floatingPnL > 0 ? (isRedUp ? "text-red-600" : "text-emerald-600") : floatingPnL < 0 ? (isRedUp ? "text-emerald-600" : "text-red-600") : "text-slate-900";

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-slate-200 bg-slate-50/95 px-3 backdrop-blur">
        <Link href="/funds" className="flex h-10 w-10 items-center justify-center text-slate-500" aria-label="返回基金持仓"><ArrowLeft size={19} /></Link>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{fundName || fundCode}</div>
          <div className="truncate text-[11px] text-slate-500">{accountLabel} · {fundCode}</div>
        </div>
      </div>
      <div className="space-y-3 px-3 py-3 pb-6">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-white shadow-sm">
          <div className="flex items-center gap-2 text-sm text-indigo-100"><TrendingUp size={17} />当前市值</div>
          <div className="mt-1 break-all text-[28px] font-bold tabular-nums">{formatMoneyYuan(marketValue)}</div>
          <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/15 pt-3">
            <Metric label="持仓成本" value={formatMoneyYuan(cost)} />
            <Metric label="浮动盈亏" value={formatMoneyYuan(floatingPnL)} valueClass={floatingPnL < 0 ? "text-emerald-200" : "text-rose-200"} />
            <Metric label="浮盈率" value={`${floatingPnLRate >= 0 ? "+" : ""}${(floatingPnLRate * 100).toFixed(2)}%`} alignRight />
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex h-11 items-center justify-between border-b border-slate-100 px-3">
            <h2 className="text-sm font-semibold text-slate-900">交易记录</h2>
            <span className={`text-xs font-semibold tabular-nums ${pnlClass}`}>{formatMoneyYuan(floatingPnL)}</span>
          </div>
          <div className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <div key={entry.id} className="grid min-h-16 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><span className="text-sm font-medium text-slate-900">{subtypeLabel(entry.subtype)}</span><span className="text-xs text-slate-500">{entry.date}</span></div>
                  <div className="mt-1 truncate text-xs text-slate-500">{entry.note || fundCode}</div>
                </div>
                <div className="text-right"><div className="text-sm font-semibold tabular-nums text-slate-900">{formatMoneyYuan(entry.amount)}</div><div className="mt-1 text-[11px] tabular-nums text-slate-500">{entry.units == null ? "-" : `${entry.units.toFixed(2)} 份`}</div></div>
              </div>
            ))}
            {entries.length === 0 ? <div className="px-4 py-10 text-center text-sm text-slate-500">暂无交易记录</div> : null}
          </div>
        </section>
        <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400"><CalendarDays size={14} />显示最近 {entries.length} 条记录</div>
      </div>
    </div>
  );
}

function Metric({ label, value, valueClass = "text-white", alignRight = false }: { label: string; value: string; valueClass?: string; alignRight?: boolean }) {
  return <div className={`min-w-0 ${alignRight ? "text-right" : ""}`}><div className="text-[11px] text-indigo-200">{label}</div><div className={`mt-1 truncate text-xs font-semibold tabular-nums ${valueClass}`}>{value}</div></div>;
}

function subtypeLabel(value: string) {
  if (value === "buy") return "买入";
  if (value === "redeem") return "赎回";
  if (value === "dividend_cash") return "现金分红";
  if (value === "dividend_reinvest") return "红利再投";
  if (value === "switch_in") return "转换转入";
  if (value === "switch_out") return "转换转出";
  return value || "基金交易";
}
