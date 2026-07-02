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
  const coverageColumns = (insuranceOverview?.categoryRows ?? []).filter((item) => item.key !== "other").slice(0, 4);

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
      <div className="border-t border-slate-100 px-4 pb-4">
        {insuranceRows.length > 0 && coverageColumns.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-[520px] w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr className="text-slate-500">
                  <th className="sticky left-0 z-10 bg-white px-0 py-2 pr-3 text-left font-semibold">人员</th>
                  {coverageColumns.map((column) => (
                    <th key={column.key} className="px-2 py-2 text-right font-semibold">{column.label}</th>
                  ))}
                  <th className="px-2 py-2 text-right font-semibold">合计</th>
                </tr>
              </thead>
              <tbody>
                {insuranceRows.slice(0, 8).map((person) => (
                  <tr key={person.insuredPersonKey} className="group">
                    <td className="sticky left-0 z-10 max-w-[120px] bg-white py-2 pr-3 align-middle group-hover:bg-slate-50">
                      <div className="truncate font-semibold text-slate-800">{person.insuredPersonName}</div>
                      <div className="mt-0.5 text-[10px] text-slate-400">{person.productCount} 个产品</div>
                    </td>
                    {coverageColumns.map((column) => {
                      const item = person.categories.find((category) => category.key === column.key);
                      const coverage = item?.coverage ?? 0;
                      return (
                        <td key={column.key} className="border-t border-slate-100 px-2 py-2 text-right align-middle tabular-nums group-hover:bg-slate-50">
                          {coverage > 0 ? (
                            <div>
                              <div className="font-semibold text-slate-800">{formatCompactMoney(coverage)}</div>
                              <div className="mt-0.5 text-[10px] text-slate-400">{item?.productCount ?? 0} 份</div>
                            </div>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border-t border-slate-100 px-2 py-2 text-right align-middle font-semibold tabular-nums text-slate-900 group-hover:bg-slate-50">
                      {formatCompactMoney(person.coverage)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-400">
            暂无保险数据
          </div>
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

function formatCompactMoney(value: number) {
  if (!Number.isFinite(value) || value === 0) return "-";
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(Math.abs(value) >= 1000000 ? 0 : 1)}万`;
  return formatMoneyYuan(value);
}
