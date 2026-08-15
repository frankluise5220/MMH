"use client";

import { ArrowLeftRight, ArrowRight, CalendarPlus } from "lucide-react";
import { useState, useEffect, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { useI18n } from "@/lib/i18n";
import { scheduledTaskTypeLabel, type ScheduledTaskType } from "@/lib/scheduled-task";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";

const INTERVAL_LABELS: Record<string, string> = {
  day: "regularInvest.interval.day",
  week: "regularInvest.interval.week",
  month: "regularInvest.interval.month",
  year: "regularInvest.interval.year",
};

const WEEKDAY_OPTIONS = [
  { value: "1", labelKey: "regularInvest.weekday.1" },
  { value: "2", labelKey: "regularInvest.weekday.2" },
  { value: "3", labelKey: "regularInvest.weekday.3" },
  { value: "4", labelKey: "regularInvest.weekday.4" },
  { value: "5", labelKey: "regularInvest.weekday.5" },
  { value: "6", labelKey: "regularInvest.weekday.6" },
  { value: "0", labelKey: "regularInvest.weekday.0" },
];

// Loan repayment is a system-level scheduled task: the repayment schedule is
// derived from the loan and created automatically on loan setup, so it is not
// offered as a user-manageable plan here.
const TASK_TYPE_OPTIONS: Array<{ value: ScheduledTaskType; labelKey: string }> = [
  { value: "fund_regular_invest", labelKey: "detailView.fundRegularInvest" },
  { value: "transfer", labelKey: "transaction.type.transfer" },
  { value: "insurance_premium", labelKey: "regularInvest.taskType.insurancePremium" },
];

const ACCOUNT_KIND_LABEL_KEYS: Record<string, string> = {
  cash: "account.kind.cash",
  bank_debit: "account.kind.bank_debit",
  bank_credit: "account.kind.bank_credit",
  ewallet: "account.kind.ewallet",
  deposit: "account.kind.deposit",
  investment: "account.kind.investment",
  loan: "account.kind.loan",
  insurance: "account.kind.insurance",
  other: "account.kind.other",
  bank_savings: "account.kind.bank_savings",
};

function accountKindLabel(t: (key: string) => string, kind: string) {
  const labelKey = ACCOUNT_KIND_LABEL_KEYS[kind];
  return labelKey ? t(labelKey) : kind;
}

const INTEREST_FREE_LOAN_REPAYMENT_METHOD = "免息分期还本";
const LOAN_REPAYMENT_METHOD_OPTIONS = ["等额本息", "等额本金", INTEREST_FREE_LOAN_REPAYMENT_METHOD, "自由还款", "先还利息一次性还本"];
const FIXED_LOAN_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INTEREST_FREE_LOAN_REPAYMENT_METHOD, "先还利息一次性还本"]);

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

