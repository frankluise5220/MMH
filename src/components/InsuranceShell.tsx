"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Pencil, Shield, Trash2 } from "lucide-react";

import { formatMoney } from "@/lib/format";
import {
  AdvancedDataTable,
  type AdvancedDataTableColumn,
  type AdvancedDataTableSummaryRow,
} from "./AdvancedDataTable";
import { EntryRowActions } from "./EntryRowActions";
import {
  InsurancePolicyEditModal,
  type InsurancePolicyEditMeta,
  type InsurancePolicyEditValue,
} from "./InsurancePolicyEditModal";
import {
  InsuranceProductEditModal,
  type InsuranceProductEditInstitution,
  type InsuranceProductEditOption,
  type InsuranceProductEditValue,
} from "./InsuranceProductEditModal";
import { InsuranceEntryEditModal } from "./InsuranceEntryEditModal";
import { InsurancePolicyDeleteModal } from "./InsurancePolicyDeleteModal";
import type { SmartSelectOption } from "./SmartSelect";

type InsuranceEntry = {
  id: string;
  date: string;
  typeLabel: string;
  productName: string;
  cashAccountLabel: string;
  cashAccountId: string | null;
  note: string;
  amount: number;
  coverageAmount: number | null;
  paymentTermYears: number | null;
  edit?: {
    type: "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    cashAccountId?: string;
    insuranceProductId?: string | null;
    fundName?: string;
    fundProductType?: string;
    fundSubtype?: string;
    source?: string | null;
  };
};

type InsuranceHolding = {
  id: string;
  label: string;
  startDate?: string | null;
  ownerName?: string;
  policyholderPersonId?: string | null;
  insuredPersonName?: string;
  insuredPersonId?: string | null;
  beneficiaryName?: string | null;
  cashValue?: number | null;
  coverageAmount?: number | null;
  totalPremium?: number | null;
  status?: string | null;
  statusLabel?: string;
  frequencyLabel?: string;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  institutionId?: string | null;
  institutionName?: string | null;
  ownerGroupId?: string | null;
  productType?: string | null;
  accountingType?: string | null;
  currency?: string | null;
  accountId?: string | null;
  premiumMode?: string | null;
  premiumFrequencyMonths?: number | null;
  cashValueEnabled?: boolean | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  note?: string | null;
  relatedEntryIds: string[];
};

type InsuranceProductRow = {
  id: string;
  accountId?: string | null;
  name: string;
  productType?: string | null;
  accountingType?: string | null;
  cashValueEnabled?: boolean | null;
  institutionId?: string | null;
  institutionName?: string | null;
  ownerGroupId?: string | null;
  ownerGroupName?: string | null;
  policyholderPersonId?: string | null;
  policyholderPersonName?: string | null;
  insuredUserName?: string | null;
  insuredPersonId?: string | null;
  insuredPersonName?: string | null;
  beneficiaryName?: string | null;
  startDate?: string | null;
  effectiveDate?: string | null;
  maturityDate?: string | null;
  status?: string | null;
  currency?: string | null;
  premiumMode?: string | null;
  premiumFrequencyMonths?: number | null;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  coverageAmount?: number | null;
  note?: string | null;
};

function amountClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function stopRowClick(event: React.MouseEvent) {
  event.stopPropagation();
}

function normalizeInsuranceMetricMode(
  productType?: string | null,
  accountingType?: string | null,
  cashValueEnabled?: boolean | null,
) {
  const normalizedProductType = productType ?? "other";
  const normalizedAccountingType = accountingType ?? "asset";
  if (cashValueEnabled === false) return "coverage";
  if (normalizedAccountingType === "protection") return "coverage";
  if (normalizedAccountingType === "hybrid") return "hybrid";
  if (
    ["critical_illness", "medical", "accident", "term_life", "whole_life"].includes(
      normalizedProductType,
    )
  ) {
    return "hybrid";
  }
  return "balance";
}

function frequencyLabel(months?: number | null) {
  if (months === 1) return "每月";
  if (months === 3) return "每季";
  if (months === 6) return "每半年";
  if (months === 12) return "每年";
  if (months === 999999) return "趸交";
  return "-";
}

function statusLabel(status?: string | null) {
  if (status === "matured") return "已满期";
  if (status === "surrendered") return "已退保";
  if (status === "lapsed") return "已失效";
  return "保障中";
}

