"use client";

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Pause, Pencil, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSortState } from "@/components/AdvancedDataTable";
import { DateStepper } from "@/components/DateStepper";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { addWorkdaysUtc, formatDateUtc } from "@/lib/date-utils";
import type { AccountDisplayOption } from "@/lib/account-display";
import { scheduledTaskTypeLabel, type ScheduledTaskType } from "@/lib/scheduled-task";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { clearBackgroundTaskProgress, dispatchBackgroundTaskProgress } from "@/lib/client/background-tasks";
import { useI18n } from "@/lib/i18n";

const WEEKDAY_LABELS: Record<number, string> = {
  1: "regularInvest.client.weekdayShort.1",
  2: "regularInvest.client.weekdayShort.2",
  3: "regularInvest.client.weekdayShort.3",
  4: "regularInvest.client.weekdayShort.4",
  5: "regularInvest.client.weekdayShort.5",
};

const STATUS_MAP: Record<string, { labelKey: string; cls: string }> = {
  active: { labelKey: "regularInvest.client.status.active", cls: "text-green-600" },
  paused: { labelKey: "regularInvest.client.status.paused", cls: "text-yellow-600" },
  stopped: { labelKey: "regularInvest.client.status.stopped", cls: "text-red-600" },
  completed: { labelKey: "regularInvest.client.status.completed", cls: "text-blue-600" },
};

function getStatusLabel(status: string, t: (key: string, params?: Record<string, string | number>) => string) {
  return STATUS_MAP[status] ? t(STATUS_MAP[status].labelKey) : status;
}

type GroupByMode = "fundGroup" | "fundAccount" | "cashGroup" | "cashAccount" | "none";
type RegularInvestColumnKey =
  | "taskContent"
  | "taskType"
  | "startDate"
  | "nextRunDate"
  | "targetAccount"
  | "cashAccount"
  | "amount"
  | "interval"
  | "status"
  | "executedCount";

type RegularInvestPlanView = {
  id: string;
  taskType?: ScheduledTaskType;
  taskTypeLabel?: string | null;
  taskTitle?: string | null;
  taskFromAccountId?: string | null;
  taskToAccountId?: string | null;
  taskInsuranceProductId?: string | null;
  taskAnnualRate?: number | null;
  taskRepaymentMethod?: string | null;
  taskRepaymentIntervalMonths?: number | null;
  /** System-level plans (e.g. loan repayment) are shown but read-only. */
  isSystemTask?: boolean;
  targetName?: string | null;
  insuranceProductName?: string | null;
  accountId: string;
  accountName?: string | null;
  accountLabel?: string | null;
  accountFullLabel?: string | null;
  accountHoverTitle?: string | null;
  accountGroupName?: string | null;
  cashAccountId?: string | null;
  cashAccountName?: string | null;
  cashAccountLabel?: string | null;
  cashAccountFullLabel?: string | null;
  cashAccountHoverTitle?: string | null;
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

type RegularInvestDisplayRow =
  | { kind: "group"; key: string; label: string; title: string; count: number }
  | { kind: "plan"; plan: RegularInvestPlanView };

type ExecutionProgressState = {
  title: string;
  status: "running" | "done" | "error";
  current: number;
  total: number;
  currentLabel: string;
  ok: number;
  fail: number;
  messages: string[];
};

type InsuranceProductOption = {
  id: string;
  label: string;
  accountId: string;
  accountLabel?: string | null;
  subLabel?: string | null;
  ownerGroupId?: string | null;
  ownerGroupName?: string | null;
  premiumAmount?: number | null;
};

const REGULAR_INVEST_COLUMNS: ReadonlyArray<{ key: RegularInvestColumnKey; labelKey: string }> = [
  { key: "taskContent", labelKey: "regularInvest.client.column.taskContent" },
  { key: "taskType", labelKey: "batchImport.field.type" },
  { key: "startDate", labelKey: "viewImport.exportStartDate" },
  { key: "nextRunDate", labelKey: "regularInvest.client.column.nextRun" },
  { key: "targetAccount", labelKey: "regularInvest.account.targetAccount" },
  { key: "cashAccount", labelKey: "batchImport.template.fund.label.cashAccount" },
  { key: "amount", labelKey: "stats.amount" },
  { key: "interval", labelKey: "creditBill.period" },
  { key: "status", labelKey: "depositShell.colStatus" },
  { key: "executedCount", labelKey: "regularInvest.client.column.executedCount" },
];

const REGULAR_INVEST_COLUMN_WIDTHS: Record<RegularInvestColumnKey, number> = {
  taskContent: 260,
  taskType: 120,
  startDate: 110,
  nextRunDate: 110,
  targetAccount: 180,
  cashAccount: 180,
  amount: 104,
  interval: 126,
  status: 104,
  executedCount: 140,
};

const REGULAR_INVEST_ACTION_COLUMN_WIDTH = 152;
const REGULAR_INVEST_ACTION_COLUMN_MIN_WIDTH = 132;
const SCHEDULED_TASK_PROGRESS_ID = "scheduled-task-execute";
const REGULAR_INVEST_COLUMN_MIN_WIDTHS: Record<RegularInvestColumnKey, number> = {
  taskContent: 160,
  taskType: 88,
  startDate: 92,
  nextRunDate: 92,
  targetAccount: 132,
  cashAccount: 132,
  amount: 86,
  interval: 92,
  status: 82,
  executedCount: 120,
};
const REGULAR_INVEST_MAIN_TABLE_MIN_WIDTH = REGULAR_INVEST_COLUMNS.reduce(
  (total, column) => total + REGULAR_INVEST_COLUMN_WIDTHS[column.key],
  REGULAR_INVEST_ACTION_COLUMN_WIDTH,
);

function formatInterval(p: RegularInvestPlanView, t: (key: string, params?: Record<string, string | number>) => string): string {
  const intervalUnit = p.intervalUnit === "biweek" ? "week" : p.intervalUnit;
  const intervalValue = p.intervalUnit === "biweek" ? Math.max(1, p.intervalValue || 1) * 2 : p.intervalValue;
  if (intervalUnit === "week") {
    const weekday = p.executionDay ? t(WEEKDAY_LABELS[p.executionDay] ?? "") : "";
    if (weekday) {
      return intervalValue > 1
        ? t("regularInvest.client.weekLabelN", { count: intervalValue, weekday })
        : t("regularInvest.client.weekLabel", { weekday });
    }
    return intervalValue > 1 ? t("regularInvest.client.everyNWeek", { count: intervalValue }) : t("regularInvest.interval.week");
  }
  if (intervalUnit === "month" && p.executionDay) {
    return intervalValue > 1
      ? t("regularInvest.client.everyNMonthDay", { count: intervalValue, day: p.executionDay })
      : t("regularInvest.client.everyMonthDay", { day: p.executionDay });
  }
  if (intervalUnit === "year" && p.executionDay) {
    const month = Math.floor(p.executionDay / 100);
    const day = p.executionDay % 100;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return intervalValue > 1
        ? t("regularInvest.client.everyNYearDate", { count: intervalValue, month, day })
        : t("regularInvest.client.everyYearDate", { month, day });
    }
  }
  const base = t(`regularInvest.interval.${intervalUnit}`);
  if (intervalValue > 1) {
    if (intervalUnit === "day") return t("regularInvest.client.everyNDay", { count: intervalValue });
    if (intervalUnit === "month") return t("regularInvest.client.everyNMonth", { count: intervalValue });
    if (intervalUnit === "year") return t("regularInvest.client.everyNYear", { count: intervalValue });
    return t("regularInvest.client.multi", { base, count: intervalValue });
  }
  return base;
}

