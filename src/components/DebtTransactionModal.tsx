"use client";

import { ChevronDown, Plus, Repeat } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm } from "./EntityCreateForm";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { institutionTypeLabel } from "@/lib/account-kinds";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageAnnualRateFromLprDiscount,
  getLatestFiveYearLpr,
  MORTGAGE_BASE_BENCHMARK_RATE,
} from "@/lib/loan-lpr";
import { getEffectiveLoanAnnualRate, type LoanRateAdjustment } from "@/lib/loan-repayment";

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type PrepayStrategy = "reduce_term" | "reduce_payment" | "settle";

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  institutionId?: string | null;
  counterpartyId?: string | null;
  institutionType?: string | null;
  isInstitutionLoan?: boolean;
  debtDirection?: "payable" | "receivable" | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type HistoricalRateRow = { key: string; effectiveDate: string; annualRate: string };
type RepaymentLprCheck = {
  mortgageLprDiscount: number | null;
  currentAnnualRate: number | null;
  loanRateAdjustments: LoanRateAdjustment[];
};

const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

const MODE_LABELS: Record<DebtMode, string> = {
  borrow_in: "借入",
  repay_out: "还款",
  prepay_out: "提前还款",
  lend_out: "借出",
  collect_in: "收回",
};

const PREPAY_STRATEGY_LABELS: Record<PrepayStrategy, string> = {
  reduce_term: "月供不变，缩短期限",
  reduce_payment: "期限不变，减少月供",
  settle: "全部结清",
};

const FIXED_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", "先还利息一次性还本"]);

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addMonthsInput(dateInput: string, months: number) {
  const date = new Date(`${dateInput}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return dateInput;
  date.setMonth(date.getMonth() + months);
  return formatDateInput(date);
}

function dateInputTime(value: string) {
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : null;
}

function shouldPromptHistoricalRepayments(params: {
  mode: DebtMode;
  isFixedRepaymentMethod: boolean;
  firstRepaymentDate: string;
  today: string;
  repaymentIntervalMonths: string;
}) {
  if (params.mode !== "borrow_in" || !params.isFixedRepaymentMethod || !params.firstRepaymentDate) return false;
  const intervalMonths = Math.max(1, Number(params.repaymentIntervalMonths) || 1);
  const thresholdTime = dateInputTime(addMonthsInput(params.today, -intervalMonths));
  const firstTime = dateInputTime(params.firstRepaymentDate);
  return firstTime != null && thresholdTime != null && firstTime <= thresholdTime;
}

function parsePositiveNumberText(value: string) {
  const num = Number(value.replace(/,/g, ""));
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parseMoneyText(value: string) {
  const num = Number(value.replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function isValidDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function createHistoricalRateRow(defaultDate = "", defaultRate = ""): HistoricalRateRow {
  return {
    key: `rate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    effectiveDate: defaultDate,
    annualRate: defaultRate,
  };
}

function debtObjectOptionId(id: string, type?: string | null) {
  return `${COUNTERPARTY_TYPES.has(type ?? "") ? "counterparty" : "institution"}:${id}`;
}

function rawDebtObjectId(value: string) {
  const match = /^(?:counterparty|institution):(.+)$/.exec(value);
  return match?.[1] ?? value;
}

function normalizeDebtObjectValue(value: string | undefined, data?: NestedFieldData) {
  const id = String(value ?? "").trim();
  if (!id || /^(?:counterparty|institution):/.test(id)) return id;
  if ((data?.counterpartyId ?? []).some((entry) => entry.id === id)) return `counterparty:${id}`;
  const item = (data?.institutionId ?? []).find((entry) => entry.id === id);
  return item ? debtObjectOptionId(item.id, item.type) : id;
}

function serializeHistoricalRateRows(rows: HistoricalRateRow[]) {
  const filledRows = rows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim());
  if (filledRows.length === 0) {
    return { ok: false as const, error: "请至少添加一条历史利率调整" };
  }

  const seenDates = new Set<string>();
  const normalized = filledRows.map((row) => {
    const effectiveDate = row.effectiveDate.trim();
    const annualRate = Number(row.annualRate.trim());
    if (!isValidDateInput(effectiveDate)) {
      return { ok: false as const, error: "历史利率的生效日期不正确" };
    }
    if (seenDates.has(effectiveDate)) {
      return { ok: false as const, error: `历史利率的生效日期重复：${effectiveDate}` };
    }
    seenDates.add(effectiveDate);
    if (!Number.isFinite(annualRate) || annualRate <= 0) {
      return { ok: false as const, error: "历史利率必须大于 0" };
    }
    return { ok: true as const, effectiveDate, annualRate };
  });
  const invalid = normalized.find((row) => !row.ok);
  if (invalid && !invalid.ok) return invalid;

  const text = normalized
    .filter((row): row is { ok: true; effectiveDate: string; annualRate: number } => row.ok)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .map((row) => `${row.effectiveDate} ${row.annualRate}`)
    .join("\n");

  return { ok: true as const, text };
}

