"use client";

import { useState } from "react";
import { SettingsActionButton } from "@/components/settings/SettingsPageScaffold";
import { notifySettingsDataChanged, type SettingsDataScope } from "@/lib/client/settingsCache";

function scopeForEntity(entity: "accountGroup" | "account" | "institution" | "counterparty" | "category"): SettingsDataScope {
  return entity === "category" ? "categories" : "accounts";
}

export function SettingsDeleteButton({
  label,
  entity,
  id,
  refresh,
  onDeleted,
}: {
  label: string;
  entity: "accountGroup" | "account" | "institution" | "counterparty" | "category";
  id: string;
  refresh?: boolean;
  onDeleted?: () => void;
}) {
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
      void notifySettingsDataChanged({ scope: scopeForEntity(entity), reason: `${entity}:delete`, prefetch: true });
      onDeleted?.();
      if (refresh !== false) {
        window.dispatchEvent(new Event("mmh:fund:refresh"));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      window.alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <SettingsActionButton
      label={`删除：${label}`}
      variant="delete"
      onClick={onDelete}
      disabled={deleting}
    />
  );
}
