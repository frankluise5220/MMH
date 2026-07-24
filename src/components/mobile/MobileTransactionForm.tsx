"use client";

import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

type AccountOption = { id: string; name: string; kind: string };
type CategoryOption = { id: string; name: string; type: string };
type TransactionDraft = {
  id?: string;
  date: string;
  amount: string;
  type: "expense" | "income" | "transfer";
  accountId: string;
  toAccountId: string;
  categoryId: string;
  note: string;
};

type Props = {
  accounts: AccountOption[];
  categories: CategoryOption[];
  defaultAccountId?: string;
};

const EMPTY_DRAFT: TransactionDraft = {
  date: new Date().toISOString().slice(0, 10),
  amount: "",
  type: "expense",
  accountId: "",
  toAccountId: "",
  categoryId: "",
  note: "",
};

export function MobileTransactionForm({ accounts, categories, defaultAccountId = "" }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TransactionDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const availableCategories = useMemo(
    () => categories.filter((category) => category.type === draft.type),
    [categories, draft.type],
  );

  useEffect(() => {
    const openCreate = () => {
      setDraft({ ...EMPTY_DRAFT, accountId: defaultAccountId || accounts[0]?.id || "" });
      setError("");
      setOpen(true);
    };
    const openEdit = async (event: Event) => {
      const entryId = (event as CustomEvent<{ entryId?: string }>).detail?.entryId?.trim();
      if (!entryId) return;
      setError("");
      try {
        const response = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(entryId)}`);
        const result = await response.json().catch(() => null);
        const entry = result?.data;
        if (!response.ok || !result?.ok || !entry) throw new Error(result?.error ?? "读取流水失败");
        if (entry.type !== "expense" && entry.type !== "income" && entry.type !== "transfer") {
          throw new Error("投资、存款和保险流水请从对应业务页面编辑");
        }
        setDraft({
          id: entry.id,
          date: String(entry.date ?? "").slice(0, 10),
          amount: String(Math.abs(Number(entry.amount) || 0)),
          type: entry.type,
          accountId: entry.accountId ?? "",
          toAccountId: entry.toAccountId ?? "",
          categoryId: entry.categoryId ?? "",
          note: entry.note ?? "",
        });
        setOpen(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "读取流水失败");
      }
    };
    window.addEventListener("mmh:create-transaction:open", openCreate);
    window.addEventListener("mmh:mobile-transaction:edit", openEdit);
    return () => {
      window.removeEventListener("mmh:create-transaction:open", openCreate);
      window.removeEventListener("mmh:mobile-transaction:edit", openEdit);
    };
  }, [accounts, defaultAccountId]);

  function close() {
    if (!saving) setOpen(false);
  }

  function update<K extends keyof TransactionDraft>(key: K, value: TransactionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    const amount = Number(draft.amount);
    if (!draft.date || !Number.isFinite(amount) || amount <= 0 || !draft.accountId) {
      setError("请填写日期、金额和账户");
      return;
    }
    if (draft.type === "transfer" && !draft.toAccountId) {
      setError("请选择转入账户");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const body = {
        ...(draft.id ? { id: draft.id } : {}),
        date: draft.date,
        amount,
        type: draft.type,
        accountId: draft.accountId,
        toAccountId: draft.type === "transfer" ? draft.toAccountId : undefined,
        categoryId: draft.type === "transfer" ? undefined : draft.categoryId || undefined,
        note: draft.note.trim() || undefined,
      };
      const response = await fetch("/api/v1/transactions/detail", {
        method: draft.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error ?? "保存失败");
      setOpen(false);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-end bg-slate-950/30" role="dialog" aria-modal="true" aria-label={draft.id ? "编辑流水" : "记一笔"}>
      <div className="w-full rounded-t-2xl bg-white px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" />
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">{draft.id ? "编辑流水" : "记一笔"}</h2>
          <button type="button" onClick={close} className="flex h-10 w-10 items-center justify-center text-slate-500" aria-label="关闭">
            <X size={20} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
          {(["expense", "income", "transfer"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => update("type", type)}
              className={`h-10 rounded-md text-sm font-medium ${draft.type === type ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500"}`}
            >
              {type === "expense" ? "支出" : type === "income" ? "收入" : "转账"}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-slate-500">日期</span>
            <input className="form-input mt-1" type="date" value={draft.date} onChange={(event) => update("date", event.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">金额</span>
            <input className="form-input mt-1 text-right tabular-nums" inputMode="decimal" type="number" min="0" step="0.01" placeholder="0.00" value={draft.amount} onChange={(event) => update("amount", event.target.value)} />
          </label>
        </div>

        <label className="mt-3 block">
          <span className="text-xs text-slate-500">{draft.type === "transfer" ? "转出账户" : "账户"}</span>
          <select className="form-input mt-1" value={draft.accountId} onChange={(event) => update("accountId", event.target.value)}>
            <option value="">请选择账户</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>

        {draft.type === "transfer" ? (
          <label className="mt-3 block">
            <span className="text-xs text-slate-500">转入账户</span>
            <select className="form-input mt-1" value={draft.toAccountId} onChange={(event) => update("toAccountId", event.target.value)}>
              <option value="">请选择账户</option>
              {accounts.filter((account) => account.id !== draft.accountId).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </label>
        ) : (
          <label className="mt-3 block">
            <span className="text-xs text-slate-500">分类</span>
            <select className="form-input mt-1" value={draft.categoryId} onChange={(event) => update("categoryId", event.target.value)}>
              <option value="">未分类</option>
              {availableCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
        )}

        <label className="mt-3 block">
          <span className="text-xs text-slate-500">备注</span>
          <input className="form-input mt-1" value={draft.note} onChange={(event) => update("note", event.target.value)} placeholder="可选" />
        </label>
        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
        <button type="button" disabled={saving} onClick={save} className="primary-button mt-4 h-11 w-full disabled:opacity-60">
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

export function openMobileTransactionEdit(entryId: string) {
  window.dispatchEvent(new CustomEvent("mmh:mobile-transaction:edit", { detail: { entryId } }));
}
