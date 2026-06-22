"use client";

import { useEffect, useState, type FormEvent } from "react";

type NestedEntityType = "institution" | "account" | "group" | "category";

interface NestedAddModalProps {
  entityType: NestedEntityType;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string, extra?: { parentId?: string; kind?: string }) => void;
  defaultType?: string;
  /** Extra fields to merge into the POST body (e.g. { kind: "investment", investProductType: "fund" }) */
  extraFields?: Record<string, string>;
  /** Fields to hide from the form UI (e.g. ["kind"] when extraFields already specifies it) */
  hiddenFields?: string[];
  /** Existing entity names for client-side duplicate check (institution/group) */
  existingNames?: string[];
  /** For category type: available parent categories to create subcategories under */
  parentCategories?: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string }>;
  /** For category type: pre-selected parent category */
  defaultParentId?: string;
}

const ENTITY_CONFIG = {
  institution: {
    title: "新增机构",
    namePlaceholder: "例如：中国银行",
    nameLabel: "机构名称",
    typeLabel: "类型",
    typeKey: "type",
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
  account: {
    title: "新增账户",
    namePlaceholder: "例如：招商卡、微信零钱",
    nameLabel: "账户名称",
    typeLabel: "账户类型",
    typeKey: "kind",
    types: [
      { value: "bank_debit", label: "借记卡" },
      { value: "bank_credit", label: "信用卡" },
      { value: "bank_savings", label: "储蓄卡" },
      { value: "ewallet", label: "电子钱包" },
      { value: "cash", label: "现金" },
      { value: "investment", label: "投资" },
      { value: "loan", label: "贷款" },
      { value: "other", label: "其他" },
    ],
    apiPath: "/api/v1/accounts",
    bodyKey: { name: "name", kind: "kind" },
  },
  group: {
    title: "新增所有人",
    namePlaceholder: "例如：我的银行卡",
    nameLabel: "所有人名称",
    typeLabel: null,
    typeKey: null,
    types: [],
    apiPath: "/api/v1/account-group",
    bodyKey: { name: "name" },
  },
  category: {
    title: "新增分类",
    namePlaceholder: "例如：餐饮",
    nameLabel: "分类名称",
    typeLabel: "类型",
    typeKey: "type",
    types: [
      { value: "expense", label: "支出" },
      { value: "income", label: "收入" },
    ],
    apiPath: "/api/v1/category",
    bodyKey: { name: "name", type: "type" },
  },
} as const;

export function NestedAddModal({
  entityType,
  open,
  onClose,
  onCreated,
  defaultType,
  extraFields,
  hiddenFields,
  existingNames,
  parentCategories,
  defaultParentId,
}: NestedAddModalProps) {
  const config = ENTITY_CONFIG[entityType];

  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [parentId, setParentId] = useState(defaultParentId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dupWarning, setDupWarning] = useState("");

  /** Determine default type from defaultType, extraFields, or fallback */
  function getDefaultType() {
    if (extraFields && config.typeKey && extraFields[config.typeKey]) {
      if (config.types.some(t => t.value === extraFields[config.typeKey])) return extraFields[config.typeKey];
    }
    if (defaultType && config.types.some(t => t.value === defaultType)) return defaultType;
    if (entityType === "institution") return "bank";
    if (entityType === "category") return "expense";
    if (entityType === "account") return "bank_debit";
    return "";
  }

  useEffect(() => {
    if (open) {
      setName("");
      setType(getDefaultType());
      setParentId(defaultParentId ?? "");
      setSaving(false);
      setError("");
      setDupWarning("");
    }
  }, [open]);

  /** Determine if the type selector should be shown:
   *  - Hidden if hiddenFields includes the type key (e.g. "kind" or "type")
   *  - Hidden if extraFields already provides the type key value
   *  - Hidden for categories when parentId is set (type inherited from parent)
   */
  const typeKey = config.typeKey;
  const shouldHideType = !typeKey
    || (hiddenFields?.includes(typeKey))
    || (extraFields && typeKey in extraFields)
    || (entityType === "category" && parentId);

  if (!open) return null;

  /** Client-side duplicate name check for institution & group */
  function checkDuplicate(nameValue: string) {
    if (!existingNames || !nameValue.trim()) { setDupWarning(""); return; }
    const trimmed = nameValue.trim();
    if (existingNames.some(n => n.trim() === trimmed)) {
      setDupWarning(`"${trimmed}" 已存在，创建时将提示重复`);
    } else {
      setDupWarning("");
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const body: Record<string, string> = {};
      body[config.bodyKey.name] = name.trim();
      // Add type/kind field if applicable
      if (typeKey && type) {
        body[typeKey] = type;
      }
      // Merge extraFields into body
      if (extraFields) {
        Object.entries(extraFields).forEach(([k, v]) => {
          if (v !== undefined && v !== "") body[k] = v;
        });
      }
      // Include parentId for category subcategories
      if (entityType === "category" && parentId) {
        body.parentId = parentId;
      }

      const res = await fetch(config.apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok && data[entityType]?.id) {
        const created = data[entityType];
        onCreated(created.id, created.name, {
          parentId: parentId || undefined,
          kind: entityType === "account" ? (type || created.kind || "") : undefined,
        });
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
      <div className="w-full max-w-sm rounded-xl bg-surface-white border border-foreground/10 shadow-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-foreground/10 bg-background/50 flex items-center justify-between">
          <div className="text-sm font-semibold text-foreground">{config.title}</div>
          <button type="button" onClick={onClose}
            className="h-8 px-2 rounded-ui border border-foreground/10 bg-surface-white text-sm text-foreground hover:bg-background/30">
            关闭
          </button>
        </div>
        <form className="p-4 space-y-3" onSubmit={onSubmit}>
          <div className="space-y-1">
            <div className="text-xs font-medium text-foreground/60">{config.nameLabel}</div>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); checkDuplicate(e.target.value); }}
              placeholder={config.namePlaceholder}
              className="h-9 w-full rounded-ui border border-foreground/10 bg-surface-white px-3 text-sm outline-none focus:border-accent-green/30"
              autoFocus
              required
            />
            {dupWarning && <div className="text-xs text-amber-600">{dupWarning}</div>}
          </div>
          {!shouldHideType && config.typeLabel && config.types.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-foreground/60">{config.typeLabel}</div>
              <select
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-9 w-full rounded-ui border border-foreground/10 bg-surface-white px-3 text-sm outline-none focus:border-accent-green/30"
              >
                {config.types.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          )}
          {/* Parent category selector — only for category entityType when parentCategories provided */}
          {entityType === "category" && parentCategories && parentCategories.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-foreground/60">上级分类</div>
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className="h-9 w-full rounded-ui border border-foreground/10 bg-surface-white px-3 text-sm outline-none focus:border-accent-green/30"
              >
                <option value="">无（根分类）</option>
                {parentCategories.map(pc => (
                  <option key={pc.id} value={pc.id}>{pc.label}</option>
                ))}
              </select>
            </div>
          )}
          {/* Hidden inputs for extraFields that need form submission */}
          {extraFields && Object.entries(extraFields).map(([k, v]) => (
            k !== typeKey ? <input key={k} type="hidden" name={k} value={v} /> : null
          ))}
          {error && <div className="text-xs text-red-500">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="h-9 px-3 rounded-ui border border-foreground/10 bg-surface-white text-sm text-foreground hover:bg-background/30">
              取消
            </button>
            <button type="submit" disabled={saving || !name.trim()}
              className="h-9 px-4 rounded-ui bg-foreground text-background text-sm hover:bg-foreground/90 disabled:opacity-50">
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
