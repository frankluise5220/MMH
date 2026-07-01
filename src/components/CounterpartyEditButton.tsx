"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type CounterpartyType = "family_member" | "person" | "organization" | "company" | "friend" | "other";

const TYPE_LABELS: Record<CounterpartyType, string> = {
  family_member: "家庭成员",
  person: "个人",
  organization: "机构",
  company: "公司",
  friend: "朋友",
  other: "其他",
};

export function CounterpartyEditButton({
  counterparty,
  action,
}: {
  counterparty: { id: string; name: string; shortName?: string | null; type: string | null };
  action: (formData: FormData) => void | Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(counterparty.name);
  const [shortName, setShortName] = useState(counterparty.shortName ?? "");
  const [type, setType] = useState<CounterpartyType>((counterparty.type as CounterpartyType) ?? "person");
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    const fd = new FormData();
    fd.set("counterpartyId", counterparty.id);
    fd.set("name", name.trim());
    fd.set("shortName", shortName.trim());
    fd.set("type", type);
    try {
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
        onClick={() => {
          setName(counterparty.name);
          setShortName(counterparty.shortName ?? "");
          setType((counterparty.type as CounterpartyType) ?? "person");
          setOpen(true);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:text-blue-600"
        title="编辑"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">编辑往来对象</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                关闭
              </button>
            </div>
            <form className="space-y-3 p-4" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">名称</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  required
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">简称</div>
                <input
                  value={shortName}
                  onChange={(e) => setShortName(e.target.value)}
                  placeholder="例如：张三、某公司"
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">类型</div>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as CounterpartyType)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                >
                  {(Object.keys(TYPE_LABELS) as CounterpartyType[]).map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end">
                <button type="submit" disabled={saving} className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
