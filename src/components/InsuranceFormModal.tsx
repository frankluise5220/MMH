"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { Repeat } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";
import { formatMoneyLoose as formatMoney } from "@/lib/format";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

type Entry = {
  id?: string;
  transactionId?: string;
  date: string;
  amount: number;
  note?: string | null;
  fundName?: string | null;
  fundProductType?: string | null;
  fundSubtype?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  toAccountName?: string | null;
  source?: string | null;
  insuranceProductId?: string | null;
  fundArrivalDate?: string | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

type InsuranceProductOption = {
  id: string;
  label: string;
  subLabel?: string;
  isMaster?: boolean;
  productMasterId?: string | null;
  accountId: string;
  accountLabel?: string;
  ownerGroupId?: string | null;
  ownerGroupName?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  institutionShortName?: string | null;
  policyNo?: string | null;
  productType?: string | null;
  accountingType?: string | null;
  policyholderPersonId?: string | null;
  policyholderPersonName?: string | null;
  insuredPersonId?: string | null;
  insuredPersonName?: string | null;
  insuredUserId?: string | null;
  insuredUserName?: string | null;
  beneficiaryName?: string | null;
  premiumMode?: string | null;
  premiumFrequencyMonths?: number | null;
  premiumAmount?: number | null;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  coverageAmount?: number | null;
  status?: string | null;
  startDate?: string | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  cashValueEnabled?: boolean | null;
  note?: string | null;
};

type OptionItem = {
  id: string;
  label: string;
  subLabel?: string;
};

type AccountMeta = {
  id: string;
  name: string;
  kind?: string | null;
  label: string;
  groupId?: string | null;
  groupName?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  institutionShortName?: string | null;
};

type InsuranceSubmitOptions = {
  createPremiumPlan: boolean;
  backfillPastRecords: boolean;
};

type InternalAccountRow = {
  id: string;
  name: string;
  kind?: string | null;
  groupId?: string | null;
  AccountGroup?: { id?: string | null; name?: string | null } | null;
};

type OwnerOption = {
  id: string;
  label: string;
  subLabel?: string;
};

const PRODUCT_TYPE_OPTIONS = [
  { value: "savings", label: "储蓄型" },
  { value: "dividend", label: "分红型" },
  { value: "annuity", label: "年金型" },
  { value: "universal", label: "万能型" },
  { value: "investment_linked", label: "投连型" },
  { value: "critical_illness", label: "重疾险" },
  { value: "medical", label: "医疗险" },
  { value: "accident", label: "意外险" },
  { value: "term_life", label: "定期寿险" },
  { value: "whole_life", label: "终身寿险" },
  { value: "other", label: "其他" },
] as const;

const PAYMENT_MODE_OPTIONS = [
  { value: 12, label: "年交" },
  { value: 999999, label: "趸交" },
] as const;

const PRODUCT_ACCOUNTING_TYPE: Record<string, "asset" | "protection" | "hybrid"> = {
  savings: "asset",
  dividend: "asset",
  annuity: "asset",
  universal: "asset",
  investment_linked: "asset",
  critical_illness: "protection",
  medical: "protection",
  accident: "protection",
  term_life: "protection",
  whole_life: "hybrid",
  other: "asset",
};

function productTypeLabel(type?: string | null) {
  return PRODUCT_TYPE_OPTIONS.find((item) => item.value === type)?.label ?? "保险";
}

function accountingTypeForProductType(type?: string | null) {
  return PRODUCT_ACCOUNTING_TYPE[String(type ?? "").trim()] ?? "asset";
}

function parseOptionalNumber(input: string) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function inferPremiumMode(frequencyMonths: number | null) {
  if (frequencyMonths === 999999) return "single";
  if (frequencyMonths && frequencyMonths > 0) return "recurring";
  return null;
}

function parseDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addYearsClamped(date: Date, years: number) {
  const next = new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), 1));
  const maxDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(date.getUTCDate(), maxDay));
  return next;
}

function addMonthsKeepingAnchorDay(date: Date, months: number, anchorDay?: number | null) {
  const interval = Number.isFinite(months) && months > 0 ? months : 12;
  const source = parseDateOnly(formatDateOnly(date)) ?? date;
  const targetMonth = source.getUTCMonth() + interval;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(anchorDay && anchorDay >= 1 ? anchorDay : source.getUTCDate(), maxDay);
  return new Date(Date.UTC(targetYear, normalizedMonth, targetDay));
}

function buildPremiumDueDates(startDate: Date, endDate: Date, frequencyMonths: number, totalRuns: number) {
  const dates: string[] = [];
  const anchorDay = startDate.getUTCDate();
  let current = parseDateOnly(formatDateOnly(startDate));
  let guard = 0;
  while (current && current <= endDate && dates.length < totalRuns) {
    dates.push(formatDateOnly(current));
    current = addMonthsKeepingAnchorDay(current, frequencyMonths, anchorDay);
    guard++;
    if (guard > 1200) break;
  }
  return dates;
}

function latestPremiumDueDate(startDate: Date, endDate: Date, frequencyMonths: number, totalRuns: number) {
  const dueDates = buildPremiumDueDates(startDate, endDate, frequencyMonths, totalRuns);
  return dueDates.length > 0 ? dueDates[dueDates.length - 1] : null;
}

function valueFromRecord(item: Record<string, unknown>, key: string) {
  const value = item[key];
  return value == null ? "" : String(value);
}

