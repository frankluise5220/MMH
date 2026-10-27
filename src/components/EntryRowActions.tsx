"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { BasicDetailReconcileLockButton } from "@/components/BasicDetailSelection";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { setEntryModalReconciledReadOnly } from "@/lib/client/entryModalLock";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { recordRecentAccounts } from "@/lib/client/recentAccounts";
import { useI18n } from "@/lib/i18n";

export type EditPayload = {
  requestId?: string;
  entryId: string;
  /** 该记录已「对账」锁定：编辑窗只读（可查看，不可改）。 */
  reconciledReadOnly?: boolean;
  transactionId?: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  targetEntryId?: string;
  type: "expense" | "income" | "advance" | "transfer" | "fx" | "investment";
  date: string;
  confirmDate?: string;
  postedAt?: string | null;
  amount: number;
  note: string;
  businessNote?: string | null;
  toNote?: string;
  accountId?: string;
  accountName?: string;
  accountLabel?: string;
  categoryId?: string;
  categoryName?: string;
  counterpartyInstitutionId?: string;
  /** Advance (代付) settlement account picked in the dialog; empty = auto resolve/create. */
  advanceAccountId?: string;
  fromAccountId?: string;
  fromAccountName?: string;
  toAccountId?: string;
  toAccountName?: string;
  hasFundDetail?: boolean;
  cashAccountId?: string;
  fundCode?: string;
  fundName?: string;
  wealthProductId?: string | null;
  depositProductId?: string | null;
  metalTypeId?: string | null;
  metalTypeName?: string | null;
  metalUnitId?: string | null;
  metalUnitName?: string | null;
  metalQuantity?: number | null;
  metalUnitPrice?: number | null;
  metalFee?: number | null;
  insuranceProductId?: string | null;
  insuranceAction?: "premium" | "additional_premium" | "refund";
  insuranceProductName?: string;
  fundSubtype?: string;
  fundUnits?: number;
  fundNav?: number;
  depositAnnualRate?: number;
  depositInterest?: number;
  depositSourceEntryId?: string | null;
  depositMaturityAction?: string | null;
  depositInterestPayoutFrequency?: string | null;
  depositInterestCalcBasis?: string | null;
  fundFee?: number;
  fundConfirmDate?: string;
  fundArrivalDate?: string | null;
  fundSourceEntryId?: string | null;
  fundArrivalAmount?: number | null;
  fundProductType?: string;
  /** 债券存单归属：子行（付息/赎回/核销）指回所属存单，编辑时据此预选存单。 */
  sourceBondTransactionId?: string | null;
  source?: string | null;
  linkedCandidateEntries?: Array<{
    id?: string;
    date: string;
    createdAt?: string | null;
    fundConfirmDate?: string | null;
    fundArrivalDate?: string | null;
    fundCode: string;
    fundSubtype: string;
    fundUnits: number | null;
    source: string | null;
    accountId?: string | null;
    toAccountId?: string | null;
    fundSourceEntryId?: string | null;
    amount?: number;
  }>;
  tagIds?: string[];
  currency?: string | null;
  originalCurrency?: string | null;
  originalAmount?: number | null;
  locationId?: string;
  locationName?: string;
  tags?: Array<{
    id?: string;
    tagId?: string;
    name?: string | null;
    label?: string | null;
    color?: string | null;
    Tag?: { name?: string | null; color?: string | null } | null;
  }>;
};

