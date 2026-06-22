"use client";

import { useState } from "react";

export function DeleteEntryButton({ entryId, entryName }: { entryId: string; entryName?: string }) {
  const [busy, setBusy] = useState(false);

  const handleDelete = async () => {
    const ok = confirm(`确认删除"${entryName || entryId}"吗？`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: [entryId] }),
      });
      const data = await res.json();
      if (data.ok) {
        window.dispatchEvent(new Event("mmh:fund:refresh"));

      } else {
        alert(data.error ?? "删除失败");
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
