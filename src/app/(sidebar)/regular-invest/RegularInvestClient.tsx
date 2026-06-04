"use client";

import { useState, useEffect } from "react";
import { Play, Pause, Square, Trash2, Plus, Pencil, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { addWorkdaysUtc } from "@/lib/date-utils";

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

  function formatInterval(p: any): string {
    const base = INTERVAL_LABELS[p.intervalUnit] || p.intervalUnit;
    if (p.intervalUnit === "week" || p.intervalUnit === "biweek") {
      const weekday = WEEKDAY_LABELS[p.executionDay];
      if (weekday) return `${base}${weekday}`;
    }
    if (p.intervalUnit === "month" && p.executionDay) {
      return `每月${p.executionDay}号`;
    }
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
    initialPlans,
    investmentAccounts,
    cashAccounts,
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

    // 当 initialPlans 变化时（router.refresh 后），同步更新本地状态
    useEffect(() => {
      setPlans(initialPlans);
    }, [initialPlans]);

    // API action for unified form
  async function apiCreateAction(payload: any) {
    const res = await fetch("/api/v1/regular-invest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  async function handleSelectPlan(p: any) {
    if (selectedPlan?.id === p.id) {
      setSelectedPlan(null);
      setPlanRecords([]);
      return;
    }
    setSelectedPlan(p);
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/v1/regular-invest/records?planId=${encodeURIComponent(p.id)}`);
      const data = await res.json();
      if (data.ok) {
        setPlanRecords(data.records || []);
      } else {
        setPlanRecords([]);
      }
    } catch {
      setPlanRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }

  async function handleAction(planId: string, action: "pause" | "resume" | "stop") {
    const res = await fetch("/api/v1/regular-invest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: planId, action }),
    });
    const data = await res.json();
    if (data.ok) {
      // 立即更新本地状态
      setPlans((prevPlans) =>
        prevPlans.map((p) => {
          if (p.id !== planId) return p;
          const newStatus = action === "pause" ? "paused" : action === "resume" ? "active" : "stopped";
          return { ...p, status: newStatus };
        })
      );
    } else {
      window.alert(data.error || "操作失败");
    }
  }

  async function handleBatchExecute(planId: string) {
    if (!window.confirm("确认从开始日期批量执行定投计划吗？\n\n系统会自动生成所有到期但未执行的交易明细，已执行的不会重复生成。")) return;

    // 先扩充净值库（从计划开始日期到今天的净值数据）
    const plan = plans.find(p => p.id === planId);
    if (plan?.fundCode && plan?.startDate) {
      const startDate = new Date(plan.startDate).toISOString().slice(0, 10);
      const endDate = new Date().toISOString().slice(0, 10);
      const preloadRes = await fetch("/api/v1/fund/preload-nav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundCode: plan.fundCode, startDate, endDate }),
      });
      const preloadData = await preloadRes.json();
      if (!preloadData.ok) {
        window.alert(`扩充净值库失败：${preloadData.error}\n继续执行可能缺少净值数据。`);
        // 仍然继续执行（缓存中可能已有部分数据）
      }
    }

    const res = await fetch("/api/v1/regular-invest/batch-execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId }),
    });
    const data = await res.json();
    if (data.ok) {
      window.alert(data.message || "执行成功");

      // 更新本地计划统计数据
      if (data.stats) {
        setPlans((prevPlans) =>
          prevPlans.map((p) => {
            if (p.id !== planId) return p;
            return {
              ...p,
              executedCount: data.stats.executedCount,
              executedAmount: data.stats.executedAmount,
              confirmedCount: data.stats.confirmedCount,
              confirmedAmount: data.stats.confirmedAmount,
              executedRuns: data.stats.plan?.executedRuns ?? p.executedRuns,
              lastRunDate: data.stats.plan?.lastRunDate ?? p.lastRunDate,
              nextRunDate: data.stats.plan?.nextRunDate ?? p.nextRunDate,
              status: data.stats.plan?.status ?? p.status,
            };
          })
        );
      }
      // 刷新整个页面数据（持仓表也需要更新）
      router.refresh();
    } else {
      window.alert(data.error || "执行失败");
    }
  }

  async function handleBatchExecuteAll() {
    const activePlans = plans.filter((p) => p.status === "active");
    if (activePlans.length === 0) {
      window.alert("没有执行中的定投计划");
      return;
    }
    if (!window.confirm(`确认批量执行所有 ${activePlans.length} 个执行中的定投计划吗？\n\n系统会自动生成所有到期但未执行的交易明细，已执行的不会重复生成。`)) return;

    // 先为所有活跃计划扩充净值库
    const endDate = new Date().toISOString().slice(0, 10);
    for (const plan of activePlans) {
      if (plan.fundCode && plan.startDate) {
        const startDate = new Date(plan.startDate).toISOString().slice(0, 10);
        await fetch("/api/v1/fund/preload-nav", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fundCode: plan.fundCode, startDate, endDate }),
        });
      }
    }

    // 逐个执行所有活跃计划
    let successCount = 0;
    let failCount = 0;
    for (const plan of activePlans) {
      const res = await fetch("/api/v1/regular-invest/batch-execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = await res.json();
      if (data.ok) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount === 0) {
      window.alert(`批量执行完成，成功执行 ${successCount} 个计划`);
    } else {
      window.alert(`批量执行完成，成功 ${successCount} 个，失败 ${failCount} 个`);
    }
    router.refresh();
  }

  async function handleDelete(planId: string) {
    // 找到计划名称用于显示
    const plan = plans.find(p => p.id === planId);
    setDeleteConfirm({ planId, planName: plan ? `${plan.fundCode} ${plan.fundName || ''}` : '定投计划' });
  }

  async function executeDelete(planId: string, deleteRecords: boolean) {
    setDeleteConfirm(null);
    const res = await fetch(`/api/v1/regular-invest?id=${planId}&deleteRecords=${deleteRecords ? '1' : '0'}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      // 如果当前选中的计划是被删除的计划，关闭详情面板
      if (selectedPlan?.id === planId) {
        setSelectedPlan(null);
        setPlanRecords([]);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      router.refresh();
    } else {
      window.alert(data.error || "删除失败");
    }
  }

  async function refreshRecords() {
    if (!selectedPlan) return;
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/v1/regular-invest/records?planId=${encodeURIComponent(selectedPlan.id)}`);
      const data = await res.json();
      if (data.ok) {
        setPlanRecords(data.records || []);
      }
    } catch {
      // ignore
    } finally {
      setRecordsLoading(false);
    }
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

  function openEditRecord(r: any) {
    const dateStr = r.date ? new Date(r.date).toISOString().slice(0, 10) : "";
    const confirmDateStr = r.fundConfirmDate ? new Date(r.fundConfirmDate).toISOString().slice(0, 10) : "";
    setEditingRecord({
      id: r.id,
      date: dateStr,
      fundConfirmDate: confirmDateStr,
      confirmDays: selectedPlan?.confirmDays ?? 0,
      _originalDate: dateStr,
      _originalConfirmDate: confirmDateStr,
    });
  }

  async function handleSaveRecord() {
    if (!editingRecord) return;
    const payload: any = { id: editingRecord.id };

    if (editingRecord.date !== editingRecord._originalDate) {
      // 申请日期变了，自动重新计算确认日期
      payload.date = editingRecord.date;
      const newConfirmDateStr = addWorkdaysUtc(editingRecord.date, editingRecord.confirmDays);
      payload.fundConfirmDate = `${newConfirmDateStr}T00:00:00.000Z`;
    } else if (editingRecord.fundConfirmDate !== editingRecord._originalConfirmDate) {
      // 只有确认日期变了
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

  return (
    <>
      <div className="flex h-full w-full">
        <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
          <header className="shrink-0 border-b border-slate-200 bg-gradient-to-b from-slate-100 to-slate-50">
            <div className="h-12 flex items-center justify-end px-4 bg-white border-b border-slate-200">
              <RegularInvestForm
                accountId={investmentAccounts[0]?.id ?? ""}
                investmentAccounts={investmentAccounts}
                cashAccounts={cashAccounts}
                showTriggerButton={false}
                open={showCreateForm}
                onOpenChange={setShowCreateForm}
                apiAction={apiCreateAction}
              />
              <button
                onClick={handleBatchExecuteAll}
                title="批量执行所有定投计划"
                className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-1"
              >
                <RefreshCw className="w-4 h-4" />
                执行全部
              </button>
              <button
                onClick={() => setShowCreateForm(true)}
                className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                新增计划
              </button>
            </div>
            <div className="h-11 flex items-center justify-between px-4 bg-slate-50">
              <div className="flex items-center gap-3 text-sm">
                <span className="font-semibold text-slate-800">定投计划</span>
                <span className="text-slate-500">
                  共 {plans.length} 个计划，{plans.filter((p) => p.status === "active").length} 个执行中
                </span>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-auto bg-white">
            <table className="min-w-full w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">
                    基金
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    开始日期
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    基金账户
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    资金账户
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    间隔
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    状态
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    下次执行
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    已执行
                  </th>
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    已确认
                  </th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {plans.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-slate-500" colSpan={10}>
                      暂无定投计划
                    </td>
                  </tr>
                ) : (
                  plans.map((p) => (
                    <tr key={p.id} className={`hover:bg-slate-50 cursor-pointer ${selectedPlan?.id === p.id ? "bg-blue-50" : ""}`} onClick={() => handleSelectPlan(p)}>
                      <td className="px-4 py-2 border-b border-slate-100 text-xs">
                        <div className="flex items-baseline gap-2">
                          <span className="text-slate-900 font-medium">{p.fundCode}</span>
                          <span className="text-slate-500 truncate max-w-[200px]">{p.fundName}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">
                        {p.startDate ? new Date(p.startDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">
                        {p.accountName}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">
                        {p.cashAccountName || "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">
                        {formatInterval(p)}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs">
                        <span className={STATUS_MAP[p.status]?.cls || "text-slate-600"}>
                          {STATUS_MAP[p.status]?.label || p.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-500">
                        {p.nextRunDate ? new Date(p.nextRunDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-700">
                        {p.executedCount || 0}期 ({(p.executedAmount || 0).toFixed(2)})
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-700">
                        {p.confirmedCount || 0}期 ({(p.confirmedAmount || 0).toFixed(2)})
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {p.status === "active" && (
                            <>
                              <button
                                onClick={() => handleBatchExecute(p.id)}
                                title="批量执行"
                                className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-purple-50 hover:border-purple-200"
                              >
                                <RefreshCw className="w-3.5 h-3.5 text-purple-600" />
                              </button>
                              <button
                                onClick={() => handleAction(p.id, "pause")}
                                title="暂停"
                                className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-yellow-50 hover:border-yellow-200"
                              >
                                <Pause className="w-3.5 h-3.5 text-yellow-600" />
                              </button>
                              <button
                                onClick={() => handleAction(p.id, "stop")}
                                title="终止"
                                className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200"
                              >
                                <Square className="w-3.5 h-3.5 text-red-600" />
                              </button>
                            </>
                          )}
                          {p.status === "paused" && (
                            <button
                              onClick={() => handleAction(p.id, "resume")}
                              title="恢复"
                              className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-green-50 hover:border-green-200"
                            >
                              <Play className="w-3.5 h-3.5 text-green-600" />
                            </button>
                          )}
                          <button
                            onClick={() => { setEditPlan(p); setEditOpen(true); }}
                            title="修改"
                            className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200"
                          >
                            <Pencil className="w-3.5 h-3.5 text-blue-600" />
                          </button>
                          <button
                            onClick={() => handleDelete(p.id)}
                            title="删除"
                            className="h-7 w-7 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* 选中的定投计划关联记录 */}
          {selectedPlan && (
            <div className="border-t border-slate-200 bg-slate-50">
              <div className="h-10 flex items-center justify-between px-4 bg-white border-b border-slate-100">
                <div className="text-xs font-semibold text-slate-700">
                  {selectedPlan.fundCode} {selectedPlan.fundName} - 交易明细
                </div>
                <button
                  onClick={() => { setSelectedPlan(null); setPlanRecords([]); }}
                  className="text-xs text-slate-400 hover:text-slate-600"
                >
                  关闭
                </button>
              </div>
              <div className="overflow-auto max-h-[300px]">
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
                            <td className="px-3 py-1.5 text-right text-slate-700 tabular-nums">{Math.abs(Number(r.amount)).toFixed(2)}</td>
                            <td className="px-3 py-1.5 text-right text-slate-700 tabular-nums">{isConfirmed ? Number(r.fundUnits).toFixed(2) : "-"}</td>
                            <td className="px-3 py-1.5 text-center">
                              {isConfirmed
                                ? <span className="text-emerald-600">已确认</span>
                                : <span className="text-amber-600">待确认</span>
                              }
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  onClick={(e) => { e.stopPropagation(); openEditRecord(r); }}
                                  title="修改日期"
                                  className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-blue-50 hover:border-blue-200"
                                >
                                  <Pencil className="w-3 h-3 text-blue-600" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDeleteRecord(r.id); }}
                                  title="删除"
                                  className="h-6 w-6 flex items-center justify-center rounded border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200"
                                >
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

      {/* 编辑定投计划 */}
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
        } : undefined}
        accountId={editPlan?.accountId ?? investmentAccounts[0]?.id ?? ""}
        investmentAccounts={investmentAccounts}
        cashAccounts={cashAccounts}
        showTriggerButton={false}
        open={editOpen}
        onOpenChange={(v) => { setEditOpen(v); if (!v) setEditPlan(null); }}
        submitMethod="api"
        onSuccess={() => { setEditPlan(null); }}
      />

      {/* 删除定投计划确认弹窗 */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">删除定投计划</div>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-sm text-slate-700">
                确认删除定投计划「{deleteConfirm.planName}」吗？
              </div>
              <div className="text-xs text-slate-500">
                请选择如何处理关联的交易明细：
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => executeDelete(deleteConfirm.planId, true)}
                  className="w-full h-9 rounded-md bg-red-600 text-white text-sm hover:bg-red-700"
                >
                  删除计划 + 删除所有交易记录
                </button>
                <button
                  onClick={() => executeDelete(deleteConfirm.planId, false)}
                  className="w-full h-9 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                >
                  仅删除计划，保留交易记录
                </button>
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="w-full h-9 rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:bg-slate-50"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 编辑交易明细弹窗 */}
      {editingRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">修改交易明细日期</div>
              <button
                onClick={() => setEditingRecord(null)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
              >
                关闭
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">申请日期</div>
                <input
                  type="date"
                  value={editingRecord.date}
                  onChange={(e) => {
                    const newDate = e.target.value;
                    const newConfirmDate = addWorkdaysUtc(newDate, editingRecord.confirmDays);
                    setEditingRecord((r: any) => ({ ...r, date: newDate, fundConfirmDate: newConfirmDate }));
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
                  onChange={(e) => setEditingRecord((r: any) => ({ ...r, fundConfirmDate: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
                <div className="text-xs text-slate-400">单独修改确认日期不会影响申请日期</div>
              </div>
              <div className="flex justify-end pt-1 gap-2">
                <button
                  onClick={() => setEditingRecord(null)}
                  className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveRecord}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}