export function DebtTransactionModal({
  debtAccounts,
  cashAccounts,
  debtObjectOptions,
  cashAccountSSOptions,
  nestedFieldData,
  defaultDebtAccountId,
  defaultDebtInstitutionId,
  defaultCashAccountId,
  action,
  showTriggerButton = true,
}: {
  debtAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  debtObjectOptions?: SmartSelectOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
  defaultDebtAccountId?: string;
  defaultDebtInstitutionId?: string;
  defaultCashAccountId?: string;
  action: (formData: FormData) => Promise<{ ok: true; warning?: string } | { ok: false; error: string }>;
  showTriggerButton?: boolean;
}) {
  const router = useRouter();
  const today = useMemo(() => formatDateInput(new Date()), []);
  const debtItemListId = useId();
  const [localDebtAccounts, setLocalDebtAccounts] = useState(debtAccounts);
  const [localDebtObjectOptions, setLocalDebtObjectOptions] = useState(debtObjectOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const [debtObjectNestedOpen, setDebtObjectNestedOpen] = useState(false);
  const fallbackDebtObjectOptions: SmartSelectOption[] = useMemo(
    () => [
      ...(localNestedFieldData?.counterpartyId ?? []).map((item) => ({
        id: `counterparty:${item.id}`,
        label: item.name,
        subLabel: item.type === "person" ? "往来人员" : "往来组织",
      })),
      ...(localNestedFieldData?.institutionId ?? [])
        .filter((item) => item.type === "bank")
        .map((item) => ({
          id: `institution:${item.id}`,
          label: item.name,
          subLabel: institutionTypeLabel(item.type ?? null),
        })),
    ],
    [localNestedFieldData],
  );
  const visibleDebtObjectOptions = useMemo(
    () => mergeSmartSelectOptions(
      mergeSmartSelectOptions(debtObjectOptions, localDebtObjectOptions),
      fallbackDebtObjectOptions,
    ),
    [debtObjectOptions, fallbackDebtObjectOptions, localDebtObjectOptions],
  );
  const debtObjectById = useMemo(
    () => new Map<string, { id: string; name: string; type?: string }>([
      ...((localNestedFieldData?.counterpartyId ?? nestedFieldData?.counterpartyId ?? []).map((item) => [`counterparty:${item.id}`, item] as const)),
      ...((localNestedFieldData?.institutionId ?? nestedFieldData?.institutionId ?? [])
        .filter((item) => item.type === "bank")
        .map((item) => [`institution:${item.id}`, item] as const)),
    ]),
    [localNestedFieldData, nestedFieldData],
  );
  const cashOptions: SmartSelectOption[] = useMemo(
    () => cashAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel })),
    [cashAccounts],
  );
  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashAccountSSFiltered,
  } = useAccountSSFilter(cashAccountSSOptions);
  const recentAccountIds = useRecentAccountIds();
  const visibleCashOptions = sortOptionsByRecent(cashAccountSSFiltered ?? cashAccountSSOptions ?? cashOptions, recentAccountIds);
  const cashOwnerCycleButton = cashAccountSSOptions?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleCashOwnerFilter}
      title={`所有人：${cashOwnerFilterLabel}`}
      aria-label={`切换所有人，当前 ${cashOwnerFilterLabel}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState("");
  const [mode, setMode] = useState<DebtMode>("borrow_in");
  const [date, setDate] = useState(today);
  const [debtAccountId, setDebtAccountId] = useState(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
  const [debtInstitutionId, setDebtInstitutionId] = useState(normalizeDebtObjectValue(defaultDebtInstitutionId, nestedFieldData));
  const [debtItemName, setDebtItemName] = useState("");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [interest, setInterest] = useState("");
  const [penalty, setPenalty] = useState("");
  const [prepayStrategy, setPrepayStrategy] = useState<PrepayStrategy>("reduce_term");
  const [annualRate, setAnnualRate] = useState("");
  const [mortgageLprDiscount, setMortgageLprDiscount] = useState("");
  const [repaymentMethod, setRepaymentMethod] = useState("自由还款");
  const [repaymentIntervalMonths, setRepaymentIntervalMonths] = useState("1");
  const [loanTotalRuns, setLoanTotalRuns] = useState("300");
  const [firstRepaymentDate, setFirstRepaymentDate] = useState(addMonthsInput(today, 1));
  const [note, setNote] = useState("");
  const [historyConfirmOpen, setHistoryConfirmOpen] = useState(false);
  const [pendingKeepAdding, setPendingKeepAdding] = useState(false);
  const [createHistoricalRepaymentRecords, setCreateHistoricalRepaymentRecords] = useState(false);
  const [showHistoricalRates, setShowHistoricalRates] = useState(false);
  const [historicalRateRows, setHistoricalRateRows] = useState<HistoricalRateRow[]>([]);
  const [historicalRatesOpen, setHistoricalRatesOpen] = useState(false);
  const [repaymentLprCheck, setRepaymentLprCheck] = useState<RepaymentLprCheck | null>(null);

  function mergeSmartSelectOptions(base?: SmartSelectOption[], extra?: SmartSelectOption[]) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((option) => option.id));
    for (const option of extra ?? []) {
      if (!seen.has(option.id)) merged.push(option);
    }
    return merged;
  }

  async function openDebtObjectCreate() {
    setDebtObjectNestedOpen(true);
    const res = await fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.ok) return;
    setLocalNestedFieldData({
      groupId: (data.groups ?? [])
        .filter((group: { name: string }) => group.name !== "未指定")
        .map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
      institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
        id: institution.id,
        name: institution.shortName?.trim() || institution.name,
        type: institution.type ?? "",
      })),
      counterpartyId: (data.counterparties ?? []).map((counterparty: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
        id: counterparty.id,
        name: counterparty.shortName?.trim() || counterparty.name,
        type: counterparty.type ?? "organization",
      })),
    });
  }

  const resetDraft = useCallback(() => {
    setMode("borrow_in");
    setEditingEntryId("");
    setDate(today);
    setDebtAccountId(defaultDebtAccountId ?? localDebtAccounts[0]?.id ?? "");
    setDebtInstitutionId(normalizeDebtObjectValue(defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData));
    setDebtItemName("");
    setCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setPrincipal("");
    setInterest("");
    setPenalty("");
    setPrepayStrategy("reduce_term");
    setAnnualRate("");
    setMortgageLprDiscount("");
    setRepaymentMethod("自由还款");
    setRepaymentIntervalMonths("1");
    setLoanTotalRuns("300");
    setFirstRepaymentDate(addMonthsInput(today, 1));
    setNote("");
    setHistoryConfirmOpen(false);
    setPendingKeepAdding(false);
    setCreateHistoricalRepaymentRecords(false);
    setShowHistoricalRates(false);
    setHistoricalRateRows([]);
    setHistoricalRatesOpen(false);
    setRepaymentLprCheck(null);
  }, [cashAccounts, defaultCashAccountId, defaultDebtAccountId, defaultDebtInstitutionId, localDebtAccounts, localNestedFieldData, nestedFieldData, today]);

  useEffect(() => {
    setLocalDebtAccounts(debtAccounts);
  }, [debtAccounts]);

  useEffect(() => {
    setLocalDebtObjectOptions(debtObjectOptions);
  }, [debtObjectOptions]);

  useEffect(() => {
    setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId?: string;
        editEntryId?: string;
        mode?: DebtMode;
        defaultDebtAccountId?: string;
        defaultDebtInstitutionId?: string;
        defaultCashAccountId?: string;
        defaultDate?: string;
        defaultPrincipal?: number | string | null;
        defaultInterest?: number | string | null;
        defaultPrepayStrategy?: PrepayStrategy;
        defaultCurrentAnnualRate?: number | null;
        defaultMortgageLprDiscount?: number | null;
        defaultLoanRateAdjustments?: LoanRateAdjustment[];
      }>).detail;
      resetDraft();
      if (detail?.editEntryId) setEditingEntryId(detail.editEntryId);
      if (detail?.mode) setMode(detail.mode);
      if (detail?.defaultDate) setDate(detail.defaultDate);
      if (detail?.defaultDebtAccountId) setDebtAccountId(detail.defaultDebtAccountId);
      if (detail?.mode && detail.mode !== "borrow_in") {
        setDebtInstitutionId("");
      } else if (detail?.defaultDebtInstitutionId) {
        setDebtInstitutionId(normalizeDebtObjectValue(detail.defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData));
      }
      if (detail?.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultPrincipal != null) setPrincipal(String(detail.defaultPrincipal));
      if (detail?.defaultInterest != null) setInterest(String(detail.defaultInterest));
      if (detail?.defaultPrepayStrategy) setPrepayStrategy(detail.defaultPrepayStrategy);
      if (detail?.mode === "repay_out" || detail?.mode === "prepay_out") {
        setRepaymentLprCheck({
          mortgageLprDiscount: detail.defaultMortgageLprDiscount ?? null,
          currentAnnualRate: detail.defaultCurrentAnnualRate ?? null,
          loanRateAdjustments: detail.defaultLoanRateAdjustments ?? [],
        });
      }
      setOpen(true);
    }
    window.addEventListener("mmh:debt:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:debt:create", onCreate as EventListener);
  }, [defaultCashAccountId, defaultDebtAccountId, localNestedFieldData, nestedFieldData, resetDraft]);
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  function getPendingRepaymentLprAdjustment() {
    if ((mode !== "repay_out" && mode !== "prepay_out") || editingEntryId || !repaymentLprCheck) return null;
    const discount = repaymentLprCheck.mortgageLprDiscount;
    if (discount == null || !Number.isFinite(discount) || discount <= 0 || !isValidDateInput(date)) return null;
    const lpr = getLatestFiveYearLpr(date);
    if (!lpr) return null;
    const annualRate = calcMortgageAnnualRateFromLprDiscount({ discount, lprRate: lpr.fiveYearRate });
    const currentAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: repaymentLprCheck.currentAnnualRate,
      adjustments: repaymentLprCheck.loanRateAdjustments,
      date,
    });
    if (currentAnnualRate != null && Math.abs(annualRate - currentAnnualRate) < 0.0005) return null;
    return {
      effectiveDate: date,
      annualRate,
      lprRate: lpr.fiveYearRate,
      currentAnnualRate,
    };
  }

  async function saveDebtTransaction(keepAdding: boolean, options?: { skipHistoryPrompt?: boolean }) {
    if (submitting) return;
    const requiresLoanScheduleFields = mode === "borrow_in" && FIXED_REPAYMENT_METHODS.has(repaymentMethod);
    if (requiresLoanScheduleFields) {
      if (!parsePositiveNumberText(annualRate)) {
        window.alert("固定还款方式需要填写年利率");
        return;
      }
      if (!parsePositiveNumberText(loanTotalRuns)) {
        window.alert("固定还款方式需要填写总期数");
        return;
      }
      if (!firstRepaymentDate) {
        window.alert("固定还款方式需要填写首次还款日");
        return;
      }
    }
    if (
      !options?.skipHistoryPrompt &&
      shouldPromptHistoricalRepayments({
        mode,
        isFixedRepaymentMethod,
        firstRepaymentDate,
        today,
        repaymentIntervalMonths,
      })
    ) {
      setPendingKeepAdding(keepAdding);
      setCreateHistoricalRepaymentRecords(false);
      setShowHistoricalRates(false);
      setHistoricalRateRows([]);
      setHistoricalRatesOpen(false);
      setHistoryConfirmOpen(true);
      return;
    }
    const historicalRates = showHistoricalRates
      ? serializeHistoricalRateRows(historicalRateRows)
      : { ok: true as const, text: "" };
    if (!historicalRates.ok) {
      window.alert(historicalRates.error);
      setHistoricalRatesOpen(true);
      return;
    }
    const pendingLprAdjustment = getPendingRepaymentLprAdjustment();
    const acceptedLprAdjustment = pendingLprAdjustment && window.confirm(
      [
        `查询到还款日 ${pendingLprAdjustment.effectiveDate} 对应的 5年期以上 LPR 为 ${pendingLprAdjustment.lprRate.toFixed(3).replace(/\.?0+$/, "")}%。`,
        `按当前贷款折扣计算的新年利率为 ${pendingLprAdjustment.annualRate.toFixed(3).replace(/\.?0+$/, "")}%。`,
        pendingLprAdjustment.currentAnnualRate == null
          ? "当前计划还没有可比较的执行利率。"
          : `当前计划执行利率为 ${pendingLprAdjustment.currentAnnualRate.toFixed(3).replace(/\.?0+$/, "")}%。`,
        "是否接受新利率，并随本次还款一起保存为利率调整？",
      ].join("\n"),
    )
      ? pendingLprAdjustment
      : null;

    const formData = new FormData();
    formData.set("editEntryId", editingEntryId);
    formData.set("mode", mode);
    formData.set("date", date);
    formData.set("debtAccountId", mode === "borrow_in" && debtInstitutionId ? "" : debtAccountId);
    formData.set("debtObjectId", mode === "borrow_in" ? debtInstitutionId : "");
    formData.set("debtInstitutionId", mode === "borrow_in" ? rawDebtObjectId(debtInstitutionId) : "");
    formData.set("debtItemName", debtItemName);
    formData.set("cashAccountId", cashAccountId);
    formData.set("principal", principal);
    formData.set("interest", interest);
    formData.set("penalty", penalty);
    formData.set("prepayStrategy", prepayStrategy);
    formData.set("annualRate", annualRate);
    formData.set("mortgageLprDiscount", mortgageLprDiscount);
    formData.set("repaymentMethod", repaymentMethod);
    formData.set("repaymentIntervalMonths", repaymentIntervalMonths);
    formData.set("loanTotalRuns", loanTotalRuns);
    formData.set("firstRepaymentDate", firstRepaymentDate);
    formData.set("createRepaymentPlan", showBorrowPlan && isFixedRepaymentMethod ? "true" : "false");
    formData.set("createHistoricalRepaymentRecords", createHistoricalRepaymentRecords ? "true" : "false");
    formData.set("historicalLoanRates", historicalRates.text);
    if (acceptedLprAdjustment) {
      formData.set("acceptedLprRateEffectiveDate", acceptedLprAdjustment.effectiveDate);
      formData.set("acceptedLprAnnualRate", String(acceptedLprAdjustment.annualRate));
    }
    formData.set("note", note);

    setSubmitting(true);
    try {
      const res = await action(formData);
      if (!res.ok) {
        window.alert(res.error);
        return;
      }
      if (res.warning) {
        window.alert(res.warning);
      }
      router.refresh();
      if (keepAdding) {
        setPrincipal("");
        setInterest("");
        setPenalty("");
        setPrepayStrategy("reduce_term");
        setAnnualRate("");
        setMortgageLprDiscount("");
        setRepaymentMethod("自由还款");
        setRepaymentIntervalMonths("1");
        setLoanTotalRuns("300");
        setFirstRepaymentDate(addMonthsInput(today, 1));
        setCreateHistoricalRepaymentRecords(false);
        setShowHistoricalRates(false);
        setHistoricalRateRows([]);
        setHistoricalRatesOpen(false);
        setDebtItemName("");
        setNote("");
      } else {
        setOpen(false);
        setHistoryConfirmOpen(false);
        resetDraft();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveDebtTransaction(false);
  }

  async function confirmHistoricalPrompt() {
    setHistoryConfirmOpen(false);
    await saveDebtTransaction(pendingKeepAdding, { skipHistoryPrompt: true });
  }

  const showInterest = mode === "repay_out" || mode === "collect_in" || mode === "prepay_out";
  const showPrepayment = mode === "prepay_out";
  const showBorrowPlan = mode === "borrow_in";
  const repaymentTotal = useMemo(() => {
    if (!showInterest || (!principal.trim() && !interest.trim())) return "";
    return (parseMoneyText(principal) + parseMoneyText(interest) + (showPrepayment ? parseMoneyText(penalty) : 0)).toFixed(2);
  }, [interest, penalty, principal, showInterest, showPrepayment]);
  const cashAccountLabel = mode === "borrow_in"
    ? "入账账户"
    : mode === "repay_out" || mode === "prepay_out"
      ? "支出账户"
      : mode === "collect_in"
        ? "收入账户"
        : "支出账户";
  const debtAccountOptions: SmartSelectOption[] = useMemo(
    () => localDebtAccounts
      .filter((account) => {
        if (mode === "repay_out" || mode === "prepay_out") return account.debtDirection === "payable";
        if (mode === "collect_in") return account.debtDirection === "receivable";
        return true;
      })
      .map((account) => ({ id: account.id, label: account.label, subLabel: account.subLabel })),
    [localDebtAccounts, mode],
  );
  const debtItemSuggestions = useMemo(
    () => Array.from(new Set(localDebtAccounts
      .filter((account) => {
        if (!debtInstitutionId) return true;
        const rawId = rawDebtObjectId(debtInstitutionId);
        if (debtInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
        return account.institutionId === rawId;
      })
      .map((account) => account.label.split("·").pop()?.trim() || account.label.trim())
      .filter(Boolean))),
    [debtInstitutionId, localDebtAccounts],
  );
  const selectedDebtObjectName = debtObjectById.get(debtInstitutionId)?.name?.trim() || "往来对象";
  const disabled = cashAccounts.length === 0;
  const isFixedRepaymentMethod = FIXED_REPAYMENT_METHODS.has(repaymentMethod);
  function applyMortgageLprDiscount() {
    const discount = Number(mortgageLprDiscount.trim());
    if (!Number.isFinite(discount) || discount <= 0) {
      window.alert("请填写正确的利率折扣，例如 0.85");
      return;
    }
    setAnnualRate((MORTGAGE_BASE_BENCHMARK_RATE * discount).toFixed(3).replace(/\.?0+$/, ""));
    const adjustments = buildMortgageLprRateAdjustments({ discount, throughDate: today });
    if (adjustments.length > 0) {
      setHistoricalRateRows(adjustments.map((item) => createHistoricalRateRow(
        item.effectiveDate,
        item.annualRate.toFixed(3).replace(/\.?0+$/, ""),
      )));
      setShowHistoricalRates(true);
    }
  }

  return (
    <>
      {showTriggerButton ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            resetDraft();
          }}
          disabled={disabled}
          className="primary-button h-8 gap-1 px-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {editingEntryId ? "编辑还款" : "借还款"}
          <ChevronDown className="w-4 h-4 opacity-90" />
        </button>
      ) : null}

      {open
        ? createPortal(
            <div className="app-modal-backdrop z-50">
              <div className="app-modal-panel max-w-xl">
                  <div className="modal-header shrink-0">
                    <div className="text-sm font-semibold text-slate-800">{editingEntryId ? "编辑还款" : "往来款"}</div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          resetDraft();
                        }}
                        className="secondary-button h-8 px-2"
                      >
                        关闭
                      </button>
                    </div>
                  </div>

                  <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
                    <div className="grid grid-cols-5 gap-2">
                      {(Object.keys(MODE_LABELS) as DebtMode[]).map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setMode(item)}
                          disabled={!!editingEntryId && item !== "repay_out" && item !== "prepay_out"}
                          className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                        >
                          {MODE_LABELS[item]}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? "入账日期" : "日期"}</div>
                        <DateStepper name="date" value={date} onChange={setDate} />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? "往来对象" : mode === "repay_out" || mode === "prepay_out" ? "借款项" : "借出项"}</div>
                        {mode === "borrow_in" ? (
                          <SmartSelect
                            mode="single"
                            value={debtInstitutionId}
                            onChange={(id) => {
                              setDebtInstitutionId(id);
                              setDebtAccountId("");
                              setDebtItemName("");
                            }}
                            options={mergeSmartSelectOptions(visibleDebtObjectOptions, [])}
                            placeholder="请选择"
                            onCreateClick={() => { void openDebtObjectCreate(); }}
                            createLabel="新增往来对象"
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: false,
                              minDropdownWidth: 320,
                            }}
                          />
                        ) : (
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={setDebtAccountId}
                            options={debtAccountOptions}
                            placeholder={mode === "repay_out" || mode === "prepay_out" ? "请选择已有借款项" : "请选择已有借出项"}
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: false,
                              minDropdownWidth: 360,
                            }}
                          />
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {mode === "borrow_in" ? (
                        <div className="space-y-1">
                          <div className="form-label">款项内容 <span className="text-slate-400">可选</span></div>
                          <input
                            value={debtItemName}
                            onChange={(event) => setDebtItemName(event.target.value)}
                            list={debtItemListId}
                            placeholder={`不填则生成“${selectedDebtObjectName}的往来款”`}
                            className="form-input"
                          />
                          <datalist id={debtItemListId}>
                            {debtItemSuggestions.map((name) => <option key={name} value={name} />)}
                          </datalist>
                        </div>
                      ) : null}
                      <div className={mode === "borrow_in" ? "space-y-1" : "col-span-2 space-y-1"}>
                        <div className="form-label">{cashAccountLabel}</div>
                        <SmartSelect
                          mode="single"
                          value={cashAccountId}
                          onChange={setCashAccountId}
                          options={visibleCashOptions}
                          placeholder="请选择"
                          behavior={{
                            hierarchy: "auto",
                            search: "auto",
                            clearable: false,
                            headerExtra: cashOwnerCycleButton,
                          }}
                        />
                      </div>
                    </div>

                    <div className={`grid gap-3 ${showInterest ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? "借款总额" : mode === "prepay_out" ? "提前还本金" : mode === "repay_out" || mode === "collect_in" ? "本金" : "金额"}</div>
                        <CalcInput value={principal} onChange={setPrincipal} placeholder="例如：1000" label="金额" precision={2} />
                      </div>
                      {showInterest ? (
                        <div className="space-y-1">
                          <div className="form-label">利息</div>
                          <CalcInput value={interest} onChange={setInterest} placeholder="可选，例如：23.5" label="利息" precision={2} />
                        </div>
                      ) : null}
                      {showInterest && !showPrepayment ? (
                        <div className="space-y-1">
                          <div className="form-label">本息合计</div>
                          <input
                            value={repaymentTotal}
                            readOnly
                            placeholder="自动计算"
                            className="form-input bg-slate-50 text-right font-mono text-slate-700"
                          />
                        </div>
                      ) : null}
                    </div>

                    {showPrepayment ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          <div className="space-y-1">
                            <div className="form-label">手续费/违约金</div>
                            <CalcInput value={penalty} onChange={setPenalty} placeholder="可选" label="手续费" precision={2} />
                          </div>
                          <div className="space-y-1 sm:col-span-2">
                            <div className="form-label">处理后续还款计划</div>
                            <select
                              value={prepayStrategy}
                              onChange={(event) => setPrepayStrategy(event.target.value as PrepayStrategy)}
                              className="form-input"
                            >
                              {(Object.keys(PREPAY_STRATEGY_LABELS) as PrepayStrategy[]).map((item) => (
                                <option key={item} value={item}>{PREPAY_STRATEGY_LABELS[item]}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1 sm:col-span-3">
                            <div className="form-label">支出合计</div>
                            <input
                              value={repaymentTotal}
                              readOnly
                              placeholder="自动计算"
                              className="form-input bg-slate-50 text-right font-mono text-slate-700"
                            />
                          </div>
                        </div>
                      </>
                    ) : null}

                    {showBorrowPlan ? (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <div className="form-label">还款方式</div>
                            <select value={repaymentMethod} onChange={(event) => setRepaymentMethod(event.target.value)} className="form-input">
                              <option value="等额本息">等额本息</option>
                              <option value="等额本金">等额本金</option>
                              <option value="自由还款">自由还款</option>
                              <option value="先还利息一次性还本">先还利息一次性还本</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">
                              年利率（%） {isFixedRepaymentMethod ? <span className="text-red-500">*</span> : <span className="text-slate-400">可选</span>}
                            </div>
                            <input
                              value={annualRate}
                              onChange={(event) => setAnnualRate(event.target.value)}
                              placeholder="例如：3.45"
                              inputMode="decimal"
                              className="form-input"
                            />
                          </div>
                          {isFixedRepaymentMethod ? (
                            <div className="space-y-1">
                              <div className="form-label">房贷 LPR 折扣 <span className="text-slate-400">可选</span></div>
                              <div className="flex gap-2">
                                <input
                                  value={mortgageLprDiscount}
                                  onChange={(event) => setMortgageLprDiscount(event.target.value)}
                                  placeholder="例如：0.85"
                                  inputMode="decimal"
                                  className="form-input"
                                />
                                <button
                                  type="button"
                                  className="secondary-button h-9 shrink-0 px-3 text-xs"
                                  onClick={applyMortgageLprDiscount}
                                >
                                  套用
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        {isFixedRepaymentMethod ? (
                          <>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <div className="form-label">还款周期 <span className="text-red-500">*</span></div>
                                <select value={repaymentIntervalMonths} onChange={(event) => setRepaymentIntervalMonths(event.target.value)} className="form-input">
                                  <option value="1">每月</option>
                                  <option value="3">每季度</option>
                                  <option value="6">每半年</option>
                                  <option value="12">每年</option>
                                </select>
                              </div>
                              <div className="space-y-1">
                                <div className="form-label">总期数 <span className="text-red-500">*</span></div>
                                <input
                                  type="number"
                                  min={1}
                                  max={600}
                                  value={loanTotalRuns}
                                  onChange={(event) => setLoanTotalRuns(event.target.value)}
                                  className="form-input"
                                />
                              </div>
                            </div>

                            <div className="space-y-1">
                              <div className="form-label">首次还款日 <span className="text-red-500">*</span></div>
                              <DateStepper value={firstRepaymentDate} onChange={setFirstRepaymentDate} />
                            </div>
                          </>
                        ) : (
                          <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            自由还款不生成固定还款计划，后续按实际还款时逐笔登记。
                          </div>
                        )}
                      </>
                    ) : null}

                    {!showBorrowPlan ? (
                      <>
                        <div className="space-y-1">
                          <div className="form-label">备注</div>
                          <input
                            name="note"
                            placeholder="可选"
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            className="form-input"
                          />
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                          {mode === "repay_out"
                            ? "还款会冲减借入本金；如填写利息，会另外记一笔利息支出。"
                            : mode === "prepay_out"
                              ? "提前还款只冲减本金，不计入计划任务已执行次数；保存后会按上方选择调整后续还款计划。"
                            : mode === "lend_out"
                              ? "借出会从资金账户转出，同时形成借出余额。"
                              : "收回会冲减借出本金；如填写利息，会另外记一笔利息收入。"}
                        </div>
                      </>
                    ) : null}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button type="button" className="secondary-button h-9 px-3" disabled={submitting} onClick={() => saveDebtTransaction(true)}>
                        {submitting ? "保存中…" : "保存并再记一笔"}
                      </button>
                      <button type="submit" className="primary-button h-9 px-3" disabled={submitting}>
                        {submitting ? "保存中…" : "保存"}
                      </button>
                    </div>
                  </form>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historyConfirmOpen
        ? createPortal(
            <div className="app-modal-backdrop z-[60]">
              <div className="app-modal-panel max-w-lg">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">确认历史还款记录</div>
                  <button
                    type="button"
                    onClick={() => setHistoryConfirmOpen(false)}
                    className="secondary-button h-8 px-2"
                    disabled={submitting}
                  >
                    返回
                  </button>
                </div>
                <div className="space-y-3 p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    首次还款日 {firstRepaymentDate || "-"} 已经早于当前日期至少一个还款周期。系统不会自动补生成历史还款记录；如需补齐，请在这里明确打开开关。
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <input
                      type="checkbox"
                      checked={createHistoricalRepaymentRecords}
                      onChange={(event) => setCreateHistoricalRepaymentRecords(event.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-blue-600"
                    />
                    <span>
                      <span className="block font-medium text-slate-800">生成历史自动还款记录</span>
                      <span className="block text-xs text-slate-500">按还款计划从首次还款日补生成到当前已到期月份；日期未到的周期会跳过。</span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <input
                      type="checkbox"
                      checked={showHistoricalRates}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setShowHistoricalRates(checked);
                        if (checked) {
                          setHistoricalRateRows((prev) => prev.length > 0 ? prev : [createHistoricalRateRow()]);
                          setHistoricalRatesOpen(true);
                        } else {
                          setHistoricalRateRows([]);
                          setHistoricalRatesOpen(false);
                        }
                      }}
                      className="mt-0.5 h-4 w-4 accent-blue-600"
                    />
                    <span>
                      <span className="block font-medium text-slate-800">有历史利率调整</span>
                      <span className="block text-xs text-slate-500">在弹窗中逐条填写生效日期和年利率，避免手工文本格式错误。</span>
                    </span>
                  </label>

                  {showHistoricalRates ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div>
                        <div className="text-xs font-medium text-slate-700">
                          已填写 {historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length} 条历史利率
                        </div>
                        <div className="text-[11px] text-slate-500">保存前会校验日期和利率。</div>
                      </div>
                      <button
                        type="button"
                        className="secondary-button h-8 px-3 text-xs"
                        onClick={() => {
                          setHistoricalRateRows((prev) => prev.length > 0 ? prev : [createHistoricalRateRow()]);
                          setHistoricalRatesOpen(true);
                        }}
                      >
                        编辑历史利率
                      </button>
                    </div>
                  ) : null}

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      className="secondary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => setHistoryConfirmOpen(false)}
                    >
                      返回修改
                    </button>
                    <button
                      type="button"
                      className="primary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => { void confirmHistoricalPrompt(); }}
                    >
                      {submitting ? "保存中…" : "确认保存"}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historyConfirmOpen && historicalRatesOpen
        ? createPortal(
            <div className="app-modal-backdrop z-[70]">
              <div className="app-modal-panel max-w-xl">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">历史利率调整</div>
                  <button
                    type="button"
                    onClick={() => setHistoricalRatesOpen(false)}
                    className="secondary-button h-8 px-2"
                  >
                    关闭
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                    每条利率只填写“生效日期”和“年利率（%）”。例如 2021-01-01 生效 4.015%，会从这个日期起影响后续还款计划。
                  </div>

                  <div className="space-y-2">
                    {historicalRateRows.map((row, index) => (
                      <div key={row.key} className="grid grid-cols-[1fr_120px_auto] items-end gap-2 rounded-lg border border-slate-200 bg-white p-2">
                        <div className="space-y-1">
                          <div className="form-label">生效日期</div>
                          <DateStepper
                            value={row.effectiveDate}
                            onChange={(value) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, effectiveDate: value } : item
                              )));
                            }}
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">年利率（%）</div>
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0.001"
                            step="0.001"
                            value={row.annualRate}
                            onChange={(event) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, annualRate: event.target.value } : item
                              )));
                            }}
                            placeholder="4.015"
                            className="form-input text-right"
                          />
                        </div>
                        <button
                          type="button"
                          className="secondary-button h-9 px-2 text-xs text-rose-600"
                          onClick={() => {
                            setHistoricalRateRows((prev) => {
                              const next = prev.filter((item) => item.key !== row.key);
                              return next.length > 0 ? next : [createHistoricalRateRow()];
                            });
                          }}
                          disabled={historicalRateRows.length <= 1 && !row.effectiveDate && !row.annualRate}
                        >
                          删除
                        </button>
                        <div className="col-span-3 text-[11px] text-slate-400">第 {index + 1} 条</div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      className="secondary-button h-9 px-3"
                      onClick={() => setHistoricalRateRows((prev) => [...prev, createHistoricalRateRow()])}
                    >
                      添加一条
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="secondary-button h-9 px-3 text-slate-500"
                        onClick={() => {
                          setHistoricalRateRows([]);
                          setShowHistoricalRates(false);
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        清空
                      </button>
                      <button
                        type="button"
                        className="primary-button h-9 px-3"
                        onClick={() => {
                          const result = serializeHistoricalRateRows(historicalRateRows);
                          if (!result.ok) {
                            window.alert(result.error);
                            return;
                          }
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        确认
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && debtObjectNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType="counterparty"
              open={debtObjectNestedOpen}
              onClose={() => setDebtObjectNestedOpen(false)}
              title="新增往来对象"
              nameLabel="对象名称"
              namePlaceholder="例如：张三、某公司"
              defaultType="person"
              onCreated={(id, name, extra) => {
                const type = extra?.type ?? "person";
                const option = { id: debtObjectOptionId(id, type), label: name, subLabel: institutionTypeLabel(type) };
                setLocalNestedFieldData((prev) => ({
                  ...(prev ?? nestedFieldData ?? {}),
                  counterpartyId: [...((prev ?? nestedFieldData)?.counterpartyId ?? []), { id, name, type }],
                }));
                setLocalDebtObjectOptions((prev) => mergeSmartSelectOptions(prev ?? debtObjectOptions, [option]));
                setDebtInstitutionId(option.id);
                setDebtAccountId("");
                setDebtObjectNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