export function dispatchEntryEdit({
  entryId,
  edit,
  customEditEvent,
}: {
  entryId: string;
  edit?: Omit<EditPayload, "entryId">;
  customEditEvent?: { name: string; detail: Record<string, unknown> };
}) {
  // 已「对账」锁定的记录：编辑窗只读（可查看，不可改）。服务端另有硬守卫。
  setEntryModalReconciledReadOnly(Boolean(
    edit?.reconciledReadOnly || customEditEvent?.detail?.reconciledReadOnly,
  ));
  if (customEditEvent) {
    window.dispatchEvent(new CustomEvent(customEditEvent.name, { detail: customEditEvent.detail }));
    return;
  }
  if (!edit) return;
  const editEntryId = edit.targetEntryId || entryId;
  const requestId = `edit-${editEntryId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const detail = { requestId, entryId: editEntryId, ...edit } satisfies EditPayload;

  const pt = edit.fundProductType;
  if (edit.type === "investment" && (edit.source === "insurance" || edit.insuranceProductId)) {
    window.dispatchEvent(new CustomEvent("mmh:insurance:edit", { detail }));
  } else if (edit.type === "investment" && pt === "bond") {
    window.dispatchEvent(new CustomEvent("mmh:bond:edit", { detail }));
  } else if (edit.type === "investment" && pt === "wealth") {
    window.dispatchEvent(new CustomEvent("mmh:wealth:edit", { detail }));
  } else if (edit.type === "investment" && pt === "deposit") {
    window.dispatchEvent(new CustomEvent("mmh:deposit:edit", { detail }));
  } else if (edit.type === "investment") {
    window.dispatchEvent(new CustomEvent("mmh:investment:edit", { detail }));
  } else {
    window.dispatchEvent(new CustomEvent("mmh:transaction:edit", { detail }));
  }
}

export function EntryRowActions({
  entryId,
  edit,
  customEditEvent,
  onEditRequest,
  reconciled = false,
  contextAccountId,
}: {
  entryId: string;
  edit?: Omit<EditPayload, "entryId">;
  customEditEvent?: { name: string; detail: Record<string, unknown> };
  /**
   * 明细列表返回的是瘦身行（不含编辑态字段），点编辑时由调用方先按 id 取完整记录、
   * 再构造 payload。传了这个回调就完全交给它，不再用行上的 `edit` 直接开窗。
   */
  onEditRequest?: (options: { reconciledReadOnly: boolean }) => void | Promise<void>;
  /**
   * 该记录背后的现金流水已「对账」锁定。
   *
   * 投资/资产类视图（基金、理财、债券、存款、房产、保险、负债）的明细行就是背后的
   * 现金流水，锁定状态不一定在 `edit.reconciledReadOnly` 里，由调用方用
   * `useEntryReconcileState` 查出来传进来；行内锁标记就是在这些视图里就地解锁的入口。
   */
  reconciled?: boolean;
  contextAccountId?: string | null;
}) {
  const [deleting, setDeleting] = useState(false);
  const { t } = useI18n();
  // 已「对账」锁定：编辑窗仍可打开（只读查看），但删除按钮禁用。
  const locked = Boolean(edit?.reconciledReadOnly || reconciled);
  // 行内操作按钮统一 20px 方块 + shrink-0：操作列宽度有限，缺了 shrink-0 时
  // flex 会把其中一部分按钮压窄（与带 shrink-0 的锁/附件图标长短不一）。
  const actionButtonClass = "flex h-5 w-5 shrink-0 items-center justify-center rounded border bg-white transition-colors disabled:opacity-50";

  function onEdit() {
    if (onEditRequest) {
      void Promise.resolve(onEditRequest({ reconciledReadOnly: locked })).catch((error) => {
        console.error("Load entry detail for edit failed:", error);
      });
      return;
    }
    // 锁定状态可能是调用方查出来的（投资/资产视图），一并带进编辑事件，让弹窗只读。
    dispatchEntryEdit({
      entryId,
      edit: edit ? { ...edit, reconciledReadOnly: locked } : edit,
      customEditEvent: customEditEvent
        ? {
            name: customEditEvent.name,
            detail: { ...customEditEvent.detail, reconciledReadOnly: Boolean(customEditEvent.detail?.reconciledReadOnly || locked) },
          }
        : undefined,
    });
  }

  async function onDelete() {
    if (deleting) return;

    setDeleting(true);
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: [entryId],
        confirmMessage: t("entryRowActions.deleteConfirm"),
        t,
      });
      if (!data?.ok) {
        if (data?.code === "DELETE_CANCELLED" || data?.error === "已取消删除") return;
        throw new Error(data?.error ?? t("entryRowActions.deleteFailed"));
      }
      const refreshEntryIds = getDeleteRefreshEntryIds(data, [entryId]);
      const deleteAccountIds = getDeleteRefreshAccountIds(data);
      recordRecentAccounts(deleteAccountIds);
      dispatchFinanceDataChanged({ reason: "entry-delete", accountIds: deleteAccountIds, deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });

    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? t("entryRowActions.timeout")
            : e.message
          : t("entryRowActions.deleteFailed");
      window.alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {/*
        只有调用方明确声明「已锁定」时才渲染锁标记：现金明细页（DetailViewClient）自己会渲染
        行内锁，这里再渲染就会重复。`edit.reconciledReadOnly` 只用来禁用删除 / 只读编辑。
      */}
      {reconciled ? (
        <BasicDetailReconcileLockButton entryId={entryId} reconciled contextAccountId={contextAccountId} />
      ) : null}
      {edit || customEditEvent ? (
        <button
          className={`${actionButtonClass} border-slate-200 text-slate-700 hover:bg-slate-50`}
          type="button"
          onClick={onEdit}
          title={locked ? t("reconcile.readOnlyNotice") : t("insuranceShell.editButton")}
          aria-label={t("insuranceShell.editButton")}
        >
          <Pencil className="h-3 w-3" />
        </button>
      ) : null}
      <button
        className={`${actionButtonClass} border-red-200 text-red-700 hover:bg-red-50`}
        disabled={deleting || locked}
        type="button"
        onClick={onDelete}
        title={locked ? t("reconcile.lockedError") : deleting ? t("ledgerSwitch.deleting") : t("depositShell.deleteButton")}
        aria-label={locked ? t("reconcile.lockedError") : deleting ? t("ledgerSwitch.deleting") : t("depositShell.deleteButton")}
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
