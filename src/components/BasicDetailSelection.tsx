"use client";

import { ChevronDown, Lock, ReceiptText, ShieldCheck, Trash2 } from "lucide-react";
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
    // 表头叫「资金流向」，这两个字段就是给它定方向，名字必须跟着表头走（2026-11-17）。
    inflow: t("basicDetailSelection.flowInLabel"),
    outflow: t("basicDetailSelection.flowOutLabel"),
    account: t("basicDetailSelection.accountLabel"),
    viewAccount: t("basicDetailSelection.accountLabel"),
    toAccount: t("batchImport.field.counterAccount"),
    // 往来明细的账户列是「往来款账户 / 对手账户」，批量替换直接复用表头的 i18n key，
    // 这样表头改名不会和批量字段对不上（2026-11-17 用户要求）。
    liabilityAccount: t("liabilityShell.colLiabilityAccount"),
    counterpartyAccount: t("liabilityShell.colCounterpartyAccount"),
    outflowAccount: t("basicDetailSelection.outflowAccountLabel"),
    inflowAccount: t("basicDetailSelection.inflowAccountLabel"),
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
  fieldLabelOverrides,
  fieldHintOverrides,
  targetLabel,
  contextAccountId,
  contextAccountIds,
  hint,
}: {
  accountOptions: AccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  categoryTypes?: string[];
  fields?: BatchReplaceField[];
  /**
   * 覆盖个别字段的显示名，用来和调用方表格的表头逐字对齐（例如往来款表在贷款视图里
   * 表头叫「贷款账户」，批量字段也得叫「贷款账户」，否则两处名字对不上）。
   */
  fieldLabelOverrides?: Partial<Record<BatchReplaceField, string>>;
  /** 覆盖个别字段的说明文字（同一字段在不同表里语义不同时用）。 */
  fieldHintOverrides?: Partial<Record<BatchReplaceField, string>>;
  targetLabel?: string;
  contextAccountId?: string | null;
  contextAccountIds?: string[];
  /** 表格语境说明（例如往来款表的红绿/负数含义），显示在字段选择之上。 */
  hint?: ReactNode;
}) {
  const { t } = useI18n();
  const { selectedIds, clear } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const fieldConfigs = useMemo<BatchReplaceFieldConfig<BatchReplaceField>[]>(() => {
    const fieldLabels = { ...getFieldLabels(t), ...fieldLabelOverrides };
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
      // 三个金额字段长得像、改的东西完全不同（数值 / 流入方向 / 流出方向），
      // 必须各自带一句说明，否则用户在往来款这类「红绿跟方向绑定」的表里必然理解错。
      amount: { value: "amount", label: fieldLabels.amount, kind: "number", placeholder: t("basicDetailSelection.amountPlaceholder"), allowAmountFieldReferences: true, hint: t("basicDetailSelection.hint.amount") },
      inflow: { value: "inflow", label: fieldLabels.inflow, kind: "number", placeholder: t("basicDetailSelection.inflowPlaceholder"), allowAmountFieldReferences: true, hint: t("basicDetailSelection.hint.inflow") },
      outflow: { value: "outflow", label: fieldLabels.outflow, kind: "number", placeholder: t("basicDetailSelection.outflowPlaceholder"), allowAmountFieldReferences: true, hint: t("basicDetailSelection.hint.outflow") },
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
      // 只改「钱从哪出 / 进到哪」的那一列，金额正负与方向语义都不动；
      // 该行本来没有这一侧（余额校准）会被后端跳过并计数。
      outflowAccount: {
        value: "outflowAccount",
        label: fieldLabels.outflowAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
        hint: t("basicDetailSelection.hint.outflowAccount"),
      },
      inflowAccount: {
        value: "inflowAccount",
        label: fieldLabels.inflowAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
        hint: t("basicDetailSelection.hint.inflowAccount"),
      },
      // 往来明细的账户口径：往来款账户（本行往来款那一侧）与对手账户（另一端）。
      // 与表头同名，且后端按每行实际方向定位，不受 accountId / toAccountId 位置影响。
      liabilityAccount: {
        value: "liabilityAccount",
        label: fieldLabels.liabilityAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
        hint: t("basicDetailSelection.hint.liabilityAccount"),
      },
      counterpartyAccount: {
        value: "counterpartyAccount",
        label: fieldLabels.counterpartyAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
        hint: t("basicDetailSelection.hint.counterpartyAccount"),
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
    return fields
      .map((field) => {
        const config = configByField[field];
        const hintOverride = fieldHintOverrides?.[field];
        return config && hintOverride ? { ...config, hint: hintOverride } : config;
      })
      .filter(Boolean);
  }, [accountOptions, categoryOptions, categoryTypes, fieldHintOverrides, fieldLabelOverrides, fields, t, tagOptions]);

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
    const replaced = t("basicDetailSelection.replacedCount", { count: result.updatedCount ?? 0 });
    // 往来明细里余额校准这类行没有「流出/流入」侧，改不了也不该改，单独说清楚。
    return result.skippedNoFlowSide
      ? `${replaced}・${t("basicDetailSelection.skippedNoFlowSide", { count: result.skippedNoFlowSide })}`
      : replaced;
  }

  return (
    <BatchReplacePopoverButton
      fields={fieldConfigs}
      targetCount={selectedCount}
      targetLabel={targetLabel}
      buttonClassName="flex h-6 w-6 items-center justify-center rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
      onApply={applyReplace}
    >
      {hint ?? null}
    </BatchReplacePopoverButton>
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
  /**
   * 这笔钱是**流进来**的吗（赎回 / 卖出 / 取出 / 退保 / 收款 → true；买入 / 申购 / 缴费 → false）。
   *
   * 单看 `type === "income"` 判断不出来：理财/基金/股票窗里的赎回记录 type 不是 income，
   * 转账记录也分流入侧和流出侧。所以由各录入窗按自己的页签给出方向，这里只做兜底。
   */
  inflow?: boolean | null;
  /** 该明细行所属账户（转账记录用它判断方向：行账户 === toAccountId 即流入）。 */
  rowAccountId?: string | null;
};

type ConvertTarget = {
  key: EntryConversionTargetKey;
  labelKey: string;
  /**
   * 这个目标本身的现金方向：钱进（收入 / 取出 / 收款）= "in"，
   * 钱出（支出 / 代付 / 缴费）= "out"，转账、投资、往来这类两边都能走的 = "both"。
   *
   * 菜单只列与源记录**同向**的目标（2026-11-18 用户裁定：流入的金额转换时「只列资金流入的操作」，
   * 买入 / 申购 / 缴费类完全不出现），钱流出的记录则反过来 —— 支出 / 代付这类不出现。
   */
  flow: "in" | "out" | "both";
};

type ConvertTargetGroup = {
  key: string;
  labelKey: string;
  targets: ConvertTarget[];
};

/**
 * 转换目标的唯一口径：**录入窗里真实存在的页签 / 入口**。
 *
 * - 记账窗的 FT 页签只有 支出 / 收入 / 代付 / 转账 四个，所以现金组就是这四个；
 *   以前那条「信用卡还款」是凭空多出来的类型 —— 信用卡还款本身就是一笔转账
 *   （资金账户 → 信用卡账户），要还卡就选「转账」并选信用卡作为流入账户
 *   （2026-11-17 用户裁定，目标清单里不要出现不存在的类型）。
 * - 投资组对应胶囊菜单里真实存在的录入窗（基金/贵金属/理财/债券/存单/保险/股票）。
 * - 往来组只在**源记录不是往来款/贷款**时出现：一条往来款记录转成往来款没有意义，
 *   想改方向/模式直接在往来款编辑窗切「借款 / 还款」页签即可。
 * - 现金组只在**源记录不是记账窗那四类**时出现：支收代转这四类在编辑窗顶部就是页签，
 *   切页签保存即等于原地转换（提交带 type），菜单里再列一遍就是同一件事做两次
 *   （2026-11-17 用户裁定：「大窗口里本就有收入/代付/转账的页签，不需要显示这三个选项」）。
 */
const CONVERT_TARGET_GROUPS: ConvertTargetGroup[] = [
  {
    key: "cash",
    labelKey: "detail.convert.group.cash",
    targets: [
      { key: "expense", labelKey: "detail.convert.target.expense", flow: "out" },
      { key: "income", labelKey: "detail.convert.target.income", flow: "in" },
      { key: "advance", labelKey: "detail.convert.target.advance", flow: "out" },
      { key: "transfer", labelKey: "detail.convert.target.transfer", flow: "both" },
    ],
  },
  {
    key: "investment",
    labelKey: "detail.convert.group.investment",
    // 投资类入口本身两个方向都能走（买入 / 赎回），所以 flow=both。
    // 菜单只写资产名（开放式基金 / 货币基金 / 贵金属…），不写申购赎回这类动作词
    // （2026-11-18 用户裁定：不要「基金申购」这种带动作的文案，方向由打开窗后的页签体现）。
    targets: [
      { key: "fund", labelKey: "detail.convert.target.fund", flow: "both" },
      // 货币基金与开放式基金共用一个录入窗，产品类型不同（fund / money）：
      // 少了这一项，货基账户只能从胶囊菜单记，转换菜单里没有货基入口。
      { key: "money", labelKey: "detail.convert.target.money", flow: "both" },
      { key: "metal", labelKey: "detail.convert.target.metal", flow: "both" },
      { key: "wealth", labelKey: "detail.convert.target.wealth", flow: "both" },
      { key: "bond", labelKey: "detail.convert.target.bond", flow: "both" },
      { key: "deposit", labelKey: "detail.convert.target.deposit", flow: "both" },
      { key: "insurance", labelKey: "detail.convert.target.insurance", flow: "both" },
      { key: "stock", labelKey: "detail.convert.target.stock", flow: "both" },
    ],
  },
  {
    key: "liability",
    labelKey: "detail.convert.group.liability",
    // 往来款窗只有「借款 / 还款」两个页签（借入借出、还款收款是同一页签的两种流向，
    // 由往来款账户落在流出侧还是流入侧决定），所以目标也只列这两项，文案直接复用页签 key。
    targets: [
      { key: "liability_borrow", labelKey: "liabilityTx.flow.borrow", flow: "both" },
      { key: "liability_repay", labelKey: "liabilityTx.flow.repay", flow: "both" },
    ],
  },
];

/**
 * 往来目标只有「借款 / 还款」两个页签，页签内部的流向沿用原记录的现金方向：
 * 原来钱是出去的 → 借出 / 还款，原来钱是进来的 → 借入 / 收款。
 * 进窗后把往来款账户挪到另一侧即可换成反方向，所以这只是默认值。
 */
function convertLiabilityMode(
  targetKey: EntryConversionTargetKey,
  entry: ConvertSourceEntry,
): "borrow_in" | "lend_out" | "repay_out" | "collect_in" | null {
  const inflow = String(entry.type ?? "").trim() === "income";
  if (targetKey === "liability_borrow") return inflow ? "borrow_in" : "lend_out";
  if (targetKey === "liability_repay") return inflow ? "collect_in" : "repay_out";
  return null;
}

/** 记账窗（支 / 收 / 代 / 转）那一族类型：它们的编辑窗顶部自带四个 FT 页签。 */
const CONVERT_CASH_FAMILY_KEYS = new Set<string>(["expense", "income", "advance", "transfer"]);

/**
 * 「转换交易」下拉：只挂在**编辑窗标题栏**里（`EntryConvertHeaderAction`）。
 * 明细表头那颗按钮已移除（2026-11-17 用户裁定：转换属于「改这条记录」，放进编辑窗）。
 *
 * 菜单按「记账 / 投资 / 往来」分组；点某一项只负责按目标类型派发新建事件，
 * 真正的替换（删除原记录）由 `<BasicDetailConvertWatcher />` 在目标窗保存成功后完成。
 */
export function EntryConvertMenu({
  entry,
  cashAccountId,
  disabled: disabledProp = false,
  onBeforeConvert,
}: {
  entry: ConvertSourceEntry;
  /** 该行的资金账户（全部收支视图下与 accountId 可能不同）。 */
  cashAccountId?: string | null;
  /** 额外禁用（编辑窗里「已对账」只读时用）。 */
  disabled?: boolean;
  /**
   * 派发目标新建事件之前的回调：编辑窗必须先关掉自己并清空草稿，
   * 否则两个录入窗会抢同一份表单状态。
   */
  onBeforeConvert?: () => void;
}) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);
  const zIndex = useDerivedLayerZIndex();
  const reconciled = Boolean(entry.reconciledAt);
  // 源记录本身是往来款/贷款：往来组整组不出现（想改方向就在编辑窗切「借款 / 还款」页签）。
  const sourceIsLiability = entry.accountKind === "loan"
    || entry.accountKind === "settlement"
    || Boolean(entry.accountIsSettlementAccount);
  // 源记录的类型与某个目标同名时同样不出现（支出不必「转换成支出」）。
  const sourceType = String(entry.type ?? "").trim();
  // 源记录本身就出自记账窗：支出 / 收入 / 代付 / 转账 在编辑窗里就是页签，切页签即转换。
  // 往来款/贷款的现金流行也存成 transfer，但它们的编辑窗是往来款窗（没有这四个页签），
  // 所以这类来源仍要保留现金组，别跟着一起吞掉。
  const sourceIsCashFamily = CONVERT_CASH_FAMILY_KEYS.has(sourceType) && !sourceIsLiability;
  /**
   * 源记录的钱是流进来的：投资类目标要说「赎回 / 卖出」而不是「买入」，否则转出来方向是反的。
   *
   * 方向优先取录入窗给出的 `inflow`（理财/基金/股票窗里赎回记录的 type 不是 income，
   * 单看 type 会把赎回记录当成买入）；没给时退回老口径：income = 流入，
   * 转账记录则看这一行属于哪个账户（行账户在流入侧 = 这笔是收款）。
   */
  const transferInflow = sourceType === "transfer"
    && Boolean(entry.toAccountId)
    && Boolean(entry.rowAccountId)
    && String(entry.rowAccountId) === String(entry.toAccountId);
  const inflow = entry.inflow ?? (sourceType === "income" || transferInflow);
  const visibleGroups = useMemo(
    () => CONVERT_TARGET_GROUPS
      .filter((group) => !(group.key === "liability" && sourceIsLiability))
      .filter((group) => !(group.key === "cash" && sourceIsCashFamily))
      .map((group) => ({
        ...group,
        targets: group.targets
          .filter((target) => target.key !== sourceType)
          // 只列与源记录同向的目标：流入的记录不出现买入 / 申购 / 缴费 / 支出 / 代付，
          // 流出的记录不出现收入；转账、投资、往来这类双向目标两边都留。
          .filter((target) => (inflow ? target.flow !== "out" : target.flow !== "in")),
      }))
      .filter((group) => group.targets.length > 0),
    [sourceIsLiability, sourceIsCashFamily, sourceType, inflow],
  );

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
      case "transfer": {
        // 信用卡还款没有独立类型（它就是转账），但把信用卡预填到流入侧：
        // 原来那条「信用卡还款」的实用价值只剩这个预填。方向仍是「资金账户 → 信用卡」。
        const creditSide = entry.accountKind === "bank_credit"
          ? String(entry.accountId ?? "")
          : entry.toAccountKind === "bank_credit"
            ? String(entry.toAccountId ?? "")
            : "";
        openTransaction("transfer", creditSide ? { to: creditSide } : undefined);
        break;
      }
      case "fund":
      case "money":
      case "metal":
        window.dispatchEvent(new CustomEvent("mmh:investment:create", {
          detail: {
            requestId,
            defaultProductType: targetKey,
            // 钱进来时这笔就是赎回：直接落在赎回页签，不再是「买入」。
            defaultSubtype: inflow ? "redeem" : "buy",
            defaultCashAccountId: moneyAccountId,
            defaultDate: date,
            defaultAmount: amount || undefined,
            defaultMemo: note || undefined,
            // 基金 / 货基都按代码预填（同一只基金在两条链路上代码一致）；贵金属没有代码。
            ...(targetKey !== "metal" && entry.fundCode
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
            defaultSubtype: inflow ? "redeem" : "buy",
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
            defaultSubtype: inflow ? "redeem" : "buy",
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
            // 钱进来时这笔是退保（保险窗的第二个页签），不是缴费。
            defaultSubtype: inflow ? "redeem" : "buy",
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
            defaultAction: inflow ? "sell" : "buy",
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
        const liabilityMode = convertLiabilityMode(targetKey, entry);
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
  }, [cashAccountId, entry, inflow]);

  const disabled = disabledProp || reconciled;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className="secondary-button h-8 px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
        title={disabled ? t("detail.convert.reconciledDisabled") : t("detail.convert.buttonTitle")}
        aria-label={t("detail.convert.button")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {/* 不加箭头图标：表头「反选」用的就是 ArrowRightLeft，两个图标容易混淆。 */}
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
          {visibleGroups.map((group) => (
            <div key={group.key} className="py-0.5">
              <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-400">{t(group.labelKey)}</div>
              {group.targets.map((target) => (
                <button
                  key={target.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onBeforeConvert?.();
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
 *
 * 没有明细 Provider 的页面（报表、计划投资等）由 `EntryConversionFallbackWatcher` 兜底。
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
