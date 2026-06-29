"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { Repeat } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./TransactionFormModal";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";

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
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

type InsuranceProductOption = {
  id: string;
  label: string;
  subLabel?: string;
  accountId: string;
  accountLabel?: string;
  ownerGroupId?: string | null;
  ownerGroupName?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  institutionShortName?: string | null;
  productType?: string | null;
  accountingType?: string | null;
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

type InsuranceLookupReference = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

type InsuranceOfficialProductCandidate = {
  name: string;
  institutionName: string;
  status: string;
  saleDate: string | null;
  termsNo: string | null;
  source: string;
};

type InsuranceProductCandidate = {
  name: string;
  institutionName: string | null;
  productType: string | null;
  status: string | null;
  saleDate: string | null;
  termsNo: string | null;
  source: string;
  sourceType: "official" | "crawled" | "search";
  url: string | null;
  confidence: "low" | "medium" | "high";
  reason: string;
};

type InsuranceLookupData = {
  query: string;
  institutionName: string | null;
  candidates: InsuranceProductCandidate[];
  officialProducts: InsuranceOfficialProductCandidate[];
  officialSources: InsuranceLookupReference[];
  webResults: InsuranceLookupReference[];
  crawledPages: InsuranceLookupReference[];
  suggestion: {
    productType: string | null;
    institutionName: string | null;
    confidence: "low" | "medium" | "high";
    reason: string;
  };
  searchedAt: string;
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

const PREMIUM_FREQUENCY_OPTIONS = [
  { value: 1, label: "每月" },
  { value: 3, label: "每季" },
  { value: 6, label: "每半年" },
  { value: 12, label: "每年" },
  { value: 999999, label: "趸交" },
] as const;

type InsuranceStatusValue = "active" | "matured" | "surrendered" | "lapsed";

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

const PRODUCT_LOOKUP_TYPE_RULES: Array<{ productType: string; keywords: string[] }> = [
  { productType: "critical_illness", keywords: ["重疾", "重大疾病"] },
  { productType: "medical", keywords: ["医疗", "住院", "百万医疗"] },
  { productType: "accident", keywords: ["意外"] },
  { productType: "annuity", keywords: ["年金", "养老"] },
  { productType: "term_life", keywords: ["定期寿", "定寿"] },
  { productType: "whole_life", keywords: ["终身寿", "增额终身寿"] },
  { productType: "universal", keywords: ["万能"] },
  { productType: "investment_linked", keywords: ["投连", "投资连结"] },
  { productType: "dividend", keywords: ["分红"] },
  { productType: "savings", keywords: ["两全", "储蓄", "教育金"] },
];

function productTypeLabel(type?: string | null) {
  return PRODUCT_TYPE_OPTIONS.find((item) => item.value === type)?.label ?? "保险";
}

function inferProductTypeFromText(text: string) {
  return PRODUCT_LOOKUP_TYPE_RULES.find((rule) =>
    rule.keywords.some((keyword) => text.includes(keyword)),
  )?.productType ?? null;
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

function addMonthsClamped(date: Date, months: number) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const maxDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(date.getUTCDate(), maxDay));
  return next;
}

function buildMissingPremiumDates(startDate: string, currentDate: string, frequencyMonths: number | null) {
  if (!frequencyMonths || frequencyMonths <= 0 || frequencyMonths === 999999) return [];
  const start = parseDateOnly(startDate);
  const current = parseDateOnly(currentDate);
  if (!start || !current || start >= current) return [];

  const dates: string[] = [];
  let cursor = start;
  for (let guard = 0; guard < 600; guard += 1) {
    if (cursor >= current) break;
    dates.push(formatDateOnly(cursor));
    cursor = addMonthsClamped(cursor, frequencyMonths);
  }
  return dates;
}

function buildLookupCandidateNote(candidate?: InsuranceProductCandidate | null) {
  if (!candidate) return undefined;
  return [
    "公开保险产品资料：",
    `来源：${candidate.source}`,
    `来源类型：${candidate.sourceType === "official" ? "官方库" : candidate.sourceType === "crawled" ? "公开页面整理" : "搜索整理"}`,
    candidate.institutionName ? `承保机构：${candidate.institutionName}` : "",
    candidate.status ? `官方销售状态：${candidate.status}` : "",
    candidate.saleDate ? `发布日期：${candidate.saleDate}` : "",
    candidate.termsNo ? `条款号：${candidate.termsNo}` : "",
    candidate.url ? `核对地址：${candidate.url}` : "",
    `整理说明：${candidate.reason}`,
  ].filter(Boolean).join("\n");
}

function mapInsuranceProduct(item: any): InsuranceProductOption {
  return {
    id: String(item.id),
    label: String(item.name ?? ""),
    subLabel: [item.institutionShortName || item.institutionName, productTypeLabel(item.productType)].filter(Boolean).join(" · "),
    accountId: String(item.accountId ?? ""),
    accountLabel: String(item.accountName ?? ""),
    ownerGroupId: item.ownerGroupId ? String(item.ownerGroupId) : null,
    ownerGroupName: item.ownerGroupName ? String(item.ownerGroupName) : null,
    institutionId: item.institutionId ? String(item.institutionId) : null,
    institutionName: item.institutionName ? String(item.institutionName) : null,
    institutionShortName: item.institutionShortName ? String(item.institutionShortName) : null,
    productType: item.productType ? String(item.productType) : null,
    accountingType: item.accountingType ? String(item.accountingType) : null,
    insuredUserId: item.insuredUserId ? String(item.insuredUserId) : null,
    insuredUserName: item.insuredUserName ? String(item.insuredUserName) : null,
    beneficiaryName: item.beneficiaryName ? String(item.beneficiaryName) : null,
    premiumMode: item.premiumMode ? String(item.premiumMode) : null,
    premiumFrequencyMonths: item.premiumFrequencyMonths != null ? Number(item.premiumFrequencyMonths) : null,
    premiumAmount: item.premiumAmount != null ? Number(item.premiumAmount) : null,
    paymentTermYears: item.paymentTermYears != null ? Number(item.paymentTermYears) : null,
    coverageTermYears: item.coverageTermYears != null ? Number(item.coverageTermYears) : null,
    coverageAmount: item.coverageAmount != null ? Number(item.coverageAmount) : null,
    status: item.status ? String(item.status) : null,
    startDate: item.startDate ? String(item.startDate) : null,
    effectiveDate: item.effectiveDate ? String(item.effectiveDate) : null,
    maturityDate: item.maturityDate ? String(item.maturityDate) : null,
    cashValueEnabled: item.cashValueEnabled != null ? Boolean(item.cashValueEnabled) : null,
    note: item.note ? String(item.note) : null,
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
  insuranceAccountSSOptions?: SmartSelectOption[];
  ownerSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const initIsRedeem = mode === "edit" && entry ? entry.amount > 0 : false;
  const initAmount = mode === "edit" && entry ? String(Math.abs(entry.amount)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";
  const initCashAccountId =
    mode === "edit" && entry
      ? (initIsRedeem ? (entry.toAccountId ?? "") : (entry.accountId ?? ""))
      : "";

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<"buy" | "redeem">(initIsRedeem ? "redeem" : "buy");
  const [date, setDate] = useState(initDate);
  const [amount, setAmount] = useState(initAmount);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [memo, setMemo] = useState(initMemo);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [insuranceProductId, setInsuranceProductId] = useState(mode === "edit" ? (entry?.insuranceProductId ?? "") : "");
  const [productName, setProductName] = useState(mode === "edit" ? (entry?.fundName ?? "") : "");
  const [productType, setProductType] = useState("savings");
  const [institutionId, setInstitutionId] = useState("");
  const [ownerGroupId, setOwnerGroupId] = useState("");
  const [insuredUserId, setInsuredUserId] = useState("");
  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [premiumFrequencyMonths, setPremiumFrequencyMonths] = useState("12");
  const [productStartDate, setProductStartDate] = useState(initDate);
  const [paymentTermYears, setPaymentTermYears] = useState("");
  const [coverageTermYears, setCoverageTermYears] = useState("");
  const [coverageAmount, setCoverageAmount] = useState("");
  const [productStatus, setProductStatus] = useState<InsuranceStatusValue>("active");
  const [lastAppliedProductId, setLastAppliedProductId] = useState<string>("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [lookupData, setLookupData] = useState<InsuranceLookupData | null>(null);
  const [selectedLookupCandidate, setSelectedLookupCandidate] = useState<InsuranceProductCandidate | null>(null);

  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [insuranceProductOptions, setInsuranceProductOptions] = useState<InsuranceProductOption[]>([]);
  const [institutionOptions, setInstitutionOptions] = useState<OptionItem[]>([]);
  const [ownerOptions, setOwnerOptions] = useState<OptionItem[]>([]);
  const [userOptions, setUserOptions] = useState<OptionItem[]>([]);
  const [accountMetaById, setAccountMetaById] = useState<Record<string, AccountMeta>>({});
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "owner" | "institution" | null>(null);

  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashFiltered,
  } = useAccountSSFilter(localCashSSOpts);

  const cashOwnerCycleButton = localCashSSOpts?.some((option) => option.isHeader) ? (
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

  const selectedInsuranceProduct = useMemo(
    () => insuranceProductOptions.find((item) => item.id === insuranceProductId) ?? null,
    [insuranceProductId, insuranceProductOptions],
  );

  const filteredInsuranceProductOptions = useMemo<SmartSelectOption[]>(() => {
    return insuranceProductOptions
      .filter((item) => {
        if (subtype === "redeem") {
          if (ownerGroupId && item.ownerGroupId !== ownerGroupId) return false;
          if (institutionId && item.institutionId !== institutionId) return false;
        } else if (ownerGroupId && item.ownerGroupId !== ownerGroupId) {
          return false;
        }
        return true;
      })
      .map((item) => ({
        id: item.id,
        label: item.label,
        subLabel: item.subLabel,
      }));
  }, [insuranceProductOptions, institutionId, ownerGroupId, subtype]);

  const insuranceAccountLabel = useMemo(() => {
    if (selectedInsuranceProduct?.accountLabel?.trim()) return selectedInsuranceProduct.accountLabel.trim();
    if (selectedInsuranceProduct?.accountId) {
      const matched = accountMetaById[selectedInsuranceProduct.accountId];
      if (matched?.label) return matched.label;
    }
    const ownerLabel = ownerOptions.find((item) => item.id === ownerGroupId)?.label ?? "";
    const institution = institutionOptions.find((item) => item.id === institutionId)?.label ?? "";
    if (ownerLabel && institution) return `${ownerLabel}的${institution}`;
    const contextAccount = accountMetaById[defaultAccountId];
    if (contextAccount?.kind === "insurance") return contextAccount.label;
    return "";
  }, [accountMetaById, defaultAccountId, institutionId, institutionOptions, ownerGroupId, ownerOptions, selectedInsuranceProduct]);

  const selectedInstitutionLabel = useMemo(() => {
    const matched = institutionOptions.find((item) => item.id === institutionId);
    return matched?.subLabel && matched.subLabel !== "保险公司" ? matched.subLabel : matched?.label ?? "";
  }, [institutionId, institutionOptions]);

  function applyProductOption(product: InsuranceProductOption) {
    setInsuranceProductId(product.id);
    setSelectedLookupCandidate(null);
    setProductName(product.label);
    setProductType(product.productType ?? "savings");
    setInstitutionId(product.institutionId ?? "");
    setOwnerGroupId(product.ownerGroupId ?? "");
    setInsuredUserId(product.insuredUserId ?? "");
    setBeneficiaryName(product.beneficiaryName ?? "");
    setPremiumFrequencyMonths(
      product.premiumFrequencyMonths != null ? String(product.premiumFrequencyMonths) : "12",
    );
    setProductStartDate(product.startDate || product.effectiveDate || date);
    setPaymentTermYears(
      product.paymentTermYears != null ? String(product.paymentTermYears) : "",
    );
    setCoverageTermYears(
      product.coverageTermYears != null ? String(product.coverageTermYears) : "",
    );
    setCoverageAmount(
      product.coverageAmount != null ? String(product.coverageAmount) : "",
    );
    setProductStatus((product.status as InsuranceStatusValue) || "active");
    setLastAppliedProductId(product.id);
  }

  function clearProductSelection() {
    setInsuranceProductId("");
    setLastAppliedProductId("");
    setSelectedLookupCandidate(null);
  }

  function findInstitutionByLookupName(name?: string | null) {
    const normalized = String(name ?? "").replace(/\s+/g, "");
    if (!normalized) return null;
    return institutionOptions.find((item) => {
      const label = item.label.replace(/\s+/g, "");
      const subLabel = String(item.subLabel ?? "").replace(/\s+/g, "");
      return (
        normalized.includes(label) ||
        label.includes(normalized) ||
        (subLabel && normalized.includes(subLabel)) ||
        (subLabel && subLabel.includes(normalized))
      );
    }) ?? null;
  }

  async function lookupProductInfo() {
    const trimmedProductName = productName.trim();
    if (!institutionId) {
      window.alert("请先选择承保机构");
      return;
    }
    if (!trimmedProductName) {
      window.alert("请先输入保险名称");
      return;
    }

    setLookupLoading(true);
    setLookupError("");
    try {
      const params = new URLSearchParams({ name: trimmedProductName });
      if (selectedInstitutionLabel) params.set("institutionName", selectedInstitutionLabel);
      const response = await fetch(`/api/v1/insurance-products/lookup?${params.toString()}`, {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; data?: InsuranceLookupData }
        | null;
      if (!response.ok || !data?.ok || !data.data) {
        throw new Error(data?.error || "查询保险产品资料失败");
      }
      setLookupData(data.data);
      if (data.data.candidates.length === 1) {
        applyProductCandidate(data.data.candidates[0], data.data.suggestion);
      } else if (data.data.candidates.length === 0) {
        setSelectedLookupCandidate(null);
        setLookupError("没有整理出可直接套用的产品候选");
      } else {
        setSelectedLookupCandidate(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "查询保险产品资料失败";
      setLookupError(message);
      setLookupData(null);
    } finally {
      setLookupLoading(false);
    }
  }

  function applyProductCandidate(candidate: InsuranceProductCandidate, suggestion?: InsuranceLookupData["suggestion"]) {
    setInsuranceProductId("");
    setLastAppliedProductId("");
    setSelectedLookupCandidate(candidate);
    setProductName(candidate.name);
    const inferredType = candidate.productType ?? inferProductTypeFromText(candidate.name);
    if (inferredType) {
      setProductType(inferredType);
    } else if (suggestion?.productType || lookupData?.suggestion.productType) {
      setProductType(suggestion?.productType ?? lookupData?.suggestion.productType ?? "other");
    }
    const matchedInstitution = findInstitutionByLookupName(candidate.institutionName);
    if (matchedInstitution) {
      setInstitutionId(matchedInstitution.id);
    }
    setLookupError("");
  }

  function resetForm(defaults?: { requestId?: string | null; defaultCashAccountId?: string; defaultInsuranceAccountId?: string }) {
    const contextAccount = defaults?.defaultInsuranceAccountId
      ? accountMetaById[defaults.defaultInsuranceAccountId]
      : accountMetaById[defaultAccountId];
    const inferredOwnerId =
      contextAccount?.kind === "insurance" ? (contextAccount.groupId ?? "") : "";
    const inferredInstitutionId =
      contextAccount?.kind === "insurance" ? (contextAccount.institutionId ?? "") : "";

    setSubtype("buy");
    setDate(today);
    setAmount("");
    setCashAccountId(defaults?.defaultCashAccountId ?? "");
    setMemo("");
    setRequestId(defaults?.requestId ?? null);
    setEditEntryId(null);
    setInsuranceProductId("");
    setProductName("");
    setProductType("savings");
    setInstitutionId(inferredInstitutionId);
    setOwnerGroupId(inferredOwnerId);
    setInsuredUserId("");
    setBeneficiaryName("");
    setPremiumFrequencyMonths("12");
    setProductStartDate(today);
    setPaymentTermYears("");
    setCoverageTermYears("");
    setCoverageAmount("");
    setProductStatus("active");
    setLastAppliedProductId("");
    setLookupData(null);
    setLookupError("");
    setSelectedLookupCandidate(null);
  }

  useEffect(() => setCashAccountList(cashAccounts), [cashAccounts]);
  useEffect(() => setLocalCashSSOpts(cashAccountSSOptions), [cashAccountSSOptions]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/v1/insurance-products", { cache: "no-store" }).then((res) => res.json()).catch(() => null),
      fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).then((res) => res.json()).catch(() => null),
    ]).then(([productsData, accountsData]) => {
      if (cancelled) return;

      if (productsData?.ok && Array.isArray(productsData.products)) {
        setInsuranceProductOptions(productsData.products.map(mapInsuranceProduct));
      }

      if (Array.isArray(accountsData?.institutions)) {
        setInstitutionOptions(
          accountsData.institutions
            .filter((item: any) => item?.type === "insurance")
            .map((item: any) => ({
              id: String(item.id),
              label: String(item.shortName || item.name || ""),
              subLabel: item.shortName ? String(item.name ?? "") : "保险公司",
            })),
        );
      }

      if (Array.isArray(accountsData?.groups)) {
        setOwnerOptions(
          accountsData.groups.map((item: any) => ({
            id: String(item.id),
            label: String(item.name ?? ""),
            subLabel: "投保人",
          })),
        );
      }

      if (Array.isArray(accountsData?.users)) {
        setUserOptions(
          accountsData.users.map((item: any) => ({
            id: String(item.id),
            label: String(item.name ?? ""),
            subLabel: "被保险人",
          })),
        );
      }

      if (Array.isArray(accountsData?.accounts)) {
        const meta: Record<string, AccountMeta> = {};
        for (const item of accountsData.accounts) {
          const label = String(item.name ?? "");
          meta[String(item.id)] = {
            id: String(item.id),
            name: String(item.name ?? ""),
            kind: item.kind ? String(item.kind) : null,
            label,
            groupId: item.groupId ? String(item.groupId) : null,
            groupName: item.AccountGroup?.name ? String(item.AccountGroup.name) : null,
            institutionId: item.institutionId ? String(item.institutionId) : null,
            institutionName: item.Institution?.name ? String(item.Institution.name) : null,
            institutionShortName: item.Institution?.shortName ? String(item.Institution.shortName) : null,
          };
        }
        setAccountMetaById(meta);
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!insuranceProductId || insuranceProductId === lastAppliedProductId) return;
    const matched = insuranceProductOptions.find((item) => item.id === insuranceProductId);
    if (matched) applyProductOption(matched);
  }, [insuranceProductId, insuranceProductOptions, lastAppliedProductId]);

  useEffect(() => {
    function onEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        date: string;
        amount: number;
        note: string;
        accountId?: string;
        cashAccountId?: string;
        toAccountId?: string;
        fundName?: string;
        fundSubtype?: string;
        insuranceProductId?: string | null;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;

      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setSubtype(detail.fundSubtype === "redeem" ? "redeem" : "buy");
      setDate(detail.date || today);
      setAmount(detail.amount > 0 ? String(detail.amount) : "");
      setMemo(detail.note ?? "");
      setProductStartDate(detail.date || today);
      setCashAccountId(
        detail.cashAccountId ??
          (detail.fundSubtype === "redeem" ? (detail.toAccountId ?? "") : (detail.accountId ?? "")),
      );
      setProductName(detail.fundName ?? "");
      setInsuranceProductId(detail.insuranceProductId ?? "");
      setLastAppliedProductId("");
      setOpen(true);
    }

    window.addEventListener("mmh:insurance:edit", onEdit as EventListener);
    return () => window.removeEventListener("mmh:insurance:edit", onEdit as EventListener);
  }, [today]);

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

  async function ensureInsuranceProduct() {
    const trimmedProductName = productName.trim();
    if (!trimmedProductName) throw new Error("请输入保险名称");
    if (!ownerGroupId) throw new Error("请选择投保人");
    let finalInstitutionId = institutionId;
    if (selectedLookupCandidate?.institutionName) {
      const matchedInstitution = findInstitutionByLookupName(selectedLookupCandidate.institutionName);
      if (matchedInstitution) {
        finalInstitutionId = matchedInstitution.id;
        if (matchedInstitution.id !== institutionId) setInstitutionId(matchedInstitution.id);
      } else if (!insuranceProductId) {
        const response = await fetch("/api/v1/institution", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: selectedLookupCandidate.institutionName,
            shortName: selectedLookupCandidate.institutionName.replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司/g, ""),
            type: "insurance",
          }),
        });
        const data = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; institution?: { id?: string; name?: string; shortName?: string | null } }
          | null;
        if (!response.ok || !data?.ok || !data.institution?.id) {
          throw new Error(data?.error || "创建承保机构失败");
        }
        const option = {
          id: String(data.institution.id),
          label: String(data.institution.shortName || data.institution.name || ""),
          subLabel: data.institution.shortName ? String(data.institution.name ?? "") : "保险公司",
        };
        setInstitutionOptions((prev) => [...prev, option]);
        finalInstitutionId = option.id;
        setInstitutionId(option.id);
      }
    }
    if (!finalInstitutionId) throw new Error("请选择承保机构");

    const premiumFrequencyValue = parseOptionalNumber(premiumFrequencyMonths);
    const accountingType = accountingTypeForProductType(productType);
    const lookupNote = buildLookupCandidateNote(selectedLookupCandidate);
    const payload = {
      id: insuranceProductId || undefined,
      name: trimmedProductName,
      productType,
      accountingType,
      ownerGroupId,
      institutionId: finalInstitutionId,
      insuredUserId: insuredUserId || undefined,
      beneficiaryName: beneficiaryName.trim() || undefined,
      premiumMode: inferPremiumMode(premiumFrequencyValue),
      premiumFrequencyMonths: premiumFrequencyValue,
      premiumAmount: parseOptionalNumber(amount),
      paymentTermYears: parseOptionalNumber(paymentTermYears),
      coverageTermYears: parseOptionalNumber(coverageTermYears),
      coverageAmount: parseOptionalNumber(coverageAmount),
      status: productStatus,
      startDate: productStartDate || date,
      effectiveDate: selectedInsuranceProduct?.effectiveDate ?? (productStartDate || date),
      maturityDate: selectedInsuranceProduct?.maturityDate ?? undefined,
      cashValueEnabled:
        selectedInsuranceProduct?.cashValueEnabled ?? (accountingType !== "protection"),
      note: selectedInsuranceProduct?.note ?? lookupNote,
    };

    const response = await fetch("/api/v1/insurance-products", {
      method: insuranceProductId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; insuranceProduct?: any }
      | null;
    if (!response.ok || !data?.ok || !data.insuranceProduct) {
      throw new Error(data?.error || (insuranceProductId ? "更新保险产品失败" : "创建保险产品失败"));
    }

    const mapped = mapInsuranceProduct(data.insuranceProduct);
    setInsuranceProductOptions((prev) => {
      const existed = prev.some((item) => item.id === mapped.id);
      if (existed) return prev.map((item) => (item.id === mapped.id ? mapped : item));
      return [...prev, mapped];
    });
    applyProductOption(mapped);
    return mapped;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const amountValue = parseOptionalNumber(amount);
    if (amountValue == null || amountValue <= 0) {
      window.alert("请输入正确金额");
      return;
    }
    if (!cashAccountId) {
      window.alert(subtype === "redeem" ? "请选择到账账户" : "请选择资金来源账户");
      return;
    }
    if (subtype === "redeem" && !insuranceProductId) {
      window.alert("请选择保险产品");
      return;
    }

    const entryId = entry?.id || editEntryId || "";
    const isEdit = !!entryId;
    const creatingNewInsuranceProduct = subtype === "buy" && !insuranceProductId;

    setSubmitting(true);
    try {
      const product =
        subtype === "buy" || insuranceProductId
          ? await ensureInsuranceProduct()
          : selectedInsuranceProduct;

      if (!product?.id) {
        throw new Error("保险产品未创建成功");
      }

      const payload = {
        id: isEdit ? entryId : undefined,
        type: "investment",
        date,
        amount: amountValue,
        note: memo,
        cashAccountId,
        ownerGroupId: product.ownerGroupId || ownerGroupId,
        accountId: product.accountId || undefined,
        fundName: product.label,
        insuranceProductId: product.id,
        fundProductType: "wealth",
        fundSubtype: subtype,
        source: "insurance",
      };

      const response = await fetch("/api/v1/transactions/detail", {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || (isEdit ? "保存失败" : "记账失败"));
      }

      if (!isEdit && creatingNewInsuranceProduct) {
        const missingPremiumDates = buildMissingPremiumDates(
          productStartDate || date,
          date,
          parseOptionalNumber(premiumFrequencyMonths),
        );
        if (missingPremiumDates.length > 0) {
          if (missingPremiumDates.length > 120) {
            window.alert(`从 ${missingPremiumDates[0]} 到 ${date} 共有 ${missingPremiumDates.length} 期历史投保记录，数量较多，请使用批量导入或分段补录。`);
          } else if (window.confirm(`初次投保日早于本次记录至少一个缴费周期。是否按${premiumFrequencyMonths === "12" ? "每年" : `${premiumFrequencyMonths}个月`}补生成 ${missingPremiumDates.length} 条历史投保记录？\n\n范围：${missingPremiumDates[0]} 至 ${missingPremiumDates[missingPremiumDates.length - 1]}`)) {
            for (const premiumDate of missingPremiumDates) {
              const backfillResponse = await fetch("/api/v1/transactions/detail", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ...payload,
                  id: undefined,
                  date: premiumDate,
                  note: memo ? `${memo}（历史投保）` : "历史投保",
                }),
              });
              const backfillData = (await backfillResponse.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
              if (!backfillResponse.ok || !backfillData?.ok) {
                throw new Error(backfillData?.error || `生成 ${premiumDate} 历史投保记录失败`);
              }
            }
          }
        }
      }

      if (isEdit) {
        window.dispatchEvent(new CustomEvent("mmh:insurance:edit:success", { detail: { requestId } }));
      }
      setOpen(false);
      if (!isEdit) resetForm();
      requestAnimationFrame(() => window.dispatchEvent(new Event("mmh:fund:refresh")));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  const isRedeem = subtype === "redeem";
  const isEditingRecord = mode === "edit" || !!editEntryId;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1000] flex items-stretch justify-center overflow-hidden bg-slate-950/28 p-2 backdrop-blur-[2px] sm:items-center sm:p-4">
        <div className="modal-surface flex h-full w-full max-w-[min(42rem,calc(100vw-1rem))] flex-col overflow-hidden sm:h-auto sm:max-h-[calc(100dvh-2rem)]">
          <div className="modal-header">
            <div className="text-sm font-semibold text-slate-800">
              {isEditingRecord ? "编辑保险记录" : "新增保险记录"}
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
                onClick={() => setSubtype("redeem")}
                className={`segment-button h-8 flex-1 text-xs ${subtype === "redeem" ? "segment-button-active font-medium" : ""}`}
              >
                赎回
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">日期</div>
                <DateStepper value={date} onChange={setDate} />
              </div>
              <div className="space-y-1">
                <div className="form-label">{isRedeem ? "赎回金额" : "保费金额"}</div>
                <CalcInput
                  value={amount}
                  onChange={setAmount}
                  placeholder="0.00"
                  label={isRedeem ? "赎回" : "保费"}
                  precision={2}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">投保人</div>
                <SmartSelect
                  mode="single"
                  value={ownerGroupId}
                  onChange={(id) => setOwnerGroupId(id)}
                  options={ownerOptions}
                  placeholder="选择投保人"
                  behavior={{
                    hierarchy: false,
                    search: "auto",
                    clearable: false,
                    create: {
                      type: "button",
                      onClick: () => setNestedEntityType("owner"),
                      label: "+",
                    },
                  }}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">承保机构</div>
                <SmartSelect
                  mode="single"
                  value={institutionId}
                  onChange={(id) => {
                    setInstitutionId(id);
                    setLookupData(null);
                    setLookupError("");
                  }}
                  options={institutionOptions}
                  placeholder="先选择保险公司，再查询产品"
                  behavior={{
                    hierarchy: false,
                    search: "auto",
                    clearable: false,
                    create: {
                      type: "button",
                      onClick: () => setNestedEntityType("institution"),
                      label: "+",
                    },
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">被保险人</div>
                <SmartSelect
                  mode="single"
                  value={insuredUserId}
                  onChange={setInsuredUserId}
                  options={userOptions}
                  placeholder="选择被保险人"
                  behavior={{ hierarchy: false, search: "auto", clearable: false }}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">受益人</div>
                <input
                  value={beneficiaryName}
                  onChange={(event) => setBeneficiaryName(event.target.value)}
                  placeholder="可选"
                  className="form-input"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="form-label">保险产品</div>
                {insuranceProductId && subtype === "buy" ? (
                  <button
                    type="button"
                    onClick={clearProductSelection}
                    className="text-[11px] text-blue-600 hover:text-blue-700"
                  >
                    改为新产品
                  </button>
                ) : null}
              </div>
              <SmartSelect
                mode="single"
                value={insuranceProductId}
                onChange={(id) => {
                  setInsuranceProductId(id);
                  setLastAppliedProductId("");
                }}
                options={filteredInsuranceProductOptions}
                placeholder={isRedeem ? "选择保险产品" : "可先选择已有产品，也可直接填写下方信息"}
                behavior={{ hierarchy: false, search: "auto", clearable: false }}
              />
              <div className="text-[11px] text-slate-400">
                {isRedeem ? "赎回必须关联到一份已有保险产品。" : "不选也可以，保存时会自动创建保险产品和保险账户。"}
              </div>
            </div>

            <div className="ml-3 border-l border-slate-200 pl-3">
              <div className="rounded-lg bg-slate-50/70 p-3">
                <div className="mb-2 text-[11px] text-slate-500">
                  承保机构：{selectedInstitutionLabel || "请先选择承保机构"}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="form-label">保险名称</div>
                      <button
                        type="button"
                        onClick={lookupProductInfo}
                        disabled={lookupLoading || !productName.trim() || !institutionId}
                        className="text-[11px] text-blue-600 hover:text-blue-700 disabled:text-slate-300"
                      >
                        {lookupLoading ? "查询中..." : "查询"}
                      </button>
                    </div>
                    <input
                      value={productName}
                      onChange={(event) => {
                        setProductName(event.target.value);
                        setLookupError("");
                        setLookupData(null);
                        setSelectedLookupCandidate(null);
                        setInsuranceProductId("");
                        setLastAppliedProductId("");
                      }}
                      placeholder="例如：平安福满分"
                      className="form-input bg-white"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">产品类型</div>
                    <select
                      value={productType}
                      onChange={(event) => setProductType(event.target.value)}
                      className="form-input bg-white"
                      title="产品类型"
                      aria-label="产品类型"
                    >
                      {PRODUCT_TYPE_OPTIONS.map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {lookupData?.candidates.length && lookupData.candidates.length > 1 ? (
                  <div className="mt-2 grid grid-cols-[88px_1fr] items-center gap-2 text-xs">
                    <div className="text-[11px] text-slate-500">查询候选</div>
                    <select
                      value=""
                      onChange={(event) => {
                        const candidate = lookupData.candidates[Number(event.target.value)];
                        if (candidate) applyProductCandidate(candidate, lookupData.suggestion);
                      }}
                      className="form-input h-8 bg-white text-xs"
                      title="查询候选"
                      aria-label="查询候选"
                    >
                      <option value="">选择一个匹配产品</option>
                      {lookupData.candidates.map((item, index) => (
                        <option key={`${item.termsNo ?? item.name}-${item.institutionName}`} value={index}>
                          {item.name} · {item.institutionName || "未知保险公司"} · {item.productType ? productTypeLabel(item.productType) : "未识别类型"}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {selectedLookupCandidate ? (
                  <div className="mt-2 text-[11px] text-slate-500">
                    已套用：{selectedLookupCandidate.institutionName || selectedInstitutionLabel || "未知保险公司"} · {selectedLookupCandidate.status || "状态未识别"}
                    {selectedLookupCandidate.saleDate ? ` · ${selectedLookupCandidate.saleDate}` : ""}
                    {selectedLookupCandidate.termsNo ? ` · 条款号 ${selectedLookupCandidate.termsNo}` : ""}
                  </div>
                ) : null}
                {lookupError ? (
                  <div className="mt-2 text-[11px] text-rose-600">{lookupError}</div>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="space-y-1">
                <div className="form-label">初次投保</div>
                <input
                  type="date"
                  value={productStartDate}
                  onChange={(event) => setProductStartDate(event.target.value)}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">缴费频率</div>
                <select
                  value={premiumFrequencyMonths}
                  onChange={(event) => setPremiumFrequencyMonths(event.target.value)}
                  className="form-input"
                  title="缴费频率"
                  aria-label="缴费频率"
                >
                  {PREMIUM_FREQUENCY_OPTIONS.map((item) => (
                    <option key={item.value} value={String(item.value)}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">缴费年限</div>
                <input
                  inputMode="decimal"
                  value={paymentTermYears}
                  onChange={(event) => setPaymentTermYears(event.target.value)}
                  placeholder="例如：20"
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">保障年限</div>
                <input
                  inputMode="decimal"
                  value={coverageTermYears}
                  onChange={(event) => setCoverageTermYears(event.target.value)}
                  placeholder="例如：30"
                  className="form-input"
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
                <div className="form-label">{isRedeem ? "到账账户" : "资金来源账户"}</div>
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
            </div>

            <div className="space-y-1">
              <div className="form-label">保险账户</div>
              <div className="form-input flex h-9 items-center text-sm text-slate-600">
                {insuranceAccountLabel || "保存时按投保人和承保机构自动生成"}
              </div>
              <div className="text-[11px] text-slate-400">
                保险账户按“投保人 + 承保机构”自动归档，不需要你手动挑其他账户类型。
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

            </div>

            <div className="shrink-0 border-t border-slate-100 bg-white/95 px-3 py-3 sm:px-4">
              <div className="flex justify-end gap-2">
              <button
                type="submit"
                disabled={submitting}
                className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : "primary-button"}`}
              >
                {submitting ? "保存中..." : isEditingRecord ? "保存修改" : isRedeem ? "记账（赎回）" : "记账（投保）"}
              </button>
              </div>
            </div>
          </form>
        </div>
      </div>

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

      {nestedEntityType === "owner" && (
        <NestedAddModal
          mode="compact"
          entityType="group"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name) => {
            const option = { id, label: name, subLabel: "投保人" };
            setOwnerOptions((prev) => [...prev, option]);
            setOwnerGroupId(id);
            setNestedEntityType(null);
          }}
          nestedFieldData={nestedFieldData}
        />
      )}

      {nestedEntityType === "institution" && (
        <NestedAddModal
          mode="compact"
          entityType="institution"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name) => {
            const option = { id, label: name, subLabel: "保险公司" };
            setInstitutionOptions((prev) => [...prev, option]);
            setInstitutionId(id);
            setNestedEntityType(null);
          }}
          extraFields={{ type: "insurance" }}
          hiddenFields={["type"]}
          nestedFieldData={nestedFieldData}
        />
      )}
    </>,
    document.body,
  );
}
