"use client";

import { useEffect, useState, useCallback, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { kindLabel, kindOrder, kindHex, institutionTypeLabel } from "@/lib/account-kinds";
import { PRODUCT_LABELS, type ProductType } from "@/lib/investment-config";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";

/* ---- Types ---- */

type NestedEntityType = "institution" | "account" | "group" | "category";

type FieldDef = {
  key: string;
  label: string;
  type: "text" | "select";
  placeholder?: string;
  /** Static options (for selects whose values are fixed) */
  options?: Array<{ value: string; label: string }>;
  /** Dynamic option key — maps to fieldData prop for runtime-populated selects */
  optionsFromData?: string;
  /** Condition to show/hide this field based on current form state */
  condition?: (form: Record<string, string>) => boolean;
  /** Default value when the form opens */
  defaultValue?: string;
  /** Whether this field supports nested inline creation (shows "+新增" button) */
  nestedCreate?: NestedEntityType;
};

/* ---- Compact mode props (existing NestedAddModal behavior) ---- */

type CompactModeProps = {
  mode: "compact";
  entityType: NestedEntityType;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string, extra?: { parentId?: string; kind?: string; type?: string }) => void;
  defaultType?: string;
  /** Extra fields to merge into the POST body (e.g. { kind: "investment", investProductType: "fund" }) */
  extraFields?: Record<string, string>;
  /** Fields to hide from the form UI (e.g. ["kind"] when extraFields already specifies it) */
  hiddenFields?: string[];
  /** Existing entity names for client-side duplicate check */
  existingNames?: string[];
  /** For category type: available parent categories to create subcategories under */
  parentCategories?: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string; isGroup?: boolean }>;
  /** For category type: pre-selected parent category */
  defaultParentId?: string;
  /** Pre-populated data for dynamic select fields (groups & institutions) in compact account creation */
  nestedFieldData?: Record<string, Array<{ id: string; name: string; type?: string }>>;
};

/* ---- Full mode props (new, for settings pages) ---- */

type FullModeProps = {
  mode: "full";
  entityType: NestedEntityType;
  /** Layout variant for full mode */
  layout?: "card" | "inline";
  onCreated: (id: string, name: string, extra?: { parentId?: string; kind?: string; type?: string }) => void;
  /** Dynamic data for select fields that need runtime-populated options */
  fieldData?: Record<string, Array<{ id: string; name: string; type?: string }>>;
  /** Existing entity names for client-side duplicate check */
  existingNames?: string[];
  /** For category: available parent categories */
  parentCategories?: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string; isGroup?: boolean }>;
  /** For category: pre-selected parent */
  defaultParentId?: string;
  /** For account: pre-selected kind */
  defaultType?: string;
  /** Extra fields to merge into POST body */
  extraFields?: Record<string, string>;
  /** Fields to hide from the form UI */
  hiddenFields?: string[];
};

export type EntityCreateFormProps = CompactModeProps | FullModeProps;

/* ---- Institution type options ---- */

const INSTITUTION_TYPES = [
  { value: "bank", label: "银行" },
  { value: "brokerage", label: "证券" },
  { value: "payment", label: "三方支付" },
  { value: "ewallet", label: "钱包" },
  { value: "other", label: "其他" },
];

/* ---- Category type options ---- */

const CATEGORY_TYPES = [
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "investment", label: "投资" },
];

/* ---- Cost basis method options ---- */

const COST_BASIS_OPTIONS = [
  { value: "moving_avg", label: "移动平均" },
  { value: "fifo", label: "先进先出" },
  { value: "lifo", label: "后进先出" },
];

/* ---- Account kind options (from account-kinds.ts) ---- */

const ACCOUNT_KIND_OPTIONS = kindOrder.map(k => ({ value: k, label: kindLabel(k) }));

/* ---- Investment product type options (from investment-config.ts) ---- */

const INVEST_PRODUCT_OPTIONS = (Object.keys(PRODUCT_LABELS) as ProductType[]).map(pt => ({
  value: pt,
  label: PRODUCT_LABELS[pt],
}));

/* ---- ENTITY_CONFIG ---- */

