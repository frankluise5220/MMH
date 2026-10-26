import { showBlockingLoading } from "@/lib/client/blocking-loading";
import { showChoiceDialog, showConfirmDialog } from "@/lib/client/confirm-dialog";

type EntriesDeleteRequest = {
  entryIds: string[];
  linkedAction?: "deleteBusiness" | "keepBusiness";
  checkOnly?: boolean;
  action?: undefined;
} | {
  action: "restore";
  transactionIds: string[];
};

export type EntryBusinessDeleteImpact = {
  selectedEntryId?: string;
  selectedSide?: "cash" | "business" | "both";
  entryId: string;
  businessEntryId: string;
  counterpartEntryId?: string | null;
  counterpartLabel?: string;
  businessType: string;
  businessLabel: string;
  legacyCombinedRecord?: boolean;
  /** 业务侧另外显示的派生行数（基金买入/退回/分红等）：整笔删除提示要把它算进条数。 */
  businessDisplayRowCount?: number;
};

type EntriesDeleteResponse =
  | {
      ok: true;
      message: string;
      count?: number;
      deletedCount?: number;
      keptBusinessCount?: number;
      deletedEntryIds?: string[];
      removedEntryIds?: string[];
      accountIds?: string[];
      needConfirm?: boolean;
      impacts?: EntryBusinessDeleteImpact[];
      depositGeneratedRecordCount?: number;
    }
  | { ok: false; error: string; code?: string; needConfirm?: boolean; impacts?: EntryBusinessDeleteImpact[]; depositGeneratedRecordCount?: number };

export type I18nT = (key: string, params?: Record<string, string | number>) => string;

