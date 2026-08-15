"use client";

import { ChevronDown, Plus, Repeat } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm } from "./EntityCreateForm";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { institutionTypeLabel } from "@/lib/account-kinds";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { formatDateLocal as formatDateInput, parseDateInputToUtc as dateInputToUtcDate } from "@/lib/date-utils";
import {
  fetchSettingsAccountData,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageAnnualRateFromLprDiscount,
  calcMortgageLprSpreadFromDiscount,
  getLatestFiveYearLpr,
  getMortgageBankExecutionRate,
  MORTGAGE_BASE_BENCHMARK_RATE,
  MORTGAGE_LPR_CONVERSION_BASE_RATE,
} from "@/lib/loan-lpr";
import {
  buildLoanRepaymentSchedulePreview,
  getEffectiveLoanAnnualRate,
  normalizeLoanRateAdjustments,
  type LoanRateAdjustment,
} from "@/lib/loan-repayment";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";
import { DEFAULT_LOAN_PREPAY_STRATEGY, type LoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { useI18n } from "@/lib/i18n";

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type SimpleTransferDirection = "transfer_in" | "transfer_out";
type PrepayStrategy = LoanPrepayStrategy;
type LoanFundingMode = "cash_disbursement" | "financed_purchase";

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  kind?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  institutionType?: string | null;
  isInstitutionLoan?: boolean;
  debtDirection?: "payable" | "receivable" | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SettingsAccountRecord = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  isPlaceholder?: boolean | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  debtDirection?: "payable" | "receivable" | null;
  Institution?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  Counterparty?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
};
type HistoricalRateRow = { key: string; effectiveDate: string; annualRate: string };
type RepaymentLprCheck = {
  mortgageLprDiscount: number | null;
  currentAnnualRate: number | null;
  loanRateAdjustments: LoanRateAdjustment[];
};

const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

const MODE_LABELS: Record<DebtMode, string> = {
  borrow_in: "debtTx.mode.borrowIn",
  repay_out: "debtShell.repayment",
  prepay_out: "debtShell.prepayment",
  lend_out: "debtTx.mode.lendOut",
  collect_in: "debtTx.mode.collectIn",
};

const PREPAY_STRATEGY_LABELS: Record<PrepayStrategy, string> = {
  reduce_term: "debtTx.prepayStrategy.reduceTerm",
  reduce_payment: "debtTx.prepayStrategy.reducePayment",
  settle: "debtTx.prepayStrategy.settle",
};

const INTEREST_FREE_REPAYMENT_METHOD = "免息分期还本";
const FIXED_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INTEREST_FREE_REPAYMENT_METHOD, "先还利息一次性还本"]);

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

function formatMoneyPreview(value: number, language: string) {
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function simpleTransferDirectionForMode(mode: DebtMode): SimpleTransferDirection {
  return mode === "borrow_in" || mode === "collect_in" ? "transfer_in" : "transfer_out";
}

function debtModeForSimpleTransferDirection(
  direction: SimpleTransferDirection,
  debtDirection?: "payable" | "receivable" | null,
): DebtMode {
  if (direction === "transfer_in") return debtDirection === "receivable" ? "collect_in" : "borrow_in";
  return debtDirection === "payable" ? "repay_out" : "lend_out";
}

function settingsAccountToDebtOption(account: SettingsAccountRecord, t: (key: string, params?: Record<string, string | number>) => string): AccountOption {
  const display = buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0]);
  const counterpartyName = account.Counterparty?.shortName?.trim() || account.Counterparty?.name?.trim() || "";
  const institutionType = account.Institution?.type ?? null;
  return {
    id: account.id,
    label: display.selectorLabel || display.label,
    subLabel: counterpartyName ? t("debtTx.subLabel.settlement", { name: counterpartyName }) : display.subLabel,
    kind: account.kind ?? null,
    institutionId: account.institutionId ?? null,
    counterpartyId: account.counterpartyId ?? null,
    institutionType,
    isInstitutionLoan: Boolean(account.institutionId && !account.counterpartyId),
    debtDirection: account.debtDirection ?? null,
  };
}

function normalizeDebtObjectValue(value: string | undefined, data?: NestedFieldData) {
  const id = String(value ?? "").trim();
  if (!id || isDebtObjectRef(id)) return id;
  if ((data?.counterpartyId ?? []).some((entry) => entry.id === id)) return `counterparty:${id}`;
  const item = (data?.institutionId ?? []).find((entry) => entry.id === id);
  return item ? debtObjectOptionId(item.id, item.type) : id;
}

