"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";

export function SettingsDeleteButton({
  label,
  entity,
  id,
  refresh,
}: {
  label: string;
  entity: "accountGroup" | "account" | "institution" | "category";
  id: string;
  refresh?: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function onDelete() {
    if (deleting) return;
    if (!window.confirm(`确认删除「${label}」？删除后不可恢复。`)) return;

    setDeleting(true);
    try {
      const res = await fetch("/api/v1/settings/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity, id }),
      });

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) {
        window.alert(data?.error ?? "删除失败");
        return;
      }
      if (refresh !== false) {
        window.dispatchEvent(new Event("mmh:fund:refresh"));
        router.refresh();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      window.alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onDelete}
      disabled={deleting}
      title={`删除：${label}`}
      className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
    >
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  );
}
