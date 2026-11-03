"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle,  ChevronDown, Loader2, Plus, Search, Trash2, X } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { CredentialPasswordField } from "@/components/CredentialPasswordField";
import { useDerivedLayerZIndex } from "@/components/ModalLayer";
import { REPO_MARKET_LABEL, REPO_PRODUCTS } from "@/lib/repo";
import { formatMoney } from "@/lib/format";
import { PERSONAL_INSTITUTION_TYPES } from "@/lib/institution-rules";

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

type ProductLibraryFamily = "deposit" | "wealth" | "advisor" | "bond" | "insurance";

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
  /** 当前持仓笔数（已全部赎回/结清的产品为 0）。列表行末尾展示的就是这个值。 */
  holdingCount: number;
  /**
   * 交易所标准品种（逆回购）：只展示，不入库，也不参与增删改。
   * 它们的代码 / 期限 / 费率由交易所规定，产品库只作为「能查到」的清单。
   */
  readOnly?: boolean;
  /** 只读品种的明细（逆回购：市场 / 起投 / 费率）。 */
  exchangeDetail?: {
    code: string;
    market: string;
    minAmount: number;
    stepAmount: number;
    feeRatePercent: number;
  };
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

/** 机构筛选里「未指定机构」的伪 id（真实机构 id 都是 cuid）。 */
const NO_INSTITUTION_KEY = "__no_institution__";

/** 列表里「交易所标准品种」的伪分组：逆回购不属于任何券商机构，单独成组。 */
const EXCHANGE_GROUP_KEY = "__exchange_products__";

/**
 * 逆回购品种是交易所规则常量（`src/lib/repo.ts`），不入库、不可编辑，
 * 但用户在「产品管理」里应该查得到它们，所以合成只读行一起展示。
 */
function exchangeProductRows(): ProductRow[] {
  return REPO_PRODUCTS.map((item) => ({
    id: `repo:${item.code}`,
    name: item.name,
    shortName: item.code,
    institutionId: null,
    currency: "CNY",
    note: null,
    annualRate: null,
    termDays: item.termDays,
    recordCount: 0,
    holdingCount: 0,
    readOnly: true,
    exchangeDetail: {
      code: item.code,
      market: REPO_MARKET_LABEL[item.market],
      minAmount: item.minAmount,
      stepAmount: item.stepAmount,
      feeRatePercent: item.feeRatePercent,
    },
  }));
}

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

/**
 * 投顾组合产品：只有名称 / 简称 / 所属机构 / 币种 / 备注。
 * 投顾没有票面利率与期限（按「份额 × 组合净值」估值），机构必填（2026-11-03 用户裁定）。
 */
