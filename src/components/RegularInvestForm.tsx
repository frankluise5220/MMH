"use client";

import { ArrowLeftRight, ArrowRight, CalendarPlus } from "lucide-react";
import { useState, useEffect, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./TransactionFormModal";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";
import { scheduledTaskTypeLabel, type ScheduledTaskType } from "@/lib/scheduled-task";

const INTERVAL_LABELS: Record<string, string> = {
  day: "每天",
  week: "每周",
  biweek: "每两周",
  month: "每月",
};

const TASK_TYPE_OPTIONS: Array<{ value: ScheduledTaskType; label: string }> = [
  { value: "fund_regular_invest", label: "基金定投" },
  { value: "loan_repayment", label: "还贷款" },
  { value: "transfer", label: "转账" },
  { value: "insurance_premium", label: "缴费" },
];

type SaveAction = (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
type ApiAction = (payload: any) => Promise<{ ok: boolean; error?: string; message?: string }>;
type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

function toDateInput(value?: string | Date | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}

function stripDefaultGroupLabel(label?: string) {
  return (label ?? "").trim().replace(new RegExp(`^${"\u6240\u6709\u4eba"}\\s*[/\uFF0F]\\s*`), "");
}

function stripDefaultGroupOptions(options: SmartSelectOption[]) {
  const defaultGroupName = "\u6240\u6709\u4eba";
  const defaultGroupIds = new Set(
    options
      .filter((option) => option.isHeader && option.label.trim() === defaultGroupName)
      .map((option) => option.id),
  );

  if (defaultGroupIds.size === 0) return options;

  return options
    .filter((option) => !(option.isHeader && defaultGroupIds.has(option.id)))
    .map((option) => defaultGroupIds.has(option.parentId ?? "") ? { ...option, parentId: undefined } : option);
}

interface RegularInvestFormData {
  taskType: ScheduledTaskType;
  accountId: string;
  fundCode: string;
  fundName: string;
  insuranceProductId: string;
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
  arrivalDays: string;
  skipPendingPreceding: boolean;
}

interface EditData {
  id: string;
  taskType?: ScheduledTaskType;
  taskInsuranceProductId?: string | null;
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
  arrivalDays: number | null;
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
  loanAccounts,
  transferTargetAccounts,
  insuranceProductOptions,
  investmentAccountSSOptions,
  cashAccountSSOptions,
  transferTargetAccountSSOptions,
  nestedFieldData,
  prefilledFundCode,
  prefilledFundName,
  prefilledCashAccountId,
  prefilledFeeRate,
  prefilledConfirmDays,
  prefilledArrivalDays,
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
  cashAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  loanAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  transferTargetAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  insuranceProductOptions?: { id: string; label: string; accountId: string; accountLabel?: string | null; subLabel?: string | null }[];
  /** Hierarchical SmartSelect options for investment account dropdown (grouped by AccountGroup) */
  investmentAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for cash account dropdown (grouped by AccountGroup) */
  cashAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for transfer target account dropdown (grouped by AccountGroup) */
  transferTargetAccountSSOptions?: SmartSelectOption[];
  /** Groups & institutions data for nested account creation inside SmartSelect. */
  nestedFieldData?: NestedFieldData;
  prefilledFundCode?: string;
  prefilledFundName?: string | null;
  prefilledCashAccountId?: string | null;
  prefilledFeeRate?: number | string | null;
  prefilledConfirmDays?: number | null;
  prefilledArrivalDays?: number | null;
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
  const [cashAccountList, setCashAccountList] = useState(cashAccounts ?? []);
  const [investmentAccountList, setInvestmentAccountList] = useState(investmentAccounts ?? []);
  const [loanAccountList, setLoanAccountList] = useState(loanAccounts ?? []);
  const [transferTargetAccountList, setTransferTargetAccountList] = useState(transferTargetAccounts ?? []);
  const [localCashSSOptions, setLocalCashSSOptions] = useState(cashAccountSSOptions);
  const [localInvestmentSSOptions, setLocalInvestmentSSOptions] = useState(investmentAccountSSOptions);
  const [localTransferTargetSSOptions, setLocalTransferTargetSSOptions] = useState(transferTargetAccountSSOptions);

  const { ownerFilter: cfOwnerFilter, ownerFilterLabel: cfLabel, cycleOwnerFilter: cfCycle, filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOptions);
  const { ownerFilterLabel: ifLabel, cycleOwnerFilter: ifCycle, filteredOptions: investFiltered } = useAccountSSFilter(localInvestmentSSOptions);
  const { filteredOptions: transferTargetFiltered } = useAccountSSFilter(localTransferTargetSSOptions, cfOwnerFilter);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "invest-account" | null>(null);

  const actualOpen = showTriggerButton ? internalOpen : open ?? false;
  const setActualOpen = showTriggerButton ? setInternalOpen : onOpenChange ?? (() => {});

  function getDefaultFormData(): RegularInvestFormData {
    if (mode === "edit" && editData) {
      return {
        taskType: editData.taskType ?? "fund_regular_invest",
        accountId: editData.accountId || "",
        fundCode: editData.fundCode || "",
        fundName: editData.fundName || editData.fundCode || "",
        insuranceProductId: editData.taskInsuranceProductId || "",
        amount: String(editData.amount || ""),
        intervalUnit: editData.intervalUnit || "day",
        intervalValue: String(editData.intervalValue || 1),
        startDate: toDateInput(editData.startDate) || todayInput(),
        endDate: toDateInput(editData.endDate),
        totalRuns: editData.totalRuns != null ? String(editData.totalRuns) : "",
        executionDay: editData.executionDay != null ? String(editData.executionDay) : "",
        cashAccountId: editData.cashAccountId || "",
        feeRate: editData.feeRate != null ? String(editData.feeRate) : "0",
        confirmDays: editData.confirmDays != null ? String(editData.confirmDays) : "1",
        arrivalDays: editData.arrivalDays != null ? String(editData.arrivalDays) : "2",
        skipPendingPreceding: editData.skipPendingPreceding !== undefined ? editData.skipPendingPreceding : true,
      };
    }
    return {
      taskType: "fund_regular_invest",
      accountId: investmentAccounts && investmentAccounts.length > 0 ? "" : accountId,
      fundCode: prefilledFundCode ?? "",
      fundName: prefilledFundName ?? "",
      insuranceProductId: "",
      amount: "",
      intervalUnit: "day",
      intervalValue: "1",
      startDate: todayInput(),
      endDate: "",
      totalRuns: "",
      executionDay: "",
      cashAccountId: prefilledCashAccountId ?? lastUsedCashAccountId ?? "",
      feeRate: prefilledFeeRate != null ? String(prefilledFeeRate) : "0",
      confirmDays: prefilledConfirmDays != null ? String(prefilledConfirmDays) : "1",
      arrivalDays: prefilledArrivalDays != null ? String(prefilledArrivalDays) : "2",
      skipPendingPreceding: true,
    };
  }

  const [formData, setFormData] = useState<RegularInvestFormData>(getDefaultFormData);

  useEffect(() => {
    setFormData(getDefaultFormData());
  }, [editData, mode]);

  useEffect(() => { setCashAccountList(cashAccounts ?? []); }, [cashAccounts]);
  useEffect(() => { setInvestmentAccountList(investmentAccounts ?? []); }, [investmentAccounts]);
  useEffect(() => { setLoanAccountList(loanAccounts ?? []); }, [loanAccounts]);
  useEffect(() => { setTransferTargetAccountList(transferTargetAccounts ?? []); }, [transferTargetAccounts]);
  useEffect(() => { setLocalCashSSOptions(cashAccountSSOptions); }, [cashAccountSSOptions]);
  useEffect(() => { setLocalInvestmentSSOptions(investmentAccountSSOptions); }, [investmentAccountSSOptions]);
  useEffect(() => { setLocalTransferTargetSSOptions(transferTargetAccountSSOptions); }, [transferTargetAccountSSOptions]);

  useEffect(() => {
    if (!actualOpen || mode !== "create") return;
    const code = (prefilledFundCode ?? formData.fundCode).trim();
    const investAccountId = formData.accountId || accountId;
    if (!code || code.length !== 6 || !investAccountId) return;

    let cancelled = false;

    fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(investAccountId)}&fundCode=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.ok && d.days != null) {
          setFormData(f => ({ ...f, confirmDays: String(d.days), arrivalDays: String(d.arrivalDays ?? 2) }));
        }
      })
      .catch(() => {});

    fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(investAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=buy`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.ok && d.rate != null) {
          setFormData(f => ({ ...f, feeRate: String(d.rate) }));
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [actualOpen, mode, prefilledFundCode, accountId, formData.accountId, formData.fundCode]);

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
          setFormData(f => ({ ...f, confirmDays: String(d.days), arrivalDays: String(d.arrivalDays ?? 2) }));
        } else {
          setFormData(f => ({ ...f, confirmDays: "1", arrivalDays: "2" }));
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
      window.alert(`请选择${formData.taskType === "fund_regular_invest" ? "基金账户" : formData.taskType === "loan_repayment" ? "贷款账户" : formData.taskType === "insurance_premium" ? "保险产品" : "目标账户"}`);
      return;
    }
    if (formData.taskType === "fund_regular_invest" && !formData.fundCode.trim()) {
      window.alert("请输入基金代码");
      return;
    }
    if (formData.taskType === "insurance_premium" && !formData.insuranceProductId) {
      window.alert("请选择保险产品");
      return;
    }
    if ((formData.taskType === "transfer" || formData.taskType === "loan_repayment" || formData.taskType === "insurance_premium") && !formData.cashAccountId) {
      window.alert("请选择资金账户");
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
          fd.set("arrivalDays", formData.arrivalDays.trim() ? formData.arrivalDays : "");
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
            taskType: formData.taskType,
            insuranceProductId: formData.insuranceProductId || null,
            accountId: formData.accountId,
            fundCode: formData.taskType === "fund_regular_invest" ? formData.fundCode : formData.taskType,
            fundName: formData.fundName || formData.fundCode || scheduledTaskTypeLabel(formData.taskType),
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
            arrivalDays: formData.arrivalDays !== "" ? parseInt(formData.arrivalDays) : 2,
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
          fd.set("arrivalDays", formData.arrivalDays.trim() ? formData.arrivalDays : "");
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
            taskType: formData.taskType,
            insuranceProductId: formData.insuranceProductId || null,
            fundCode: formData.taskType === "fund_regular_invest" ? formData.fundCode : formData.taskType,
            fundName: formData.fundName || formData.fundCode || scheduledTaskTypeLabel(formData.taskType),
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
            arrivalDays: formData.arrivalDays !== "" ? parseInt(formData.arrivalDays) : 2,
            skipPendingPreceding: formData.skipPendingPreceding,
          };

          const res = await apiAction(payload);
          if (!res.ok) {
            window.alert(res.error || res.message || "保存失败");
            return;
          }
          setActualOpen(false);
          resetForm();
          router.refresh();
        } else {
          window.alert("保存入口未配置");
        }
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "edit" ? "修改计划任务" : "新增计划任务";

  // edit 模式下的账户显示标签
  const displayAccountLabel = stripDefaultGroupLabel(mode === "edit" ? (editAccountLabel ?? accountLabel) : accountLabel);
  const investmentOptions = investFiltered
    ? stripDefaultGroupOptions(investFiltered)
    : investmentAccountList.map(a => ({ id: a.id, label: stripDefaultGroupLabel(a.label), subLabel: (a as { subLabel?: string }).subLabel }));
  const cashOptions = cashFiltered ?? cashAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel }));
  const loanOptions = loanAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel }));
  const transferTargetOptions = transferTargetFiltered ?? transferTargetAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel }));
  const insuranceOptions = (insuranceProductOptions ?? []).map(item => ({ id: item.id, label: item.label, subLabel: item.subLabel ?? item.accountLabel ?? undefined }));
  const selectedInsuranceProduct = (insuranceProductOptions ?? []).find((item) => item.id === formData.insuranceProductId) ?? null;
  const isFundTask = formData.taskType === "fund_regular_invest";
  const isLoanTask = formData.taskType === "loan_repayment";
  const isTransferTask = formData.taskType === "transfer";
  const isInsuranceTask = formData.taskType === "insurance_premium";

  function handleTaskTypeChange(taskType: ScheduledTaskType) {
    setFormData((prev) => ({
      ...prev,
      taskType,
      accountId: taskType === "fund_regular_invest" ? "" : taskType === "loan_repayment" ? "" : taskType === "transfer" ? "" : selectedInsuranceProduct?.accountId ?? "",
      fundCode: taskType === "fund_regular_invest" ? prev.fundCode : taskType,
      fundName: taskType === "fund_regular_invest" ? prev.fundName : scheduledTaskTypeLabel(taskType),
      insuranceProductId: taskType === "insurance_premium" ? prev.insuranceProductId : "",
      feeRate: taskType === "fund_regular_invest" ? prev.feeRate : "0",
      confirmDays: taskType === "fund_regular_invest" ? prev.confirmDays : "0",
      arrivalDays: taskType === "fund_regular_invest" ? prev.arrivalDays : "0",
      skipPendingPreceding: taskType === "fund_regular_invest" ? prev.skipPendingPreceding : false,
    }));
  }

  function handleNestedAccountCreated(id: string, name: string, extra?: { kind?: string }) {
    const kind = extra?.kind ?? (nestedEntityType === "cash-account" ? "bank_debit" : "investment");
    const option = { id, label: name, subLabel: kindLabel(kind) };

    if (nestedEntityType === "cash-account") {
      setCashAccountList(prev => [...prev, option]);
      setLocalCashSSOptions(prev => prev ? [...prev, option] : prev);
      setFormData(prev => ({ ...prev, cashAccountId: id }));
    } else {
      setInvestmentAccountList(prev => [...prev, { id, name, label: name }]);
      setLocalInvestmentSSOptions(prev => prev ? [...prev, option] : prev);
      setFormData(prev => ({ ...prev, accountId: id }));
    }

    setNestedEntityType(null);
  }

  return (
    <>
      {showTriggerButton && mode === "create" && (
        <button
          type="button"
          onClick={() => { resetForm(); setActualOpen(true); }}
          className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-1"
        >
          <CalendarPlus className="w-3.5 h-3.5" />
          计划
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
              <div className="grid grid-cols-4 gap-2">
                {TASK_TYPE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => mode === "create" ? handleTaskTypeChange(item.value) : undefined}
                    disabled={mode === "edit"}
                    className={`rounded-lg border px-2 py-2 text-center transition-colors ${
                      formData.taskType === item.value
                        ? "border-blue-200 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                    } disabled:cursor-not-allowed disabled:opacity-70`}
                  >
                    <div className="text-xs font-semibold">{item.label}</div>
                  </button>
                ))}
              </div>

              {isTransferTask ? (
                <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-2">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">转出账户</div>
                    <SmartSelect mode="single" value={formData.cashAccountId}
                      onChange={(id) => setFormData(d => ({ ...d, cashAccountId: id }))}
                      options={cashOptions}
                      placeholder="选择转出账户"
                      onCreateClick={() => setNestedEntityType("cash-account")}
                      createLabel="新增账户"
                      onCycleOwnerFilter={cfCycle} ownerFilterLabel={cfLabel} />
                  </div>

                  <div className="flex flex-col items-center gap-1 pb-0.5">
                    <div className="flex h-6 items-center justify-center text-emerald-600" title="资金方向">
                      <ArrowRight className="h-4 w-4" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const fromId = formData.cashAccountId;
                        const toId = formData.accountId;
                        const nextTarget = transferTargetOptions.find((item) => item.id === fromId);
                        setFormData(d => ({
                          ...d,
                          cashAccountId: toId,
                          accountId: fromId,
                          fundName: nextTarget?.label ?? d.fundName,
                        }));
                      }}
                      disabled={!formData.cashAccountId && !formData.accountId}
                      className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                      title="互换转出/转入账户"
                    >
                      <ArrowLeftRight className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">转入账户</div>
                    <SmartSelect mode="single" value={formData.accountId}
                      onChange={(id) => setFormData(d => ({ ...d, accountId: id, fundName: transferTargetOptions.find((item) => item.id === id)?.label ?? "转账" }))}
                      options={transferTargetOptions}
                      placeholder="选择转入账户" />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      {isFundTask ? "基金账户" : isLoanTask ? "贷款账户" : isInsuranceTask ? "保险产品" : "目标账户"}
                    </div>
                    {isFundTask ? (
                      investmentAccountList.length > 0 ? (
                        <SmartSelect mode="single" value={formData.accountId}
                          onChange={(id) => setFormData(d => ({ ...d, accountId: id }))}
                          options={investmentOptions}
                          placeholder="选择基金账户"
                          onCreateClick={() => setNestedEntityType("invest-account")}
                          createLabel="新增账户"
                          onCycleOwnerFilter={ifCycle} ownerFilterLabel={ifLabel} />
                      ) : (
                        <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 flex items-center">
                          {displayAccountLabel}
                        </div>
                      )
                    ) : isLoanTask ? (
                      <SmartSelect mode="single" value={formData.accountId}
                        onChange={(id) => setFormData(d => ({ ...d, accountId: id, fundName: loanOptions.find((item) => item.id === id)?.label ?? "还贷款" }))}
                        options={loanOptions}
                        placeholder="选择贷款账户" />
                    ) : (
                      <SmartSelect mode="single" value={formData.insuranceProductId}
                        onChange={(id) => {
                          const product = (insuranceProductOptions ?? []).find((item) => item.id === id);
                          setFormData(d => ({
                            ...d,
                            insuranceProductId: id,
                            accountId: product?.accountId ?? "",
                            fundName: product?.label ?? "保险缴费",
                          }));
                        }}
                        options={insuranceOptions}
                        placeholder="选择保险产品" />
                    )}
                  </div>

                  {cashAccountList.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">资金账户</div>
                      <SmartSelect mode="single" value={formData.cashAccountId}
                        onChange={(id) => setFormData(d => ({ ...d, cashAccountId: id }))}
                        options={cashOptions}
                        placeholder="选择账户"
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel="新增账户"
                        onCycleOwnerFilter={cfCycle} ownerFilterLabel={cfLabel} />
                    </div>
                  )}
                </div>
              )}

              {isFundTask && (
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
              )}

              <div className={`grid gap-3 ${isFundTask ? "grid-cols-2" : "grid-cols-1"}`}>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{isFundTask ? "基金定投金额" : "计划金额"}</div>
                  <input
                    inputMode="decimal"
                    value={formData.amount}
                    onChange={(e) => setFormData(d => ({ ...d, amount: e.target.value }))}
                    placeholder="0.00"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
                {isFundTask && (
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
                )}
              </div>

              {isFundTask && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">确认天数 (T+N)</div>
                    <input
                      inputMode="numeric"
                      min="0"
                      value={formData.confirmDays}
                      onChange={(e) => setFormData(d => ({ ...d, confirmDays: e.target.value }))}
                      placeholder="1"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">入账天数 (确认日+N日后入账)</div>
                    <input
                      inputMode="numeric"
                      min="0"
                      value={formData.arrivalDays}
                      onChange={(e) => setFormData(d => ({ ...d, arrivalDays: e.target.value }))}
                      placeholder="2"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                </div>
              )}

              {/* 周期 + 周期数 + 执行日 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">周期</div>
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

              {isFundTask && (
                <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={formData.skipPendingPreceding}
                    onChange={(e) => setFormData(d => ({ ...d, skipPendingPreceding: e.target.checked }))}
                    className="w-3.5 h-3.5 accent-blue-600" />
                  跳过暂停申购与无净值间隙
                </label>
              )}

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
      {nestedEntityType && typeof document !== "undefined" ? createPortal(
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={handleNestedAccountCreated}
          extraFields={{
            kind: nestedEntityType === "cash-account" ? "bank_debit" : "investment",
            investProductType: "fund",
          }}
          hiddenFields={["kind"]}
          nestedFieldData={nestedFieldData}
        />,
        document.body,
      ) : null}
    </>
  );
}
