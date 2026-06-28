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
  ownerGroupId?: string | null;
  institutionId?: string | null;
};

type InstitutionOption = {
  id: string;
  label: string;
  subLabel?: string;
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

function productTypeLabel(type?: string | null) {
  return PRODUCT_TYPE_OPTIONS.find((item) => item.value === type)?.label ?? "保险";
}

export function InsuranceFormModal({
  mode = "create",
  accountId: _defaultAccountId,
  entry,
  cashAccounts = [],
  cashAccountSSOptions,
  insuranceAccountSSOptions,
  ownerSSOptions,
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
  const initInsuranceAccountId =
    mode === "edit" && entry
      ? (initIsRedeem ? (entry.accountId ?? _defaultAccountId) : (entry.toAccountId ?? _defaultAccountId))
      : _defaultAccountId;

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<"buy" | "redeem">(initIsRedeem ? "redeem" : "buy");
  const [date, setDate] = useState(initDate);
  const [amount, setAmount] = useState(initAmount);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [insuranceAccountId, setInsuranceAccountId] = useState(initInsuranceAccountId);
  const [insuranceProductId, setInsuranceProductId] = useState<string>(mode === "edit" ? (entry?.insuranceProductId ?? "") : "");
  const [selectedProductName, setSelectedProductName] = useState(mode === "edit" ? (entry?.fundName ?? "") : "");
  const [memo, setMemo] = useState(initMemo);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);

  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [insuranceAccountList, setInsuranceAccountList] = useState<{ id: string; label: string; icon?: string; subLabel?: string }[]>([]);
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [localInsuranceSSOpts, setLocalInsuranceSSOpts] = useState(insuranceAccountSSOptions);
  const [insuranceProductOptions, setInsuranceProductOptions] = useState<InsuranceProductOption[]>([]);
  const [institutionOptions, setInstitutionOptions] = useState<InstitutionOption[]>([]);
  const [ownerOptions, setOwnerOptions] = useState<OwnerOption[]>([]);
  const [ownerGroupId, setOwnerGroupId] = useState("");
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "owner" | null>(null);
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [newProductName, setNewProductName] = useState("");
  const [newProductType, setNewProductType] = useState("savings");
  const [newProductInstitutionId, setNewProductInstitutionId] = useState("");
  const [newProductSaving, setNewProductSaving] = useState(false);

  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashFiltered,
  } = useAccountSSFilter(localCashSSOpts);
  const {
    ownerFilterLabel: insuranceOwnerFilterLabel,
    cycleOwnerFilter: cycleInsuranceOwnerFilter,
    filteredOptions: insuranceFiltered,
  } = useAccountSSFilter(localInsuranceSSOpts);

  const filteredInsuranceProducts = useMemo<SmartSelectOption[]>(() => {
    return insuranceProductOptions
      .filter((item) => !ownerGroupId || item.ownerGroupId === ownerGroupId)
      .map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel }));
  }, [insuranceProductOptions, ownerGroupId, insuranceAccountId]);

  const selectedInsuranceProduct = useMemo(
    () => insuranceProductOptions.find((item) => item.id === insuranceProductId) ?? null,
    [insuranceProductOptions, insuranceProductId],
  );

  useEffect(() => setCashAccountList(cashAccounts), [cashAccounts]);
  useEffect(() => setInsuranceAccountList(cashAccounts), [cashAccounts]);
  useEffect(() => setLocalCashSSOpts(cashAccountSSOptions), [cashAccountSSOptions]);
  useEffect(() => setLocalInsuranceSSOpts(insuranceAccountSSOptions), [insuranceAccountSSOptions]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/v1/insurance-products", { cache: "no-store" }).then((res) => res.json()).catch(() => null),
      fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).then((res) => res.json()).catch(() => null),
    ]).then(([productsData, accountsData]) => {
      if (cancelled) return;
      if (productsData?.ok && Array.isArray(productsData.products)) {
        setInsuranceProductOptions(
          productsData.products.map((item: any) => ({
            id: String(item.id),
            label: String(item.name ?? ""),
            subLabel: [item.institutionShortName || item.institutionName, productTypeLabel(item.productType)].filter(Boolean).join(" · "),
            accountId: String(item.accountId ?? ""),
            ownerGroupId: item.ownerGroupId ? String(item.ownerGroupId) : null,
            institutionId: item.institutionId ? String(item.institutionId) : null,
          })),
        );
      }
      if (Array.isArray(accountsData?.institutions)) {
        setInstitutionOptions(
          accountsData.institutions
            .filter((item: any) => item?.type === "insurance")
            .map((item: any) => ({
              id: String(item.id),
              label: String(item.name ?? ""),
              subLabel: "保险公司",
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
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function reset() {
    setSubtype("buy");
    setDate(today);
    setAmount("");
    setCashAccountId("");
    setInsuranceAccountId(_defaultAccountId);
    setOwnerGroupId("");
    setInsuranceProductId("");
    setSelectedProductName("");
    setMemo("");
    setRequestId(null);
  }

  useEffect(() => {
    function onEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        date: string;
        amount: number;
        note: string;
        accountId?: string;
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
      setSelectedProductName(detail.fundName ?? "");
      setInsuranceProductId(detail.insuranceProductId ?? "");
      const matched = detail.insuranceProductId
        ? insuranceProductOptions.find((item) => item.id === detail.insuranceProductId)
        : null;
      setOwnerGroupId(matched?.ownerGroupId ?? "");
      setMemo(detail.note ?? "");
      setCashAccountId(detail.fundSubtype === "redeem" ? (detail.toAccountId ?? "") : (detail.accountId ?? ""));
      setInsuranceAccountId(detail.fundSubtype === "redeem" ? (detail.accountId ?? _defaultAccountId) : (detail.toAccountId ?? _defaultAccountId));
      setOpen(true);
    }
    window.addEventListener("mmh:insurance:edit", onEdit as EventListener);
    return () => window.removeEventListener("mmh:insurance:edit", onEdit as EventListener);
  }, [_defaultAccountId, today]);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{ requestId: string; defaultCashAccountId?: string; defaultInsuranceAccountId?: string }>).detail;
      setRequestId(detail?.requestId ?? null);
      reset();
      setDate(today);
      setCashAccountId(detail?.defaultCashAccountId ?? "");
      setInsuranceAccountId(detail?.defaultInsuranceAccountId ?? _defaultAccountId);
      setOpen(true);
    }
    window.addEventListener("mmh:insurance:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:insurance:create", onCreate as EventListener);
  }, [_defaultAccountId, today]);

  useEffect(() => {
    if (!insuranceProductId) return;
    const matched = insuranceProductOptions.find((item) => item.id === insuranceProductId);
    if (matched && matched.accountId !== insuranceAccountId) {
      setInsuranceAccountId(matched.accountId);
    }
  }, [insuranceProductId, insuranceProductOptions, insuranceAccountId]);

  async function onCreateInsuranceProduct(event: FormEvent) {
    event.preventDefault();
    if (newProductSaving) return;
    const trimmedName = newProductName.trim();
    if (!trimmedName) {
      window.alert("请输入保险产品名称");
      return;
    }
    if (!ownerGroupId) {
      window.alert("请选择投保人");
      return;
    }
    if (!newProductInstitutionId) {
      window.alert("请选择承保机构");
      return;
    }

    setNewProductSaving(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          productType: newProductType,
          accountingType: "asset",
          ownerGroupId,
          institutionId: newProductInstitutionId || undefined,
        }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; insuranceProduct?: any } | null;
      if (!response.ok || !data?.ok || !data.insuranceProduct) {
        throw new Error(data?.error || "创建保险产品失败");
      }
      const created = data.insuranceProduct;
      const option: InsuranceProductOption = {
        id: created.id,
        label: created.name,
        subLabel: [created.institutionShortName || created.institutionName, productTypeLabel(created.productType)].filter(Boolean).join(" · "),
        accountId: created.accountId,
        ownerGroupId: created.ownerGroupId ?? ownerGroupId,
        institutionId: created.institutionId ?? (newProductInstitutionId || null),
      };
      setInsuranceProductOptions((prev) => [...prev, option]);
      setInsuranceProductId(option.id);
      setSelectedProductName(option.label);
      setNewProductOpen(false);
      setNewProductName("");
      setNewProductType("savings");
      setNewProductInstitutionId("");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "创建保险产品失败");
    } finally {
      setNewProductSaving(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    const amt = Number(String(amount).replace(/,/g, ""));
    if (!Number.isFinite(amt) || amt <= 0) {
      window.alert("请输入正确金额");
      return;
    }
    if (!ownerGroupId) {
      window.alert("请选择投保人");
      return;
    }
    if (!insuranceProductId) {
      window.alert("请选择保险产品");
      return;
    }

    // Determine actual mode: edit only when there is a real entry id to update
    const entryId = mode === "edit" ? (entry?.id || editEntryId || "") : "";
    const isEdit = !!entryId;
    const method = isEdit ? "PUT" : "POST";

    setSubmitting(true);
    try {
      const payload = {
        id: isEdit ? entryId : undefined,
        type: "investment",
        date,
        amount: amt,
        note: memo,
        accountId: selectedInsuranceProduct?.accountId || insuranceAccountId || undefined,
        ownerGroupId,
        cashAccountId,
        // Compatibility with the shared investment transaction API. Insurance identity is insuranceProductId.
        fundName: selectedInsuranceProduct?.label || selectedProductName || "",
        insuranceProductId,
        fundProductType: "wealth",
        fundSubtype: subtype,
        source: "insurance",
      };
      const response = await fetch("/api/v1/transactions/detail", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || (isEdit ? "保存失败" : "记账失败"));
      }
      if (isEdit) {
        window.dispatchEvent(new CustomEvent("mmh:insurance:edit:success", { detail: { requestId } }));
      }
      setOpen(false);
      if (!isEdit) reset();
      requestAnimationFrame(() => window.dispatchEvent(new Event("mmh:fund:refresh")));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  const isRedeem = subtype === "redeem";

  const insuranceOwnerCycleButton = localInsuranceSSOpts?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleInsuranceOwnerFilter}
      title={`鎵€鏈変汉锛?{insuranceOwnerFilterLabel}`}
      aria-label={`鍒囨崲鎵€鏈変汉锛屽綋鍓?${insuranceOwnerFilterLabel}`}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;
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

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 p-4 backdrop-blur-[2px]">
        <div className="modal-surface w-full max-w-md">
          <div className="modal-header">
            <div className="text-sm font-semibold text-slate-800">
              {mode === "edit" ? "编辑保险记录" : "新增保险记录"}
              <span className="ml-2 text-xs font-normal text-slate-500">保险</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                if (mode === "create") reset();
              }}
              className="secondary-button h-8 px-2"
            >
              关闭
            </button>
          </div>

          <form className="max-h-[80vh] space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSubtype("buy")}
                className={`segment-button h-8 flex-1 text-xs ${subtype === "buy" ? "segment-button-active font-medium" : ""}`}
              >
                买入
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
                <div className="form-label">{isRedeem ? "赎回金额" : "买入金额"}</div>
                <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={isRedeem ? "赎回" : "买入"} precision={2} />
              </div>
            </div>

            <div className="space-y-1">
              <div className="form-label">投保人</div>
              <SmartSelect
                mode="single"
                value={ownerGroupId}
                onChange={(id) => {
                  setOwnerGroupId(id);
                  setInsuranceAccountId("");
                  setInsuranceProductId("");
                }}
                options={ownerOptions}
                placeholder="选择投保人"
                searchable
                onCreateClick={() => setNestedEntityType("owner")}
                createLabel="+"
              />
            </div>

            <div className="space-y-1">
              <div className="form-label">保险产品</div>
              <SmartSelect
                mode="single"
                value={insuranceProductId}
                onChange={setInsuranceProductId}
                options={filteredInsuranceProducts}
                placeholder="选择保险产品"
                searchable
                onCreateClick={() => setNewProductOpen(true)}
                createLabel="+"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">{isRedeem ? "到账账户" : "资金来源账户"}</div>
                <SmartSelect
                  mode="single"
                  value={cashAccountId}
                  onChange={setCashAccountId}
                  options={cashFiltered ?? cashAccountList}
                  placeholder="选择账户"
                  onCreateClick={() => setNestedEntityType("cash-account")}
                  createLabel="+"
                  onCycleOwnerFilter={cycleCashOwnerFilter}
                  ownerFilterLabel={cashOwnerFilterLabel}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">产品类型</div>
                <div className="form-input flex h-9 items-center text-sm text-slate-600">
                  {selectedInsuranceProduct?.subLabel || "未选择"}
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <div className="form-label">备注</div>
              <input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="可选" className="form-input" />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="submit"
                disabled={submitting}
                className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : "primary-button"}`}
              >
                {submitting ? "保存中..." : mode === "edit" ? "保存修改" : isRedeem ? "记账（赎回）" : "记账（买入）"}
              </button>
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
            setInsuranceAccountId("");
            setInsuranceProductId("");
            setNestedEntityType(null);
          }}
          nestedFieldData={nestedFieldData}
        />
      )}

      {newProductOpen && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/28 p-4 backdrop-blur-[2px]">
          <div className="modal-surface w-full max-w-md">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">新增保险产品</div>
              <button type="button" onClick={() => setNewProductOpen(false)} className="secondary-button h-8 px-2">
                关闭
              </button>
            </div>
            <form className="space-y-3 p-4" onSubmit={onCreateInsuranceProduct}>
              <div className="space-y-1">
                <div className="form-label">保险产品名称</div>
                <input
                  value={newProductName}
                  onChange={(event) => setNewProductName(event.target.value)}
                  placeholder="例如：泰康幸福年金A"
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">产品类型</div>
                <select value={newProductType} onChange={(event) => setNewProductType(event.target.value)} className="form-input" title="产品类型" aria-label="产品类型">
                  {PRODUCT_TYPE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">承保机构</div>
                <SmartSelect
                  mode="single"
                  value={newProductInstitutionId}
                  onChange={setNewProductInstitutionId}
                  options={institutionOptions}
                  placeholder="选择承保机构"
                  searchable
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setNewProductOpen(false)} className="secondary-button h-9 px-4">
                  取消
                </button>
                <button type="submit" disabled={newProductSaving} className="primary-button h-9">
                  {newProductSaving ? "保存中..." : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )}
    </>,
    document.body,
  );
}




