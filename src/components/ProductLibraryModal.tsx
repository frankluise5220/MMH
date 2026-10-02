"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Plus, Search, Trash2, X } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { CredentialPasswordField } from "@/components/CredentialPasswordField";

/**
 * 产品库统一管理弹窗（存款 / 理财 / 债券 / 保险产品主数据）。
 *
 * 设计口径（2026-09-30 用户裁定）：**各类产品在各自视图内管理**，不建统一页面。
 * 因此本组件是一个「按家族参数化」的共享实现，四个视图各挂一个，差异全部收敛在
 * `FAMILY_CONFIG` 里（列表接口 / 增删改接口 / 字段表 / 文案前缀）。
 *
 * 关键点：产品主数据 ≠ 账户，也 ≠ 单据。这里只动产品主数据行：
 * - 新增 / 编辑：`mode:"master"` 通道，不解析也不创建任何账户。
 * - 删除：先统计引用，被引用时返回 409，由用户勾选「同时删除关联记录」并输入密码确认，
 *   服务端走余额安全的级联清理（见 `src/lib/server/product-master-delete.ts`）。
 */

export type ProductLibraryFamily = "deposit" | "wealth" | "bond" | "insurance";

type FieldKind = "text" | "number" | "currency" | "date" | "select" | "note" | "institution";

type FieldSpec = {
  key: string;
  labelKey: string;
  kind: FieldKind;
  required?: boolean;
  span2?: boolean;
  /** select 专用：值与 i18n key 一一对应 */
  optionValues?: string[];
  optionKeys?: string[];
};

type ProductRow = {
  id: string;
  name: string;
  shortName: string | null;
  institutionId: string | null;
  institutionName?: string;
  currency: string;
  note: string | null;
  annualRate?: number | null;
  termDays?: number | null;
  maturityDate?: string | null;
  firstPayoutDate?: string | null;
  payoutFrequency?: string | null;
  interestCalcBasis?: string | null;
  productType?: string | null;
  accountingType?: string | null;
  /** 该产品下未软删的真实业务记录数。软删记录不计入。 */
  recordCount: number;
};

type InstitutionOption = { id: string; name: string; shortName: string | null; type?: string };

type RefSummary = {
  entryCount: number;
  businessCount: number;
  lotCount: number;
  planCount: number;
};

type DeleteState = {
  row: ProductRow;
  refs: RefSummary;
};

const INSURANCE_PRODUCT_TYPES = [
  "savings",
  "dividend",
  "annuity",
  "universal",
  "investment_linked",
  "critical_illness",
  "medical",
  "accident",
  "term_life",
  "whole_life",
  "other",
];

const SHARED_HEAD: FieldSpec[] = [
  { key: "name", labelKey: "investForm.productNameLabel", kind: "text", required: true },
  { key: "shortName", labelKey: "entityForm.shortNameLabel", kind: "text" },
  { key: "institutionId", labelKey: "productLibrary.institution", kind: "institution" },
  { key: "currency", labelKey: "detail.column.currency", kind: "currency" },
];

const DEPOSIT_FIELDS: FieldSpec[] = [
  ...SHARED_HEAD,
  { key: "annualRate", labelKey: "productLibrary.annualRate", kind: "number" },
  { key: "termDays", labelKey: "productLibrary.termDays", kind: "number" },
  { key: "note", labelKey: "detail.column.remark", kind: "note", span2: true },
];

const BOND_FIELDS: FieldSpec[] = [
  ...SHARED_HEAD,
  { key: "annualRate", labelKey: "productLibrary.annualRate", kind: "number" },
  { key: "termDays", labelKey: "productLibrary.termDays", kind: "number" },
  { key: "maturityDate", labelKey: "productLibrary.maturityDate", kind: "date" },
  { key: "firstPayoutDate", labelKey: "wealthForm.firstPayoutDate", kind: "date" },
  {
    key: "payoutFrequency",
    labelKey: "wealthForm.payoutFrequency",
    kind: "select",
    optionValues: ["maturity", "yearly", "monthly", "weekly"],
    optionKeys: [
      "wealthForm.payout.maturity",
      "wealthForm.payout.yearly",
      "wealthForm.payout.monthly",
      "wealthForm.payout.weekly",
    ],
  },
  {
    key: "interestCalcBasis",
    labelKey: "deposit.calcBasis.label",
    kind: "select",
    optionValues: ["daily", "monthly"],
    optionKeys: ["deposit.calcBasis.daily", "deposit.calcBasis.monthly"],
  },
  { key: "note", labelKey: "detail.column.remark", kind: "note", span2: true },
];

