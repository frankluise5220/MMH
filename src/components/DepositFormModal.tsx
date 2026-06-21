"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
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
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

export function DepositFormModal({
  mode = "create",
  accountId: defaultAccountId,
  entry,
  cashAccounts = [],
  investmentAccounts = [],
  cashAccountSSOptions,
  investmentAccountSSOptions,
  nestedFieldData,
  createAction,
  editAction,
}: {
  mode?: "create" | "edit";
  accountId: string;
  entry?: Entry;
  cashAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  investmentAccounts?: { id: string; label: string; icon?: string; subLabel?: string }[];
  /** Hierarchical SmartSelect options for cash account dropdown (grouped by AccountGroup) */
  cashAccountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for investment account dropdown (grouped by AccountGroup) */
  investmentAccountSSOptions?: SmartSelectOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const initIsRedeem = mode === "edit" && entry ? entry.amount > 0 : false;
  const initAmount = mode === "edit" && entry ? String(Math.abs(entry.amount)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initName = mode === "edit" && entry?.fundName ? entry.fundName : "";
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";

  const initCashAccountId = mode === "edit" && entry
    ? (initIsRedeem ? (entry.toAccountId ?? "") : (entry.accountId ?? ""))
    : "";
  const initToAccountId = mode === "edit" && entry
    ? (initIsRedeem ? (entry.accountId ?? defaultAccountId) : (entry.toAccountId ?? defaultAccountId))
    : defaultAccountId;

  const [open, setOpen] = useState(false);
  const [subtype, setSubtype] = useState<"buy" | "redeem">(initIsRedeem ? "redeem" : "buy");
  const [date, setDate] = useState(initDate);
  const [amount, setAmount] = useState(initAmount);
  const [fundName, setFundName] = useState(initName);
  const [annualRate, setAnnualRate] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [termDays, setTermDays] = useState("");
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [toAccountId, setToAccountId] = useState(initToAccountId);
  const [memo, setMemo] = useState(initMemo);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);

  // Mutable account lists for NestedAddModal onCreated updates
  const [cashAccountList, setCashAccountList] = useState(cashAccounts);
  const [investmentAccountList, setInvestmentAccountList] = useState(investmentAccounts);
  // Mutable SS options — onCreated appends new account to these too
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [localInvestSSOpts, setLocalInvestSSOpts] = useState(investmentAccountSSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "invest-account" | null>(null);

  useEffect(() => { setCashAccountList(cashAccounts); }, [cashAccounts]);
  useEffect(() => { setInvestmentAccountList(investmentAccounts); }, [investmentAccounts]);
  useEffect(() => { setLocalCashSSOpts(cashAccountSSOptions); }, [cashAccountSSOptions]);
  useEffect(() => { setLocalInvestSSOpts(investmentAccountSSOptions); }, [investmentAccountSSOptions]);

  function reset() {
    setSubtype("buy");
    setDate(today);
    setAmount("");
    setFundName("");
    setAnnualRate("");
    setMinAmount("");
    setTermDays("");
    setCashAccountId("");
    setToAccountId(defaultAccountId);
    setMemo("");
    setRequestId(null);
  }

  useEffect(() => {
    function onEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string; entryId: string;
        type: string; date: string; amount: number; note: string;
        accountId?: string; toAccountId?: string;
        fundName?: string; fundSubtype?: string;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setSubtype(detail.fundSubtype === "redeem" ? "redeem" : "buy");
      setDate(detail.date || today);
      setAmount(detail.amount > 0 ? String(detail.amount) : "");
      setFundName(detail.fundName ?? "");
      setMemo(detail.note ?? "");
      setCashAccountId(detail.fundSubtype === "redeem" ? (detail.toAccountId ?? "") : (detail.accountId ?? ""));
      setToAccountId(detail.fundSubtype === "redeem" ? (detail.accountId ?? defaultAccountId) : (detail.toAccountId ?? defaultAccountId));
      setOpen(true);
    }
    window.addEventListener("mmh:deposit:edit", onEdit as EventListener);
    return () => window.removeEventListener("mmh:deposit:edit", onEdit as EventListener);
  }, [defaultAccountId, today]);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{ requestId: string; defaultCashAccountId?: string }>).detail;
      setRequestId(detail?.requestId ?? null);
      setCashAccountId(detail?.defaultCashAccountId ?? "");
      reset();
      setDate(today);
      setToAccountId(defaultAccountId);
      setOpen(true);
    }
    window.addEventListener("mmh:deposit:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:deposit:create", onCreate as EventListener);
  }, [defaultAccountId, today]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const amt = parseNumber(amount);
    if (amt <= 0) { window.alert("请输入金额"); return; }
    if (!fundName.trim()) { window.alert("请输入产品名称"); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.set("type", "investment");
      fd.set("subtype", subtype);
      fd.set("productType", "deposit");
      fd.set("date", date);
      fd.set("amount", String(subtype === "redeem" ? amt : -amt));
      fd.set("fundName", fundName.trim());
      fd.set("note", memo);
      fd.set("accountId", toAccountId);
      fd.set("cashAccountId", cashAccountId);
      if (mode === "edit" && (entry?.id || editEntryId)) {
        fd.set("entryId", entry?.id || editEntryId || "");
        fd.set("fundProductType", "deposit");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: "缺少 editAction" };
        if (!res.ok) throw new Error(res.error ?? "保存失败");
        window.dispatchEvent(new CustomEvent("mmh:deposit:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", "deposit");
        const res = await createAction(fd);
        if (!res.ok) throw new Error(res.error ?? "记账失败");
      }
      setOpen(false);
      if (mode === "create") reset();
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("mmh:fund:refresh"));
      });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const isRedeem = subtype === "redeem";

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 p-4 backdrop-blur-[2px]">
      <div className="modal-surface w-full max-w-md">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">
            {mode === "edit" ? "编辑存款记录" : "新增存款记录"}
            <span className="ml-2 text-xs font-normal text-slate-500">活期/存款</span>
          </div>
          <button type="button" onClick={() => { setOpen(false); if (mode === "create") reset(); }}
            className="secondary-button h-8 px-2">关闭</button>
        </div>

        <form className="p-4 space-y-3 overflow-y-auto max-h-[80vh]" onSubmit={onSubmit}>
          <div className="flex gap-2">
            <button type="button" onClick={() => setSubtype("buy")}
              className={`segment-button h-8 flex-1 text-xs ${subtype === "buy" ? "segment-button-active font-medium" : ""}`}>
              存入
            </button>
            <button type="button" onClick={() => setSubtype("redeem")}
              className={`segment-button h-8 flex-1 text-xs ${subtype === "redeem" ? "segment-button-active font-medium" : ""}`}>
              取出
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="form-label">日期</div>
              <DateStepper value={date} onChange={setDate} />
            </div>
            <div className="space-y-1">
              <div className="form-label">{isRedeem ? "取出金额" : "存入金额"}</div>
              <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={isRedeem ? "取出" : "存入"} />
            </div>
          </div>

          <div className="space-y-1">
            <div className="form-label">产品名称</div>
            <input value={fundName} onChange={(e) => setFundName(e.target.value)} placeholder="例如：余额宝"
              className="form-input" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="form-label">年化利率（%）</div>
              <input inputMode="decimal" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} placeholder="如：2.5"
                className="form-input" />
            </div>
            <div className="space-y-1">
              <div className="form-label">期限天数</div>
              <input inputMode="numeric" value={termDays} onChange={(e) => setTermDays(e.target.value)} placeholder="如：30"
                className="form-input" />
            </div>
          </div>

          <div className="space-y-1">
            <div className="form-label">最低金额</div>
            <input inputMode="decimal" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="如：1"
              className="form-input" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="form-label">{isRedeem ? "到账账户" : "资金来源账户"}</div>
              <SmartSelect mode="single" value={cashAccountId} onChange={setCashAccountId}
                options={localCashSSOpts ?? cashAccountList} placeholder="选择账户"
                onCreateClick={() => setNestedEntityType("cash-account")} createLabel="新增账户" />
            </div>
            <div className="space-y-1">
              <div className="form-label">{isRedeem ? "取出账户" : "存入账户"}</div>
              <SmartSelect mode="single" value={toAccountId} onChange={setToAccountId}
                options={localInvestSSOpts ?? investmentAccountList} placeholder="选择投资账户"
                onCreateClick={() => setNestedEntityType("invest-account")} createLabel="新增账户" />
            </div>
          </div>

          <div className="space-y-1">
            <div className="form-label">备注</div>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="可选"
              className="form-input" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="submit" disabled={submitting}
              className={`h-9 px-4 rounded-[10px] text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : "primary-button"}`}>
              {submitting ? "保存中…" : mode === "edit" ? "保存修改" : isRedeem ? "记账（取出）" : "记账（存入）"}
            </button>
          </div>
        </form>
      </div>
    </div>
    {nestedEntityType && createPortal(
      <NestedAddModal mode="compact" entityType="account" open={true}
        onClose={() => setNestedEntityType(null)}
        onCreated={(id, name, extra) => {
          const kind = extra?.kind || "investment";
          setCashAccountList(prev => [...prev, { id, label: name, subLabel: kindLabel("bank_debit") }]);
          setInvestmentAccountList(prev => [...prev, { id, label: name, subLabel: kindLabel(kind) }]);
          setLocalCashSSOpts(prev => prev ? [...prev, { id, label: name, subLabel: kindLabel("bank_debit") }] : prev);
          setLocalInvestSSOpts(prev => prev ? [...prev, { id, label: name, subLabel: kindLabel(kind) }] : prev);
          if (nestedEntityType === "cash-account") setCashAccountId(id);
          else setToAccountId(id);
          setNestedEntityType(null);
        }}
        extraFields={{ kind: nestedEntityType === "cash-account" ? "bank_debit" : "investment", investProductType: "deposit" }}
        hiddenFields={["kind"]}
        nestedFieldData={nestedFieldData}
      />,
      document.body,
    )}
    </>
  );
}
