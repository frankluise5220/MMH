"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";

type EditPayload = {
  requestId?: string;
  entryId: string;
  type: "expense" | "income" | "transfer" | "investment";
  date: string;
  amount: number;
  note: string;
  toNote?: string;
  accountId?: string;
  accountLabel?: string;
  categoryId?: string;
  fromAccountId?: string;
  toAccountId?: string;
  hasFundDetail?: boolean;
  cashAccountId?: string;
  fundCode?: string;
  fundName?: string;
  insuranceProductId?: string | null;
  fundSubtype?: string;
  fundUnits?: number;
  fundNav?: number;
  depositAnnualRate?: number;
  depositInterest?: number;
  depositSourceEntryId?: string | null;
  fundFee?: number;
  fundConfirmDate?: string;
  fundArrivalDate?: string | null;
  fundProductType?: string;
  source?: string | null;
  tagIds?: string[];
};

export function EntryRowActions({
  entryId,
  edit,
}: {
  entryId: string;
  edit?: Omit<EditPayload, "entryId">;
}) {
  const [deleting, setDeleting] = useState(false);

  function onEdit() {
    if (!edit) return;
    const requestId = `edit-${entryId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const detail = { requestId, entryId, ...edit } satisfies EditPayload;

    const pt = edit.fundProductType;
    if (edit.type === "investment" && edit.source === "insurance") {
      window.dispatchEvent(new CustomEvent("mmh:insurance:edit", { detail }));
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

  async function onDelete() {
    if (deleting) return;
    if (!window.confirm("确认删除这条记录吗？删除后不可恢复。")) return;

    setDeleting(true);
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 20000);
      const res = await fetch(
        "/api/v1/entries/delete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entryIds: [entryId] }),
          signal: controller.signal,
        },
      ).finally(() => window.clearTimeout(timeoutId));

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) {
        throw new Error(data?.error ?? `删除失败（HTTP ${res.status}）`);
      }
      window.dispatchEvent(new Event("mmh:fund:refresh"));

    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? "请求超时：删除接口无响应"
            : e.message
          : "删除失败";
      window.alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {edit ? (
        <button
          className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 flex items-center justify-center"
          type="button"
          onClick={onEdit}
          title="编辑"
        >
          <Pencil className="w-4 h-4" />
        </button>
      ) : null}
      <button
        className="h-8 w-8 rounded-md border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50 flex items-center justify-center"
        disabled={deleting}
        type="button"
        onClick={onDelete}
        title={deleting ? "删除中…" : "删除"}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