function formatDate(value?: string | null): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? formatDateUtc(date) : "-";
}

function toDateInput(value?: string | Date | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}

function planAccountLabel(p: RegularInvestPlanView): string {
  return p.accountLabel || p.accountName || p.accountId || "-";
}

function planCashAccountLabel(p: RegularInvestPlanView): string {
  return p.cashAccountLabel || p.cashAccountName || "-";
}

function getPlanTaskType(plan: RegularInvestPlanView): ScheduledTaskType {
  return plan.taskType ?? "fund_regular_invest";
}

function getPlanTaskLabel(plan: RegularInvestPlanView): string {
  return plan.taskTypeLabel || scheduledTaskTypeLabel(getPlanTaskType(plan));
}

function getPlanTargetLabel(plan: RegularInvestPlanView): string {
  if (getPlanTaskType(plan) === "transfer") return `${planCashAccountLabel(plan)} → ${planAccountLabel(plan)}`;
  if (getPlanTaskType(plan) === "loan_repayment") return `${planCashAccountLabel(plan)} → ${planAccountLabel(plan)}`;
  if (getPlanTaskType(plan) === "insurance_premium") return plan.insuranceProductName || plan.targetName || plan.taskTitle || plan.fundName || planAccountLabel(plan);
  if (plan.taskTitle) return plan.taskTitle;
  return [plan.fundCode, plan.fundName && plan.fundName !== plan.fundCode ? plan.fundName : ""].filter(Boolean).join(" ");
}

function recordMatchesPlan(plan: RegularInvestPlanView, record: { source?: string | null }) {
  const taskType = getPlanTaskType(plan);
  if (taskType === "fund_regular_invest") return record.source === "regular_invest";
  if (taskType === "insurance_premium") return record.source === "insurance";
  return record.source === "scheduled_task";
}

function groupLabel(p: RegularInvestPlanView, mode: GroupByMode, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (mode === "fundGroup") return p.accountGroupName || t("regularInvest.client.group.noTargetOwner");
  if (mode === "fundAccount") return planAccountLabel(p);
  if (mode === "cashGroup") return p.cashAccountGroupName || t("regularInvest.client.group.noCashOwner");
  if (mode === "cashAccount") return planCashAccountLabel(p);
  return "";
}

function groupTitle(p: RegularInvestPlanView, mode: GroupByMode, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (mode === "fundAccount") return p.accountHoverTitle || p.accountFullLabel || planAccountLabel(p);
  if (mode === "cashAccount") return p.cashAccountHoverTitle || p.cashAccountFullLabel || planCashAccountLabel(p);
  return groupLabel(p, mode, t);
}

function groupKey(p: RegularInvestPlanView, mode: GroupByMode, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (mode === "fundAccount") return `fundAccount:${p.accountId || p.accountFullLabel || planAccountLabel(p)}`;
  if (mode === "cashAccount") return `cashAccount:${p.cashAccountId || p.cashAccountFullLabel || planCashAccountLabel(p)}`;
  return `${mode}:${groupLabel(p, mode, t)}`;
}

function groupPlans(plans: RegularInvestPlanView[], mode: GroupByMode, t: (key: string, params?: Record<string, string | number>) => string) {
  if (mode === "none") return [{ label: "", title: "", items: plans }];

  const grouped = new Map<string, { label: string; title: string; items: RegularInvestPlanView[] }>();
  for (const plan of plans) {
    const key = groupKey(plan, mode, t);
    const label = groupLabel(plan, mode, t);
    const title = groupTitle(plan, mode, t);
    if (!grouped.has(key)) grouped.set(key, { label, title, items: [] });
    grouped.get(key)!.items.push(plan);
  }

  return [...grouped.values()]
    .sort((a, b) => (a.label + a.title).localeCompare(b.label + b.title, "zh-Hans-CN"));
}

function dateSortValue(value?: string | null): number | null {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN");
}

function getRegularInvestSortValue(plan: RegularInvestPlanView, key: string, t: (key: string, params?: Record<string, string | number>) => string): string | number | null {
  if (key === "taskContent") return getPlanTargetLabel(plan);
  if (key === "taskType") return getPlanTaskLabel(plan);
  if (key === "startDate") return dateSortValue(plan.startDate);
  if (key === "nextRunDate") return dateSortValue(plan.nextRunDate);
  if (key === "targetAccount") return planAccountLabel(plan);
  if (key === "cashAccount") return planCashAccountLabel(plan);
  if (key === "amount") return Number(plan.amount || 0);
  if (key === "interval") return formatInterval(plan, t);
  if (key === "status") return getStatusLabel(plan.status, t);
  if (key === "executedCount") return Number(plan.executedCount || 0);
  return null;
}

function compareRegularInvestSortValue(
  a: { value: string | number | null | undefined; index: number },
  b: { value: string | number | null | undefined; index: number },
  direction: AdvancedDataTableSortState["direction"],
) {
  const aEmpty = a.value == null || a.value === "";
  const bEmpty = b.value == null || b.value === "";
  if (aEmpty || bEmpty) {
    if (aEmpty && bEmpty) return a.index - b.index;
    return aEmpty ? 1 : -1;
  }
  const compared = typeof a.value === "number" && typeof b.value === "number"
    ? a.value - b.value
    : String(a.value).localeCompare(String(b.value), "zh-Hans-CN", { numeric: true });
  return compared === 0
    ? a.index - b.index
    : direction === "asc" ? compared : -compared;
}