function parseOptionalNumber(input: string) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function mergeFamilyMemberOptions(
  options: SmartSelectOption[],
  people: ReadonlyArray<{ id?: string | null; name?: string | null }>,
) {
  const byName = new Map<string, SmartSelectOption>();

  function addOption(candidate: SmartSelectOption) {
    const normalizedName = candidate.label.trim();
    if (!normalizedName) return;
    const normalizedCandidate: SmartSelectOption = {
      ...candidate,
      label: normalizedName,
      subLabel: "家庭成员",
    };
    const existing = byName.get(normalizedName);
    const existingIsSynthetic = existing?.id.startsWith("name:") ?? false;
    const candidateIsSynthetic = normalizedCandidate.id.startsWith("name:");
    if (!existing || (existingIsSynthetic && !candidateIsSynthetic)) {
      byName.set(normalizedName, normalizedCandidate);
    }
  }

  for (const option of options) {
    addOption(option);
  }

  for (const person of people) {
    const id = String(person.id ?? "").trim();
    const name = String(person.name ?? "").trim();
    if (!name) continue;
    addOption({
      id: id || `name:${name}`,
      label: name,
      subLabel: "家庭成员",
    });
  }

  return Array.from(byName.values()).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}

function buildInsuranceEntries(detailEntries: Array<Record<string, unknown>>): InsuranceEntry[] {
  return detailEntries
    .filter((entry) => entry.source === "insurance")
    .map((entry) => {
      const fundSubtype = String(entry.fundSubtype ?? "");
      const isRedeemEntry = fundSubtype === "redeem" || fundSubtype === "switch_out";
      const rawAmount = Number(entry.amount ?? 0);
      const amount = isRedeemEntry ? Math.abs(rawAmount) : -Math.abs(rawAmount);

      const cashAccountId = isRedeemEntry
        ? (entry.toAccountId ? String(entry.toAccountId) : null)
        : (entry.accountId ? String(entry.accountId) : null);

      // 资金账户显示：机构 · 卡名称
      const accountInstitutionName = String(entry.accountInstitutionName ?? "");
      const toAccountInstitutionName = String(entry.toAccountInstitutionName ?? "");
      const rawAccountName = isRedeemEntry
        ? String(entry.toAccountName ?? "")
        : String(entry.accountName ?? "");
      const rawInstitution = isRedeemEntry ? toAccountInstitutionName : accountInstitutionName;
      const cashAccountLabel = [rawInstitution, rawAccountName]
        .filter(Boolean)
        .join(" · ") || rawAccountName || "-";

      return {
        id: String(entry.id ?? ""),
        date: String(entry.date ?? ""),
        typeLabel: isRedeemEntry ? "赎回" : "投保",
        productName: String(entry.fundName ?? ""),
        cashAccountLabel,
        cashAccountId,
        note: String(entry.note ?? ""),
        amount,
        coverageAmount:
          entry.coverageAmount == null ? null : Number(entry.coverageAmount),
        paymentTermYears:
          entry.paymentTermYears == null ? null : Number(entry.paymentTermYears),
        edit: {
          type: "investment",
          date: String(entry.date ?? ""),
          amount: Math.abs(rawAmount),
          note: String(entry.note ?? ""),
          accountId: isRedeemEntry
            ? String(entry.accountId ?? "")
            : String(entry.toAccountId ?? ""),
          cashAccountId: isRedeemEntry
            ? String(entry.toAccountId ?? "")
            : String(entry.accountId ?? ""),
          insuranceProductId:
            entry.insuranceProductId == null ? null : String(entry.insuranceProductId),
          fundName: entry.fundName == null ? undefined : String(entry.fundName),
          fundProductType:
            entry.fundProductType == null ? undefined : String(entry.fundProductType),
          fundSubtype: fundSubtype || undefined,
          source: "insurance",
        },
      };
    });
}

