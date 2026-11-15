"use client";

import { ArrowLeftRight, ChevronDown, Lock, ReceiptText, ShieldCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ROW_ACTION_BUTTON_BOX_CLASS } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { CATEGORY_SMART_SELECT_BEHAVIOR } from "@/components/categorySmartSelect";
import { useDerivedLayerZIndex } from "@/components/ModalLayer";
import type { ReimbursementFormEntry } from "@/components/ReimbursementFormModal";
import { callReconcileEntries } from "@/lib/api/entry-reconcile";
import { callDeleteEntries, deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import {
  beginEntryConversion,
  createEntryConversionRequestId,
  ENTRY_CONVERSION_SUCCESS_EVENTS,
  takeEntryConversion,
  type EntryConversionTargetKey,
} from "@/lib/client/entry-conversion";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { recordRecentAccounts } from "@/lib/client/recentAccounts";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { batchReplaceEntries, type BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { translate, useI18n } from "@/lib/i18n";

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

function getFieldLabels(t: (key: string) => string): Record<BatchReplaceField, string> {
  return {
    date: t("detail.column.date"),
    postedAt: t("detail.column.postedAt"),
    type: t("batchImport.field.type"),
    amount: t("txForm.amount"),
    inflow: t("detail.column.inflow"),
    outflow: t("detail.column.outflow"),
    account: t("basicDetailSelection.accountLabel"),
    viewAccount: t("basicDetailSelection.accountLabel"),
    toAccount: t("batchImport.field.counterAccount"),
    categoryId: t("detail.column.category"),
    institution: t("batchImport.field.institution"),
    tagId: t("detail.column.tags"),
    appendTagId: t("basicDetailSelection.appendTag"),
    remark: t("detail.column.remark"),
  };
}

function getTypeOptions(t: (key: string) => string) {
  return [
    { value: "", label: t("batchImport.selectType") },
    { value: "expense", label: t("transaction.type.expense") },
    { value: "income", label: t("transaction.type.income") },
    { value: "transfer", label: t("transaction.type.transfer") },
    { value: "investment", label: t("transaction.type.investment") },
  ];
}
const defaultBatchReplaceFields: BatchReplaceField[] = ["date", "postedAt", "type", "outflow", "inflow", "amount", "viewAccount", "toAccount", "categoryId", "institution", "tagId", "appendTagId", "remark"];

function scopeBatchCategoryOptions(
  categoryOptions: BasicDetailBatchCategoryOption[],
  categoryTypes: string[] = [],
) {
  const typeSet = new Set(categoryTypes.filter(Boolean));
  if (typeSet.size === 0) return categoryOptions;

  const scopedOptions = categoryOptions.filter((option) => option.categoryType && typeSet.has(option.categoryType));
  if (typeSet.size !== 1) return scopedOptions;

  const [categoryType] = Array.from(typeSet);
  const typeHeaderId = `category-type:${categoryType}`;
  return scopedOptions
    .filter((option) => option.value !== typeHeaderId)
    .map((option) => ({
      ...option,
      parentId: option.parentId === typeHeaderId ? undefined : option.parentId,
      subLabel: undefined,
    }));
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function useBasicDetailSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("BasicDetailSelection components must be used inside BasicDetailSelectionProvider");
  return ctx;
}

export function usePruneBasicDetailSelection(validIds: string[]) {
  const { selectedIds, setSelection } = useBasicDetailSelection();

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const validIdSet = new Set(validIds);
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (validIdSet.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelection(next);
  }, [selectedIds, setSelection, validIds]);
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



export function BasicDetailBatchReplaceButton({
  accountOptions,
  categoryOptions = [],
  tagOptions = [],
  categoryTypes = [],
  fields = defaultBatchReplaceFields,
  targetLabel,
  contextAccountId,
  contextAccountIds,
}: {
  accountOptions: AccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  categoryTypes?: string[];
  fields?: BatchReplaceField[];
  targetLabel?: string;
  contextAccountId?: string | null;
  contextAccountIds?: string[];
}) {
  const { t } = useI18n();
  const { selectedIds, clear } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const fieldConfigs = useMemo<BatchReplaceFieldConfig<BatchReplaceField>[]>(() => {
    const fieldLabels = getFieldLabels(t);
    const typeOptions = getTypeOptions(t);
    const accountSelectOptions = [
      { value: "", label: t("fundShell.selectAccount") },
      ...accountOptions.map((account) => ({ value: account.id, label: account.label, title: account.title ?? undefined })),
    ];
    const categorySelectOptions = [
      { value: "", label: t("basicDetailSelection.clearCategory") },
      ...scopeBatchCategoryOptions(categoryOptions, categoryTypes),
    ];
    const tagSelectOptions = [
      { value: "", label: t("basicDetailSelection.clearTag") },
      ...tagOptions,
    ];
    const configByField: Record<BatchReplaceField, BatchReplaceFieldConfig<BatchReplaceField>> = {
      date: { value: "date", label: fieldLabels.date, kind: "date" },
      postedAt: { value: "postedAt", label: fieldLabels.postedAt, kind: "date", allowEmpty: true },
      type: { value: "type", label: fieldLabels.type, kind: "select", options: typeOptions },
      amount: { value: "amount", label: fieldLabels.amount, kind: "number", placeholder: t("basicDetailSelection.amountPlaceholder"), allowAmountFieldReferences: true },
      inflow: { value: "inflow", label: fieldLabels.inflow, kind: "number", placeholder: t("basicDetailSelection.inflowPlaceholder"), allowAmountFieldReferences: true },
      outflow: { value: "outflow", label: fieldLabels.outflow, kind: "number", placeholder: t("basicDetailSelection.outflowPlaceholder"), allowAmountFieldReferences: true },
      account: {
        value: "account",
        label: fieldLabels.account,
        kind: "smartSelect",
        options: accountSelectOptions,
      },
      viewAccount: {
        value: "viewAccount",
        label: fieldLabels.viewAccount,
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
        placeholder: t("basicDetailSelection.selectCategory"),
        allowEmpty: true,
        smartSelectBehavior: {
          ...CATEGORY_SMART_SELECT_BEHAVIOR,
          maxDropdownWidth: 560,
        },
      },
      institution: { value: "institution", label: fieldLabels.institution, kind: "text", placeholder: t("basicDetailSelection.institutionPlaceholder"), allowEmpty: true },
      tagId: { value: "tagId", label: fieldLabels.tagId, kind: "select", options: tagSelectOptions, allowEmpty: true },
      // 追加标签：保留记录已有标签，把所选标签并上去重；空选项只是占位（allowEmpty=false 挡住未选择就提交）。
      appendTagId: { value: "appendTagId", label: fieldLabels.appendTagId, kind: "select", options: [{ value: "", label: t("txForm.selectPlaceholder") }, ...tagOptions] },
      remark: { value: "remark", label: fieldLabels.remark, kind: "text", placeholder: t("stockPanel.batchNotePlaceholder"), allowEmpty: true },
    };
    return fields.map((field) => configByField[field]).filter(Boolean);
  }, [accountOptions, categoryOptions, categoryTypes, fields, t, tagOptions]);

  async function applyReplace(field: BatchReplaceField, value: string) {
    const entryIds = Array.from(selectedIds);
    const result = await batchReplaceEntries({ ids: entryIds, field, value, contextAccountId, contextAccountIds });
    if (!result.ok) {
      const message = result.code === "INVALID_AMOUNT"
        ? t("basicDetailSelection.invalidAmountExpression")
        : result.error ?? t("basicDetailSelection.batchReplaceFailed");
      throw new Error(message);
    }
    clear();
    dispatchFinanceDataChanged({ reason: "entry-batch-replace", entryIds });
    return t("basicDetailSelection.replacedCount", { count: result.updatedCount ?? 0 });
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

export function BasicDetailBatchDeleteButton({ recordLabel }: { recordLabel?: string }) {
  const { t } = useI18n();
  const { selectedIds, clear, setDeleteMessage } = useBasicDetailSelection();
  const [submitting, setSubmitting] = useState(false);
  const selectedCount = selectedIds.size;
  const disabled = selectedCount === 0 || submitting;
  const effectiveRecordLabel = recordLabel ?? t("basicDetail.entriesTitle");

  async function applyDelete() {
    if (disabled) return;
    const entryIds = Array.from(selectedIds);

    setSubmitting(true);
    setDeleteMessage("");
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds,
        confirmMessage: t("basicDetailSelection.deleteConfirm", { count: entryIds.length, label: effectiveRecordLabel }),
        t,
      });
      if (!data.ok) {
        if (data.error === translate("zh-CN", "basicDetailSelection.deleteCanceled")) return;
        setDeleteMessage(data.error ?? t("stockPanel.error.batchDeleteFailed"));
        return;
      }
      setDeleteMessage(data.message ?? t("fundShell.deletedCount", { count: entryIds.length }));
      clear();
      const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
      const deleteAccountIds = getDeleteRefreshAccountIds(data);
      recordRecentAccounts(deleteAccountIds);
      dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: deleteAccountIds, deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
    } catch {
      setDeleteMessage(t("stockPanel.error.batchDeleteFailed"));
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
      title={selectedCount === 0 ? t("stockPanel.error.selectRowsFirst") : t("common.delete")}
      aria-label={selectedCount === 0 ? t("basicDetailSelection.deleteDisabledAria") : t("common.delete")}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}


/**
 * 批量「对账」：把选中的流水锁定。
 *
 * 锁定后该记录不可删除 / 修改（编辑窗只读），并把「本行事后余额」钉进
 * `reconciledBalance` 当余额锚点（等价「余额校准」）。解除对账走行内的锁标记。
 */
export function BasicDetailBatchReconcileButton({ contextAccountId }: { contextAccountId?: string | null }) {
  const { t } = useI18n();
  const { selectedIds, clear, setDeleteMessage } = useBasicDetailSelection();
  const [submitting, setSubmitting] = useState(false);
  const selectedCount = selectedIds.size;
  const disabled = selectedCount === 0 || submitting;

  async function applyReconcile() {
    if (disabled) return;
    const entryIds = Array.from(selectedIds);
    const confirmed = await showConfirmDialog({
      title: t("reconcile.lockConfirmTitle"),
      message: t("reconcile.lockConfirm", { count: entryIds.length }),
      confirmLabel: t("reconcile.button"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;

    setSubmitting(true);
    setDeleteMessage("");
    try {
      const data = await callReconcileEntries({
        entryIds,
        action: "lock",
        contextAccountId: contextAccountId ?? undefined,
      });
      if (!data.ok) {
        setDeleteMessage(data.error || t("reconcile.failed"));
        return;
      }
      setDeleteMessage(t("reconcile.lockedCount", { count: data.count }));
      clear();
      dispatchFinanceDataChanged({ reason: "entry-reconcile", accountIds: data.accountIds, entryIds });
    } catch {
      setDeleteMessage(t("reconcile.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={applyReconcile}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
      title={selectedCount === 0 ? t("reconcile.selectRowsFirst") : t("reconcile.buttonTitle")}
      aria-label={t("reconcile.button")}
    >
      <ShieldCheck className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * 行内锁标记：已对账的记录显示锁，单击解除对账。
 *
 * 未对账的记录不渲染任何东西——加锁是批量动作（工具栏「对账」），行内只负责解锁。
 */
export function BasicDetailReconcileLockButton({
  entryId,
  reconciled,
  contextAccountId,
  asButton = true,
}: {
  entryId: string;
  reconciled: boolean;
  contextAccountId?: string | null;
  /**
   * 移动端整行本身是个 `<button>`，行内图标不能渲染嵌套 `<button>`
   * （无效 HTML，且浏览器在解析期就会把外层按钮闭合掉 → 行结构与 hydration 全乱）。
   * 与 `EntryAttachmentIndicator` 同一约定：嵌套时传 `false` 渲染 span。
   */
  asButton?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (!reconciled) return null;

  async function unlock() {
    if (busy) return;
    const confirmed = await showConfirmDialog({
      title: t("reconcile.unlockConfirmTitle"),
      message: t("reconcile.unlockConfirm"),
      confirmLabel: t("reconcile.unlock"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const data = await callReconcileEntries({
        entryIds: [entryId],
        action: "unlock",
        contextAccountId: contextAccountId ?? undefined,
      });
      if (!data.ok) {
        window.alert(data.error || t("reconcile.failed"));
        return;
      }
      dispatchFinanceDataChanged({ reason: "entry-reconcile", accountIds: data.accountIds, entryIds: [entryId] });
    } catch {
      window.alert(t("reconcile.failed"));
    } finally {
      setBusy(false);
    }
  }

  const lockClassName =
    `${ROW_ACTION_BUTTON_BOX_CLASS} border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100`;
  const lockTitle = t("reconcile.unlockTitle");
  const lockIcon = <Lock />;

  // 整行是可点的 <button>：只当图标用，点它不能顺带打开编辑窗。
  if (!asButton) {
    return (
      <span
        title={lockTitle}
        className={lockClassName}
        onClick={(event) => {
          event.stopPropagation();
          void unlock();
        }}
      >
        {lockIcon}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={unlock}
      disabled={busy}
      className={`${lockClassName} disabled:opacity-50`}
      title={lockTitle}
      aria-label={lockTitle}
    >
      {lockIcon}
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

/**
 * Detail-selection reimbursement entry point.
 *
 * - With rows selected: opens the object's reimbursement hub with the picked rows
 *   pre-seeded into the create form (the rows share one reimbursement purpose).
 * - Without any selection: opens the same hub showing the account's reimbursement
 *   status (pending / reimbursed) with no create form popped.
 */

function showSelectionBlocked(
  selectedCount: number,
  selectedEntries: ReimbursementFormEntry[],
  blockedSelection: boolean,
  selectedAdvanceAccountIds: Set<string>,
) {
  return blockedSelection || (selectedCount > 0 && (selectedEntries.length !== selectedCount || selectedAdvanceAccountIds.size !== 1));
}

/* ------------------------------------------------------------------ *
 * 「转换交易」
 *
 * 选中一条记录 → 转换 → 选目标交易类型 → 打开该类型的新建窗（带入资金账户 /
 * 日期 / 金额 / 备注）→ 保存成功后删除原记录（真·转换）。
 * 会话登记与「保存成功」事件的约定见 `@/lib/client/entry-conversion`。
 * ------------------------------------------------------------------ */

/** 转换时用得上的明细行字段（明细行是瘦身行，这里只声明实际读取的部分）。 */
export type ConvertSourceEntry = {
  id: string;
  type?: string | null;
  date?: string | null;
  amount?: number | null;
  bookAmount?: number | null;
  note?: string | null;
  businessNote?: string | null;
  accountId?: string | null;
  accountKind?: string | null;
  accountIsSettlementAccount?: boolean | null;
  toAccountId?: string | null;
  toAccountKind?: string | null;
  cashAccountId?: string | null;
  reconciledAt?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
  stockTransaction?: {
    stockAccountId?: string | null;
    cashAccountId?: string | null;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
    stockName?: string | null;
  } | null;
};

type ConvertTargetGroup = {
  key: string;
  labelKey: string;
  targets: Array<{ key: EntryConversionTargetKey; labelKey: string }>;
};

const CONVERT_TARGET_GROUPS: ConvertTargetGroup[] = [
  {
    key: "cash",
    labelKey: "detail.convert.group.cash",
    targets: [
      { key: "expense", labelKey: "detail.convert.target.expense" },
      { key: "income", labelKey: "detail.convert.target.income" },
      { key: "advance", labelKey: "detail.convert.target.advance" },
      { key: "transfer", labelKey: "detail.convert.target.transfer" },
      { key: "credit_repay", labelKey: "detail.convert.target.creditRepay" },
    ],
  },
  {
    key: "investment",
    labelKey: "detail.convert.group.investment",
    targets: [
      { key: "fund", labelKey: "detail.convert.target.fund" },
      { key: "metal", labelKey: "detail.convert.target.metal" },
      { key: "wealth", labelKey: "detail.convert.target.wealth" },
      { key: "bond", labelKey: "detail.convert.target.bond" },
      { key: "deposit", labelKey: "detail.convert.target.deposit" },
      { key: "insurance", labelKey: "detail.convert.target.insurance" },
      { key: "stock", labelKey: "detail.convert.target.stock" },
    ],
  },
  {
    key: "liability",
    labelKey: "detail.convert.group.liability",
    targets: [
      { key: "liability_borrow_in", labelKey: "detail.convert.target.borrowIn" },
      { key: "liability_lend_out", labelKey: "detail.convert.target.lendOut" },
      { key: "liability_repay_out", labelKey: "detail.convert.target.repayOut" },
      { key: "liability_collect_in", labelKey: "detail.convert.target.collectIn" },
    ],
  },
];

const CONVERT_LIABILITY_MODES: Partial<Record<EntryConversionTargetKey, "borrow_in" | "lend_out" | "repay_out" | "collect_in">> = {
  liability_borrow_in: "borrow_in",
  liability_lend_out: "lend_out",
  liability_repay_out: "repay_out",
  liability_collect_in: "collect_in",
};

/**
 * 选中单条记录时出现在明细工具栏的「转换」按钮。
 *
 * 菜单按「记账 / 投资 / 往来」分组；点某一项只负责按目标类型派发新建事件，
 * 真正的替换（删除原记录）由 `<BasicDetailConvertWatcher />` 在目标窗保存成功后完成。
 */
export function BasicDetailConvertButton({
  entry,
  cashAccountId,
}: {
  entry: ConvertSourceEntry;
  /** 该行的资金账户（全部收支视图下与 accountId 可能不同）。 */
  cashAccountId?: string | null;
}) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const zIndex = useDerivedLayerZIndex();
  const reconciled = Boolean(entry.reconciledAt);

  // 菜单用 portal 定位：明细表格容器带 overflow 与固定高度，absolute 面板会被裁掉。
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const width = panel.offsetWidth || 184;
      const height = panel.offsetHeight || 320;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 6;
      const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
      setPanelStyle({ left, top, width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const dispatchConversion = useCallback((targetKey: EntryConversionTargetKey, label: string) => {
    const requestId = createEntryConversionRequestId();
    beginEntryConversion(requestId, { sourceEntryId: entry.id, targetKey, targetLabel: label });

    const amount = Math.abs(Number(entry.bookAmount ?? entry.amount ?? 0)) || 0;
    const date = String(entry.date ?? "").slice(0, 10);
    const note = String(entry.businessNote ?? entry.note ?? "").trim();
    const moneyAccountId = String(cashAccountId || entry.cashAccountId || entry.accountId || "").trim();
    const stock = entry.stockTransaction ?? null;
    // 原记录本身就是往来款/贷款时，目标窗可以直接落在同一个往来对象上。
    const liabilityAccountId = entry.accountKind === "loan" || entry.accountIsSettlementAccount
      ? String(entry.accountId ?? "")
      : "";

    const openTransaction = (type: string, override?: { from?: string; to?: string }) => {
      window.dispatchEvent(new CustomEvent("mmh:create-transaction:open", {
        detail: {
          requestId,
          source: "detail-convert",
          defaultAccountId: moneyAccountId,
          defaultFromAccountId: override?.from ?? moneyAccountId,
          defaultToAccountId: override?.to ?? "",
          item: { type, date, amount, remark: note },
        },
      }));
    };

    switch (targetKey) {
      case "expense":
      case "income":
      case "advance":
        openTransaction(targetKey);
        break;
      case "transfer":
        openTransaction("transfer");
        break;
      case "credit_repay": {
        const creditSide = entry.accountKind === "bank_credit"
          ? String(entry.accountId ?? "")
          : entry.toAccountKind === "bank_credit"
            ? String(entry.toAccountId ?? "")
            : "";
        openTransaction("transfer", creditSide ? { to: creditSide } : undefined);
        break;
      }
      case "fund":
      case "metal":
        window.dispatchEvent(new CustomEvent("mmh:investment:create", {
          detail: {
            requestId,
            defaultProductType: targetKey,
            defaultCashAccountId: moneyAccountId,
            defaultDate: date,
            defaultAmount: amount || undefined,
            defaultMemo: note || undefined,
            ...(targetKey === "fund" && entry.fundCode
              ? { defaultFundCode: entry.fundCode, defaultFundName: entry.fundName ?? "" }
              : {}),
          },
        }));
        break;
      case "wealth":
      case "bond":
        window.dispatchEvent(new CustomEvent(`mmh:${targetKey}:create`, {
          detail: {
            requestId,
            defaultCashAccountId: moneyAccountId,
            defaultDate: date,
            defaultAmount: amount || undefined,
          },
        }));
        break;
      case "deposit":
        window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
          detail: {
            requestId,
            defaultSubtype: "buy",
            defaultCashAccountId: moneyAccountId,
            defaultDate: date,
            defaultAmount: amount || undefined,
          },
        }));
        break;
      case "insurance":
        window.dispatchEvent(new CustomEvent("mmh:insurance:create", {
          detail: {
            requestId,
            defaultCashAccountId: moneyAccountId,
            defaultDate: date,
            defaultAmount: amount || undefined,
          },
        }));
        break;
      case "stock":
        window.dispatchEvent(new CustomEvent("mmh:stock:create", {
          detail: {
            requestId,
            defaultAction: "buy",
            defaultStockAccountId: stock?.stockAccountId ?? "",
            defaultCashAccountId: stock?.cashAccountId || moneyAccountId,
            defaultDate: date,
            defaultAmount: amount || undefined,
            defaultSecurityId: stock?.securityId ?? undefined,
            defaultStockCode: stock?.stockCode ?? undefined,
            defaultStockName: stock?.stockName ?? undefined,
            defaultMarket: stock?.market ?? undefined,
          },
        }));
        break;
      default: {
        const liabilityMode = CONVERT_LIABILITY_MODES[targetKey];
        if (!liabilityMode) return;
        const isLoanTarget = Boolean(liabilityAccountId) && entry.accountKind === "loan"
          && (liabilityMode === "borrow_in" || liabilityMode === "repay_out");
        window.dispatchEvent(new CustomEvent(isLoanTarget ? "mmh:loan:create" : "mmh:settlement:create", {
          detail: {
            requestId,
            mode: liabilityMode,
            entryKind: "liability",
            defaultLiabilityAccountId: liabilityAccountId,
            defaultCashAccountId: moneyAccountId,
            defaultDate: date,
            defaultPrincipal: amount || undefined,
            defaultNote: note || undefined,
          },
        }));
      }
    }
  }, [cashAccountId, entry]);

  const disabled = reconciled;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className="flex h-6 items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-40"
        title={disabled ? t("detail.convert.reconciledDisabled") : t("detail.convert.buttonTitle")}
        aria-label={t("detail.convert.button")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
        <span>{t("detail.convert.button")}</span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={t("detail.convert.buttonTitle")}
          style={{ ...panelStyle, zIndex, visibility: panelStyle ? "visible" : "hidden" }}
          className="fixed max-h-[70vh] overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl"
        >
          {CONVERT_TARGET_GROUPS.map((group) => (
            <div key={group.key} className="py-0.5">
              <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400">{t(group.labelKey)}</div>
              {group.targets.map((target) => (
                <button
                  key={target.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    dispatchConversion(target.key, t(target.labelKey));
                  }}
                  className="block w-full px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                >
                  {t(target.labelKey)}
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/**
 * 「转换」收尾：目标交易保存成功后删除原记录。
 *
 * 必须在选中区之外常驻挂载——转换按钮在保存前就随选择变化/列表刷新卸载了。
 */
export function BasicDetailConvertWatcher() {
  const { t } = useI18n();
  const { setDeleteMessage } = useBasicDetailSelection();

  const removeSource = useCallback(async (session: ReturnType<typeof takeEntryConversion>) => {
    if (!session) return;
    const entryIds = [session.sourceEntryId];
    try {
      const precheck = await callDeleteEntries({ entryIds, checkOnly: true });
      if (!precheck.ok && !precheck.needConfirm) {
        setDeleteMessage(t("detail.convert.removeFailed", {
          target: session.targetLabel,
          reason: precheck.error || t("detail.convert.removeUnknownReason"),
        }));
        return;
      }
      const hasLinkedBusiness = (precheck.impacts?.length ?? 0) > 0 || Boolean(precheck.needConfirm);
      const data = await callDeleteEntries({
        entryIds,
        linkedAction: hasLinkedBusiness ? "deleteBusiness" : undefined,
      });
      if (!data.ok) {
        setDeleteMessage(t("detail.convert.removeFailed", {
          target: session.targetLabel,
          reason: data.error || t("detail.convert.removeUnknownReason"),
        }));
        return;
      }
      const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
      const accountIds = getDeleteRefreshAccountIds(data);
      recordRecentAccounts(accountIds);
      dispatchFinanceDataChanged({
        reason: "entry-convert",
        accountIds,
        deletedEntryIds: refreshEntryIds,
        entryIds: refreshEntryIds,
      });
      const depositWarning = (data.depositGeneratedRecordCount ?? 0) > 0
        ? ` ${t("entriesDelete.depositGeneratedWarning", { count: data.depositGeneratedRecordCount ?? 0 })}`
        : "";
      setDeleteMessage(`${t("detail.convert.removed", { target: session.targetLabel })}${depositWarning}`);
    } catch (error) {
      setDeleteMessage(t("detail.convert.removeFailed", {
        target: session.targetLabel,
        reason: error instanceof Error ? error.message : t("detail.convert.removeUnknownReason"),
      }));
    }
  }, [setDeleteMessage, t]);

  useEffect(() => {
    const handler = (event: Event) => {
      const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId;
      const session = takeEntryConversion(requestId);
      if (!session) return;
      void removeSource(session);
    };
    for (const eventName of ENTRY_CONVERSION_SUCCESS_EVENTS) {
      window.addEventListener(eventName, handler);
    }
    return () => {
      for (const eventName of ENTRY_CONVERSION_SUCCESS_EVENTS) {
        window.removeEventListener(eventName, handler);
      }
    };
  }, [removeSource]);

  return null;
}