function sortRegularInvestDisplayRows(
  rows: RegularInvestDisplayRow[],
  sortState: AdvancedDataTableSortState | null,
  columns: AdvancedDataTableColumn<RegularInvestDisplayRow>[],
): RegularInvestDisplayRow[] {
  if (!sortState) return rows;
  const column = columns.find((item) => item.key === sortState.key);
  const readValue = column?.sortValue ?? column?.filterText;
  if (!readValue) return rows;

  const sortedRows: RegularInvestDisplayRow[] = [];
  let currentGroup: Extract<RegularInvestDisplayRow, { kind: "group" }> | null = null;
  let currentPlanRows: Array<{
    row: Extract<RegularInvestDisplayRow, { kind: "plan" }>;
    index: number;
    value: string | number | null | undefined;
  }> = [];

  const flushGroup = () => {
    if (currentGroup) sortedRows.push(currentGroup);
    sortedRows.push(...currentPlanRows
      .sort((a, b) => compareRegularInvestSortValue(a, b, sortState.direction))
      .map((item) => item.row));
    currentGroup = null;
    currentPlanRows = [];
  };

  rows.forEach((row, index) => {
    if (row.kind === "group") {
      flushGroup();
      currentGroup = row;
      return;
    }
    currentPlanRows.push({ row, index, value: readValue(row) });
  });
  flushGroup();

  return sortedRows;
}

function regularInvestRowMatchesFilters(
  row: RegularInvestDisplayRow,
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<RegularInvestDisplayRow>[],
) {
  if (row.kind !== "plan") return false;
  for (const [key, values] of Object.entries(filters)) {
    if ((values?.length ?? 0) === 0) continue;
    const column = columns.find((item) => item.key === key);
    const rawValue = column?.filterText?.(row);
    const value = rawValue?.trim() || "-";
    if (!values?.includes(value)) return false;
  }
  return true;
}

function filterRegularInvestDisplayRows(
  rows: RegularInvestDisplayRow[],
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<RegularInvestDisplayRow>[],
): RegularInvestDisplayRow[] {
  const filteredRows: RegularInvestDisplayRow[] = [];
  let currentGroup: Extract<RegularInvestDisplayRow, { kind: "group" }> | null = null;
  let currentPlanRows: Array<Extract<RegularInvestDisplayRow, { kind: "plan" }>> = [];

  const flushGroup = () => {
    if (currentPlanRows.length === 0) {
      currentGroup = null;
      return;
    }
    if (currentGroup) filteredRows.push({ ...currentGroup, count: currentPlanRows.length });
    filteredRows.push(...currentPlanRows);
    currentGroup = null;
    currentPlanRows = [];
  };

  for (const row of rows) {
    if (row.kind === "group") {
      flushGroup();
      currentGroup = row;
      continue;
    }
    if (regularInvestRowMatchesFilters(row, filters, columns)) currentPlanRows.push(row);
  }
  flushGroup();

  return filteredRows;
}

function sortPlansByDefault(plans: readonly RegularInvestPlanView[], t: (key: string, params?: Record<string, string | number>) => string): RegularInvestPlanView[] {
  return [...plans].sort((left, right) => {
    const nextRunCompare = compareRegularInvestSortValue(
      { value: getRegularInvestSortValue(left, "nextRunDate", t), index: 0 },
      { value: getRegularInvestSortValue(right, "nextRunDate", t), index: 0 },
      "asc",
    );
    if (nextRunCompare !== 0) return nextRunCompare;
    return compareText(getPlanTargetLabel(left), getPlanTargetLabel(right));
  });
}

