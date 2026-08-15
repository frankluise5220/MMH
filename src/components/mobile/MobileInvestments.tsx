"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, TrendingUp } from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
  const [hideZero, setHideZero] = useState(true);
  const visibleRows = useMemo(
    () => hideZero
      ? rows.filter((row) => Math.abs(row.marketValue) >= 0.005 || Math.abs(row.totalCost) >= 0.005 || Math.abs(row.floatingPnL) >= 0.005)
      : rows,
    [hideZero, rows],
  );

  const pnlClass = (value: number) => pnlClassFromRedUp(value, isRedUp, "softDark");

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-slate-200 bg-slate-50/96 px-2 backdrop-blur">
        <MobileTab href="/investments" label={t("overview.investmentOverview")} active />
        <MobileTab href="/regular-invest" label={t("mobileInvestments.regularInvest")} />
      </div>

      <div className="space-y-2.5 px-3 py-2 pb-4">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-white shadow-sm">
          <div className="text-sm font-medium text-indigo-100">{t("mobileInvestments.totalMarketValue")}</div>
          <div className="mt-1 break-all text-[26px] font-bold tabular-nums">{formatMoneyYuan(total)}</div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/15 pt-3">
            <div>
              <div className="text-[11px] text-indigo-200">{t("overview.holdingCost")}</div>
              <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{formatMoneyYuan(totalCost)}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-indigo-200">{t("overview.floatingPnL")}</div>
              <div className="mt-0.5 truncate text-sm font-semibold tabular-nums">{formatMoneyYuan(totalFloatingPnL)}</div>
            </div>
          </div>
        </section>

        <div className="flex min-h-11 items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-slate-900">{t("invest.productTypeDefault")}</h2>
          <button type="button" onClick={() => setHideZero((current) => !current)} className="h-10 px-2 text-xs font-medium text-indigo-600">
            {t(hideZero ? "mobileInvestments.showZero" : "mobileInvestments.hideZero")}
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
                <InvestmentMetric label={t("mobileInvestments.cost")} value={formatMoneyYuan(row.totalCost)} />
                <InvestmentMetric label={t("invest.colMarketValue")} value={formatMoneyYuan(row.marketValue)} />
                <InvestmentMetric label={t("stats.pnl")} value={formatMoneyYuan(row.floatingPnL)} className={pnlClass(row.floatingPnL)} />
              </div>
            </Link>
          ))}
          {visibleRows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">{t("invest.noAccounts")}</div>
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