function nullableStringFromRecord(item: Record<string, unknown>, key: string) {
  const value = valueFromRecord(item, key).trim();
  return value || null;
}

function nullableNumberFromRecord(item: Record<string, unknown>, key: string) {
  const value = item[key];
  return value == null ? null : Number(value);
}

function mapInsuranceProduct(item: Record<string, unknown>): InsuranceProductOption {
  return {
    id: valueFromRecord(item, "id"),
    label: valueFromRecord(item, "name"),
    subLabel: [valueFromRecord(item, "institutionShortName") || valueFromRecord(item, "institutionName"), productTypeLabel(nullableStringFromRecord(item, "productType"))].filter(Boolean).join(" · "),
    productMasterId: nullableStringFromRecord(item, "productMasterId"),
    accountId: valueFromRecord(item, "accountId"),
    accountLabel: valueFromRecord(item, "accountName"),
    ownerGroupId: nullableStringFromRecord(item, "ownerGroupId"),
    ownerGroupName: nullableStringFromRecord(item, "ownerGroupName"),
    institutionId: nullableStringFromRecord(item, "institutionId"),
    institutionName: nullableStringFromRecord(item, "institutionName"),
    institutionShortName: nullableStringFromRecord(item, "institutionShortName"),
    policyNo: nullableStringFromRecord(item, "policyNo"),
    productType: nullableStringFromRecord(item, "productType"),
    accountingType: nullableStringFromRecord(item, "accountingType"),
    policyholderPersonId: nullableStringFromRecord(item, "policyholderPersonId"),
    policyholderPersonName: nullableStringFromRecord(item, "policyholderPersonName"),
    insuredPersonId: nullableStringFromRecord(item, "insuredPersonId"),
    insuredPersonName: nullableStringFromRecord(item, "insuredPersonName"),
    insuredUserId: nullableStringFromRecord(item, "insuredUserId"),
    insuredUserName: nullableStringFromRecord(item, "insuredUserName"),
    beneficiaryName: nullableStringFromRecord(item, "beneficiaryName"),
    premiumMode: nullableStringFromRecord(item, "premiumMode"),
    premiumFrequencyMonths: nullableNumberFromRecord(item, "premiumFrequencyMonths"),
    premiumAmount: nullableNumberFromRecord(item, "premiumAmount"),
    paymentTermYears: nullableNumberFromRecord(item, "paymentTermYears"),
    coverageTermYears: nullableNumberFromRecord(item, "coverageTermYears"),
    coverageAmount: nullableNumberFromRecord(item, "coverageAmount"),
    status: nullableStringFromRecord(item, "status"),
    startDate: nullableStringFromRecord(item, "startDate"),
    effectiveDate: nullableStringFromRecord(item, "effectiveDate"),
    maturityDate: nullableStringFromRecord(item, "maturityDate"),
    cashValueEnabled: item.cashValueEnabled != null ? Boolean(item.cashValueEnabled) : null,
    note: nullableStringFromRecord(item, "note"),
  };
}

function mapInsuranceProductMaster(item: Record<string, unknown>): InsuranceProductOption {
  const id = valueFromRecord(item, "id");
  return {
    id,
    isMaster: true,
    productMasterId: id,
    label: valueFromRecord(item, "name"),
    subLabel: [valueFromRecord(item, "institutionShortName") || valueFromRecord(item, "institutionName"), productTypeLabel(nullableStringFromRecord(item, "productType"))].filter(Boolean).join(" · "),
    accountId: "",
    institutionId: nullableStringFromRecord(item, "institutionId"),
    institutionName: nullableStringFromRecord(item, "institutionName"),
    institutionShortName: nullableStringFromRecord(item, "institutionShortName"),
    productType: nullableStringFromRecord(item, "productType"),
    accountingType: nullableStringFromRecord(item, "accountingType"),
    status: nullableStringFromRecord(item, "status"),
    note: nullableStringFromRecord(item, "note"),
  };
}

