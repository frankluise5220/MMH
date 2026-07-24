"use client";

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ArrowDownAZ, ArrowDownUp, Pause, Pencil, Play, Plus, RefreshCw, SlidersHorizontal, Square, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { DateStepper } from "@/components/DateStepper";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { TableColumnFilter } from "@/components/TableColumnFilter";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { addWorkdaysUtc, formatDateUtc } from "@/lib/date-utils";
import type { AccountDisplayOption } from "@/lib/account-display";
import { scheduledTaskTypeLabel, type ScheduledTaskType } from "@/lib/scheduled-task";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { clearBackgroundTaskProgress, dispatchBackgroundTaskProgress } from "@/lib/client/background-tasks";

const INTERVAL_LABELS: Record<string, string> = {
  day: "每天",
  week: "每周",
  month: "每月",
  year: "每年",
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
type SortKey = "taskContent" | "startDate";
type SortDirection = "asc" | "desc";
type RegularInvestColumnKey =
  | "taskContent"
  | "taskType"
  | "startDate"
  | "targetAccount"
  | "cashAccount"
  | "amount"
  | "interval"
  | "status"
  | "executedCount";
type RegularInvestTableColumnKey = RegularInvestColumnKey | "actions";

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

const REGULAR_INVEST_COLUMNS: ReadonlyArray<{ key: RegularInvestColumnKey; label: string }> = [
  { key: "taskContent", label: "任务内容" },
  { key: "taskType", label: "类型" },
  { key: "startDate", label: "开始日期" },
  { key: "targetAccount", label: "目标账户" },
  { key: "cashAccount", label: "资金账户" },
  { key: "amount", label: "金额" },
  { key: "interval", label: "周期" },
  { key: "status", label: "状态" },
  { key: "executedCount", label: "已执行次数" },
];

const REGULAR_INVEST_COLUMN_WIDTHS: Record<RegularInvestColumnKey, number> = {
  taskContent: 260,
  taskType: 120,
  startDate: 110,
  targetAccount: 180,
  cashAccount: 180,
  amount: 104,
  interval: 126,
  status: 104,
  executedCount: 140,
};

const REGULAR_INVEST_ACTION_COLUMN_WIDTH = 152;
const REGULAR_INVEST_COLUMN_WIDTH_STORAGE_KEY = "regular-invest:main-table:widths";
const SCHEDULED_TASK_PROGRESS_ID = "scheduled-task-execute";
const REGULAR_INVEST_TABLE_COLUMN_KEYS: ReadonlyArray<RegularInvestTableColumnKey> = [
  "taskContent",
  "taskType",
  "startDate",
  "targetAccount",
  "cashAccount",
  "amount",
  "interval",
  "status",
  "executedCount",
  "actions",
];
const REGULAR_INVEST_COLUMN_MIN_WIDTHS: Record<RegularInvestTableColumnKey, number> = {
  taskContent: 160,
  taskType: 88,
  startDate: 92,
  targetAccount: 132,
  cashAccount: 132,
  amount: 86,
  interval: 92,
  status: 82,
  executedCount: 120,
  actions: 132,
};
const REGULAR_INVEST_SORT_COLUMNS: Partial<Record<RegularInvestColumnKey, SortKey>> = {
  taskContent: "taskContent",
  startDate: "startDate",
};

function isRegularInvestTableColumnKey(value: string): value is RegularInvestTableColumnKey {
  return REGULAR_INVEST_TABLE_COLUMN_KEYS.some((key) => key === value);
}

function defaultRegularInvestColumnWidth(key: RegularInvestTableColumnKey): number {
  return key === "actions" ? REGULAR_INVEST_ACTION_COLUMN_WIDTH : REGULAR_INVEST_COLUMN_WIDTHS[key];
}

function readRegularInvestColumnWidths(): Partial<Record<RegularInvestTableColumnKey, number>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(REGULAR_INVEST_COLUMN_WIDTH_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const widths: Partial<Record<RegularInvestTableColumnKey, number>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRegularInvestTableColumnKey(key) && typeof value === "number" && Number.isFinite(value)) {
        widths[key] = value;
      }
    }
    return widths;
  } catch {
    return {};
  }
}

function writeRegularInvestColumnWidths(widths: Partial<Record<RegularInvestTableColumnKey, number>>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REGULAR_INVEST_COLUMN_WIDTH_STORAGE_KEY, JSON.stringify(widths));
  } catch {}
}

