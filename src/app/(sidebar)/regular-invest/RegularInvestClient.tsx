"use client";

import { Fragment, useEffect, useState } from "react";
import { Pause, Pencil, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { addWorkdaysUtc } from "@/lib/date-utils";
import type { AccountDisplayOption } from "@/lib/account-display";

const INTERVAL_LABELS: Record<string, string> = {
  day: "每天",
  week: "每周",
  biweek: "每两周",
  month: "每月",
};

const WEEKDAY_LABELS: Record<number, string> = {
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
};

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  active: { label: "执行中", cls: "text-green-600" },
  paused: { label: "已暂停", cls: "text-yellow-600" },
  stopped: { label: "已终止", cls: "text-red-600" },
  completed: { label: "已完成", cls: "text-blue-600" },
};

type GroupByMode = "fundGroup" | "fundAccount" | "cashGroup" | "cashAccount" | "none";

type RegularInvestPlanView = {
  id: string;
  accountId: string;
  accountName?: string | null;
  accountLabel?: string | null;
  accountFullLabel?: string | null;
  accountGroupName?: string | null;
  cashAccountId?: string | null;
  cashAccountName?: string | null;
  cashAccountLabel?: string | null;
  cashAccountFullLabel?: string | null;
  cashAccountGroupName?: string | null;
  fundCode: string;
  fundName?: string | null;
  amount: number;
  intervalUnit: string;
  intervalValue: number;
  executionDay?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  nextRunDate?: string | null;
  lastRunDate?: string | null;
  totalRuns?: number | null;
  executedRuns?: number | null;
  feeRate?: number | null;
  confirmDays?: number | null;
  arrivalDays?: number | null;
  skipPendingPreceding?: boolean;
  status: string;
  executedCount?: number;
  executedAmount?: number;
  confirmedCount?: number;
  confirmedAmount?: number;
};

function formatInterval(p: RegularInvestPlanView): string {
  const base = INTERVAL_LABELS[p.intervalUnit] || p.intervalUnit;
  if (p.intervalUnit === "week" || p.intervalUnit === "biweek") {
    const weekday = p.executionDay ? WEEKDAY_LABELS[p.executionDay] : "";
    if (weekday) return `${base}${weekday}`;
  }
  if (p.intervalUnit === "month" && p.executionDay) return `每月${p.executionDay}号`;
  if (p.intervalValue > 1) return `${base} x${p.intervalValue}`;
  return base;
}

function formatDate(value?: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "-";
}

function planAccountLabel(p: RegularInvestPlanView): string {
  return p.accountLabel || p.accountName || p.accountId || "-";
}

function planCashAccountLabel(p: RegularInvestPlanView): string {
  return p.cashAccountLabel || p.cashAccountName || "-";
}

function groupLabel(p: RegularInvestPlanView, mode: GroupByMode): string {
  if (mode === "fundGroup") return p.accountGroupName || "基金账户未分组";
  if (mode === "fundAccount") return p.accountFullLabel || planAccountLabel(p);
  if (mode === "cashGroup") return p.cashAccountGroupName || "资金账户未分组";
  if (mode === "cashAccount") return p.cashAccountFullLabel || planCashAccountLabel(p);
  return "";
}

