"use client";

import { ArrowLeftRight, ArrowRight, CalendarPlus, ChevronDown, ChevronUp } from "lucide-react";
import { useState, useEffect, useRef, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption, type SmartSelectProps } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { CATEGORY_SMART_SELECT_BEHAVIOR, type CategorySmartSelectOption } from "./categorySmartSelect";
import { NestedAddModal } from "./EntityCreateForm";
import { useI18n } from "@/lib/i18n";
import { scheduledTaskTypeLabel, type ScheduledTaskType } from "@/lib/scheduled-task";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { formatDateUtc, lastDayOfMonthUtc } from "@/lib/date-utils";
import { decodeYearlyExecutionDay, encodeYearlyExecutionDay, isYearlyExecutionDay } from "@/lib/scheduled-task-date";

const INTERVAL_LABELS: Record<string, string> = {
  once: "regularInvest.interval.once",
  day: "regularInvest.interval.day",
  week: "regularInvest.interval.week",
  month: "regularInvest.interval.month",
  year: "regularInvest.interval.year",
};

const REQUIRED_FIELD_CLASS = "rounded-[10px] ring-1 ring-rose-200/80";

// Loan repayment is a system-level scheduled task: the repayment schedule is
// derived from the loan and created automatically on loan setup, so it is not
// offered as a user-manageable plan here.
const TASK_TYPE_OPTIONS: Array<{ value: ScheduledTaskType; labelKey: string }> = [
  { value: "fund_regular_invest", labelKey: "detailView.fundRegularInvest" },
  { value: "transfer", labelKey: "transaction.type.transfer" },
  { value: "insurance_premium", labelKey: "regularInvest.taskType.insurancePremium" },
  { value: "income", labelKey: "transaction.type.income" },
  { value: "expense", labelKey: "transaction.type.expense" },
];

type SingleSmartSelectBehavior = Extract<SmartSelectProps, { mode: "single" }>["behavior"];

const REGULAR_INVEST_CATEGORY_SMART_SELECT_BEHAVIOR = {
  ...CATEGORY_SMART_SELECT_BEHAVIOR,
  density: "regular",
} satisfies SingleSmartSelectBehavior;

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

function parseDateInput(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

function weekdayFromDateInput(value: string): string {
  const date = parseDateInput(value);
  if (!date) return "";
  const weekday = date.getUTCDay();
  return String(weekday === 0 ? 7 : weekday);
}

function firstWeekdayInMonth(year: number, month: number, weekday: number): string {
  const firstDate = new Date(Date.UTC(year, month, 1));
  const firstWeekday = firstDate.getUTCDay() === 0 ? 7 : firstDate.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return formatDateUtc(new Date(Date.UTC(year, month, 1 + offset)));
}

function weeklyExecutionDateInStartMonth(startDateValue: string, executionDay: string): string {
  const startDate = parseDateInput(startDateValue);
  if (!startDate) return startDateValue;
  const weekday = Number(executionDay);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return startDateValue;

  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();
  return firstWeekdayInMonth(year, month, weekday);
}

function monthlyExecutionDateInStartMonth(startDateValue: string, executionDay: string): string {
  const startDate = parseDateInput(startDateValue);
  if (!startDate) return startDateValue;
  const day = Number(executionDay);
  if (!Number.isInteger(day) || day < 1 || day > 31) return startDateValue;

  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();
  return formatDateUtc(new Date(Date.UTC(year, month, Math.min(day, lastDayOfMonthUtc(year, month)))));
}

function yearlyExecutionDateInStartYear(startDateValue: string, executionDay: string): string {
  const startDate = parseDateInput(startDateValue);
  const encoded = parseInt(executionDay, 10);
  if (!startDate || !Number.isFinite(encoded) || !isYearlyExecutionDay(encoded)) return startDateValue;
  const decoded = decodeYearlyExecutionDay(encoded, startDate.getUTCFullYear());
  return decoded ? formatDateUtc(decoded) : startDateValue;
}

function secondaryExecutionDateInStartPeriod(
  startDateValue: string,
  unit: string,
  encodedExecutionDay: string,
): string {
  const startDate = parseDateInput(startDateValue);
  const encoded = parseInt(encodedExecutionDay, 10);
  if (!startDate || !Number.isFinite(encoded)) return "";
  if (unit === "week") {
    if (encoded < 1 || encoded > 7) return "";
    return weeklyExecutionDateInStartMonth(startDateValue, String(encoded));
  }
  if (unit === "month") {
    if (encoded < 1 || encoded > 31) return "";
    return formatDateUtc(new Date(Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      Math.min(encoded, lastDayOfMonthUtc(startDate.getUTCFullYear(), startDate.getUTCMonth())),
    )));
  }
  if (unit === "year" && isYearlyExecutionDay(encoded)) {
    const date = decodeYearlyExecutionDay(encoded, startDate.getUTCFullYear());
    return date ? formatDateUtc(date) : "";
  }
  return "";
}

function monthBounds(value: string): { min: string; max: string } {
  const date = parseDateInput(value);
  if (!date) return { min: "1900-01-01", max: "2999-12-31" };
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    min: formatDateUtc(new Date(Date.UTC(year, month, 1))),
    max: formatDateUtc(new Date(Date.UTC(year, month, lastDayOfMonthUtc(year, month)))),
  };
}