function buildInsuranceHoldings(
  products: InsuranceProductRow[],
  entries: InsuranceEntry[],
): InsuranceHolding[] {
  return products.map((product) => {
    const relatedEntries = entries.filter(
      (entry) => entry.edit?.insuranceProductId === product.id,
    );
    const sortedEntries = [...relatedEntries].sort((a, b) => a.date.localeCompare(b.date));
    const metricMode = normalizeInsuranceMetricMode(
      product.productType,
      product.accountingType,
      product.cashValueEnabled,
    );
    const balance = relatedEntries.reduce((sum, entry) => sum + entry.amount, 0);
    const totalPremium = relatedEntries
      .filter((entry) => entry.amount < 0)
      .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);

    return {
      id: product.id,
      label: product.name,
      startDate: sortedEntries[0]?.date ?? product.startDate ?? null,
      ownerName: product.policyholderPersonName ?? product.ownerGroupName ?? "",
      policyholderPersonId: product.policyholderPersonId ?? null,
      insuredPersonName: product.insuredPersonName ?? product.insuredUserName ?? "",
      insuredPersonId: product.insuredPersonId ?? null,
      beneficiaryName: product.beneficiaryName ?? null,
      cashValue: metricMode === "coverage" ? null : balance,
      coverageAmount: product.coverageAmount ?? null,
      totalPremium,
      status: product.status ?? null,
      statusLabel: statusLabel(product.status),
      frequencyLabel: frequencyLabel(product.premiumFrequencyMonths),
      paymentTermYears: product.paymentTermYears ?? null,
      coverageTermYears: product.coverageTermYears ?? null,
      institutionId: product.institutionId ?? null,
      institutionName: product.institutionName ?? null,
      ownerGroupId: product.ownerGroupId ?? null,
      productType: product.productType ?? null,
      accountingType: product.accountingType ?? null,
      currency: product.currency ?? null,
      accountId: product.accountId ?? null,
      premiumMode: product.premiumMode ?? null,
      premiumFrequencyMonths: product.premiumFrequencyMonths ?? null,
      cashValueEnabled: product.cashValueEnabled ?? null,
      effectiveDate: product.effectiveDate ?? null,
      maturityDate: product.maturityDate ?? null,
      note: product.note ?? null,
      relatedEntryIds: relatedEntries.map((entry) => entry.id),
    };
  });
}

