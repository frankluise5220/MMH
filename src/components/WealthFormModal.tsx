"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { parseNumber } from "@/lib/investment-config";
import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { kindLabel } from "@/lib/account-kinds";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";

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
const TERM_PRESETS = [
  { label: "3个月", days: 90 },
  { label: "半年", days: 180 },
  { label: "1年", days: 365 },
  { label: "2年", days: 730 },
  { label: "3年", days: 1095 },
  { label: "5年", days: 1825 },
] as const;

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

  const { ownerFilterLabel: cfLabel, cycleOwnerFilter: cfCycle, filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOpts);
  const { ownerFilterLabel: ifLabel, cycleOwnerFilter: ifCycle, filteredOptions: investFiltered } = useAccountSSFilter(localInvestSSOpts);

  useEffect(() => { setCashAccountList(cashAccounts); }, [cashAccounts]);
  useEffect(() => { setInvestmentAccountList(investmentAccounts); }, [investmentAccounts]);
  useEffect(() => { setLocalCashSSOpts(cashAccountSSOptions); }, [cashAccountSSOptions]);
  useEffect(() => { setLocalInvestSSOpts(investmentAccountSSOptions); }, [investmentAccountSSOptions]);
  const recentAccountIds = useRecentAccountIds();

  function reset() {
    setSubtype("buy");
    setDate(today);
    setAmount("");
    setFundName("");
    setAnnualRate("");
    setTermDays("");
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
    window.addEventListener("mmh:wealth:edit", onEdit as EventListener);
    return () => window.removeEventListener("mmh:wealth:edit", onEdit as EventListener);
  }, [defaultAccountId, today]);

  // Listen for create event
  useEffect(() => {
    if (mode !== "create") return;

    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{ requestId: string; defaultCashAccountId?: string }>).detail;
      setRequestId(detail?.requestId ?? null);
      setCashAccountId(detail?.defaultCashAccountId ?? "");
      reset();
      setDate(today);
      setToAccountId(defaultAccountId);
      setOpen(true);
    }
    window.addEventListener("mmh:wealth:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:wealth:create", onCreate as EventListener);
  }, [defaultAccountId, mode, today]);

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
        window.dispatchEvent(new CustomEvent("mmh:wealth:edit:success", { detail: { requestId } }));
      } else {
        fd.set("fundProductType", "wealth");
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
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") reset();
  });
  if (!open) return null;

  const isRedeem = subtype === "redeem";

  return createPortal(
    <>
      <div className="app-modal-backdrop z-[1000]">
        <div className="app-modal-panel max-w-md">
          <div className="modal-header">
            <div className="text-sm font-semibold text-slate-800">
              {mode === "edit" ? "编辑理财记录" : "新增理财记录"}
              <span className="ml-2 text-xs font-normal text-slate-500">银行理财</span>
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

          <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSubtype("buy")}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "buy" ? "segment-button-active font-medium" : ""}`}
                >
                  存入
                </button>
                <button
                  type="button"
                  onClick={() => setSubtype("redeem")}
                  className={`segment-button h-8 flex-1 text-xs ${subtype === "redeem" ? "segment-button-active font-medium" : ""}`}
                >
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
                  <CalcInput
                    value={amount}
                    onChange={setAmount}
                    placeholder="0.00"
                    label={isRedeem ? "取出" : "存入"}
                    precision={2}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="form-label">产品名称</div>
                <input
                  value={fundName}
                  onChange={(e) => setFundName(e.target.value)}
                  placeholder="例如：招行朝朝宝"
                  className="form-input"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="form-label">年化收益率（%）</div>
                  <input
                    inputMode="decimal"
                    value={annualRate}
                    onChange={(e) => setAnnualRate(e.target.value)}
                    placeholder="如：3.5"
                    className="form-input"
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">期限天数</div>
                  <select
                    value={TERM_PRESETS.some((preset) => String(preset.days) === termDays) ? termDays : "__custom__"}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value !== "__custom__") setTermDays(value);
                    }}
                    className="form-input"
                  >
                    <option value="">请选择常见期限</option>
                    {TERM_PRESETS.map((preset) => (
                      <option key={preset.days} value={String(preset.days)}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="__custom__">自定义天数</option>
                  </select>
                  <input
                    inputMode="numeric"
                    value={termDays}
                    onChange={(e) => setTermDays(e.target.value)}
                    placeholder="可手填，如：30"
                    className="form-input"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="form-label">{isRedeem ? "到账账户" : "资金来源账户"}</div>
                  <SmartSelect
                    mode="single"
                    value={cashAccountId}
                    onChange={setCashAccountId}
                    options={sortOptionsByRecent(cashFiltered ?? cashAccountList, recentAccountIds)}
                    placeholder="选择账户"
                    onCreateClick={() => setNestedEntityType("cash-account")}
                    createLabel="新增账户"
                    onCycleOwnerFilter={cfCycle}
                    ownerFilterLabel={cfLabel}
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">理财账户</div>
                  <SmartSelect
                    mode="single"
                    value={toAccountId}
                    onChange={setToAccountId}
                    options={sortOptionsByRecent(investFiltered ?? investmentAccountList, recentAccountIds)}
                    placeholder="选择理财账户"
                    onCreateClick={() => setNestedEntityType("invest-account")}
                    createLabel="新增账户"
                    onCycleOwnerFilter={ifCycle}
                    ownerFilterLabel={ifLabel}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="form-label">备注</div>
                <input
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  placeholder="可选"
                  className="form-input"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submitting}
                  className={`h-9 rounded-[10px] px-4 text-sm text-white disabled:opacity-50 ${isRedeem ? "bg-orange-600 hover:bg-orange-700" : "primary-button"}`}
                >
                  {submitting ? "保存中…" : mode === "edit" ? "保存修改" : isRedeem ? "记账（取出）" : "记账（存入）"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
      {nestedEntityType ? (
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            const kind = extra?.kind || (nestedEntityType === "cash-account" ? "bank_debit" : "investment");
            const option = { id, label: name, subLabel: kindLabel(kind) };
            if (nestedEntityType === "cash-account") {
              setCashAccountList((prev) => [...prev, option]);
              setLocalCashSSOpts((prev) => (prev ? [...prev, option] : prev));
              setCashAccountId(id);
            } else {
              setInvestmentAccountList((prev) => [...prev, option]);
              setLocalInvestSSOpts((prev) => (prev ? [...prev, option] : prev));
              setToAccountId(id);
            }
            setNestedEntityType(null);
          }}
          extraFields={{
            kind: nestedEntityType === "cash-account" ? "bank_debit" : "investment",
            investProductType: "wealth",
          }}
          hiddenFields={["kind"]}
          nestedFieldData={nestedFieldData}
        />
      ) : null}
    </>,
    document.body,
  );
}