const INSURANCE_FIELDS: FieldSpec[] = [
  { key: "name", labelKey: "investForm.productNameLabel", kind: "text", required: true },
  { key: "shortName", labelKey: "entityForm.shortNameLabel", kind: "text" },
  {
    key: "productType",
    labelKey: "insuranceProductEdit.productTypeLabel",
    kind: "select",
    required: true,
    optionValues: INSURANCE_PRODUCT_TYPES,
    optionKeys: INSURANCE_PRODUCT_TYPES.map((value) => `insuranceProduct.type.${value}`),
  },
  {
    key: "accountingType",
    labelKey: "insuranceProductEdit.accountingTypeLabel",
    kind: "select",
    required: true,
    optionValues: ["asset", "protection", "hybrid"],
    optionKeys: [
      "insuranceProduct.accountingType.asset",
      "insuranceProduct.accountingType.protection",
      "insuranceProduct.accountingType.hybrid",
    ],
  },
  { key: "institutionId", labelKey: "productLibrary.institution", kind: "institution", required: true },
  { key: "currency", labelKey: "detail.column.currency", kind: "currency" },
  { key: "note", labelKey: "detail.column.remark", kind: "note", span2: true },
];

type FamilyConfig = {
  titleKey: string;
  listUrl: string;
  fields: FieldSpec[];
  createUrl: string;
  createBody: (draft: Record<string, string>) => Record<string, unknown>;
  update: (id: string, draft: Record<string, string>) => Promise<Response>;
  remove: (id: string, opts: { cascade: boolean; password: string }) => Promise<Response>;
  /** 该家族没有机构时是否允许保存（存款/理财/债券允许，保险必填） */
  allowNoInstitution: boolean;
  /** 只列出该类型的机构（保险产品必须挂在保险公司上） */
  institutionType?: string;
};

