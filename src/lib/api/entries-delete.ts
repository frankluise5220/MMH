import { showChoiceDialog, showConfirmDialog } from "@/lib/client/confirm-dialog";

export type EntriesDeleteRequest = {
  entryIds: string[];
  linkedAction?: "deleteBusiness" | "keepBusiness";
  checkOnly?: boolean;
  action?: undefined;
} | {
  action: "restore";
  transactionIds: string[];
};

export type EntryBusinessDeleteImpact = {
  entryId: string;
  businessEntryId: string;
  businessType: string;
  businessLabel: string;
  legacyCombinedRecord?: boolean;
};

export type EntriesDeleteResponse =
  | {
      ok: true;
      message: string;
      count?: number;
      deletedCount?: number;
      keptBusinessCount?: number;
      deletedEntryIds?: string[];
      removedEntryIds?: string[];
      needConfirm?: boolean;
      impacts?: EntryBusinessDeleteImpact[];
    }
  | { ok: false; error: string; needConfirm?: boolean; impacts?: EntryBusinessDeleteImpact[] };

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

function describeBusinessImpacts(impacts: EntryBusinessDeleteImpact[] = []) {
  const counts = new Map<string, number>();
  for (const impact of impacts) {
    const label = impact.businessLabel || "业务明细";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => `${label} ${count} 条`)
    .join("、") || "业务明细";
}

export async function deleteEntriesWithLinkedPrompt({
  entryIds,
  confirmMessage,
}: {
  entryIds: string[];
  confirmMessage: string;
}): Promise<EntriesDeleteResponse> {
  if (entryIds.length === 0) return { ok: false, error: "没有可删除的记录" };

  const precheck = await callDeleteEntries({ entryIds, checkOnly: true });
  if (!precheck.ok && !precheck.needConfirm) return precheck;

  const impacts = precheck.impacts ?? [];
  if (impacts.length > 0 || precheck.needConfirm) {
    const impactText = describeBusinessImpacts(impacts);
    const linkedAction = await showChoiceDialog<"keepBusiness" | "deleteBusiness">({
      title: entryIds.length > 1 ? "选择批量删除范围" : "选择删除范围",
      message:
        `当前选择关联了 ${impactText}。\n\n` +
        "请选择这次删除要影响的范围：\n" +
        "只删本账户记录：只从当前资金账户流水中移除，并保留业务侧记录。\n" +
        "两边一起删除：同时删除当前资金流水和关联业务记录。",
      choices: [
        { value: "keepBusiness", label: "只删本账户记录" },
        { value: "deleteBusiness", label: "两边一起删除", tone: "danger" },
      ],
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!linkedAction) return { ok: false, error: "已取消删除" };
    return callDeleteEntries({ entryIds, linkedAction });
  }

  const confirmed = await showConfirmDialog({
    title: entryIds.length > 1 ? "删除选中记录" : "删除这条记录",
    message: confirmMessage,
    confirmLabel: "删除",
    cancelLabel: "取消",
    tone: "danger",
  });
  if (!confirmed) return { ok: false, error: "已取消删除" };

  return callDeleteEntries({ entryIds });
}