function formatInterval(p: RegularInvestPlanView): string {
  const intervalUnit = p.intervalUnit === "biweek" ? "week" : p.intervalUnit;
  const intervalValue = p.intervalUnit === "biweek" ? Math.max(1, p.intervalValue || 1) * 2 : p.intervalValue;
  if (intervalUnit === "week") {
    const weekday = p.executionDay ? WEEKDAY_LABELS[p.executionDay] : "";
    const prefix = intervalValue > 1 ? `每${intervalValue}周` : (INTERVAL_LABELS.week || "每周");
    return weekday ? `${prefix}${weekday}` : prefix;
  }
  const base = INTERVAL_LABELS[intervalUnit] || intervalUnit;
  if (intervalUnit === "month" && p.executionDay) return intervalValue > 1 ? `每${intervalValue}个月${p.executionDay}号` : `每月${p.executionDay}号`;
  if (intervalUnit === "year" && p.executionDay) {
    const month = Math.floor(p.executionDay / 100);
    const day = p.executionDay % 100;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return intervalValue > 1 ? `每${intervalValue}年${month}.${day}` : `每年${month}.${day}`;
  }
  if (intervalValue > 1) {
    if (intervalUnit === "day") return `每${intervalValue}天`;
    if (intervalUnit === "month") return `每${intervalValue}个月`;
    if (intervalUnit === "year") return `每${intervalValue}年`;
    return `${base} x${intervalValue}`;
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

function groupLabel(p: RegularInvestPlanView, mode: GroupByMode): string {
  if (mode === "fundGroup") return p.accountGroupName || "目标账户未设置所有人";
  if (mode === "fundAccount") return p.accountFullLabel || planAccountLabel(p);
  if (mode === "cashGroup") return p.cashAccountGroupName || "资金账户未设置所有人";
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

function compareNullableDate(a?: string | null, b?: string | null): number {
  const left = a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
  const right = b ? new Date(b).getTime() : Number.POSITIVE_INFINITY;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN");
}

function sortPlans(
  plans: readonly RegularInvestPlanView[],
  sortKey: SortKey,
  direction: SortDirection,
): RegularInvestPlanView[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...plans].sort((left, right) => {
    let result = 0;
    if (sortKey === "taskContent") {
      result = compareText(getPlanTargetLabel(left), getPlanTargetLabel(right));
    } else if (sortKey === "startDate") {
      result = compareNullableDate(left.startDate, right.startDate);
    }
    if (result !== 0) return result * factor;
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
  const router = useRouter();
  const tableViewportRef = useRef<HTMLDivElement>(null);
  const columnMenuRef = useRef<HTMLDivElement>(null);
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
  const [sortKey, setSortKey] = useState<SortKey>("startDate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [columnFilterOpen, setColumnFilterOpen] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<RegularInvestColumnKey[]>([]);
  const [taskTypeFilterOpen, setTaskTypeFilterOpen] = useState(false);
  const [selectedTaskTypes, setSelectedTaskTypes] = useState<string[]>([]);
  const [tableViewportWidth, setTableViewportWidth] = useState(0);
  const [columnWidths, setColumnWidths] = useState<Partial<Record<RegularInvestTableColumnKey, number>>>({});
  const [executionProgress, setExecutionProgress] = useState<ExecutionProgressState | null>(null);
  const executionBusy = executionProgress?.status === "running";

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
    setColumnWidths(readRegularInvestColumnWidths());
  }, []);

  useEffect(() => {
    const node = tableViewportRef.current;
    if (!node) return;
    const update = () => setTableViewportWidth(Math.floor(node.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!columnFilterOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = columnMenuRef.current;
      if (!node || !(event.target instanceof Node) || node.contains(event.target)) return;
      setColumnFilterOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [columnFilterOpen]);

  useEffect(() => {
    async function handleEditSuccess() {
      await refreshRecords();
      router.refresh();
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
    router.refresh();
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
    const plan = plans.find((item) => item.id === planId);
    if (!plan) return;
    const taskType = getPlanTaskType(plan);
    if (!window.confirm(`确认执行该${getPlanTaskLabel(plan)}计划吗？\n\n系统会生成所有到期但未执行的交易明细。`)) return;
    setExecutionProgress({
      title: "执行计划任务",
      status: "running",
      current: 0,
      total: 1,
      currentLabel: `准备执行：${getPlanTargetLabel(plan)}`,
      ok: 0,
      fail: 0,
      messages: [],
    });
    try {
      if (taskType === "fund_regular_invest" && plan?.fundCode) {
        setExecutionProgress((prev) => prev ? { ...prev, currentLabel: "正在预加载基金净值..." } : prev);
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

      setExecutionProgress((prev) => prev ? { ...prev, currentLabel: "正在生成到期交易明细..." } : prev);
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
          currentLabel: "执行失败",
          messages: [data?.error || `执行失败(${res.status})`],
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
        currentLabel: "执行完成，相关数字已刷新",
        messages: [data.message || "执行完成"],
      } : prev);
    } catch (e) {
      setExecutionProgress((prev) => prev ? {
        ...prev,
        status: "error",
        current: 1,
        fail: 1,
        currentLabel: "执行失败",
        messages: [e instanceof Error ? e.message : "执行失败"],
      } : prev);
    }
  }

  async function handleBatchExecuteAll() {
    const activePlans = plans.filter((plan) => plan.status === "active");
    if (activePlans.length === 0) {
      window.alert("没有执行中的计划任务");
      return;
    }
    if (!window.confirm(`确认批量执行所有 ${activePlans.length} 个执行中的计划任务吗？`)) return;
    setExecutionProgress({
      title: "批量执行计划任务",
      status: "running",
      current: 0,
      total: activePlans.length,
      currentLabel: "准备执行计划任务...",
      ok: 0,
      fail: 0,
      messages: [],
    });
    try {
      const endDate = todayInput();
      for (const plan of activePlans) {
        if (getPlanTaskType(plan) !== "fund_regular_invest" || !plan.fundCode) continue;
        setExecutionProgress((prev) => prev ? { ...prev, currentLabel: `预加载净值：${getPlanTargetLabel(plan)}` } : prev);
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
          currentLabel: `正在执行 ${index + 1}/${activePlans.length}：${getPlanTargetLabel(plan)}`,
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
            messages.push(`${getPlanTargetLabel(plan)}：${data.message || "执行完成"}`);
          } else {
            fail++;
            messages.push(`${getPlanTargetLabel(plan)}：${data?.error || `执行失败(${res.status})`}`);
          }
        } catch (error) {
          fail++;
          messages.push(`${getPlanTargetLabel(plan)}：${error instanceof Error ? error.message : "执行失败"}`);
        }
        setExecutionProgress((prev) => prev ? {
          ...prev,
          current: index + 1,
          currentLabel: `已处理 ${index + 1}/${activePlans.length}`,
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
        currentLabel: fail === 0 ? "批量执行完成，相关数字已刷新" : "批量执行完成，部分计划失败",
        ok,
        fail,
        messages: messages.slice(-8),
      } : prev);
    } catch (e) {
      setExecutionProgress((prev) => prev ? {
        ...prev,
        status: "error",
        currentLabel: "批量执行失败",
        messages: [e instanceof Error ? e.message : "批量执行失败"],
      } : prev);
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
    setDeleteConfirm({ planId, planName: plan ? getPlanTargetLabel(plan) : "计划任务" });
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
    if (selectedPlan && getPlanTaskType(selectedPlan) !== "fund_regular_invest") {
      if (record.type !== "transfer") {
        window.alert("这类计划生成的记录暂时请到对应业务页面编辑");
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
      router.refresh();
    } else {
      window.alert(data.error || "保存失败");
    }
  }

  function toggleSort(nextKey: SortKey) {
    if (sortKey === nextKey) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "taskContent" ? "asc" : "asc");
  }

  function renderSortButton(label: string, key: SortKey) {
    const active = sortKey === key;
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className={`flex min-w-0 items-center gap-1 truncate transition-colors ${
          active ? "text-slate-800" : "text-slate-600 hover:text-slate-800"
        }`}
      >
        <span className="truncate">{label}</span>
        {active ? (
          <ArrowDownUp className={`h-3.5 w-3.5 ${sortDirection === "desc" ? "rotate-180" : ""}`} />
        ) : (
          <ArrowDownAZ className="h-3.5 w-3.5 opacity-60" />
        )}
      </button>
    );
  }

  function isColumnVisible(key: RegularInvestColumnKey): boolean {
    return visibleColumns.length === 0 || visibleColumns.includes(key);
  }

  function toggleColumnVisibility(key: RegularInvestColumnKey) {
    const allColumnKeys = REGULAR_INVEST_COLUMNS.map((column) => column.key);
    const currentVisibleKeys = visibleColumns.length === 0 ? allColumnKeys : visibleColumns;
    const nextVisibleKeys = currentVisibleKeys.includes(key)
      ? currentVisibleKeys.filter((item) => item !== key)
      : [...currentVisibleKeys, key];
    if (nextVisibleKeys.length === 0) return;
    setVisibleColumns(nextVisibleKeys.length === allColumnKeys.length ? [] : nextVisibleKeys);
  }

  function baseColumnWidth(key: RegularInvestTableColumnKey): number {
    const storedWidth = columnWidths[key];
    const width = storedWidth ?? defaultRegularInvestColumnWidth(key);
    return Math.max(REGULAR_INVEST_COLUMN_MIN_WIDTHS[key], width);
  }

  function layoutColumnWidth(key: RegularInvestTableColumnKey): number {
    return baseColumnWidth(key);
  }

  function setMainTableColumnWidth(key: RegularInvestTableColumnKey, width: number) {
    setColumnWidths((prev) => {
      const next = {
        ...prev,
        [key]: Math.max(REGULAR_INVEST_COLUMN_MIN_WIDTHS[key], Math.round(width)),
      };
      writeRegularInvestColumnWidths(next);
      return next;
    });
  }

  function beginColumnResize(event: ReactMouseEvent, key: RegularInvestTableColumnKey) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = layoutColumnWidth(key);
    const onMove = (moveEvent: MouseEvent) => {
      setMainTableColumnWidth(key, startWidth + moveEvent.clientX - startX);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function renderHeaderContent(column: { key: RegularInvestColumnKey; label: string }) {
    const columnSortKey = REGULAR_INVEST_SORT_COLUMNS[column.key];
    const labelNode = columnSortKey ? renderSortButton(column.label, columnSortKey) : <span className="block truncate">{column.label}</span>;
    const filterNode = column.key === "taskType" ? (
      <TableColumnFilter
        label={column.label}
        options={taskTypeOptions}
        selectedValues={selectedTaskTypes}
        open={taskTypeFilterOpen}
        filtered={selectedTaskTypes.length > 0}
        showLabel={false}
        onToggleOpen={() => setTaskTypeFilterOpen((current) => !current)}
        onClose={() => setTaskTypeFilterOpen(false)}
        onChange={(values) => setSelectedTaskTypes(values ?? [])}
      />
    ) : null;

      return (
        <div className="flex min-w-0 items-center justify-center gap-1 text-center">
          <div className="min-w-0">{labelNode}</div>
          {filterNode ? <div className="shrink-0">{filterNode}</div> : null}
        </div>
      );
    }

    function renderHeaderCell(column: { key: RegularInvestColumnKey; label: string }) {
      return (
        <th
          key={column.key}
          className="relative select-none border-b border-r border-slate-200 px-3 py-2 text-center text-xs font-semibold text-slate-600"
        >
          {renderHeaderContent(column)}
          <span
            role="separator"
            aria-orientation="vertical"
            onMouseDown={(event) => beginColumnResize(event, column.key)}
            className="absolute right-[-3px] top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none hover:bg-blue-300/40"
            title="拖动调整列宽"
          />
        </th>
      );
    }

  const taskTypeOptions = Array.from(new Set(plans.map((plan) => getPlanTaskLabel(plan)))).sort((a, b) =>
    a.localeCompare(b, "zh-Hans-CN"),
  );

  const filteredPlans = plans.filter((plan) => {
    if (!showEnded && (plan.status === "stopped" || plan.status === "completed")) return false;
    if (selectedTaskTypes.length > 0 && !selectedTaskTypes.includes(getPlanTaskLabel(plan))) return false;
    return true;
  });
  const sortedPlans = sortPlans(filteredPlans, sortKey, sortDirection);
  const groupedPlans = groupPlans(sortedPlans, groupBy);
  const visibleRegularInvestColumns = REGULAR_INVEST_COLUMNS.filter((column) => isColumnVisible(column.key));
  const mainTableColSpan = visibleRegularInvestColumns.length + 1;
  const mainTableBaseWidth = visibleRegularInvestColumns.reduce(
    (total, column) => total + baseColumnWidth(column.key),
    baseColumnWidth("actions"),
  );
  const mainTableWidth = Math.max(tableViewportWidth || 0, mainTableBaseWidth);
  const mainTableScale = mainTableBaseWidth > 0 && mainTableBaseWidth < mainTableWidth
    ? mainTableWidth / mainTableBaseWidth
    : 1;

  function renderRow(plan: RegularInvestPlanView) {
    return (
      <tr
        key={plan.id}
        className={`cursor-pointer hover:bg-slate-50 ${selectedPlan?.id === plan.id ? "bg-blue-50" : ""}`}
        onClick={() => handleSelectPlan(plan)}
      >
        {isColumnVisible("taskContent") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs overflow-hidden">
            <span className="font-medium text-slate-800">{getPlanTargetLabel(plan)}</span>
          </td>
        ) : null}
        {isColumnVisible("taskType") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs overflow-hidden text-slate-500">{getPlanTaskLabel(plan)}</td>
        ) : null}
        {isColumnVisible("startDate") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs tabular-nums overflow-hidden text-slate-500">{formatDate(plan.startDate)}</td>
        ) : null}
        {isColumnVisible("targetAccount") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs overflow-hidden">
            <AccountCell label={planAccountLabel(plan)} title={plan.accountHoverTitle} />
          </td>
        ) : null}
        {isColumnVisible("cashAccount") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs overflow-hidden">
            <AccountCell label={planCashAccountLabel(plan)} title={plan.cashAccountHoverTitle} />
          </td>
        ) : null}
        {isColumnVisible("amount") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-right text-xs tabular-nums overflow-hidden text-slate-700">
            {Number(plan.amount || 0).toFixed(2)}
          </td>
        ) : null}
        {isColumnVisible("interval") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs overflow-hidden text-slate-500">{formatInterval(plan)}</td>
        ) : null}
        {isColumnVisible("status") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs overflow-hidden">
            <span className={STATUS_MAP[plan.status]?.cls || "text-slate-600"}>{STATUS_MAP[plan.status]?.label || plan.status}</span>
          </td>
        ) : null}
        {isColumnVisible("executedCount") ? (
          <td className="border-b border-r border-slate-100 px-3 py-1 text-xs tabular-nums overflow-hidden text-slate-500">
            {plan.executedCount || 0}笔({(plan.executedAmount || 0).toFixed(2)})
          </td>
        ) : null}
        <td className="border-b border-slate-100 px-2 py-1">
          <div className="flex items-center justify-end gap-1">
            {plan.status === "active" && (
              <>
                <button
                  onClick={(e) => { e.stopPropagation(); handleBatchExecute(plan.id); }}
                  disabled={executionBusy}
                  title="批量执行"
                  className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white hover:border-purple-200 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw className={`h-3 w-3 text-purple-600 ${executionBusy ? "animate-spin" : ""}`} />
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
              <button
                onClick={handleBatchExecuteAll}
                disabled={executionBusy}
                title="批量执行所有计划任务"
                className="flex h-8 items-center gap-1 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${executionBusy ? "animate-spin" : ""}`} />执行全部
              </button>
              <button onClick={() => setShowCreateForm(true)} className="flex h-8 items-center gap-1 rounded-md bg-blue-600 px-3 text-sm text-white hover:bg-blue-700">
                <Plus className="h-4 w-4" />新增计划
              </button>
            </div>
            <div className="flex h-11 items-center justify-between bg-slate-50 px-4">
              <div className="flex items-center gap-3 text-sm">
                <span className="font-semibold text-slate-800">计划任务</span>
                <span className="text-slate-500">
                  共 {filteredPlans.length} 个计划，{filteredPlans.filter((plan) => plan.status === "active").length} 个执行中
                </span>
                <select
                  value={groupBy}
                  onChange={(e) => setGroupBy(e.target.value as GroupByMode)}
                  className="ml-4 h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none"
                >
                  <option value="fundGroup">按目标账户所有人</option>
                  <option value="fundAccount">按目标账户</option>
                  <option value="cashGroup">按资金账户所有人</option>
                  <option value="cashAccount">按资金账户</option>
                  <option value="none">不按所有人</option>
                </select>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-slate-500">
                  <input type="checkbox" checked={!showEnded} onChange={(e) => setShowEnded(!e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />
                  不显示已结束计划
                </label>
                <div ref={columnMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setColumnFilterOpen((current) => !current)}
                    className="secondary-button h-7 px-2 text-xs"
                    title="表头设置"
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    <span>表头设置</span>
                  </button>
                  {columnFilterOpen ? (
                    <div className="absolute right-0 top-8 z-50 w-48 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
                      <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">显示列</div>
                      <div className="max-h-56 space-y-1 overflow-y-auto">
                        {REGULAR_INVEST_COLUMNS.map((column) => {
                          const checked = isColumnVisible(column.key);
                          const disabled = checked && visibleRegularInvestColumns.length <= 1;
                          return (
                            <label
                              key={column.key}
                              className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
                                disabled ? "text-slate-400" : "cursor-pointer text-slate-700 hover:bg-slate-50"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={disabled}
                                onChange={() => toggleColumnVisibility(column.key)}
                                className="h-3.5 w-3.5 rounded border-slate-300"
                              />
                              <span className="truncate">{column.label}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div ref={tableViewportRef} className={`${selectedPlan ? "min-h-[240px] flex-1 overflow-auto border-b border-slate-200 bg-white" : "min-h-0 flex-1 overflow-auto bg-white"}`}>
              <table className="table-fixed w-full border-separate border-spacing-0" style={{ minWidth: mainTableWidth }}>
                <colgroup>
                  {visibleRegularInvestColumns.map((column) => (
                    <col key={column.key} style={{ width: layoutColumnWidth(column.key) }} />
                  ))}
                  <col style={{ width: layoutColumnWidth("actions") }} />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-white">
                  <tr>
                    {visibleRegularInvestColumns.map((column) => renderHeaderCell(column))}
                    <th className="relative select-none border-b border-slate-200 px-2 py-2 text-right text-xs font-semibold text-slate-600">
                      操作
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        onMouseDown={(event) => beginColumnResize(event, "actions")}
                        className="absolute right-[-3px] top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none hover:bg-blue-300/40"
                        title="拖动调整列宽"
                      />
                    </th>
                  </tr>
                </thead>
                <tbody className="text-sm">
                  {groupedPlans.length === 0 || groupedPlans[0].items.length === 0 ? (
                    <tr><td className="px-3 py-6 text-xs text-slate-500" colSpan={mainTableColSpan}>暂无计划任务</td></tr>
                  ) : (
                    groupedPlans.map((group, index) => (
                      group.label ? (
                        <Fragment key={`g-${index}`}>
                          <tr className="bg-slate-50">
                            <td className="px-3 py-1.5 text-xs font-semibold text-slate-600" colSpan={mainTableColSpan}>
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
              <div className="flex h-80 shrink-0 flex-col bg-slate-50">
                <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-100 bg-white px-4">
                  <div className="text-xs font-semibold text-slate-700">{getPlanTargetLabel(selectedPlan)} - 执行记录</div>
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
                          <th className="px-3 py-1.5 text-left font-medium text-slate-600">执行日期</th>
                          {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                            <th className="px-3 py-1.5 text-left font-medium text-slate-600">确认日期</th>
                          )}
                          <th className="px-3 py-1.5 text-right font-medium text-slate-600">金额</th>
                          {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                            <th className="px-3 py-1.5 text-right font-medium text-slate-600">份额</th>
                          )}
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
                              {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                                <td className="px-3 py-1.5 tabular-nums text-slate-500">{formatDate(record.fundConfirmDate)}</td>
                              )}
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{(Math.abs(Number(record.amount)) || 0).toFixed(2)}</td>
                              {getPlanTaskType(selectedPlan) === "fund_regular_invest" && (
                                <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{isConfirmed ? Number(record.fundUnits).toFixed(2) : "-"}</td>
                              )}
                              <td className="px-3 py-1.5 text-center">
                                {getPlanTaskType(selectedPlan) === "fund_regular_invest"
                                  ? (isConfirmed ? <span className="text-emerald-600">已确认</span> : <span className="text-amber-600">待确认</span>)
                                  : <span className="text-emerald-600">已执行</span>}
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
              <div className="text-sm font-semibold text-slate-800">删除计划任务</div>
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
                <DateStepper
                  value={editingRecord.date}
                  onChange={(newDate) => {
                    setEditingRecord((record: any) => ({ ...record, date: newDate, fundConfirmDate: addWorkdaysUtc(newDate, editingRecord.confirmDays) }));
                  }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
                <div className="text-xs text-slate-400">修改申请日期会自动重算确认日期 (T+{editingRecord.confirmDays})</div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">确认日期</div>
                <DateStepper
                  value={editingRecord.fundConfirmDate}
                  onChange={(value) => setEditingRecord((record: any) => ({ ...record, fundConfirmDate: value }))}
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
