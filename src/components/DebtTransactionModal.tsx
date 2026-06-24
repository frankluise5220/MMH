"use client";

import { ChevronDown, Plus } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";

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
  defaultDebtAccountId,
  defaultCashAccountId,
  action,
}: {
  debtAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  defaultDebtAccountId?: string;
  defaultCashAccountId?: string;
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const debtOptions: SmartSelectOption[] = useMemo(
    () => debtAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel })),
    [debtAccounts],
  );
  const cashOptions: SmartSelectOption[] = useMemo(
    () => cashAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel })),
    [cashAccounts],
  );

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<DebtMode>("borrow_in");
  const [date, setDate] = useState(today);
  const [debtAccountId, setDebtAccountId] = useState(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [interest, setInterest] = useState("");
  const [note, setNote] = useState("");

  function resetDraft() {
    setMode("borrow_in");
    setDate(today);
    setDebtAccountId(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
    setCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setPrincipal("");
    setInterest("");
    setNote("");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setOpen(false);
      resetDraft();
      window.location.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  const showInterest = mode === "repay_out" || mode === "collect_in";
  const disabled = debtAccounts.length === 0 || cashAccounts.length === 0;

  return (
    <>
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

      {open
        ? createPortal(
            <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/28 backdrop-blur-[2px]">
              <div className="flex min-h-full items-start justify-center p-4 py-8">
                <div className="modal-surface flex max-h-[90vh] w-full max-w-xl flex-col">
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

                  <form className="space-y-4 overflow-y-auto p-4" onSubmit={onSubmit}>
                    <div className="grid grid-cols-4 gap-2">
                      {(Object.keys(MODE_LABELS) as DebtMode[]).map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setMode(item)}
                          className={`segment-button h-9 ${
                            mode === item ? "segment-button-active" : ""
                          }`}
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
                        options={cashOptions}
                        placeholder="请选择"
                      />
                    </div>

                    <div className={`grid gap-3 ${showInterest ? "grid-cols-2" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{mode === "repay_out" || mode === "collect_in" ? "本金" : "金额"}</div>
                        <CalcInput value={principal} onChange={setPrincipal} placeholder="例如：1000" label="金额" />
                      </div>
                      {showInterest ? (
                        <div className="space-y-1">
                          <div className="form-label">利息</div>
                          <CalcInput value={interest} onChange={setInterest} placeholder="可选，例如：23.5" label="利息" />
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
                      <button type="submit" className="primary-button h-9 px-3" disabled={submitting}>
                        {submitting ? "保存中…" : "保存"}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
