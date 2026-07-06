"use client";

import { Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { batchReplaceEntries, type BatchReplaceField } from "@/lib/client/batchReplaceEntries";

type SelectionContextValue = {
  selectedIds: Set<string>;
  toggleOne: (id: string) => void;
  toggleAll: (ids: string[]) => void;
  setSelection: (ids: Set<string>) => void;
  clear: () => void;
  deleteMessage: string;
  setDeleteMessage: (msg: string) => void;
};

type AccountOption = { id: string; label: string };

const fieldLabels: Record<BatchReplaceField, string> = {
  date: "日期",
  type: "类型",
  account: "来源账户",
  toAccount: "去向账户",
  remark: "备注",
};

const typeOptions = [
  { value: "", label: "选择类型" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "转账" },
  { value: "investment", label: "投资" },
];

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function useBasicDetailSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("BasicDetailSelection components must be used inside BasicDetailSelectionProvider");
  return ctx;
}

export function BasicDetailSelectionProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey?: string;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteMessage, setDeleteMessage] = useState<string>("");

  useEffect(() => {
    setSelectedIds(new Set());
    setDeleteMessage("");
  }, [resetKey]);

  const value = useMemo<SelectionContextValue>(() => ({
    selectedIds,
    deleteMessage,
    toggleOne: (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll: (ids: string[]) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
        ids.forEach((id) => {
          if (allSelected) next.delete(id);
          else next.add(id);
        });
        return next;
      });
    },
    setSelection: (ids: Set<string>) => setSelectedIds(new Set(ids)),
    clear: () => {
      setSelectedIds(new Set());
      setDeleteMessage("");
    },
    setDeleteMessage,
  }), [selectedIds, deleteMessage]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function BasicDetailSelectAll({ ids }: { ids: string[] }) {
  const { selectedIds, toggleAll } = useBasicDetailSelection();
  const checked = ids.length > 0 && ids.every((id) => selectedIds.has(id));
  const indeterminate = !checked && ids.some((id) => selectedIds.has(id));

  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(input) => {
        if (input) input.indeterminate = indeterminate;
      }}
      onChange={() => toggleAll(ids)}
      className="h-3.5 w-3.5 accent-blue-600"
      aria-label="选择当前页全部基础交易"
    />
  );
}

export function BasicDetailRowCheckbox({ id }: { id: string }) {
  const { selectedIds, toggleOne } = useBasicDetailSelection();

  return (
    <input
      type="checkbox"
      checked={selectedIds.has(id)}
      onChange={() => toggleOne(id)}
      className="h-3.5 w-3.5 accent-blue-600"
      aria-label="选择基础交易明细"
    />
  );
}

export function BasicDetailBatchReplaceButton({ accountOptions }: { accountOptions: AccountOption[] }) {
  const { selectedIds, clear } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const fields = useMemo<BatchReplaceFieldConfig<BatchReplaceField>[]>(() => [
    { value: "date", label: fieldLabels.date, kind: "date" },
    { value: "type", label: fieldLabels.type, kind: "select", options: typeOptions },
    {
      value: "account",
      label: fieldLabels.account,
      kind: "smartSelect",
      options: [{ value: "", label: "选择账户" }, ...accountOptions.map((account) => ({ value: account.id, label: account.label }))],
    },
    {
      value: "toAccount",
      label: fieldLabels.toAccount,
      kind: "smartSelect",
      options: [{ value: "", label: "选择账户" }, ...accountOptions.map((account) => ({ value: account.id, label: account.label }))],
    },
    { value: "remark", label: fieldLabels.remark, kind: "text", placeholder: "输入替换内容，可留空清除备注", allowEmpty: true },
  ], [accountOptions]);

  async function applyReplace(field: BatchReplaceField, value: string) {
    const result = await batchReplaceEntries({ ids: Array.from(selectedIds), field, value });
    if (!result.ok) throw new Error(result.error ?? "批量替换失败");
    clear();
    window.dispatchEvent(new Event("mmh:fund:refresh"));
    return `已替换 ${result.updatedCount ?? 0} 条记录`;
  }

  return (
    <BatchReplacePopoverButton
      fields={fields}
      targetCount={selectedCount}
      targetLabel="已选"
      onApply={applyReplace}
    />
  );
}

export function BasicDetailBatchDeleteButton() {
  const { selectedIds, clear, setDeleteMessage } = useBasicDetailSelection();
  const [submitting, setSubmitting] = useState(false);
  const selectedCount = selectedIds.size;
  const disabled = selectedCount === 0 || submitting;

  async function applyDelete() {
    if (disabled) return;
    const entryIds = Array.from(selectedIds);
    if (!window.confirm(`确认删除已选 ${entryIds.length} 条资金明细？删除后会进入回收站。`)) return;

    setSubmitting(true);
    setDeleteMessage("");
    try {
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "批量删除失败" }));
      if (!res.ok || !data.ok) {
        setDeleteMessage(data.error ?? "批量删除失败");
        return;
      }
      setDeleteMessage(data.message ?? `已删除 ${entryIds.length} 条记录`);
      clear();
      window.dispatchEvent(new CustomEvent("mmh:fund:refresh", { detail: { deletedEntryIds: entryIds } }));
    } catch {
      setDeleteMessage("批量删除失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={applyDelete}
      disabled={disabled}
      className="h-8 w-8 rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
      title={selectedCount === 0 ? "请先勾选记录" : `批量删除已选 ${selectedCount} 条记录`}
      aria-label={selectedCount === 0 ? "请先勾选记录再批量删除" : `批量删除已选 ${selectedCount} 条记录`}
    >
      <Trash2 className="w-4 h-4" />
    </button>
  );
}


export function BasicDetailBatchDeleteMessage() {
  const { deleteMessage } = useBasicDetailSelection();
  if (!deleteMessage) return null;
  return (
    <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 text-xs text-rose-600">
      {deleteMessage}
    </div>
  );
}
