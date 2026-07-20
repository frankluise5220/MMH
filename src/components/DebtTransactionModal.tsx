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
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageAnnualRateFromLprDiscount,
  calcMortgageLprSpreadFromDiscount,
  getLatestFiveYearLpr,
  getMortgageBankExecutionRate,
  MORTGAGE_BASE_BENCHMARK_RATE,
  MORTGAGE_LPR_CONVERSION_BASE_RATE,
} from "@/lib/loan-lpr";
import { getEffectiveLoanAnnualRate, type LoanRateAdjustment } from "@/lib/loan-repayment";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";
import { DEFAULT_LOAN_PREPAY_STRATEGY, type LoanPrepayStrategy } from "@/lib/loan-prepay-strategy";

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type PrepayStrategy = LoanPrepayStrategy;
type LoanFundingMode = "cash_disbursement" | "financed_purchase";

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

const INTEREST_FREE_REPAYMENT_METHOD = "免息分期还本";
const FIXED_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INTEREST_FREE_REPAYMENT_METHOD, "先还利息一次性还本"]);

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

function parseAbsMoneyText(value: string) {
  return Math.abs(parseMoneyText(value));
}

function roundMoneyValue(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

function isDebtObjectRef(value: string) {
  return /^(?:counterparty|institution):/.test(value);
}

function canCreateDebtItemForMode(mode: DebtMode) {
  return mode === "borrow_in" || mode === "lend_out";
}

function rawDebtObjectId(value: string) {
  const match = /^(?:counterparty|institution):(.+)$/.exec(value);
  return match?.[1] ?? value;
}

function debtDirectionForMode(mode: DebtMode): "payable" | "receivable" {
  return mode === "borrow_in" || mode === "repay_out" || mode === "prepay_out" ? "payable" : "receivable";
}

function canSwitchDebtEditMode(currentMode: DebtMode, nextMode: DebtMode) {
  if (currentMode === nextMode) return true;
  return canCreateDebtItemForMode(currentMode) && canCreateDebtItemForMode(nextMode);
}

function normalizeDebtObjectValue(value: string | undefined, data?: NestedFieldData) {
  const id = String(value ?? "").trim();
  if (!id || isDebtObjectRef(id)) return id;
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
  action: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
  showTriggerButton?: boolean;
}) {
  const router = useRouter();
  const today = useMemo(() => formatDateInput(new Date()), []);
  const debtItemListId = useId();
  const [localDebtAccounts, setLocalDebtAccounts] = useState(debtAccounts);
  const [localDebtObjectOptions, setLocalDebtObjectOptions] = useState(debtObjectOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const [debtObjectNestedOpen, setDebtObjectNestedOpen] = useState(false);
  const fallbackDebtObjectOptions: SmartSelectOption[] = useMemo(() => {
    const counterpartyOptions = (localNestedFieldData?.counterpartyId ?? []).map((item) => ({
      id: `counterparty:${item.id}`,
      label: item.name,
      subLabel: item.type === "person" ? "往来人员" : "往来组织",
    }));
    const bankInstitutionOptions = (localNestedFieldData?.institutionId ?? [])
      .filter((item) => item.type === "bank")
      .map((item) => ({
        id: `institution:${item.id}`,
        label: item.name,
        subLabel: institutionTypeLabel(item.type ?? null),
      }));

    return [
      ...(counterpartyOptions.length > 0
        ? [{ id: "debt-counterparty-header", label: "往来对象", isHeader: true }, ...counterpartyOptions]
        : []),
      ...(bankInstitutionOptions.length > 0
        ? [{ id: "debt-institution-source-header", label: "从机构选择", isHeader: true }, ...bankInstitutionOptions]
        : []),
    ];
  }, [localNestedFieldData]);
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
  const [loanFundingMode, setLoanFundingMode] = useState<LoanFundingMode>("cash_disbursement");
  const [date, setDate] = useState(today);
  const [debtAccountId, setDebtAccountId] = useState(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
  const [debtInstitutionId, setDebtInstitutionId] = useState(normalizeDebtObjectValue(defaultDebtInstitutionId, nestedFieldData));
  const [debtItemName, setDebtItemName] = useState("");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [originalPrincipalForEdit, setOriginalPrincipalForEdit] = useState("");
  const [editRecalculateStartDate, setEditRecalculateStartDate] = useState("");
  const [interest, setInterest] = useState("");
  const [penalty, setPenalty] = useState("");
  const [prepayTotal, setPrepayTotal] = useState("");
  const [prepayTotalManual, setPrepayTotalManual] = useState(false);
  const [prepayStrategy, setPrepayStrategy] = useState<PrepayStrategy>(DEFAULT_LOAN_PREPAY_STRATEGY);
  const [bankExecutionRate, setBankExecutionRate] = useState("");
  const [annualRate, setAnnualRate] = useState("");
  const [annualRateManuallyEdited, setAnnualRateManuallyEdited] = useState(false);
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
    const normalizedDefaultObject = normalizeDebtObjectValue(defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData);
    const defaultDebtAccount = defaultDebtAccountId
      ? localDebtAccounts.find((account) => account.id === defaultDebtAccountId)
      : undefined;
    const defaultAccountObject = debtObjectValueForAccount(defaultDebtAccount);
    const nextDebtObjectId = normalizedDefaultObject || defaultAccountObject;
    setMode("borrow_in");
    setLoanFundingMode("cash_disbursement");
    setEditingEntryId("");
    setDate(today);
    setDebtInstitutionId(nextDebtObjectId);
    setDebtAccountId(nextDebtObjectId && defaultDebtAccountId ? defaultDebtAccountId : "");
    setDebtItemName("");
    setCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setPrincipal("");
    setOriginalPrincipalForEdit("");
    setEditRecalculateStartDate("");
    setInterest("");
    setPenalty("");
    setPrepayTotal("");
    setPrepayTotalManual(false);
    setPrepayStrategy(DEFAULT_LOAN_PREPAY_STRATEGY);
    setBankExecutionRate("");
    setAnnualRate("");
    setAnnualRateManuallyEdited(false);
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
        defaultPenalty?: number | string | null;
        defaultRecalculateStartDate?: string | null;
        defaultPrepayStrategy?: PrepayStrategy;
        defaultCurrentAnnualRate?: number | null;
        defaultMortgageLprDiscount?: number | null;
        defaultLoanRateAdjustments?: LoanRateAdjustment[];
        defaultLoanFundingMode?: LoanFundingMode;
        defaultNote?: string | null;
      }>).detail;
      resetDraft();
      if (detail?.editEntryId) setEditingEntryId(detail.editEntryId);
      if (detail?.mode) setMode(detail.mode);
      if (detail?.defaultLoanFundingMode) setLoanFundingMode(detail.defaultLoanFundingMode);
      if (detail?.defaultDate) setDate(detail.defaultDate);
      const eventDebtAccount = detail?.defaultDebtAccountId
        ? localDebtAccounts.find((account) => account.id === detail.defaultDebtAccountId)
        : undefined;
      const eventDebtObject = debtObjectValueForAccount(eventDebtAccount);
      if (detail?.mode && !canCreateDebtItemForMode(detail.mode)) {
        setDebtInstitutionId("");
      } else if (detail?.defaultDebtInstitutionId) {
        setDebtInstitutionId(normalizeDebtObjectValue(detail.defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData));
      } else if (eventDebtObject) {
        setDebtInstitutionId(eventDebtObject);
      }
      if (detail?.defaultDebtAccountId && (!canCreateDebtItemForMode(detail?.mode ?? "borrow_in") || detail.defaultDebtInstitutionId || eventDebtObject)) {
        setDebtAccountId(detail.defaultDebtAccountId);
      }
      if (detail?.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultPrincipal != null) {
        const nextPrincipal = String(detail.defaultPrincipal);
        setPrincipal(nextPrincipal);
        setOriginalPrincipalForEdit(nextPrincipal);
      }
      if (detail?.defaultRecalculateStartDate) setEditRecalculateStartDate(detail.defaultRecalculateStartDate);
      if (detail?.defaultInterest != null) setInterest(String(detail.defaultInterest));
      if (detail?.defaultPenalty != null) {
        const nextPenalty = String(detail.defaultPenalty);
        setPenalty(nextPenalty);
        if (detail?.mode === "prepay_out") {
          setPrepayTotal(roundMoneyValue(parseMoneyText(String(detail.defaultPrincipal ?? "")) + parseMoneyText(nextPenalty)).toFixed(2));
          setPrepayTotalManual(false);
        }
      }
      if (detail?.defaultPrepayStrategy) setPrepayStrategy(detail.defaultPrepayStrategy);
      if (detail?.defaultNote != null) setNote(String(detail.defaultNote));
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
  }, [defaultCashAccountId, defaultDebtAccountId, localDebtAccounts, localNestedFieldData, nestedFieldData, resetDraft]);
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  const prepayComputedTotal = useMemo(() => {
    if (mode !== "prepay_out") return "";
    if (!principal.trim() && !penalty.trim()) return "";
    return roundMoneyValue(parseAbsMoneyText(principal) + parseMoneyText(penalty)).toFixed(2);
  }, [mode, penalty, principal]);

  useEffect(() => {
    if (mode !== "prepay_out" || prepayTotalManual) return;
    setPrepayTotal(prepayComputedTotal);
  }, [mode, prepayComputedTotal, prepayTotalManual]);

  useEffect(() => {
    if (!!editingEntryId || !canCreateDebtItemForMode(mode) || !isDebtObjectRef(debtInstitutionId)) return;
    const rawId = rawDebtObjectId(debtInstitutionId);
    const existingAccount = localDebtAccounts.find((account) => {
      if (debtInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
      if (account.debtDirection !== debtDirectionForMode(mode)) return false;
      return account.institutionId === rawId;
    });
    setDebtAccountId(existingAccount?.id ?? "");
  }, [debtInstitutionId, editingEntryId, localDebtAccounts, mode]);

  function applyPrepayTotalDraft(options?: { alertOnInvalid?: boolean }) {
    if (mode !== "prepay_out" || !prepayTotal.trim()) return penalty;
    const total = roundMoneyValue(parseMoneyText(prepayTotal));
    const principalAmount = roundMoneyValue(parseAbsMoneyText(principal));
    if (total + 0.005 < principalAmount) {
      if (options?.alertOnInvalid) window.alert("支出合计不能小于提前还本金");
      setPrepayTotal(prepayComputedTotal);
      setPrepayTotalManual(false);
      return penalty;
    }
    const nextPenalty = roundMoneyValue(total - principalAmount).toFixed(2);
    setPenalty(nextPenalty);
    setPrepayTotal(total.toFixed(2));
    setPrepayTotalManual(false);
    return nextPenalty;
  }

  function handlePrincipalChange(value: string) {
    setPrincipal(value);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePenaltyChange(value: string) {
    setPenalty(value);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePrepayTotalChange(value: string) {
    setPrepayTotal(value);
    setPrepayTotalManual(true);
  }

  function findDebtAccountForObject(objectValue: string, direction: "payable" | "receivable") {
    if (!isDebtObjectRef(objectValue)) return null;
    const rawId = rawDebtObjectId(objectValue);
    return localDebtAccounts.find((account) => {
      if (objectValue.startsWith("counterparty:")) return account.counterpartyId === rawId;
      if (account.debtDirection !== direction) return false;
      return account.institutionId === rawId;
    }) ?? null;
  }

  function debtObjectValueForAccount(account: AccountOption | undefined) {
    if (!account) return "";
    if (account.counterpartyId) return `counterparty:${account.counterpartyId}`;
    if (account.institutionId) return `institution:${account.institutionId}`;
    return "";
  }

  function handleDebtAccountChange(id: string) {
    setDebtAccountId(id);
    setDebtItemName("");
    if (!id) return;
    const account = localDebtAccounts.find((item) => item.id === id);
    const objectValue = debtObjectValueForAccount(account);
    if (objectValue) setDebtInstitutionId(objectValue);
  }

  function handleDebtItemOrObjectChange(id: string) {
    if (id && !isDebtObjectRef(id)) {
      handleDebtAccountChange(id);
      return;
    }
    const existingAccount = findDebtAccountForObject(id, debtDirectionForMode(mode));
    setDebtInstitutionId(id);
    setDebtAccountId(existingAccount?.id ?? "");
    setDebtItemName("");
  }

  function handleModeSelect(nextMode: DebtMode) {
    if (editingEntryId && !canSwitchDebtEditMode(mode, nextMode)) return;
    setMode(nextMode);
    if (!canCreateDebtItemForMode(nextMode)) {
      setDebtInstitutionId("");
    }
  }

  function getPendingRepaymentLprAdjustment() {
    if (mode !== "repay_out" || editingEntryId || !repaymentLprCheck) return null;
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
    const requiresLoanScheduleFields = showBorrowPlan && FIXED_REPAYMENT_METHODS.has(repaymentMethod);
    if (requiresLoanScheduleFields) {
      if (repaymentMethod !== INTEREST_FREE_REPAYMENT_METHOD && !parsePositiveNumberText(annualRate)) {
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
      showBorrowPlan &&
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
    const shouldPromptPrincipalRecalculation =
      !!editingEntryId &&
      mode === "repay_out" &&
      !!debtAccountId &&
      !!editRecalculateStartDate &&
      Math.abs(roundMoneyValue(parseAbsMoneyText(principal)) - roundMoneyValue(parseAbsMoneyText(originalPrincipalForEdit))) > 0.005;
    const penaltyForSubmit = mode === "prepay_out" ? applyPrepayTotalDraft({ alertOnInvalid: true }) : penalty;
    if (mode === "prepay_out" && prepayTotal.trim() && parseMoneyText(prepayTotal) + 0.005 < parseAbsMoneyText(principal)) {
      return;
    }

    const formData = new FormData();
    formData.set("editEntryId", editingEntryId);
    formData.set("mode", mode);
    formData.set("loanFundingMode", loanFundingMode);
    formData.set("date", date);
    const shouldUseDebtObject = !editingEntryId && canCreateDebtItemForMode(mode) && !!debtInstitutionId && !debtAccountId;
    formData.set("debtAccountId", shouldUseDebtObject ? "" : debtAccountId);
    formData.set("debtObjectId", shouldUseDebtObject ? debtInstitutionId : "");
    formData.set("debtInstitutionId", shouldUseDebtObject ? rawDebtObjectId(debtInstitutionId) : "");
    formData.set("debtItemName", debtItemName);
    formData.set("cashAccountId", cashAccountId);
    formData.set("principal", principal);
    formData.set("interest", interest);
    formData.set("penalty", penaltyForSubmit);
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
      if (res.recalculateAfterSave) {
        const recalcResponse = await fetch("/api/v1/loan-repayment/recalculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(res.recalculateAfterSave),
        });
        const recalcData = await recalcResponse.json().catch(() => null);
        if (!recalcResponse.ok || !recalcData?.ok) {
          window.alert(recalcData?.error || "提前还款已保存，但后续计划重算失败");
        } else {
          window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
        }
      }
      if (shouldPromptPrincipalRecalculation) {
        const accepted = window.confirm([
          "本期还款本金已经修改，这会改变后续剩余本金。",
          `是否从 ${editRecalculateStartDate} 开始重算后续还款计划？`,
          "本期本金会作为银行实际值保留；只修改利息不会触发重算。",
        ].join("\n"));
        if (accepted) {
          const recalcResponse = await fetch("/api/v1/loan-repayment/recalculate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountId: debtAccountId,
              startDate: editRecalculateStartDate,
            }),
          });
          const recalcData = await recalcResponse.json().catch(() => null);
          if (!recalcResponse.ok || !recalcData?.ok) {
            window.alert(recalcData?.error || "本金已保存，但后续计划重算失败");
          } else {
            window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
          }
        }
      }
      dispatchFinanceDataChanged({ reason: "debt-save" });
      router.refresh();
      if (keepAdding) {
        setPrincipal("");
        setInterest("");
        setPenalty("");
        setPrepayTotal("");
        setPrepayTotalManual(false);
        setPrepayStrategy(DEFAULT_LOAN_PREPAY_STRATEGY);
        setBankExecutionRate("");
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

  const showInterest = mode === "repay_out" || mode === "collect_in" || mode === "lend_out";
  const showPrepayment = mode === "prepay_out";
  const canCreateDebtItem = canCreateDebtItemForMode(mode);
  const selectedDebtAccount = localDebtAccounts.find((account) => account.id === debtAccountId);
  const selectedDebtObject = debtObjectById.get(debtInstitutionId);
  const selectedDebtObjectIsCounterparty = debtInstitutionId.startsWith("counterparty:") || !!selectedDebtAccount?.counterpartyId;
  const selectedDebtObjectIsBankInstitution =
    (debtInstitutionId.startsWith("institution:") && selectedDebtObject?.type === "bank") ||
    (!!selectedDebtAccount?.institutionId && selectedDebtAccount.institutionType === "bank");
  const showLoanBorrowOptions = mode === "borrow_in" && !selectedDebtObjectIsCounterparty && selectedDebtObjectIsBankInstitution;
  const showBorrowPlan = showLoanBorrowOptions;
  useEffect(() => {
    if (!showLoanBorrowOptions && loanFundingMode !== "cash_disbursement") {
      setLoanFundingMode("cash_disbursement");
    }
  }, [loanFundingMode, showLoanBorrowOptions]);
  const repaymentTotal = useMemo(() => {
    if (!principal.trim() && !interest.trim() && !penalty.trim()) return "";
    return (parseMoneyText(principal) + (showInterest ? parseMoneyText(interest) : 0) + (showPrepayment ? parseMoneyText(penalty) : 0)).toFixed(2);
  }, [interest, penalty, principal, showInterest, showPrepayment]);
  const cashAccountLabel = mode === "borrow_in"
    ? (showLoanBorrowOptions && loanFundingMode === "financed_purchase" ? "还款账户" : "入账账户")
    : mode === "repay_out" || mode === "prepay_out"
      ? "支出账户"
      : mode === "collect_in"
        ? "收入账户"
        : "支出账户";
  const debtAccountOptions: SmartSelectOption[] = useMemo(
    () => localDebtAccounts
      .filter((account) => {
        if (account.counterpartyId) return true;
        if (mode === "borrow_in") return account.debtDirection === "payable";
        if (mode === "repay_out" || mode === "prepay_out") return account.debtDirection === "payable";
        if (mode === "collect_in") return account.debtDirection === "receivable";
        if (mode === "lend_out") return account.debtDirection === "receivable";
        return true;
      })
      .map((account) => ({ id: account.id, label: account.label, subLabel: account.subLabel })),
    [localDebtAccounts, mode],
  );
  const debtObjectAccountOptions: SmartSelectOption[] = useMemo(
    () => localDebtAccounts
      .filter((account) => {
        if (!canCreateDebtItem) return debtAccountOptions.some((option) => option.id === account.id);
        if (!isDebtObjectRef(debtInstitutionId)) return false;
        const rawId = rawDebtObjectId(debtInstitutionId);
        if (debtInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
        return account.institutionId === rawId;
      })
      .map((account) => {
        const directionLabel = account.debtDirection === "payable" ? "借入" : account.debtDirection === "receivable" ? "借出" : "未定方向";
        return {
          id: account.id,
          label: account.label,
          subLabel: [directionLabel, account.subLabel].filter(Boolean).join(" · "),
        };
      }),
    [canCreateDebtItem, debtAccountOptions, debtInstitutionId, localDebtAccounts],
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
  const editingExistingDebtItem = !!editingEntryId && canCreateDebtItem;
  const selectedExistingDebtItem = editingExistingDebtItem || !!debtAccountId;
  const disabled = cashAccounts.length === 0;
  const isFixedRepaymentMethod = FIXED_REPAYMENT_METHODS.has(repaymentMethod);
  const isInterestFreeRepaymentMethod = repaymentMethod === INTEREST_FREE_REPAYMENT_METHOD;
  const formatRateInput = (value: number) => value.toFixed(3).replace(/\.?0+$/, "");
  function computeAnnualRateFromBankExecutionRate(discount: number, baseRate = Number(bankExecutionRate.trim())) {
    if (!Number.isFinite(baseRate) || baseRate <= 0) return;
    if (!annualRateManuallyEdited) {
      setAnnualRate(formatRateInput(baseRate * discount));
    }
  }
  function fetchBankExecutionRate() {
    const quote = getMortgageBankExecutionRate(date || today);
    if (!quote) {
      window.alert("未找到可用的银行执行利率");
      return;
    }
    const baseRate = quote.rate;
    setBankExecutionRate(formatRateInput(baseRate));
    const discount = Number(mortgageLprDiscount.trim());
    if (Number.isFinite(discount) && discount > 0) {
      computeAnnualRateFromBankExecutionRate(discount, baseRate);
    }
  }
  function applyMortgageLprDiscount(options?: { silent?: boolean }) {
    const discount = Number(mortgageLprDiscount.trim());
    if (!Number.isFinite(discount) || discount <= 0) {
      if (!options?.silent) window.alert("请填写正确的利率折扣，例如 0.85");
      return;
    }
    const currentBankRate = Number(bankExecutionRate.trim());
    if (Number.isFinite(currentBankRate) && currentBankRate > 0) {
      computeAnnualRateFromBankExecutionRate(discount, currentBankRate);
    } else {
      const quote = getMortgageBankExecutionRate(date || today);
      if (!quote) return;
      const baseRate = quote.rate;
      setBankExecutionRate(formatRateInput(baseRate));
      computeAnnualRateFromBankExecutionRate(discount, baseRate);
    }
    const adjustments = buildMortgageLprRateAdjustments({ discount, throughDate: today });
    if (adjustments.length > 0) {
      setHistoricalRateRows(adjustments.map((item) => createHistoricalRateRow(
        item.effectiveDate,
        formatRateInput(item.annualRate),
      )));
      setShowHistoricalRates(true);
    }
  }

  function handleMortgageLprDiscountBlur() {
    if (!mortgageLprDiscount.trim()) return;
    applyMortgageLprDiscount({ silent: true });
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
                          onClick={() => handleModeSelect(item)}
                          disabled={!!editingEntryId && !canSwitchDebtEditMode(mode, item)}
                          className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                        >
                          {MODE_LABELS[item]}
                        </button>
                      ))}
                    </div>

                    {showLoanBorrowOptions ? (
                      <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3 border-y border-slate-100 py-2">
                        <div className="form-label">贷款形式</div>
                        <div className="grid grid-cols-2 gap-1 rounded border border-slate-200 bg-slate-50 p-0.5">
                          <button
                            type="button"
                            onClick={() => setLoanFundingMode("cash_disbursement")}
                            className={`h-7 rounded text-xs ${loanFundingMode === "cash_disbursement" ? "bg-white font-medium text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                          >
                            资金到账
                          </button>
                          <button
                            type="button"
                            onClick={() => setLoanFundingMode("financed_purchase")}
                            className={`h-7 rounded text-xs ${loanFundingMode === "financed_purchase" ? "bg-white font-medium text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                          >
                            消费分期
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? (showLoanBorrowOptions && loanFundingMode === "financed_purchase" ? "发生日期" : "入账日期") : "日期"}</div>
                        <DateStepper name="date" value={date} onChange={setDate} />
                      </div>
                      <div className="space-y-1">
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

                    <div className="grid grid-cols-2 gap-3">
                      {canCreateDebtItem ? (
                        <div className="space-y-1">
                          <div className="form-label">往来对象</div>
                          <SmartSelect
                            mode="single"
                            value={debtInstitutionId}
                            onChange={handleDebtItemOrObjectChange}
                            options={visibleDebtObjectOptions}
                            placeholder="请选择往来对象"
                            onCreateClick={() => { void openDebtObjectCreate(); }}
                            createLabel="新增往来对象"
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: false,
                              minDropdownWidth: 320,
                            }}
                          />
                        </div>
                      ) : null}
                      {canCreateDebtItem ? (
                        <div className="space-y-1">
                          <div className="form-label">往来账户</div>
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={handleDebtAccountChange}
                            options={debtObjectAccountOptions}
                            placeholder={debtInstitutionId ? "保存时自动复用或新建" : "请先选择往来对象"}
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: true,
                              minDropdownWidth: 360,
                            }}
                          />
                        </div>
                      ) : showPrepayment ? (
                        <div className="col-span-2 space-y-1">
                          <div className="form-label">借款项</div>
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={setDebtAccountId}
                            options={debtAccountOptions}
                            placeholder="请选择已有借款项"
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: false,
                              minDropdownWidth: 360,
                            }}
                          />
                        </div>
                      ) : (
                        <div className="col-span-2 space-y-1">
                          <div className="form-label">{mode === "repay_out" ? "借款项" : "借出项"}</div>
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={setDebtAccountId}
                            options={debtAccountOptions}
                            placeholder={mode === "repay_out" ? "请选择已有借款项" : "请选择已有借出项"}
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: false,
                              minDropdownWidth: 360,
                            }}
                          />
                        </div>
                      )}
                    </div>

                    {canCreateDebtItem && !debtAccountId ? (
                      <div className="space-y-1">
                        <div className="form-label">新账户名称 <span className="text-slate-400">可选</span></div>
                          <input
                            value={debtItemName}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDebtItemName(value);
                              if (mode === "borrow_in" && /(车贷|汽车贷款|购车)/.test(value)) {
                                setLoanFundingMode("financed_purchase");
                              }
                            }}
                            list={debtItemListId}
                            disabled={selectedExistingDebtItem}
                            placeholder={`不填则生成“${selectedDebtObjectName}的往来款”`}
                            className="form-input"
                          />
                          <datalist id={debtItemListId}>
                            {debtItemSuggestions.map((name) => <option key={name} value={name} />)}
                          </datalist>
                      </div>
                    ) : null}

                    {!showPrepayment ? (
                    <div className={`grid gap-3 ${showInterest ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? (showLoanBorrowOptions && loanFundingMode === "financed_purchase" ? "分期本金" : "借款总额") : mode === "repay_out" || mode === "collect_in" || mode === "lend_out" ? "本金" : "金额"}</div>
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
                            <div className="form-label">{mode === "lend_out" ? "应收本息" : "本息合计"}</div>
                          <input
                            value={repaymentTotal}
                            readOnly
                            placeholder="自动计算"
                            className="form-input bg-slate-50 text-right font-mono text-slate-700"
                          />
                        </div>
                      ) : null}
                    </div>
                    ) : null}

                    {showPrepayment ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <div className="form-label">提前还本金</div>
                            <CalcInput value={principal} onChange={handlePrincipalChange} placeholder="例如：1000" label="提前还本金" precision={2} />
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">手续费/违约金</div>
                            <CalcInput value={penalty} onChange={handlePenaltyChange} placeholder="可选" label="手续费" precision={2} />
                          </div>
                          <div className="space-y-1">
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
                          <div className="space-y-1">
                            <div className="form-label">支出合计</div>
                            <CalcInput
                              value={prepayTotal}
                              onChange={handlePrepayTotalChange}
                              onBlur={() => applyPrepayTotalDraft()}
                              placeholder="自动计算，可手填"
                              label="支出合计"
                              precision={2}
                            />
                          </div>
                        </div>
                      </>
                    ) : null}

                    {showBorrowPlan ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <div className="form-label">还款方式</div>
                            <select value={repaymentMethod} onChange={(event) => {
                              const method = event.target.value;
                              setRepaymentMethod(method);
                              if (method === INTEREST_FREE_REPAYMENT_METHOD) {
                                setAnnualRate("0");
                                setAnnualRateManuallyEdited(false);
                                setMortgageLprDiscount("");
                                setBankExecutionRate("");
                                setShowHistoricalRates(false);
                                setHistoricalRateRows([]);
                              }
                            }} className="form-input">
                              <option value="等额本息">等额本息</option>
                              <option value="等额本金">等额本金</option>
                              <option value={INTEREST_FREE_REPAYMENT_METHOD}>{INTEREST_FREE_REPAYMENT_METHOD}</option>
                              <option value="自由还款">自由还款</option>
                              <option value="先还利息一次性还本">先还利息一次性还本</option>
                            </select>
                          </div>
                        </div>

                        {isFixedRepaymentMethod ? (
                          <>
                            {!isInterestFreeRepaymentMethod ? <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                              <div className="space-y-1">
                                <div className="form-label">
                                  银行执行利率（未折扣 %）
                                </div>
                                <input
                                  value={bankExecutionRate}
                                  onChange={(event) => setBankExecutionRate(event.target.value)}
                                  placeholder="例如：3.5"
                                  inputMode="decimal"
                                  className="form-input"
                                />
                              </div>
                              <div className="flex items-end">
                                <button
                                  type="button"
                                  className="secondary-button h-9 shrink-0 px-3 text-xs"
                                  onClick={fetchBankExecutionRate}
                                >
                                  获取
                                </button>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <div className="form-label">房贷 LPR 折扣 <span className="text-slate-400">可选</span></div>
                                <input
                                  value={mortgageLprDiscount}
                                  onChange={(event) => setMortgageLprDiscount(event.target.value)}
                                  onBlur={handleMortgageLprDiscountBlur}
                                  placeholder="例如：0.85"
                                  inputMode="decimal"
                                  className="form-input"
                                />
                              </div>
                              <div className="space-y-1">
                                <div className="form-label">
                                  年利率（%） <span className="text-red-500">*</span>
                                </div>
                                <input
                                  value={annualRate}
                                  onChange={(event) => {
                                    setAnnualRateManuallyEdited(true);
                                    setAnnualRate(event.target.value);
                                  }}
                                  placeholder="例如：2.975"
                                  inputMode="decimal"
                                  className="form-input"
                                />
                              </div>
                            </div>
                            </> : (
                              <div className="border-y border-slate-100 py-2 text-xs text-slate-500">
                                每期只归还本金，计划利息固定为 0。
                              </div>
                            )}
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
                            自由还款不生成固定还款计划，也不记录约定利率；后续还款或收回时再填写实际利息。
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
                            ? "还款金额包含本金和利息；借记卡端显示一笔贷款还款，贷款端按本金和利息拆分。"
                            : mode === "prepay_out"
                              ? "提前还款只冲减本金，不计入计划任务已执行次数；保存后会按上方选择调整后续还款计划。"
                            : mode === "lend_out"
                              ? "借出会从资金账户转出，同时形成借出余额。"
                              : "收回金额包含本金和利息；资金账户端显示一笔收回，往来端按本金和利息拆分。"}
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

                  {!isInterestFreeRepaymentMethod ? <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
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
                      <span className="block text-xs text-slate-500">打开利率调整界面，可按 LPR 折扣生成，也可维护实际年利率。</span>
                    </span>
                  </label> : null}

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
                        利率调整
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
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                    利率调整会影响生效日之后的还款计划。新增借款时先在这里维护草稿，保存借入后写入贷款利率调整表。
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2">
                      <div className="text-xs font-semibold text-slate-700">按 LPR 折扣生成</div>
                      <div className="mt-0.5 text-[11px] leading-5 text-slate-500">
                        折扣先换算固定加点：{MORTGAGE_BASE_BENCHMARK_RATE.toFixed(2)}% × 折扣 - {MORTGAGE_LPR_CONVERSION_BASE_RATE.toFixed(2)}%。生成后仍可手工调整。
                      </div>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_92px] gap-2">
                      <div className="space-y-1">
                        <div className="form-label">利率折扣</div>
                        <input
                          value={mortgageLprDiscount}
                          onChange={(event) => setMortgageLprDiscount(event.target.value)}
                          inputMode="decimal"
                          placeholder="例如：0.85"
                          className="form-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">固定加点</div>
                        <input
                          value={(() => {
                            const discount = Number(mortgageLprDiscount.trim());
                            return Number.isFinite(discount) && discount > 0
                              ? `${calcMortgageLprSpreadFromDiscount(discount).toFixed(3).replace(/\.?0+$/, "")}%`
                              : "";
                          })()}
                          readOnly
                          placeholder="自动计算"
                          className="form-input bg-white/70 text-slate-500"
                        />
                      </div>
                      <div className="flex items-end">
                        <button
                          type="button"
                          className="inline-flex h-9 w-full items-center justify-center rounded-full border border-blue-600 bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700"
                          onClick={() => applyMortgageLprDiscount()}
                        >
                          生成
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 px-1 text-xs font-medium text-slate-500">
                      <div>生效日期</div>
                      <div>年利率（%）</div>
                      <div className="text-right">操作</div>
                    </div>
                    <div className="max-h-[230px] space-y-2 overflow-y-auto pr-1">
                      {historicalRateRows.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                          暂无利率调整记录
                        </div>
                      ) : historicalRateRows.map((row) => (
                        <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2">
                          <DateStepper
                            value={row.effectiveDate}
                            onChange={(value) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, effectiveDate: value } : item
                              )));
                            }}
                          />
                          <input
                            value={row.annualRate}
                            onChange={(event) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, annualRate: event.target.value } : item
                              )));
                            }}
                            inputMode="decimal"
                            placeholder="例如：4.015"
                            className="form-input"
                          />
                          <button
                            type="button"
                            className="secondary-button h-9 px-2 text-rose-600 hover:bg-rose-50"
                            onClick={() => {
                              setHistoricalRateRows((prev) => prev.filter((item) => item.key !== row.key));
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
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
                          if (historicalRateRows.length === 0) {
                            setShowHistoricalRates(false);
                            setHistoricalRatesOpen(false);
                            return;
                          }
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
