"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { CalcInput } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";

type PropertyAction = "purchase" | "improvement" | "sale";
type ModalMode = "transaction" | "valuation";

type AccountOption = {
  id: string;
  name?: string;
  label: string;
  title?: string;
  hoverTitle?: string;
  kind?: string | null;
  currency?: string | null;
  investProductType?: string | null;
};

type PropertyAssetOption = {
  id: string;
  name: string;
  marketValue?: number | null;
};

type PropertyCreateEventDetail = {
  requestId?: string;
  defaultPropertyAccountId?: string;
  defaultCashAccountId?: string;
  defaultAction?: PropertyAction;
};

type PropertyValuationEventDetail = {
  requestId?: string;
  defaultPropertyAccountId?: string;
  propertyAssetId?: string;
  propertyName?: string;
  currentMarketValue?: number | null;
};

type Props = {
  defaultPropertyAccountId?: string;
  defaultCashAccountId?: string;
  propertyAccounts: AccountOption[];
  propertyAccountSSOptions?: SmartSelectOption[];
  cashAccounts: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  propertyAssets?: PropertyAssetOption[];
};

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function accountToOption(account: AccountOption): SmartSelectOption {
  return {
    id: account.id,
    label: account.label || account.name || account.id,
    title: account.hoverTitle || account.title || account.label || account.name || account.id,
  };
}