export function InsuranceFormModal({
  mode = "create",
  accountId: defaultAccountId,
  entry,
  cashAccounts = [],
  cashAccountSSOptions,
  nestedFieldData,
}: {
  mode?: "create" | "edit";
  accountId: string;
  entry?: Entry;
  cashAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const initIsRedeem = mode === "edit" && entry ? entry.amount > 0 : false;
  const initAmount = mode === "edit" && entry ? String(Math.abs(entry.amount)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initArrivalDate = mode === "edit" && entry?.fundArrivalDate ? entry.fundArrivalDate.slice(0, 10) : initDate;
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";
  const initCashAccountId =
    mode === "edit" && entry
      ? (initIsRedeem ? (entry.toAccountId ?? "") : (entry.accountId ?? ""))
      : "";

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<"buy" | "redeem">(initIsRedeem ? "redeem" : "buy");
  const [date, setDate] = useState(initDate);
  const [arrivalDate, setArrivalDate] = useState(initArrivalDate);
  const arrivalDateTouchedRef = useRef(mode === "edit");
  const [amount, setAmount] = useState(initAmount);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [memo, setMemo] = useState(initMemo);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [insuranceProductId, setInsuranceProductId] = useState(mode === "edit" ? (entry?.insuranceProductId ?? "") : "");
  const [productType, setProductType] = useState("savings");
  const [policyNo, setPolicyNo] = useState("");
  const [policyholderPersonId, setPolicyholderPersonId] = useState("");
  const [insuredPersonId, setInsuredPersonId] = useState("");
  const [beneficiaryPersonId, setBeneficiaryPersonId] = useState("");
  const [premiumFrequencyMonths, setPremiumFrequencyMonths] = useState("12");
  const isAnnualPayment = premiumFrequencyMonths === "12";
  const isSinglePayment = premiumFrequencyMonths === "999999";
  const [productStartDateTouched, setProductStartDateTouched] = useState(false);
  const [productStartDate, setProductStartDate] = useState(initDate);
  const [paymentTermYears, setPaymentTermYears] = useState("");
  const [coverageTermYears, setCoverageTermYears] = useState("");
  const [coverageAmount, setCoverageAmount] = useState("");
  const [lastAppliedProductId, setLastAppliedProductId] = useState<string>("");
  const [showNewProductModal, setShowNewProductModal] = useState(false);
  const [newProductInstitutionId, setNewProductInstitutionId] = useState("");
  const [newProductName, setNewProductName] = useState("");
  const [newProductLookupCandidates, setNewProductLookupCandidates] = useState<
    Array<{
      id: string;
      name: string;
      institutionName?: string | null;
      productType?: string | null;
      accountingType?: string | null;
      status?: string | null;
    }>
  >([]);
  const [newProductSelectedCandidate, setNewProductSelectedCandidate] = useState(-1);
  const [newProductLookupLoading, setNewProductLookupLoading] = useState(false);
  const [newProductLookupError, setNewProductLookupError] = useState("");
  const [newProductSaving, setNewProductSaving] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingPlanData, setPendingPlanData] = useState<{
    totalRuns: number;
    historyCount: number;
    dueCount: number;
    amount: number;
    planStartDate: string;
    currentRecordDate: string;
    frequencyLabel: string;
  } | null>(null);
  const [confirmBatchGenerate, setConfirmBatchGenerate] = useState(false);

  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [insuranceProductOptions, setInsuranceProductOptions] = useState<InsuranceProductOption[]>([]);
  const [institutionOptions, setInstitutionOptions] = useState<OptionItem[]>([]);
  const [familyMemberOptions, setFamilyMemberOptions] = useState<OptionItem[]>([]);
  const [accountMetaById, setAccountMetaById] = useState<Record<string, AccountMeta>>({});
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "family-member" | null>(null);

  const selectedInsuranceProduct = useMemo(
    () => insuranceProductOptions.find((item) => item.id === insuranceProductId) ?? null,
    [insuranceProductId, insuranceProductOptions],
  );

  const selectedPolicyholder = useMemo(
    () => familyMemberOptions.find((item) => item.id === policyholderPersonId) ?? null,
    [familyMemberOptions, policyholderPersonId],
  );
  const selectedPolicyholderName = selectedPolicyholder?.label.trim() ?? "";
  const selectedOwnerGroupId = useMemo(() => {
    if (!selectedPolicyholderName) return "";
    const matchedAccount = Object.values(accountMetaById).find(
      (account) => account.groupName?.trim() === selectedPolicyholderName,
    );
    return matchedAccount?.groupId ?? "";
  }, [accountMetaById, selectedPolicyholderName]);

  async function handleNewProductLookup() {
    const productName = newProductName.trim();
    const institutionId = newProductInstitutionId.trim();
    if (!productName || !institutionId) return;

    const institutionName = institutionOptions.find((item) => item.id === institutionId)?.label.trim() ?? "";
    setNewProductLookupLoading(true);
    setNewProductLookupError("");
    try {
      const params = new URLSearchParams({ name: productName });
      if (institutionName) params.set("institutionName", institutionName);
      const response = await fetch(`/api/v1/insurance-products/lookup?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            data?: { candidates?: Array<{ name?: string; institutionName?: string | null; productType?: string | null; status?: string | null; source?: string; url?: string | null; confidence?: "low" | "medium" | "high"; reason?: string }> };
          }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "查询失败");
      }
      const candidates = data.data?.candidates ?? [];
      setNewProductLookupCandidates(
        candidates.map((candidate) => ({
          id: `${candidate.name ?? ""}__${candidate.institutionName ?? ""}__${candidate.source ?? ""}`,
          name: candidate.name ?? "",
          institutionName: candidate.institutionName ?? null,
          productType: candidate.productType ?? null,
          accountingType: null,
          status: candidate.status ?? null,
        })),
      );
      setNewProductSelectedCandidate(candidates.length > 0 ? 0 : -1);
    } catch (error) {
      setNewProductLookupCandidates([]);
      setNewProductSelectedCandidate(-1);
      setNewProductLookupError(error instanceof Error ? error.message : "查询失败");
    } finally {
      setNewProductLookupLoading(false);
    }
  }

  async function handleCreateProductMaster() {
    const productName = newProductName.trim();
    const institutionId = newProductInstitutionId.trim();
    if (!productName || !institutionId || newProductSaving) return;

    const selectedCandidate = newProductLookupCandidates[newProductSelectedCandidate] ?? null;
    setNewProductSaving(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          institutionId,
          name: productName,
          shortName: selectedCandidate?.name ?? null,
          productType: selectedCandidate?.productType ?? "other",
          accountingType: selectedCandidate?.accountingType ?? "protection",
          currency: "CNY",
          note: selectedCandidate?.status ?? null,
          mode: "master",
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; productMaster?: Record<string, unknown> }
        | null;
      if (!response.ok || !data?.ok || !data.productMaster) {
        throw new Error(data?.error || "创建失败");
      }
      const nextOption = mapInsuranceProductMaster(data.productMaster);
      setInsuranceProductOptions((prev) => [
        ...prev.filter((item) => item.id !== nextOption.id),
        nextOption,
      ]);
      setInsuranceProductId(nextOption.id);
      setShowNewProductModal(false);
      setNewProductInstitutionId("");
      setNewProductName("");
      setNewProductLookupCandidates([]);
      setNewProductSelectedCandidate(-1);
      setNewProductLookupError("");
    } catch (error) {
      setNewProductLookupError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setNewProductSaving(false);
    }
  }

  function handleCancelConfirm() {
    setShowConfirmDialog(false);
    setPendingPlanData(null);
    setConfirmBatchGenerate(false);
  }

  function getPremiumRecordDate() {
    const start = parseDateOnly(productStartDate);
    if (!start) return date;

    const frequencyMonths = parseOptionalNumber(premiumFrequencyMonths);
    if (!frequencyMonths || frequencyMonths >= 999999) return formatDateOnly(start);

    const termYears = parseOptionalNumber(paymentTermYears);
    const todayDate = parseDateOnly(today);
    if (!termYears || !todayDate) return formatDateOnly(start);

    const totalRuns = Math.ceil((termYears * 12) / frequencyMonths);
    return latestPremiumDueDate(start, todayDate, frequencyMonths, totalRuns) ?? formatDateOnly(start);
  }

  function getPremiumPlanPreview() {
    const frequencyMonths = parseOptionalNumber(premiumFrequencyMonths);
    const termYears = parseOptionalNumber(paymentTermYears);
    const amountValue = parseOptionalNumber(amount);
    const start = parseDateOnly(productStartDate);
    const currentEntryDate = parseDateOnly(getPremiumRecordDate());
    const todayDate = parseDateOnly(today);
    if (
      !frequencyMonths ||
      frequencyMonths >= 999999 ||
      !termYears ||
      !amountValue ||
      !start ||
      !currentEntryDate ||
      !todayDate
    ) {
      return null;
    }
    const totalRuns = Math.ceil((termYears * 12) / frequencyMonths);
    if (totalRuns <= 1) return null;
    const dueDates = buildPremiumDueDates(start, todayDate, frequencyMonths, totalRuns);
    const currentEntryDateText = formatDateOnly(currentEntryDate);
    const historyCount = dueDates.filter((item) => item < currentEntryDateText).length;
    const dueCount = dueDates.filter((item) => item <= currentEntryDateText).length;
    return {
      totalRuns,
      historyCount,
      dueCount,
      amount: amountValue,
      planStartDate: formatDateOnly(start),
      currentRecordDate: formatDateOnly(currentEntryDate),
      frequencyLabel: frequencyMonths === 12 ? "每年" : `每 ${frequencyMonths} 个月`,
    };
  }

  function handleConfirmPlanAndBatch() {
    setShowConfirmDialog(false);
    setPendingPlanData(null);
    void submitInsurance({
      createPremiumPlan: true,
      backfillPastRecords: confirmBatchGenerate,
    });
  }

  const cashOptionsForPolicyholder = useMemo<SmartSelectOption[] | undefined>(() => {
    const sourceOptions = localCashSSOpts;
    if (!sourceOptions || !selectedPolicyholderName) return sourceOptions;
    const allowedAccountIds = new Set(
      Object.values(accountMetaById)
        .filter((account) => account.groupName?.trim() === selectedPolicyholderName)
        .map((account) => account.id),
    );
    const optionById = new Map(sourceOptions.map((option) => [option.id, option]));
    const keptIds = new Set<string>();
    for (const accountId of allowedAccountIds) {
      keptIds.add(accountId);
      let parentId = optionById.get(accountId)?.parentId;
      while (parentId) {
        keptIds.add(parentId);
        parentId = optionById.get(parentId)?.parentId;
      }
    }
    return sourceOptions.filter((option) => keptIds.has(option.id));
  }, [accountMetaById, localCashSSOpts, selectedPolicyholderName]);

  const cashListForPolicyholder = useMemo(
    () =>
      selectedPolicyholderName
        ? cashAccountList.filter(
            (account) => accountMetaById[account.id]?.groupName?.trim() === selectedPolicyholderName,
          )
        : cashAccountList,
    [accountMetaById, cashAccountList, selectedPolicyholderName],
  );

  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashFiltered,
  } = useAccountSSFilter(cashOptionsForPolicyholder);

  const cashOwnerCycleButton = cashOptionsForPolicyholder?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleCashOwnerFilter}
      title={`所有人：${cashOwnerFilterLabel}`}
      aria-label={`切换所有人，当前${cashOwnerFilterLabel}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  const filteredInsuranceProductOptions = useMemo<SmartSelectOption[]>(() => {
    return insuranceProductOptions
      .filter((item) => {
        if (subtype === "redeem") {
          if (item.isMaster) return false;
          if (selectedOwnerGroupId && item.ownerGroupId !== selectedOwnerGroupId) return false;
        } else {
          if (!item.isMaster) return false;
        }
        return true;
      })
      .map((item) => ({
        id: item.id,
        label: item.label,
        subLabel: item.subLabel,
      }));
  }, [insuranceProductOptions, selectedOwnerGroupId, subtype]);

  function resetForm(defaults?: { requestId?: string | null; defaultCashAccountId?: string; defaultInsuranceAccountId?: string }) {
    setSubtype("buy");
    setDate(today);
    setArrivalDate(today);
    arrivalDateTouchedRef.current = false;
    setAmount("");
    setCashAccountId(defaults?.defaultCashAccountId ?? "");
    setMemo("");
    setRequestId(defaults?.requestId ?? null);
    setEditEntryId(null);
    setInsuranceProductId("");
    setProductType("savings");
    setPolicyNo("");
    setPolicyholderPersonId("");
    setInsuredPersonId("");
    setBeneficiaryPersonId("");
    setPremiumFrequencyMonths("12");
    setProductStartDateTouched(false);
    setProductStartDate(today);
    setPaymentTermYears("");
    setCoverageTermYears("");
    setCoverageAmount("");
    setLastAppliedProductId("");
    setShowConfirmDialog(false);
    setPendingPlanData(null);
    setConfirmBatchGenerate(false);
  }

  useEffect(() => setCashAccountList(cashAccounts), [cashAccounts]);
  useEffect(() => setLocalCashSSOpts(cashAccountSSOptions), [cashAccountSSOptions]);

  function changeDate(nextDate: string) {
    setDate(nextDate);
    if (mode === "create" && subtype === "redeem" && !arrivalDateTouchedRef.current) {
      setArrivalDate(nextDate);
    }
  }

  function changeArrivalDate(nextDate: string) {
    arrivalDateTouchedRef.current = true;
    setArrivalDate(nextDate);
  }
  useEffect(() => {
    let cancelled = false;

    async function loadInsuranceOptions() {
      try {
        const response = await fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" });
        const accountsData = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              accounts?: InternalAccountRow[];
              institutions?: Array<{ id: string; name: string; type?: string | null; shortName?: string | null }>;
            }
          | null;
        if (cancelled || !response.ok || !accountsData?.ok) return;

        const institutions = Array.isArray(accountsData.institutions) ? accountsData.institutions : [];
        const accounts = Array.isArray(accountsData.accounts) ? accountsData.accounts : [];
        const nextFamilyMembers = institutions
          .filter((item) => item.type === "family_member")
          .map((item) => ({
            id: item.id,
            label: item.name,
            subLabel: "家庭成员",
          }));
        const nextInstitutions = institutions
          .filter((item) => item.type === "insurance")
          .map((item) => ({
            id: item.id,
            label: item.name,
            subLabel: item.shortName && item.shortName !== item.name ? item.shortName : "保险公司",
          }));
        setFamilyMemberOptions(nextFamilyMembers);
        setInstitutionOptions(nextInstitutions);
        setAccountMetaById(() => {
          const nextMeta: Record<string, AccountMeta> = {};
          for (const item of accounts) {
            nextMeta[item.id] = {
              id: item.id,
              name: item.name,
              label: item.name,
              kind: item.kind,
              groupId: item.groupId ?? item.AccountGroup?.id ?? null,
              groupName: item.AccountGroup?.name ?? null,
            };
          }
          return nextMeta;
        });
      } catch {
        if (!cancelled) {
          setFamilyMemberOptions([]);
          setInstitutionOptions([]);
        }
      }
    }

    void loadInsuranceOptions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadInsuranceProducts() {
      try {
        const response = await fetch("/api/v1/insurance-products?includeMasters=1", { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as
          | {
              ok?: boolean;
              products?: Array<Record<string, unknown>>;
              masters?: Array<Record<string, unknown>>;
            }
          | null;
        if (cancelled || !response.ok || !data?.ok) return;
        const nextOptions = [
          ...(Array.isArray(data.products) ? data.products.map(mapInsuranceProduct) : []),
          ...(Array.isArray(data.masters) ? data.masters.map(mapInsuranceProductMaster) : []),
        ];
        setInsuranceProductOptions(nextOptions);
      } catch {
        if (!cancelled) setInsuranceProductOptions([]);
      }
    }

    void loadInsuranceProducts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{ requestId: string; defaultCashAccountId?: string; defaultInsuranceAccountId?: string }>).detail;
      resetForm({
        requestId: detail?.requestId ?? null,
        defaultCashAccountId: detail?.defaultCashAccountId,
        defaultInsuranceAccountId: detail?.defaultInsuranceAccountId ?? defaultAccountId,
      });
      setOpen(true);
    }

    window.addEventListener("mmh:insurance:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:insurance:create", onCreate as EventListener);
  }, [accountMetaById, defaultAccountId, today]);

  async function submitInsurance(options: InsuranceSubmitOptions) {
    if (submitting) return;

    const amountValue = parseOptionalNumber(amount);
    if (amountValue == null || amountValue <= 0) {
      window.alert("请输入正确金额");
      return;
    }

    if (!insuranceProductId) {
      window.alert("请选择保单");
      return;
    }
    if (!cashAccountId) {
      window.alert("请选择资金账户");
      return;
    }
    if (!selectedInsuranceProduct) {
      window.alert("请选择保险产品");
      return;
    }

    const entryId = entry?.id || editEntryId || "";
    const isEdit = !!entryId;
    const submitDate = !isEdit && subtype === "buy" ? getPremiumRecordDate() : date;

    setSubmitting(true);
    try {
      const payload = {
        id: isEdit ? entryId : undefined,
        type: "investment",
        date: submitDate,
        amount: amountValue,
        note: memo,
        cashAccountId,
        accountId: selectedInsuranceProduct.accountId || undefined,
        fundName: selectedInsuranceProduct.label || undefined,
        insuranceProductId: selectedInsuranceProduct.isMaster ? undefined : selectedInsuranceProduct.id,
        insuranceProductMasterId: selectedInsuranceProduct.isMaster ? selectedInsuranceProduct.productMasterId : undefined,
        policyNo: !isEdit && subtype === "buy" ? policyNo.trim() || undefined : undefined,
        policyholderPersonId: policyholderPersonId || undefined,
        policyholderPersonName: selectedPolicyholderName || undefined,
        insuredPersonId: insuredPersonId || undefined,
        insuredPersonName:
          familyMemberOptions.find((item) => item.id === insuredPersonId)?.label.trim() ||
          undefined,
        beneficiaryName:
          familyMemberOptions.find((item) => item.id === beneficiaryPersonId)?.label.trim() ||
          undefined,
        startDate: productStartDate || undefined,
        effectiveDate: productStartDate || undefined,
        premiumMode: inferPremiumMode(parseOptionalNumber(premiumFrequencyMonths)),
        premiumFrequencyMonths: parseOptionalNumber(premiumFrequencyMonths) ?? undefined,
        premiumAmount: amountValue,
        paymentTermYears: parseOptionalNumber(paymentTermYears),
        coverageTermYears: parseOptionalNumber(coverageTermYears),
        coverageAmount: parseOptionalNumber(coverageAmount),
        cashValueEnabled: true,
        fundSubtype: subtype === "redeem" ? "redeem" : "buy",
        fundArrivalDate: subtype === "redeem" ? (arrivalDate || submitDate) : undefined,
        source: "insurance",
        createInsurancePremiumPlan: options.createPremiumPlan,
        insurancePremiumBackfillPastRecords: options.backfillPastRecords,
      };

      const response = await fetch("/api/v1/transactions/detail", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; data?: { id?: string } } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || (isEdit ? "保存失败" : "记账失败"));
      }

      if (isEdit) {
        window.dispatchEvent(new CustomEvent("mmh:insurance:edit:success", { detail: { requestId } }));
      }
      setOpen(false);
      if (!isEdit) resetForm();
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({ reason: "insurance-save" });
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const shouldAskPremiumActions = mode !== "edit" && !editEntryId && subtype === "buy";
    const preview = shouldAskPremiumActions ? getPremiumPlanPreview() : null;
    if (preview) {
      setPendingPlanData(preview);
      setConfirmBatchGenerate(preview.historyCount > 0);
      setShowConfirmDialog(true);
      return;
    }

    await submitInsurance({ createPremiumPlan: false, backfillPastRecords: false });
  }

  if (!open || typeof document === "undefined") return null;

  const isRedeem = subtype === "redeem";
  const isEditingRecord = mode === "edit" || !!editEntryId;

  return createPortal(
    <>
      <div className="app-modal-backdrop z-[1000]">
        <div className="app-modal-panel max-w-[min(42rem,calc(100vw-1rem))]">
          <div className="modal-header">
            <div className="text-sm font-semibold text-slate-800">
              {isEditingRecord ? "编辑保单" : "新增保单"}
              <span className="ml-2 text-xs font-normal text-slate-500">保险</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (mode === "create") resetForm();
              }}
              className="secondary-button h-8 px-2"
            >
              关闭
            </button>
          </div>

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
              {/* 投保 / 退保 切换 */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSubtype("buy")}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "buy" ? "segment-button-active font-medium" : ""}`}
                >
                  投保
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSubtype("redeem");
                    if (!arrivalDateTouchedRef.current) setArrivalDate(date);
                  }}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "redeem" ? "segment-button-active font-medium" : ""}`}
                >
                  退保
                </button>
              </div>

              {isRedeem ? (
                /* ========== 退保模式 ========== */
                <>
                  <div className="space-y-1">
                    <div className="form-label">保单</div>
                    <SmartSelect
                      mode="single"
                      value={insuranceProductId}
                      onChange={(id) => {
                        setInsuranceProductId(id);
                        setLastAppliedProductId("");
                      }}
                      options={filteredInsuranceProductOptions}
                      placeholder="选择已有保单"
                      behavior={{ hierarchy: false, search: "auto", clearable: false }}
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">资金退回账户</div>
                    <SmartSelect
                      mode="single"
                      value={cashAccountId}
                      onChange={setCashAccountId}
                      options={cashFiltered ?? cashAccountList}
                      placeholder="选择账户"
                      behavior={{
                        hierarchy: false,
                        search: "auto",
                        clearable: false,
                        headerExtra: cashOwnerCycleButton,
                        create: {
                          type: "button",
                          onClick: () => setNestedEntityType("cash-account"),
                          label: "+",
                        },
                      }}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <div className="form-label">退保日期</div>
                      <DateStepper
                        value={date}
                        onChange={changeDate}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">到账日期</div>
                      <DateStepper
                        value={arrivalDate}
                        onChange={changeArrivalDate}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">退保金额</div>
                      <CalcInput
                        value={amount}
                        onChange={setAmount}
                        placeholder="0.00"
                        label="退保"
                        precision={2}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      value={memo}
                      onChange={(event) => setMemo(event.target.value)}
                      placeholder="可选"
                      className="form-input"
                    />
                  </div>
                </>
              ) : (
                /* ========== 投保模式 ========== */
                <>
                  {/* 1. 投保人 + 2. 资金账户 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">投保人</div>
                      <SmartSelect
                        mode="single"
                        value={policyholderPersonId}
                        onChange={(id) => {
                          setPolicyholderPersonId(id);
                          setCashAccountId("");
                        }}
                        options={familyMemberOptions}
                        placeholder="选择投保人"
                        behavior={{
                          hierarchy: false,
                          search: "auto",
                          clearable: false,
                          create: {
                            type: "button",
                            onClick: () => setNestedEntityType("family-member"),
                            label: "+",
                          },
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">资金来源账户</div>
                      <SmartSelect
                        mode="single"
                        value={cashAccountId}
                        onChange={setCashAccountId}
                        options={cashFiltered ?? cashListForPolicyholder}
                        placeholder={policyholderPersonId ? "选择账户" : "先选择投保人"}
                        behavior={{
                          hierarchy: false,
                          search: "auto",
                          clearable: false,
                          headerExtra: cashOwnerCycleButton,
                          create: {
                            type: "button",
                            onClick: () => setNestedEntityType("cash-account"),
                            label: "+",
                          },
                        }}
                      />
                    </div>
                  </div>

                  {/* 3. 保险产品 */}
                  <div className="space-y-1">
                    <div className="form-label">保险产品</div>
                    <SmartSelect
                      mode="single"
                      value={insuranceProductId}
                      onChange={(id) => {
                        setInsuranceProductId(id);
                        setLastAppliedProductId("");
                      }}
                      options={filteredInsuranceProductOptions}
                      placeholder="选择保险产品"
                      behavior={{
                        hierarchy: false,
                        search: "auto",
                        clearable: false,
                        create: {
                          type: "button",
                          onClick: () => setShowNewProductModal(true),
                          label: "+",
                        },
                      }}
                    />
                  </div>

                  {/* 4. 被保险人 + 5. 受益人 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">被保险人</div>
                      <SmartSelect
                        mode="single"
                        value={insuredPersonId}
                        onChange={setInsuredPersonId}
                        options={familyMemberOptions}
                        placeholder="选择被保险人"
                        behavior={{
                          hierarchy: false,
                          search: "auto",
                          clearable: true,
                          create: {
                            type: "button",
                            onClick: () => setNestedEntityType("family-member"),
                            label: "+",
                          },
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">受益人</div>
                      <SmartSelect
                        mode="single"
                        value={beneficiaryPersonId}
                        onChange={setBeneficiaryPersonId}
                        options={familyMemberOptions}
                        placeholder="选择受益人"
                        behavior={{
                          hierarchy: false,
                          search: "auto",
                          clearable: true,
                          create: {
                            type: "button",
                            onClick: () => setNestedEntityType("family-member"),
                            label: "+",
                          },
                        }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">保单号</div>
                      <input
                        value={policyNo}
                        onChange={(event) => setPolicyNo(event.target.value)}
                        placeholder="可选"
                        className="form-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">交款方式</div>
                      <select
                        value={premiumFrequencyMonths}
                        onChange={(event) => setPremiumFrequencyMonths(event.target.value)}
                        className="form-input"
                        title="交款方式"
                        aria-label="交款方式"
                      >
                        {PAYMENT_MODE_OPTIONS.map((item) => (
                          <option key={item.value} value={String(item.value)}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">缴费期限（年）</div>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={isAnnualPayment ? paymentTermYears : ""}
                        onChange={(event) => setPaymentTermYears(event.target.value)}
                        min={2}
                        max={30}
                        placeholder={isAnnualPayment ? "2-30" : "锁定"}
                        disabled={isSinglePayment}
                        className="form-input disabled:bg-slate-100 disabled:text-slate-400"
                      />
                    </div>
                  </div>

                  {/* 7. 初次购买日期 + 投保金额 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">初次购买日期</div>
                      <DateStepper
                        value={productStartDate}
                        onChange={(value) => {
                          setProductStartDate(value);
                          setProductStartDateTouched(true);
                          if (!productStartDateTouched) setDate(value);
                        }}
                        className="form-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">投保金额</div>
                      <CalcInput
                        value={amount}
                        onChange={setAmount}
                        placeholder="0.00"
                        label="投保"
                        precision={2}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">保额</div>
                      <CalcInput
                        value={coverageAmount}
                        onChange={setCoverageAmount}
                        placeholder="0.00"
                        label="保额"
                        precision={2}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">保障期限（年）</div>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={coverageTermYears}
                        onChange={(event) => setCoverageTermYears(event.target.value)}
                        min={1}
                        max={30}
                        placeholder="1-30"
                        className="form-input"
                      />
                    </div>
                  </div>

                  {/* 9. 备注 */}
                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      value={memo}
                      onChange={(event) => setMemo(event.target.value)}
                      placeholder="可选"
                      className="form-input"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="shrink-0 border-t border-slate-100 bg-white/95 px-3 py-3 sm:px-4">
              <div className="flex justify-end gap-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : "primary-button"}`}
                >
                  {submitting ? "保存中..." : isEditingRecord ? "保存修改" : isRedeem ? "记账（退保）" : "记账（投保）"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* Nested modals */}
      {nestedEntityType === "cash-account" && (
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name) => {
            const option = { id, label: name, subLabel: kindLabel("bank_debit") };
            setCashAccountList((prev) => [...prev, option]);
            setLocalCashSSOpts((prev) => (prev ? [...prev, option] : prev));
            setCashAccountId(id);
            setNestedEntityType(null);
          }}
          extraFields={{ kind: "bank_debit" }}
          hiddenFields={["kind"]}
          nestedFieldData={nestedFieldData}
        />
      )}

      {nestedEntityType === "family-member" && (
        <NestedAddModal
          mode="compact"
          entityType="institution"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name) => {
            const option = { id, label: name, subLabel: "家庭成员" };
            setFamilyMemberOptions((prev) => [...prev, option]);
            setNestedEntityType(null);
          }}
          extraFields={{ type: "family_member" }}
          hiddenFields={["type"]}
          nestedFieldData={nestedFieldData}
        />
      )}

      {/* 新增保险产品母体弹窗 */}
      {showNewProductModal && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">新增保险产品</div>
              <button
                type="button"
                onClick={() => {
                  setShowNewProductModal(false);
                  setNewProductInstitutionId("");
                  setNewProductName("");
                  setNewProductLookupCandidates([]);
                  setNewProductSelectedCandidate(-1);
                  setNewProductLookupError("");
                }}
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                关闭
              </button>
            </div>
            <div className="space-y-3 p-4">
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">承保机构</div>
                <select
                  value={newProductInstitutionId}
                  onChange={(event) => setNewProductInstitutionId(event.target.value)}
                  className="form-input bg-white"
                >
                  <option value="">选择机构</option>
                  {institutionOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}{item.subLabel && item.subLabel !== "保险公司" ? ` (${item.subLabel})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-slate-600">产品名称</div>
                  <button
                    type="button"
                    onClick={handleNewProductLookup}
                    disabled={newProductLookupLoading || !newProductName.trim() || !newProductInstitutionId}
                    className="text-[11px] text-blue-600 hover:text-blue-700 disabled:text-slate-300"
                  >
                    {newProductLookupLoading ? "查询中..." : "查询"}
                  </button>
                </div>
                <input
                  value={newProductName}
                  onChange={(event) => {
                    setNewProductName(event.target.value);
                    setNewProductLookupError("");
                    setNewProductLookupCandidates([]);
                    setNewProductSelectedCandidate(-1);
                  }}
                  placeholder="例如：平安福满分"
                  className="form-input bg-white"
                />
              </div>

              {newProductLookupError && (
                <div className="text-[11px] text-rose-600">{newProductLookupError}</div>
              )}

              {newProductLookupCandidates.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    查询结果 ({newProductLookupCandidates.length})
                  </div>
                  <div className="max-h-40 overflow-auto rounded-md border border-slate-200">
                    {newProductLookupCandidates.map((candidate, index) => (
                      <label
                        key={`${candidate.name}-${candidate.institutionName}-${index}`}
                        className={`flex cursor-pointer items-start gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50 ${
                          newProductSelectedCandidate === index ? "bg-blue-50" : ""
                        }`}
                      >
                        <input
                          type="radio"
                          name="lookupCandidate"
                          checked={newProductSelectedCandidate === index}
                          onChange={() => setNewProductSelectedCandidate(index)}
                          className="mt-0.5 accent-blue-600"
                        />
                        <div>
                          <div className="text-slate-800">{candidate.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {candidate.institutionName}
                            {candidate.productType ? ` · ${productTypeLabel(candidate.productType)}` : ""}
                            {candidate.status ? ` · ${candidate.status}` : ""}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setShowNewProductModal(false);
                    setNewProductInstitutionId("");
                    setNewProductName("");
                    setNewProductLookupCandidates([]);
                    setNewProductSelectedCandidate(-1);
                    setNewProductLookupError("");
                  }}
                  className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateProductMaster}
                  disabled={newProductSaving || !newProductName.trim() || !newProductInstitutionId}
                  className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {newProductSaving ? "保存中..." : "创建"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 确认弹窗：缴费计划固定生成，用户只确认是否补生成过往记录 */}
      {showConfirmDialog && pendingPlanData && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">缴费计划确认</div>
            </div>
            <div className="space-y-4 p-4">
              <div className="text-sm text-slate-600">
                初次购买日期为 <span className="font-semibold text-slate-800">{productStartDate}</span>，
                本次应补齐到 <span className="font-semibold text-slate-800">{pendingPlanData.currentRecordDate}</span>。
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
                将生成缴费计划：共 {pendingPlanData.totalRuns} 次，{pendingPlanData.frequencyLabel} {formatMoney(pendingPlanData.amount)}。
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmBatchGenerate}
                  onChange={(e) => setConfirmBatchGenerate(e.target.checked)}
                  disabled={pendingPlanData.dueCount <= 0}
                  className="h-4 w-4 accent-blue-600"
                />
                同时由计划任务批量生成已到期缴费记录（预计 {pendingPlanData.dueCount} 条，从 {pendingPlanData.planStartDate} 到 {pendingPlanData.currentRecordDate}）
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCancelConfirm}
                  className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50"
                >
                  返回修改
                </button>
                <button
                  type="button"
                  onClick={handleConfirmPlanAndBatch}
                  className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700"
                >
                  确认并保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
