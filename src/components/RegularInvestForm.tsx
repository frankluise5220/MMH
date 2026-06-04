"use client";

import { Plus } from "lucide-react";
import { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_LABELS: Record<string, string> = {
  day: "每天",
  week: "每周",
  biweek: "每两周",
  month: "每月",
};

type SaveAction = (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
type ApiAction = (payload: any) => Promise<{ ok: boolean; error?: string; message?: string }>;

interface RegularInvestFormData {
  accountId: string;
  fundCode: string;
  fundName: string;
  amount: string;
  intervalUnit: string;
  intervalValue: string;
  startDate: string;
  endDate: string;
  totalRuns: string;
  executionDay: string;
  cashAccountId: string;
  feeRate: string;
  confirmDays: string;
  skipPendingPreceding: boolean;
}

interface EditData {
  id: string;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  amount: number;
  intervalUnit: string;
  intervalValue: number;
  executionDay: number | null;
  startDate: string;
  endDate: string | null;
  totalRuns: number | null;
  cashAccountId: string | null;
  feeRate: number | null;
  confirmDays: number | null;
  skipPendingPreceding: boolean;
}

/**
 * 统一的定投计划表单组件（新增 + 修改）
 *
 * 支持两种模式：
 * - create: 新增定投计划
 * - edit: 修改定投计划（基金代码不可改）
 *
 * 支持两种提交方式：
 * 1. Server Action（主页）— action prop + submitMethod="serverAction"
 * 2. API 方式（定投计划页面）— submitMethod="api"（默认）
 */
export function RegularInvestForm({
  accountId,
  accountLabel,
  investmentAccounts,
  cashAccounts,
  prefilledFundCode,
  prefilledFundName,
  lastUsedCashAccountId,
  showTriggerButton = true,
  open,
  onOpenChange,
  action,
  apiAction,
  mode = "create",
  editData,
  editAccountLabel,
  submitMethod = "api",
  onSuccess,
}: {
  accountId: string;
  accountLabel?: string;
  investmentAccounts?: { id: string; name: string; label: string }[];
  cashAccounts?: { id: string; label: string }[];
  prefilledFundCode?: string;
  prefilledFundName?: string | null;
  lastUsedCashAccountId?: string | null;
  showTriggerButton?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  action?: SaveAction;
  apiAction?: ApiAction;
  mode?: "create" | "edit";
  editData?: EditData;
  editAccountLabel?: string;
  submitMethod?: "serverAction" | "api";
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [internalOpen, setInternalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nameLoading, setNameLoading] = useState(false);

  const actualOpen = showTriggerButton ? internalOpen : open ?? false;
  const setActualOpen = showTriggerButton ? setInternalOpen : onOpenChange ?? (() => {});

  function getDefaultFormData(): RegularInvestFormData {
    if (mode === "edit" && editData) {
      return {
        accountId: editData.accountId || "",
        fundCode: editData.fundCode || "",
        fundName: editData.fundName || editData.fundCode || "",
        amount: String(editData.amount || ""),
        intervalUnit: editData.intervalUnit || "month",
        intervalValue: String(editData.intervalValue || 1),
        startDate: editData.startDate ? new Date(editData.startDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        endDate: editData.endDate ? new Date(editData.endDate).toISOString().slice(0, 10) : "",
        totalRuns: editData.totalRuns != null ? String(editData.totalRuns) : "",
        executionDay: editData.executionDay != null ? String(editData.executionDay) : "",
        cashAccountId: editData.cashAccountId || "",
        feeRate: editData.feeRate != null ? String(editData.feeRate) : "0",
        confirmDays: editData.confirmDays != null ? String(editData.confirmDays) : "1",
        skipPendingPreceding: editData.skipPendingPreceding !== undefined ? editData.skipPendingPreceding : true,
      };
    }
    return {
      accountId: investmentAccounts && investmentAccounts.length > 0 ? "" : accountId,
      fundCode: prefilledFundCode ?? "",
      fundName: prefilledFundName ?? "",
      amount: "",
      intervalUnit: "month",
      intervalValue: "1",
      startDate: new Date().toISOString().slice(0, 10),
      endDate: "",
      totalRuns: "",
      executionDay: "",
      cashAccountId: lastUsedCashAccountId ?? "",
      feeRate: "0",
      confirmDays: "1",
      skipPendingPreceding: true,
    };
  }

  const [formData, setFormData] = useState<RegularInvestFormData>(getDefaultFormData);

  useEffect(() => {
    setFormData(getDefaultFormData());
  }, [editData, mode]);

  async function handleFundCodeBlur() {
    const code = formData.fundCode.trim();
    if (!code || code.length !== 6) {
      setFormData(d => ({ ...d, fundName: "" }));
      return;
    }

    if (mode === "edit" && editData && code === editData.fundCode && editData.fundName) {
      return;
    }

    setNameLoading(true);
    try {
      const res = await fetch(`/api/v1/fund/name?code=${code}`);
      const data = await res.json();
      if (data.ok && data.name) {
        setFormData(f => ({ ...f, fundName: data.name }));
      } else {
        setFormData(f => ({ ...f, fundName: "" }));
      }
    } finally {
      setNameLoading(false);
    }

    if (!formData.accountId) return;

    fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(formData.accountId)}&fundCode=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.days != null) {
          setFormData(f => ({ ...f, confirmDays: String(d.days) }));
        } else {
          setFormData(f => ({ ...f, confirmDays: "1" }));
        }
      })
      .catch(() => {
        setFormData(f => ({ ...f, confirmDays: "1" }));
      });

    fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(formData.accountId)}&fundCode=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.rate != null) {
          setFormData(f => ({ ...f, feeRate: String(d.rate) }));
        } else {
          setFormData(f => ({ ...f, feeRate: "0" }));
        }
      })
      .catch(() => {
        setFormData(f => ({ ...f, feeRate: "0" }));
      });
  }

  async function fetchFundName(code: string) {
    if (!code || code.length !== 6) return;
    setNameLoading(true);
    try {
      const res = await fetch(`/api/v1/fund/name?code=${code}`);
      const data = await res.json();
      if (data.ok && data.name) {
        setFormData(f => ({ ...f, fundName: data.name }));
      } else {
        setFormData(f => ({ ...f, fundName: "" }));
      }
    } finally {
      setNameLoading(false);
    }
  }

  function resetForm() {
    setFormData(getDefaultFormData());
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const finalAmount = parseFloat(formData.amount);
    if (!finalAmount || finalAmount <= 0) {
      window.alert("请输入正确的金额");
      return;
    }

    if (!formData.accountId) {
      window.alert("请选择基金账户");
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "edit" && editData) {
        if (submitMethod === "serverAction" && action) {
          // Server Action 方式（主页）
          const fd = new FormData();
          fd.set("intent", "updateRegularInvest");
          fd.set("planId", editData.id);
          fd.set("accountId", formData.accountId);
          fd.set("fundName", formData.fundName.trim() || formData.fundCode);
          fd.set("amount", String(finalAmount));
          fd.set("intervalUnit", formData.intervalUnit);
          fd.set("intervalValue", formData.intervalValue);
          fd.set("startDate", formData.startDate);
          fd.set("endDate", formData.endDate || "");
          fd.set("totalRuns", formData.totalRuns || "");
          fd.set("executionDay", formData.executionDay || "");
          fd.set("cashAccountId", formData.cashAccountId || "");
          fd.set("feeRate", formData.feeRate.trim() ? formData.feeRate : "");
          fd.set("confirmDays", formData.confirmDays.trim() ? formData.confirmDays : "");
          fd.set("skipPendingPreceding", formData.skipPendingPreceding ? "true" : "false");
          const res = await action(fd);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
        } else {
          // API 方式（定投计划页面）— 直接调 PUT
          const payload = {
            id: editData.id,
            accountId: formData.accountId,
            fundName: formData.fundName || formData.fundCode,
            amount: finalAmount,
            intervalUnit: formData.intervalUnit,
            intervalValue: parseInt(formData.intervalValue) || 1,
            executionDay: formData.executionDay.trim() ? parseInt(formData.executionDay) : null,
            startDate: formData.startDate,
            endDate: formData.endDate || null,
            totalRuns: formData.totalRuns.trim() ? parseInt(formData.totalRuns) : null,
            cashAccountId: formData.cashAccountId || null,
            feeRate: formData.feeRate.trim() ? parseFloat(formData.feeRate) : 0,
            confirmDays: formData.confirmDays !== "" ? parseInt(formData.confirmDays) : 1,
            skipPendingPreceding: formData.skipPendingPreceding,
            action: "update",
          };
          const res = await fetch("/api/v1/regular-invest", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!data.ok) {
            window.alert(data.error || "保存失败");
            return;
          }
        }

        setActualOpen(false);
        onSuccess?.();
        await new Promise(resolve => setTimeout(resolve, 100));
        router.refresh();
      } else {
        // 新增模式
        if (action) {
          const fd = new FormData();
          fd.set("intent", "createRegularInvest");
          fd.set("accountId", formData.accountId);
          fd.set("fundCode", formData.fundCode.trim());
          fd.set("fundName", formData.fundName.trim() || formData.fundCode.trim());
          fd.set("amount", String(finalAmount));
          fd.set("intervalUnit", formData.intervalUnit);
          fd.set("intervalValue", formData.intervalValue);
          fd.set("startDate", formData.startDate);
          fd.set("endDate", formData.endDate || "");
          fd.set("totalRuns", formData.totalRuns || "");
          fd.set("executionDay", formData.executionDay || "");
          fd.set("cashAccountId", formData.cashAccountId || "");
          fd.set("feeRate", formData.feeRate.trim() ? formData.feeRate : "");
          fd.set("confirmDays", formData.confirmDays.trim() ? formData.confirmDays : "");
          fd.set("skipPendingPreceding", formData.skipPendingPreceding ? "true" : "false");

          const res = await action(fd);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
          setActualOpen(false);
          resetForm();
          await new Promise(resolve => setTimeout(resolve, 100));
          router.refresh();
        } else if (apiAction) {
          const payload = {
            accountId: formData.accountId,
            fundCode: formData.fundCode,
            fundName: formData.fundName || formData.fundCode,
            amount: finalAmount,
            intervalUnit: formData.intervalUnit,
            intervalValue: parseInt(formData.intervalValue) || 1,
            executionDay: formData.executionDay.trim() ? parseInt(formData.executionDay) : null,
            startDate: formData.startDate,
            endDate: formData.endDate || null,
            totalRuns: formData.totalRuns.trim() ? parseInt(formData.totalRuns) : null,
            cashAccountId: formData.cashAccountId || null,
            feeRate: formData.feeRate.trim() ? parseFloat(formData.feeRate) : 0,
            confirmDays: formData.confirmDays !== "" ? parseInt(formData.confirmDays) : 1,
            skipPendingPreceding: formData.skipPendingPreceding,
          };

          const res = await apiAction(payload);
          setActualOpen(false);
          resetForm();
          router.refresh();
        }
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "edit" ? "修改定投计划" : "新增定投计划";

  // edit 模式下的账户显示标签
  const displayAccountLabel = mode === "edit" ? (editAccountLabel ?? accountLabel) : accountLabel;

  return (
    <>
      {showTriggerButton && mode === "create" && (
        <button
          type="button"
          onClick={() => { resetForm(); setActualOpen(true); }}
          className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" />
          定投
        </button>
      )}

      {actualOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">{title}</div>
              <button
                type="button"
                onClick={() => setActualOpen(false)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
              >
                关闭
              </button>
            </div>

            <form className="p-4 space-y-3 overflow-y-auto max-h-[80vh]" onSubmit={onSubmit}>
              {/* 基金账户和资金来源账户 */}
              <div className="grid grid-cols-2 gap-3">
                {investmentAccounts && investmentAccounts.length > 0 ? (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金账户</div>
                    <select
                      value={formData.accountId}
                      onChange={(e) => setFormData(d => ({ ...d, accountId: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      <option value="">选择账户</option>
                      {investmentAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.label}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">基金账户</div>
                    <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 flex items-center">
                      {displayAccountLabel}
                    </div>
                  </div>
                )}
                {cashAccounts && cashAccounts.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">资金来源账户</div>
                    <select
                      value={formData.cashAccountId}
                      onChange={(e) => setFormData(d => ({ ...d, cashAccountId: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      <option value="">不关联</option>
                      {cashAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.label}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* 基金代码和名称 */}
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">基金代码</div>
                  {mode === "edit" ? (
                    <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 flex items-center">{formData.fundCode}</div>
                  ) : (
                    <input
                      value={formData.fundCode}
                      onChange={(e) => setFormData(d => ({ ...d, fundCode: e.target.value }))}
                      onBlur={handleFundCodeBlur}
                      placeholder="6位代码"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  )}
                </div>
                {mode === "create" && (
                  <button
                    type="button"
                    onClick={() => fetchFundName(formData.fundCode)}
                    disabled={nameLoading || !formData.fundCode}
                    className="h-9 px-2 rounded-md border border-slate-200 bg-white text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 shrink-0"
                  >
                    {nameLoading ? "…" : "获取"}
                  </button>
                )}
                {mode === "edit" && <div />}
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    基金名称{nameLoading && <span className="ml-1 text-slate-400 font-normal">获取中…</span>}
                  </div>
                  <input
                    value={formData.fundName}
                    onChange={(e) => setFormData(d => ({ ...d, fundName: e.target.value }))}
                    placeholder={formData.fundCode?.length === 6 && !formData.fundName && !nameLoading ? "获取失败" : ""}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
              </div>

              {/* 定投金额 + 手续费率 + 确认天数 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">定投金额</div>
                  <input
                    inputMode="decimal"
                    value={formData.amount}
                    onChange={(e) => setFormData(d => ({ ...d, amount: e.target.value }))}
                    placeholder="0.00"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">手续费率 (%)</div>
                  <input
                    inputMode="decimal"
                    step="0.001"
                    value={formData.feeRate}
                    onChange={(e) => setFormData(d => ({ ...d, feeRate: e.target.value }))}
                    placeholder="默认0"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">确认天数 T+N</div>
                  <input
                    inputMode="numeric"
                    min="0"
                    value={formData.confirmDays}
                    onChange={(e) => setFormData(d => ({ ...d, confirmDays: e.target.value }))}
                    placeholder="默认1"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
              </div>

              {/* 定投间隔 + 周期数 + 执行日 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">定投间隔</div>
                  <select
                    value={formData.intervalUnit}
                    onChange={(e) => setFormData(d => ({ ...d, intervalUnit: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  >
                    {Object.entries(INTERVAL_LABELS).map(([v, l]) => (
                      <option key={v} value={v}>{l}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">周期数</div>
                  <input
                    inputMode="numeric"
                    min="1"
                    value={formData.intervalValue}
                    onChange={(e) => setFormData(d => ({ ...d, intervalValue: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">执行日</div>
                  {formData.intervalUnit === "day" ? (
                    <input
                      type="text"
                      value="每日执行"
                      disabled
                      className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 cursor-not-allowed"
                    />
                  ) : formData.intervalUnit === "week" || formData.intervalUnit === "biweek" ? (
                    <select
                      value={formData.executionDay}
                      onChange={(e) => setFormData(d => ({ ...d, executionDay: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      <option value="">不指定</option>
                      <option value="1">周一</option>
                      <option value="2">周二</option>
                      <option value="3">周三</option>
                      <option value="4">周四</option>
                      <option value="5">周五</option>
                    </select>
                  ) : (
                    <select
                      value={formData.executionDay}
                      onChange={(e) => setFormData(d => ({ ...d, executionDay: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      <option value="">不指定</option>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                        <option key={day} value={day}>{day}号</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* 起始日期 + 停止日期 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">起始日期</div>
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData(d => ({ ...d, startDate: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">停止日期（可选）</div>
                  <input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) => setFormData(d => ({ ...d, endDate: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
              </div>

              {/* 总次数 */}
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">总次数（可选）</div>
                <input
                  inputMode="numeric"
                  min="1"
                  value={formData.totalRuns}
                  onChange={(e) => setFormData(d => ({ ...d, totalRuns: e.target.value }))}
                  placeholder="不限"
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
              </div>

              {/* 跳过间隙选项 */}
              <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" checked={formData.skipPendingPreceding}
                  onChange={(e) => setFormData(d => ({ ...d, skipPendingPreceding: e.target.checked }))}
                  className="w-3.5 h-3.5 accent-blue-600" />
                跳过无净值间隙（如某日无净值但次日有则跳过该日）
              </label>

              {/* 保存按钮 */}
              <div className="flex justify-end pt-1 gap-2">
                <button
                  type="button"
                  onClick={() => setActualOpen(false)}
                  className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}