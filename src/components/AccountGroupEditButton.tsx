"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AccountGroupEditButton({
  group,
  action,
}: {
  group: { id: string; name: string; sortOrder: number };
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const [sortOrder, setSortOrder] = useState(String(group.sortOrder));
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const fd = new FormData();
      fd.set("groupId", group.id);
      fd.set("groupName", name.trim());
      fd.set("sortOrder", sortOrder);
      await action(fd);
      setOpen(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setName(group.name); setSortOrder(String(group.sortOrder)); setOpen(true); }}
        className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50"
      >
        编辑
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-80" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between rounded-t-xl">
              <div className="text-sm font-semibold text-slate-800">编辑分组</div>
              <button type="button" onClick={() => setOpen(false)} className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50">关闭</button>
            </div>
            <form className="p-4 space-y-3" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">分组名称</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="分组名称"
                  required
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">排序</div>
                <input
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
              </div>
              <div className="flex justify-end pt-1">
                <button type="submit" disabled={saving} className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