function parseAmount(value: string) {
  const num = Number(String(value || "0").replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
}

export function PropertyFormModal({
  defaultPropertyAccountId = "",
  defaultCashAccountId = "",
  propertyAccounts,
  propertyAccountSSOptions,
  cashAccounts,
  cashAccountSSOptions,
  propertyAssets = [],
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ModalMode>("transaction");
  const [requestId, setRequestId] = useState("");
  const [action, setAction] = useState<PropertyAction>("purchase");
  const [propertyAccountId, setPropertyAccountId] = useState(defaultPropertyAccountId);
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId);
  const [propertyAssetId, setPropertyAssetId] = useState("");
  const [name, setName] = useState("");
  const [propertyType, setPropertyType] = useState("");
  const [address, setAddress] = useState("");
  const [tradeDate, setTradeDate] = useState(todayYmd());
  const [settlementDate, setSettlementDate] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("");
  const [tax, setTax] = useState("");
  const [marketValue, setMarketValue] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const propertyOptions = useMemo(
    () => propertyAccountSSOptions?.length ? propertyAccountSSOptions : propertyAccounts.map(accountToOption),
    [propertyAccountSSOptions, propertyAccounts],
  );
  const cashOptions = useMemo(
    () => cashAccountSSOptions?.length ? cashAccountSSOptions : cashAccounts.map(accountToOption),
    [cashAccountSSOptions, cashAccounts],
  );
  const assetOptions = useMemo(
    () => propertyAssets.map((asset) => ({ id: asset.id, label: asset.name, title: asset.name })),
    [propertyAssets],
  );

  const resetTransactionDraft = useCallback((detail?: PropertyCreateEventDetail) => {
    setMode("transaction");
    setRequestId(detail?.requestId ?? "");
    setAction(detail?.defaultAction ?? "purchase");
    setPropertyAccountId(detail?.defaultPropertyAccountId || defaultPropertyAccountId || propertyAccounts[0]?.id || "");
    setCashAccountId(detail?.defaultCashAccountId || defaultCashAccountId || cashAccounts[0]?.id || "");
    setPropertyAssetId("");
    setName("");
    setPropertyType("");
    setAddress("");
    setTradeDate(todayYmd());
    setSettlementDate("");
    setAmount("");
    setFee("");
    setTax("");
    setMarketValue("");
    setNote("");
  }, [cashAccounts, defaultCashAccountId, defaultPropertyAccountId, propertyAccounts]);

  const resetValuationDraft = useCallback((detail?: PropertyValuationEventDetail) => {
    setMode("valuation");
    setRequestId(detail?.requestId ?? "");
    setAction("purchase");
    setPropertyAccountId(detail?.defaultPropertyAccountId || defaultPropertyAccountId || propertyAccounts[0]?.id || "");
    setCashAccountId(defaultCashAccountId || cashAccounts[0]?.id || "");
    setPropertyAssetId(detail?.propertyAssetId || propertyAssets[0]?.id || "");
    setName(detail?.propertyName || "");
    setPropertyType("");
    setAddress("");
    setTradeDate(todayYmd());
    setSettlementDate("");
    setAmount("");
    setFee("");
    setTax("");
    setMarketValue(detail?.currentMarketValue != null ? String(detail.currentMarketValue) : "");
    setNote("");
  }, [cashAccounts, defaultCashAccountId, defaultPropertyAccountId, propertyAccounts, propertyAssets]);

  useEffect(() => {
    function onCreate(event: Event) {
      resetTransactionDraft((event as CustomEvent<PropertyCreateEventDetail>).detail ?? {});
      setOpen(true);
    }
    function onValuation(event: Event) {
      resetValuationDraft((event as CustomEvent<PropertyValuationEventDetail>).detail ?? {});
      setOpen(true);
    }
    window.addEventListener("mmh:property:create", onCreate);
    window.addEventListener("mmh:property:valuation", onValuation);
    return () => {
      window.removeEventListener("mmh:property:create", onCreate);
      window.removeEventListener("mmh:property:valuation", onValuation);
    };
  }, [resetTransactionDraft, resetValuationDraft]);

  const close = useCallback(() => {
    if (!submitting) setOpen(false);
  }, [submitting]);
  useCloseOnNavigation(open, () => setOpen(false));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    if (mode === "valuation") {
      if (!propertyAssetId) {
        window.alert("请选择房产");
        return;
      }
      if (parseAmount(marketValue) < 0 || !marketValue.trim()) {
        window.alert("请填写市值");
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch("/api/v1/properties/valuations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            propertyAssetId,
            valuationDate: tradeDate,
            marketValue,
            note: note.trim() || undefined,
          }),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !data?.ok) throw new Error(data?.error ?? "市值更新失败");
        if (requestId) window.dispatchEvent(new CustomEvent("mmh:property:valuation:success", { detail: { requestId } }));
        requestAnimationFrame(() => dispatchFinanceDataChanged({ reason: "property-valuation-save", accountIds: [propertyAccountId].filter(Boolean) }));
        setOpen(false);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "市值更新失败");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!propertyAccountId) {
      window.alert("请选择房产账户");
      return;
    }
    if (action !== "purchase" && !propertyAssetId) {
      window.alert("请选择房产");
      return;
    }
    if (action === "purchase" && !name.trim()) {
      window.alert("请填写房产名称");
      return;
    }
    if (parseAmount(amount) <= 0) {
      window.alert("请填写交易金额");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/v1/properties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: propertyAccountId,
          cashAccountId: cashAccountId || undefined,
          propertyAssetId: propertyAssetId || undefined,
          action,
          name: name.trim() || undefined,
          propertyType: propertyType.trim() || undefined,
          address: address.trim() || undefined,
          tradeDate,
          settlementDate: settlementDate || undefined,
          amount,
          fee: fee || undefined,
          tax: tax || undefined,
          marketValue: marketValue || undefined,
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; data?: { transaction?: { id?: string; cashEntryId?: string | null } | null } } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "房产交易保存失败");
      if (requestId) window.dispatchEvent(new CustomEvent("mmh:property:create:success", { detail: { requestId } }));
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "property-transaction-save",
          accountIds: Array.from(new Set([propertyAccountId, cashAccountId].filter(Boolean))),
          entryIds: [data.data?.transaction?.cashEntryId ?? "", data.data?.transaction?.id ?? ""].filter(Boolean),
        });
      });
      setOpen(false);
      resetTransactionDraft();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "房产交易保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="app-modal-backdrop z-[1000]">
      <div className="app-modal-panel max-w-[min(34rem,calc(100vw-1rem))]">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="modal-header">
            <div className="text-sm font-semibold text-slate-800">{mode === "valuation" ? "更新房产市值" : "房产交易"}</div>
            <button type="button" onClick={close} className="secondary-button h-8 px-2" title="关闭">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:px-5 sm:py-4">
            {mode === "transaction" ? (
              <div className="grid grid-cols-3 gap-2">
                {([
                  ["purchase", "购入"],
                  ["improvement", "装修投入"],
                  ["sale", "出售"],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setAction(key)}
                    className={`h-8 rounded-[10px] border px-2 text-xs ${action === key ? "border-blue-200 bg-blue-50 font-medium text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="form-label">房产账户</div>
                <SmartSelect
                  mode="single"
                  value={propertyAccountId}
                  onChange={setPropertyAccountId}
                  options={propertyOptions}
                  placeholder="选择房产账户"
                  behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
                />
              </div>
              {mode === "transaction" ? (
                <div className="space-y-1">
                  <div className="form-label">资金账户</div>
                  <SmartSelect
                    mode="single"
                    value={cashAccountId}
                    onChange={setCashAccountId}
                    options={cashOptions}
                    placeholder="选择资金账户"
                    behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
                  />
                </div>
              ) : null}
            </div>

            {action === "purchase" && mode === "transaction" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="form-label">房产名称</div>
                  <input value={name} onChange={(event) => setName(event.target.value)} className="form-input" placeholder="例如：XX小区 1 号楼" />
                </div>
                <div className="space-y-1">
                  <div className="form-label">房产类型</div>
                  <input value={propertyType} onChange={(event) => setPropertyType(event.target.value)} className="form-input" placeholder="住宅 / 商铺 / 车位" />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <div className="form-label">地址</div>
                  <input value={address} onChange={(event) => setAddress(event.target.value)} className="form-input" placeholder="可选" />
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="form-label">房产</div>
                <SmartSelect
                  mode="single"
                  value={propertyAssetId}
                  onChange={(value) => {
                    setPropertyAssetId(value);
                    const asset = propertyAssets.find((item) => item.id === value);
                    if (asset?.marketValue != null && mode === "valuation") setMarketValue(String(asset.marketValue));
                  }}
                  options={assetOptions}
                  placeholder="选择房产"
                  behavior={{ search: true, density: "compact", minDropdownWidth: 280 }}
                />
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="form-label">{mode === "valuation" ? "估值日期" : "交易日期"}</div>
                <DateStepper value={tradeDate} onChange={setTradeDate} />
              </div>
              {mode === "transaction" && action === "sale" ? (
                <div className="space-y-1">
                  <div className="form-label">交割日期</div>
                  <DateStepper value={settlementDate || tradeDate} onChange={(value) => setSettlementDate(value === tradeDate ? "" : value)} />
                </div>
              ) : null}
            </div>

            {mode === "transaction" ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <div className="form-label">{action === "sale" ? "出售金额" : action === "improvement" ? "投入金额" : "购入金额"}</div>
                  <CalcInput value={amount} onChange={setAmount} placeholder="金额" label="金额" precision={2} />
                </div>
                <div className="space-y-1">
                  <div className="form-label">手续费</div>
                  <CalcInput value={fee} onChange={setFee} placeholder="可选" label="手续费" precision={2} />
                </div>
                <div className="space-y-1">
                  <div className="form-label">税费</div>
                  <CalcInput value={tax} onChange={setTax} placeholder="可选" label="税费" precision={2} />
                </div>
              </div>
            ) : null}

            <div className="space-y-1">
              <div className="form-label">{mode === "valuation" ? "最新市值" : "交易后市值"}</div>
              <CalcInput value={marketValue} onChange={setMarketValue} placeholder={mode === "valuation" ? "手动更新市值" : "可选，默认按成本"} label="市值" precision={2} />
            </div>

            <div className="space-y-1">
              <div className="form-label">备注</div>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} className="form-input min-h-[72px] resize-none py-2" placeholder="可选" />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 p-3 sm:px-5">
            <button type="button" onClick={close} className="secondary-button" disabled={submitting}>取消</button>
            <button type="submit" className="primary-button" disabled={submitting}>{submitting ? "保存中..." : "保存"}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