function serializeExecutionDay(executionDay: string): number | null {
  const trimmed = executionDay.trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function serializeSecondaryExecutionDay(executionDate: string, unit: string): number | null {
  const date = parseDateInput(executionDate);
  if (!date) return null;
  if (unit === "week") {
    const weekday = date.getUTCDay();
    return weekday === 0 ? 7 : weekday;
  }
  if (unit === "month") return date.getUTCDate();
  return unit === "year" ? encodeYearlyExecutionDay(date) : null;
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

function clampIntervalValue(value: string | number, delta: number) {
  const current = typeof value === "number" ? value : positiveIntervalValue(value);
  return String(Math.max(1, current + delta));
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

function isOrdinaryTaskType(taskType: ScheduledTaskType) {
  return taskType === "income" || taskType === "expense";
}

function cleanOptionLabel(label?: string) {
  return (label ?? "").replace(/\u3000/g, "").trim();
}

interface RegularInvestFormData {
  taskType: ScheduledTaskType;
  accountId: string;
  fundCode: string;
  fundName: string;
  categoryId: string;
  categoryName: string;
  insuranceProductId: string;
  policyholderGroupId: string;
  note: string;
  amount: string;
  intervalUnit: string;
  intervalValue: string;
  startDate: string;
  weeklyExecutionDate: string;
  secondaryWeeklyExecutionDate: string;
  monthlyExecutionDate: string;
  yearlyExecutionDate: string;
  secondaryMonthlyExecutionDate: string;
  secondaryYearlyExecutionDate: string;
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
  taskCategoryId?: string | null;
  taskCategoryName?: string | null;
  taskNote?: string | null;
  accountId: string;
  fundCode: string;
  fundName: string | null;
  amount: number;
  intervalUnit: string;
  intervalValue: number;
  executionDay: number | null;
  secondaryExecutionDay: number | null;
  startDate: string;
  nextRunDate?: string | null;
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
  ordinaryAccounts,
  insuranceProductOptions,
  investmentAccountSSOptions,
  cashAccountSSOptions,
  transferTargetAccountSSOptions,
  ordinaryAccountSSOptions,
  incomeCategoryOptions,
  expenseCategoryOptions,
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
  ordinaryAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  insuranceProductOptions?: {
    id: string;
    label: string;
    accountId: string;
    accountLabel?: string | null;
    subLabel?: string | null;
    ownerGroupId?: string | null;
    ownerGroupName?: string | null;
    premiumAmount?: number | null;
    premiumFrequencyMonths?: number | null;
  }[];
  /** Hierarchical SmartSelect options for investment account dropdown (grouped by AccountGroup) */
  investmentAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for cash account dropdown (grouped by AccountGroup) */
  cashAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for transfer target account dropdown (grouped by AccountGroup) */
  transferTargetAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for fixed income/expense account dropdown */
  ordinaryAccountSSOptions?: SmartSelectOption[];
  incomeCategoryOptions?: CategorySmartSelectOption[];
  expenseCategoryOptions?: CategorySmartSelectOption[];
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
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const [internalOpen, setInternalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nameLoading, setNameLoading] = useState(false);
  const [cashAccountList, setCashAccountList] = useState(cashAccounts ?? []);
  const [investmentAccountList, setInvestmentAccountList] = useState(investmentAccounts ?? []);
  const [loanAccountList, setLoanAccountList] = useState(loanAccounts ?? []);
  const [transferTargetAccountList, setTransferTargetAccountList] = useState(transferTargetAccounts ?? []);
  const [ordinaryAccountList, setOrdinaryAccountList] = useState(ordinaryAccounts ?? []);
  const [localCashSSOptions, setLocalCashSSOptions] = useState(cashAccountSSOptions);
  const [localInvestmentSSOptions, setLocalInvestmentSSOptions] = useState(investmentAccountSSOptions);
  const [localTransferTargetSSOptions, setLocalTransferTargetSSOptions] = useState(transferTargetAccountSSOptions);
  const [localOrdinarySSOptions, setLocalOrdinarySSOptions] = useState(ordinaryAccountSSOptions);
  const confirmDaysTouchedRef = useRef(false);
  const arrivalDaysTouchedRef = useRef(false);
  const lastFundRuleKeyRef = useRef("");

  const { t } = useI18n();

  const { ownerFilter: cfOwnerFilter, ownerFilterLabel: cfLabel, cycleOwnerFilter: cfCycle, filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOptions);
  const { ownerFilterLabel: ifLabel, cycleOwnerFilter: ifCycle, filteredOptions: investFiltered } = useAccountSSFilter(localInvestmentSSOptions);
  const { filteredOptions: transferTargetFiltered } = useAccountSSFilter(localTransferTargetSSOptions, cfOwnerFilter);
  const { ownerFilterLabel: ofLabel, cycleOwnerFilter: ofCycle, filteredOptions: ordinaryFiltered } = useAccountSSFilter(localOrdinarySSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "invest-account" | null>(null);
  // Local copy of nested option data so newly created institutions/groups persist
  // across account-dialog instances within this modal.
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);

  // Keep local nested option data in sync when the server-provided prop changes.
  useEffect(() => {
    if (nestedFieldData) setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

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
      const editTaskType = editData.taskType ?? "fund_regular_invest";
      const isFundEditTask = editTaskType === "fund_regular_invest";
      const isStoredOneTime = editData.totalRuns === 1;
      const originalStartDate = toDateInput(editData.startDate) || todayInput();
      const startDate = toDateInput(editData.nextRunDate) || originalStartDate;
      const executionDay = editData.executionDay != null ? String(editData.executionDay) : "";
      const secondaryExecutionDay = editData.secondaryExecutionDay != null ? String(editData.secondaryExecutionDay) : "";
      const yearlyExecutionDayValue = editData.executionDay != null ? String(editData.executionDay) : "";
      return {
        taskType: editTaskType,
        accountId: editData.accountId || "",
        // Non-fund plans use fundCode as a storage compatibility field. Never
        // expose that task-type enum as a fund code in the form.
        fundCode: isFundEditTask ? editData.fundCode || "" : "",
        fundName: editData.fundName || editData.taskCategoryName || (
          editTaskType === "income"
            ? t("transaction.type.income")
            : editTaskType === "expense"
              ? t("transaction.type.expense")
              : scheduledTaskTypeLabel(editTaskType)
        ),
        categoryId: editData.taskCategoryId || "",
        categoryName: editData.taskCategoryName || "",
        insuranceProductId: editData.taskInsuranceProductId || "",
        policyholderGroupId: insuranceProduct?.ownerGroupId || "",
        note: editData.taskNote || "",
        amount: String(editData.amount || ""),
        intervalUnit: isStoredOneTime ? "once" : normalizedInterval.intervalUnit,
        intervalValue: isStoredOneTime ? "1" : normalizedInterval.intervalValue,
        startDate,
        weeklyExecutionDate: !isStoredOneTime && normalizedInterval.intervalUnit === "week"
          ? weeklyExecutionDateInStartMonth(originalStartDate, executionDay)
          : "",
        monthlyExecutionDate: !isStoredOneTime && normalizedInterval.intervalUnit === "month"
          ? monthlyExecutionDateInStartMonth(originalStartDate, executionDay)
          : "",
        yearlyExecutionDate: !isStoredOneTime && normalizedInterval.intervalUnit === "year"
          ? yearlyExecutionDateInStartYear(originalStartDate, yearlyExecutionDayValue)
          : "",
        secondaryWeeklyExecutionDate: !isStoredOneTime && normalizedInterval.intervalUnit === "week"
          ? secondaryExecutionDateInStartPeriod(originalStartDate, "week", secondaryExecutionDay)
          : "",
        secondaryMonthlyExecutionDate: !isStoredOneTime && normalizedInterval.intervalUnit === "month"
          ? secondaryExecutionDateInStartPeriod(originalStartDate, "month", secondaryExecutionDay)
          : "",
        secondaryYearlyExecutionDate: !isStoredOneTime && normalizedInterval.intervalUnit === "year"
          ? secondaryExecutionDateInStartPeriod(originalStartDate, "year", secondaryExecutionDay)
          : "",
        endDate: isStoredOneTime ? "" : toDateInput(editData.endDate),
        totalRuns: isStoredOneTime ? "" : remainingRunsInput(editData.totalRuns, editData.executedRuns),
        executionDay: isStoredOneTime ? "" : executionDay,
        cashAccountId: isOrdinaryTaskType(editTaskType) ? "" : editData.cashAccountId || "",
        feeRate: editData.feeRate != null ? String(editData.feeRate) : "0",
        confirmDays: editData.confirmDays != null ? String(editData.confirmDays) : "0",
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
      categoryId: "",
      categoryName: "",
      insuranceProductId: "",
      policyholderGroupId: "",
      note: "",
      amount: "",
      intervalUnit: "day",
      intervalValue: "1",
      startDate: todayInput(),
      weeklyExecutionDate: "",
      secondaryWeeklyExecutionDate: "",
      monthlyExecutionDate: "",
      yearlyExecutionDate: "",
      secondaryMonthlyExecutionDate: "",
      secondaryYearlyExecutionDate: "",
      endDate: "",
      totalRuns: "",
      executionDay: "",
      cashAccountId: prefilledCashAccountId ?? lastUsedCashAccountId ?? "",
      feeRate: prefilledFeeRate != null ? String(prefilledFeeRate) : "0",
      confirmDays: prefilledConfirmDays != null ? String(prefilledConfirmDays) : "0",
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
    confirmDaysTouchedRef.current = false;
    arrivalDaysTouchedRef.current = false;
    lastFundRuleKeyRef.current = "";
  }, [editData, mode]);

  useEffect(() => { setCashAccountList(cashAccounts ?? []); }, [cashAccounts]);
  useEffect(() => { setInvestmentAccountList(investmentAccounts ?? []); }, [investmentAccounts]);
  useEffect(() => { setLoanAccountList(loanAccounts ?? []); }, [loanAccounts]);
  useEffect(() => { setTransferTargetAccountList(transferTargetAccounts ?? []); }, [transferTargetAccounts]);
  useEffect(() => { setOrdinaryAccountList(ordinaryAccounts ?? []); }, [ordinaryAccounts]);
  useEffect(() => { setLocalCashSSOptions(cashAccountSSOptions); }, [cashAccountSSOptions]);
  useEffect(() => { setLocalInvestmentSSOptions(investmentAccountSSOptions); }, [investmentAccountSSOptions]);
  useEffect(() => { setLocalTransferTargetSSOptions(transferTargetAccountSSOptions); }, [transferTargetAccountSSOptions]);
  useEffect(() => { setLocalOrdinarySSOptions(ordinaryAccountSSOptions); }, [ordinaryAccountSSOptions]);

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
    if (!actualOpen || formData.taskType !== "fund_regular_invest") return;
    const code = formData.fundCode.trim();
    const investAccountId = formData.accountId || accountId;
    if (!code || code.length !== 6 || !investAccountId) return;
    const ruleKey = `${investAccountId}:${code}`;
    if (lastFundRuleKeyRef.current !== ruleKey) {
      confirmDaysTouchedRef.current = false;
      arrivalDaysTouchedRef.current = false;
      lastFundRuleKeyRef.current = ruleKey;
    }

    // Existing plan values remain authoritative while editing. New plans read
    // the account+fund rule as soon as a complete code and account are known.
    if (mode === "edit" && editData?.confirmDays != null) return;

    let cancelled = false;

    fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(investAccountId)}&fundCode=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.ok && d.days != null) {
          setFormData(f => ({
            ...f,
            confirmDays: confirmDaysTouchedRef.current ? f.confirmDays : String(d.days),
            arrivalDays: arrivalDaysTouchedRef.current ? f.arrivalDays : String(d.arrivalDays ?? 2),
          }));
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
  }, [actualOpen, accountId, editData?.confirmDays, formData.accountId, formData.fundCode, formData.taskType, mode]);

  async function handleFundCodeBlur() {
    const code = formData.fundCode.trim();
    if (!code || code.length !== 6) {
      setFormData(d => ({ ...d, fundName: "" }));
      return;
    }

    if (mode === "edit" && editData && code === editData.fundCode && editData.fundName) {
      return;
    }
    const ruleKey = `${formData.accountId}:${code}`;
    if (lastFundRuleKeyRef.current !== ruleKey) {
      confirmDaysTouchedRef.current = false;
      arrivalDaysTouchedRef.current = false;
      lastFundRuleKeyRef.current = ruleKey;
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
          setFormData(f => ({
            ...f,
            confirmDays: confirmDaysTouchedRef.current ? f.confirmDays : String(d.days),
            arrivalDays: arrivalDaysTouchedRef.current ? f.arrivalDays : String(d.arrivalDays ?? 2),
          }));
        }
      })
      .catch(() => {});

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
    confirmDaysTouchedRef.current = false;
    arrivalDaysTouchedRef.current = false;
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
              : isOrdinaryTaskType(formData.taskType)
                ? t("regularInvest.account.cashFundAccount")
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
      let submitConfirmDays = formData.confirmDays;
      let submitArrivalDays = formData.arrivalDays;
      if (formData.taskType === "fund_regular_invest") {
        const code = formData.fundCode.trim();
        const accountIdForRule = formData.accountId || accountId;
        const ruleKey = `${accountIdForRule}:${code}`;
        if (lastFundRuleKeyRef.current !== ruleKey) {
          confirmDaysTouchedRef.current = false;
          arrivalDaysTouchedRef.current = false;
          lastFundRuleKeyRef.current = ruleKey;
        }
        if (code && code.length === 6 && accountIdForRule && (!confirmDaysTouchedRef.current || !arrivalDaysTouchedRef.current)) {
          try {
            const res = await fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountIdForRule)}&fundCode=${encodeURIComponent(code)}`);
            const data = await res.json();
            if (data.ok && data.days != null) {
              if (!confirmDaysTouchedRef.current) submitConfirmDays = String(data.days);
              if (!arrivalDaysTouchedRef.current) submitArrivalDays = String(data.arrivalDays ?? 2);
            }
          } catch {
          }
        }
      }

      const isOneTimeInterval = formData.intervalUnit === "once";
      const normalizedInterval = normalizeBiweekFormData(formData.intervalUnit, formData.intervalValue);
      const effectiveIntervalUnit = isOneTimeInterval ? "day" : formData.taskType === "loan_repayment" ? "month" : normalizedInterval.intervalUnit;
      const effectiveIntervalValue = isOneTimeInterval ? "1" : formData.taskType === "loan_repayment"
          ? String(Number.isFinite(loanRepaymentIntervalMonths) && loanRepaymentIntervalMonths > 0 ? loanRepaymentIntervalMonths : 1)
          : normalizedInterval.intervalValue;
      const effectiveExecutionDay = isOneTimeInterval ? null : serializeExecutionDay(formData.executionDay);
      const effectiveSecondaryExecutionDay = isOneTimeInterval ||
        positiveIntervalValue(formData.intervalValue) !== 1 ||
        !effectiveExecutionDay
        ? null
        : formData.intervalUnit === "week"
          ? serializeSecondaryExecutionDay(formData.secondaryWeeklyExecutionDate, "week")
          : formData.intervalUnit === "month"
          ? serializeSecondaryExecutionDay(formData.secondaryMonthlyExecutionDate, "month")
          : formData.intervalUnit === "year"
            ? serializeSecondaryExecutionDay(formData.secondaryYearlyExecutionDate, "year")
            : null;
      const effectiveTotalRuns = isOneTimeInterval
        ? Math.max(0, mode === "edit" ? editData?.executedRuns ?? 0 : 0) + 1
        : serializeTotalRunsFromRemaining(
            formData.totalRuns,
            mode === "edit" ? editData?.executedRuns : 0,
          );
      const effectiveEndDate = isOneTimeInterval ? "" : formData.endDate;
      const isOrdinaryTask = isOrdinaryTaskType(formData.taskType);
      const taskTypeTitle = formData.taskType === "income" ? t("transaction.type.income") : formData.taskType === "expense" ? t("transaction.type.expense") : scheduledTaskTypeLabel(formData.taskType);
      const submitFundCode = formData.taskType === "fund_regular_invest" ? formData.fundCode.trim() : formData.taskType;
      const submitFundName = isOrdinaryTask
        ? (formData.categoryName.trim() || formData.fundName.trim() || taskTypeTitle)
        : (formData.fundName.trim() || formData.fundCode.trim() || scheduledTaskTypeLabel(formData.taskType));
      const submitCashAccountId = isOrdinaryTask ? "" : formData.cashAccountId || "";

      if (mode === "edit" && editData) {
        if (submitMethod === "serverAction" && action) {
          // Server Action path (home page)
          const fd = new FormData();
          fd.set("intent", "updateRegularInvest");
          fd.set("planId", editData.id);
          fd.set("taskType", formData.taskType);
          fd.set("insuranceProductId", formData.insuranceProductId || "");
          fd.set("accountId", formData.accountId);
          fd.set("fundCode", submitFundCode);
          fd.set("fundName", submitFundName);
          fd.set("categoryId", isOrdinaryTask ? formData.categoryId : "");
          fd.set("categoryName", isOrdinaryTask ? formData.categoryName.trim() : "");
          fd.set("note", isOrdinaryTask ? formData.note.trim() : "");
          fd.set("amount", String(finalAmount));
          fd.set("intervalUnit", effectiveIntervalUnit);
          fd.set("intervalValue", effectiveIntervalValue);
          fd.set("nextRunDate", formData.startDate);
          fd.set("endDate", effectiveEndDate || "");
          fd.set("totalRuns", effectiveTotalRuns != null ? String(effectiveTotalRuns) : "");
          fd.set("executionDay", effectiveExecutionDay != null ? String(effectiveExecutionDay) : "");
          fd.set("secondaryExecutionDay", effectiveSecondaryExecutionDay != null ? String(effectiveSecondaryExecutionDay) : "");
          fd.set("cashAccountId", submitCashAccountId);
          fd.set("feeRate", formData.feeRate.trim() ? formData.feeRate : "");
          fd.set("confirmDays", submitConfirmDays.trim() ? submitConfirmDays : "");
          fd.set("arrivalDays", submitArrivalDays.trim() ? submitArrivalDays : "");
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
            fundCode: submitFundCode,
            fundName: submitFundName,
            categoryId: isOrdinaryTask ? formData.categoryId || null : null,
            categoryName: isOrdinaryTask ? formData.categoryName.trim() || null : null,
            note: isOrdinaryTask ? formData.note.trim() || null : null,
            amount: finalAmount,
            intervalUnit: effectiveIntervalUnit,
            intervalValue: parseInt(effectiveIntervalValue) || 1,
            executionDay: effectiveExecutionDay,
            secondaryExecutionDay: effectiveSecondaryExecutionDay,
            nextRunDate: formData.startDate,
            endDate: effectiveEndDate || null,
            totalRuns: effectiveTotalRuns,
            cashAccountId: submitCashAccountId || null,
            feeRate: formData.feeRate.trim() ? parseFloat(formData.feeRate) : 0,
            confirmDays: submitConfirmDays !== "" ? parseInt(submitConfirmDays) : 0,
            arrivalDays: submitArrivalDays !== "" ? parseInt(submitArrivalDays) : 2,
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
          fd.set("fundCode", submitFundCode);
          fd.set("fundName", submitFundName);
          fd.set("categoryId", isOrdinaryTask ? formData.categoryId : "");
          fd.set("categoryName", isOrdinaryTask ? formData.categoryName.trim() : "");
          fd.set("note", isOrdinaryTask ? formData.note.trim() : "");
          fd.set("amount", String(finalAmount));
          fd.set("intervalUnit", effectiveIntervalUnit);
          fd.set("intervalValue", effectiveIntervalValue);
          fd.set("startDate", formData.startDate);
          fd.set("endDate", effectiveEndDate || "");
          fd.set("totalRuns", effectiveTotalRuns != null ? String(effectiveTotalRuns) : "");
          fd.set("executionDay", effectiveExecutionDay != null ? String(effectiveExecutionDay) : "");
          fd.set("secondaryExecutionDay", effectiveSecondaryExecutionDay != null ? String(effectiveSecondaryExecutionDay) : "");
          fd.set("cashAccountId", submitCashAccountId);
          fd.set("feeRate", formData.feeRate.trim() ? formData.feeRate : "");
          fd.set("confirmDays", submitConfirmDays.trim() ? submitConfirmDays : "");
          fd.set("arrivalDays", submitArrivalDays.trim() ? submitArrivalDays : "");
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
            fundCode: submitFundCode,
            fundName: submitFundName,
            categoryId: isOrdinaryTask ? formData.categoryId || null : null,
            categoryName: isOrdinaryTask ? formData.categoryName.trim() || null : null,
            note: isOrdinaryTask ? formData.note.trim() || null : null,
            amount: finalAmount,
            intervalUnit: effectiveIntervalUnit,
            intervalValue: parseInt(effectiveIntervalValue) || 1,
            executionDay: effectiveExecutionDay,
            secondaryExecutionDay: effectiveSecondaryExecutionDay,
            startDate: formData.startDate,
            endDate: effectiveEndDate || null,
            totalRuns: effectiveTotalRuns,
            cashAccountId: submitCashAccountId || null,
            feeRate: formData.feeRate.trim() ? parseFloat(formData.feeRate) : 0,
            confirmDays: submitConfirmDays !== "" ? parseInt(submitConfirmDays) : 0,
            arrivalDays: submitArrivalDays !== "" ? parseInt(submitArrivalDays) : 2,
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
  const ordinaryOptions = sortOptionsByRecent(ordinaryFiltered ?? ordinaryAccountList.map(a => ({ id: a.id, label: a.label, subLabel: a.subLabel })), recentAccountIds);
  const insuranceOptions = (insuranceProductOptions ?? []).map(item => ({ id: item.id, label: item.label, subLabel: item.subLabel ?? item.accountLabel ?? undefined }));
  const ordinaryCategoryOptions = formData.taskType === "income" ? incomeCategoryOptions ?? [] : expenseCategoryOptions ?? [];
  const selectedInsuranceProduct = (insuranceProductOptions ?? []).find((item) => item.id === formData.insuranceProductId) ?? null;
  const policyholderOptions = (nestedFieldData?.groupId ?? [])
    .filter((item) => item.name && item.name !== "未指定")
    .map((item) => ({ id: item.id, label: item.name }));
  const isFundTask = formData.taskType === "fund_regular_invest";
  const isLoanTask = formData.taskType === "loan_repayment";
  const isTransferTask = formData.taskType === "transfer";
  const isInsuranceTask = formData.taskType === "insurance_premium";
  const isOrdinaryTask = isOrdinaryTaskType(formData.taskType);
  const scheduleLocked = isLoanTask || mode === "edit";
  const displayedIntervalUnit = isLoanTask ? "month" : formData.intervalUnit;
  const displayedIntervalValue = isLoanTask ? formData.repaymentIntervalMonths || "1" : formData.intervalValue;
  const isOneTimeInterval = displayedIntervalUnit === "once";
  const startDateLocked = false;
  const nextRunDateMin = mode === "edit" && editData?.nextRunDate ? toDateInput(editData.nextRunDate) : undefined;
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
    confirmDaysTouchedRef.current = false;
    arrivalDaysTouchedRef.current = false;
    const nextIsOrdinaryTask = isOrdinaryTaskType(taskType);
    setFormData((prev) => ({
      ...prev,
      taskType,
      accountId: taskType === "fund_regular_invest"
        ? ""
        : taskType === "loan_repayment"
          ? ""
          : taskType === "transfer"
            ? ""
            : nextIsOrdinaryTask
              ? (ordinaryAccountList.some((item) => item.id === prev.accountId) ? prev.accountId : "")
              : selectedInsuranceProduct?.accountId ?? "",
      fundCode: taskType === "fund_regular_invest" && prev.taskType === "fund_regular_invest" ? prev.fundCode : "",
      fundName: taskType === "fund_regular_invest"
        ? prev.fundName
        : nextIsOrdinaryTask
          ? (taskType === "income" ? t("transaction.type.income") : t("transaction.type.expense"))
          : scheduledTaskTypeLabel(taskType),
      categoryId: nextIsOrdinaryTask && isOrdinaryTaskType(prev.taskType) && prev.taskType === taskType ? prev.categoryId : "",
      categoryName: nextIsOrdinaryTask && isOrdinaryTaskType(prev.taskType) && prev.taskType === taskType ? prev.categoryName : "",
      insuranceProductId: taskType === "insurance_premium" ? prev.insuranceProductId : "",
      policyholderGroupId: taskType === "insurance_premium" ? prev.policyholderGroupId : "",
      intervalUnit: taskType === "insurance_premium" ? "month" : prev.intervalUnit,
      intervalValue: taskType === "insurance_premium" ? "1" : prev.intervalValue,
      executionDay: taskType === "insurance_premium" ? "" : prev.executionDay,
      cashAccountId: nextIsOrdinaryTask ? "" : prev.cashAccountId,
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
      intervalValue: intervalUnit === "once" ? "1" : prev.intervalValue,
      endDate: intervalUnit === "once" ? "" : prev.endDate,
      totalRuns: intervalUnit === "once" ? "" : prev.totalRuns,
      weeklyExecutionDate: intervalUnit === "week" ? prev.startDate : prev.weeklyExecutionDate,
      monthlyExecutionDate: intervalUnit === "month" ? prev.startDate : prev.monthlyExecutionDate,
      yearlyExecutionDate: intervalUnit === "year" ? prev.startDate : prev.yearlyExecutionDate,
      secondaryWeeklyExecutionDate: intervalUnit === "week" ? prev.secondaryWeeklyExecutionDate : "",
      secondaryMonthlyExecutionDate: intervalUnit === "month" ? prev.secondaryMonthlyExecutionDate : "",
      secondaryYearlyExecutionDate: intervalUnit === "year" ? prev.secondaryYearlyExecutionDate : "",
      executionDay: intervalUnit === "week"
        ? weekdayFromDateInput(prev.startDate) || prev.executionDay
        : intervalUnit === "year"
          ? String(encodeYearlyExecutionDay(prev.startDate) ?? "")
          : intervalUnit === "day" || intervalUnit === "once"
            ? ""
            : intervalUnit === "month"
              ? parseDateInput(prev.startDate)?.getUTCDate().toString() ?? prev.executionDay
              : prev.executionDay,
    }));
  }

  function changeIntervalValue(delta: number) {
    setFormData((prev) => {
      const intervalValue = clampIntervalValue(prev.intervalValue, delta);
      return {
        ...prev,
        intervalValue,
        ...(positiveIntervalValue(intervalValue) !== 1
          ? {
              secondaryWeeklyExecutionDate: "",
              secondaryMonthlyExecutionDate: "",
              secondaryYearlyExecutionDate: "",
            }
          : {}),
      };
    });
  }

  function handleNestedAccountCreated(id: string, name: string, extra?: { kind?: string }) {
    const kind = extra?.kind ?? (nestedEntityType === "cash-account" ? "bank_debit" : "investment");
    const option = { id, label: name, subLabel: accountKindLabel(t, kind) };

    if (nestedEntityType === "cash-account") {
      setCashAccountList(prev => [...prev, option]);
      setLocalCashSSOptions(prev => prev ? [...prev, option] : prev);
      if (isOrdinaryTaskType(formData.taskType)) {
        setOrdinaryAccountList(prev => [...prev, option]);
        setLocalOrdinarySSOptions(prev => prev ? [...prev, option] : prev);
        setFormData(prev => ({ ...prev, accountId: id }));
      } else {
        setFormData(prev => ({ ...prev, cashAccountId: id }));
      }
    } else {
      setInvestmentAccountList(prev => [...prev, { id, name, label: name }]);
      setLocalInvestmentSSOptions(prev => prev ? [...prev, option] : prev);
      setFormData(prev => ({ ...prev, accountId: id }));
    }

    setNestedEntityType(null);
  }

  // Called when a nested institution/group is created inside an account dialog.
  // Keep the shared nested option data fresh so subsequent account dialogs can
  // select the newly created entity.
  function handleNestedOptionCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    setLocalNestedFieldData((prev) => {
      const base = prev ?? nestedFieldData ?? {};
      if (extra?.type !== undefined) {
        const existing = base.institutionId ?? [];
        if (existing.some((item) => item.id === id)) return base;
        return { ...base, institutionId: [...existing, { id, name, type: extra.type }] };
      }
      const existing = base.groupId ?? [];
      if (existing.some((item) => item.id === id)) return base;
      return { ...base, groupId: [...existing, { id, name }] };
    });
  }

  return (
    <ModalLayerProvider value={modalZIndex}>
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
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-[min(42rem,calc(100vw-1rem))]">
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
              <div className="grid grid-cols-5 gap-2">
                {TASK_TYPE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => mode === "create" ? handleTaskTypeChange(item.value) : undefined}
                    disabled={mode === "edit"}
                    title={t(item.labelKey)}
                    className={`min-w-0 whitespace-nowrap rounded-lg border px-1 py-2 text-center transition-colors ${
                      formData.taskType === item.value
                        ? "border-blue-200 bg-blue-50 text-blue-700"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      } disabled:cursor-not-allowed disabled:opacity-70`}
                  >
                    <div className="truncate whitespace-nowrap text-xs font-semibold">{t(item.labelKey)}</div>
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
                            intervalUnit: product?.premiumFrequencyMonths === 12
                              ? "year"
                              : product?.premiumFrequencyMonths && product.premiumFrequencyMonths > 0 && product.premiumFrequencyMonths !== 999999
                                ? "month"
                                : d.intervalUnit,
                            intervalValue: product?.premiumFrequencyMonths && product.premiumFrequencyMonths > 0 && product.premiumFrequencyMonths !== 999999
                              ? String(product.premiumFrequencyMonths === 12 ? 1 : product.premiumFrequencyMonths)
                              : d.intervalValue,
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
                        onChange={(id) => setFormData(d => ({ ...d, policyholderGroupId: id }))}
                        options={policyholderOptions}
                        placeholder={t("regularInvest.allPolicyholders")} />
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
                </div>
              ) : isOrdinaryTask ? (
                <div className="space-y-3 rounded-lg border border-slate-100 bg-slate-50/60 p-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("regularInvest.account.cashFundAccount")}</div>
                      <div className={REQUIRED_FIELD_CLASS}>
                        <SmartSelect mode="single" value={formData.accountId}
                          onChange={(id) => setFormData(d => ({ ...d, accountId: id }))}
                          options={ordinaryOptions}
                          placeholder={t("regularInvest.placeholder.cashFundAccount")}
                          onCreateClick={() => setNestedEntityType("cash-account")}
                          createLabel={t("settings.accounts.add")}
                          onCycleOwnerFilter={ofCycle} ownerFilterLabel={ofLabel} />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("regularInvest.category")}</div>
                      <SmartSelect mode="single" value={formData.categoryId}
                        onChange={(id) => {
                          const category = ordinaryCategoryOptions.find((option) => option.id === id);
                          const categoryName = category?.sourceName ?? cleanOptionLabel(category?.label);
                          setFormData(d => ({
                            ...d,
                            categoryId: id,
                            categoryName,
                            fundName: categoryName || (d.taskType === "income" ? t("transaction.type.income") : t("transaction.type.expense")),
                          }));
                        }}
                        options={ordinaryCategoryOptions}
                        placeholder={t("regularInvest.placeholder.category")}
                        behavior={REGULAR_INVEST_CATEGORY_SMART_SELECT_BEHAVIOR} />
                    </div>
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
                      onChange={(e) => {
                        confirmDaysTouchedRef.current = true;
                        setFormData(d => ({ ...d, confirmDays: e.target.value }));
                      }}
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
                      onChange={(e) => {
                        arrivalDaysTouchedRef.current = true;
                        setFormData(d => ({ ...d, arrivalDays: e.target.value }));
                      }}
                      placeholder="2"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    />
                  </div>
                </div>
              )}

              <div className={isOneTimeInterval ? "grid grid-cols-1 gap-3" : "grid grid-cols-[minmax(0,3fr)_minmax(0,3fr)_minmax(0,1fr)] gap-3"}>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{mode === "edit" ? t("regularInvest.nextRunDateLabel") : t("stockFee.effectiveDateLabel")}</div>
                  <DateStepper
                    value={formData.startDate}
                    onChange={(value) => setFormData(d => mode === "edit"
                        ? { ...d, startDate: value }
                        : ({
                      ...d,
                      startDate: value,
                      weeklyExecutionDate: d.intervalUnit === "week"
                        ? weeklyExecutionDateInStartMonth(value, weekdayFromDateInput(d.weeklyExecutionDate) || d.executionDay)
                        : d.weeklyExecutionDate,
                      secondaryWeeklyExecutionDate: d.intervalUnit === "week" && d.secondaryWeeklyExecutionDate
                        ? weeklyExecutionDateInStartMonth(value, weekdayFromDateInput(d.secondaryWeeklyExecutionDate))
                        : d.secondaryWeeklyExecutionDate,
                      monthlyExecutionDate: monthlyExecutionDateInStartMonth(value, d.executionDay),
                      yearlyExecutionDate: d.intervalUnit === "year"
                        ? yearlyExecutionDateInStartYear(value, d.executionDay || String(encodeYearlyExecutionDay(d.yearlyExecutionDate || d.startDate) ?? ""))
                        : d.yearlyExecutionDate,
                      secondaryMonthlyExecutionDate: d.intervalUnit === "month" && d.secondaryMonthlyExecutionDate
                        ? secondaryExecutionDateInStartPeriod(
                            value,
                            "month",
                            parseDateInput(d.secondaryMonthlyExecutionDate)?.getUTCDate().toString() ?? "",
                          )
                        : d.secondaryMonthlyExecutionDate,
                      secondaryYearlyExecutionDate: d.intervalUnit === "year" && d.secondaryYearlyExecutionDate
                        ? secondaryExecutionDateInStartPeriod(
                            value,
                            "year",
                            String(encodeYearlyExecutionDay(d.secondaryYearlyExecutionDate) ?? ""),
                          )
                        : d.secondaryYearlyExecutionDate,
                      }))}
                      min={nextRunDateMin}
                      disabled={startDateLocked}
                      className={REQUIRED_FIELD_CLASS}
                    />
                  {startDateLocked ? <div className="text-[11px] text-slate-400">{t("regularInvest.startDateLockedHint")}</div> : null}
                </div>
                {!isOneTimeInterval && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.stopDateOptional")}</div>
                    <DateStepper
                      value={formData.endDate}
                      onChange={(value) => setFormData(d => ({ ...d, endDate: value }))}
                    />
                  </div>
                )}
                {!isOneTimeInterval && (
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
                )}
              </div>

              <div className="space-y-2">
                <div className={
                    isOneTimeInterval
                      ? "grid grid-cols-1 gap-3"
                    : displayedIntervalUnit === "week" || displayedIntervalUnit === "month" || displayedIntervalUnit === "year"
                      ? "grid grid-cols-4 gap-3"
                      : "grid grid-cols-3 gap-3"
                }>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.intervalUnit")}</div>
                    <select
                      value={displayedIntervalUnit}
                      onChange={(e) => handleIntervalUnitChange(e.target.value)}
                      disabled={scheduleLocked}
                      className={`h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none ring-1 ring-rose-200/80 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500`}
                    >
                      {Object.entries(INTERVAL_LABELS).map(([v, labelKey]) => (
                        <option key={v} value={v}>{t(labelKey)}</option>
                      ))}
                    </select>
                  </div>
                  {!isOneTimeInterval && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.interval")}</div>
                    <div className="relative">
                      <input
                        inputMode="numeric"
                        min="1"
                        value={scheduleLocked ? displayedIntervalValue : formData.intervalValue}
                        onChange={(e) => setFormData(d => ({
                          ...d,
                          intervalValue: e.target.value,
                          ...(positiveIntervalValue(e.target.value) !== 1
                            ? {
                                secondaryWeeklyExecutionDate: "",
                                secondaryMonthlyExecutionDate: "",
                                secondaryYearlyExecutionDate: "",
                              }
                            : {}),
                        }))}
                        disabled={scheduleLocked}
                        className={`h-9 w-full rounded-md border border-slate-200 bg-white px-3 pr-8 text-sm outline-none ring-1 ring-rose-200/80 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500`}
                      />
                      <div className="absolute bottom-px right-px top-px flex w-5 flex-col overflow-hidden rounded-r bg-white/95">
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => changeIntervalValue(1)}
                          disabled={scheduleLocked}
                          className="flex flex-1 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={t("dateStepper.nextDay")}
                          aria-label={t("dateStepper.nextDay")}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => changeIntervalValue(-1)}
                          disabled={scheduleLocked || positiveIntervalValue(formData.intervalValue) <= 1}
                          className="flex flex-1 items-center justify-center border-t border-slate-200 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={t("dateStepper.prevDay")}
                          aria-label={t("dateStepper.prevDay")}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                  )}
                  {!isOneTimeInterval && (
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
                      (() => {
                        const weeklyBounds = monthBounds(formData.startDate);
                        return (
                          <DateStepper
                            value={formData.weeklyExecutionDate}
                            min={weeklyBounds.min}
                            max={weeklyBounds.max}
                            onChange={(value) => setFormData(d => ({
                              ...d,
                              weeklyExecutionDate: value,
                              executionDay: weekdayFromDateInput(value),
                            }))}
                            className={REQUIRED_FIELD_CLASS}
                          />
                        );
                      })()
                    ) : displayedIntervalUnit === "month" ? (
                      (() => {
                        const monthlyBounds = monthBounds(formData.startDate);
                        return (
                          <div className="space-y-1">
                            <DateStepper
                              value={formData.monthlyExecutionDate}
                              min={monthlyBounds.min}
                              max={monthlyBounds.max}
                              onChange={(value) => setFormData(d => ({
                                ...d,
                                monthlyExecutionDate: value,
                                executionDay: parseDateInput(value)?.getUTCDate().toString() ?? d.executionDay,
                              }))}
                              className={REQUIRED_FIELD_CLASS}
                            />
                            <div className="text-[11px] text-slate-400">{t("regularInvest.primaryExecutionDay")}</div>
                          </div>
                        );
                      })()
                    ) : displayedIntervalUnit === "year" ? (
                      (() => {
                        const yearlyBounds = monthBounds(formData.startDate);
                        return (
                          <div className="space-y-1">
                            <DateStepper
                              value={formData.yearlyExecutionDate}
                              min={yearlyBounds.min}
                              max={yearlyBounds.max}
                              onChange={(value) => setFormData(d => ({
                                ...d,
                                yearlyExecutionDate: value,
                                executionDay: encodeYearlyExecutionDay(value)?.toString() ?? d.executionDay,
                              }))}
                              className={REQUIRED_FIELD_CLASS}
                            />
                            <div className="text-[11px] text-slate-400">{t("regularInvest.primaryExecutionDay")}</div>
                          </div>
                        );
                      })()
                    ) : (
                      <select
                        value={formData.executionDay}
                        onChange={(e) => setFormData(d => ({ ...d, executionDay: e.target.value }))}
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none ring-1 ring-rose-200/80"
                      >
                        <option value="">{t("regularInvest.notSpecified")}</option>
                        {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                          <option key={day} value={day}>{t("regularInvest.daySuffix", { day })}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  )}
                  {!isOneTimeInterval &&
                    mode !== "edit" &&
                    positiveIntervalValue(formData.intervalValue) === 1 &&
                    (displayedIntervalUnit === "week" || displayedIntervalUnit === "month" || displayedIntervalUnit === "year") && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("regularInvest.secondaryExecutionDayOptional")}</div>
                      <DateStepper
                        value={displayedIntervalUnit === "week"
                          ? formData.secondaryWeeklyExecutionDate
                          : displayedIntervalUnit === "month"
                          ? formData.secondaryMonthlyExecutionDate
                          : formData.secondaryYearlyExecutionDate}
                        min={monthBounds(formData.startDate).min}
                        max={monthBounds(formData.startDate).max}
                        onChange={(value) => setFormData(d => (displayedIntervalUnit === "week"
                          ? { ...d, secondaryWeeklyExecutionDate: value }
                          : displayedIntervalUnit === "month"
                            ? { ...d, secondaryMonthlyExecutionDate: value }
                          : { ...d, secondaryYearlyExecutionDate: value }))}
                      />
                    </div>
                  )}
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

              {isFundTask ? (
                <div className="grid grid-cols-2 gap-3">
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
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("regularInvest.fundInvestAmount")}</div>
                    <div className={REQUIRED_FIELD_CLASS}>
                      <CalcInput
                        value={formData.amount}
                        onChange={(value) => setFormData(d => ({ ...d, amount: value }))}
                        placeholder="0.00"
                        label={t("regularInvest.fundInvestAmount")}
                        precision={2}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("regularInvest.planAmount")}</div>
                  <div className={REQUIRED_FIELD_CLASS}>
                    <CalcInput
                      value={formData.amount}
                      onChange={(value) => setFormData(d => ({ ...d, amount: value }))}
                      placeholder="0.00"
                      label={t("regularInvest.planAmount")}
                      precision={2}
                    />
                  </div>
                </div>
              )}

              {isOrdinaryTask && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("regularInvest.noteOptional")}</div>
                  <textarea
                    value={formData.note}
                    onChange={(e) => setFormData(d => ({ ...d, note: e.target.value }))}
                    placeholder={t("regularInvest.placeholder.note")}
                    rows={2}
                    className="w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none"
                  />
                </div>
              )}

              {/* Save buttons */}
              <div className="flex justify-end pt-1">
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
          extraFields={nestedEntityType === "cash-account"
            ? undefined
            : { kind: "investment", investProductType: "fund" }}
          hiddenFields={nestedEntityType === "cash-account" ? [] : ["kind"]}
          allowedAccountKinds={nestedEntityType === "cash-account" ? ["bank_debit", "ewallet"] : undefined}
          nestedFieldData={localNestedFieldData ?? nestedFieldData}
          onNestedCreated={handleNestedOptionCreated}
        />,
        document.body,
      ) : null}
    </ModalLayerProvider>
  );
}
