"use client";

import { useState, useEffect, Fragment } from "react";
import { Play, Pause, Square, Trash2, Plus, Pencil, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { addWorkdaysUtc } from "@/lib/date-utils";

const INTERVAL_LABELS: Record<string, string> = {
  day: "每天", week: "每周", biweek: "每两周", month: "每月",
};

const WEEKDAY_LABELS: Record<number, string> = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五" };

function formatInterval(p: any): string {
  const base = INTERVAL_LABELS[p.intervalUnit] || p.intervalUnit;
  if (p.intervalUnit === "week" || p.intervalUnit === "biweek") {
    const weekday = WEEKDAY_LABELS[p.executionDay];
    if (weekday) return `${base}${weekday}`;
  }
  if (p.intervalUnit === "month" && p.executionDay) return `每月${p.executionDay}号`;
  if (p.intervalValue > 1) return `${base} ×${p.intervalValue}`;
  return base;
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  active: { label: "执行中", cls: "text-green-600" },
  paused: { label: "已暂停", cls: "text-yellow-600" },
  stopped: { label: "已终止", cls: "text-red-600" },
  completed: { label: "已完成", cls: "text-blue-600" },
};

export function RegularInvestClient({
  initialPlans, investmentAccounts, cashAccounts,
}: {
  initialPlans: any[];
  investmentAccounts: { id: string; name: string; label: string }[];
  cashAccounts: { id: string; name: string; label: string }[];
}) {
  const router = useRouter();
  const [plans, setPlans] = useState(initialPlans);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editPlan, setEditPlan] = useState<any>(null);
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [planRecords, setPlanRecords] = useState<any[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ planId: string; planName: string } | null>(null);
  const [editingRecord, setEditingRecord] = useState<any>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [groupBy, setGroupBy] = useState<"none" | "cashAccount">("none");

  useEffect(() => { setPlans(initialPlans); }, [initialPlans]);

  async function readJsonSafe(res: Response): Promise<any> {
    try { return await res.json(); } catch { return null; }
  }

  async function apiCreateAction(payload: any) {
    const res = await fetch("/api/v1/regular-invest", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    return await res.json();
  }

  async function handleSelectPlan(p: any) {
    if (selectedPlan?.id === p.id) { setSelectedPlan(null); setPlanRecords([]); return; }
    setSelectedPlan(p);
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/v1/regular-invest/records?planId=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      if (data.ok) {
        if (data.records) data.records.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setPlanRecords(data.records || []);
      } else {
        setPlanRecords([]);
      }
    } catch { setPlanRecords([]); } finally { setRecordsLoading(false); }
  }

  async function handleAction(planId: string, action: "pause" | "resume" | "stop") {
    const res = await fetch("/api/v1/regular-invest", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: planId, action }),
    });
    const data = await res.json();
    if (data.ok) {
      setPlans((prev) => prev.map((p) => {
        if (p.id !== planId) return p;
        const newStatus = action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
        return { ...p, status: newStatus };
      }));
    } else { window.alert(data.error || "操作失败"); }
  }

  async function handleBatchExecute(planId: string) {
    if (!window.confirm("确认从开始日期批量执行定投计划吗？\n\n系统会自动生成所有到期但未执行的交易明细。")) return;
    try {
      const plan = plans.find(p => p.id === planId);
      if (plan?.fundCode && plan?.startDate) {
        const startDate = new Date(plan.startDate).toISOString().slice(0, 10);
        const endDate = new Date().toISOString().slice(0, 10);
        try {
          await fetch("/api/v1/fund/preload-nav", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fundCode: plan.fundCode, startDate, endDate }),
          });
        } catch { }
      }
      const res = await fetch("/api/v1/regular-invest/batch-execute", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok || !data?.ok) {
        window.alert(data?.error || `执行失败(${res.status})`);
        return;
      }
      if (data.stats) {
        setPlans((prev) => prev.map((p) => {
          if (p.id !== planId) return p;
          return { ...p, executedCount: data.stats.executedCount, executedAmount: data.stats.executedAmount, confirmedCount: data.stats.confirmedCount, confirmedAmount: data.stats.confirmedAmount, executedRuns: data.stats.plan?.executedRuns ?? p.executedRuns, lastRunDate: data.stats.plan?.lastRunDate ?? p.lastRunDate, nextRunDate: data.stats.plan?.nextRunDate ?? p.nextRunDate, status: data.stats.plan?.status ?? p.status };
        }));
      }
      router.refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "执行失败");
    }
  }

  async function handleBatchExecuteAll() {
    const activePlans = plans.filter((p) => p.status === "active");
    if (activePlans.length === 0) { window.alert("没有执行中的定投计划"); return; }
    if (!window.confirm(`确认批量执行所有 ${activePlans.length} 个执行中的定投计划吗？`)) return;
    try {
      const endDate = new Date().toISOString().slice(0, 10);
      for (const plan of activePlans) {
        if (plan.fundCode && plan.startDate) {
          try {
            await fetch("/api/v1/fund/preload-nav", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fundCode: plan.fundCode, startDate: new Date(plan.startDate).toISOString().slice(0, 10), endDate }),
            });
          } catch { }
        }
      }
      let ok = 0, fail = 0;
      for (const plan of activePlans) {
        try {
          const res = await fetch("/api/v1/regular-invest/batch-execute", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ planId: plan.id }),
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
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "批量执行失败");
    }
  }

  async function executeDelete(planId: string, mode: "all" | "plan" | "records") {
    setDeleteConfirm(null);
    if (mode === "records") {
      if (!window.confirm(`确认删除该计划关联的所有交易明细吗？`)) return;
      const res = await fetch(`/api/v1/regular-invest?id=${planId}&deleteRecords=records`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setPlanRecords([]);
        setSelectedPlan((prev: any) => prev?.id === planId ? { ...prev, ...data.plan, executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 } : prev);
        setPlans((prev) => prev.map((p) => p.id === planId ? { ...p, ...data.plan, executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 } : p));
        router.refresh();
      }
      else window.alert(data.error || "删除失败");
      return;
    }
    const deleteRecords = mode === "all";
    const res = await fetch(`/api/v1/regular-invest?id=${planId}&deleteRecords=${deleteRecords ? "1" : "0"}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      if (selectedPlan?.id === planId) { setSelectedPlan(null); setPlanRecords([]); }
      router.refresh();
    } else { window.alert(data.error || "删除失败"); }
  }

  function handleDelete(planId: string) {
    const plan = plans.find(p => p.id === planId);
    setDeleteConfirm({ planId, planName: plan ? `${plan.fundCode} ${plan.fundName || ""}` : "定投计划" });
  }

  async function refreshRecords() {
    if (!selectedPlan) return;
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/v1/regular-invest/records?planId=${encodeURIComponent(selectedPlan.id)}`);
      const d = await res.json();
      if (d.ok) setPlanRecords(d.records || []);
    } catch {} finally { setRecordsLoading(false); }
  }

  async function handleDeleteRecord(recordId: string) {
    if (!window.confirm("确认删除这条交易明细？")) return;
    const res = await fetch(`/api/v1/fund/entry?id=${recordId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) { refreshRecords(); router.refresh(); }
    else window.alert(data.error || "删除失败");
  }

  function openEditRecord(r: any) {
    setEditingRecord({
      id: r.id,
      date: r.date ? new Date(r.date).toISOString().slice(0, 10) : "",
      fundConfirmDate: r.fundConfirmDate ? new Date(r.fundConfirmDate).toISOString().slice(0, 10) : "",
      confirmDays: selectedPlan?.confirmDays ?? 0,
      _originalDate: r.date ? new Date(r.date).toISOString().slice(0, 10) : "",
      _originalConfirmDate: r.fundConfirmDate ? new Date(r.fundConfirmDate).toISOString().slice(0, 10) : "",
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
    const res = await fetch("/api/v1/fund/entry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.ok) { setEditingRecord(null); refreshRecords(); router.refresh(); }
    else window.alert(data.error || "保存失败");
  }

  const filteredPlans = plans.filter(p => showEnded || (p.status !== "stopped" && p.status !== "completed"));
  const groupedPlans: Array<{ label: string; items: typeof filteredPlans }> =
    groupBy === "cashAccount"
      ? (() => {
          const g = new Map<string, typeof filteredPlans>();
          for (const p of filteredPlans) {
            const key = p.cashAccountName || "未关联资金账户";
            if (!g.has(key)) g.set(key, []);
            g.get(key)!.push(p);
          }
          return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN")).map(([label, items]) => ({ label, items }));
        })()
      : [{ label: "", items: filteredPlans }];

  function renderRow(p: any) {
    return (
      <tr key={p.id} className={`hover:bg-slate-50 ${selectedPlan?.id === p.id ? "bg-blue-50" : ""}`} onClick={() => handleSelectPlan(p)}>
        <td className="px-3 py-1 border-b border-slate-100 text-xs">
          <span className="text-slate-800 font-medium">{p.fundCode}</span>
          {p.fundName && p.fundName !== p.fundCode && <span className="ml-1 text-slate-400">{p.fundName}</span>}
        </td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
          {p.startDate ? new Date(p.startDate).toLocaleDateString() : "—"}
        </td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">{p.accountName}</td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">{p.cashAccountName || "—"}</td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">{formatInterval(p)}</td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs">
          <span className={STATUS_MAP[p.status]?.cls || "text-slate-600"}>{STATUS_MAP[p.status]?.label || p.status}</span>
        </td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
          {p.nextRunDate ? new Date(p.nextRunDate).toLocaleDateString() : "—"}
        </td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
          {p.executedCount || 0}期 ({(p.executedAmount || 0).toFixed(2)})
        </td>
        <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
          {p.confirmedCount || 0}期 ({(p.confirmedAmount || 0).toFixed(2)})
        </td>
        <td className="px-2 py-1 border-b border-slate-100">
          <div className="flex items-center justify-end gap-1">
            {p.status === "active" && (
              <>
                <button onClick={() => handleBatchExecute(p.id)} title="批量执行" className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-purple-50 hover:border-purple-200">
                  <RefreshCw className="w-3 h-3 text-purple-600" />
                </button>
                <button onClick={() => handleAction(p.id, "pause")} title="暂停" className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-yellow-50 hover:border-yellow-200">
                  <Pause className="w-3 h-3 text-yellow-600" />
                </button>
                <button onClick={() => handleAction(p.id, "stop")} title="终止" className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200">
                  <Square className="w-3 h-3 text-red-600" />
                </button>
              </>
            )}
            {p.status === "paused" && (
              <button onClick={() => handleAction(p.id, "resume")} title="恢复" className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-green-50 hover:border-green-200">
                <Play className="w-3 h-3 text-green-600" />
              </button>
            )}
            <button onClick={() => { setEditPlan(p); setEditOpen(true); }} title="修改" className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200">
              <Pencil className="w-3 h-3 text-blue-600" />
            </button>
            <button onClick={() => handleDelete(p.id)} title="删除" className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200">
              <Trash2 className="w-3 h-3 text-red-500" />
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="flex h-full w-full">
        <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
          <header className="shrink-0 border-b border-slate-200 bg-gradient-to-b from-slate-100 to-slate-50">
            <div className="h-12 flex items-center justify-end px-4 bg-white border-b border-slate-200">
              <RegularInvestForm
                accountId={investmentAccounts[0]?.id ?? ""}
                investmentAccounts={investmentAccounts} cashAccounts={cashAccounts}
                showTriggerButton={false} open={showCreateForm} onOpenChange={setShowCreateForm}
                apiAction={apiCreateAction}
              />
              <button onClick={handleBatchExecuteAll} title="批量执行所有定投计划"
                className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-1">
                <RefreshCw className="w-4 h-4" />执行全部
              </button>
              <button onClick={() => setShowCreateForm(true)}
                className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center gap-1">
                <Plus className="w-4 h-4" />新增计划
              </button>
            </div>
            <div className="h-11 flex items-center justify-between px-4 bg-slate-50">
              <div className="flex items-center gap-3 text-sm">
                <span className="font-semibold text-slate-800">定投计划</span>
                <span className="text-slate-500">
                  共 {filteredPlans.length} 个计划，{filteredPlans.filter((p) => p.status === "active").length} 个执行中
                </span>
                <select value={groupBy} onChange={e => setGroupBy(e.target.value as any)}
                  className="h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none ml-4">
                  <option value="none">不分组</option>
                  <option value="cashAccount">按资金账户分组</option>
                </select>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
                <input type="checkbox" checked={!showEnded} onChange={e => setShowEnded(!e.target.checked)}
                  className="w-3.5 h-3.5 accent-blue-600" />
                不显示已结束计划
              </label>
            </div>
          </header>

          <div className={`flex-1 min-h-0 ${selectedPlan ? "grid grid-rows-2" : ""}`}>
            <div className={`${selectedPlan ? "min-h-0 overflow-auto bg-white border-b border-slate-200" : "flex-1 overflow-auto bg-white"}`}>
              <table className="min-w-[900px] w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">基金</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">开始日期</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">基金账户</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">资金账户</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">间隔</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">状态</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">下次执行</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">已执行</th>
                    <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">已确认</th>
                    <th className="text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">操作</th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {groupedPlans.length === 0 || groupedPlans[0].items.length === 0 ? (
                    <tr><td className="px-3 py-6 text-xs text-slate-500" colSpan={10}>暂无定投计划</td></tr>
                  ) : (
                    groupedPlans.map((group, gi) => (
                      group.label ? (
                        <Fragment key={`g-${gi}`}>
                          <tr className="bg-slate-50">
                            <td className="px-3 py-1.5 text-xs font-semibold text-slate-600" colSpan={10}>
                              {group.label} ({group.items.length})
                            </td>
                          </tr>
                          {group.items.map((p) => renderRow(p))}
                        </Fragment>
                      ) : (
                        <Fragment key={`g-${gi}`}>{group.items.map((p) => renderRow(p))}</Fragment>
                      )
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {selectedPlan && (
              <div className="min-h-0 flex flex-col bg-slate-50">
                <div className="h-10 flex items-center justify-between px-4 bg-white border-b border-slate-100 shrink-0">
                  <div className="text-xs font-semibold text-slate-700">{selectedPlan.fundCode} {selectedPlan.fundName} - 交易明细</div>
                  <button onClick={() => { setSelectedPlan(null); setPlanRecords([]); }} className="text-xs text-slate-400 hover:text-slate-600">关闭</button>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  {recordsLoading ? (
                    <div className="px-4 py-6 text-xs text-slate-400 text-center">加载中...</div>
                  ) : planRecords.length === 0 ? (
                    <div className="px-4 py-6 text-xs text-slate-400 text-center">暂无交易记录</div>
                  ) : (
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100">
                        <tr>
                          <th className="text-left px-3 py-1.5 text-slate-600 font-medium">申请日期</th>
                          <th className="text-left px-3 py-1.5 text-slate-600 font-medium">确认日期</th>
                          <th className="text-right px-3 py-1.5 text-slate-600 font-medium">金额</th>
                          <th className="text-right px-3 py-1.5 text-slate-600 font-medium">份额</th>
                          <th className="text-center px-3 py-1.5 text-slate-600 font-medium">状态</th>
                          <th className="text-center px-3 py-1.5 text-slate-600 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planRecords.map((r: any) => {
                          const isConfirmed = r.fundUnits != null && Number(r.fundUnits) > 0;
                          return (
                            <tr key={r.id} className="border-b border-slate-100 bg-white">
                              <td className="px-3 py-1.5 text-slate-700 tabular-nums">{r.date ? new Date(r.date).toLocaleDateString() : "-"}</td>
                              <td className="px-3 py-1.5 text-slate-500 tabular-nums">{r.fundConfirmDate ? new Date(r.fundConfirmDate).toLocaleDateString() : "-"}</td>
                              <td className="px-3 py-1.5 text-right text-slate-700 tabular-nums">{(Math.abs(Number(r.amount)) || 0).toFixed(2)}</td>
                              <td className="px-3 py-1.5 text-right text-slate-700 tabular-nums">{isConfirmed ? Number(r.fundUnits).toFixed(2) : "-"}</td>
                              <td className="px-3 py-1.5 text-center">
                                {isConfirmed ? <span className="text-emerald-600">已确认</span> : <span className="text-amber-600">待确认</span>}
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <button onClick={(e) => { e.stopPropagation(); openEditRecord(r); }} title="修改日期"
                                    className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200">
                                    <Pencil className="w-3 h-3 text-blue-600" />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(r.id); }} title="删除"
                                    className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200">
                                    <Trash2 className="w-3 h-3 text-red-500" />
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
          id: editPlan.id, accountId: editPlan.accountId || "",
          fundCode: editPlan.fundCode || "", fundName: editPlan.fundName || null,
          amount: editPlan.amount, intervalUnit: editPlan.intervalUnit || "month",
          intervalValue: editPlan.intervalValue || 1, executionDay: editPlan.executionDay ?? null,
          startDate: editPlan.startDate ? new Date(editPlan.startDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          endDate: editPlan.endDate ? new Date(editPlan.endDate).toISOString().slice(0, 10) : null,
          totalRuns: editPlan.totalRuns ?? null, cashAccountId: editPlan.cashAccountId ?? null,
          feeRate: editPlan.feeRate ?? null, confirmDays: editPlan.confirmDays ?? null,
          arrivalDays: editPlan.arrivalDays ?? null,
          skipPendingPreceding: editPlan.skipPendingPreceding ?? true,
        } : undefined}
        accountId={editPlan?.accountId ?? investmentAccounts[0]?.id ?? ""}
        investmentAccounts={investmentAccounts} cashAccounts={cashAccounts}
        showTriggerButton={false} open={editOpen}
        onOpenChange={(v) => { setEditOpen(v); if (!v) setEditPlan(null); }}
        submitMethod="api" onSuccess={() => { setEditPlan(null); }}
      />

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">删除定投计划</div>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm text-slate-700">确认对「{deleteConfirm.planName}」的操作：</div>
              <div className="space-y-2">
                <button onClick={() => executeDelete(deleteConfirm.planId, "all")}
                  className="w-full h-9 rounded-md bg-red-600 text-white text-sm hover:bg-red-700">
                  删除计划 + 删除关联交易记录
                </button>
                <button onClick={() => executeDelete(deleteConfirm.planId, "plan")}
                  className="w-full h-9 rounded-md border border-amber-200 bg-amber-50 text-amber-700 text-sm hover:bg-amber-100">
                  仅删除计划，保留交易记录
                </button>
                <button onClick={() => executeDelete(deleteConfirm.planId, "records")}
                  className="w-full h-9 rounded-md border border-red-200 bg-red-50 text-red-600 text-sm hover:bg-red-100">
                  仅删除交易记录，保留计划
                </button>
                <button onClick={() => setDeleteConfirm(null)}
                  className="w-full h-9 rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:bg-slate-50">
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">修改交易明细日期</div>
              <button onClick={() => setEditingRecord(null)} className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">关闭</button>
            </div>
            <div className="p-4 space-y-3">
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">申请日期</div>
                <input type="date" value={editingRecord.date} onChange={(e) => {
                  const newDate = e.target.value;
                  setEditingRecord((r: any) => ({ ...r, date: newDate, fundConfirmDate: addWorkdaysUtc(newDate, editingRecord.confirmDays) }));
                }} className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                <div className="text-xs text-slate-400">修改申请日期会自动重算确认日期 (T+{editingRecord.confirmDays})</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">确认日期</div>
                <input type="date" value={editingRecord.fundConfirmDate} onChange={(e) => setEditingRecord((r: any) => ({ ...r, fundConfirmDate: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                <div className="text-xs text-slate-400">单独修改确认日期不会影响申请日期</div>
              </div>
              <div className="flex justify-end pt-1 gap-2">
                <button onClick={() => setEditingRecord(null)} className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">取消</button>
                <button onClick={handleSaveRecord} className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700">保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