function jsonPost(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonPut(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonDelete(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 产品库提交体：只挑字段表里声明过的键，空串转 null，数字转 number。 */
function buildPayload(fields: FieldSpec[], draft: Record<string, string>) {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = String(draft[field.key] ?? "").trim();
    if (field.kind === "number") {
      payload[field.key] = raw === "" ? null : Number(raw);
    } else if (field.kind === "institution") {
      payload[field.key] = raw || null;
    } else {
      payload[field.key] = raw || null;
    }
  }
  return payload;
}

const FAMILY_CONFIG: Record<ProductLibraryFamily, FamilyConfig> = {
  deposit: {
    titleKey: "productLibrary.title.deposit",
    listUrl: "/api/v1/deposit-products",
    fields: DEPOSIT_FIELDS,
    createUrl: "/api/v1/deposit-products",
    createBody: (draft) => ({ ...buildPayload(DEPOSIT_FIELDS, draft), mode: "master" }),
    update: (id, draft) => jsonPut(`/api/v1/deposit-products/${id}`, buildPayload(DEPOSIT_FIELDS, draft)),
    remove: (id, opts) => jsonDelete(`/api/v1/deposit-products/${id}`, opts),
    allowNoInstitution: true,
  },
  wealth: {
    titleKey: "productLibrary.title.wealth",
    listUrl: "/api/v1/wealth-products",
    fields: DEPOSIT_FIELDS,
    createUrl: "/api/v1/wealth-products",
    createBody: (draft) => ({ ...buildPayload(DEPOSIT_FIELDS, draft), mode: "master" }),
    update: (id, draft) => jsonPut(`/api/v1/wealth-products/${id}`, buildPayload(DEPOSIT_FIELDS, draft)),
    remove: (id, opts) => jsonDelete(`/api/v1/wealth-products/${id}`, opts),
    allowNoInstitution: true,
  },
  bond: {
    titleKey: "productLibrary.title.bond",
    listUrl: "/api/v1/bond-products",
    fields: BOND_FIELDS,
    createUrl: "/api/v1/bond-products",
    createBody: (draft) => ({ ...buildPayload(BOND_FIELDS, draft), mode: "master" }),
    update: (id, draft) => jsonPut(`/api/v1/bond-products/${id}`, buildPayload(BOND_FIELDS, draft)),
    remove: (id, opts) => jsonDelete(`/api/v1/bond-products/${id}`, opts),
    allowNoInstitution: true,
  },
  insurance: {
    titleKey: "productLibrary.title.insurance",
    listUrl: "/api/v1/insurance-products?includeMasters=1",
    fields: INSURANCE_FIELDS,
    createUrl: "/api/v1/insurance-products",
    createBody: (draft) => ({ ...buildPayload(INSURANCE_FIELDS, draft), mode: "master" }),
    update: (id, draft) =>
      jsonPut("/api/v1/insurance-products", { ...buildPayload(INSURANCE_FIELDS, draft), id, mode: "master" }),
    remove: (id, opts) =>
      jsonDelete(`/api/v1/insurance-products?id=${encodeURIComponent(id)}&mode=master`, opts),
    allowNoInstitution: false,
    institutionType: "insurance",
  },
};

function normalizeRow(family: ProductLibraryFamily, raw: Record<string, unknown>): ProductRow {
  const str = (value: unknown) => (value == null ? null : String(value));
  const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
  if (family === "insurance") {
    return {
      id: String(raw.id),
      name: String(raw.name ?? ""),
      shortName: str(raw.shortName),
      institutionId: str(raw.institutionId),
      institutionName: String(raw.institutionShortName ?? raw.institutionName ?? ""),
      currency: String(raw.currency ?? "CNY"),
      note: str(raw.note),
      productType: str(raw.productType),
      accountingType: str(raw.accountingType),
      recordCount: Number(raw.recordCount ?? 0) || 0,
    };
  }
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    shortName: str(raw.shortName),
    institutionId: str(raw.institutionId),
    institutionName: String(raw.institutionName ?? ""),
    currency: String(raw.currency ?? "CNY"),
    note: str(raw.note),
    annualRate: num(raw.annualRate),
    termDays: num(raw.termDays),
    maturityDate: str(raw.maturityDate),
    firstPayoutDate: str(raw.firstPayoutDate),
    payoutFrequency: str(raw.payoutFrequency),
    interestCalcBasis: str(raw.interestCalcBasis),
    recordCount: Number(raw.recordCount ?? 0) || 0,
  };
}

function draftFromRow(family: ProductLibraryFamily, row: ProductRow | null): Record<string, string> {
  const fields = FAMILY_CONFIG[family].fields;
  const draft: Record<string, string> = {};
  for (const field of fields) {
    const value = row ? (row as unknown as Record<string, unknown>)[field.key] : null;
    if (value == null) draft[field.key] = "";
    else if (field.kind === "select") draft[field.key] = String(value);
    else draft[field.key] = String(value);
  }
  if (family === "insurance" && !row) {
    draft.productType = "other";
    draft.accountingType = "asset";
    draft.currency = "CNY";
  }
  if (family !== "insurance" && !row) {
    draft.currency = "CNY";
  }
  return draft;
}

export function ProductLibraryModal({
  open,
  family,
  defaultInstitutionId,
  onClose,
  onChanged,
}: {
  open: boolean;
  family: ProductLibraryFamily;
  defaultInstitutionId?: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const config = FAMILY_CONFIG[family];

  const [rows, setRows] = useState<ProductRow[]>([]);
  const [institutions, setInstitutions] = useState<InstitutionOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() => draftFromRow(family, null));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [cascade, setCascade] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const institutionOptions = useMemo(
    () => (config.institutionType ? institutions.filter((item) => item.type === config.institutionType) : institutions),
    [institutions, config.institutionType],
  );

  const institutionNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of institutions) {
      map.set(item.id, item.shortName?.trim() || item.name);
    }
    return map;
  }, [institutions]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(config.listUrl, { cache: "no-store" });
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok || !data || data.ok === false) {
        throw new Error(String(data?.error ?? t("productLibrary.loadFailed")));
      }
      const rawList = (family === "insurance" ? data.masters : data.products) as Record<string, unknown>[] | undefined;
      setRows((rawList ?? []).map((item) => normalizeRow(family, item)));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("productLibrary.loadFailed"));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [config.listUrl, family, t]);

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setSelectedId(null);
    setIsCreating(false);
    setDeleteState(null);
    setFormError(null);
    setDraft(draftFromRow(family, null));
    void loadRows();
    void (async () => {
      try {
        const response = await fetch("/api/v1/institution", { cache: "no-store" });
        const data = await response.json().catch(() => null) as { ok?: boolean; institutions?: InstitutionOption[] } | null;
        if (response.ok && data?.ok) setInstitutions(data.institutions ?? []);
      } catch {
        setInstitutions([]);
      }
    })();
  }, [open, family, loadRows]);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return rows;
    return rows.filter((row) => {
      const institution = row.institutionId ? institutionNameById.get(row.institutionId) ?? "" : "";
      return (
        row.name.toLowerCase().includes(text) ||
        (row.shortName ?? "").toLowerCase().includes(text) ||
        institution.toLowerCase().includes(text)
      );
    });
  }, [rows, keyword, institutionNameById]);

  const selectedRow = useMemo(
    () => (isCreating ? null : rows.find((row) => row.id === selectedId) ?? null),
    [rows, selectedId, isCreating],
  );

  function selectRow(row: ProductRow) {
    setIsCreating(false);
    setSelectedId(row.id);
    setDraft(draftFromRow(family, row));
    setFormError(null);
  }

  function startCreate() {
    setIsCreating(true);
    setSelectedId(null);
    const next = draftFromRow(family, null);
    if (config.allowNoInstitution && defaultInstitutionId) next.institutionId = defaultInstitutionId;
    setDraft(next);
    setFormError(null);
  }

  function closeDeleteConfirm() {
    setDeleteState(null);
    setCascade(false);
    setPassword("");
    setDeleteError(null);
  }

  async function handleSave() {
    const missing = config.fields.find((field) => field.required && !String(draft[field.key] ?? "").trim());
    if (missing) {
      setFormError(t("productLibrary.requiredField", { field: t(missing.labelKey) }));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const response = isCreating
        ? await jsonPost(config.createUrl, config.createBody(draft))
        : await config.update(selectedRow!.id, draft);
      const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("productLibrary.saveFailed"));
      }
      await loadRows();
      setIsCreating(false);
      setFormError(null);
      onChanged();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("productLibrary.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  /** 第一步：尝试直接删除。被引用时服务端返回 409 + refs，转入确认面板。 */
  async function handleDelete() {
    if (!selectedRow) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await config.remove(selectedRow.id, { cascade: false, password: "" });
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        code?: string;
        error?: string;
        refs?: RefSummary;
      } | null;
      if (response.ok && data?.ok) {
        setSelectedId(null);
        setIsCreating(false);
        setDraft(draftFromRow(family, null));
        await loadRows();
        onChanged();
        return;
      }
      if (response.status === 409 && data?.refs) {
        setDeleteState({ row: selectedRow, refs: data.refs });
        setCascade(false);
        setPassword("");
        return;
      }
      throw new Error(data?.error || t("productLibrary.deleteFailed"));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t("productLibrary.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  /** 第二步：确认级联删除（勾选 + 密码）。 */
  async function handleConfirmDelete() {
    if (!deleteState) return;
    if (!cascade) {
      setDeleteError(t("productLibrary.cascadeRequired"));
      return;
    }
    if (!password.trim()) {
      setDeleteError(t("productLibrary.passwordRequired"));
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await config.remove(deleteState.row.id, { cascade: true, password });
      const data = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("productLibrary.deleteFailed"));
      }
      closeDeleteConfirm();
      setSelectedId(null);
      setIsCreating(false);
      setDraft(draftFromRow(family, null));
      await loadRows();
      onChanged();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t("productLibrary.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  if (!open) return null;

  const canSave = isCreating || !!selectedRow;

  return (
    <div className="app-modal-backdrop z-[1300]">
      <div className="app-modal-panel h-[min(760px,84vh)] max-w-4xl min-h-0">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{t(config.titleKey)}</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：产品列表 */}
          <div className="flex w-[340px] shrink-0 flex-col border-r border-slate-100">
            <div className="shrink-0 space-y-2 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={t("productLibrary.searchPlaceholder")}
                  className="form-input pl-8"
                />
              </div>
              <button type="button" onClick={startCreate} className="secondary-button h-8 w-full px-3 text-xs">
                <Plus className="h-3.5 w-3.5" />
                {t("productLibrary.addProduct")}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : loadError ? (
                <div className="px-2 py-6 text-xs text-rose-600">{loadError}</div>
              ) : filtered.length === 0 ? (
                <div className="px-2 py-6 text-xs text-slate-400">{t("productLibrary.empty")}</div>
              ) : (
                filtered.map((row) => {
                  const active = !isCreating && row.id === selectedId;
                  const institutionLabel = row.institutionId
                    ? institutionNameById.get(row.institutionId) ?? row.institutionName ?? ""
                    : "";
                  return (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => selectRow(row)}
                      title={institutionLabel ? `${row.name} · ${institutionLabel}` : row.name}
                      className={`mb-0.5 flex w-full items-center gap-2 overflow-hidden rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                        active ? "bg-cyan-50 ring-1 ring-cyan-200" : "hover:bg-slate-50"
                      }`}
                    >
                      {/* 单行：产品名占满剩余宽度并截断，机构/利率/期限/记录数靠右不换行 */}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{row.name}</span>
                      <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-slate-500">
                        {row.institutionId ? (
                          <span className="max-w-[92px] truncate">{institutionLabel}</span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 text-amber-600">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {t("productLibrary.noInstitution")}
                          </span>
                        )}
                        {row.annualRate != null ? <span className="tabular-nums">· {row.annualRate}%</span> : null}
                        {row.termDays != null ? (
                          <span className="tabular-nums">
                            · {row.termDays}
                            {t("productLibrary.termUnitDay")}
                          </span>
                        ) : null}
                        <span className="tabular-nums text-slate-400">
                          · {row.recordCount}
                          {t("productLibrary.recordUnit")}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* 右：表单 / 删除确认 */}
          <div className="flex min-h-0 flex-1 flex-col">
            {deleteState ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-start gap-2 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-1">
                      <div className="font-medium">
                        {t("productLibrary.deleteBlockedTitle", { name: deleteState.row.name })}
                      </div>
                      <div className="text-xs">
                        {t("productLibrary.deleteBlocked", {
                          lots: deleteState.refs.lotCount,
                          entries: deleteState.refs.entryCount,
                          plans: deleteState.refs.planCount,
                        })}
                      </div>
                    </div>
                  </div>
                </div>

                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={cascade}
                    onChange={(event) => setCascade(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>{t("productLibrary.cascadeLabel")}</span>
                </label>

                <CredentialPasswordField value={password} onChange={setPassword} />

                {deleteError ? <div className="text-xs text-rose-600">{deleteError}</div> : null}
              </div>
            ) : canSave ? (
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="text-xs font-medium text-slate-500">
                  {isCreating ? t("productLibrary.newProduct") : t("productLibrary.editingProduct")}
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {config.fields.map((field) => (
                    <div key={field.key} className={`space-y-1 ${field.span2 ? "md:col-span-2" : ""}`}>
                      <div className="form-label">
                        {t(field.labelKey)}
                        {field.required ? <span className="text-rose-500"> *</span> : null}
                      </div>
                      {field.kind === "select" ? (
                        <select
                          value={draft[field.key] ?? ""}
                          onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                          className="form-input"
                        >
                          {(field.optionValues ?? []).map((value, index) => (
                            <option key={value} value={value}>
                              {t(field.optionKeys?.[index] ?? value)}
                            </option>
                          ))}
                        </select>
                      ) : field.kind === "institution" ? (
                        <select
                          value={draft[field.key] ?? ""}
                          onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                          className="form-input"
                        >
                          <option value="">{config.allowNoInstitution ? t("productLibrary.institutionNone") : t("productLibrary.selectInstitution")}</option>
                          {institutionOptions.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.shortName?.trim() || item.name}
                            </option>
                          ))}
                        </select>
                      ) : field.kind === "note" ? (
                        <textarea
                          value={draft[field.key] ?? ""}
                          onChange={(event) => setDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                          className="form-input min-h-20 resize-y py-2"
                        />
                      ) : (
                        <input
                          type={field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text"}
                          value={draft[field.key] ?? ""}
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              [field.key]: field.kind === "currency" ? event.target.value.toUpperCase() : event.target.value,
                            }))
                          }
                          className="form-input"
                        />
                      )}
                    </div>
                  ))}
                </div>

                {!config.allowNoInstitution ? null : (
                  <div className="text-[11px] text-slate-400">{t("productLibrary.noInstitutionHint")}</div>
                )}
                {formError ? <div className="text-xs text-rose-600">{formError}</div> : null}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-slate-400">
                {t("productLibrary.selectOrCreate")}
              </div>
            )}

            <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
              {deleteError && !deleteState ? (
                <div className="mb-2 text-xs text-rose-600">{deleteError}</div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <div>
                  {!isCreating && selectedRow && !deleteState ? (
                    <button
                      type="button"
                      onClick={() => void handleDelete()}
                      disabled={deleting}
                      className="secondary-button h-9 px-3 text-rose-600 disabled:opacity-50"
                    >
                      {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      {t("common.delete")}
                    </button>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  {deleteState ? (
                    <>
                      <button type="button" onClick={closeDeleteConfirm} className="secondary-button h-9 px-4">
                        {t("common.cancel")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleConfirmDelete()}
                        disabled={deleting}
                        className="primary-button h-9 px-4 text-white disabled:opacity-50"
                      >
                        {deleting ? t("productLibrary.deleting") : t("productLibrary.confirmDelete")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={onClose} className="secondary-button h-9 px-4">
                        {t("common.close")}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSave()}
                        disabled={saving || !canSave}
                        className="primary-button h-9 px-4 text-white disabled:opacity-50"
                      >
                        {saving ? t("productLibrary.saving") : t("common.save")}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
