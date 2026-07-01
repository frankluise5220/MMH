"use client";

import { ChevronDown, Plus, Repeat } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./TransactionFormModal";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";

type DebtMode = "borrow_in" | "repay_out" | "lend_out" | "collect_in";

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
};

const MODE_LABELS: Record<DebtMode, string> = {
  borrow_in: "借入",
  repay_out: "还款",
  lend_out: "借出",
  collect_in: "收回",
};

export function DebtTransactionModal({
  debtAccounts,
  cashAccounts,
  cashAccountSSOptions,
  defaultDebtAccountId,
  defaultCashAccountId,
  action,
  showTriggerButton = true,
}: {
  debtAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  defaultDebtAccountId?: string;
  defaultCashAccountId?: string;
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  showTriggerButton?: boolean;
}) {
  const router = useRouter();
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const debtOptions: SmartSelectOption[] = useMemo(
    () => debtAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel })),
    [debtAccounts],
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
  const [mode, setMode] = useState<DebtMode>("borrow_in");
  const [date, setDate] = useState(today);
  const [debtAccountId, setDebtAccountId] = useState(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [interest, setInterest] = useState("");
  const [note, setNote] = useState("");

  const resetDraft = useCallback(() => {
    setMode("borrow_in");
    setDate(today);
    setDebtAccountId(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
    setCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setPrincipal("");
    setInterest("");
    setNote("");
  }, [cashAccounts, debtAccounts, defaultCashAccountId, defaultDebtAccountId, today]);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId?: string;
        defaultDebtAccountId?: string;
        defaultCashAccountId?: string;
      }>).detail;
      resetDraft();
      if (detail?.defaultDebtAccountId) setDebtAccountId(detail.defaultDebtAccountId);
      if (detail?.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      setOpen(true);
    }
    window.addEventListener("mmh:debt:create", onCreate as EventListener);
    return () => window.removeEventListener("mmh:debt:create", onCreate as EventListener);
  }, [defaultCashAccountId, defaultDebtAccountId, resetDraft]);
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  async function saveDebtTransaction(keepAdding: boolean) {
    if (submitting) return;

    const formData = new FormData();
    formData.set("mode", mode);
    formData.set("date", date);
    formData.set("debtAccountId", debtAccountId);
    formData.set("cashAccountId", cashAccountId);
    formData.set("principal", principal);
    formData.set("interest", interest);
    formData.set("note", note);

    setSubmitting(true);
    try {
      const res = await action(formData);
      if (!res.ok) {
        window.alert(res.error);
        return;
      }
      router.refresh();
      if (keepAdding) {
        setPrincipal("");
        setInterest("");
        setNote("");
      } else {
        setOpen(false);
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

  const showInterest = mode === "repay_out" || mode === "collect_in";
  const disabled = debtAccounts.length === 0 || cashAccounts.length === 0;

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
          借还款
          <ChevronDown className="w-4 h-4 opacity-90" />
        </button>
      ) : null}

      {open
        ? createPortal(
            <div className="app-modal-backdrop z-50">
              <div className="app-modal-panel max-w-xl">
                  <div className="modal-header shrink-0">
                    <div className="text-sm font-semibold text-slate-800">借还款</div>
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

                  <form className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onSubmit={onSubmit}>
                    <div className="grid grid-cols-4 gap-2">
                      {(Object.keys(MODE_LABELS) as DebtMode[]).map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setMode(item)}
                          className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                        >
                          {MODE_LABELS[item]}
                        </button>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <div className="form-label">日期</div>
                        <input
                          name="date"
                          type="date"
                          value={date}
                          onChange={(e) => setDate(e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">往来对象账户</div>
                        <SmartSelect
                          mode="single"
                          value={debtAccountId}
                          onChange={setDebtAccountId}
                          options={debtOptions}
                          placeholder="请选择"
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="form-label">资金账户</div>
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

                    <div className={`grid gap-3 ${showInterest ? "grid-cols-2" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{mode === "repay_out" || mode === "collect_in" ? "本金" : "金额"}</div>
                        <CalcInput value={principal} onChange={setPrincipal} placeholder="例如：1000" label="金额" precision={2} />
                      </div>
                      {showInterest ? (
                        <div className="space-y-1">
                          <div className="form-label">利息</div>
                          <CalcInput value={interest} onChange={setInterest} placeholder="可选，例如：23.5" label="利息" precision={2} />
                        </div>
                      ) : null}
                    </div>

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
                      {mode === "borrow_in"
                        ? "借入会把金额记到资金账户，同时形成借入余额。"
                        : mode === "repay_out"
                          ? "还款会冲减借入本金；如填写利息，会另外记一笔利息支出。"
                          : mode === "lend_out"
                            ? "借出会从资金账户转出，同时形成借出余额。"
                            : "收回会冲减借出本金；如填写利息，会另外记一笔利息收入。"}
                    </div>

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
    </>
  );
}