const ENTITY_CONFIG = {
  institution: {
    title: "新增机构",
    namePlaceholder: "例如：中国银行",
    nameLabel: "机构名称",
    typeLabel: "类型",
    typeKey: "type",
    types: INSTITUTION_TYPES,
    apiPath: "/api/v1/institution",
    bodyKey: { name: "name", type: "type" },
    fullFields: [
      { key: "name", label: "机构名称", type: "text", placeholder: "例如：中国银行" },
      { key: "type", label: "类型", type: "select", options: INSTITUTION_TYPES, defaultValue: "bank" },
    ] as FieldDef[],
  },
  account: {
    title: "新增账户",
    namePlaceholder: "例如：招商卡、微信零钱",
    nameLabel: "账户名称",
    typeLabel: "账户类型",
    typeKey: "kind",
    types: ACCOUNT_KIND_OPTIONS,
    apiPath: "/api/v1/accounts",
    bodyKey: { name: "name", kind: "kind" },
    fullFields: [
      { key: "name", label: "账户名称", type: "text", placeholder: "例如：招商卡、微信零钱" },
      { key: "kind", label: "账户类型", type: "select", options: ACCOUNT_KIND_OPTIONS, defaultValue: "bank_debit" },
      { key: "investProductType", label: "投资账户类型", type: "select", options: INVEST_PRODUCT_OPTIONS, defaultValue: "fund", condition: (f) => f.kind === "investment" },
      { key: "groupId", label: "所有人", type: "select", optionsFromData: "groupId", nestedCreate: "group" },
      { key: "institutionId", label: "机构", type: "select", optionsFromData: "institutionId", nestedCreate: "institution" },
      { key: "currency", label: "币种", type: "text", defaultValue: "CNY", placeholder: "CNY" },
      { key: "billingDay", label: "账单日", type: "text", placeholder: "1-31", condition: (f) => f.kind === "bank_credit" || f.kind === "loan" },
      { key: "repaymentDay", label: "还款日", type: "text", placeholder: "1-31", condition: (f) => f.kind === "bank_credit" || f.kind === "loan" },
      { key: "creditLimit", label: "额度", type: "text", placeholder: "例如：50000", condition: (f) => f.kind === "bank_credit" || f.kind === "loan" },
      { key: "numberMasked", label: "卡号后四位", type: "text", placeholder: "例如：3833", condition: (f) => f.kind === "bank_credit" || f.kind === "loan" },
      { key: "costBasisMethod", label: "成本摊薄方式", type: "select", options: COST_BASIS_OPTIONS, defaultValue: "moving_avg", condition: (f) => f.kind === "investment" },
    ] as FieldDef[],
  },
  group: {
    title: "新增所有人",
    namePlaceholder: "所有人",
    nameLabel: "所有人名称",
    typeLabel: null,
    typeKey: null,
    types: [],
    apiPath: "/api/v1/account-group",
    bodyKey: { name: "name" },
    fullFields: [
      { key: "name", label: "所有人名称", type: "text", placeholder: "所有人" },
    ] as FieldDef[],
  },
  category: {
    title: "新增分类",
    namePlaceholder: "例如：餐饮",
    nameLabel: "分类名称",
    typeLabel: "类型",
    typeKey: "type",
    types: CATEGORY_TYPES,
    apiPath: "/api/v1/category",
    bodyKey: { name: "name", type: "type" },
    fullFields: [
      { key: "name", label: "分类名称", type: "text", placeholder: "例如：餐饮" },
      { key: "type", label: "类型", type: "select", options: CATEGORY_TYPES, defaultValue: "expense",
        condition: (f) => !f.parentId /* hide type when parentId is set (inherits from parent) */ },
      { key: "parentId", label: "上级分类", type: "select", optionsFromData: "parentId" },
    ] as FieldDef[],
  },
} as const;

/* ---- Helper: build select options for a dynamic field ---- */

function buildSelectOptions(
  field: FieldDef,
  fieldData?: Record<string, Array<{ id: string; name: string }>>,
  parentCategories?: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string; isGroup?: boolean }>,
  hideRootOption?: boolean,
): Array<{ value: string; label: string }> {
  if (field.options) return field.options;
  if (field.key === "parentId" && parentCategories) {
    const rootOpt = hideRootOption ? [] : [{ value: "", label: "无（根分类）" }];
    return [...rootOpt, ...parentCategories.map(pc => {
      // Use indentation for depth > 0 entries
      const indent = pc.depth && pc.depth > 0 ? `    `.repeat(pc.depth) : "";
      return { value: pc.id, label: `${indent}${pc.name}` };
    })];
  }
  if (field.optionsFromData && fieldData) {
    const data = fieldData[field.optionsFromData];
    if (data) {
      const emptyLabel = field.key === "groupId" ? "所有人" : field.key === "institutionId" ? "无" : "无";
      return [{ value: "", label: emptyLabel }, ...data.map(d => ({ value: d.id, label: d.name }))];
    }
  }
  return [];
}