function groupPlans(plans: RegularInvestPlanView[], mode: GroupByMode) {
  if (mode === "none") return [{ label: "", items: plans }];

  const grouped = new Map<string, RegularInvestPlanView[]>();
  for (const plan of plans) {
    const label = groupLabel(plan, mode);
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(plan);
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"))
    .map(([label, items]) => ({ label, items }));
}

function AccountCell({ label, groupName }: { label: string; groupName?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-slate-700">{label}</div>
      <div className="mt-0.5 truncate text-[11px] text-slate-400">{groupName || "未分组"}</div>
    </div>
  );
}

async function readJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function RegularInvestClient({
  initialPlans,
  investmentAccounts,
  cashAccounts,
  investmentAccountSSOptions,
  cashAccountSSOptions,
}: {
  initialPlans: RegularInvestPlanView[];
  investmentAccounts: AccountDisplayOption[];
  cashAccounts: AccountDisplayOption[];
  investmentAccountSSOptions: SmartSelectOption[];
  cashAccountSSOptions: SmartSelectOption[];
}) {
  const router = useRouter();
  const [plans, setPlans] = useState(initialPlans);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editPlan, setEditPlan] = useState<RegularInvestPlanView | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<RegularInvestPlanView | null>(null);
  const [planRecords, setPlanRecords] = useState<any[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ planId: string; planName: string } | null>(null);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupByMode>("fundGroup");

  useEffect(() => {
    setPlans(initialPlans);
  }, [initialPlans]);

  async function apiCreateAction(payload: any) {
    const res = await fetch("/api/v1/regular-invest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  async function loadRecords(plan: RegularInvestPlanView) {
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/v1/regular-invest/records?planId=${encodeURIComponent(plan.id)}`);
      const data = await res.json();
      if (data.ok) {
        const records = data.records || [];
        records.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setPlanRecords(records);
      } else {
        setPlanRecords([]);
      }
    } catch {
      setPlanRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }

  async function handleSelectPlan(plan: RegularInvestPlanView) {
    if (selectedPlan?.id === plan.id) {
      setSelectedPlan(null);
      setPlanRecords([]);
      return;
    }
    setSelectedPlan(plan);
    await loadRecords(plan);
  }

  async function refreshRecords() {
    if (!selectedPlan) return;
    await loadRecords(selectedPlan);
  }

  async function handleAction(planId: string, action: "pause" | "resume" | "stop") {
    const res = await fetch("/api/v1/regular-invest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: planId, action }),
    });
    const data = await res.json();
    if (data.ok) {
      setPlans((prev) => prev.map((plan) => {
        if (plan.id !== planId) return plan;
        const status = action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
        return { ...plan, status };
      }));
    } else {
      window.alert(data.error || "操作失败");
    }
  }

  async function handleBatchExecute(planId: string) {
    if (!window.confirm("确认从开始日期批量执行该定投计划吗？\n\n系统会自动生成所有到期但未执行的交易明细。")) return;
    try {
      const plan = plans.find((item) => item.id === planId);
      if (plan?.fundCode) {
        const startDate = plan.lastRunDate
          ? new Date(plan.lastRunDate).toISOString().slice(0, 10)
          : new Date(plan.startDate || new Date()).toISOString().slice(0, 10);
        const endDate = new Date().toISOString().slice(0, 10);
        try {
          await fetch("/api/v1/fund/preload-nav", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fundCode: plan.fundCode, startDate, endDate }),
          });
        } catch {
          // NAV preload is an optimization; execution API still returns the source of truth.
        }
      }

      const res = await fetch("/api/v1/regular-invest/batch-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok || !data?.ok) {
        window.alert(data?.error || `执行失败(${res.status})`);
        return;
      }
      if (data.stats) {
        setPlans((prev) => prev.map((plan) => {
          if (plan.id !== planId) return plan;
          return {
            ...plan,
            executedCount: data.stats.executedCount,
            executedAmount: data.stats.executedAmount,
            confirmedCount: data.stats.confirmedCount,
            confirmedAmount: data.stats.confirmedAmount,
            executedRuns: data.stats.plan?.executedRuns ?? plan.executedRuns,
            lastRunDate: data.stats.plan?.lastRunDate ?? plan.lastRunDate,
            nextRunDate: data.stats.plan?.nextRunDate ?? plan.nextRunDate,
            status: data.stats.plan?.status ?? plan.status,
          };
        }));
      }
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "执行失败");
    }
  }

  async function handleBatchExecuteAll() {
    const activePlans = plans.filter((plan) => plan.status === "active");
    if (activePlans.length === 0) {
      window.alert("没有执行中的定投计划");
      return;
    }
    if (!window.confirm(`确认批量执行所有 ${activePlans.length} 个执行中的定投计划吗？`)) return;
    try {
      const endDate = new Date().toISOString().slice(0, 10);
      for (const plan of activePlans) {
        if (!plan.fundCode) continue;
        const preloadStart = plan.lastRunDate
          ? new Date(plan.lastRunDate).toISOString().slice(0, 10)
          : new Date(plan.startDate || new Date()).toISOString().slice(0, 10);
        try {
          await fetch("/api/v1/fund/preload-nav", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fundCode: plan.fundCode, startDate: preloadStart, endDate }),
          });
        } catch {
        }
      }

      let ok = 0;
      let fail = 0;
      for (const plan of activePlans) {
        try {
          const res = await fetch("/api/v1/regular-invest/batch-execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId: plan.id }),
          });
          const data = await readJsonSafe(res);
          if (res.ok && data?.ok) ok++;
          else fail++;
        } catch {
          fail++;
        }
      }
      window.alert(fail === 0 ? `批量执行完成，成功执行 ${ok} 个计划` : `批量执行完成，成功 ${ok} 个，失败 ${fail} 个`);
      router.refresh();
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "批量执行失败");
    }
  }

  async function executeDelete(planId: string, mode: "all" | "plan" | "records") {
    setDeleteConfirm(null);
    if (mode === "records") {
      if (!window.confirm("确认删除该计划关联的所有交易明细吗？")) return;
      const res = await fetch(`/api/v1/regular-invest?id=${planId}&deleteRecords=records`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setPlanRecords([]);
        setSelectedPlan((prev) => prev?.id === planId ? { ...prev, ...data.plan, executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 } : prev);
        setPlans((prev) => prev.map((plan) => plan.id === planId ? { ...plan, ...data.plan, executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 } : plan));
        router.refresh();
      } else {
        window.alert(data.error || "删除失败");
      }
      return;
    }

    const deleteRecords = mode === "all";
    const res = await fetch(`/api/v1/regular-invest?id=${planId}&deleteRecords=${deleteRecords ? "1" : "0"}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      if (selectedPlan?.id === planId) {
        setSelectedPlan(null);
        setPlanRecords([]);
      }
      router.refresh();
    } else {
      window.alert(data.error || "删除失败");
    }
  }

  function handleDelete(planId: string) {
    const plan = plans.find((item) => item.id === planId);
    setDeleteConfirm({ planId, planName: plan ? `${plan.fundCode} ${plan.fundName || ""}` : "定投计划" });
  }

  async function handleDeleteRecord(recordId: string) {
    if (!window.confirm("确认删除这条交易明细？")) return;
    const res = await fetch(`/api/v1/fund/entry?id=${recordId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      await refreshRecords();
      router.refresh();
    } else {
      window.alert(data.error || "删除失败");
    }
  }

  function openEditRecord(record: any) {
    setEditingRecord({
      id: record.id,
      date: record.date ? new Date(record.date).toISOString().slice(0, 10) : "",
      fundConfirmDate: record.fundConfirmDate ? new Date(record.fundConfirmDate).toISOString().slice(0, 10) : "",
      confirmDays: selectedPlan?.confirmDays ?? 0,
      _originalDate: record.date ? new Date(record.date).toISOString().slice(0, 10) : "",
      _originalConfirmDate: record.fundConfirmDate ? new Date(record.fundConfirmDate).toISOString().slice(0, 10) : "",
    });
  }

  async function handleSaveRecord() {
    if (!editingRecord) return;
    const payload: any = { id: editingRecord.id };
    if (editingRecord.date !== editingRecord._originalDate) {
      payload.date = editingRecord.date;
      payload.fundConfirmDate = `${addWorkdaysUtc(editingRecord.date, editingRecord.confirmDays)}T00:00:00.000Z`;
    } else if (editingRecord.fundConfirmDate !== editingRecord._originalConfirmDate) {
      payload.fundConfirmDate = `${editingRecord.fundConfirmDate}T00:00:00.000Z`;
    }
    const res = await fetch("/api/v1/fund/entry", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      setEditingRecord(null);
      await refreshRecords();
      router.refresh();
    } else {
      window.alert(data.error || "保存失败");
    }
  }

  const filteredPlans = plans.filter((plan) => showEnded || (plan.status !== "stopped" && plan.status !== "completed"));
  const groupedPlans = groupPlans(filteredPlans, groupBy);

  function renderRow(plan: RegularInvestPlanView) {
    return (
      <tr
        key={plan.id}
        className={`cursor-pointer hover:bg-slate-50 ${selectedPlan?.id === plan.id ? "bg-blue-50" : ""}`}
        onClick={() => handleSelectPlan(plan)}
      >
        <td className="border-b border-slate-100 px-3 py-1 text-xs">
          <span className="font-medium text-slate-800">{plan.fundCode}</span>
          {plan.fundName && plan.fundName !== plan.fundCode && <span className="ml-1 text-slate-400">{plan.fundName}</span>}
        </td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs tabular-nums text-slate-500">{formatDate(plan.startDate)}</td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs">
          <AccountCell label={planAccountLabel(plan)} groupName={plan.accountGroupName} />
        </td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs">
          <AccountCell label={planCashAccountLabel(plan)} groupName={plan.cashAccountGroupName} />
        </td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs text-slate-500">{formatInterval(plan)}</td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs">
          <span className={STATUS_MAP[plan.status]?.cls || "text-slate-600"}>{STATUS_MAP[plan.status]?.label || plan.status}</span>
        </td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs tabular-nums text-slate-500">{formatDate(plan.nextRunDate)}</td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs tabular-nums text-slate-500">
          {plan.executedCount || 0}笔({(plan.executedAmount || 0).toFixed(2)})
        </td>
        <td className="border-b border-slate-100 px-3 py-1 text-xs tabular-nums text-slate-500">
          {plan.confirmedCount || 0}笔({(plan.confirmedAmount || 0).toFixed(2)})
        </td>
        <td className="border-b border-slate-100 px-2 py-1">
          <div className="flex items-center justify-end gap-1">
            {plan.status === "active" && (
              <>
                <button onClick={(e) => { e.stopPropagation(); handleBatchExecute(plan.id); }} title="批量执行" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-purple-200 hover:bg-purple-50">
                  <RefreshCw className="h-3 w-3 text-purple-600" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); handleAction(plan.id, "pause"); }} title="暂停" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-yellow-200 hover:bg-yellow-50">
                  <Pause className="h-3 w-3 text-yellow-600" />
                </button>
                <button onClick={(e) => { e.stopPropagation(); handleAction(plan.id, "stop"); }} title="终止" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-red-200 hover:bg-red-50">
                  <Square className="h-3 w-3 text-red-600" />
                </button>
              </>
            )}
            {plan.status === "paused" && (
              <button onClick={(e) => { e.stopPropagation(); handleAction(plan.id, "resume"); }} title="恢复" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-green-200 hover:bg-green-50">
                <Play className="h-3 w-3 text-green-600" />
              </button>
            )}
            <button onClick={(e) => { e.stopPropagation(); setEditPlan(plan); setEditOpen(true); }} title="修改" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50">
              <Pencil className="h-3 w-3 text-blue-600" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); handleDelete(plan.id); }} title="删除" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-red-200 hover:bg-red-50">
              <Trash2 className="h-3 w-3 text-red-500" />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="flex h-full w-full">
        <div className="flex min-w-0 flex-1 flex-col bg-slate-50">
          <header className="shrink-0 border-b border-slate-200 bg-gradient-to-b from-slate-100 to-slate-50">
            <div className="flex h-12 items-center justify-end gap-2 border-b border-slate-200 bg-white px-4">
              <RegularInvestForm
                accountId={investmentAccounts[0]?.id ?? ""}
                investmentAccounts={investmentAccounts}
                cashAccounts={cashAccounts}
                investmentAccountSSOptions={investmentAccountSSOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                showTriggerButton={false}
                open={showCreateForm}
                onOpenChange={setShowCreateForm}
                apiAction={apiCreateAction}
              />
              <button onClick={handleBatchExecuteAll} title="批量执行所有定投计划" className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50">
                <RefreshCw className="h-4 w-4" />执行全部
              </button>
              <button onClick={() => setShowCreateForm(true)} className="flex h-8 items-center gap-1 rounded-md bg-blue-600 px-3 text-sm text-white hover:bg-blue-700">
                <Plus className="h-4 w-4" />新增计划
              </button>
            </div>
            <div className="flex h-11 items-center justify-between bg-slate-50 px-4">
              <div className="flex items-center gap-3 text-sm">
                <span className="font-semibold text-slate-800">定投计划</span>
                <span className="text-slate-500">
                  共 {filteredPlans.length} 个计划，{filteredPlans.filter((plan) => plan.status === "active").length} 个执行中
                </span>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupByMode)}
                  className="ml-4 h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none"
                >
                  <option value="fundGroup">按基金账户组分组</option>
                  <option value="fundAccount">按基金账户分组</option>
                  <option value="cashGroup">按资金账户组分组</option>
                  <option value="cashAccount">按资金账户分组</option>
                  <option value="none">不分组</option>
                </select>
              </div>
              <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-slate-500">
                <input type="checkbox" checked={!showEnded} onChange={(e) => setShowEnded(!e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />
                不显示已结束计划
              </label>
            </div>
          </header>

          <div className={`min-h-0 flex-1 ${selectedPlan ? "grid grid-rows-2" : ""}`}>
            <div className={`${selectedPlan ? "min-h-0 overflow-auto border-b border-slate-200 bg-white" : "flex-1 overflow-auto bg-white"}`}>
              <table className="w-full min-w-[1040px] border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">基金</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">开始日期</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">基金账户</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">资金账户</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">间隔</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">状态</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">下次执行</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">已执行</th>
                    <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">已确认</th>
                    <th className="border-b border-slate-200 px-2 py-2 text-right text-xs font-semibold text-slate-600">操作</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {groupedPlans.length === 0 || groupedPlans[0].items.length === 0 ? (
                    <tr><td className="px-3 py-6 text-xs text-slate-500" colSpan={10}>暂无定投计划</td></tr>
                  ) : (
                    groupedPlans.map((group, index) => (
                      group.label ? (
                        <Fragment key={`g-${index}`}>
                          <tr className="bg-slate-50">
                            <td className="px-3 py-1.5 text-xs font-semibold text-slate-600" colSpan={10}>
                              {group.label} ({group.items.length})
                            </td>
                          </tr>
                          {group.items.map((plan) => renderRow(plan))}
                        </Fragment>
                      ) : (
                        <Fragment key={`g-${index}`}>{group.items.map((plan) => renderRow(plan))}</Fragment>
                      )
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {selectedPlan && (
              <div className="flex min-h-0 flex-col bg-slate-50">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4">
                  <div className="text-xs font-semibold text-slate-700">{selectedPlan.fundCode} {selectedPlan.fundName} - 交易明细</div>
                  <button onClick={() => { setSelectedPlan(null); setPlanRecords([]); }} className="text-xs text-slate-400 hover:text-slate-600">关闭</button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {recordsLoading ? (
                    <div className="px-4 py-6 text-center text-xs text-slate-400">加载中...</div>
                  ) : planRecords.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-slate-400">暂无交易记录</div>
                  ) : (
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium text-slate-600">申请日期</th>
                          <th className="px-3 py-1.5 text-left font-medium text-slate-600">确认日期</th>
                          <th className="px-3 py-1.5 text-right font-medium text-slate-600">金额</th>
                          <th className="px-3 py-1.5 text-right font-medium text-slate-600">份额</th>
                          <th className="px-3 py-1.5 text-center font-medium text-slate-600">状态</th>
                          <th className="px-3 py-1.5 text-center font-medium text-slate-600">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planRecords.map((record) => {
                          const isConfirmed = record.fundUnits != null && Number(record.fundUnits) > 0;
                          return (
                            <tr key={record.id} className="border-b border-slate-100 bg-white">
                              <td className="px-3 py-1.5 tabular-nums text-slate-700">{formatDate(record.date)}</td>
                              <td className="px-3 py-1.5 tabular-nums text-slate-500">{formatDate(record.fundConfirmDate)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{(Math.abs(Number(record.amount)) || 0).toFixed(2)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{isConfirmed ? Number(record.fundUnits).toFixed(2) : "-"}</td>
                              <td className="px-3 py-1.5 text-center">
                                {isConfirmed ? <span className="text-emerald-600">已确认</span> : <span className="text-amber-600">待确认</span>}
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <button onClick={(e) => { e.stopPropagation(); openEditRecord(record); }} title="修改日期" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50">
                                    <Pencil className="h-3 w-3 text-blue-600" />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record.id); }} title="删除" className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-red-200 hover:bg-red-50">
                                    <Trash2 className="h-3 w-3 text-red-500" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <RegularInvestForm
        mode="edit"
        editData={editPlan ? {
          id: editPlan.id,
          accountId: editPlan.accountId || "",
          fundCode: editPlan.fundCode || "",
          fundName: editPlan.fundName || null,
          amount: editPlan.amount,
          intervalUnit: editPlan.intervalUnit || "month",
          intervalValue: editPlan.intervalValue || 1,
          executionDay: editPlan.executionDay ?? null,
          startDate: editPlan.startDate ? new Date(editPlan.startDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          endDate: editPlan.endDate ? new Date(editPlan.endDate).toISOString().slice(0, 10) : null,
          totalRuns: editPlan.totalRuns ?? null,
          cashAccountId: editPlan.cashAccountId ?? null,
          feeRate: editPlan.feeRate ?? null,
          confirmDays: editPlan.confirmDays ?? null,
          arrivalDays: editPlan.arrivalDays ?? null,
          skipPendingPreceding: editPlan.skipPendingPreceding ?? true,
        } : undefined}
        accountId={editPlan?.accountId ?? investmentAccounts[0]?.id ?? ""}
        investmentAccounts={investmentAccounts}
        cashAccounts={cashAccounts}
        investmentAccountSSOptions={investmentAccountSSOptions}
        cashAccountSSOptions={cashAccountSSOptions}
        showTriggerButton={false}
        open={editOpen}
        onOpenChange={(open) => { setEditOpen(open); if (!open) setEditPlan(null); }}
        submitMethod="api"
        onSuccess={() => { setEditPlan(null); }}
      />

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">删除定投计划</div>
            </div>
            <div className="space-y-3 p-4">
              <div className="text-sm text-slate-700">确认对「{deleteConfirm.planName}」的操作？</div>
              <div className="space-y-2">
                <button onClick={() => executeDelete(deleteConfirm.planId, "all")} className="h-9 w-full rounded-md bg-red-600 text-sm text-white hover:bg-red-700">
                  删除计划 + 删除关联交易记录
                </button>
                <button onClick={() => executeDelete(deleteConfirm.planId, "plan")} className="h-9 w-full rounded-md border border-amber-200 bg-amber-50 text-sm text-amber-700 hover:bg-amber-100">
                  仅删除计划，保留交易记录
                </button>
                <button onClick={() => executeDelete(deleteConfirm.planId, "records")} className="h-9 w-full rounded-md border border-red-200 bg-red-50 text-sm text-red-600 hover:bg-red-100">
                  仅删除交易记录，保留计划
                </button>
                <button onClick={() => setDeleteConfirm(null)} className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:bg-slate-50">
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">修改交易明细日期</div>
              <button onClick={() => setEditingRecord(null)} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 hover:bg-slate-50">关闭</button>
            </div>
            <div className="space-y-3 p-4">
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">申请日期</div>
                <input
                  type="date"
                  value={editingRecord.date}
                  onChange={(e) => {
                    const newDate = e.target.value;
                    setEditingRecord((record: any) => ({ ...record, date: newDate, fundConfirmDate: addWorkdaysUtc(newDate, editingRecord.confirmDays) }));
                  }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
                <div className="text-xs text-slate-400">修改申请日期会自动重算确认日期 (T+{editingRecord.confirmDays})</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">确认日期</div>
                <input
                  type="date"
                  value={editingRecord.fundConfirmDate}
                  onChange={(e) => setEditingRecord((record: any) => ({ ...record, fundConfirmDate: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
                <div className="text-xs text-slate-400">单独修改确认日期不会影响申请日期</div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setEditingRecord(null)} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50">取消</button>
                <button onClick={handleSaveRecord} className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700">保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
