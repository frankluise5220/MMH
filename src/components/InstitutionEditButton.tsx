"use client";

import { Pencil } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type InstitutionType = "family_member" | "person" | "organization" | "bank" | "insurance" | "brokerage" | "payment" | "ewallet" | "debt" | "other";
const TYPE_LABELS: Record<InstitutionType, string> = {
  family_member: "家庭成员",
  person: "往来人员",
  organization: "往来机构",
  bank: "银行",
  insurance: "保险公司",
  brokerage: "证券",
  payment: "三方支付",
  ewallet: "钱包",
  debt: "债权债务",
  other: "其他",
};

export function InstitutionEditButton({
  institution,
  action,
}: {
  institution: { id: string; name: string; shortName?: string | null; type: string | null };
  action: (formData: FormData) => void | Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(institution.name);
  const [shortName, setShortName] = useState(institution.shortName ?? "");
  const [type, setType] = useState<InstitutionType>((institution.type as InstitutionType) ?? "other");
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    const fd = new FormData();
    fd.set("institutionId", institution.id);
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
          setName(institution.name);
          setShortName(institution.shortName ?? "");
          setType((institution.type as InstitutionType) ?? "other");
          setOpen(true);
        }}
        className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-blue-600 hover:border-blue-200"
        title="编辑"
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">编辑往来对象</div>
              <button type="button" onClick={() => setOpen(false)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">关闭</button>
            </div>
            <form className="p-4 space-y-3" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">往来对象名称</div>
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
                  placeholder="例如：张三、中行、平安"
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">类型</div>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as InstitutionType)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                >
                  {(Object.keys(TYPE_LABELS) as InstitutionType[]).map((t) => (
                    <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end">
                <button type="submit" disabled={saving}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
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