function AccountCell({ label, title }: { label: string; title?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-slate-700" title={title ?? label}>{label}</div>
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
  loanAccounts,
  transferTargetAccounts,
  insuranceProductOptions,
  investmentAccountSSOptions,
  cashAccountSSOptions,
  transferTargetAccountSSOptions,
  nestedFieldData,
  allAccountSSOptions,
  transactionCreateAction,
  transactionEditAction,
}: {
  initialPlans: RegularInvestPlanView[];
  investmentAccounts: AccountDisplayOption[];
  cashAccounts: AccountDisplayOption[];
  loanAccounts: AccountDisplayOption[];
  transferTargetAccounts: AccountDisplayOption[];
  insuranceProductOptions: InsuranceProductOption[];
  investmentAccountSSOptions: SmartSelectOption[];
  cashAccountSSOptions: SmartSelectOption[];
  transferTargetAccountSSOptions: SmartSelectOption[];
  allAccountSSOptions: SmartSelectOption[];
  nestedFieldData?: Record<string, Array<{ id: string; name: string; type?: string }>>;
  transactionCreateAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  transactionEditAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const { t } = useI18n();
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
  const [executionProgress, setExecutionProgress] = useState<ExecutionProgressState | null>(null);
  const executionBusy = executionProgress?.status === "running";
  const groupBy: GroupByMode = "fundGroup";

  useEffect(() => {
    if (!executionProgress) {
      clearBackgroundTaskProgress(SCHEDULED_TASK_PROGRESS_ID);
      return;
    }
    dispatchBackgroundTaskProgress({
      id: SCHEDULED_TASK_PROGRESS_ID,
      title: executionProgress.title,
      status: executionProgress.status,
      current: executionProgress.current,
      total: executionProgress.total,
      currentLabel: executionProgress.currentLabel,
      ok: executionProgress.ok,
      fail: executionProgress.fail,
      messages: executionProgress.messages,
    });
  }, [executionProgress]);

  useEffect(() => {
    setPlans(initialPlans);
  }, [initialPlans]);

  useEffect(() => {
    async function handleEditSuccess() {
      await refreshRecords();
    }
    window.addEventListener("mmh:transaction:edit:success", handleEditSuccess);
    return () => window.removeEventListener("mmh:transaction:edit:success", handleEditSuccess);
  });

  function enrichPlanFromApi(plan: any): RegularInvestPlanView {
    const fundAccount = investmentAccounts.find((account) => account.id === plan.accountId);
    const cashAccount = cashAccounts.find((account) => account.id === plan.cashAccountId);
    return {
      ...plan,
      taskType: plan.taskType ?? "fund_regular_invest",
      taskTypeLabel: plan.taskTypeLabel ?? scheduledTaskTypeLabel(plan.taskType ?? "fund_regular_invest"),
      amount: Number(plan.amount ?? 0),
      intervalValue: Number(plan.intervalValue ?? 1),
      executedRuns: plan.executedRuns == null ? null : Number(plan.executedRuns),
      totalRuns: plan.totalRuns == null ? null : Number(plan.totalRuns),
      executionDay: plan.executionDay == null ? null : Number(plan.executionDay),
      feeRate: plan.feeRate == null ? null : Number(plan.feeRate),
      confirmDays: plan.confirmDays == null ? null : Number(plan.confirmDays),
      arrivalDays: plan.arrivalDays == null ? null : Number(plan.arrivalDays),
      executedCount: Number(plan.executedCount ?? 0),
      executedAmount: Number(plan.executedAmount ?? 0),
      confirmedCount: Number(plan.confirmedCount ?? 0),
      confirmedAmount: Number(plan.confirmedAmount ?? 0),
      accountLabel: fundAccount?.label ?? plan.accountLabel ?? plan.accountName,
      accountFullLabel: fundAccount?.fullLabel ?? plan.accountFullLabel ?? plan.accountName,
      accountHoverTitle: fundAccount?.hoverTitle ?? plan.accountHoverTitle ?? null,
      accountGroupName: fundAccount?.groupName ?? plan.accountGroupName ?? "",
      cashAccountLabel: cashAccount?.label ?? plan.cashAccountLabel ?? plan.cashAccountName,
      cashAccountFullLabel: cashAccount?.fullLabel ?? plan.cashAccountFullLabel ?? plan.cashAccountName,
      cashAccountHoverTitle: cashAccount?.hoverTitle ?? plan.cashAccountHoverTitle ?? null,
      cashAccountGroupName: cashAccount?.groupName ?? plan.cashAccountGroupName ?? "",
    };
  }

  async function apiCreateAction(payload: any) {
    const res = await fetch("/api/v1/regular-invest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok && data.plan?.id) {
      const createdPlan = enrichPlanFromApi(data.plan);
      setPlans((prev) => [createdPlan, ...prev.filter((plan) => plan.id !== createdPlan.id)]);
      setSelectedPlan(createdPlan);
      setPlanRecords([]);
    }
    return data;
  }

  async function loadRecords(plan: RegularInvestPlanView) {
    setRecordsLoading(true);
    try {
      const res = await fetch(`/api/v1/regular-invest/records?planId=${encodeURIComponent(plan.id)}`);
      const data = await res.json();
      if (data.ok) {
        const records = (data.records || []).filter((record: any) => recordMatchesPlan(plan, record));
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

  function updatePlanFromExecutionResult(planId: string, data: any) {
    if (!data?.stats) return;
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
    setSelectedPlan((prev) => {
      if (!prev || prev.id !== planId) return prev;
      return {
        ...prev,
        executedCount: data.stats.executedCount,
        executedAmount: data.stats.executedAmount,
        confirmedCount: data.stats.confirmedCount,
        confirmedAmount: data.stats.confirmedAmount,
        executedRuns: data.stats.plan?.executedRuns ?? prev.executedRuns,
        lastRunDate: data.stats.plan?.lastRunDate ?? prev.lastRunDate,
        nextRunDate: data.stats.plan?.nextRunDate ?? prev.nextRunDate,
        status: data.stats.plan?.status ?? prev.status,
      };
    });
  }

  async function refreshAfterScheduledExecution(touchedPlans: RegularInvestPlanView[]) {
    const accountIds = Array.from(new Set(touchedPlans.flatMap((plan) => [
      plan.accountId,
      plan.cashAccountId,
      plan.taskFromAccountId,
      plan.taskToAccountId,
    ]).filter((id): id is string => Boolean(id))));
    dispatchFinanceDataChanged({ reason: "scheduled-task-execute", accountIds });
    if (selectedPlan) await refreshRecords();
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
      window.alert(data.error || t("settings.fundApi.actionFailed"));
    }
  }

  async function handleBatchExecute(planId: string) {
    const plan = plans.find((item) => item.id === planId);
    if (!plan) return;
    const taskType = getPlanTaskType(plan);
    const confirmed = await showConfirmDialog({
      title: t("regularInvest.client.execute.title"),
      message: t("regularInvest.client.execute.confirm", { name: getPlanTaskLabel(plan) }),
    });
    if (!confirmed) return;
    setExecutionProgress({
      title: t("regularInvest.client.execute.taskTitle"),
      status: "running",
      current: 0,
      total: 1,
      currentLabel: t("regularInvest.client.execute.preparing", { name: getPlanTargetLabel(plan) }),
      ok: 0,
      fail: 0,
      messages: [],
    });
    try {
      if (taskType === "fund_regular_invest" && plan?.fundCode) {
        setExecutionProgress((prev) => prev ? { ...prev, currentLabel: t("regularInvest.client.execute.preloadingNav") } : prev);
        const startDate = plan.lastRunDate
          ? toDateInput(plan.lastRunDate)
          : toDateInput(plan.startDate) || todayInput();
        const endDate = todayInput();
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

      setExecutionProgress((prev) => prev ? { ...prev, currentLabel: t("regularInvest.client.execute.generating") } : prev);
      const res = await fetch(taskType === "fund_regular_invest" ? "/api/v1/regular-invest/batch-execute" : "/api/v1/regular-invest/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok || !data?.ok) {
        setExecutionProgress((prev) => prev ? {
          ...prev,
          status: "error",
          current: 1,
          fail: 1,
          currentLabel: t("regularInvest.client.execute.failed"),
          messages: [data?.error || t("regularInvest.client.execute.failedStatus", { status: res.status })],
        } : prev);
        return;
      }
      updatePlanFromExecutionResult(planId, data);
      await refreshAfterScheduledExecution([plan]);
      setExecutionProgress((prev) => prev ? {
        ...prev,
        status: "done",
        current: 1,
        ok: 1,
        currentLabel: t("regularInvest.client.execute.doneRefreshed"),
        messages: [data.message || t("regularInvest.client.execute.done")],
      } : prev);
    } catch (e) {
      setExecutionProgress((prev) => prev ? {
        ...prev,
        status: "error",
        current: 1,
        fail: 1,
        currentLabel: t("regularInvest.client.execute.failed"),
        messages: [e instanceof Error ? e.message : t("regularInvest.client.execute.failed")],
      } : prev);
    }
  }

  async function handleBatchExecuteAll() {
    const activePlans = plans.filter((plan) => plan.status === "active");
    if (activePlans.length === 0) {
      window.alert(t("regularInvest.client.executeAll.noActive"));
      return;
    }
    const confirmed = await showConfirmDialog({
      title: t("regularInvest.client.executeAll.title"),
      message: t("regularInvest.client.executeAll.confirm", { count: activePlans.length }),
    });
    if (!confirmed) return;
    setExecutionProgress({
      title: t("regularInvest.client.executeAll.taskTitle"),
      status: "running",
      current: 0,
      total: activePlans.length,
      currentLabel: t("regularInvest.client.executeAll.preparing"),
      ok: 0,
      fail: 0,
      messages: [],
    });
    try {
      const endDate = todayInput();
      for (const plan of activePlans) {
        if (getPlanTaskType(plan) !== "fund_regular_invest" || !plan.fundCode) continue;
        setExecutionProgress((prev) => prev ? { ...prev, currentLabel: t("regularInvest.client.executeAll.preloadNav", { name: getPlanTargetLabel(plan) }) } : prev);
        const preloadStart = plan.lastRunDate
          ? toDateInput(plan.lastRunDate)
          : toDateInput(plan.startDate) || todayInput();
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
      const messages: string[] = [];
      for (let index = 0; index < activePlans.length; index += 1) {
        const plan = activePlans[index];
        setExecutionProgress((prev) => prev ? {
          ...prev,
          current: index,
          currentLabel: t("regularInvest.client.executeAll.running", { current: index + 1, total: activePlans.length, name: getPlanTargetLabel(plan) }),
          ok,
          fail,
        } : prev);
        try {
          const res = await fetch(getPlanTaskType(plan) === "fund_regular_invest" ? "/api/v1/regular-invest/batch-execute" : "/api/v1/regular-invest/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ planId: plan.id }),
          });
          const data = await readJsonSafe(res);
          if (res.ok && data?.ok) {
            ok++;
            updatePlanFromExecutionResult(plan.id, data);
            messages.push(t("regularInvest.client.execute.message", { name: getPlanTargetLabel(plan), message: data.message || t("regularInvest.client.execute.done") }));
          } else {
            fail++;
            messages.push(t("regularInvest.client.execute.message", { name: getPlanTargetLabel(plan), message: data?.error || t("regularInvest.client.execute.failedStatus", { status: res.status }) }));
          }
        } catch (error) {
          fail++;
          messages.push(t("regularInvest.client.execute.message", { name: getPlanTargetLabel(plan), message: error instanceof Error ? error.message : t("regularInvest.client.execute.failed") }));
        }
        setExecutionProgress((prev) => prev ? {
          ...prev,
          current: index + 1,
          currentLabel: t("regularInvest.client.executeAll.processed", { current: index + 1, total: activePlans.length }),
          ok,
          fail,
          messages: messages.slice(-6),
        } : prev);
      }
      await refreshAfterScheduledExecution(activePlans);
      setExecutionProgress((prev) => prev ? {
        ...prev,
        status: fail === 0 ? "done" : "error",
        current: activePlans.length,
        currentLabel: fail === 0 ? t("regularInvest.client.executeAll.done") : t("regularInvest.client.executeAll.partialFail"),
        ok,
        fail,
        messages: messages.slice(-8),
      } : prev);
    } catch (e) {
      setExecutionProgress((prev) => prev ? {
        ...prev,
        status: "error",
        currentLabel: t("regularInvest.client.executeAll.failed"),
        messages: [e instanceof Error ? e.message : t("regularInvest.client.executeAll.failed")],
      } : prev);
    }
  }

  async function executeDelete(planId: string, mode: "all" | "plan" | "records") {
    setDeleteConfirm(null);
    if (mode === "records") {
      const confirmed = await showConfirmDialog({
        title: t("regularInvest.client.deleteRecords.title"),
        message: t("regularInvest.client.deleteRecords.confirmAll"),
        tone: "danger",
      });
      if (!confirmed) return;
      const res = await fetch(`/api/v1/regular-invest?id=${planId}&deleteRecords=records`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setPlanRecords([]);
        setSelectedPlan((prev) => prev?.id === planId ? { ...prev, ...data.plan, executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 } : prev);
        setPlans((prev) => prev.map((plan) => plan.id === planId ? { ...plan, ...data.plan, executedCount: 0, executedAmount: 0, confirmedCount: 0, confirmedAmount: 0 } : plan));
        dispatchFinanceDataChanged({ reason: "regular-invest-records-delete" });
      } else {
        window.alert(data.error || t("settingsDelete.deleteFailed"));
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
      setPlans((prev) => prev.filter((plan) => plan.id !== planId));
      dispatchFinanceDataChanged({ reason: "regular-invest-plan-delete" });
    } else {
      window.alert(data.error || t("settingsDelete.deleteFailed"));
    }
  }

  function handleDelete(planId: string) {
    const plan = plans.find((item) => item.id === planId);
    setDeleteConfirm({ planId, planName: plan ? getPlanTargetLabel(plan) : t("nav.scheduledTasks") });
  }

  async function handleDeleteRecord(recordId: string) {
    const confirmed = await showConfirmDialog({
      title: t("regularInvest.client.deleteRecords.title"),
      message: t("regularInvest.client.deleteRecord.confirm"),
      tone: "danger",
    });
    if (!confirmed) return;
    const res = await fetch(`/api/v1/fund/entry?id=${recordId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      await refreshRecords();
      dispatchFinanceDataChanged({ reason: "regular-invest-record-delete", deletedEntryIds: [recordId], entryIds: [recordId] });
    } else {
      window.alert(data.error || t("settingsDelete.deleteFailed"));
    }
  }

  function openEditRecord(record: any) {
    if (selectedPlan && getPlanTaskType(selectedPlan) !== "fund_regular_invest") {
      if (record.type !== "transfer") {
        window.alert(t("regularInvest.client.editRecord.notSupported"));
        return;
      }
      window.dispatchEvent(new CustomEvent("mmh:transaction:edit", {
        detail: {
          requestId: `scheduled-edit-${record.id}-${Date.now()}`,
          entryId: record.id,
          type: "transfer",
          date: toDateInput(record.date),
          amount: Math.abs(Number(record.amount)) || 0,
          note: record.note ?? "",
          toNote: record.toNote ?? "",
          fromAccountId: record.accountId ?? "",
          toAccountId: record.toAccountId ?? "",
        },
      }));
      return;
    }

    setEditingRecord({
      id: record.id,
      date: toDateInput(record.date),
      fundConfirmDate: toDateInput(record.fundConfirmDate),
      confirmDays: selectedPlan?.confirmDays ?? 0,
      _originalDate: toDateInput(record.date),
      _originalConfirmDate: toDateInput(record.fundConfirmDate),
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
      dispatchFinanceDataChanged({ reason: "regular-invest-record-save", entryIds: [editingRecord.id] });
    } else {
      window.alert(data.error || t("regularInvest.alert.saveFailed"));
    }
  }

  const filteredPlans = plans.filter((plan) => {
    if (!showEnded && (plan.status === "stopped" || plan.status === "completed")) return false;
    return true;
  });
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const overduePlans = filteredPlans.filter(
    (plan) => plan.status === "active" && plan.nextRunDate && new Date(plan.nextRunDate).getTime() <= todayStart.getTime(),
  );
  const sortedPlans = sortPlansByDefault(filteredPlans, t);
  const groupedPlans = groupPlans(sortedPlans, groupBy, t);

  const tableRows: RegularInvestDisplayRow[] = groupedPlans.flatMap((group, index) => {
    const planRows = group.items.map((plan) => ({ kind: "plan" as const, plan }));
    if (!group.label) return planRows;
    return [
      {
        kind: "group" as const,
        key: `group:${index}:${group.label}:${group.title}`,
        label: group.label,
        title: group.title || group.label,
        count: group.items.length,
      },
      ...planRows,
    ];
  });

  const mainTableColumns = useMemo<AdvancedDataTableColumn<RegularInvestDisplayRow>[]>(() => {
    const groupCell = (row: RegularInvestDisplayRow) =>
      row.kind === "group"
        ? <span className="font-semibold text-slate-600" title={row.title}>{row.label} ({row.count})</span>
        : null;

    const planOnly = (
      row: RegularInvestDisplayRow,
      render: (plan: RegularInvestPlanView) => ReactNode,
    ) => row.kind === "plan" ? render(row.plan) : null;

    return (
      REGULAR_INVEST_COLUMNS.map((column) => ({
        key: column.key,
        label: t(column.labelKey),
        width: REGULAR_INVEST_COLUMN_WIDTHS[column.key],
        minWidth: REGULAR_INVEST_COLUMN_MIN_WIDTHS[column.key],
        hideable: column.key !== "taskContent",
        align: column.key === "amount" ? "right" : undefined,
        truncate: column.key !== "amount" && column.key !== "status",
        sortValue: (row) => row.kind === "plan" ? getRegularInvestSortValue(row.plan, column.key, t) : null,
        filterText: column.key === "taskType"
          ? (row) => row.kind === "plan" ? getPlanTaskLabel(row.plan) : null
          : column.key === "status"
            ? (row) => row.kind === "plan" ? getStatusLabel(row.plan.status, t) : null
            : undefined,
        cellTitle: (row) => {
          if (row.kind === "group") return column.key === "taskContent" ? row.title : "";
          if (column.key === "taskContent") return getPlanTargetLabel(row.plan);
          if (column.key === "targetAccount") return row.plan.accountHoverTitle || planAccountLabel(row.plan);
          if (column.key === "cashAccount") return row.plan.cashAccountHoverTitle || planCashAccountLabel(row.plan);
          if (column.key === "taskType") return getPlanTaskLabel(row.plan);
          if (column.key === "interval") return formatInterval(row.plan, t);
          return "";
        },
        render: (row) => {
          if (row.kind === "group") return column.key === "taskContent" ? groupCell(row) : null;
          if (column.key === "taskContent") {
            return <span className="font-medium text-slate-800">{getPlanTargetLabel(row.plan)}</span>;
          }
          if (column.key === "taskType") {
            return <span className="text-slate-500">{getPlanTaskLabel(row.plan)}</span>;
          }
          if (column.key === "startDate") {
            return <span className="tabular-nums text-slate-500">{formatDate(row.plan.startDate)}</span>;
          }
          if (column.key === "nextRunDate") {
            return <span className="tabular-nums text-slate-700">{formatDate(row.plan.nextRunDate)}</span>;
          }
          if (column.key === "targetAccount") {
            return <AccountCell label={planAccountLabel(row.plan)} title={row.plan.accountHoverTitle} />;
          }
          if (column.key === "cashAccount") {
            return <AccountCell label={planCashAccountLabel(row.plan)} title={row.plan.cashAccountHoverTitle} />;
          }
          if (column.key === "amount") {
            return <span className="tabular-nums text-slate-700">{Number(row.plan.amount || 0).toFixed(2)}</span>;
          }
          if (column.key === "interval") {
            return <span className="text-slate-500">{formatInterval(row.plan, t)}</span>;
          }
          if (column.key === "status") {
            return (
              <span className={STATUS_MAP[row.plan.status]?.cls || "text-slate-600"}>
                {getStatusLabel(row.plan.status, t)}
              </span>
            );
          }
          return planOnly(row, (plan) => (
            <span className="tabular-nums text-slate-500">
              {t("regularInvest.client.executedSummary", { count: plan.executedCount || 0, amount: (plan.executedAmount || 0).toFixed(2) })}
            </span>
          ));
        },
      }))
    );
  }, [t]);

  function renderPlanActions(plan: RegularInvestPlanView) {
    // System-level plans (loan repayment) are read-only in the plan table:
    // the schedule is derived from the loan, so no pause/stop/edit/delete.
    if (plan.isSystemTask) {
      return (
        <span className="inline-flex h-6 items-center rounded border border-slate-200 bg-slate-50 px-1.5 text-[10px] text-slate-400" title={t("regularInvest.client.systemTask.title")}>
          {t("regularInvest.client.systemTask.short")}
        </span>
      );
    }
    return (
      <>
        {plan.status === "active" && (
          <>
            <button
              onClick={() => handleBatchExecute(plan.id)}
              disabled={executionBusy}
              title={t("regularInvest.client.executeAll.title")}
              className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-purple-200 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RefreshCw className={`h-3 w-3 text-purple-600 ${executionBusy ? "animate-spin" : ""}`} />
            </button>
            <button onClick={() => handleAction(plan.id, "pause")} title={t("fundShell.plan.pause")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-yellow-200 hover:bg-yellow-50">
              <Pause className="h-3 w-3 text-yellow-600" />
            </button>
            <button onClick={() => handleAction(plan.id, "stop")} title={t("regularInvest.client.action.stop")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-red-200 hover:bg-red-50">
              <Square className="h-3 w-3 text-red-600" />
            </button>
          </>
        )}
        {plan.status === "paused" && (
          <button onClick={() => handleAction(plan.id, "resume")} title={t("fundShell.plan.resume")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-green-200 hover:bg-green-50">
            <Play className="h-3 w-3 text-green-600" />
          </button>
        )}
        <button onClick={() => { setEditPlan(plan); setEditOpen(true); }} title={t("regularInvest.client.action.edit")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50">
          <Pencil className="h-3 w-3 text-blue-600" />
        </button>
        <button onClick={() => handleDelete(plan.id)} title={t("common.delete")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-red-200 hover:bg-red-50">
          <Trash2 className="h-3 w-3 text-red-500" />
        </button>
      </>
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
                loanAccounts={loanAccounts}
                transferTargetAccounts={transferTargetAccounts}
                insuranceProductOptions={insuranceProductOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                transferTargetAccountSSOptions={transferTargetAccountSSOptions}
                nestedFieldData={nestedFieldData}
                showTriggerButton={false}
                open={showCreateForm}
                onOpenChange={setShowCreateForm}
                apiAction={apiCreateAction}
              />
              <button onClick={() => setShowCreateForm(true)} className="flex h-8 items-center gap-1 rounded-md bg-blue-600 px-3 text-sm text-white hover:bg-blue-700">
                <Plus className="h-4 w-4" />{t("regularInvest.client.addPlan")}
              </button>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className={`${selectedPlan ? "min-h-[240px] flex-1 border-b border-slate-200 bg-white" : "min-h-0 flex-1 bg-white"}`}>
              <AdvancedDataTable
                storageKey="regular-invest:main-table"
                columns={mainTableColumns}
                rows={tableRows}
                rowKey={(row) => row.kind === "group" ? row.key : row.plan.id}
                minTableWidth={REGULAR_INVEST_MAIN_TABLE_MIN_WIDTH}
                fillHeight
                compactRows
                showFilters
                sortable
                defaultSort={{ key: "nextRunDate", direction: "asc" }}
                filterRows={filterRegularInvestDisplayRows}
                sortRows={sortRegularInvestDisplayRows}
                emptyText={t("regularInvest.client.empty")}
                onRowClick={(row) => {
                  if (row.kind === "plan") handleSelectPlan(row.plan);
                }}
                rowClassName={(row) => {
                  if (row.kind === "group") return "bg-slate-50 hover:bg-slate-50";
                  return `cursor-pointer hover:bg-slate-50 ${selectedPlan?.id === row.plan.id ? "bg-blue-50" : ""}`;
                }}
                rowActions={(row) => row.kind === "plan" ? renderPlanActions(row.plan) : null}
                rowActionsWidth={REGULAR_INVEST_ACTION_COLUMN_WIDTH}
                rowActionsMinWidth={REGULAR_INVEST_ACTION_COLUMN_MIN_WIDTH}
                toolbarMode="custom"
                toolbarLeftContent={(
                  <div className="flex min-w-0 items-center gap-3 text-sm">
                    <span className="font-semibold text-slate-800">{t("nav.scheduledTasks")}</span>
                    <span className="text-slate-500">
                      {t("regularInvest.client.toolbarSummary", { total: filteredPlans.length, active: filteredPlans.filter((plan) => plan.status === "active").length })}
                    </span>
                    {overduePlans.length > 0 ? (
                      <span className="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600">
                        {t("regularInvest.client.overdue", { count: overduePlans.length })}
                      </span>
                    ) : null}
                  </div>
                )}
                toolbarRightContent={(
                  <>
                    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-slate-500">
                      <input type="checkbox" checked={!showEnded} onChange={(e) => setShowEnded(!e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />
                      {t("regularInvest.client.hideEnded")}
                    </label>
                    <button
                      onClick={handleBatchExecuteAll}
                      disabled={executionBusy}
                      title={t("regularInvest.client.executeAll.title")}
                      className="flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${executionBusy ? "animate-spin" : ""}`} />{t("regularInvest.client.executeAll.short")}
                    </button>
                  </>
                )}
              />
            </div>

            {selectedPlan && (
              <div className="flex h-80 shrink-0 flex-col bg-slate-50">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4">
                  <div className="text-xs font-semibold text-slate-700">{t("regularInvest.client.recordsTitle", { name: getPlanTargetLabel(selectedPlan) })}</div>
                  <button onClick={() => { setSelectedPlan(null); setPlanRecords([]); }} className="text-xs text-slate-400 hover:text-slate-600">{t("table.close")}</button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {recordsLoading ? (
                    <div className="px-4 py-6 text-center text-xs text-slate-400">{t("common.loading")}</div>
                  ) : planRecords.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-slate-400">{t("regularInvest.client.recordsEmpty")}</div>
                  ) : (
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 bg-slate-100">
                        <tr>
                          <th className="px-3 py-1.5 text-left font-medium text-slate-600">{t("regularInvest.client.recordsCol.execDate")}</th>
                          {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                            <th className="px-3 py-1.5 text-left font-medium text-slate-600">{t("investForm.confirmDate")}</th>
                          )}
                          <th className="px-3 py-1.5 text-right font-medium text-slate-600">{t("stats.amount")}</th>
                          {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                            <th className="px-3 py-1.5 text-right font-medium text-slate-600">{t("batchImport.template.fund.label.units")}</th>
                          )}
                          <th className="px-3 py-1.5 text-center font-medium text-slate-600">{t("depositShell.colStatus")}</th>
                          <th className="px-3 py-1.5 text-center font-medium text-slate-600">{t("detail.column.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planRecords.map((record) => {
                          const isConfirmed = record.fundUnits != null && Number(record.fundUnits) > 0;
                          return (
                            <tr key={record.id} className="border-b border-slate-100 bg-white">
                              <td className="px-3 py-1.5 tabular-nums text-slate-700">{formatDate(record.date)}</td>
                              {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                                <td className="px-3 py-1.5 tabular-nums text-slate-500">{formatDate(record.fundConfirmDate)}</td>
                              )}
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{(Math.abs(Number(record.amount)) || 0).toFixed(2)}</td>
                              {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                                <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{isConfirmed ? Number(record.fundUnits).toFixed(2) : "-"}</td>
                              )}
                              <td className="px-3 py-1.5 text-center">
                                {getPlanTaskType(selectedPlan) === "fund_regular_invest"
                                  ? (isConfirmed ? <span className="text-emerald-600">{t("regularInvest.client.recordsCol.confirmed")}</span> : <span className="text-amber-600">{t("fundShell.status.pending")}</span>)
                                  : <span className="text-emerald-600">{t("regularInvest.client.recordsCol.executed")}</span>}
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <button onClick={(e) => { e.stopPropagation(); openEditRecord(record); }} title={t("regularInvest.client.recordsCol.editDate")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-blue-200 hover:bg-blue-50">
                                    <Pencil className="h-3 w-3 text-blue-600" />
                                  </button>
                                  <button onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record.id); }} title={t("common.delete")} className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-red-200 hover:bg-red-50">
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
          taskType: getPlanTaskType(editPlan),
          taskInsuranceProductId: editPlan.taskInsuranceProductId ?? null,
          accountId: editPlan.accountId || "",
          fundCode: editPlan.fundCode || "",
          fundName: editPlan.fundName || null,
          amount: editPlan.amount,
          intervalUnit: editPlan.intervalUnit || "month",
          intervalValue: editPlan.intervalValue || 1,
          executionDay: editPlan.executionDay ?? null,
          startDate: toDateInput(editPlan.startDate) || todayInput(),
          lastRunDate: toDateInput(editPlan.lastRunDate) || null,
          endDate: toDateInput(editPlan.endDate) || null,
          totalRuns: editPlan.totalRuns ?? null,
          executedRuns: editPlan.executedRuns ?? null,
          cashAccountId: editPlan.cashAccountId ?? null,
          feeRate: editPlan.feeRate ?? null,
          confirmDays: editPlan.confirmDays ?? null,
          arrivalDays: editPlan.arrivalDays ?? null,
          annualRate: editPlan.taskAnnualRate ?? null,
          repaymentMethod: editPlan.taskRepaymentMethod ?? null,
          repaymentIntervalMonths: editPlan.taskRepaymentIntervalMonths ?? null,
          skipPendingPreceding: editPlan.skipPendingPreceding ?? true,
        } : undefined}
        accountId={editPlan?.accountId ?? investmentAccounts[0]?.id ?? ""}
        investmentAccounts={investmentAccounts}
        cashAccounts={cashAccounts}
        loanAccounts={loanAccounts}
        transferTargetAccounts={transferTargetAccounts}
        insuranceProductOptions={insuranceProductOptions}
        investmentAccountSSOptions={investmentAccountSSOptions}
        cashAccountSSOptions={cashAccountSSOptions}
        transferTargetAccountSSOptions={transferTargetAccountSSOptions}
        nestedFieldData={nestedFieldData}
        showTriggerButton={false}
        open={editOpen}
        onOpenChange={(open) => { setEditOpen(open); if (!open) setEditPlan(null); }}
        submitMethod="api"
        onSuccess={() => { setEditPlan(null); }}
      />

      <div className="hidden">
        <TransactionFormModal
          accounts={cashAccounts}
          transferAccounts={transferTargetAccounts}
          accountSSOptions={cashAccountSSOptions}
          transferAccountSSOptions={allAccountSSOptions}
          nestedFieldData={nestedFieldData}
          expenseCategories={[]}
          incomeCategories={[]}
          defaultAccountId={cashAccounts[0]?.id}
          action={transactionCreateAction}
          editAction={transactionEditAction}
        />
      </div>

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{t("regularInvest.client.deleteDialog.title")}</div>
            </div>
            <div className="space-y-3 p-4">
              <div className="text-sm text-slate-700">{t("regularInvest.client.deleteDialog.confirm", { name: deleteConfirm.planName })}</div>
              <div className="space-y-2">
                <button onClick={() => executeDelete(deleteConfirm.planId, "all")} className="h-9 w-full rounded-md bg-red-600 text-sm text-white hover:bg-red-700">
                  {t("regularInvest.client.deleteDialog.deletePlanAndRecords")}
                </button>
                <button onClick={() => executeDelete(deleteConfirm.planId, "plan")} className="h-9 w-full rounded-md border border-amber-200 bg-amber-50 text-sm text-amber-700 hover:bg-amber-100">
                  {t("regularInvest.client.deleteDialog.deletePlanOnly")}
                </button>
                <button onClick={() => executeDelete(deleteConfirm.planId, "records")} className="h-9 w-full rounded-md border border-red-200 bg-red-50 text-sm text-red-600 hover:bg-red-100">
                  {t("regularInvest.client.deleteDialog.deleteRecordsOnly")}
                </button>
                <button onClick={() => setDeleteConfirm(null)} className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:bg-slate-50">
                  {t("common.cancel")}
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
              <div className="text-sm font-semibold text-slate-800">{t("regularInvest.client.editDateDialog.title")}</div>
              <button onClick={() => setEditingRecord(null)} className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 hover:bg-slate-50">{t("table.close")}</button>
            </div>
            <div className="space-y-3 p-4">
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("investForm.applyDate")}</div>
                <DateStepper
                  value={editingRecord.date}
                  onChange={(newDate) => {
                    setEditingRecord((record: any) => ({ ...record, date: newDate, fundConfirmDate: addWorkdaysUtc(newDate, editingRecord.confirmDays) }));
                  }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
                <div className="text-xs text-slate-400">{t("regularInvest.client.editDateDialog.applyHint", { days: editingRecord.confirmDays })}</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("investForm.confirmDate")}</div>
                <DateStepper
                  value={editingRecord.fundConfirmDate}
                  onChange={(value) => setEditingRecord((record: any) => ({ ...record, fundConfirmDate: value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
                <div className="text-xs text-slate-400">{t("regularInvest.client.editDateDialog.confirmHint")}</div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setEditingRecord(null)} className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50">{t("common.cancel")}</button>
                <button onClick={handleSaveRecord} className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700">{t("common.save")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
