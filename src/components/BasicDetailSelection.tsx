"use client";

import { Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
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

type AccountOption = { id: string; label: string; title?: string | null };
export type BasicDetailBatchCategoryOption = BatchReplaceOption;

const fieldLabels: Record<BatchReplaceField, string> = {
  date: "日期",
  type: "类型",
  account: "来源账户",
  toAccount: "对向账户",
  categoryId: "分类",
  remark: "备注",
};

const typeOptions = [
  { value: "", label: "选择类型" },
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "转账" },
  { value: "investment", label: "投资" },
];
const defaultBatchReplaceFields: BatchReplaceField[] = ["date", "type", "account", "toAccount", "categoryId", "remark"];

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

export function BasicDetailBatchReplaceButton({
  accountOptions,
  categoryOptions = [],
  fields = defaultBatchReplaceFields,
  targetLabel = "已选",
  contextAccountId,
}: {
  accountOptions: AccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  fields?: BatchReplaceField[];
  targetLabel?: string;
  contextAccountId?: string | null;
}) {
  const { selectedIds, clear } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const fieldConfigs = useMemo<BatchReplaceFieldConfig<BatchReplaceField>[]>(() => {
    const accountSelectOptions = [
      { value: "", label: "选择账户" },
      ...accountOptions.map((account) => ({ value: account.id, label: account.label, title: account.title ?? undefined })),
    ];
    const categorySelectOptions = [
      { value: "", label: "清除分类" },
      ...categoryOptions,
    ];
    const configByField: Record<BatchReplaceField, BatchReplaceFieldConfig<BatchReplaceField>> = {
      date: { value: "date", label: fieldLabels.date, kind: "date" },
      type: { value: "type", label: fieldLabels.type, kind: "select", options: typeOptions },
      account: {
        value: "account",
        label: fieldLabels.account,
        kind: "smartSelect",
        options: accountSelectOptions,
      },
      toAccount: {
        value: "toAccount",
        label: fieldLabels.toAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
      },
      categoryId: {
        value: "categoryId",
        label: fieldLabels.categoryId,
        kind: "smartSelect",
        options: categorySelectOptions,
        placeholder: "选择分类",
        allowEmpty: true,
        smartSelectBehavior: {
          hierarchy: true,
          search: true,
          initialCollapsedAll: true,
          accordionGroups: true,
          selectableGroups: true,
          groupSelectOnDoubleClick: false,
          minDropdownWidth: 560,
          dropdownMaxHeight: 420,
          density: "compact",
          expandedGroupColumns: 4,
        },
      },
      remark: { value: "remark", label: fieldLabels.remark, kind: "text", placeholder: "输入替换内容，可留空清除备注", allowEmpty: true },
    };
    return fields.map((field) => configByField[field]).filter(Boolean);
  }, [accountOptions, categoryOptions, fields]);

  async function applyReplace(field: BatchReplaceField, value: string) {
    const entryIds = Array.from(selectedIds);
    const result = await batchReplaceEntries({ ids: entryIds, field, value, contextAccountId });
    if (!result.ok) throw new Error(result.error ?? "批量替换失败");
    clear();
    dispatchFinanceDataChanged({ reason: "entry-batch-replace", entryIds });
    return `已替换 ${result.updatedCount ?? 0} 条记录`;
  }

  return (
    <BatchReplacePopoverButton
      fields={fieldConfigs}
      targetCount={selectedCount}
      targetLabel={targetLabel}
      buttonClassName="flex h-6 w-6 items-center justify-center rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
      onApply={applyReplace}
    />
  );
}

export function BasicDetailBatchDeleteButton({ recordLabel = "资金明细" }: { recordLabel?: string }) {
  const { selectedIds, clear, setDeleteMessage } = useBasicDetailSelection();
  const [submitting, setSubmitting] = useState(false);
  const selectedCount = selectedIds.size;
  const disabled = selectedCount === 0 || submitting;

  async function applyDelete() {
    if (disabled) return;
    const entryIds = Array.from(selectedIds);

    setSubmitting(true);
    setDeleteMessage("");
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds,
        confirmMessage: `确认删除已选 ${entryIds.length} 条${recordLabel}？删除后会进入回收站。`,
      });
      if (!data.ok) {
        if (data.error === "已取消删除") return;
        setDeleteMessage(data.error ?? "批量删除失败");
        return;
      }
      setDeleteMessage(data.message ?? `已删除 ${entryIds.length} 条记录`);
      clear();
      const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
      dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
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
      className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
      title={selectedCount === 0 ? "请先勾选记录" : `批量删除已选 ${selectedCount} 条${recordLabel}`}
      aria-label={selectedCount === 0 ? "请先勾选记录再批量删除" : `批量删除已选 ${selectedCount} 条${recordLabel}`}
    >
      <Trash2 className="h-3.5 w-3.5" />
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
