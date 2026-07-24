"use client";

import { useMemo, useState } from "react";
import { CalendarClock, ChevronRight, Pause, Play, Repeat2 } from "lucide-react";
import { formatMoneyYuan } from "@/lib/format";

type MobilePlan = {
  id: string;
  taskTypeLabel?: string | null;
  taskTitle?: string | null;
  targetName?: string | null;
  fundName?: string | null;
  fundCode: string;
  accountLabel?: string | null;
  cashAccountLabel?: string | null;
  amount: number;
  intervalUnit: string;
  intervalValue: number;
  nextRunDate?: string | null;
  executedCount?: number;
  status: string;
};

type Filter = "active" | "paused" | "all";

export function MobileRegularInvest({ plans }: { plans: MobilePlan[] }) {
  const [filter, setFilter] = useState<Filter>("active");
  const [busyId, setBusyId] = useState<string | null>(null);

  const visiblePlans = useMemo(
    () => plans.filter((plan) => filter === "all" || plan.status === filter),
    [filter, plans],
  );

  async function updateStatus(plan: MobilePlan) {
    const action = plan.status === "active" ? "pause" : "resume";
    setBusyId(plan.id);
    try {
      const response = await fetch("/api/v1/regular-invest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: plan.id, action }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error ?? "更新计划失败");
      window.location.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "更新计划失败");
      setBusyId(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between px-1">
          <h1 className="text-sm font-semibold text-slate-900">计划任务</h1>
          <span className="text-xs tabular-nums text-slate-500">{plans.length} 个计划</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-200 p-1">
          {(["active", "paused", "all"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={`h-9 rounded-md text-xs font-semibold ${filter === value ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600"}`}>
              {value === "active" ? "执行中" : value === "paused" ? "已暂停" : "全部"}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 px-3 py-3 pb-6">
        {visiblePlans.map((plan) => {
          const active = plan.status === "active";
          return (
            <article key={plan.id} className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
              <div className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${active ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>
                  <Repeat2 size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-slate-900">{plan.taskTitle || plan.targetName || plan.fundName || plan.fundCode}</h2>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{active ? "执行中" : statusLabel(plan.status)}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">{plan.taskTypeLabel || "定投"} · {plan.accountLabel || "未设置目标账户"}</p>
                </div>
                <button type="button" disabled={busyId === plan.id || (plan.status !== "active" && plan.status !== "paused")} onClick={() => updateStatus(plan)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40" aria-label={active ? "暂停计划" : "恢复计划"}>
                  {active ? <Pause size={18} /> : <Play size={18} />}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                <Metric label="每期金额" value={formatMoneyYuan(plan.amount)} />
                <Metric label="执行周期" value={formatInterval(plan)} />
                <Metric label="已执行" value={`${plan.executedCount ?? 0} 次`} alignRight />
              </div>
              <div className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
                <CalendarClock size={14} className="shrink-0" />
                <span className="truncate">下次执行：{formatDate(plan.nextRunDate)}</span>
                {plan.cashAccountLabel ? <><span className="text-slate-300">·</span><span className="truncate">{plan.cashAccountLabel}</span></> : null}
                <ChevronRight size={15} className="ml-auto shrink-0 text-slate-400" />
              </div>
            </article>
          );
        })}
        {visiblePlans.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-12 text-center text-sm text-slate-500">暂无对应计划</div> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, alignRight = false }: { label: string; value: string; alignRight?: boolean }) {
  return <div className={`min-w-0 ${alignRight ? "text-right" : ""}`}><div className="text-[11px] text-slate-500">{label}</div><div className="mt-1 truncate text-xs font-semibold tabular-nums text-slate-900">{value}</div></div>;
}

function formatInterval(plan: MobilePlan) {
  const unit = plan.intervalUnit === "day" ? "天" : plan.intervalUnit === "week" ? "周" : plan.intervalUnit === "year" ? "年" : "月";
  return `每 ${plan.intervalValue || 1} ${unit}`;
}

function formatDate(value?: string | null) {
  if (!value) return "未安排";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function statusLabel(status: string) {
  if (status === "completed") return "已完成";
  if (status === "stopped") return "已终止";
  return status || "未知";
}