const ADVISOR_FIELDS: FieldSpec[] = [
  { key: "name", labelKey: "investForm.productNameLabel", kind: "text", required: true },
  { key: "shortName", labelKey: "entityForm.shortNameLabel", kind: "text" },
  { key: "institutionId", labelKey: "productLibrary.institution", kind: "institution", required: true },
  { key: "currency", labelKey: "detail.column.currency", kind: "currency" },
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
  /**
   * 从「所属机构」下拉里排除的机构类型。理财 / 债券排除往来人员 / 往来组织 / 家庭成员
   * （不是产品发行方）；理财另排除保险公司（服务端 guard 拒绝），避免列出必然保存失败的选项。
   */
  excludedInstitutionTypes?: readonly string[];
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
    // 往来人员 / 往来组织 / 家庭成员不是理财产品的发行方：不进「所属机构」下拉。
    // 保险公司同样排除——理财产品落到保险公司名下会被服务端拒绝（INSTITUTION_IS_INSURER），
    // 列出来只会让用户选中后「保存不成功」。
    excludedInstitutionTypes: [...PERSONAL_INSTITUTION_TYPES, "insurance"],
    createUrl: "/api/v1/wealth-products",
    createBody: (draft) => ({ ...buildPayload(DEPOSIT_FIELDS, draft), mode: "master" }),
    update: (id, draft) => jsonPut(`/api/v1/wealth-products/${id}`, buildPayload(DEPOSIT_FIELDS, draft)),
    remove: (id, opts) => jsonDelete(`/api/v1/wealth-products/${id}`, opts),
    allowNoInstitution: true,
  },
  advisor: {
    titleKey: "productLibrary.title.advisor",
    listUrl: "/api/v1/wealth-products",
    fields: ADVISOR_FIELDS,
    // 同理财：往来主体与保险公司都不是投顾产品的发行方（服务端同样拒绝）。
    excludedInstitutionTypes: [...PERSONAL_INSTITUTION_TYPES, "insurance"],
    createUrl: "/api/v1/wealth-products",
    createBody: (draft) => ({ ...buildPayload(ADVISOR_FIELDS, draft), mode: "master", productType: "advisor" }),
    update: (id, draft) => jsonPut(`/api/v1/wealth-products/${id}`, buildPayload(ADVISOR_FIELDS, draft)),
    remove: (id, opts) => jsonDelete(`/api/v1/wealth-products/${id}`, opts),
    // 投顾产品必须归属机构：没有「通用（不限机构）」这一档。
    allowNoInstitution: false,
  },
  bond: {
    titleKey: "productLibrary.title.bond",
    listUrl: "/api/v1/bond-products",
    fields: BOND_FIELDS,
    // 同理财：往来人员 / 往来组织 / 家庭成员不是债券的发行方（服务端同样拒绝）。
    excludedInstitutionTypes: PERSONAL_INSTITUTION_TYPES,
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
      holdingCount: Number(raw.holdingCount ?? 0) || 0,
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
    holdingCount: Number(raw.holdingCount ?? 0) || 0,
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

/**
 * 机构筛选下拉：**复选 + 面板内输入筛选**，面板 portal 到 body。
 *
 * 层级必须由 `useDerivedLayerZIndex()` 从「所在弹窗层」派生（弹窗遮罩起步 1000）：
 * 就地渲染或写死 z（例如 `z-[100]`）会被弹窗压在下面，表现为「点了没反应」。
 * 空选择 = 不筛选（全部机构）。
 */
function InstitutionFilterDropdown({
  options,
  selected,
  onChange,
  triggerLabel,
  allLabel,
  searchPlaceholder,
  clearLabel,
  emptyLabel,
}: {
  options: Array<{ id: string; label: string; count: number }>;
  selected: string[];
  onChange: (next: string[]) => void;
  triggerLabel: string;
  allLabel: string;
  searchPlaceholder: string;
  clearLabel: string;
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const zIndex = useDerivedLayerZIndex();

  const PANEL_WIDTH = 264;
  const PANEL_MAX_HEIGHT = 360;

  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - PANEL_WIDTH - 8));
    const panelHeight = Math.min(window.innerHeight * 0.6, PANEL_MAX_HEIGHT);
    const openUpward = rect.bottom + 4 + panelHeight > window.innerHeight - 8 && rect.top - 4 - panelHeight > 8;
    setPosition({ left, top: openUpward ? rect.top - panelHeight - 4 : rect.bottom + 4 });
  }, []);

  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const text = query.trim().toLowerCase();
  const visible = text ? options.filter((option) => option.label.toLowerCase().includes(text)) : options;
  const selectedLabels = selected
    .map((id) => options.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? selectedLabels[0] ?? allLabel
      : `${selectedLabels[0] ?? ""} +${selected.length - 1}`;

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <button
        ref={anchorRef}
        type="button"
        title={`${triggerLabel}：${summary}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="min-w-0 truncate">
          <span className="text-slate-400">{triggerLabel}：</span>
          {summary}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && mounted
        ? createPortal(
            <div
              ref={panelRef}
              style={{ left: position.left, top: position.top, width: PANEL_WIDTH, zIndex }}
              className="fixed max-h-[min(60vh,360px)] overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-lg"
            >
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="form-input mb-1 h-7 text-xs"
                autoFocus
              />
              <button
                type="button"
                className="flex min-h-7 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => onChange([])}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                  checked={selected.length === 0}
                  readOnly
                  tabIndex={-1}
                />
                <span className="min-w-0 flex-1 truncate">{allLabel}</span>
              </button>
              <div className="my-1 border-t border-slate-100" />
              {visible.length === 0 ? (
                <div className="px-2 py-2 text-xs text-slate-400">{emptyLabel}</div>
              ) : (
                visible.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={selected.includes(option.id)}
                    className="flex min-h-7 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-50"
                    onClick={() => toggle(option.id)}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                      checked={selected.includes(option.id)}
                      readOnly
                      tabIndex={-1}
                    />
                    <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
                    <span className="shrink-0 tabular-nums text-[11px] text-slate-400">{option.count}</span>
                  </button>
                ))
              )}
              {selected.length > 0 ? (
                <button
                  type="button"
                  className="mt-1 w-full rounded px-2 py-1 text-left text-[11px] text-blue-600 hover:bg-slate-50 hover:text-blue-800"
                  onClick={() => onChange([])}
                >
                  {clearLabel}
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
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
  const [institutionFilter, setInstitutionFilter] = useState<string[]>([]);
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

  const institutionOptions = useMemo(() => {
    const excluded = new Set<string>(config.excludedInstitutionTypes ?? []);
    return institutions.filter((item) => {
      if (config.institutionType && item.type !== config.institutionType) return false;
      return !excluded.has(String(item.type ?? "").trim());
    });
  }, [institutions, config.institutionType, config.excludedInstitutionTypes]);

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
      // 理财 / 投顾两个产品库互不混排（2026-11-03 起）：理财库不列 advisor，
      // 投顾库只列 advisor（投顾产品必须归属机构，见 FAMILY_CONFIG.advisor）。
      const filteredList = family === "wealth"
        ? (rawList ?? []).filter((item) => item.productType !== "advisor")
        : family === "advisor"
          ? (rawList ?? []).filter((item) => item.productType === "advisor")
          : rawList ?? [];
      const loaded = filteredList.map((item) => normalizeRow(family, item));
      // 债券产品库里额外列出逆回购标准品种：它们不入库，只作为只读清单展示。
      setRows(family === "bond" ? [...loaded, ...exchangeProductRows()] : loaded);
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
    setInstitutionFilter([]);
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
    const institutionSet = new Set(institutionFilter);
    return rows.filter((row) => {
      // 交易所标准品种不属于任何机构，按机构筛选时一并隐藏。
      if (row.readOnly) {
        if (institutionSet.size > 0) return false;
        if (!text) return true;
        return row.name.toLowerCase().includes(text) || (row.shortName ?? "").toLowerCase().includes(text);
      }
      if (institutionSet.size > 0 && !institutionSet.has(row.institutionId ?? NO_INSTITUTION_KEY)) return false;
      if (!text) return true;
      const institution = row.institutionId ? institutionNameById.get(row.institutionId) ?? "" : "";
      return (
        row.name.toLowerCase().includes(text) ||
        (row.shortName ?? "").toLowerCase().includes(text) ||
        institution.toLowerCase().includes(text)
      );
    });
  }, [rows, keyword, institutionNameById, institutionFilter]);

  /**
   * 债券与理财的「不指定机构」是通用语义：留空 = 所有机构的账户都能选购。
   * 存款产品与开户行强绑定（接口传空机构直接返回空列表），保险产品的机构必填，
   * 这两个族保留「未指定机构」的原说法。
   */
  const universalScope = family === "bond" || family === "wealth";
  const noInstitutionLabel = universalScope
    ? t("productLibrary.universalGroup")
    : t("productLibrary.noInstitution");

  /** 机构下拉的选项：按当前产品集合统计，包含「未指定机构」分组。 */
  const institutionFilterOptions = useMemo(() => {
    const map = new Map<string, { id: string; label: string; count: number }>();
    for (const row of rows) {
      // 交易所标准品种没有机构归属，不进机构筛选。
      if (row.readOnly) continue;
      const id = row.institutionId ?? NO_INSTITUTION_KEY;
      const label = row.institutionId
        ? institutionNameById.get(row.institutionId) ?? row.institutionName ?? t("productLibrary.unknownInstitution")
        : noInstitutionLabel;
      const entry = map.get(id) ?? { id, label, count: 0 };
      entry.count += 1;
      map.set(id, entry);
    }
    return [...map.values()].sort((a, b) => {
      if (a.id === NO_INSTITUTION_KEY) return 1;
      if (b.id === NO_INSTITUTION_KEY) return -1;
      return a.label.localeCompare(b.label, "zh-Hans-CN");
    });
  }, [rows, institutionNameById, t, noInstitutionLabel]);

  /** 列表按所属机构分组（交易所标准品种单独成组，未指定机构排在最后）。 */
  const groupedRows = useMemo(() => {
    const groups: Array<{ key: string; label: string; count: number; rows: ProductRow[] }> = [];
    const indexByKey = new Map<string, number>();
    for (const row of filtered) {
      const key = row.readOnly ? EXCHANGE_GROUP_KEY : row.institutionId ?? NO_INSTITUTION_KEY;
      let at = indexByKey.get(key);
      if (at == null) {
        const label = key === EXCHANGE_GROUP_KEY
          ? t("productLibrary.exchangeGroup")
          : row.institutionId
            ? institutionNameById.get(row.institutionId) ?? row.institutionName ?? t("productLibrary.unknownInstitution")
            : noInstitutionLabel;
        at = groups.length;
        indexByKey.set(key, at);
        groups.push({ key, label, count: 0, rows: [] });
      }
      groups[at].rows.push(row);
      groups[at].count += 1;
    }
    return groups;
  }, [filtered, institutionNameById, t, noInstitutionLabel]);

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
    // 机构必填的产品库（投顾）也要带上当前账户的机构，省一次手选。
    if ((config.allowNoInstitution || family === "advisor") && defaultInstitutionId) next.institutionId = defaultInstitutionId;
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
    // 交易所标准品种只是清单，任何时候都不写库。
    if (selectedRow?.readOnly) return;
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
    <ModalLayer className="app-modal-backdrop">
      {/* 高度用 inline style：`h-[min(...)]` 依赖 Tailwind 扫描新类，dev 下常不重新生成。 */}
      <div
        className="app-modal-panel max-w-4xl min-h-0"
        style={{ height: "min(640px, 74vh)" }}
      >
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{t(config.titleKey)}</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：筛选 + 按所属机构分组的产品列表 */}
          <div className="flex w-[360px] shrink-0 flex-col border-r border-slate-100">
            <div className="shrink-0 space-y-2 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder={t("productLibrary.searchProductName")}
                  className="form-input pl-8"
                />
              </div>
              <div className="flex items-center gap-2">
                <InstitutionFilterDropdown
                  options={institutionFilterOptions}
                  selected={institutionFilter}
                  onChange={setInstitutionFilter}
                  triggerLabel={t("productLibrary.institution")}
                  allLabel={t("productLibrary.allInstitutions")}
                  searchPlaceholder={t("productLibrary.searchInstitution")}
                  clearLabel={t("productLibrary.clearInstitutionFilter")}
                  emptyLabel={t("productLibrary.institutionNoMatch")}
                />
                <button
                  type="button"
                  onClick={startCreate}
                  className="secondary-button h-8 shrink-0 px-2.5 text-xs"
                  title={t("productLibrary.addProduct")}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("common.loading")}
                </div>
              ) : loadError ? (
                <div className="px-2 py-6 text-xs text-rose-600">{loadError}</div>
              ) : groupedRows.length === 0 ? (
                <div className="px-2 py-6 text-xs text-slate-400">{t("productLibrary.empty")}</div>
              ) : (
                groupedRows.map((group) => (
                  <div key={group.key} className="mb-1">
                    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-white/95 px-2 py-1 backdrop-blur">
                      <span
                        className={`inline-flex min-w-0 items-center gap-1 truncate text-[11px] font-medium ${
                          group.key === EXCHANGE_GROUP_KEY
                            ? "text-emerald-600"
                            : group.key === NO_INSTITUTION_KEY
                              ? (universalScope ? "text-sky-600" : "text-amber-600")
                              : "text-slate-500"
                        }`}
                      >
                        {group.key === NO_INSTITUTION_KEY && !universalScope
                          ? <AlertTriangle className="h-3 w-3 shrink-0" />
                          : null}
                        {group.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-[11px] text-slate-400">{group.count}</span>
                    </div>
                    {group.rows.map((row) => {
                      const active = !isCreating && row.id === selectedId;
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => selectRow(row)}
                          title={row.name}
                          className={`mb-0.5 flex w-full items-center gap-2 overflow-hidden rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                            active ? "bg-cyan-50 ring-1 ring-cyan-200" : "hover:bg-slate-50"
                          }`}
                        >
                          {/* 单行：产品名占满剩余宽度并截断，利率/期限/持仓数靠右不换行（机构已在分组头） */}
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{row.name}</span>
                          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-slate-500">
                            {row.readOnly ? (
                              <>
                                <span className="tabular-nums text-slate-400">{row.shortName}</span>
                                {row.termDays != null ? (
                                  <span className="tabular-nums">
                                    · {row.termDays}
                                    {t("productLibrary.termUnitDay")}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <>
                                {row.annualRate != null ? <span className="tabular-nums">{row.annualRate}%</span> : null}
                                {row.termDays != null ? (
                                  <span className="tabular-nums">
                                    · {row.termDays}
                                    {t("productLibrary.termUnitDay")}
                                  </span>
                                ) : null}
                                <span className="tabular-nums text-slate-400">
                                  · {row.holdingCount}
                                  {t("productLibrary.holdingUnit")}
                                </span>
                              </>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
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
            ) : selectedRow?.readOnly && selectedRow.exchangeDetail ? (
              // 交易所标准品种：字段由交易所规定，这里只读展示，不提供编辑/删除。
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="text-xs font-medium text-slate-500">{t("productLibrary.exchangeDetailTitle")}</div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
                  {t("productLibrary.exchangeReadOnlyHint")}
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="space-y-1">
                    <div className="form-label">{t("productLibrary.exchangeCode")}</div>
                    <div className="form-input flex items-center tabular-nums text-slate-700">{selectedRow.exchangeDetail.code}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("productLibrary.exchangeMarket")}</div>
                    <div className="form-input flex items-center text-slate-700">{selectedRow.exchangeDetail.market}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("productLibrary.termDays")}</div>
                    <div className="form-input flex items-center tabular-nums text-slate-700">
                      {selectedRow.termDays ?? "-"}{t("productLibrary.termUnitDay")}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("productLibrary.exchangeFeeRate")}</div>
                    <div className="form-input flex items-center tabular-nums text-slate-700">{selectedRow.exchangeDetail.feeRatePercent}%</div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("productLibrary.exchangeMinAmount")}</div>
                    <div className="form-input flex items-center tabular-nums text-slate-700">{formatMoney(selectedRow.exchangeDetail.minAmount)}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("productLibrary.exchangeStepAmount")}</div>
                    <div className="form-input flex items-center tabular-nums text-slate-700">{formatMoney(selectedRow.exchangeDetail.stepAmount)}</div>
                  </div>
                </div>
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
                          {/**
                           * 历史数据可能仍挂在被排除的机构上（往来人员 / 往来组织 /
                           * 家庭成员）。把它显示成不可选项，而不是留空：留空会让
                           * 用户以为已经清掉机构，但 draft 里仍是旧 id，保存后照旧。
                           */}
                          {(() => {
                            const currentId = draft[field.key] ?? "";
                            if (!currentId || institutionOptions.some((item) => item.id === currentId)) return null;
                            const hidden = institutions.find((item) => item.id === currentId);
                            if (!hidden) return null;
                            return (
                              <option value={hidden.id} disabled>
                                {hidden.shortName?.trim() || hidden.name}
                                {t("productLibrary.institutionNotSelectable")}
                              </option>
                            );
                          })()}
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
                  <div className="text-[11px] text-slate-400">
                    {/* 债券/理财：留空即「通用」，所有机构都能选购；存款/保险仍与机构强绑定。 */}
                    {universalScope
                      ? t("productLibrary.universalProductHint")
                      : t("productLibrary.noInstitutionHint")}
                  </div>
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
                  {!isCreating && selectedRow && !selectedRow.readOnly && !deleteState ? (
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
                        disabled={saving || !canSave || !!selectedRow?.readOnly}
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
    </ModalLayer>
  );
}