function serializeHistoricalRateRows(rows: HistoricalRateRow[], t: (key: string, params?: Record<string, string | number>) => string) {
  const filledRows = rows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim());
  if (filledRows.length === 0) {
    return { ok: false as const, error: t("debtTx.historicalRate.minOne") };
  }

  const seenDates = new Set<string>();
  const normalized = filledRows.map((row) => {
    const effectiveDate = row.effectiveDate.trim();
    const annualRate = Number(row.annualRate.trim());
    if (!isValidDateInput(effectiveDate)) {
      return { ok: false as const, error: t("debtTx.historicalRate.invalidDate") };
    }
    if (seenDates.has(effectiveDate)) {
      return { ok: false as const, error: t("debtTx.historicalRate.duplicateDate", { date: effectiveDate }) };
    }
    seenDates.add(effectiveDate);
    if (!Number.isFinite(annualRate) || annualRate <= 0) {
      return { ok: false as const, error: t("debtTx.historicalRate.mustBePositive") };
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
  triggerLabel,
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
  triggerLabel?: string;
}) {
  const today = useMemo(() => formatDateInput(new Date()), []);
  const { t, language } = useI18n();
  const debtItemListId = useId();
  const [localDebtAccounts, setLocalDebtAccounts] = useState(debtAccounts);
  const [localDebtObjectOptions, setLocalDebtObjectOptions] = useState(debtObjectOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const [debtObjectNestedOpen, setDebtObjectNestedOpen] = useState(false);
  const fallbackDebtObjectOptions: SmartSelectOption[] = useMemo(() => {
    const counterpartyOptions = (localNestedFieldData?.counterpartyId ?? []).map((item) => ({
      id: `counterparty:${item.id}`,
      label: item.name,
      subLabel: item.type === "person" ? t("debtTx.objectType.person") : t("debtTx.objectType.organization"),
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
        ? [{ id: "debt-counterparty-header", label: t("txForm.counterparty"), isHeader: true }, ...counterpartyOptions]
        : []),
      ...(bankInstitutionOptions.length > 0
        ? [{ id: "debt-institution-source-header", label: t("debtTx.objectSourceHeader"), isHeader: true }, ...bankInstitutionOptions]
        : []),
    ];
  }, [localNestedFieldData, t]);
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
    () => cashAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel, kind: item.kind })),
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
      title={t("debtTx.ownerFilterTitle", { label: cashOwnerFilterLabel })}
      aria-label={t("debtTx.ownerFilterAria", { label: cashOwnerFilterLabel })}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState("");
  const [debtAccountNestedOpen, setDebtAccountNestedOpen] = useState(false);
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
  // Loan repayment execution mode: auto-debit (mortgage-style) or bill-only
  // (consumer loan without auto-debit, paid manually).
  const [autoDebit, setAutoDebit] = useState(true);
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

  function openDebtAccountCreate() {
    if (!selectedDebtObjectIsCounterparty) return;
    setDebtAccountNestedOpen(true);
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
    let cancelled = false;
    async function refreshDebtSettingsData() {
      const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
      if (cancelled || !data) return;
      const debtRows = (data.accounts as SettingsAccountRecord[])
        .filter((account) => account.kind === "loan" && account.isPlaceholder !== true && account.isActive !== false);
      setLocalDebtAccounts(debtRows.map((account) => settingsAccountToDebtOption(account, t)));
      const nextNested: NestedFieldData = {
        groupId: (data.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
        institutionId: (data.institutions ?? []).map((institution) => ({
          id: institution.id,
          name: institution.shortName?.trim() || institution.name,
          type: institution.type ?? "",
        })),
        counterpartyId: (data.counterparties ?? []).map((counterparty) => ({
          id: counterparty.id,
          name: counterparty.shortName?.trim() || counterparty.name,
          type: counterparty.type ?? "organization",
        })),
      };
      setLocalNestedFieldData(nextNested);
      const counterpartyOptions = nextNested.counterpartyId.map((item) => ({
        id: debtObjectOptionId(item.id, item.type),
        label: item.name,
        subLabel: item.type === "person" ? t("debtTx.objectType.person") : t("debtTx.objectType.organization"),
      }));
      const institutionOptions = nextNested.institutionId
        .filter((item) => item.type === "bank")
        .map((item) => ({
          id: debtObjectOptionId(item.id, item.type),
          label: item.name,
          subLabel: institutionTypeLabel(item.type ?? null),
        }));
      setLocalDebtObjectOptions(mergeSmartSelectOptions(debtObjectOptions, [...counterpartyOptions, ...institutionOptions]));
    }

    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<SettingsDataChangedDetail>).detail;
      const scope = detail?.scope ?? "all";
      if (scope === "accounts" || scope === "all") void refreshDebtSettingsData();
    }

    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [debtObjectOptions, t]);

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
      if (detail?.defaultDebtInstitutionId) {
        setDebtInstitutionId(normalizeDebtObjectValue(detail.defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData));
      } else if (eventDebtObject) {
        setDebtInstitutionId(eventDebtObject);
      }
      if (detail?.defaultDebtAccountId) setDebtAccountId(detail.defaultDebtAccountId);
      if (detail?.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultPrincipal != null) {
        const nextPrincipal = String(parseAbsMoneyText(String(detail.defaultPrincipal)));
        setPrincipal(nextPrincipal);
        setOriginalPrincipalForEdit(nextPrincipal);
      }
      if (detail?.defaultRecalculateStartDate) setEditRecalculateStartDate(detail.defaultRecalculateStartDate);
      if (detail?.defaultInterest != null) setInterest(String(parseAbsMoneyText(String(detail.defaultInterest))));
      if (detail?.defaultPenalty != null) {
        const nextPenalty = String(parseAbsMoneyText(String(detail.defaultPenalty)));
        setPenalty(nextPenalty);
        if (detail?.mode === "prepay_out") {
          setPrepayTotal(roundMoneyValue(parseAbsMoneyText(String(detail.defaultPrincipal ?? "")) + parseMoneyText(nextPenalty)).toFixed(2));
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
      if (options?.alertOnInvalid) window.alert(t("debtTx.alert.expenseTotalTooSmall"));
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
    const matchedAccounts = localDebtAccounts.filter((account) => {
      if (objectValue.startsWith("counterparty:")) return account.counterpartyId === rawId;
      return account.institutionId === rawId;
    });
    return matchedAccounts.find((account) => account.debtDirection === direction) ?? matchedAccounts[0] ?? null;
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
    const shouldAutoPickAccount = id.startsWith("counterparty:");
    const existingAccount = shouldAutoPickAccount ? findDebtAccountForObject(id, debtDirectionForMode(mode)) : null;
    if (shouldAutoPickAccount && existingAccount) {
      setMode(debtModeForSimpleTransferDirection(simpleTransferDirectionForMode(mode), existingAccount.debtDirection));
    }
    setDebtInstitutionId(id);
    setDebtAccountId(existingAccount?.id ?? "");
    setDebtItemName("");
  }

  function handleModeSelect(nextMode: DebtMode) {
    if (editingEntryId && !canSwitchDebtEditMode(mode, nextMode)) return;
    setMode(nextMode);
    if (principal.trim()) setPrincipal(String(parseAbsMoneyText(principal)));
    if (!canCreateDebtItemForMode(nextMode)) {
      setDebtInstitutionId("");
    }
  }

  function handleSimpleTransferDirectionSelect(direction: SimpleTransferDirection) {
    const account = localDebtAccounts.find((item) => item.id === debtAccountId);
    const nextMode = debtModeForSimpleTransferDirection(direction, account?.debtDirection);
    setMode(nextMode);
    if (principal.trim()) setPrincipal(String(parseAbsMoneyText(principal)));
    if (account) {
      const objectValue = debtObjectValueForAccount(account);
      if (objectValue) setDebtInstitutionId(objectValue);
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
        window.alert(t("debtTx.alert.annualRateRequired"));
        return;
      }
      if (!parsePositiveNumberText(loanTotalRuns)) {
        window.alert(t("debtTx.alert.totalRunsRequired"));
        return;
      }
      if (!firstRepaymentDate) {
        window.alert(t("debtTx.alert.firstRepaymentDateRequired"));
        return;
      }
    }
    if (
      !options?.skipHistoryPrompt &&
      showBorrowPlan &&
      loanFundingMode !== "financed_purchase" &&
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
      ? serializeHistoricalRateRows(historicalRateRows, t)
      : { ok: true as const, text: "" };
    if (!historicalRates.ok) {
      window.alert(historicalRates.error);
      setHistoricalRatesOpen(true);
      return;
    }
    const pendingLprAdjustment = getPendingRepaymentLprAdjustment();
    let acceptedLprAdjustment: typeof pendingLprAdjustment = null;
    if (pendingLprAdjustment) {
      const accepted = await showConfirmDialog({
        title: t("debtTx.lprAdjust.title"),
        message: [
          t("debtTx.lprAdjust.foundLpr", {
            date: pendingLprAdjustment.effectiveDate,
            rate: pendingLprAdjustment.lprRate.toFixed(3).replace(/\.?0+$/, ""),
          }),
          t("debtTx.lprAdjust.newRate", {
            rate: pendingLprAdjustment.annualRate.toFixed(3).replace(/\.?0+$/, ""),
          }),
          pendingLprAdjustment.currentAnnualRate == null
            ? t("debtTx.lprAdjust.noComparableRate")
            : t("debtTx.lprAdjust.currentRate", {
                rate: pendingLprAdjustment.currentAnnualRate.toFixed(3).replace(/\.?0+$/, ""),
              }),
          t("debtTx.lprAdjust.acceptPrompt"),
        ].join("\n"),
      });
      acceptedLprAdjustment = accepted ? pendingLprAdjustment : null;
    }
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

    const submittedLoanFundingMode =
      editingEntryId && loanFundingMode === "financed_purchase" ? "financed_purchase" : "cash_disbursement";
    const formData = new FormData();
    formData.set("editEntryId", editingEntryId);
    formData.set("mode", mode);
    formData.set("loanFundingMode", submittedLoanFundingMode);
    formData.set("date", date);
    const shouldUseDebtObject = !editingEntryId && canSelectDebtObject && !!debtInstitutionId && !debtAccountId;
    formData.set("debtAccountId", shouldUseDebtObject ? "" : debtAccountId);
    formData.set("debtObjectId", shouldUseDebtObject ? debtInstitutionId : "");
    formData.set("debtInstitutionId", shouldUseDebtObject ? rawDebtObjectId(debtInstitutionId) : "");
    formData.set("debtItemName", debtItemName);
    formData.set("cashAccountId", cashAccountId);
    formData.set("principal", String(parseAbsMoneyText(principal)));
    formData.set("interest", showSimpleTransferMode ? "0" : interest);
    formData.set("penalty", showSimpleTransferMode ? "0" : penaltyForSubmit);
    formData.set("prepayStrategy", prepayStrategy);
    formData.set("annualRate", annualRate);
    formData.set("mortgageLprDiscount", mortgageLprDiscount);
    formData.set("repaymentMethod", repaymentMethod);
    formData.set("repaymentIntervalMonths", repaymentIntervalMonths);
    formData.set("loanTotalRuns", loanTotalRuns);
    formData.set("firstRepaymentDate", firstRepaymentDate);
    formData.set("createRepaymentPlan", showBorrowPlan && isFixedRepaymentMethod ? "true" : "false");
    formData.set("autoDebit", autoDebit ? "true" : "false");
    formData.set(
      "createHistoricalRepaymentRecords",
      submittedLoanFundingMode === "financed_purchase" ? "false" : createHistoricalRepaymentRecords ? "true" : "false",
    );
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
          window.alert(recalcData?.error || t("debtTx.alert.recalcFailedPrepay"));
        } else {
          window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
        }
      }
      if (shouldPromptPrincipalRecalculation) {
        const accepted = await showConfirmDialog({
          title: t("debtTx.principalEdit.title"),
          message: [
            t("debtTx.principalEdit.message1"),
            t("debtTx.principalEdit.message2", { date: editRecalculateStartDate }),
            t("debtTx.principalEdit.message3"),
          ].join("\n"),
        });
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
            window.alert(recalcData?.error || t("debtTx.alert.recalcFailedPrincipal"));
          } else {
            window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
          }
        }
      }
      dispatchFinanceDataChanged({ reason: "debt-save" });
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
      window.alert(error instanceof Error ? error.message : t("debtTx.alert.saveFailed"));
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

  const selectedDebtAccount = localDebtAccounts.find((account) => account.id === debtAccountId);
  const selectedDebtObjectIsCounterparty = debtInstitutionId.startsWith("counterparty:") || !!selectedDebtAccount?.counterpartyId;
  const selectedDebtAccountIsBankLoan = !!selectedDebtAccount?.institutionId && selectedDebtAccount.institutionType === "bank";
  const showSimpleTransferMode = selectedDebtObjectIsCounterparty && mode !== "prepay_out";
  const simpleTransferDirection = simpleTransferDirectionForMode(mode);
  const showInterest = !showSimpleTransferMode && (mode === "repay_out" || mode === "collect_in" || mode === "lend_out");
  const showPrepayment = mode === "prepay_out";
  const canCreateDebtItem = canCreateDebtItemForMode(mode);
  const canSelectDebtObject = !!editingEntryId || canCreateDebtItem || showSimpleTransferMode;
  const showLoanBorrowOptions = mode === "borrow_in" && !selectedDebtObjectIsCounterparty && selectedDebtAccountIsBankLoan;
  const showBorrowPlan = showLoanBorrowOptions;
  useEffect(() => {
    if (selectedDebtObjectIsCounterparty && mode === "prepay_out") {
      setMode("repay_out");
    }
  }, [mode, selectedDebtObjectIsCounterparty]);
  useEffect(() => {
    if (!showLoanBorrowOptions && loanFundingMode !== "cash_disbursement") {
      setLoanFundingMode("cash_disbursement");
    }
  }, [loanFundingMode, showLoanBorrowOptions]);
  const repaymentTotal = useMemo(() => {
    if (!principal.trim() && !interest.trim() && !penalty.trim()) return "";
    return (parseMoneyText(principal) + (showInterest ? parseMoneyText(interest) : 0) + (showPrepayment ? parseMoneyText(penalty) : 0)).toFixed(2);
  }, [interest, penalty, principal, showInterest, showPrepayment]);
  const cashAccountLabel = showSimpleTransferMode
    ? simpleTransferDirection === "transfer_in" ? t("txForm.transferTo") : t("txForm.transferFrom")
    : mode === "borrow_in"
      ? (showLoanBorrowOptions && loanFundingMode === "financed_purchase" ? t("debtTx.accountLabel.repaymentAccount") : t("debtTx.accountLabel.postingAccount"))
      : mode === "repay_out" || mode === "prepay_out"
        ? t("debtTx.accountLabel.expenseAccount")
        : mode === "collect_in"
          ? t("debtTx.accountLabel.incomeAccount")
          : t("debtTx.accountLabel.expenseAccount");
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
        if (!canSelectDebtObject) return debtAccountOptions.some((option) => option.id === account.id);
        if (!isDebtObjectRef(debtInstitutionId)) return false;
        const rawId = rawDebtObjectId(debtInstitutionId);
        if (debtInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
        return account.institutionId === rawId;
      })
      .map((account) => {
        const directionLabel = account.debtDirection === "payable" ? t(MODE_LABELS.borrow_in) : account.debtDirection === "receivable" ? t(MODE_LABELS.lend_out) : t("debtTx.direction.unspecified");
        return {
          id: account.id,
          label: account.label,
          subLabel: [directionLabel, account.subLabel].filter(Boolean).join(" · "),
        };
      }),
    [canSelectDebtObject, debtAccountOptions, debtInstitutionId, localDebtAccounts, t],
  );
  const debtItemSuggestions = useMemo(
    () => Array.from(new Set(localDebtAccounts
      .filter((account) => {
        if (!debtInstitutionId) return true;
        const rawId = rawDebtObjectId(debtInstitutionId);
        if (debtInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
        return account.institutionId === rawId;
      })
      .map((account) => account.label.trim())
      .filter(Boolean))),
    [debtInstitutionId, localDebtAccounts],
  );
  const selectedDebtObjectName = debtObjectById.get(debtInstitutionId)?.name?.trim() || t("txForm.counterparty");
  const editingExistingDebtItem = !!editingEntryId && canSelectDebtObject;
  const selectedExistingDebtItem = editingExistingDebtItem || !!debtAccountId;
  const disabled = cashAccounts.length === 0;
  const isFixedRepaymentMethod = FIXED_REPAYMENT_METHODS.has(repaymentMethod);
  const isInterestFreeRepaymentMethod = repaymentMethod === INTEREST_FREE_REPAYMENT_METHOD;
  const loanSchedulePreview = useMemo(() => {
    if (!showBorrowPlan || !isFixedRepaymentMethod) return null;
    const firstRunDate = dateInputToUtcDate(firstRepaymentDate);
    const principalAmount = parseAbsMoneyText(principal);
    const totalRuns = Number.parseInt(loanTotalRuns || "0", 10);
    const intervalMonths = Number.parseInt(repaymentIntervalMonths || "1", 10);
    const baseAnnualRate = isInterestFreeRepaymentMethod ? 0 : Number(annualRate);
    if (
      !firstRunDate ||
      principalAmount <= 0 ||
      !Number.isFinite(totalRuns) ||
      totalRuns <= 0 ||
      (!isInterestFreeRepaymentMethod && (!Number.isFinite(baseAnnualRate) || baseAnnualRate <= 0))
    ) {
      return null;
    }
    const adjustments = showHistoricalRates
      ? normalizeLoanRateAdjustments(historicalRateRows.map((row) => ({
          effectiveDate: row.effectiveDate,
          annualRate: Number(row.annualRate),
        })))
      : [];
    const rows = buildLoanRepaymentSchedulePreview({
      principal: principalAmount,
      repaymentMethod,
      baseAnnualRate,
      adjustments,
      intervalMonths,
      totalRuns,
      firstRunDate,
      maxRows: totalRuns,
    });
    if (rows.length === 0) return null;
    return {
      rows,
      repaymentDay: firstRunDate.getUTCDate(),
      intervalMonths,
      totalPrincipal: roundMoneyValue(rows.reduce((sum, row) => sum + row.principal, 0)),
      totalInterest: roundMoneyValue(rows.reduce((sum, row) => sum + row.interest, 0)),
      totalPayment: roundMoneyValue(rows.reduce((sum, row) => sum + row.payment, 0)),
      hasRateAdjustments: adjustments.length > 0,
    };
  }, [
    annualRate,
    firstRepaymentDate,
    historicalRateRows,
    isFixedRepaymentMethod,
    isInterestFreeRepaymentMethod,
    loanTotalRuns,
    principal,
    repaymentIntervalMonths,
    repaymentMethod,
    showBorrowPlan,
    showHistoricalRates,
  ]);
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
      window.alert(t("debtTx.alert.bankRateNotFound"));
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
      if (!options?.silent) window.alert(t("debtTx.alert.lprDiscountInvalid"));
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
          {editingEntryId ? t("debtTx.editRepayment") : triggerLabel ?? t("debtTx.borrowRepay")}
          <ChevronDown className="w-4 h-4 opacity-90" />
        </button>
      ) : null}

      {open
        ? createPortal(
            <div className="app-modal-backdrop z-50">
              <div className="app-modal-panel max-w-xl">
                  <div className="modal-header shrink-0">
                    <div className="text-sm font-semibold text-slate-800">{editingEntryId ? t("debtTx.editRepayment") : t("debtTx.title")}</div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          resetDraft();
                        }}
                        className="secondary-button h-8 px-2"
                      >
                        {t("table.close")}
                      </button>
                    </div>
                  </div>

                  <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
                    {showSimpleTransferMode ? (
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          ["transfer_in", "debtTx.transferIn"],
                          ["transfer_out", "debtTx.transferOut"],
                        ] as const).map(([direction, labelKey]) => (
                          <button
                            key={direction}
                            type="button"
                            onClick={() => handleSimpleTransferDirectionSelect(direction)}
                            className={`segment-button h-9 ${simpleTransferDirection === direction ? "segment-button-active" : ""}`}
                          >
                            {t(labelKey)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-5 gap-2">
                        {(Object.keys(MODE_LABELS) as DebtMode[]).map((item) => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => handleModeSelect(item)}
                            disabled={!!editingEntryId && !canSwitchDebtEditMode(mode, item)}
                            className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                          >
                            {t(MODE_LABELS[item])}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? (showLoanBorrowOptions && loanFundingMode === "financed_purchase" ? t("debtTx.date.occurred") : t("detail.column.postedAt")) : t("detail.column.date")}</div>
                        <DateStepper name="date" value={date} onChange={setDate} />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{cashAccountLabel}</div>
                        <SmartSelect
                          mode="single"
                          value={cashAccountId}
                          onChange={setCashAccountId}
                          options={visibleCashOptions}
                          placeholder={t("txForm.selectPlaceholder")}
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
                      {canSelectDebtObject ? (
                        <div className="space-y-1">
                          <div className="form-label">{t("txForm.counterparty")}</div>
                          <SmartSelect
                            mode="single"
                            value={debtInstitutionId}
                            onChange={handleDebtItemOrObjectChange}
                            options={visibleDebtObjectOptions}
                            placeholder={t("debtTx.placeholder.selectCounterparty")}
                            onCreateClick={() => { void openDebtObjectCreate(); }}
                            createLabel={t("txForm.addCounterparty")}
                            behavior={{
                              hierarchy: false,
                              search: true,
                              clearable: false,
                              minDropdownWidth: 320,
                            }}
                          />
                        </div>
                      ) : null}
                      {canSelectDebtObject ? (
                        <div className="space-y-1">
                          <div className="form-label">{t("debtTx.counterpartyAccount")}</div>
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={handleDebtAccountChange}
                            options={debtObjectAccountOptions}
                            placeholder={debtInstitutionId ? t("debtTx.placeholder.autoReuseOrCreate") : t("debtTx.placeholder.selectObjectFirst")}
                            onCreateClick={selectedDebtObjectIsCounterparty ? () => { void openDebtAccountCreate(); } : undefined}
                            createLabel={t("debtTx.addAccount")}
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
                          <div className="form-label">{t("debtTx.borrowItem")}</div>
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={setDebtAccountId}
                            options={debtAccountOptions}
                            placeholder={t("debtTx.placeholder.selectExistingBorrowing")}
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
                          <div className="form-label">{mode === "repay_out" ? t("debtTx.borrowItem") : t("debtTx.lendItem")}</div>
                          <SmartSelect
                            mode="single"
                            value={debtAccountId}
                            onChange={setDebtAccountId}
                            options={debtAccountOptions}
                            placeholder={mode === "repay_out" ? t("debtTx.placeholder.selectExistingBorrowing") : t("debtTx.placeholder.selectExistingLending")}
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

                    {canSelectDebtObject && !debtAccountId ? (
                      <div className="space-y-1">
                        <div className="form-label">{t("debtTx.newAccountName")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
                          <input
                            value={debtItemName}
                            onChange={(event) => setDebtItemName(event.target.value)}
                            list={debtItemListId}
                            disabled={selectedExistingDebtItem}
                            placeholder={t("debtTx.placeholder.autoName", { name: selectedDebtObjectName })}
                            className="form-input"
                          />
                          <datalist id={debtItemListId}>
                            {debtItemSuggestions.map((name) => <option key={name} value={name} />)}
                          </datalist>
                      </div>
                    ) : null}

                    {!showPrepayment && !showBorrowPlan ? (
                    <div className={`grid gap-3 ${showInterest ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{showSimpleTransferMode ? t("txForm.amount") : mode === "borrow_in" ? (showLoanBorrowOptions && loanFundingMode === "financed_purchase" ? t("debtTx.installmentPrincipal") : t("debtTx.totalBorrowing")) : mode === "repay_out" || mode === "collect_in" || mode === "lend_out" ? t("debtShell.colPrincipal") : t("txForm.amount")}</div>
                        <CalcInput value={principal} onChange={setPrincipal} placeholder={t("debtTx.placeholder.exampleAmount")} label={t("txForm.amount")} precision={2} />
                      </div>
                      {showInterest ? (
                        <div className="space-y-1">
                          <div className="form-label">{t("debtShell.colInterest")}</div>
                          <CalcInput value={interest} onChange={setInterest} placeholder={t("debtTx.placeholder.exampleInterest")} label={t("debtShell.colInterest")} precision={2} />
                        </div>
                      ) : null}
                      {showInterest && !showPrepayment ? (
                        <div className="space-y-1">
                            <div className="form-label">{mode === "lend_out" ? t("debtTx.receivableTotal") : t("debtTx.principalInterestTotal")}</div>
                          <input
                            value={repaymentTotal}
                            readOnly
                            placeholder={t("debtShell.lpr.autoCalculated")}
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
                            <div className="form-label">{t("debtTx.prepayPrincipal")}</div>
                            <CalcInput value={principal} onChange={handlePrincipalChange} placeholder={t("debtTx.placeholder.exampleAmount")} label={t("debtTx.prepayPrincipal")} precision={2} />
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.feePenalty")}</div>
                            <CalcInput value={penalty} onChange={handlePenaltyChange} placeholder={t("stockFee.optional")} label={t("txForm.fee")} precision={2} />
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.handleFollowUpPlan")}</div>
                            <select
                              value={prepayStrategy}
                              onChange={(event) => setPrepayStrategy(event.target.value as PrepayStrategy)}
                              className="form-input"
                            >
                              {(Object.keys(PREPAY_STRATEGY_LABELS) as PrepayStrategy[]).map((item) => (
                                <option key={item} value={item}>{t(PREPAY_STRATEGY_LABELS[item])}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.expenseTotal")}</div>
                            <CalcInput
                              value={prepayTotal}
                              onChange={handlePrepayTotalChange}
                              onBlur={() => applyPrepayTotalDraft()}
                              placeholder={t("debtTx.placeholder.autoOrManual")}
                              label={t("debtTx.expenseTotal")}
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
                            <div className="form-label">{t("debtTx.repaymentMethod")}</div>
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
                              <option value="等额本息">{t("debtTx.method.equalInstallment")}</option>
                              <option value="等额本金">{t("debtTx.method.equalPrincipal")}</option>
                              <option value={INTEREST_FREE_REPAYMENT_METHOD}>{t("debtTx.method.interestFreeInstallment")}</option>
                              <option value="自由还款">{t("debtTx.method.freeRepayment")}</option>
                              <option value="先还利息一次性还本">{t("debtTx.method.interestFirstThenPrincipal")}</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">
                              {loanFundingMode === "financed_purchase" ? t("debtTx.installmentPrincipal") : t("debtTx.totalBorrowing")}
                            </div>
                            <CalcInput value={principal} onChange={setPrincipal} placeholder={t("debtTx.placeholder.exampleAmount")} label={t("debtTx.totalBorrowing")} precision={2} />
                          </div>
                        </div>

                        {isFixedRepaymentMethod ? (
                          <>
                            {!isInterestFreeRepaymentMethod ? <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                              <div className="space-y-1">
                                <div className="form-label">
                                  {t("debtTx.bankExecutionRate")}
                                </div>
                                <input
                                  value={bankExecutionRate}
                                  onChange={(event) => setBankExecutionRate(event.target.value)}
                                  placeholder={t("debtTx.placeholder.exampleBankRate")}
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
                                  {t("debtTx.fetch")}
                                </button>
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <div className="form-label">{t("debtTx.mortgageLprDiscount")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
                                <input
                                  value={mortgageLprDiscount}
                                  onChange={(event) => setMortgageLprDiscount(event.target.value)}
                                  onBlur={handleMortgageLprDiscountBlur}
                                  placeholder={t("debtShell.lpr.discountPlaceholder")}
                                  inputMode="decimal"
                                  className="form-input"
                                />
                              </div>
                              <div className="space-y-1">
                                <div className="form-label">
                                  {t("debtShell.rateAdjust.annualRateLabel")} <span className="text-red-500">*</span>
                                </div>
                                <input
                                  value={annualRate}
                                  onChange={(event) => {
                                    setAnnualRateManuallyEdited(true);
                                    setAnnualRate(event.target.value);
                                  }}
                                  placeholder={t("debtTx.placeholder.exampleAnnualRate")}
                                  inputMode="decimal"
                                  className="form-input"
                                />
                              </div>
                            </div>
                            </> : (
                              <div className="border-y border-slate-100 py-2 text-xs text-slate-500">
                                {t("debtTx.interestFreeHint")}
                              </div>
                            )}
                            <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <div className="form-label">{t("debtTx.totalRuns")} <span className="text-red-500">*</span></div>
                                <input
                                  type="number"
                                  min={1}
                                  max={600}
                                  value={loanTotalRuns}
                                  onChange={(event) => setLoanTotalRuns(event.target.value)}
                                  className="form-input"
                                />
                              </div>
                              <div className="space-y-1">
                                <div className="form-label">{t("debtTx.firstRepaymentDate")} <span className="text-red-500">*</span></div>
                                <DateStepper value={firstRepaymentDate} onChange={setFirstRepaymentDate} />
                              </div>
                            </div>

                            {!isInterestFreeRepaymentMethod ? (
                              <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <div>
                                  <div className="text-xs font-medium text-slate-700">{t("debtShell.rateAdjustment")}</div>
                                  <div className="mt-0.5 text-[11px] text-slate-500">
                                    {showHistoricalRates && historicalRateRows.some((row) => row.effectiveDate.trim() || row.annualRate.trim())
                                      ? t("debtTx.rateAdjustFilledHint", { count: historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length })
                                      : t("debtTx.rateAdjustDefaultHint")}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="secondary-button h-8 shrink-0 px-3 text-xs"
                                  onClick={() => {
                                    setShowHistoricalRates(true);
                                    setHistoricalRateRows((prev) => prev.length > 0 ? prev : [createHistoricalRateRow(firstRepaymentDate, annualRate)]);
                                    setHistoricalRatesOpen(true);
                                  }}
                                >
                                  {t("debtShell.rateAdjustment")}
                                </button>
                              </div>
                            ) : null}

                            {loanSchedulePreview ? (
                              <div className="rounded-md border border-slate-200">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                                  <span className="font-medium text-slate-700">
                                    {t("debtTx.schedulePreviewTitle", {
                                      count: loanSchedulePreview.rows.length,
                                      interval: loanSchedulePreview.intervalMonths === 1 ? t("debtTx.everyMonth") : t("debtTx.everyNMonths", { n: loanSchedulePreview.intervalMonths }),
                                      day: loanSchedulePreview.repaymentDay,
                                    })}
                                  </span>
                                  <span className="tabular-nums">
                                    {t("debtTx.scheduleSummary", {
                                      principal: formatMoneyPreview(loanSchedulePreview.totalPrincipal, language),
                                      interest: formatMoneyPreview(loanSchedulePreview.totalInterest, language),
                                      total: formatMoneyPreview(loanSchedulePreview.totalPayment, language),
                                    })}
                                  </span>
                                </div>
                                <div className="max-h-56 overflow-auto">
                                  <table className="min-w-full text-xs tabular-nums">
                                    <thead className="sticky top-0 bg-white text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                                      <tr>
                                        <th className="px-2 py-1 text-left font-medium">{t("txForm.periods")}</th>
                                        <th className="px-2 py-1 text-left font-medium">{t("detail.column.postedAt")}</th>
                                        <th className="px-2 py-1 text-left font-medium">{t("debtTx.colRepaymentDate")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("debtShell.colPrincipal")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("debtShell.colInterest")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("txForm.dueAmount")}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {loanSchedulePreview.rows.map((row) => (
                                        <tr key={`${row.period}-${row.date}`} className="border-t border-slate-100">
                                          <td className="px-2 py-1 text-slate-600">{row.period}/{loanTotalRuns}</td>
                                          <td className="px-2 py-1 text-slate-600">{date}</td>
                                          <td className="px-2 py-1 text-slate-600">{row.date}</td>
                                          <td className="px-2 py-1 text-right text-slate-700">{formatMoneyPreview(row.principal, language)}</td>
                                          <td className="px-2 py-1 text-right text-slate-700">{formatMoneyPreview(row.interest, language)}</td>
                                          <td className="px-2 py-1 text-right font-medium text-slate-800">{formatMoneyPreview(row.payment, language)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            {t("debtTx.freeRepaymentHint")}
                          </div>
                        )}

                        <label className="flex cursor-pointer select-none items-start gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={autoDebit}
                            onChange={(event) => setAutoDebit(event.target.checked)}
                            className="mt-0.5 h-3.5 w-3.5 accent-blue-600"
                          />
                          <span>
                            {t("debtTx.autoDebitLabel")}
                            <span className="block text-[11px] text-slate-400">{t("debtTx.autoDebitHint")}</span>
                          </span>
                        </label>
                      </>
                    ) : null}

                    {!showBorrowPlan ? (
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.remark")}</div>
                          <input
                            name="note"
                            placeholder={t("stockFee.optional")}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            className="form-input"
                          />
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                          {mode === "repay_out"
                            ? t("debtTx.hint.repayOut")
                            : mode === "prepay_out"
                              ? t("debtTx.hint.prepayOut")
                            : mode === "lend_out"
                              ? t("debtTx.hint.lendOut")
                              : t("debtTx.hint.collectIn")}
                        </div>
                      </>
                    ) : null}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button type="button" className="secondary-button h-9 px-3" disabled={submitting} onClick={() => saveDebtTransaction(true)}>
                        {submitting ? t("txForm.saving") : t("txForm.saveAndRepeat")}
                      </button>
                      <button type="submit" className="primary-button h-9 px-3" disabled={submitting}>
                        {submitting ? t("txForm.saving") : t("common.save")}
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
                  <div className="text-sm font-semibold text-slate-800">{t("debtTx.historyConfirmTitle")}</div>
                  <button
                    type="button"
                    onClick={() => setHistoryConfirmOpen(false)}
                    className="secondary-button h-8 px-2"
                    disabled={submitting}
                  >
                    {t("debtTx.back")}
                  </button>
                </div>
                <div className="space-y-3 p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    {t("debtTx.historyPrompt.warning", { date: firstRepaymentDate || "-" })}
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <input
                      type="checkbox"
                      checked={createHistoricalRepaymentRecords}
                      onChange={(event) => setCreateHistoricalRepaymentRecords(event.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-blue-600"
                    />
                    <span>
                      <span className="block font-medium text-slate-800">{t("debtTx.historyPrompt.generateLabel")}</span>
                      <span className="block text-xs text-slate-500">{t("debtTx.historyPrompt.generateHint")}</span>
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
                      <span className="block font-medium text-slate-800">{t("debtTx.historyPrompt.hasRateAdjustments")}</span>
                      <span className="block text-xs text-slate-500">{t("debtTx.historyPrompt.rateAdjustmentsHint")}</span>
                    </span>
                  </label> : null}

                  {showHistoricalRates ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div>
                        <div className="text-xs font-medium text-slate-700">
                          {t("debtTx.historyRateFilled", { count: historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length })}
                        </div>
                        <div className="text-[11px] text-slate-500">{t("debtTx.historyRateValidateHint")}</div>
                      </div>
                      <button
                        type="button"
                        className="secondary-button h-8 px-3 text-xs"
                        onClick={() => {
                          setHistoricalRateRows((prev) => prev.length > 0 ? prev : [createHistoricalRateRow()]);
                          setHistoricalRatesOpen(true);
                        }}
                      >
                        {t("debtShell.rateAdjustment")}
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
                      {t("debtTx.backToEdit")}
                    </button>
                    <button
                      type="button"
                      className="primary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => { void confirmHistoricalPrompt(); }}
                    >
                      {submitting ? t("txForm.saving") : t("debtTx.confirmSave")}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historicalRatesOpen
        ? createPortal(
            <div className="app-modal-backdrop z-[70]">
              <div className="app-modal-panel max-w-xl">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">{t("debtShell.rateAdjustment")}</div>
                  <button
                    type="button"
                    onClick={() => setHistoricalRatesOpen(false)}
                    className="secondary-button h-8 px-2"
                  >
                    {t("table.close")}
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                    {t("debtTx.rateModal.hint")}
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2">
                      <div className="text-xs font-semibold text-slate-700">{t("debtShell.lpr.title")}</div>
                      <div className="mt-0.5 text-[11px] leading-5 text-slate-500">
                        {t("debtTx.lpr.hint", {
                          base: MORTGAGE_BASE_BENCHMARK_RATE.toFixed(2),
                          conversion: MORTGAGE_LPR_CONVERSION_BASE_RATE.toFixed(2),
                        })}
                      </div>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_92px] gap-2">
                      <div className="space-y-1">
                        <div className="form-label">{t("debtShell.lpr.discountLabel")}</div>
                        <input
                          value={mortgageLprDiscount}
                          onChange={(event) => setMortgageLprDiscount(event.target.value)}
                          inputMode="decimal"
                          placeholder={t("debtShell.lpr.discountPlaceholder")}
                          className="form-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("debtShell.lpr.spreadLabel")}</div>
                        <input
                          value={(() => {
                            const discount = Number(mortgageLprDiscount.trim());
                            return Number.isFinite(discount) && discount > 0
                              ? `${calcMortgageLprSpreadFromDiscount(discount).toFixed(3).replace(/\.?0+$/, "")}%`
                              : "";
                          })()}
                          readOnly
                          placeholder={t("debtShell.lpr.autoCalculated")}
                          className="form-input bg-white/70 text-slate-500"
                        />
                      </div>
                      <div className="flex items-end">
                        <button
                          type="button"
                          className="inline-flex h-9 w-full items-center justify-center rounded-full border border-blue-600 bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700"
                          onClick={() => applyMortgageLprDiscount()}
                        >
                          {t("debtShell.lpr.generate")}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 px-1 text-xs font-medium text-slate-500">
                      <div>{t("debtShell.rateAdjust.effectiveDate")}</div>
                      <div>{t("debtShell.rateAdjust.annualRateLabel")}</div>
                      <div className="text-right">{t("detail.column.actions")}</div>
                    </div>
                    <div className="max-h-[230px] space-y-2 overflow-y-auto pr-1">
                      {historicalRateRows.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                          {t("debtShell.rateAdjust.empty")}
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
                            placeholder={t("debtShell.rateAdjust.annualRatePlaceholder")}
                            className="form-input"
                          />
                          <button
                            type="button"
                            className="secondary-button h-9 px-2 text-rose-600 hover:bg-rose-50"
                            onClick={() => {
                              setHistoricalRateRows((prev) => prev.filter((item) => item.key !== row.key));
                            }}
                          >
                            {t("common.delete")}
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
                      {t("debtTx.addRow")}
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
                        {t("table.clear")}
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
                          const result = serializeHistoricalRateRows(historicalRateRows, t);
                          if (!result.ok) {
                            window.alert(result.error);
                            return;
                          }
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        {t("table.confirm")}
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
              title={t("txForm.addCounterparty")}
              nameLabel={t("debtTx.objectName")}
              namePlaceholder={t("debtTx.objectNamePlaceholder")}
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
      {open && debtAccountNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType="account"
              open={debtAccountNestedOpen}
              onClose={() => setDebtAccountNestedOpen(false)}
              title={t("debtTx.addCounterpartyAccount")}
              nameLabel={t("debtTx.counterpartyAccountName")}
              namePlaceholder={t("debtTx.counterpartyAccountNamePlaceholder")}
              defaultType="loan"
              hiddenFields={[
                "kind",
                "groupId",
                "institutionId",
                "currency",
                "billingDay",
                "repaymentDay",
                "creditLimit",
                "creditBillMode",
                "numberMasked",
                "investProductType",
                "fundUnitsDecimals",
                "tradingCalendar",
                "costBasisMethod",
                "defaultFundQueryApiId",
              ]}
              extraFields={{
                kind: "loan",
                counterpartyId: rawDebtObjectId(debtInstitutionId),
              }}
              onCreated={(id, name, extra) => {
                const nextOption: AccountOption = {
                  id,
                  label: name,
                  subLabel: extra?.counterpartyName ? t("debtTx.subLabel.settlement", { name: extra.counterpartyName }) : t("debtTx.subLabel.settlementPlain"),
                  counterpartyId: extra?.counterpartyId ?? rawDebtObjectId(debtInstitutionId),
                  debtDirection: "receivable" as const,
                };
                setLocalDebtAccounts((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, nextOption]));
                setDebtAccountId(id);
                setDebtAccountNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