export async function callDeleteEntries(body: EntriesDeleteRequest): Promise<EntriesDeleteResponse> {
  const res = await fetch("/api/v1/entries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function getDeleteRefreshEntryIds(data: EntriesDeleteResponse, fallbackEntryIds: string[]) {
  if (!data.ok) return fallbackEntryIds;
  const ids = data.removedEntryIds?.length
    ? data.removedEntryIds
    : data.deletedEntryIds?.length
      ? data.deletedEntryIds
      : fallbackEntryIds;
  return Array.from(new Set(ids.filter(Boolean)));
}

export function getDeleteRefreshAccountIds(data: EntriesDeleteResponse) {
  return data.ok ? Array.from(new Set((data.accountIds ?? []).filter(Boolean))) : [];
}

function describeBusinessImpacts(impacts: EntryBusinessDeleteImpact[] = [], t: I18nT, labelOverride?: string) {
  const counts = new Map<string, number>();
  // 整笔删除：资金侧的每条腿各占一行，业务侧派生的行（基金买入/退回/分红）也各占一行，
  // 提示里的「共 N 条」要把两边加起来。同一笔业务单的多条资金腿只加一次派生行数。
  const displayRowCounted = new Set<string>();
  for (const impact of impacts) {
    const label = labelOverride || impact.counterpartLabel || impact.businessLabel || t("entriesDelete.linkedRecord");
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const businessKey = impact.businessEntryId;
    if (!businessKey || displayRowCounted.has(businessKey)) continue;
    displayRowCounted.add(businessKey);
    const derivedRows = impact.businessDisplayRowCount ?? 0;
    if (derivedRows > 0) counts.set(label, (counts.get(label) ?? 0) + derivedRows);
  }
  const parts = Array.from(counts.entries()).map(([label, count]) => t("entriesDelete.impactCount", { label, count }));
  return parts.join(", ") || t("entriesDelete.businessDetail");
}

export async function deleteEntriesWithLinkedPrompt({
  entryIds,
  confirmMessage,
  selectedRecordLabel,
  counterpartRecordLabel,
  t,
}: {
  entryIds: string[];
  confirmMessage: string;
  selectedRecordLabel?: string;
  counterpartRecordLabel?: string;
  t: I18nT;
}): Promise<EntriesDeleteResponse> {
  if (entryIds.length === 0) return { ok: false, error: t("entriesDelete.noDeletableRecord") };

  const precheck = await callDeleteEntries({ entryIds, checkOnly: true });
  if (!precheck.ok && !precheck.needConfirm) return precheck;

  const impacts = precheck.impacts ?? [];
  if (impacts.length > 0 || precheck.needConfirm) {
    const impactText = describeBusinessImpacts(impacts, t, counterpartRecordLabel);
    const selectedIdSet = new Set(entryIds);
    const linkedSelectedEntryIds = new Set(
      impacts
        .map((impact) => impact.selectedEntryId || impact.entryId)
        .filter((id): id is string => Boolean(id) && selectedIdSet.has(id)),
    );
    const linkedSelectedCount = linkedSelectedEntryIds.size;
    const unlinkedSelectedCount = Math.max(0, entryIds.length - linkedSelectedCount);
    const mixedSelection = linkedSelectedCount > 0 && unlinkedSelectedCount > 0;
    // 整笔删除把同业务单的其余资金腿也带进了 impacts，判断「选中的是业务侧」只能看选中项。
    const selectedImpacts = impacts.filter((impact) => selectedIdSet.has(impact.selectedEntryId || impact.entryId));
    const allBusinessSide = selectedImpacts.length > 0 && selectedImpacts.every((impact) => impact.selectedSide === "business");
    // 存单口径（2026-09-15）：删除存单（buy）时，其已生成的到期/取息记录不会连带
    // 删除——在范围选择弹窗中附加提示，让用户带着这个口径做选择。
    const depositGeneratedRecordCount = precheck.depositGeneratedRecordCount ?? 0;
    const depositGeneratedWarning = depositGeneratedRecordCount > 0
      ? `\n\n${t("entriesDelete.depositGeneratedWarning", { count: depositGeneratedRecordCount })}`
      : "";
    const businessRecordLabel = t("entriesDelete.businessRecord");
    const selectedLabel = allBusinessSide
      ? (Array.from(new Set(selectedImpacts.map((impact) => impact.businessLabel || businessRecordLabel))).join(", ") || businessRecordLabel)
      : t("entriesDelete.thisAccountRecord");
    const effectiveSelectedLabel = selectedRecordLabel || selectedLabel;
    const counterpartLabel = counterpartRecordLabel || (allBusinessSide ? t("entriesDelete.linkedCashTransaction") : t("entriesDelete.businessSideRecord"));
    const messageKey = mixedSelection ? "entriesDelete.rangeMessageMixed" : "entriesDelete.rangeMessage";
    const linkedAction = await showChoiceDialog<"keepBusiness" | "deleteBusiness">({
      title: entryIds.length > 1 ? t("entriesDelete.batchRangeTitle") : t("entriesDelete.rangeTitle"),
      message: t(messageKey, {
        impactText,
        selectedLabel: effectiveSelectedLabel,
        counterpartLabel,
        linkedCount: linkedSelectedCount,
        unlinkedCount: unlinkedSelectedCount,
      }) + depositGeneratedWarning,
      choices: [
        {
          value: "keepBusiness",
          label: t(mixedSelection ? "entriesDelete.onlyDeleteMixedLabel" : "entriesDelete.onlyDeleteLabel", { label: effectiveSelectedLabel }),
        },
        {
          value: "deleteBusiness",
          label: t(mixedSelection ? "entriesDelete.deleteBothMixedLabel" : "entriesDelete.deleteBothLabel"),
          tone: "danger",
        },
      ],
      cancelLabel: t("common.cancel"),
      tone: "danger",
    });
    if (!linkedAction) return { ok: false, code: "DELETE_CANCELLED", error: t("entriesDelete.cancelled") };
    const closeBlocking = showBlockingLoading(t("common.batchDeleting"));
    try {
      return await callDeleteEntries({ entryIds, linkedAction });
    } finally {
      closeBlocking();
    }
  }

  const confirmed = await showConfirmDialog({
    title: entryIds.length > 1 ? t("entriesDelete.deleteSelectedTitle") : t("entriesDelete.deleteRecordTitle"),
    message: confirmMessage,
    confirmLabel: t("common.delete"),
    cancelLabel: t("common.cancel"),
    tone: "danger",
  });
  if (!confirmed) return { ok: false, code: "DELETE_CANCELLED", error: t("entriesDelete.cancelled") };

  const closeBlocking = showBlockingLoading(t("common.batchDeleting"));
  try {
    return await callDeleteEntries({ entryIds });
  } finally {
    closeBlocking();
  }
}
