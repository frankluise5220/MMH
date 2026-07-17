"use client";

import { useState } from "react";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

export function DeleteEntryButton({ entryId, entryName }: { entryId: string; entryName?: string }) {
  const [busy, setBusy] = useState(false);

  const handleDelete = async () => {
    setBusy(true);
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: [entryId],
        confirmMessage: `确认删除"${entryName || entryId}"吗？`,
      });
      if (data.ok) {
        const refreshEntryIds = getDeleteRefreshEntryIds(data, [entryId]);
        dispatchFinanceDataChanged({ reason: "entry-delete", deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
      } else {
        if (data.error !== "已取消删除") alert(data.error ?? "删除失败");
      }
    } catch (e) {
      alert("删除失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40"
    >
      删除
    </button>
  );
}