/* ---- Main Component ---- */

export function EntityCreateForm(props: EntityCreateFormProps) {
  const mode = props.mode;
  const entityType = props.entityType;
  const config = ENTITY_CONFIG[entityType];
  const layout = mode === "full" ? (props.layout ?? "card") : "modal";

  // Unpack mode-specific props
  const onCreated = props.onCreated;
  const existingNames = props.existingNames;
  const extraFields = props.extraFields;
  const parentCategories = mode === "compact" ? props.parentCategories : props.parentCategories;
  const defaultParentId = mode === "compact" ? props.defaultParentId : props.defaultParentId ?? "";
  const fieldData = mode === "full" ? props.fieldData : undefined;
  const compactNestedFieldData = mode === "compact" ? props.nestedFieldData : undefined;
  const hiddenFields = mode === "compact" ? props.hiddenFields : props.hiddenFields ?? [];

  // Compact mode: open/onClose
  const open = mode === "compact" ? props.open : undefined;
  const onClose = mode === "compact" ? props.onClose : undefined;
  const defaultType = props.defaultType;

  /* ---- Form state ---- */
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dupWarning, setDupWarning] = useState("");

  // Full card mode: expanded state
  const [expanded, setExpanded] = useState(false);

  // Nested creation state (for full mode "+新增" buttons on dynamic select fields)
  const [nestedEntityType, setNestedEntityType] = useState<NestedEntityType | null>(null);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [nestedFieldData, setNestedFieldData] = useState<Record<string, Array<{ id: string; name: string; type?: string }>>>(fieldData ?? compactNestedFieldData ?? {});

  /** Initialize form state */
  const initForm = useCallback(() => {
    const initial: Record<string, string> = {};

    if (mode === "compact") {
      // Compact mode: just name + type
      initial.name = "";
      initial.type = getDefaultTypeCompact();
      initial.parentId = defaultParentId ?? "";
    } else {
      // Full mode: set parentId first so type condition can evaluate correctly
      if (defaultParentId) initial.parentId = defaultParentId;
      // All fields from fullFields
      for (const field of config.fullFields) {
        // Check condition — now parentId is set if defaultParentId was provided
        if (field.condition && !field.condition(initial)) continue;
        // Skip if the key is already set (e.g. parentId from defaultParentId)
        if (initial[field.key] !== undefined) continue;
        // Default value
        if (field.defaultValue) initial[field.key] = field.defaultValue;
        // For dynamic selects, default to empty
        if (field.optionsFromData) initial[field.key] = "";
        // For conditional selects without defaultValue, set to empty
        if (field.type === "select" && !field.defaultValue && !field.optionsFromData) initial[field.key] = field.options?.[0]?.value ?? "";
        // For text fields without defaultValue, set to empty
        if (field.type === "text" && !field.defaultValue) initial[field.key] = "";
      }
      // Apply defaultType override
      if (defaultType) initial.type = defaultType;
      // Apply extraFields
      if (extraFields) {
        Object.entries(extraFields).forEach(([k, v]) => {
          if (v !== undefined) initial[k] = v;
        });
      }
    }

    setForm(initial);
    setSaving(false);
    setError("");
    setDupWarning("");
  }, [mode, entityType, defaultType, extraFields, defaultParentId]);

  useEffect(() => {
    if (mode === "compact" && open) {
      initForm();
      // Sync nestedFieldData with compact prop changes
      if (compactNestedFieldData) setNestedFieldData(compactNestedFieldData);
    }
  }, [mode, open, initForm, compactNestedFieldData]);

  useEffect(() => {
    if (mode === "full") {
      initForm();
      // Sync nestedFieldData with fieldData changes
      if (fieldData) setNestedFieldData(fieldData);
    }
  }, [mode, initForm, fieldData]);

  /** Get default type for compact mode */
  function getDefaultTypeCompact(): string {
    const typeKey = config.typeKey;
    if (extraFields && typeKey && extraFields[typeKey]) {
      if (config.types.some(t => t.value === extraFields[typeKey])) return extraFields[typeKey];
    }
    if (defaultType && config.types.some(t => t.value === defaultType)) return defaultType;
    if (entityType === "institution") return "bank";
    if (entityType === "category") return "expense";
    if (entityType === "account") return "bank_debit";
    return "";
  }

  /** Determine if the type selector should be shown in compact mode */
  const typeKey = config.typeKey;
  const shouldHideType = !typeKey
    || (hiddenFields?.includes(typeKey))
    || (extraFields && typeKey in extraFields)
    || (entityType === "category" && form.parentId);

  /** Client-side duplicate name check */
  function checkDuplicate(nameValue: string) {
    if (!existingNames || !nameValue.trim()) { setDupWarning(""); return; }
    const trimmed = nameValue.trim();
    if (existingNames.some(n => n.trim() === trimmed)) {
      setDupWarning(`"${trimmed}" 已存在，创建时将提示重复`);
    } else {
      setDupWarning("");
    }
  }

  /** Build the POST body and submit */
  async function onSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    const name = form.name ?? "";
    if (saving || !name.trim()) return;
    // In compact mode for category: parentId is required (cannot create root category directly)
    if (mode === "compact" && entityType === "category" && parentCategories && parentCategories.length > 0 && !form.parentId) {
      setError("请选择上级分类");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body: Record<string, string> = {};

      if (mode === "compact") {
        body[config.bodyKey.name] = name.trim();
        if (typeKey && form.type) {
          body[typeKey] = form.type;
        }
        if (entityType === "account") {
          body.groupId = form.groupId ?? "";
          body.institutionId = form.institutionId ?? "";
        }
        if (extraFields) {
          Object.entries(extraFields).forEach(([k, v]) => {
            if (v !== undefined && v !== "") body[k] = v;
          });
        }
        if (entityType === "category" && form.parentId) {
          body.parentId = form.parentId;
        }
      } else {
        // Full mode: send all non-empty fields
        for (const field of config.fullFields) {
          const val = form[field.key];
          if (val !== undefined && val !== "") {
            body[field.key] = val;
          }
        }
        // Also merge extraFields
        if (extraFields) {
          Object.entries(extraFields).forEach(([k, v]) => {
            if (v !== undefined && v !== "") body[k] = v;
          });
        }
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
          parentId: form.parentId || undefined,
          kind: entityType === "account" ? (form.kind || created.kind || "") : undefined,
          type: entityType === "institution" ? (form.type || created.type || "") :
               entityType === "category" ? (form.type || created.type || "") : undefined,
        });
        // Reset form
        if (mode === "compact") {
          onClose?.();
        } else {
          // Full mode: collapse card and re-init form
          setExpanded(false);
          initForm();
        }
      } else {
        setError(data.error ?? "创建失败");
      }
    } catch {
      setError("网络错误，请重试");
    } finally {
      setSaving(false);
    }
  }

  /** Handle nested entity creation (e.g., "+新增机构" inside account full form) */
  function handleNestedCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    // Add the newly created entity to the nested field data
    if (nestedEntityType === "institution") {
      setNestedFieldData(prev => ({
        ...prev,
        institutionId: [...(prev.institutionId ?? []), { id, name, type: extra?.type }],
      }));
      setForm(prev => ({ ...prev, institutionId: id }));
    } else if (nestedEntityType === "group") {
      setNestedFieldData(prev => ({
        ...prev,
        groupId: [...(prev.groupId ?? []), { id, name }],
      }));
      setForm(prev => ({ ...prev, groupId: id }));
    }
    setNestedOpen(false);
    setNestedEntityType(null);
  }

  /* ---- RENDER: Compact mode (modal) ---- */
  if (mode === "compact") {
    if (!open) return null;

    // Build SmartSelect options for account compact mode
    const groupList = (nestedFieldData.groupId ?? []).filter((item) => item.id && item.name && !item.type);
    const compactGroupOptions: SmartSelectOption[] = [
      { id: "", label: "所有人" },
      ...groupList.map(g => ({ id: g.id, label: g.name })),
    ];
    const instList = (nestedFieldData.institutionId ?? []).filter((item) => item.id && item.name);
    const compactInstitutionOptions: SmartSelectOption[] = [
      ...instList.map(it => ({
        id: it.id,
        label: it.name,
        subLabel: institutionTypeLabel(it.type ?? null),
      })),
    ];

    return (
      <>
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4">
          <div className="modal-surface w-full max-w-sm">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">{config.title}</div>
              <button type="button" onClick={onClose}
                className="secondary-button h-8 px-2">
                关闭
              </button>
            </div>
            <form className="p-4 space-y-3" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="form-label">{config.nameLabel}</div>
                <input
                  value={form.name ?? ""}
                  onChange={(e) => { setForm(prev => ({ ...prev, name: e.target.value })); checkDuplicate(e.target.value); }}
                  placeholder={config.namePlaceholder}
                  className="form-input"
                  autoFocus
                  required
                />
                {dupWarning && <div className="text-xs text-amber-600">{dupWarning}</div>}
              </div>
              {!shouldHideType && config.typeLabel && config.types.length > 0 && (
                <div className="space-y-1">
                  <div className="form-label">{config.typeLabel}</div>
                  <select
                    value={form.type ?? ""}
                    onChange={(e) => setForm(prev => ({ ...prev, type: e.target.value }))}
                    className="form-input"
                  >
                    {config.types.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Account: group & institution SmartSelect in compact mode */}
              {entityType === "account" && !hiddenFields?.includes("groupId") && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground/60">所有人</div>
                  <SmartSelect mode="single" value={form.groupId ?? ""}
                    onChange={id => setForm(prev => ({ ...prev, groupId: id }))}
                    options={compactGroupOptions} placeholder="所有人"
                    onCreateClick={() => { setNestedEntityType("group"); setNestedOpen(true); }}
                    createLabel="新增所有人" />
                </div>
              )}
              {entityType === "account" && !hiddenFields?.includes("institutionId") && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground/60">机构</div>
                  <SmartSelect mode="single" value={form.institutionId ?? ""}
                    onChange={id => setForm(prev => ({ ...prev, institutionId: id }))}
                    options={compactInstitutionOptions} placeholder="选择机构"
                    onCreateClick={() => { setNestedEntityType("institution"); setNestedOpen(true); }}
                    createLabel="新增机构" />
                </div>
              )}
              {/* Parent category selector — only for category entityType when parentCategories provided */}
              {entityType === "category" && parentCategories && parentCategories.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground/60">上级分类</div>
                  <SmartSelect
                    mode="single"
                    value={form.parentId ?? ""}
                    onChange={(id) => setForm(prev => ({ ...prev, parentId: id }))}
                    options={parentCategories.map(pc => {
                      // depth 0 = root category → group header (non-selectable)
                      // depth 1+ with isGroup → collapsible group (selectable + has sub-items)
                      // depth 1+ without isGroup → regular selectable item
                      const indent = pc.depth && pc.depth > 0 ? "　".repeat(pc.depth) : "";
                      return {
                        id: pc.id,
                        label: `${indent}${pc.name}`,
                        isHeader: pc.depth === 0,
                        isGroup: pc.isGroup,
                        parentId: pc.parentId,
                      };
                    })}
                    placeholder="请选择上级分类"
                  />
                </div>
              )}
              {/* Hidden inputs for extraFields */}
              {extraFields && Object.entries(extraFields).map(([k, v]) => (
                k !== typeKey ? <input key={k} type="hidden" name={k} value={v} /> : null
              ))}
              {error && <div className="text-xs text-red-500">{error}</div>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose}
                  className="secondary-button h-9 px-3">
                  取消
                </button>
                <button type="submit" disabled={saving || !(form.name?.trim())}
                  className="primary-button h-9 disabled:opacity-50">
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Nested creation modals (for group/institution inside account compact mode) */}
        {nestedEntityType && nestedOpen && (
          <EntityCreateForm
            mode="compact"
            entityType={nestedEntityType}
            open={nestedOpen}
            onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
            onCreated={handleNestedCreated}
          />
        )}
      </>
    );
  }

  /* ---- RENDER: Full mode ---- */

  const visibleFields = config.fullFields.filter(field => {
    if (field.condition && !field.condition(form)) return false;
    if (hiddenFields?.includes(field.key)) return false;
    if (extraFields && field.key in extraFields && field.key !== "name") return false;
    return true;
  });

  if (layout === "inline") {
    /* ---- Inline layout: compact row form ---- */
    return (
      <>
        <form className="flex items-center gap-2" onSubmit={onSubmit}>
          {visibleFields.map(field => {
            if (field.type === "text") {
              return (
                <input
                  key={field.key}
                  value={form[field.key] ?? ""}
                  onChange={e => setForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder ?? field.label}
                  className="form-input flex-1 min-w-[120px]"
                  required={field.key === "name"}
                />
              );
            }
            // Select field
            const opts = buildSelectOptions(field, nestedFieldData, parentCategories);
            if (opts.length === 0) return null; // No data yet for dynamic select
            return (
              <select
                key={field.key}
                value={form[field.key] ?? ""}
                onChange={e => setForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                className="form-input"
              >
                {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          })}
          <button
            type="submit"
            disabled={saving || !(form.name?.trim())}
            className="primary-button h-9 shrink-0"
          >
            {saving ? "…" : "新增"}
          </button>
        </form>
        {error && <div className="text-xs text-red-500 mt-1">{error}</div>}

        {/* Nested creation modals */}
        {nestedEntityType && (
          <EntityCreateForm
            mode="compact"
            entityType={nestedEntityType}
            open={nestedOpen}
            onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
            onCreated={handleNestedCreated}
          />
        )}
      </>
    );
  }

  /* ---- Card layout: expandable card form ---- */
  return (
    <>
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="primary-button h-9 gap-1.5 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />{config.title}
        </button>
      ) : (
        <div className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="text-sm font-medium text-slate-700">{config.title}</div>
            {error && <div className="text-xs text-red-600">{error}</div>}
          </div>
          <form className="p-4 space-y-3" onSubmit={onSubmit}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {visibleFields.map(field => {
                if (field.type === "text") {
                  return (
                    <div key={field.key}>
                      <label className="form-label mb-1 block">{field.label}</label>
                      <input
                        value={form[field.key] ?? ""}
                        onChange={e => setForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder ?? ""}
                        className="form-input"
                        inputMode={field.key === "billingDay" || field.key === "repaymentDay" ? "numeric" : undefined}
                        required={field.key === "name"}
                      />
                    </div>
                  );
                }

                // Select field — use SmartSelect for dynamic fields with nestedCreate, plain <select> for static
                const opts = buildSelectOptions(field, nestedFieldData, parentCategories);
                if (opts.length === 0 && !field.optionsFromData) return null;

                // Build SmartSelect options for dynamic fields (institutionId / groupId)
                if (field.optionsFromData && field.nestedCreate) {
                  const dataKey = field.optionsFromData;
                  const dataList = nestedFieldData[dataKey] ?? [];
                  let ssOptions: SmartSelectOption[];

                  if (field.key === "institutionId") {
                    ssOptions = dataList.map(d => ({
                      id: d.id,
                      label: d.name,
                      subLabel: institutionTypeLabel((d as { type?: string }).type ?? null),
                    }));
                  } else {
                    ssOptions = dataList.map(d => ({
                      id: d.id,
                      label: d.name,
                    }));
                  }

                  // Placeholder text for the SmartSelect (no empty option in the list)
                  const selectPlaceholder = field.key === "groupId" ? "选择所有人" : "选择机构";

                  return (
                    <div key={field.key}>
                      <label className="form-label mb-1 block">{field.label}</label>
                      <SmartSelect
                        mode="single"
                        value={form[field.key] ?? ""}
                        onChange={id => setForm(prev => ({ ...prev, [field.key]: id }))}
                        options={ssOptions}
                        placeholder={selectPlaceholder}
                        onCreateClick={() => { setNestedEntityType(field.nestedCreate!); setNestedOpen(true); }}
                        createLabel={`新增${field.nestedCreate === "institution" ? "机构" : "所有人"}`}
                      />
                    </div>
                  );
                }

                // Static select (kind, type, costBasisMethod, etc.)
                return (
                  <div key={field.key}>
                    <label className="form-label mb-1 block">{field.label}</label>
                    <select
                      value={form[field.key] ?? ""}
                      onChange={e => setForm(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="form-input"
                    >
                      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setExpanded(false); setError(""); initForm(); }}
                className="secondary-button h-9 px-4"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={saving || !(form.name?.trim())}
                className="primary-button h-9"
              >
                {saving ? "保存中…" : "创建"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Nested creation modals */}
      {nestedEntityType && (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open={nestedOpen}
          onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
          onCreated={handleNestedCreated}
        />
      )}
    </>
  );
}

/* ---- Backward-compatible alias ---- */
export const NestedAddModal = EntityCreateForm;
