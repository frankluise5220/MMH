"use client";

import Link from "next/link";
import { Shield } from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";

export type InsuranceOverviewCategoryRow = {
  key: string;
  label: string;
  premium: number;
  coverage: number;
  productCount: number;
};

export type InsuranceOverviewPersonRow = {
  insuredPersonKey: string;
  insuredPersonId: string | null;
  insuredPersonName: string;
  premium: number;
  coverage: number;
  productCount: number;
  categories: InsuranceOverviewCategoryRow[];
};

export type InsuranceOverview = {
  productCount: number;
  insuredPersonCount: number;
  totalPremium: number;
  totalCoverage: number;
  categoryRows: InsuranceOverviewCategoryRow[];
  personRows: InsuranceOverviewPersonRow[];
};

export function InsuranceOverviewCard({
  className = "panel-surface",
  insuranceOverview,
  isRedUp,
}: {
  className?: string;
  insuranceOverview?: InsuranceOverview | null;
  isRedUp: boolean;
}) {
  const insuranceRows = insuranceOverview?.personRows ?? [];
  const categoryRows = insuranceOverview?.categoryRows ?? [];

  return (
    <div className={`${className} overflow-hidden`}>
      <div className="panel-header">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Shield className="h-4 w-4 text-cyan-500" />
          保险概览
        </div>
        <Link href="/insurance" className="text-xs text-blue-600 hover:text-blue-800">查看保险</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 px-4 py-4">
        <MetricCard label="被保险人数" value={insuranceOverview ? `${insuranceOverview.insuredPersonCount} 人` : "0 人"} />
        <MetricCard label="保险产品" value={insuranceOverview ? `${insuranceOverview.productCount} 个` : "0 个"} />
        <MetricCard label="投保金额" value={formatMoneyYuan(insuranceOverview?.totalPremium ?? 0)} valueClass={directionalClass(-(insuranceOverview?.totalPremium ?? 0), isRedUp)} />
        <MetricCard label="保额" value={formatMoneyYuan(insuranceOverview?.totalCoverage ?? 0)} />
      </div>
      <div className="grid grid-cols-1 gap-2 px-4 pb-4">
        {categoryRows.length > 0 ? (
          categoryRows.map((item) => (
            <div key={item.key} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-700">{item.label}</div>
                <div className="text-[11px] text-slate-400">{item.productCount} 个产品</div>
              </div>
              <div className="text-right text-xs font-semibold tabular-nums">
                <div className={directionalClass(-item.premium, isRedUp)}>{formatMoneyYuan(item.premium)}</div>
                <div className="text-[10px] font-normal text-slate-400">{formatMoneyYuan(item.coverage)}</div>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-400">
            暂无保险数据
          </div>
        )}
      </div>
      <div className="divide-y divide-slate-100 border-t border-slate-100">
        {insuranceRows.length > 0 ? insuranceRows.slice(0, 6).map((person) => (
          <div key={person.insuredPersonKey} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">{person.insuredPersonName}</div>
                <div className="mt-1 text-[11px] text-slate-400">{person.productCount} 个产品</div>
              </div>
              <div className="text-right text-xs font-semibold tabular-nums">
                <div className={directionalClass(-person.premium, isRedUp)}>{formatMoneyYuan(person.premium)}</div>
                <div className="text-[10px] font-normal text-slate-400">{formatMoneyYuan(person.coverage)}</div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {person.categories
                .filter((item) => item.productCount > 0)
                .map((item) => (
                  <span key={item.key} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
                    {item.label} {formatMoneyYuan(item.coverage)}
                  </span>
                ))}
            </div>
          </div>
        )) : (
          <div className="px-4 py-8 text-center text-sm text-slate-400">暂无被保险人数据</div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, valueClass = "text-slate-900" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function directionalClass(value: number, isRedUp: boolean) {
  if (value > 0) return isRedUp ? "text-red-600" : "text-emerald-600";
  if (value < 0) return isRedUp ? "text-emerald-600" : "text-red-600";
  return "text-slate-500";
}
