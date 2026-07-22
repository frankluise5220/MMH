"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, TrendingUp } from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";

type InvestmentRow = {
  id: string;
  label: string;
  hoverTitle?: string;
  productType: string;
  marketValue: number;
  totalCost: number;
  floatingPnL: number;
  floatingRate: number;
  href: string;
};

export function MobileInvestments({
  rows,
  total,
  totalCost,
  totalFloatingPnL,
  isRedUp,
}: {
  rows: InvestmentRow[];
  total: number;
  totalCost: number;
  totalFloatingPnL: number;
  isRedUp: boolean;
}) {
  const [hideZero, setHideZero] = useState(true);
  const visibleRows = useMemo(
    () => hideZero
      ? rows.filter((row) => Math.abs(row.marketValue) >= 0.005 || Math.abs(row.totalCost) >= 0.005 || Math.abs(row.floatingPnL) >= 0.005)
      : rows,
    [hideZero, rows],
  );

  const pnlClass = (value: number) => {
    if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
    if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
    return "text-slate-700";
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 grid grid-cols-3 border-b border-slate-200 bg-slate-50/96 px-2 backdrop-blur">
        <MobileTab href="/investments" label="投资总览" active />
        <MobileTab href="/funds" label="基金持仓" />
        <MobileTab href="/regular-invest" label="定投计划" />
      </div>

      <div className="space-y-2.5 px-3 py-2 pb-4">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-white shadow-sm">
          <div className="text-sm font-medium text-indigo-100">投资账户总市值</div>
          <div className="mt-1 break-all text-[26px] font-bold tabular-nums">{formatMoneyYuan(total)}</div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/15 pt-3">
            <div>
              <div className="text-[11px] text-indigo-200">持仓成本</div>
              <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{formatMoneyYuan(totalCost)}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-indigo-200">浮动盈亏</div>
              <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{formatMoneyYuan(totalFloatingPnL)}</div>
            </div>
          </div>
        </section>

        <div className="flex min-h-11 items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-slate-900">投资账户</h2>
          <button type="button" onClick={() => setHideZero((current) => !current)} className="h-10 px-2 text-xs font-medium text-indigo-600">
            {hideZero ? "显示零值" : "隐藏零值"}
          </button>
        </div>

        <div className="space-y-2">
          {visibleRows.map((row) => (
            <Link key={row.id} href={row.href} title={row.hoverTitle} className="block rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
              <div className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
                  <TrendingUp size={19} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900">{row.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{row.productType}</span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-slate-400" />
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                <InvestmentMetric label="成本" value={formatMoneyYuan(row.totalCost)} />
                <InvestmentMetric label="市值" value={formatMoneyYuan(row.marketValue)} />
                <InvestmentMetric label="盈亏" value={formatMoneyYuan(row.floatingPnL)} className={pnlClass(row.floatingPnL)} />
              </div>
            </Link>
          ))}
          {visibleRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">暂无投资账户</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MobileTab({ href, label, active = false }: { href: string; label: string; active?: boolean }) {
  return (
    <Link href={href} className={`flex h-11 items-center justify-center border-b-2 text-xs font-semibold ${active ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}>
      {label}
    </Link>
  );
}

function InvestmentMetric({ label, value, className = "text-slate-900" }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 truncate text-xs font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}
