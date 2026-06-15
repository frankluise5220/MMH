"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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

export function WealthFormModal({
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
  const router = useRouter();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const initIsRedeem = mode === "edit" && entry ? entry.amount > 0 : false;
  const initAmount = mode === "edit" && entry ? String(Math.abs(entry.amount)) : "";
  const initDate = mode === "edit" && entry?.date ? entry.date.slice(0, 10) : today;
  const initName = mode === "edit" && entry?.fundName ? entry.fundName : "";
  const initMemo = mode === "edit" && entry?.note ? entry.note : "";

  // 编辑模式确定资金/投资账户
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
  const [termDays, setTermDays] = useState("");
  const [minAmount, setMinAmount] = useState("");
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
    setTermDays("");
    setMinAmount("");
    setCashAccountId("");
    setToAccountId(defaultAccountId);
    setMemo("");
    setRequestId(null);
  }

  // Listen for edit event
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
    window.addEventListener("wiseme:wealth:edit", onEdit as EventListener);
    return () => window.removeEventListener("wiseme:wealth:edit", onEdit as EventListener);
  }, [defaultAccountId, today]);

  // Listen for create event
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
    window.addEventListener("wiseme:wealth:create", onCreate as EventListener);
    return () => window.removeEventListener("wiseme:wealth:create", onCreate as EventListener);
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
      fd.set("productType", "wealth");
      fd.set("date", date);
      fd.set("amount", String(subtype === "redeem" ? amt : -amt));
      fd.set("fundName", fundName.trim());
      fd.set("note", memo);
      fd.set("accountId", toAccountId);
      fd.set("cashAccountId", cashAccountId);
      if (mode === "edit" && (entry?.id || editEntryId)) {
        fd.set("entryId", entry?.id || editEntryId || "");
        fd.set("fundProductType", "wealth");
        const res = editAction ? await editAction(fd) : { ok: false as const, error: "缺少 editAction" };
        if (!res.ok) throw new Error(res.error ?? "保存失败");
        window.dispatchEvent(new CustomEvent("wiseme:wealth:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", "wealth");
        const res = await createAction(fd);
        if (!res.ok) throw new Error(res.error ?? "记账失败");
      }
      setOpen(false);
      if (mode === "create") reset();
      await new Promise(resolve => setTimeout(resolve, 300));
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  function openCreate(cashAccId?: string) {
    setCashAccountId(cashAccId ?? "");
    reset();
    setDate(today);
    setToAccountId(defaultAccountId);
    setOpen(true);
  }

  if (!open) return null;

  const isRedeem = subtype === "redeem";

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">
            {mode === "edit" ? "编辑理财记录" : "新增理财记录"}
            <span className="ml-2 text-xs font-normal text-slate-500">银行理财</span>
          </div>
          <button type="button" onClick={() => { setOpen(false); if (mode === "create") reset(); }}
            className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">关闭</button>
        </div>

        <form className="p-4 space-y-3 overflow-y-auto max-h-[80vh]" onSubmit={onSubmit}>
          {/* 交易类型 */}
          <div className="flex gap-2">
            <button type="button" onClick={() => setSubtype("buy")}
              className={`flex-1 h-8 rounded-md border text-xs ${subtype === "buy" ? "bg-blue-50 text-blue-700 border-blue-200 font-medium" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
              存入
            </button>
            <button type="button" onClick={() => setSubtype("redeem")}
              className={`flex-1 h-8 rounded-md border text-xs ${subtype === "redeem" ? "bg-blue-50 text-blue-700 border-blue-200 font-medium" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"}`}>
              取出
            </button>
          </div>

          {/* 日期 + 金额 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">日期</div>
              <DateStepper value={date} onChange={setDate} />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{isRedeem ? "取出金额" : "存入金额"}</div>
              <CalcInput value={amount} onChange={setAmount} placeholder="0.00" label={isRedeem ? "取出" : "存入"} />
            </div>
          </div>

          {/* 产品名称 */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">产品名称</div>
            <input value={fundName} onChange={(e) => setFundName(e.target.value)} placeholder="例如：招行朝朝宝"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>

          {/* 年化收益率 + 期限天数 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">年化收益率（%）</div>
              <input inputMode="decimal" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} placeholder="如：3.5"
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">期限天数</div>
              <input inputMode="numeric" value={termDays} onChange={(e) => setTermDays(e.target.value)} placeholder="如：30"
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
            </div>
          </div>

          {/* 最低持有金额 */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">最低持有金额</div>
            <input inputMode="decimal" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="如：10000"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>

          {/* 资金账户 + 理财账户 */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{isRedeem ? "到账账户" : "资金来源账户"}</div>
              <SmartSelect mode="single" value={cashAccountId} onChange={setCashAccountId}
                options={localCashSSOpts ?? cashAccountList} placeholder="选择账户"
                onCreateClick={() => setNestedEntityType("cash-account")} createLabel="新增账户" />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">理财账户</div>
              <SmartSelect mode="single" value={toAccountId} onChange={setToAccountId}
                options={localInvestSSOpts ?? investmentAccountList} placeholder="选择理财账户"
                onCreateClick={() => setNestedEntityType("invest-account")} createLabel="新增账户" />
            </div>
          </div>

          {/* 备注 */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">备注</div>
            <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="可选"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="submit" disabled={submitting}
              className={`h-9 px-4 rounded-md text-white text-sm disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : "bg-blue-600 hover:bg-blue-700"}`}>
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
        extraFields={{ kind: nestedEntityType === "cash-account" ? "bank_debit" : "investment", investProductType: "wealth" }}
        hiddenFields={["kind"]}
        nestedFieldData={nestedFieldData}
      />,
      document.body,
    )}
    </>
  );
}
