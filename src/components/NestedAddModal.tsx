"use client";

import { useEffect, useState, type FormEvent } from "react";

type NestedEntityType = "institution" | "group" | "category";

interface NestedAddModalProps {
  entityType: NestedEntityType;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
}

const ENTITY_CONFIG = {
  institution: {
    title: "新增机构",
    namePlaceholder: "例如：中国银行",
    nameLabel: "机构名称",
    typeLabel: "类型",
    types: [
      { value: "bank", label: "银行" },
      { value: "brokerage", label: "证券" },
      { value: "payment", label: "三方支付" },
      { value: "ewallet", label: "钱包" },
      { value: "other", label: "其他" },
    ],
    apiPath: "/api/v1/institution",
    bodyKey: { name: "name", type: "type" },
  },
  group: {
    title: "新增分组",
    namePlaceholder: "例如：我的银行卡",
    nameLabel: "分组名称",
    typeLabel: null,
    types: [],
    apiPath: "/api/v1/account-group",
    bodyKey: { name: "name" },
  },
  category: {
    title: "新增分类",
    namePlaceholder: "例如：餐饮",
    nameLabel: "分类名称",
    typeLabel: "类型",
    types: [
      { value: "expense", label: "支出" },
      { value: "income", label: "收入" },
    ],
    apiPath: "/api/v1/category",
    bodyKey: { name: "name", type: "type" },
  },
} as const;

export function NestedAddModal({ entityType, open, onClose, onCreated, defaultType }: NestedAddModalProps & { defaultType?: string }) {
  const config = ENTITY_CONFIG[entityType];
  const [name, setName] = useState("");
  const getDefaultType = () => {
    if (defaultType && config.types.some(t => t.value === defaultType)) return defaultType;
    if (entityType === "institution") return "bank";
    if (entityType === "category") return "expense";
    return "";
  };
  const [type, setType] = useState(getDefaultType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setType(getDefaultType());
      setSaving(false);
      setError("");
    }
  }, [open]);

  if (!open) return null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const body: Record<string, string> = {};
      body[config.bodyKey.name] = name.trim();
      if ("type" in config.bodyKey) {
        body[config.bodyKey.type as string] = type;
      }
      const res = await fetch(config.apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok && data[entityType]?.id) {
        const created = data[entityType];
        onCreated(created.id, created.name);
        setName("");
        onClose();
      } else {
        setError(data.error ?? "创建失败");
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">{config.title}</div>
          <button type="button" onClick={onClose}
            className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">
            关闭
          </button>
        </div>
        <form className="p-4 space-y-3" onSubmit={onSubmit}>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">{config.nameLabel}</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={config.namePlaceholder}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              autoFocus
              required
            />
          </div>
          {config.typeLabel && config.types.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{config.typeLabel}</div>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              >
                {config.types.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          )}
          {error && <div className="text-xs text-red-500">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">
              取消
            </button>
            <button type="submit" disabled={saving || !name.trim()}
              className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