export function InsuranceShell({
  accountId,
  holdings,
  entries,
  familyMemberOptions = [],
  cashAccounts = [],
  cashAccountSSOptions = [],
}: {
  accountId: string;
  accountLabel: string;
  institutionName?: string;
  holdings: InsuranceHolding[];
  entries: InsuranceEntry[];
  familyMemberOptions?: SmartSelectOption[];
  cashAccounts?: Array<{ id: string; label: string; icon?: string; subLabel?: string }>;
  cashAccountSSOptions?: SmartSelectOption[];
}) {
  const [refreshedEntries, setRefreshedEntries] = useState<InsuranceEntry[] | null>(null);
  const [refreshedHoldings, setRefreshedHoldings] = useState<InsuranceHolding[] | null>(null);
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [showActiveOnly, setShowActiveOnly] = useState(false);
  const [familyMemberOptionsState, setFamilyMemberOptionsState] =
    useState<SmartSelectOption[]>(familyMemberOptions);
  const familyMemberOptionsStateRef = useRef<SmartSelectOption[]>(familyMemberOptions);
  const [policyEditValue, setPolicyEditValue] =
    useState<InsurancePolicyEditValue | null>(null);
  const [policyEditMeta, setPolicyEditMeta] =
    useState<InsurancePolicyEditMeta | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [deletePolicyValue, setDeletePolicyValue] = useState<{
    readonly id: string;
    readonly name: string;
    readonly institutionName: string | null;
    readonly ownerName: string | null;
    readonly relatedEntryCount: number;
  } | null>(null);
  const [deletingPolicy, setDeletingPolicy] = useState(false);
  const [productEditValue, setProductEditValue] = useState<InsuranceProductEditValue | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [entryEditValue, setEntryEditValue] = useState<{
    readonly id: string;
    readonly date: string;
    readonly amount: string;
    readonly cashAccountId: string;
    readonly coverageAmount: string;
    readonly paymentTermYears: string;
    readonly note: string;
    readonly fundSubtype: string;
    readonly fundProductType: string;
    readonly insuranceProductId: string;
    readonly insuranceProductName: string;
  } | null>(null);
  const refreshSeq = useRef(0);
  const currentHoldingsRef = useRef<InsuranceHolding[]>(holdings);
  const familyMemberOptionsRef = useRef<SmartSelectOption[]>(familyMemberOptions);

  const currentEntries = refreshedEntries ?? entries;
  const currentHoldings = refreshedHoldings ?? holdings;

  useEffect(() => {
    currentHoldingsRef.current = currentHoldings;
  }, [currentHoldings]);

  useEffect(() => {
    familyMemberOptionsRef.current = familyMemberOptions;
  }, [familyMemberOptions]);

  useEffect(() => {
    familyMemberOptionsStateRef.current = familyMemberOptionsState;
  }, [familyMemberOptionsState]);

  const refreshInsuranceData = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const [detailRes, productsRes, accountsRes] = await Promise.all([
        fetch(
          `/api/v1/transactions/detail?accountId=${encodeURIComponent(accountId)}&page=1&pageSize=2000`,
          { cache: "no-store" },
        ),
        fetch("/api/v1/insurance-products", { cache: "no-store" }),
        fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }),
      ]);
      const [detailData, productsData, accountsData] = await Promise.all([
        detailRes.json().catch(() => null),
        productsRes.json().catch(() => null),
        accountsRes.json().catch(() => null),
      ]);
      if (seq !== refreshSeq.current) return;
      if (!detailRes.ok || !detailData?.ok || !Array.isArray(detailData?.data?.entries)) {
        return;
      }
      if (!productsRes.ok || !productsData?.ok || !Array.isArray(productsData?.products)) {
        return;
      }

      const nextEntries = buildInsuranceEntries(detailData.data.entries);
      const nextProducts = (productsData.products as InsuranceProductRow[]).filter(
        (product) => product.accountId === accountId,
      );
      const previousHoldingsById = new Map(
        currentHoldingsRef.current.map((holding) => [holding.id, holding]),
      );
      const nextHoldings = buildInsuranceHoldings(nextProducts, nextEntries).map((holding) => {
        const previous = previousHoldingsById.get(holding.id);
        if (!previous) return holding;
        return {
          ...holding,
          ownerName: holding.ownerName || previous.ownerName,
          policyholderPersonId:
            holding.policyholderPersonId ?? previous.policyholderPersonId ?? null,
          insuredPersonName: holding.insuredPersonName || previous.insuredPersonName,
          insuredPersonId: holding.insuredPersonId ?? previous.insuredPersonId ?? null,
          beneficiaryName: holding.beneficiaryName || previous.beneficiaryName,
          institutionName: holding.institutionName || previous.institutionName,
        };
      });

      const fetchedFamilyOptions = Array.isArray(accountsData?.institutions)
        ? accountsData.institutions
            .filter((item: { type?: string | null }) => item?.type === "family_member")
            .map((item: { id: string; name: string }) => ({
              id: String(item.id),
              label: String(item.name ?? ""),
              subLabel: "家庭成员",
            }))
        : [];

      setFamilyMemberOptionsState(
        mergeFamilyMemberOptions(
          fetchedFamilyOptions.length > 0 ? fetchedFamilyOptions : familyMemberOptionsRef.current,
          nextHoldings.flatMap((holding) => [
            { id: holding.policyholderPersonId, name: holding.ownerName },
            { id: holding.insuredPersonId, name: holding.insuredPersonName },
            { id: null, name: holding.beneficiaryName },
          ]),
        ),
      );
      setRefreshedEntries(nextEntries);
      setRefreshedHoldings(nextHoldings);
    } catch {}
  }, [accountId]);

  useEffect(() => {
    setRefreshedEntries(null);
    setRefreshedHoldings(null);
    setSelectedHoldingId(null);
    setSelectedEntryIds(new Set());
  }, [accountId]);

  useEffect(() => {
    setFamilyMemberOptionsState((previous) =>
      mergeFamilyMemberOptions(familyMemberOptions, [
        ...previous.map((item) => ({ id: item.id, name: item.label })),
        ...currentHoldings.flatMap((holding) => [
          { id: holding.policyholderPersonId, name: holding.ownerName },
          { id: holding.insuredPersonId, name: holding.insuredPersonName },
          { id: null, name: holding.beneficiaryName },
        ]),
      ]),
    );
  }, [currentHoldings, familyMemberOptions]);

  useEffect(() => {
    const handler = () => {
      void refreshInsuranceData();
    };
    window.addEventListener("mmh:fund:refresh", handler);
    return () => window.removeEventListener("mmh:fund:refresh", handler);
  }, [refreshInsuranceData]);

  useEffect(() => {
    function onInsuranceEdit(event: Event) {
      const detail = (event as CustomEvent<{
        entryId: string;
        date: string;
        amount: number;
        note: string;
        accountId?: string;
        cashAccountId?: string;
        insuranceProductId?: string | null;
        fundName?: string;
        fundProductType?: string;
        fundSubtype?: string;
        source?: string | null;
      }>).detail;
      const sourceEntry = currentEntries.find((entry) => entry.id === detail.entryId);
      if (!sourceEntry) return;
      setEntryEditValue({
        id: sourceEntry.id,
        date: detail.date,
        amount: String(detail.amount),
        cashAccountId: detail.cashAccountId ?? "",
        coverageAmount: sourceEntry.coverageAmount == null ? "" : String(sourceEntry.coverageAmount),
        paymentTermYears:
          sourceEntry.paymentTermYears == null ? "" : String(sourceEntry.paymentTermYears),
        note: detail.note ?? sourceEntry.note ?? "",
        fundSubtype: detail.fundSubtype ?? "buy",
        fundProductType: detail.fundProductType ?? "insurance",
        insuranceProductId: detail.insuranceProductId ? String(detail.insuranceProductId) : "",
        insuranceProductName: sourceEntry.productName,
      });
    }

    window.addEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
    return () => window.removeEventListener("mmh:insurance:edit", onInsuranceEdit as EventListener);
  }, [currentEntries]);

  useEffect(() => {
    void refreshInsuranceData();
  }, [refreshInsuranceData]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok || !Array.isArray(data?.institutions)) return;
        const nextOptions = data.institutions
          .filter((item: { type?: string | null }) => item?.type === "family_member")
          .map((item: { id: string; name: string }) => ({
            id: String(item.id),
            label: String(item.name ?? ""),
            subLabel: "家庭成员",
          }));
        setFamilyMemberOptionsState((prev) =>
          mergeFamilyMemberOptions(
            nextOptions,
            prev.map((item) => ({ id: item.id, name: item.label })),
          ),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleHoldings = useMemo(
    () =>
      currentHoldings
        .filter((holding) => holding.relatedEntryIds.length > 0 || holding.status !== "lapsed")
        .filter((holding) => !showActiveOnly || holding.status === "active"),
    [currentHoldings, showActiveOnly],
  );

  const selectedHolding = useMemo(
    () => visibleHoldings.find((holding) => holding.id === selectedHoldingId) ?? null,
    [selectedHoldingId, visibleHoldings],
  );
  const productEditOptions = useMemo<InsuranceProductEditOption[]>(
    () => currentHoldings.map((holding) => ({ id: holding.id, label: holding.label })),
    [currentHoldings],
  );
  const productEditInstitutions = useMemo<InsuranceProductEditInstitution[]>(
    () =>
      Array.from(
        new Map(
          currentHoldings
            .map((holding) => ({
              id: String(holding.institutionId ?? ""),
              label: String(holding.institutionName ?? ""),
            }))
            .filter((item) => item.id && item.label)
            .map((item) => [item.id, item] as const),
        ).values(),
      ).sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    [currentHoldings],
  );

  const visibleEntries = useMemo(() => {
    if (!selectedHolding) return currentEntries;
    const relatedIds = new Set(selectedHolding.relatedEntryIds);
    return currentEntries.filter((entry) => relatedIds.has(entry.id));
  }, [currentEntries, selectedHolding]);

  const holdingSummary = useMemo(() => {
    const totalCashValue = visibleHoldings.reduce(
      (sum, holding) => sum + (holding.cashValue ?? 0),
      0,
    );
    const totalCoverageAmount = visibleHoldings.reduce(
      (sum, holding) => sum + (holding.coverageAmount ?? 0),
      0,
    );
    const totalPremium = visibleHoldings.reduce(
      (sum, holding) => sum + (holding.totalPremium ?? 0),
      0,
    );
    return { totalCashValue, totalCoverageAmount, totalPremium };
  }, [visibleHoldings]);

  const holdingSummaryRow = useMemo<AdvancedDataTableSummaryRow>(
    () => ({
      cells: {
        name: <span className="font-semibold text-slate-800">汇总</span>,
        totalPremium: (
          <span className="font-semibold tabular-nums text-slate-800">
            {formatMoney(holdingSummary.totalPremium)}
          </span>
        ),
        cashValue: (
          <span className={`font-semibold tabular-nums ${amountClass(holdingSummary.totalCashValue)}`}>
            {formatMoney(holdingSummary.totalCashValue)}
          </span>
        ),
        coverageAmount: (
          <span className="font-semibold tabular-nums text-slate-800">
            {formatMoney(holdingSummary.totalCoverageAmount)}
          </span>
        ),
      },
      rowClassName: "bg-slate-50/80",
    }),
    [holdingSummary],
  );

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${selectedEntryIds.size} 条投保记录吗？`)) return;
    const response = await fetch("/api/v1/entries/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: Array.from(selectedEntryIds) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      window.alert(data?.error || "批量删除失败");
      return;
    }
    setSelectedEntryIds(new Set());
    window.dispatchEvent(new Event("mmh:fund:refresh"));
  }

  async function savePolicyEdit(next: InsurancePolicyEditValue) {
    const holding = currentHoldings.find((item) => item.id === next.id);
    if (!holding) {
      window.alert("保单不存在");
      return;
    }

    const policyholderPersonId = next.policyholderPersonId.trim() || null;
    const insuredPersonId = next.insuredPersonId.trim() || null;
    const paymentTermYears = parseOptionalNumber(next.paymentTermYears);
    const coverageAmount = parseOptionalNumber(next.coverageAmount);

    setSavingPolicy(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: next.id,
          mode: "policy",
          policyholderPersonId,
          policyholderPersonName: policyholderPersonId
            ? familyMemberOptionsState.find((item) => item.id === policyholderPersonId)?.label?.trim() || undefined
            : undefined,
          insuredPersonId,
          insuredPersonName: insuredPersonId
            ? familyMemberOptionsState.find((item) => item.id === insuredPersonId)?.label?.trim() || undefined
            : undefined,
          paymentTermYears,
          coverageAmount,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "保存保单失败");
      }
      setPolicyEditValue(null);
      setPolicyEditMeta(null);
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存保单失败");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function deletePolicyById(target: {
    id: string;
    relatedEntryCount: number;
  }, password?: string) {
    setDeletingPolicy(true);
    try {
      const response = await fetch(`/api/v1/insurance-products?id=${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        headers: target.relatedEntryCount > 0 ? { "Content-Type": "application/json" } : undefined,
        body:
          target.relatedEntryCount > 0
            ? JSON.stringify({ password: password ?? "", cascade: true })
            : undefined,
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "删除保单失败");
      }
      setDeletePolicyValue(null);
      setPolicyEditValue(null);
      setPolicyEditMeta(null);
      setSelectedHoldingId(null);
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "删除保单失败");
    } finally {
      setDeletingPolicy(false);
    }
  }

  async function saveProductEdit(next: InsuranceProductEditValue) {
    const holding = currentHoldings.find((item) => item.id === next.id);
    if (!holding) {
      window.alert("保险产品不存在");
      return;
    }

    setSavingProduct(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...next,
          mode: "master",
          shortName: next.shortName.trim() || null,
          note: next.note.trim() || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || "保存保险产品失败");
      }
      setProductEditValue(null);
      window.dispatchEvent(new Event("mmh:fund:refresh"));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存保险产品失败");
    } finally {
      setSavingProduct(false);
    }
  }

  const holdingColumns = useMemo<AdvancedDataTableColumn<InsuranceHolding>[]>(
    () => [
      {
        key: "name",
        label: "保单名称",
        width: 240,
        minWidth: 160,
        filterText: (holding) => holding.label,
        render: (holding) => (
          <span className="block truncate font-medium text-slate-700" title={holding.label}>
            {holding.label}
          </span>
        ),
      },
      {
        key: "ownerName",
        label: "投保人",
        width: 110,
        minWidth: 84,
        hideable: true,
        filterText: (holding) => holding.ownerName ?? "",
        render: (holding) => (
          <span className="truncate text-slate-600">{holding.ownerName || "-"}</span>
        ),
      },
      {
        key: "insuredPersonName",
        label: "被保人",
        width: 110,
        minWidth: 84,
        hideable: true,
        filterText: (holding) => holding.insuredPersonName ?? "",
        render: (holding) => (
          <span className="truncate text-slate-600">{holding.insuredPersonName || "-"}</span>
        ),
      },
      {
        key: "status",
        label: "状态",
        width: 96,
        minWidth: 72,
        hideable: true,
        filterText: (holding) => holding.statusLabel ?? "",
        render: (holding) => (
          <span className="text-slate-600">{holding.statusLabel || "-"}</span>
        ),
      },
      {
        key: "startDate",
        label: "开始投保",
        width: 112,
        minWidth: 88,
        hideable: true,
        filterText: (holding) => holding.startDate ?? "",
        render: (holding) => (
          <span className="tabular-nums text-slate-600">{holding.startDate || "-"}</span>
        ),
      },
      {
        key: "frequency",
        label: "缴费频率",
        width: 100,
        minWidth: 78,
        hideable: true,
        filterText: (holding) => holding.frequencyLabel ?? "",
        render: (holding) => (
          <span className="text-slate-600">{holding.frequencyLabel || "-"}</span>
        ),
      },
      {
        key: "paymentTerm",
        label: "缴费年限",
        width: 96,
        minWidth: 74,
        align: "right",
        hideable: true,
        render: (holding) => (
          <span className="tabular-nums text-slate-600">
            {holding.paymentTermYears != null ? `${holding.paymentTermYears} 年` : "-"}
          </span>
        ),
      },
      {
        key: "coverageTerm",
        label: "保障年限",
        width: 96,
        minWidth: 74,
        align: "right",
        hideable: true,
        render: (holding) => (
          <span className="tabular-nums text-slate-600">
            {holding.coverageTermYears != null ? `${holding.coverageTermYears} 年` : "-"}
          </span>
        ),
      },
      {
        key: "totalPremium",
        label: "保费合计",
        width: 120,
        minWidth: 92,
        align: "right",
        render: (holding) => (
          <span className="font-semibold tabular-nums text-slate-700">
            {formatMoney(holding.totalPremium ?? 0)}
          </span>
        ),
      },
      {
        key: "cashValue",
        label: "现金价值余额",
        width: 140,
        minWidth: 108,
        align: "right",
        render: (holding) => (
          <span className={`font-semibold tabular-nums ${amountClass(holding.cashValue ?? 0)}`}>
            {holding.cashValue != null ? formatMoney(holding.cashValue) : "-"}
          </span>
        ),
      },
      {
        key: "coverageAmount",
        label: "保额",
        width: 120,
        minWidth: 92,
        align: "right",
        hideable: true,
        render: (holding) => (
          <span className="font-semibold tabular-nums text-slate-700">
            {holding.coverageAmount != null ? formatMoney(holding.coverageAmount) : "-"}
          </span>
        ),
      },
      {
        key: "actions",
        label: "操作",
        width: 92,
        minWidth: 76,
        align: "right",
        hideable: true,
        render: (holding) => (
          <div className="flex items-center justify-end gap-1" onClick={stopRowClick}>
            <button
              type="button"
              className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500 hover:text-blue-600"
              onClick={() => {
                setPolicyEditValue({
                  id: holding.id,
                  policyholderPersonId:
                    holding.policyholderPersonId ??
                    familyMemberOptionsStateRef.current.find(
                      (item) => item.label.trim() === (holding.ownerName ?? "").trim(),
                    )?.id ??
                    "",
                  insuredPersonId: holding.insuredPersonId ?? "",
                  paymentTermYears:
                    holding.paymentTermYears != null ? String(holding.paymentTermYears) : "",
                  coverageAmount:
                    holding.coverageAmount != null ? String(holding.coverageAmount) : "",
                });
                setPolicyEditMeta({
                  name: holding.label,
                  institutionName: holding.institutionName ?? null,
                  ownerName: holding.ownerName ?? null,
                });
              }}
              title="编辑保单"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500 hover:text-red-600"
              onClick={() => {
                setDeletePolicyValue({
                  id: holding.id,
                  name: holding.label,
                  institutionName: holding.institutionName ?? null,
                  ownerName: holding.ownerName ?? null,
                  relatedEntryCount: holding.relatedEntryIds.length,
                });
              }}
              title="删除保单"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ),
      },
    ],
    [],
  );

  const entryColumns = useMemo<AdvancedDataTableColumn<InsuranceEntry>[]>(
    () => [
      {
        key: "date",
        label: "日期",
        width: 100,
        minWidth: 80,
        filterText: (entry) => entry.date,
        render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span>,
      },
      {
        key: "action",
        label: "动作",
        width: 90,
        minWidth: 70,
        filterText: (entry) => entry.typeLabel,
        render: (entry) => (
          <span className="inline-flex items-center gap-1 text-slate-700">
            {entry.amount >= 0 ? (
              <ArrowUpRight className="h-3 w-3" />
            ) : (
              <ArrowDownLeft className="h-3 w-3" />
            )}
            {entry.typeLabel}
          </span>
        ),
      },
      {
        key: "product",
        label: "保险名称",
        width: 220,
        minWidth: 140,
        filterText: (entry) => entry.productName,
        render: (entry) => (
          <span className="block truncate text-slate-700" title={entry.productName}>
            {entry.productName || "-"}
          </span>
        ),
      },
      {
        key: "cashAccount",
        label: "资金账户",
        width: 180,
        minWidth: 120,
        hideable: true,
        filterText: (entry) => entry.cashAccountLabel,
        render: (entry) => (
          <span className="block truncate text-slate-600" title={entry.cashAccountLabel}>
            {entry.cashAccountLabel || "-"}
          </span>
        ),
      },
      {
        key: "amount",
        label: "金额",
        width: 120,
        minWidth: 90,
        align: "right",
        render: (entry) => (
          <span className={`font-semibold tabular-nums ${amountClass(entry.amount)}`}>
            {formatMoney(entry.amount)}
          </span>
        ),
      },
      {
        key: "note",
        label: "备注",
        width: 280,
        minWidth: 140,
        hideable: true,
        filterText: (entry) => entry.note,
        render: (entry) => (
          <span className="block truncate text-slate-600" title={entry.note}>
            {entry.note || "-"}
          </span>
        ),
      },
      {
        key: "actions",
        label: "操作",
        width: 92,
        minWidth: 76,
        align: "right",
        render: (entry) => (
          <div onClick={stopRowClick}>
            <EntryRowActions entryId={entry.id} edit={entry.edit} />
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <section className="panel-surface flex min-h-0 flex-[0_0_42%] flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Shield className="h-4 w-4 text-cyan-600" />
              保单列表
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-500">
                <input
                  type="checkbox"
                  checked={showActiveOnly}
                  onChange={(event) => {
                    setShowActiveOnly(event.target.checked);
                    setSelectedHoldingId(null);
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                仅保障中
              </label>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_insurance_holdings_table_v2"
              columns={holdingColumns}
              rows={visibleHoldings}
              rowKey={(holding) => holding.id}
              minTableWidth={1360}
              emptyText="暂无保单"
              showFilters={false}
              showColumnVisibilityButton={false}
              fillHeight
              summaryRow={holdingSummaryRow}
              onRowClick={(holding) =>
                setSelectedHoldingId((current) => (current === holding.id ? null : holding.id))
              }
              onRowDoubleClick={(holding) => {
                setProductEditValue({
                  id: holding.id,
                  name: holding.label,
                  shortName: "",
                  productType: holding.productType ?? "other",
                  accountingType: holding.accountingType ?? "asset",
                  currency: holding.currency ?? "CNY",
                  institutionId: holding.institutionId ?? "",
                  note: holding.note ?? "",
                });
              }}
              rowClassName={(holding) =>
                `cursor-pointer ${selectedHoldingId === holding.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`
              }
            />
          </div>
        </section>

        <section className="panel-surface flex h-[26rem] min-h-[26rem] shrink-0 flex-col overflow-hidden md:h-[28rem] md:min-h-[28rem]">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Shield className="h-4 w-4 text-blue-500" />
              投保记录
            </div>
            <div className="text-xs text-slate-400">
              {selectedHolding
                ? `当前显示 ${visibleEntries.length} 条关联记录`
                : `显示全部记录，共 ${currentEntries.length} 条`}
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_insurance_entries_table_v2"
              columns={entryColumns}
              rows={visibleEntries}
              rowKey={(entry) => entry.id}
              minTableWidth={980}
              emptyText={selectedHolding ? "这份保单暂时没有关联记录" : "暂无投保记录"}
              selectable
              fillHeight
              selectedKeys={selectedEntryIds}
              onSelectionChange={setSelectedEntryIds}
              batchActions={[
                { label: "批量删除", onClick: batchDeleteEntries },
                {
                  label: "批量修改",
                  onClick: () => window.alert("批量修改入口下一步接入统一批量编辑弹窗。"),
                },
              ]}
            />
          </div>
        </section>
      </div>

      <InsurancePolicyEditModal
        open={!!policyEditValue}
        saving={savingPolicy}
        value={policyEditValue}
        meta={policyEditMeta}
        familyMemberOptions={familyMemberOptionsState}
        onClose={() => {
          if (savingPolicy) return;
          setPolicyEditValue(null);
          setPolicyEditMeta(null);
        }}
        onChange={setPolicyEditValue}
        onSaved={savePolicyEdit}
      />
      <InsurancePolicyDeleteModal
        open={!!deletePolicyValue}
        value={deletePolicyValue}
        deleting={deletingPolicy}
        onClose={() => {
          if (deletingPolicy) return;
          setDeletePolicyValue(null);
        }}
        onDelete={async (password) => {
          if (!deletePolicyValue) return;
          if (deletePolicyValue.relatedEntryCount > 0 && !password.trim()) {
            window.alert("请输入密码后再删除");
            return;
          }
          await deletePolicyById(deletePolicyValue, password);
        }}
      />
      <InsuranceProductEditModal
        open={!!productEditValue}
        saving={savingProduct}
        value={productEditValue}
        institutions={productEditInstitutions}
        products={productEditOptions}
        onClose={() => {
          if (savingProduct) return;
          setProductEditValue(null);
        }}
        onChange={setProductEditValue}
        onSaved={saveProductEdit}
      />
      <InsuranceEntryEditModal
        open={!!entryEditValue}
        value={entryEditValue}
        cashAccounts={cashAccounts}
        cashAccountSSOptions={cashAccountSSOptions}
        onClose={() => setEntryEditValue(null)}
        onSaved={async (next) => {
          setEntryEditValue(next);
          window.dispatchEvent(new Event("mmh:fund:refresh"));
        }}
      />
    </div>
  );
}