function serializeExecutionDay(intervalUnit: string, executionDay: string): number | null {
  if (intervalUnit === "year") return null;
  const trimmed = executionDay.trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function remainingRunsInput(totalRuns?: number | null, executedRuns?: number | null): string {
  if (totalRuns == null) return "";
  return String(Math.max(0, totalRuns - Math.max(0, executedRuns ?? 0)));
}

function serializeTotalRunsFromRemaining(remainingRuns: string, executedRuns?: number | null): number | null {
  const trimmed = remainingRuns.trim();
  if (!trimmed) return null;
  const remaining = parseInt(trimmed, 10);
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return remaining + Math.max(0, executedRuns ?? 0);
}

function positiveIntervalValue(value: string) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

function scheduleAnchor(t: TranslateFn, unit: string, executionDay: string, weekdayLabel: string) {
  if (unit === "week") {
    return weekdayLabel ? t("regularInvest.anchor.weekday", { weekday: weekdayLabel }) : "";
  }
  if (unit === "month") {
    return executionDay ? t("regularInvest.anchor.monthDay", { day: executionDay }) : "";
  }
  return "";
}

function schedulePreview(t: TranslateFn, unit: string, value: string, executionDay: string, locked = false) {
  if (locked && unit === "year") return t("regularInvest.schedule.yearlyOnceLocked");
  const interval = positiveIntervalValue(value);
  const weekdayOption = WEEKDAY_OPTIONS.find((option) => option.value === executionDay);
  const weekdayLabel = weekdayOption ? t(weekdayOption.labelKey) : "";
  const anchor = scheduleAnchor(t, unit, executionDay, weekdayLabel);

  if (unit === "day") return interval === 1 ? t("regularInvest.schedule.dailyOnce") : t("regularInvest.schedule.dailyN", { interval });
  if (unit === "week") {
    return interval === 1 ? t("regularInvest.schedule.weeklyOnce", { anchor }) : t("regularInvest.schedule.weeklyN", { interval, anchor });
  }
  if (unit === "month") {
    return interval === 1 ? t("regularInvest.schedule.monthlyOnce", { anchor }) : t("regularInvest.schedule.monthlyN", { interval, anchor });
  }
  if (unit === "year") return interval === 1 ? t("regularInvest.schedule.yearlyOnce") : t("regularInvest.schedule.yearlyN", { interval });
  return t("regularInvest.schedule.asPlanned");
}

function normalizeBiweekFormData(intervalUnit: string, intervalValue: string) {
  if (intervalUnit !== "biweek") return { intervalUnit, intervalValue };
  const value = positiveIntervalValue(intervalValue) * 2;
  return { intervalUnit: "week", intervalValue: String(value) };
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

function filterAccountOptionsByOwner(options: SmartSelectOption[] | undefined, ownerName: string) {
  if (!options) return undefined;
  const nonHeaderOptions = options.filter((option) => !option.isHeader);
  if (!ownerName.trim()) return nonHeaderOptions;
  const headerId = options.find((option) => option.isHeader && option.label === ownerName)?.id;
  if (!headerId) return nonHeaderOptions;
  return nonHeaderOptions.filter((option) => option.parentId === headerId);
}

interface RegularInvestFormData {
  taskType: ScheduledTaskType;
  accountId: string;
  fundCode: string;
  fundName: string;
  insuranceProductId: string;
  policyholderGroupId: string;
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
  annualRate: string;
  repaymentMethod: string;
  repaymentIntervalMonths: string;
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
  lastRunDate?: string | null;
  endDate: string | null;
  totalRuns: number | null;
  executedRuns?: number | null;
  cashAccountId: string | null;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  annualRate?: number | null;
  repaymentMethod?: string | null;
  repaymentIntervalMonths?: number | null;
  skipPendingPreceding: boolean;
}

/**
 * Unified recurring-investment plan form component (create + edit).
 *
 * Two modes:
 * - create: create a new recurring investment plan
 * - edit: modify an existing plan (fund code is not changeable)
 *
 * Two submit paths:
 * 1. Server Action (home page) — action prop + submitMethod="serverAction"
 * 2. API (recurring investment page) — submitMethod="api" (default)
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
  insuranceProductOptions?: {
    id: string;
    label: string;
    accountId: string;
    accountLabel?: string | null;
    subLabel?: string | null;
    ownerGroupId?: string | null;
    ownerGroupName?: string | null;
    premiumAmount?: number | null;
  }[];
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

  const { t } = useI18n();

  const { ownerFilter: cfOwnerFilter, ownerFilterLabel: cfLabel, cycleOwnerFilter: cfCycle, filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOptions);
  const { ownerFilterLabel: ifLabel, cycleOwnerFilter: ifCycle, filteredOptions: investFiltered } = useAccountSSFilter(localInvestmentSSOptions);
  const { filteredOptions: transferTargetFiltered } = useAccountSSFilter(localTransferTargetSSOptions, cfOwnerFilter);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "invest-account" | null>(null);

  const actualOpen = showTriggerButton ? internalOpen : open ?? false;
  const setActualOpen = showTriggerButton ? setInternalOpen : onOpenChange ?? (() => {});
  useCloseOnNavigation(actualOpen, () => {
    setActualOpen(false);
    setNestedEntityType(null);
  });

  function getDefaultFormData(): RegularInvestFormData {
    if (mode === "edit" && editData) {
      const insuranceProduct = editData.taskInsuranceProductId
        ? (insuranceProductOptions ?? []).find((item) => item.id === editData.taskInsuranceProductId)
        : null;
      const normalizedInterval = normalizeBiweekFormData(
        editData.intervalUnit || "day",
        String(editData.intervalValue || 1),
      );
      return {
        taskType: editData.taskType ?? "fund_regular_invest",
        accountId: editData.accountId || "",
        fundCode: editData.fundCode || "",
        fundName: editData.fundName || editData.fundCode || "",
        insuranceProductId: editData.taskInsuranceProductId || "",
        policyholderGroupId: insuranceProduct?.ownerGroupId || "",
        amount: String(editData.amount || ""),
        intervalUnit: normalizedInterval.intervalUnit,
        intervalValue: normalizedInterval.intervalValue,
        startDate: toDateInput(editData.startDate) || todayInput(),
        endDate: toDateInput(editData.endDate),
        totalRuns: remainingRunsInput(editData.totalRuns, editData.executedRuns),
        executionDay: normalizedInterval.intervalUnit !== "year" && editData.executionDay != null ? String(editData.executionDay) : "",
        cashAccountId: editData.cashAccountId || "",
        feeRate: editData.feeRate != null ? String(editData.feeRate) : "0",
        confirmDays: editData.confirmDays != null ? String(editData.confirmDays) : "1",
        arrivalDays: editData.arrivalDays != null ? String(editData.arrivalDays) : "2",
        annualRate: editData.annualRate != null ? String(editData.annualRate) : "",
        repaymentMethod: editData.repaymentMethod || "自由还款",
        repaymentIntervalMonths: editData.repaymentIntervalMonths != null ? String(editData.repaymentIntervalMonths) : "1",
        skipPendingPreceding: editData.skipPendingPreceding !== undefined ? editData.skipPendingPreceding : true,
      };
    }
    return {
      taskType: "fund_regular_invest",
      accountId: investmentAccounts && investmentAccounts.length > 0 ? "" : accountId,
      fundCode: prefilledFundCode ?? "",
      fundName: prefilledFundName ?? "",
      insuranceProductId: "",
      policyholderGroupId: "",
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
      annualRate: "",
      repaymentMethod: "自由还款",
      repaymentIntervalMonths: "1",
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
    if (mode !== "create") return;
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId?: string;
        taskType?: ScheduledTaskType;
        defaultCashAccountId?: string;
        defaultAccountId?: string;
      }>).detail;
      resetForm();
      const nextTaskType = detail?.taskType ?? "fund_regular_invest";
      handleTaskTypeChange(nextTaskType);
      setFormData((prev) => ({
        ...prev,
        taskType: nextTaskType,
        cashAccountId: detail?.defaultCashAccountId ?? prev.cashAccountId,
        accountId:
          nextTaskType === "fund_regular_invest"
            ? (detail?.defaultAccountId ?? prev.accountId)
            : prev.accountId,
      }));
      setActualOpen(true);
    }
    window.addEventListener("mmh:regular-task:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:regular-task:create", onCreate as EventListener);
  }, [mode, setActualOpen]);

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
      window.alert(t("regularInvest.alert.validAmount"));
      return;
    }

    if (!formData.accountId) {
      const accountLabel =
        formData.taskType === "fund_regular_invest"
          ? t("viewImport.fundAccount")
          : formData.taskType === "loan_repayment"
            ? t("regularInvest.account.loanAccount")
            : formData.taskType === "insurance_premium"
              ? t("settings.insuranceProducts")
              : t("regularInvest.account.targetAccount");
      window.alert(t("regularInvest.alert.selectAccount", { label: accountLabel }));
      return;
    }
    if (formData.taskType === "fund_regular_invest" && !formData.fundCode.trim()) {
      window.alert(t("regularInvest.alert.fundCodeRequired"));
      return;
    }
    if (formData.taskType === "insurance_premium" && !formData.insuranceProductId) {
      window.alert(t("regularInvest.alert.selectInsuranceProduct"));
      return;
    }
    if ((formData.taskType === "transfer" || formData.taskType === "loan_repayment" || formData.taskType === "insurance_premium") && !formData.cashAccountId) {
      window.alert(t("regularInvest.alert.selectCashAccount"));
      return;
    }
    if (formData.taskType === "transfer" && formData.accountId === formData.cashAccountId) {
      window.alert(t("regularInvest.alert.sameTransferAccounts"));
      return;
    }
    const isFixedLoanRepayment = formData.taskType === "loan_repayment" && FIXED_LOAN_REPAYMENT_METHODS.has(formData.repaymentMethod);
    const isInterestFreeLoanRepayment = formData.repaymentMethod === INTEREST_FREE_LOAN_REPAYMENT_METHOD;
    const loanAnnualRate = formData.annualRate.trim() ? parseFloat(formData.annualRate) : null;
    const loanRepaymentIntervalMonths = parseInt(formData.repaymentIntervalMonths || "1", 10);
    if (isFixedLoanRepayment) {
      if (!isInterestFreeLoanRepayment && (loanAnnualRate == null || !Number.isFinite(loanAnnualRate) || loanAnnualRate <= 0)) {
        window.alert(t("regularInvest.alert.fixedRepaymentRateRequired"));
        return;
      }
      if (!Number.isFinite(loanRepaymentIntervalMonths) || loanRepaymentIntervalMonths <= 0) {
        window.alert(t("regularInvest.alert.invalidRepaymentInterval"));
        return;
      }
    }

    setSubmitting(true);
    try {
      const normalizedInterval = normalizeBiweekFormData(formData.intervalUnit, formData.intervalValue);
      const effectiveIntervalUnit = formData.taskType === "insurance_premium" ? "year" : formData.taskType === "loan_repayment" ? "month" : normalizedInterval.intervalUnit;
      const effectiveIntervalValue = formData.taskType === "insurance_premium"
        ? "1"
        : formData.taskType === "loan_repayment"
          ? String(Number.isFinite(loanRepaymentIntervalMonths) && loanRepaymentIntervalMonths > 0 ? loanRepaymentIntervalMonths : 1)
          : normalizedInterval.intervalValue;
      const serializedExecutionDay = serializeExecutionDay(effectiveIntervalUnit, formData.executionDay);
      const serializedTotalRuns = serializeTotalRunsFromRemaining(
        formData.totalRuns,
        mode === "edit" ? editData?.executedRuns : 0,
      );

      if (mode === "edit" && editData) {
        if (submitMethod === "serverAction" && action) {
          // Server Action path (home page)
          const fd = new FormData();
          fd.set("intent", "updateRegularInvest");
          fd.set("planId", editData.id);
          fd.set("taskType", formData.taskType);
          fd.set("insuranceProductId", formData.insuranceProductId || "");
          fd.set("accountId", formData.accountId);
          fd.set("fundCode", formData.taskType === "fund_regular_invest" ? formData.fundCode.trim() : formData.taskType);
          fd.set("fundName", formData.fundName.trim() || formData.fundCode.trim() || scheduledTaskTypeLabel(formData.taskType));
          fd.set("amount", String(finalAmount));
          fd.set("intervalUnit", effectiveIntervalUnit);
          fd.set("intervalValue", effectiveIntervalValue);
          fd.set("startDate", formData.startDate);
          fd.set("endDate", formData.endDate || "");
          fd.set("totalRuns", serializedTotalRuns != null ? String(serializedTotalRuns) : "");
          fd.set("executionDay", formData.executionDay || "");
          fd.set("cashAccountId", formData.cashAccountId || "");
          fd.set("feeRate", formData.feeRate.trim() ? formData.feeRate : "");
          fd.set("confirmDays", formData.confirmDays.trim() ? formData.confirmDays : "");
          fd.set("arrivalDays", formData.arrivalDays.trim() ? formData.arrivalDays : "");
          fd.set("annualRate", formData.annualRate.trim());
          fd.set("repaymentMethod", formData.repaymentMethod);
          fd.set("repaymentIntervalMonths", String(Number.isFinite(loanRepaymentIntervalMonths) && loanRepaymentIntervalMonths > 0 ? loanRepaymentIntervalMonths : 1));
          fd.set("skipPendingPreceding", formData.skipPendingPreceding ? "true" : "false");
          const res = await action(fd);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
        } else {
          // API path (recurring investment page) — direct PUT
          const payload = {
            id: editData.id,
            taskType: formData.taskType,
            insuranceProductId: formData.insuranceProductId || null,
            accountId: formData.accountId,
            fundCode: formData.taskType === "fund_regular_invest" ? formData.fundCode : formData.taskType,
            fundName: formData.fundName || formData.fundCode || scheduledTaskTypeLabel(formData.taskType),
            amount: finalAmount,
            intervalUnit: effectiveIntervalUnit,
            intervalValue: parseInt(effectiveIntervalValue) || 1,
            executionDay: serializedExecutionDay,
            startDate: formData.startDate,
            endDate: formData.endDate || null,
            totalRuns: serializedTotalRuns,
            cashAccountId: formData.cashAccountId || null,
            feeRate: formData.feeRate.trim() ? parseFloat(formData.feeRate) : 0,
            confirmDays: formData.confirmDays !== "" ? parseInt(formData.confirmDays) : 1,
            arrivalDays: formData.arrivalDays !== "" ? parseInt(formData.arrivalDays) : 2,
            annualRate: loanAnnualRate,
            repaymentMethod: formData.repaymentMethod,
            repaymentIntervalMonths: Number.isFinite(loanRepaymentIntervalMonths) && loanRepaymentIntervalMonths > 0 ? loanRepaymentIntervalMonths : 1,
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
            window.alert(data.error || t("regularInvest.alert.saveFailed"));
            return;
          }
        }

        setActualOpen(false);
        onSuccess?.();
      } else {
        // Create mode
        if (action) {
          const fd = new FormData();
          fd.set("intent", "createRegularInvest");
          fd.set("taskType", formData.taskType);
          fd.set("insuranceProductId", formData.insuranceProductId || "");
          fd.set("accountId", formData.accountId);
          fd.set("fundCode", formData.taskType === "fund_regular_invest" ? formData.fundCode.trim() : formData.taskType);
          fd.set("fundName", formData.fundName.trim() || formData.fundCode.trim() || scheduledTaskTypeLabel(formData.taskType));
          fd.set("amount", String(finalAmount));
          fd.set("intervalUnit", effectiveIntervalUnit);
          fd.set("intervalValue", effectiveIntervalValue);
          fd.set("startDate", formData.startDate);
          fd.set("endDate", formData.endDate || "");
          fd.set("totalRuns", serializedTotalRuns != null ? String(serializedTotalRuns) : "");
          fd.set("executionDay", formData.executionDay || "");
          fd.set("cashAccountId", formData.cashAccountId || "");
          fd.set("feeRate", formData.feeRate.trim() ? formData.feeRate : "");
          fd.set("confirmDays", formData.confirmDays.trim() ? formData.confirmDays : "");
          fd.set("arrivalDays", formData.arrivalDays.trim() ? formData.arrivalDays : "");
          fd.set("annualRate", formData.annualRate.trim());
          fd.set("repaymentMethod", formData.repaymentMethod);
          fd.set("repaymentIntervalMonths", String(Number.isFinite(loanRepaymentIntervalMonths) && loanRepaymentIntervalMonths > 0 ? loanRepaymentIntervalMonths : 1));
          fd.set("skipPendingPreceding", formData.skipPendingPreceding ? "true" : "false");

          const res = await action(fd);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
          setActualOpen(false);
          resetForm();
        } else if (apiAction) {
          const payload = {
            accountId: formData.accountId,
            taskType: formData.taskType,
            insuranceProductId: formData.insuranceProductId || null,
            fundCode: formData.taskType === "fund_regular_invest" ? formData.fundCode : formData.taskType,
            fundName: formData.fundName || formData.fundCode || scheduledTaskTypeLabel(formData.taskType),
            amount: finalAmount,
            intervalUnit: effectiveIntervalUnit,
            intervalValue: parseInt(effectiveIntervalValue) || 1,
            executionDay: serializedExecutionDay,
            startDate: formData.startDate,
            endDate: formData.endDate || null,
            totalRuns: serializedTotalRuns,
            cashAccountId: formData.cashAccountId || null,
            feeRate: formData.feeRate.trim() ? parseFloat(formData.feeRate) : 0,
            confirmDays: formData.confirmDays !== "" ? parseInt(formData.confirmDays) : 1,
            arrivalDays: formData.arrivalDays !== "" ? parseInt(formData.arrivalDays) : 2,
            annualRate: loanAnnualRate,
            repaymentMethod: formData.repaymentMethod,
            repaymentIntervalMonths: Number.isFinite(loanRepaymentIntervalMonths) && loanRepaymentIntervalMonths > 0 ? loanRepaymentIntervalMonths : 1,
            skipPendingPreceding: formData.skipPendingPreceding,
          };

          const res = await apiAction(payload);
          if (!res.ok) {
            window.alert(res.error || res.message || t("regularInvest.alert.saveFailed"));
            return;
          }
          setActualOpen(false);
          resetForm();
        } else {
          window.alert(t("regularInvest.alert.noSaveEntry"));
        }
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("regularInvest.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  const title = mode === "edit" ? t("regularInvest.title.edit") : t("regularInvest.title.create");
  const recentAccountIds = useRecentAccountIds();

  // Account display label in edit mode
  const displayAccountLabel = stripDefaultGroupLabel(mode === "edit" ? (editAccountLabel ?? accountLabel) : accountLabel);
  const investmentOptions = investFiltered
    ? sortOptionsByRecent(stripDefaultGroupOptions(investFiltered), recentAccountIds)
    : sortOptionsByRecent(investmentAccountList.map(a => ({ id: a.id, label: stripDefaultGroupLabel(a.label), subLabel: (a as { subLabel?: string }).subLabel })), recentAccountIds);
  const cashOptions = sortOptionsByRecent(cashFiltered ?? cashAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel })), recentAccountIds);
  const loanOptions = loanAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel }));
  const transferTargetOptions = sortOptionsByRecent(transferTargetFiltered ?? transferTargetAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel })), recentAccountIds);
  const insuranceOptions = (insuranceProductOptions ?? []).map(item => ({ id: item.id, label: item.label, subLabel: item.subLabel ?? item.accountLabel ?? undefined }));
  const selectedInsuranceProduct = (insuranceProductOptions ?? []).find((item) => item.id === formData.insuranceProductId) ?? null;
  const policyholderOptions = (nestedFieldData?.groupId ?? [])
    .filter((item) => item.name && item.name !== "未指定")
    .map((item) => ({ id: item.id, label: item.name }));
  const selectedPolicyholderName = policyholderOptions.find((item) => item.id === formData.policyholderGroupId)?.label ?? "";
  const insuranceCashOptions = sortOptionsByRecent(
    filterAccountOptionsByOwner(localCashSSOptions, selectedPolicyholderName)
      ?? cashAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel })),
    recentAccountIds,
  );
  const isFundTask = formData.taskType === "fund_regular_invest";
  const isLoanTask = formData.taskType === "loan_repayment";
  const isTransferTask = formData.taskType === "transfer";
  const isInsuranceTask = formData.taskType === "insurance_premium";
  const scheduleLocked = isInsuranceTask || isLoanTask;
  const displayedIntervalUnit = isInsuranceTask ? "year" : isLoanTask ? "month" : formData.intervalUnit;
  const displayedIntervalValue = isInsuranceTask ? "1" : isLoanTask ? formData.repaymentIntervalMonths || "1" : formData.intervalValue;
  const scheduleText = schedulePreview(t, displayedIntervalUnit, displayedIntervalValue, formData.executionDay, scheduleLocked);
  const startDateLocked = mode === "edit" && !!editData && ((editData.executedRuns ?? 0) > 0 || !!editData.lastRunDate);
  const readonlyTransferFromLabel =
    cashOptions.find((option) => option.id === formData.cashAccountId)?.label
    ?? cashAccountList.find((option) => option.id === formData.cashAccountId)?.label
    ?? t("batchImport.unselected");
  const executedRuns = Math.max(0, editData?.executedRuns ?? 0);
  const totalRunsHint = editData?.totalRuns == null ? t("regularInvest.unlimited") : String(editData.totalRuns);
  const runsLabel =
    mode === "edit"
      ? t("regularInvest.remainingRunsLabel", { total: totalRunsHint, executed: executedRuns })
      : t("regularInvest.runsOptional");

  function handleTaskTypeChange(taskType: ScheduledTaskType) {
    setFormData((prev) => ({
      ...prev,
      taskType,
      accountId: taskType === "fund_regular_invest" ? "" : taskType === "loan_repayment" ? "" : taskType === "transfer" ? "" : selectedInsuranceProduct?.accountId ?? "",
      fundCode: taskType === "fund_regular_invest" ? prev.fundCode : taskType,
      fundName: taskType === "fund_regular_invest" ? prev.fundName : scheduledTaskTypeLabel(taskType),
      insuranceProductId: taskType === "insurance_premium" ? prev.insuranceProductId : "",
      policyholderGroupId: taskType === "insurance_premium" ? prev.policyholderGroupId : "",
      intervalUnit: taskType === "insurance_premium" ? "year" : prev.intervalUnit,
      intervalValue: taskType === "insurance_premium" ? "1" : prev.intervalValue,
      executionDay: taskType === "insurance_premium" ? "" : prev.executionDay,
      feeRate: taskType === "fund_regular_invest" ? prev.feeRate : "0",
      confirmDays: taskType === "fund_regular_invest" ? prev.confirmDays : "0",
      arrivalDays: taskType === "fund_regular_invest" ? prev.arrivalDays : "0",
      annualRate: taskType === "loan_repayment" ? prev.annualRate : "",
      repaymentMethod: taskType === "loan_repayment" ? prev.repaymentMethod : "自由还款",
      repaymentIntervalMonths: taskType === "loan_repayment" ? prev.repaymentIntervalMonths : "1",
      skipPendingPreceding: taskType === "fund_regular_invest" ? prev.skipPendingPreceding : false,
    }));
  }

  function handleIntervalUnitChange(intervalUnit: string) {
    setFormData((prev) => ({
      ...prev,
      intervalUnit,
      executionDay:
        intervalUnit === "year" || intervalUnit === "day"
            ? ""
            : prev.executionDay,
    }));
  }

  function handleNestedAccountCreated(id: string, name: string, extra?: { kind?: string }) {
    const kind = extra?.kind ?? (nestedEntityType === "cash-account" ? "bank_debit" : "investment");
    const option = { id, label: name, subLabel: accountKindLabel(t, kind) };

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
          {t("regularInvest.plan")}
        </button>
      )}

      {actualOpen && (
        <div className="app-modal-backdrop z-50">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{title}</div>
              <button
                type="button"
                onClick={() => setActualOpen(false)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
              >
                {t("table.close")}
              </button>
            </div>

            <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
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
                    <div className="text-xs font-semibold">{t(item.labelKey)}</div>
                  </button>
                ))}
              </div>

              {isTransferTask ? (
                <div className={`grid items-end gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-2 ${mode === "edit" ? "grid-cols-2" : "grid-cols-[1fr_auto_1fr]"}`}>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("txForm.transferFrom")}</div>
                    {mode === "edit" ? (
                      <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-600 flex items-center">
                        {readonlyTransferFromLabel}
                      </div>
                    ) : (
                      <SmartSelect mode="single" value={formData.cashAccountId}
                        onChange={(id) => setFormData(d => ({ ...d, cashAccountId: id }))}
                        options={cashOptions}
                        placeholder={t("regularInvest.placeholder.transferFrom")}
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel={t("settings.accounts.add")}
                        onCycleOwnerFilter={cfCycle} ownerFilterLabel={cfLabel} />
                    )}
                  </div>

                  {mode === "edit" ? null : (
                    <div className="flex flex-col items-center gap-1 pb-0.5">
                      <div className="flex h-6 items-center justify-center text-emerald-600" title={t("regularInvest.fundDirection")}>
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
                        title={t("txForm.swapAccountsTitle")}
                      >
                        <ArrowLeftRight className="h-4 w-4" />
                      </button>
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("txForm.transferTo")}</div>
                    <SmartSelect mode="single" value={formData.accountId}
                      onChange={(id) => setFormData(d => ({ ...d, accountId: id, fundName: transferTargetOptions.find((item) => item.id === id)?.label ?? "转账" }))}
                      options={transferTargetOptions}
                      placeholder={t("regularInvest.placeholder.transferTo")} />
                  </div>
                </div>
              ) : isInsuranceTask ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("settings.insuranceProducts")}</div>
                    {mode === "edit" ? (
                      <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 flex items-center">
                        {selectedInsuranceProduct?.label || formData.fundName || t("regularInvest.taskType.insurancePremium")}
                      </div>
                    ) : (
                      <SmartSelect mode="single" value={formData.insuranceProductId}
                        onChange={(id) => {
                          const product = (insuranceProductOptions ?? []).find((item) => item.id === id);
                          setFormData(d => ({
                            ...d,
                            insuranceProductId: id,
                            policyholderGroupId: product?.ownerGroupId ?? d.policyholderGroupId,
                            accountId: product?.accountId ?? "",
                            fundName: product?.label ?? "保险缴费",
                            amount: !d.amount && product?.premiumAmount != null ? String(product.premiumAmount) : d.amount,
                            cashAccountId: "",
                          }));
                        }}
                        options={insuranceOptions}
                        placeholder={t("regularInvest.placeholder.insuranceProduct")} />
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("regularInvest.policyholderOptional")}</div>
                      <SmartSelect mode="single" value={formData.policyholderGroupId}
                        onChange={(id) => setFormData(d => ({ ...d, policyholderGroupId: id, cashAccountId: "" }))}
                        options={policyholderOptions}
                        placeholder={t("regularInvest.allPolicyholders")} />
                    </div>

                    {cashAccountList.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("txForm.cashAccount")}</div>
                        <SmartSelect mode="single" value={formData.cashAccountId}
                          onChange={(id) => setFormData(d => ({ ...d, cashAccountId: id }))}
                          options={insuranceCashOptions}
                          placeholder={selectedPolicyholderName ? t("regularInvest.placeholder.ownerAccount", { name: selectedPolicyholderName }) : t("regularInvest.placeholder.account")}
                          onCreateClick={() => setNestedEntityType("cash-account")}
                          createLabel={t("settings.accounts.add")} />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      {isFundTask ? t("viewImport.fundAccount") : isLoanTask ? t("regularInvest.account.loanAccount") : isInsuranceTask ? t("settings.insuranceProducts") : t("regularInvest.account.targetAccount")}
                    </div>
                    {isFundTask ? (
                      investmentAccountList.length > 0 ? (
                        <SmartSelect mode="single" value={formData.accountId}
                          onChange={(id) => setFormData(d => ({ ...d, accountId: id }))}
                          options={investmentOptions}
                          placeholder={t("regularInvest.placeholder.fundAccount")}
                          onCreateClick={() => setNestedEntityType("invest-account")}
                          createLabel={t("settings.accounts.add")}
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
                        placeholder={t("regularInvest.placeholder.loanAccount")} />
                    ) : mode === "edit" && isInsuranceTask ? (
                      <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 flex items-center">
                        {selectedInsuranceProduct?.label || formData.fundName || t("regularInvest.taskType.insurancePremium")}
                      </div>
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
                        placeholder={t("regularInvest.placeholder.insuranceProduct")} />
                    )}
                  </div>

                  {cashAccountList.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("txForm.cashAccount")}</div>
                      <SmartSelect mode="single" value={formData.cashAccountId}
                        onChange={(id) => setFormData(d => ({ ...d, cashAccountId: id }))}
                        options={cashOptions}
                        placeholder={t("regularInvest.placeholder.account")}
                        onCreateClick={() => setNestedEntityType("cash-account")}
                        createLabel={t("settings.accounts.add")}
                        onCycleOwnerFilter={cfCycle} ownerFilterLabel={cfLabel} />
                    </div>
                  )}
                </div>
              )}

              {isFundTask && (
                <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("viewImport.fundCode")}</div>
                    {mode === "edit" ? (
                      <div className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 flex items-center">{formData.fundCode}</div>
                    ) : (
                      <input
                        value={formData.fundCode}
                        onChange={(e) => setFormData(d => ({ ...d, fundCode: e.target.value }))}
                        onBlur={handleFundCodeBlur}
                        placeholder={t("regularInvest.codePlaceholder")}
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
                      {nameLoading ? "…" : t("regularInvest.fetch")}
                    </button>
                  )}
                  {mode === "edit" && <div />}
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      {t("viewImport.fundName")}{nameLoading && <span className="ml-1 text-slate-400 font-normal">{t("regularInvest.fetching")}</span>}
                    </div>
                    <input
                      value={formData.fundName}
                      onChange={(e) => setFormData(d => ({ ...d, fundName: e.target.value }))}
                      placeholder={formData.fundCode?.length === 6 && !formData.fundName && !nameLoading ? t("regularInvest.fetchFailed") : ""}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                </div>
              )}

              {isFundTask && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.confirmDaysLabel")}</div>
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
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.arrivalDaysLabel")}</div>
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

              {/* Execution frequency */}
              <div className="space-y-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-medium text-slate-600">{t("regularInvest.scheduleFrequency")}</div>
                  <div className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                    {scheduleText}
                  </div>
                </div>
                <div className={`grid gap-3 ${displayedIntervalUnit === "year" ? "grid-cols-2" : "grid-cols-3"}`}>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.intervalUnit")}</div>
                    <select
                      value={displayedIntervalUnit}
                      onChange={(e) => handleIntervalUnitChange(e.target.value)}
                      disabled={scheduleLocked}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
                    >
                      {Object.entries(INTERVAL_LABELS).map(([v, labelKey]) => (
                        <option key={v} value={v}>{t(labelKey)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.interval")}</div>
                    <input
                      inputMode="numeric"
                      min="1"
                      value={scheduleLocked ? displayedIntervalValue : formData.intervalValue}
                      onChange={(e) => setFormData(d => ({ ...d, intervalValue: e.target.value }))}
                      disabled={scheduleLocked}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
                    />
                  </div>
                  {displayedIntervalUnit !== "year" && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("regularInvest.executionDay")}</div>
                      {displayedIntervalUnit === "day" ? (
                        <input
                          type="text"
                          value={t("regularInvest.noDayRequired")}
                          disabled
                          className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 cursor-not-allowed"
                        />
                      ) : displayedIntervalUnit === "week" ? (
                      <select
                        value={formData.executionDay}
                        onChange={(e) => setFormData(d => ({ ...d, executionDay: e.target.value }))}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      >
                        <option value="">{t("regularInvest.notSpecified")}</option>
                        {WEEKDAY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                        ))}
                      </select>
                      ) : (
                      <select
                        value={formData.executionDay}
                        onChange={(e) => setFormData(d => ({ ...d, executionDay: e.target.value }))}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      >
                        <option value="">{t("regularInvest.notSpecified")}</option>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                          <option key={day} value={day}>{t("regularInvest.daySuffix", { day })}</option>
                        ))}
                      </select>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Effective date */}
              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("stockFee.effectiveDateLabel")}</div>
                  <DateStepper
                    value={formData.startDate}
                    onChange={(value) => setFormData(d => ({ ...d, startDate: value }))}
                    disabled={startDateLocked}
                  />
                  {startDateLocked ? <div className="text-[11px] text-slate-400">{t("regularInvest.startDateLockedHint")}</div> : null}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("regularInvest.stopDateOptional")}</div>
                  <DateStepper
                    value={formData.endDate}
                    onChange={(value) => setFormData(d => ({ ...d, endDate: value }))}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    {runsLabel}
                  </div>
                  <input
                    inputMode="numeric"
                    min="1"
                    value={formData.totalRuns}
                    onChange={(e) => setFormData(d => ({ ...d, totalRuns: e.target.value }))}
                    placeholder={t("regularInvest.unlimited")}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  />
                </div>
              </div>

              {isFundTask && (
                <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={formData.skipPendingPreceding}
                    onChange={(e) => setFormData(d => ({ ...d, skipPendingPreceding: e.target.checked }))}
                    className="w-3.5 h-3.5 accent-blue-600" />
                  {t("regularInvest.skipPendingPreceding")}
                </label>
              )}

              {isLoanTask && (
                <div className="grid grid-cols-3 gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.repaymentMethod")}</div>
                    <select
                      value={formData.repaymentMethod}
                      onChange={(e) => setFormData(d => ({
                        ...d,
                        repaymentMethod: e.target.value,
                        annualRate: e.target.value === INTEREST_FREE_LOAN_REPAYMENT_METHOD ? "0" : d.annualRate,
                      }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    >
                      {LOAN_REPAYMENT_METHOD_OPTIONS.map((method) => (
                        <option key={method} value={method}>{method}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("txForm.annualRatePercent")}</div>
                    <input
                      inputMode="decimal"
                      step="0.001"
                      value={formData.annualRate}
                      onChange={(e) => setFormData(d => ({ ...d, annualRate: e.target.value }))}
                      disabled={formData.repaymentMethod === INTEREST_FREE_LOAN_REPAYMENT_METHOD}
                      placeholder={formData.repaymentMethod === INTEREST_FREE_LOAN_REPAYMENT_METHOD ? "0" : FIXED_LOAN_REPAYMENT_METHODS.has(formData.repaymentMethod) ? t("batchImport.required") : t("stockFee.optional")}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.repaymentIntervalMonths")}</div>
                    <input
                      inputMode="numeric"
                      min="1"
                      value={formData.repaymentIntervalMonths}
                      onChange={(e) => setFormData(d => ({ ...d, repaymentIntervalMonths: e.target.value }))}
                      placeholder="1"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                </div>
              )}

              <div className={`grid gap-3 ${isFundTask ? "grid-cols-2" : "grid-cols-1"}`}>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{isFundTask ? t("regularInvest.fundInvestAmount") : t("regularInvest.planAmount")}</div>
                  <CalcInput
                    value={formData.amount}
                    onChange={(value) => setFormData(d => ({ ...d, amount: value }))}
                    placeholder="0.00"
                    label={isFundTask ? t("regularInvest.fundInvestAmount") : t("regularInvest.planAmount")}
                    precision={2}
                  />
                </div>
                {isFundTask && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.feeRatePercent")}</div>
                    <input
                      inputMode="decimal"
                      step="0.001"
                      value={formData.feeRate}
                      onChange={(e) => setFormData(d => ({ ...d, feeRate: e.target.value }))}
                      placeholder={t("regularInvest.defaultFeeRatePlaceholder")}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                )}
              </div>

              {/* Save buttons */}
              <div className="flex justify-end pt-1 gap-2">
                <button
                  type="button"
                  onClick={() => setActualOpen(false)}
                  className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {submitting ? t("txForm.saving") : t("common.save")}
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
