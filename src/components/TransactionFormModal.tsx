"use client";

import { ArrowLeftRight, ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm, NestedAddModal } from "./EntityCreateForm";
import { SmartSelect, SmartSelectOption } from "./SmartSelect";
import { UnifiedEntryLauncher } from "./UnifiedEntryLauncher";
import { useAccountSSFilter } from "./accountSSFilter";
import { kindLabel } from "@/lib/account-kinds";
import { getCashTargetOperation } from "@/lib/account-kind-utils";
import { buildAccountDisplayOption, buildGroupedAccountOptions } from "@/lib/account-display";
import { recordRecentAccount, sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  fetchSettingsAccountData,
  fetchSettingsCategories,
  fetchSettingsTags,
  notifySettingsDataChanged,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsCategory,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import {
  buildCreditCardInstallmentSchedule,
  summarizeCreditCardInstallments,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { filterIncomeExpenseInstitutions } from "@/lib/institution-rules";

type TxType = "expense" | "income" | "advance" | "transfer" | "fx" | "investment";
type DebtTransferMode = "borrow_in" | "repay_out" | "lend_out" | "collect_in";

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  currency?: string | null;
  billingDay?: number | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
};

type CategoryOption = {
  id: string;
  label: string;
  parentId: string | null;
  type: string;
};

type AiPrefillItem = {
  rawText?: string;
  type?: "expense" | "income" | "transfer" | "fx" | "investment";
  date?: string;
  amount?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
};

type OpenFromAiDetail = {
  requestId: string;
  item: AiPrefillItem;
  source?: "launcher";
  defaultAccountId?: string;
  defaultFromAccountId?: string;
  defaultToAccountId?: string;
  /** 锁定记账类型：打开后只保留该类型，隐藏支出/收入/代付切换 tab（如银证转账只允许转账）。 */
  lockedType?: TxType;
  /** 银证转账模式：转入账户固定为当前股票机构下的证券资金账户，转出账户从同一所有人的资金账户选择。 */
  stockTransferMode?: boolean;
  stockCashAccountId?: string;
  stockCashAccountName?: string;
};

function normalizeYmd(value: string | undefined) {
  const s = (value ?? "").trim();
  if (!s) return "";
  const d = new Date(s.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toDateInputValue(value: string | null | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[\sT]+\d{1,2}[:：]\d{2})?/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const normalized = raw
    .replace(/[/.]/g, "-")
    .replace("年", "-")
    .replace("月", "-")
    .replace("日", "")
    .replace(" ", "T");
  const ymd = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${String(Number(ymd[2])).padStart(2, "0")}-${String(Number(ymd[3])).padStart(2, "0")}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function dateInputToUtcDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseMoneyDraft(value: string) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCurrencyLabel(value: string | null | undefined) {
  const text = String(value ?? "CNY").trim().toUpperCase();
  return text || "CNY";
}

function formatFxRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function formatFxQuoteAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const COMMON_CURRENCY_OPTIONS = ["CNY", "USD", "JPY", "HKD", "EUR", "GBP"];
const BASE_CASH_CURRENCY = "CNY";

function isForeignCurrency(value: string | null | undefined) {
  return normalizeCurrencyLabel(value) !== BASE_CASH_CURRENCY;
}

function storedAmountToDialogAmount(type: TxType, value: number) {
  if (type === "transfer") return Math.abs(value);
  return type === "expense" ? -value : value;
}

function dialogAmountToStoredAmount(type: TxType, value: string) {
  const parsed = parseMoneyDraft(value);
  return type === "expense" ? -parsed : parsed;
}

function compactIds(ids: Array<string | null | undefined>) {
  return Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

function inferDebtTransferMode(
  sourceAccount: AccountOption | SmartSelectOption | undefined,
  targetAccount: AccountOption | SmartSelectOption | undefined,
): DebtTransferMode | null {
  const source = sourceAccount as AccountOption | undefined;
  const target = targetAccount as AccountOption | undefined;
  if (source?.kind === "loan") {
    return source.debtDirection === "receivable" ? "collect_in" : "borrow_in";
  }
  if (target?.kind === "loan") {
    return target.debtDirection === "receivable" ? "lend_out" : "repay_out";
  }
  return null;
}

function findAccountIdByLabel(input: string | undefined, options: AccountOption[]) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const exact = options.find((o) => o.label === raw);
  if (exact) return exact.id;
  const bySuffix = options.find((o) => o.label.endsWith(`·${raw}`));
  if (bySuffix) return bySuffix.id;
  const lower = raw.toLowerCase();
  const fuzzy = options.find((o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()));
  return fuzzy?.id ?? "";
}

function makeRequestId(prefix: string) {
  return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function findCategoryIdByLabel(input: string | undefined, options: CategoryOption[]) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const exact = options.find((o) => o.label === raw);
  if (exact) return exact.id;
  const suffix = options.find((o) => o.label.endsWith(`.${raw}`) || o.label.endsWith(raw));
  if (suffix) return suffix.id;
  const lower = raw.toLowerCase();
  const fuzzy = options.find((o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()));
  return fuzzy?.id ?? "";
}

function getCategoryLeafName(label: string) {
  return label.includes(".") ? label.split(".").pop() ?? label : label;
}

function buildCategoryOptionsFromSettings(categories: SettingsCategory[], type: string): CategoryOption[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const pathFor = (category: SettingsCategory) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: SettingsCategory | undefined = category;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return names.join(".");
  };
  return categories
    .filter((category) => category.type === type)
    .map((category) => ({
      id: category.id,
      label: pathFor(category),
      parentId: category.parentId ?? null,
      type: category.type,
    }));
}

function settingsAccountToOption(account: SettingsAccountRecord): AccountOption {
  const display = buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0]);
  return {
    id: account.id,
    label: display.selectorLabel || display.label,
    subLabel: display.subLabel,
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    debtDirection: account.debtDirection ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
    billingDay: account.billingDay ?? null,
  };
}

function buildGroupedOptionsFromSettingsAccounts(accounts: SettingsAccountRecord[]): SmartSelectOption[] {
  const displayOptions = accounts.map((account) => buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0]));
  const metaById = new Map(accounts.map((account) => [account.id, settingsAccountToOption(account)]));
  return buildGroupedAccountOptions(displayOptions).map((option) => (
    option.isHeader || option.isGroup ? option : { ...option, ...metaById.get(option.id) }
  ));
}

type TagOption = {
  id: string;
  name: string;
  color?: string | null;
};

type EditTagOption = {
  id?: string;
  tagId?: string;
  name?: string | null;
  label?: string | null;
  color?: string | null;
  Tag?: { name?: string | null; color?: string | null } | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SubmitMode = "close" | "repeat";
const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

type SettingsAccountRecord = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  isPlaceholder?: boolean | null;
  groupId?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  numberMasked?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  currency?: string | null;
  billingDay?: number | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
};

export function TransactionFormModal({
  accounts,
  transferAccounts,
  expenseCategories,
  incomeCategories,
  advanceCategories,
  defaultAccountId,
  lastRepayToAccountId,
  lastRepayFromAccountId,
  isCreditCardAccount,
  showInvestment,
  action,
  editAction,
  allTags,
  accountSSOptions,
  transferAccountSSOptions,
  nestedFieldData,
  hideTrigger = false,
}: {
  accounts: AccountOption[];
  transferAccounts: AccountOption[];
  expenseCategories: CategoryOption[];
  incomeCategories: CategoryOption[];
  advanceCategories?: CategoryOption[];
  defaultAccountId?: string;
  lastRepayToAccountId?: string;
  lastRepayFromAccountId?: string;
  isCreditCardAccount?: boolean;
  showInvestment?: boolean;
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  allTags?: TagOption[];
  /** Hierarchical SmartSelect options for spending account dropdown (grouped by AccountGroup) */
  accountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for transfer account dropdown (grouped by AccountGroup) */
  transferAccountSSOptions?: SmartSelectOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [txType, setTxType] = useState<TxType>("expense");
  const [lockedType, setLockedType] = useState<TxType | null>(null);
  const [stockTransferMode, setStockTransferMode] = useState(false);
  const [stockCashAccountId, setStockCashAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editEntryOriginalType, setEditEntryOriginalType] = useState<TxType | null>(null);
  const [editEntryHasFundDetail, setEditEntryHasFundDetail] = useState(false);
  const [editOriginalTransferAccounts, setEditOriginalTransferAccounts] = useState<{ fromAccountId: string; toAccountId: string } | null>(null);
  const [fromAccountIdEdited, setFromAccountIdEdited] = useState(false);
  const [categoryList, setCategoryList] = useState(expenseCategories);
  const [categoryNestedOpen, setCategoryNestedOpen] = useState(false);
  const [accountNestedOpen, setAccountNestedOpen] = useState(false);
  const [counterpartyNestedOpen, setCounterpartyNestedOpen] = useState(false);
  const [institutionNestedOpen, setInstitutionNestedOpen] = useState(false);
  const [accountCreateTarget, setAccountCreateTarget] = useState<"account" | "from" | "to">("account");
  const [tagList, setTagList] = useState(allTags ?? []);
  const [accountList, setAccountList] = useState(accounts);
  const [transferAccountList, setTransferAccountList] = useState(transferAccounts);
  const [localAccountSSOpts, setLocalAccountSSOpts] = useState(accountSSOptions);
  const [localTransferAccountSSOpts, setLocalTransferAccountSSOpts] = useState(transferAccountSSOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const formRef = useRef<HTMLFormElement>(null);
  const submitModeRef = useRef<SubmitMode>("close");

  function mergeSmartSelectOptions(base?: SmartSelectOption[], extra?: SmartSelectOption[]) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((opt) => opt.id));
    for (const opt of extra ?? []) {
      if (!seen.has(opt.id)) merged.push(opt);
    }
    return merged;
  }

  function normalizeEditTagOptions(tags: EditTagOption[] | undefined): TagOption[] {
    const normalized: TagOption[] = [];
    const seen = new Set<string>();
    for (const tag of tags ?? []) {
      const id = String(tag.id ?? tag.tagId ?? "").trim();
      if (!id || seen.has(id)) continue;
      const name = String(tag.name ?? tag.label ?? tag.Tag?.name ?? "").trim();
      if (!name) continue;
      normalized.push({ id, name, color: tag.color ?? tag.Tag?.color ?? null });
      seen.add(id);
    }
    return normalized;
  }

  function mergeTagOptions(base: TagOption[], extra: TagOption[]) {
    if (extra.length === 0) return base;
    const merged = [...base];
    const byId = new Map(merged.map((tag, index) => [tag.id, index]));
    for (const tag of extra) {
      const existingIndex = byId.get(tag.id);
      if (existingIndex == null) {
        byId.set(tag.id, merged.length);
        merged.push(tag);
        continue;
      }
      const existing = merged[existingIndex];
      if (!existing.name && tag.name) {
        merged[existingIndex] = { ...existing, name: tag.name, color: existing.color ?? tag.color ?? null };
      }
    }
    return merged;
  }

  function appendAccountOptionWithGroup(
    base: SmartSelectOption[] | undefined,
    option: SmartSelectOption,
    groupId?: string,
    groupName?: string,
  ) {
    const next = [...(base ?? [])];
    const headerId = groupId ? `group:${groupId}` : "";
    if (headerId && groupName?.trim() && !next.some((item) => item.id === headerId)) {
      next.push({ id: headerId, label: groupName.trim(), isHeader: true });
    }
    if (!next.some((item) => item.id === option.id)) {
      next.push({
        ...option,
        parentId: headerId || undefined,
      });
    }
    return next;
  }

  async function openAccountCreate(target: "account" | "from" | "to") {
    setAccountCreateTarget(target);
    setAccountNestedOpen(true);
    void (async () => {
      const res = await fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).catch(() => null);
      if (res?.ok) {
        const data = await res.json().catch(() => null);
        if (data?.ok) {
          setLocalNestedFieldData({
            groupId: (data.groups ?? []).filter((group: { name: string }) => group.name !== "未指定").map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
            institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
              id: institution.id,
              name: institution.shortName?.trim() || institution.name,
              type: institution.type ?? "",
            })),
            counterpartyId: (data.counterparties ?? [])
              .filter((counterparty: { type?: string | null }) => COUNTERPARTY_TYPES.has(counterparty.type ?? "other"))
              .map((counterparty: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
                id: counterparty.id,
                name: counterparty.shortName?.trim() || counterparty.name,
                type: counterparty.type ?? "other",
              })),
          });
        }
      }
    })();
  }

  useEffect(() => {
    setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    if (accountSSOptions) {
      setLocalAccountSSOpts((prev) => mergeSmartSelectOptions(accountSSOptions, prev));
    }
  }, [accountSSOptions]);

  useEffect(() => {
    if (transferAccountSSOptions) {
      setLocalTransferAccountSSOpts((prev) => mergeSmartSelectOptions(transferAccountSSOptions, prev));
    }
  }, [transferAccountSSOptions]);

  const currentCategoryType = useMemo(() =>
    txType === "income" ? "income" :
    txType === "advance" ? "advance" :
    txType === "investment" ? "investment" : "expense",
  [txType]);

  /** Build parent category options with hierarchical display.
   * In transaction entry, new categories are created under an existing category,
   * so every existing category, including top-level categories, can be selected
   * as the parent.
   */
  const categoryParentOptions = useMemo(() => {
    // Build a parent-id → children map for all categories of current type
    const byParentId = new Map<string | null, CategoryOption[]>();
    for (const c of categoryList) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }

    const options: Array<{ id: string; name: string; label: string; type: string; depth: number; parentId?: string; isGroup?: boolean }> = [];

    // Recursively walk the tree, building indented options
    function walk(parentId: string | null, depth: number, pathPrefix: string) {
      const children = byParentId.get(parentId) ?? [];
      for (const child of children) {
        const shortName = child.label.includes(".") ? child.label.split(".").pop() ?? child.label : child.label;
        const fullLabel = pathPrefix ? `${pathPrefix}.${shortName}` : shortName;
        options.push({
          id: child.id,
          name: shortName,
          label: fullLabel,
          type: currentCategoryType,
          depth,
          parentId: child.parentId ?? undefined,
          isGroup: (byParentId.get(child.id) ?? []).length > 0,
        });
        walk(child.id, depth + 1, fullLabel);
      }
    }

    // Start from root (parentId=null)
    walk(null, 0, "");

    return options;
  }, [categoryList, currentCategoryType]);

  /** Build hierarchical SmartSelect options for category dropdown.
   * All real categories are selectable. Categories with children are collapsible
   * groups, and their caret toggles expansion without taking away selection.
   */
  const categorySSOptions = useMemo(() => {
    const byParentId = new Map<string | null, CategoryOption[]>();
    for (const c of categoryList) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }

    const opts: SmartSelectOption[] = [];
    const INDENT = "　";

    /** Walk the tree recursively.
     *  currentGroupId tracks the nearest isHeader or isGroup ancestor for parentId linkage. */
    function walk(parentId: string | null, level: number, currentGroupId?: string) {
      const children = byParentId.get(parentId) ?? [];
      for (const child of children) {
        const shortName = child.label.includes(".") ? child.label.split(".").pop() ?? child.label : child.label;
        const grandChildren = byParentId.get(child.id) ?? [];

        if (grandChildren.length > 0) {
          // Category with children -> collapsible group and selectable category.
          opts.push({
            id: child.id,
            label: `${INDENT.repeat(level)}${shortName}`,
            isGroup: true,
            parentId: currentGroupId,
          });
          walk(child.id, level + 1, child.id);
        } else {
          // Leaf → regular selectable item
          opts.push({
            id: child.id,
            label: `${INDENT.repeat(level)}${shortName}`,
            parentId: currentGroupId,
          });
          // No deeper walk needed for leaf
        }
      }
    }

    walk(null, 0);
    return opts;
  }, [categoryList]);

  useEffect(() => {
    const nextCategoryList = txType === "income" ? incomeCategories : txType === "advance" ? (advanceCategories ?? []) : expenseCategories;
    setCategoryList(nextCategoryList);
    setCategoryId((current) => current && nextCategoryList.some((c) => c.id === current) ? current : "");
  }, [txType, incomeCategories, advanceCategories, expenseCategories]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [date, setDate] = useState(today);
  const [postedAt, setPostedAt] = useState(() => toDateInputValue(today));
  const [postedAtEdited, setPostedAtEdited] = useState(false);
  const [amount, setAmount] = useState("");
  const [fxToAmount, setFxToAmount] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxFeeAmount, setFxFeeAmount] = useState("");
  const [fxFromCurrencyDraft, setFxFromCurrencyDraft] = useState("CNY");
  const [fxToCurrencyDraft, setFxToCurrencyDraft] = useState("USD");
  const [fetchingFxRate, setFetchingFxRate] = useState(false);
  const [createInstallment, setCreateInstallment] = useState(false);
  const [installmentAmount, setInstallmentAmount] = useState("");
  const [installmentAmountEdited, setInstallmentAmountEdited] = useState(false);
  const [installmentTotal, setInstallmentTotal] = useState("12");
  const [installmentRateType, setInstallmentRateType] = useState<CreditCardInstallmentRateType>("period_fee");
  const [installmentRate, setInstallmentRate] = useState("0");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const [categoryId, setCategoryId] = useState("");
  const [counterpartyInstitutionId, setCounterpartyInstitutionId] = useState("");
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [isFromButton, setIsFromButton] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function refreshAccountData() {
      const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
      if (cancelled || !data) return;
      const rawAccounts = (data.accounts as SettingsAccountRecord[])
        .filter((account) => account.isPlaceholder !== true && account.isActive !== false);
      const allOptions = rawAccounts.map(settingsAccountToOption);
      const allowedKinds = new Set(
        [...accounts, ...accountList]
          .map((account) => account.kind)
          .filter((kind): kind is string => Boolean(kind)),
      );
      const nextAccountOptions = allOptions.filter((option) => !allowedKinds.size || allowedKinds.has(option.kind ?? ""));
      const selectedIds = new Set([accountId, fromAccountId, toAccountId].filter(Boolean));
      setAccountList((prev) => {
        const selectedOnly = prev.filter((option) => selectedIds.has(option.id) && !nextAccountOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(nextAccountOptions, selectedOnly);
      });
      setTransferAccountList((prev) => {
        const selectedOnly = prev.filter((option) => selectedIds.has(option.id) && !allOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(allOptions, selectedOnly);
      });
      const groupedAll = buildGroupedOptionsFromSettingsAccounts(rawAccounts);
      const groupedAccount = buildGroupedOptionsFromSettingsAccounts(
        rawAccounts.filter((account) => !allowedKinds.size || allowedKinds.has(account.kind ?? "")),
      );
      setLocalAccountSSOpts(groupedAccount);
      setLocalTransferAccountSSOpts(groupedAll);
      setLocalNestedFieldData({
        groupId: (data.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
        institutionId: (data.institutions ?? []).map((institution) => ({
          id: institution.id,
          name: institution.shortName?.trim() || institution.name,
          type: institution.type ?? "",
        })),
        counterpartyId: (data.counterparties ?? []).map((counterparty) => ({
          id: counterparty.id,
          name: counterparty.shortName?.trim() || counterparty.name,
          type: counterparty.type ?? "organization",
        })),
      });
    }

    async function refreshCategories() {
      const next = await fetchSettingsCategories({ force: true }).catch(() => null);
      if (cancelled || !next) return;
      setCategoryList(buildCategoryOptionsFromSettings(next, currentCategoryType));
    }

    async function refreshTags() {
      const next = await fetchSettingsTags({ force: true }).catch(() => null);
      if (cancelled || !next) return;
      setTagList(next.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })));
    }

    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<SettingsDataChangedDetail>).detail;
      const scope = detail?.scope ?? "all";
      if (scope === "accounts" || scope === "all") void refreshAccountData();
      if (scope === "categories" || scope === "all") void refreshCategories();
      if (scope === "tags" || scope === "all") void refreshTags();
    }

    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [
    accountId,
    accountList,
    accounts,
    currentCategoryType,
    fromAccountId,
    toAccountId,
  ]);

  const {
    ownerFilter,
    ownerFilterLabel,
    cycleOwnerFilter,
    filteredOptions: accountSSOptionsFiltered,
    visibleOptionIds: accountVisibleOptionIds,
  } = useAccountSSFilter(localAccountSSOpts);
  const {
    filteredOptions: transferFiltered,
    visibleOptionIds: transferVisibleOptionIds,
  } = useAccountSSFilter(localTransferAccountSSOpts, ownerFilter);

  const recentAccountIds = useRecentAccountIds();
  const displayTransferOptions = useMemo(() => {
    const source = (transferFiltered?.length ? transferFiltered : localTransferAccountSSOpts) ?? [];
    const filtered = source.filter((option) => !option.isHeader);
    let merged = mergeSmartSelectOptions(filtered, transferAccountList);
    const selectedIds = new Set([fromAccountId, toAccountId].filter(Boolean));
    const selectedOptions = merged.filter((option) => selectedIds.has(option.id));
    if (transferVisibleOptionIds) {
      merged = merged.filter((option) => transferVisibleOptionIds.has(option.id));
    }
    // 银证转账：转出账户不能是证券资金账户本身，只保留同一所有人的资金账户
    if (stockTransferMode && stockCashAccountId) {
      merged = merged.filter((option) => option.id !== stockCashAccountId);
    }
    for (const option of selectedOptions) {
      if (!merged.some((item) => item.id === option.id)) merged.push(option);
    }
    return sortOptionsByRecent(merged, recentAccountIds);
  }, [fromAccountId, localTransferAccountSSOpts, recentAccountIds, stockCashAccountId, stockTransferMode, toAccountId, transferAccountList, transferFiltered, transferVisibleOptionIds]);

  // 银证转账转入账户：当前股票机构证券资金账户 + 同一所有人的资金账户
  const stockTransferToOptions = useMemo(() => {
    const source = (transferFiltered?.length ? transferFiltered : localTransferAccountSSOpts) ?? [];
    const filtered = source.filter((option) => !option.isHeader);
    let merged = mergeSmartSelectOptions(filtered, transferAccountList);
    if (transferVisibleOptionIds) {
      merged = merged.filter((option) => transferVisibleOptionIds.has(option.id));
    }
    if (stockCashAccountId && !merged.some((option) => option.id === stockCashAccountId)) {
      const cashOption = transferAccountList.find((option) => option.id === stockCashAccountId)
        ?? localTransferAccountSSOpts?.find((option) => option.id === stockCashAccountId && !option.isHeader);
      if (cashOption) merged.push(cashOption);
    }
    return sortOptionsByRecent(merged, recentAccountIds);
  }, [localTransferAccountSSOpts, recentAccountIds, stockCashAccountId, transferAccountList, transferFiltered, transferVisibleOptionIds]);

  const displayAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(accountSSOptionsFiltered, accountList);
    if (accountVisibleOptionIds) {
      base = base.filter((option) => accountVisibleOptionIds.has(option.id));
    }
    return sortOptionsByRecent(base, recentAccountIds);
  }, [accountSSOptionsFiltered, accountList, accountVisibleOptionIds, recentAccountIds]);
  const incomeExpenseInstitutionOptions = useMemo(
    () => filterIncomeExpenseInstitutions(localNestedFieldData?.institutionId ?? nestedFieldData?.institutionId ?? []),
    [localNestedFieldData, nestedFieldData],
  );
  const compactAccountSelectBehavior = useMemo(() => ({
    density: "compact" as const,
    dropdownMaxHeight: 320,
  }), []);

  const accountMetaById = useMemo(() => {
    const map = new Map<string, AccountOption>();
    const add = (option: AccountOption | SmartSelectOption | undefined) => {
      if (!option?.id || option.isHeader || option.isGroup) return;
      const current = map.get(option.id);
      const next = option as AccountOption;
      if (!current || (!current.kind && next.kind)) {
        map.set(option.id, next);
      }
    };
    [...transferAccountList, ...accountList].forEach(add);
    (localTransferAccountSSOpts ?? []).forEach(add);
    (localAccountSSOpts ?? []).forEach(add);
    return map;
  }, [accountList, localAccountSSOpts, localTransferAccountSSOpts, transferAccountList]);
  const selectedAccountIsCreditCard = accountMetaById.get(accountId)?.kind === "bank_credit"
    || (isCreditCardAccount && accountId === (defaultAccountId ?? accountId));
  const fxFromCurrency = fromAccountId
    ? normalizeCurrencyLabel(accountMetaById.get(fromAccountId)?.currency)
    : fxFromCurrencyDraft;
  const fxToCurrency = toAccountId
    ? normalizeCurrencyLabel(accountMetaById.get(toAccountId)?.currency)
    : fxToCurrencyDraft;
  const fxComputedRate = useMemo(() => {
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(fxToAmount);
    return fromValue > 0 && toValue > 0 ? toValue / fromValue : null;
  }, [amount, fxToAmount]);
  const fxCurrencyOptions = useMemo(() => {
    const currencies = new Set(COMMON_CURRENCY_OPTIONS);
    for (const option of displayTransferOptions) {
      const currency = normalizeCurrencyLabel((option as AccountOption).currency);
      if (currency) currencies.add(currency);
    }
    return Array.from(currencies)
      .filter(isForeignCurrency)
      .sort((a, b) => COMMON_CURRENCY_OPTIONS.indexOf(a) - COMMON_CURRENCY_OPTIONS.indexOf(b));
  }, [displayTransferOptions]);
  const fxFromAccountOptions = useMemo(
    () => displayTransferOptions.filter((option) => (option as AccountOption).kind === "bank_debit"),
    [displayTransferOptions],
  );
  const fxToAccountOptions = useMemo(
    () => displayTransferOptions.filter((option) => {
      const account = option as AccountOption;
      return account.id !== fromAccountId
        && account.kind !== "bank_credit"
        && account.kind !== "loan"
        && isForeignCurrency(account.currency);
    }),
    [displayTransferOptions, fromAccountId],
  );
  function formatFxAmount(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "";
    return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }
  function updateFxFromAmount(value: string) {
    setAmount(value);
    const fromValue = parseMoneyDraft(value);
    const rateValue = parseMoneyDraft(fxRate);
    if (fromValue > 0 && rateValue > 0) setFxToAmount(formatFxAmount(fromValue * rateValue));
  }
  function updateFxRate(value: string) {
    setFxRate(value);
    const fromValue = parseMoneyDraft(amount);
    const rateValue = parseMoneyDraft(value);
    if (fromValue > 0 && rateValue > 0) setFxToAmount(formatFxAmount(fromValue * rateValue));
  }
  function updateFxToAmount(value: string) {
    setFxToAmount(value);
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(value);
    if (fromValue > 0 && toValue > 0) setFxRate(formatFxRate(toValue / fromValue));
  }
  async function fetchFxRateForForm() {
    if (fetchingFxRate) return;
    if (!fxFromCurrency || !fxToCurrency || fxFromCurrency === fxToCurrency) {
      window.alert("请先选择不同的换出币种和换入币种");
      return;
    }
    setFetchingFxRate(true);
    try {
      const params = new URLSearchParams({
        from: fxFromCurrency,
        to: fxToCurrency,
        refresh: "1",
      });
      const res = await fetch(`/api/v1/fx-rates?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !Array.isArray(data.rates)) {
        throw new Error(data?.error || "汇率获取失败");
      }
      const rateRow = data.rates.find((rate: { fromCurrency?: string; toCurrency?: string }) =>
        normalizeCurrencyLabel(rate.fromCurrency) === fxFromCurrency &&
        normalizeCurrencyLabel(rate.toCurrency) === fxToCurrency
      );
      const rate = Number(rateRow?.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error("未获取到可用汇率，可手工填写");
      }
      const formattedRate = formatFxRate(rate);
      setFxRate(formattedRate);
      const fromValue = parseMoneyDraft(amount);
      if (fromValue > 0) setFxToAmount(formatFxAmount(fromValue * rate));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "汇率获取失败，可手工填写");
    } finally {
      setFetchingFxRate(false);
    }
  }
  const fxCommonQuoteText = useMemo(() => {
    if (fxFromCurrency === fxToCurrency) return "换出币种和换入币种相同，请选择不同币种账户";
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(fxToAmount);
    if (fromValue <= 0 || toValue <= 0) return "";
    const quoteBase = 100;
    const quoteAmount = (fromValue / toValue) * quoteBase;
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return "";
    return `当前折算：${quoteBase} ${fxToCurrency} = ${formatFxQuoteAmount(quoteAmount)} ${fxFromCurrency}`;
  }, [amount, fxFromCurrency, fxToAmount, fxToCurrency]);
  const installmentPreview = useMemo(() => {
    if (!createInstallment) return null;
    const account = accountMetaById.get(accountId);
    const billingDay = Number(account?.billingDay);
    const firstDate = dateInputToUtcDate(date);
    if (!firstDate || !Number.isFinite(billingDay) || billingDay < 1 || billingDay > 31) return null;
    try {
      const rows = buildCreditCardInstallmentSchedule({
        principal: Number(installmentAmount),
        totalRuns: Number(installmentTotal),
        rateType: installmentRateType,
        rate: Number(installmentRate),
        billingDay,
        firstDate,
      });
      return {
        rows,
        summary: summarizeCreditCardInstallments(rows),
      };
    } catch {
      return null;
    }
  }, [accountId, accountMetaById, createInstallment, date, installmentAmount, installmentRate, installmentRateType, installmentTotal]);

  function openSpecialTransferTargetIfNeeded() {
    if (txType !== "transfer") return false;
    const sourceAccount = accountMetaById.get(fromAccountId);
    const targetAccount = accountMetaById.get(toAccountId);
    const debtMode = inferDebtTransferMode(sourceAccount, targetAccount);
    const operation = debtMode ? "debt" : getCashTargetOperation(targetAccount);
    if (operation === "transfer") return false;

    if (editEntryId) {
      if (operation === "debt" && debtMode && editEntryOriginalType !== "transfer") {
        return false;
      }
      if (operation === "debt" && debtMode) {
        const isDebtSourceFlow = debtMode === "borrow_in" || debtMode === "collect_in";
        const cashAccountId = isDebtSourceFlow ? toAccountId : fromAccountId;
        const debtAccountId = isDebtSourceFlow ? fromAccountId : toAccountId;
        if (!cashAccountId) {
          window.alert(isDebtSourceFlow ? "请选择资金到账账户" : "请选择资金来源账户");
          return true;
        }
        const amountNumber = Number(amount);
        if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
          window.alert("金额不正确");
          return true;
        }

        window.dispatchEvent(new CustomEvent("mmh:debt:create", {
          detail: {
            requestId: requestId ?? makeRequestId(operation),
            editEntryId,
            mode: debtMode,
            defaultDebtAccountId: debtAccountId,
            defaultCashAccountId: cashAccountId,
            defaultDate: date,
            defaultPrincipal: amountNumber,
            defaultNote: note,
          },
        }));
        setOpen(false);
        resetDraft();
        return true;
      }
      window.alert("这类目标账户需要用对应的专用记账窗口编辑，不能保存为普通转账。");
      return true;
    }
    const isDebtSourceFlow = debtMode === "borrow_in" || debtMode === "collect_in";
    const cashAccountId = isDebtSourceFlow ? toAccountId : fromAccountId;
    const debtAccountId = isDebtSourceFlow ? fromAccountId : toAccountId;
    if (!cashAccountId) {
      window.alert(isDebtSourceFlow ? "请选择资金到账账户" : "请选择资金来源账户");
      return true;
    }
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      window.alert("金额不正确");
      return true;
    }

    const nextRequestId = requestId ?? makeRequestId(operation);
    const baseDetail = {
      requestId: nextRequestId,
      defaultCashAccountId: cashAccountId,
      defaultDate: date,
      defaultAmount: amountNumber,
    };

    if (operation === "investment") {
      const productType = targetAccount?.investProductType === "metal"
        ? "metal"
        : targetAccount?.investProductType === "money"
          ? "money"
          : "fund";
      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
        detail: {
          ...baseDetail,
          defaultAccountId: toAccountId,
          defaultProductType: productType,
        },
      }));
    } else if (operation === "wealth") {
      window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
        detail: {
          ...baseDetail,
          defaultWealthAccountId: toAccountId,
        },
      }));
    } else if (operation === "deposit") {
      window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
        detail: {
          ...baseDetail,
          defaultDepositAccountId: toAccountId,
          defaultSubtype: "buy",
        },
      }));
    } else if (operation === "debt") {
      window.dispatchEvent(new CustomEvent("mmh:debt:create", {
        detail: {
          requestId: nextRequestId,
          mode: debtMode ?? (targetAccount?.debtDirection === "receivable" ? "lend_out" : "repay_out"),
          defaultDebtAccountId: debtAccountId,
          defaultCashAccountId: cashAccountId,
          defaultDate: date,
          defaultPrincipal: amountNumber,
        },
      }));
    }

    setOpen(false);
    resetDraft();
    return true;
  }
  useEffect(() => {
    if (!open || txType === "transfer" || !accountId) return;
    setLocalAccountSSOpts((prev) => {
      const currentOptions = prev ?? accountSSOptions ?? [];
      if (currentOptions.some((opt) => opt.id === accountId)) return prev;
      const fallback = accountList.find((opt) => opt.id === accountId);
      if (!fallback) return prev;
      return [...currentOptions, fallback];
    });
  }, [open, txType, accountId, accountList, accountSSOptions]);

  function resetDraft() {
    setTxType("expense");
    setDate(today);
    setPostedAt(toDateInputValue(today));
    setPostedAtEdited(false);
    setAmount("");
    setFxToAmount("");
    setFxRate("");
    setFxFeeAmount("");
    setFxFromCurrencyDraft("CNY");
    setFxToCurrencyDraft("USD");
    setCreateInstallment(false);
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setInstallmentTotal("12");
    setInstallmentRateType("period_fee");
    setInstallmentRate("0");
    setAccountId(defaultAccountId ?? "");
    if (isCreditCardAccount) {
      setFromAccountId(lastRepayFromAccountId ?? defaultAccountId ?? "");
      setToAccountId(defaultAccountId ?? "");
    } else {
      setFromAccountId("");
      setToAccountId("");
    }
    setCategoryId("");
    setCounterpartyInstitutionId("");
    setNote("");
    setSelectedTagIds([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    setFromAccountIdEdited(false);
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  function repeatDraft() {
    setAmount("");
    setFxToAmount("");
    setFxRate("");
    setFxFeeAmount("");
    setCreateInstallment(false);
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    if ((txType === "transfer" || txType === "fx") && !isCreditCardAccount && !fromAccountId && defaultAccountId) {
      setFromAccountId(defaultAccountId);
    }
  }

  function swapTransferAccounts() {
    const prevFrom = fromAccountId;
    const prevTo = toAccountId;
    setFromAccountId(prevTo);
    setToAccountId(prevFrom);
  }

  function switchType(nextType: TxType) {
    const currentType = txType;
    if ((nextType === "transfer" || nextType === "fx") && currentType !== "transfer" && currentType !== "fx") {
      setAmount((value) => {
        const numericValue = Number(String(value).replace(/,/g, ""));
        return Number.isFinite(numericValue) && numericValue !== 0 ? String(Math.abs(numericValue)) : value;
      });
      const currentAccountId = accountId || defaultAccountId || "";
      if (currentType === "income") {
        setToAccountId(currentAccountId);
        if (fromAccountId === currentAccountId) setFromAccountId("");
        setFromAccountIdEdited(false);
      } else {
        setFromAccountId(currentAccountId);
        if (toAccountId === currentAccountId) setToAccountId("");
        setFromAccountIdEdited(true);
      }
      setCategoryId("");
    } else if ((currentType === "transfer" || currentType === "fx") && nextType !== "transfer" && nextType !== "fx") {
      const transferFromAccountId = fromAccountId || editOriginalTransferAccounts?.fromAccountId || "";
      const transferToAccountId = toAccountId || editOriginalTransferAccounts?.toAccountId || "";
      const nextAccountId = nextType === "income"
        ? transferToAccountId || transferFromAccountId || defaultAccountId || ""
        : transferFromAccountId || transferToAccountId || defaultAccountId || "";
      setAccountId(nextAccountId);
      setFromAccountIdEdited(false);
    }
    setTxType(nextType);
  }

  useEffect(() => {
    function onOpenFromAi(ev: Event) {
      const detail = (ev as CustomEvent<OpenFromAiDetail>).detail;
      if (!detail?.requestId || !detail.item) return;

      const item = detail.item;
      const mappedType: TxType =
        item.type === "income"
          ? "income"
          : item.type === "transfer"
            ? "transfer"
            : item.type === "fx"
              ? "fx"
            : item.type === "investment"
              ? "investment"
              : "expense";

      setRequestId(detail.requestId);
      setOpen(true);
      setIsFromButton(detail.source === "launcher");
      setLockedType(detail.lockedType ?? null);
      setStockTransferMode(detail.stockTransferMode === true);
      setStockCashAccountId(detail.stockCashAccountId ?? "");
      setTxType(mappedType);

      const dateStr = normalizeYmd(item.date) || today;
      setDate(dateStr);
      setPostedAt(toDateInputValue(dateStr));
      setPostedAtEdited(false);

      const num = typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : 0;
      setAmount(num > 0 ? String(num) : "");

      const noteText = (item.remark ?? "").trim() || (item.counterparty ?? "").trim() || (item.rawText ?? "").trim();
      setNote(noteText);

      setFxToAmount("");
      setFxRate("");
      setFxFeeAmount("");

      if (mappedType === "transfer" || mappedType === "fx") {
        const nextFromAccountId = findAccountIdByLabel(item.fromAccount, transferAccounts) || detail.defaultFromAccountId || detail.defaultAccountId || (defaultAccountId ?? "");
        const rawNextToAccountId = findAccountIdByLabel(item.toAccount ?? item.account, transferAccounts) || detail.defaultToAccountId || "";
        const rawNextToAccount = transferAccounts.find((account) => account.id === rawNextToAccountId);
        const nextToAccountId = mappedType === "fx" && rawNextToAccount && !isForeignCurrency(rawNextToAccount.currency)
          ? ""
          : rawNextToAccountId;
        // 银证转账：转入账户固定为当前股票机构的证券资金账户
        const effectiveToAccountId = detail.stockTransferMode
          ? (detail.stockCashAccountId || nextToAccountId)
          : nextToAccountId;
        const effectiveFromAccountId = detail.stockTransferMode && effectiveToAccountId === nextFromAccountId
          ? ""
          : nextFromAccountId;
        setFromAccountId(effectiveFromAccountId);
        setToAccountId(effectiveToAccountId);
        if (mappedType === "fx") {
          const fromCurrency = transferAccounts.find((account) => account.id === nextFromAccountId)?.currency;
          const toCurrency = transferAccounts.find((account) => account.id === nextToAccountId)?.currency;
          setFxFromCurrencyDraft(normalizeCurrencyLabel(fromCurrency));
          setFxToCurrencyDraft(toCurrency ? normalizeCurrencyLabel(toCurrency) : "USD");
        }
        setCategoryId("");
        setAccountId("");
      } else {
        setAccountId(findAccountIdByLabel(item.account, accounts) || (defaultAccountId ?? ""));

        const rawCat = (item.category ?? "").trim();
        const withTypePrefix = rawCat ? `支出.${rawCat}` : "";
        const nextCatId = findCategoryIdByLabel(withTypePrefix, expenseCategories)
          || findCategoryIdByLabel(rawCat, expenseCategories);
        setCategoryId(nextCatId);

        setFromAccountId(defaultAccountId ?? "");
        setToAccountId("");
      }
    }

    window.addEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
  }, [accounts, defaultAccountId, expenseCategories, incomeCategories, lastRepayFromAccountId, lastRepayToAccountId, today, transferAccounts]);

  useEffect(() => {
    function onOpenEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        type: TxType;
        date: string;
        postedAt?: string | null;
        amount: number;
        note: string;
        toNote?: string;
        accountId?: string;
        accountLabel?: string;
        categoryId?: string;
        counterpartyInstitutionId?: string;
        accountName?: string;
        fromAccountName?: string;
        fromAccountId?: string;
        toAccountId?: string;
        toAccountName?: string;
        fundSubtype?: string;
        hasFundDetail?: boolean;
        cashAccountId?: string;
        fundCode?: string;
        fundName?: string;
        fundUnits?: number;
        fundNav?: number;
        fundFee?: number;
        fundProductType?: string;
        tagIds?: string[];
        tags?: EditTagOption[];
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setEditEntryOriginalType(detail.type);
      setEditEntryHasFundDetail(detail.hasFundDetail ?? false);
      setCreateInstallment(false);
      setOpen(true);
      setTxType(detail.type);
      setDate(detail.date || today);
      setPostedAt(toDateInputValue(detail.postedAt || detail.date || today));
      setPostedAtEdited(Boolean(detail.postedAt));
      const numericAmount = Number(detail.amount);
      const dialogAmount = Number.isFinite(numericAmount) ? storedAmountToDialogAmount(detail.type, numericAmount) : 0;
      setAmount(
        dialogAmount !== 0
          ? String(dialogAmount)
          : "",
      );
      setNote(detail.note ?? "");
      setCounterpartyInstitutionId(detail.counterpartyInstitutionId ?? "");
      const detailTags = normalizeEditTagOptions(detail.tags);
      const nextTagIds = detail.tagIds?.length ? detail.tagIds : detailTags.map((tag) => tag.id);
      setTagList((prev) => {
        const knownIds = new Set([...prev.map((tag) => tag.id), ...detailTags.map((tag) => tag.id)]);
        const missingSelectedTags = nextTagIds
          .filter((id) => !knownIds.has(id))
          .map((id) => ({ id, name: "未知标签", color: null }));
        return mergeTagOptions(prev, [...detailTags, ...missingSelectedTags]);
      });
      setSelectedTagIds(nextTagIds);
      if (detail.type === "transfer") {
        const nextToAccountId = detail.toAccountId ?? "";
        const nextFromAccountId = detail.fromAccountId && detail.fromAccountId !== nextToAccountId
          ? detail.fromAccountId
          : detail.accountId ?? "";
        const fallbackTransferOption = (id: string, label?: string): AccountOption | null => {
          if (!id) return null;
          const existing = transferAccountList.find((opt) => opt.id === id)
            ?? (transferAccountSSOptions ?? []).find((opt) => opt.id === id && !opt.isHeader && !opt.isGroup) as AccountOption | undefined;
          if (existing) return existing;
          const text = (label ?? "").trim();
          return text ? { id, label: text } : null;
        };
        const transferExtras = [
          fallbackTransferOption(nextFromAccountId, detail.fromAccountName ?? detail.accountName),
          fallbackTransferOption(nextToAccountId, detail.toAccountName),
        ].filter((option): option is AccountOption => !!option);
        setLocalTransferAccountSSOpts((prev) => {
          return mergeSmartSelectOptions(prev ?? transferAccountSSOptions, transferExtras);
        });
        setTransferAccountList((prev) => mergeSmartSelectOptions(prev, transferExtras));
        setAccountId("");
        setCategoryId("");
        setFromAccountId(nextFromAccountId);
        setToAccountId(nextToAccountId);
        setEditOriginalTransferAccounts({ fromAccountId: nextFromAccountId, toAccountId: nextToAccountId });
        setFromAccountIdEdited(true);
      } else {
        const nextAccountId = detail.accountId ?? (defaultAccountId ?? "");
        setLocalAccountSSOpts((prev) => {
          const extra = accountList.find((opt) => opt.id === nextAccountId);
          if (extra) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [extra]);
          }
          if (nextAccountId && detail.accountLabel) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [{ id: nextAccountId, label: detail.accountLabel }]);
          }
          return prev ?? accountSSOptions;
        });
        setAccountId(nextAccountId);
        setCategoryId(detail.categoryId ?? "");
        setFromAccountId("");
        setToAccountId(detail.toAccountId ?? "");
        setEditOriginalTransferAccounts(null);
        setFromAccountIdEdited(false);
      }
    }

    window.addEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
    return () => window.removeEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
  }, [
    accountList,
    accountSSOptions,
    defaultAccountId,
    today,
    transferAccountList,
    transferAccountSSOptions,
  ]);

  useEffect(() => {
    if (!open || (txType !== "expense" && txType !== "income") || postedAtEdited) return;
    setPostedAt(toDateInputValue(date || today));
  }, [date, open, postedAtEdited, today, txType]);

  useEffect(() => {
    if (!open || txType !== "fx" || !editEntryId) return;
    let cancelled = false;
    fetch(`/api/v1/fx-conversions?entryId=${encodeURIComponent(editEntryId)}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data?.ok || !data.conversion) return;
        const conversion = data.conversion as {
          date?: string;
          fromAccountId?: string;
          toAccountId?: string;
          fromCurrency?: string;
          toCurrency?: string;
          fromAmount?: number;
          toAmount?: number;
          exchangeRate?: number;
          feeAmount?: number | null;
          note?: string | null;
        };
        setDate(conversion.date || today);
        setFromAccountId(conversion.fromAccountId ?? "");
        setToAccountId(conversion.toAccountId ?? "");
        setFxFromCurrencyDraft(normalizeCurrencyLabel(conversion.fromCurrency));
        setFxToCurrencyDraft(normalizeCurrencyLabel(conversion.toCurrency));
        setAmount(formatFxAmount(Number(conversion.fromAmount ?? 0)));
        setFxToAmount(formatFxAmount(Number(conversion.toAmount ?? 0)));
        setFxRate(formatFxRate(Number(conversion.exchangeRate ?? 0)));
        setFxFeeAmount(conversion.feeAmount == null ? "" : formatFxAmount(Number(conversion.feeAmount)));
        setNote(conversion.note ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editEntryId, open, today, txType]);

  useEffect(() => {
    if (!open || !isCreditCardAccount || txType !== "transfer") return;
    if (fromAccountIdEdited || !toAccountId) return;
    if (accountMetaById.get(toAccountId)?.kind !== "bank_credit") return;
    fetch(`/api/v1/fund/last-repay-account?accountId=${encodeURIComponent(toAccountId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.repayAccountId) setFromAccountId(d.repayAccountId);
      })
      .catch(() => {});
  }, [accountMetaById, open, isCreditCardAccount, txType, toAccountId, fromAccountIdEdited]);

  function currentFinanceRefreshDetail() {
    const accountIds = txType === "transfer" || txType === "fx"
      ? compactIds([fromAccountId, toAccountId])
      : txType === "investment"
        ? compactIds([accountId, fromAccountId, toAccountId, defaultAccountId])
        : compactIds([accountId, toAccountId, defaultAccountId]);
    return {
      reason: "transaction-save",
      accountIds: accountIds.length > 0 ? accountIds : undefined,
      entryIds: editEntryId ? [editEntryId] : undefined,
    };
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (openSpecialTransferTargetIfNeeded()) return;

    if (editEntryId && editEntryOriginalType === "investment" && txType !== "investment" && editEntryHasFundDetail) {
      const confirmed = window.confirm("这条投资记录有对应的基金明细。\n\n选择「确定」将删除基金明细记录。\n选择「取消」将保留基金明细但清空资金来源关联。\n\n请选择：");
      if (!confirmed) {
        const formData = new FormData(e.currentTarget);
        formData.set("type", txType);
        formData.set("date", date);
        if (txType === "expense" || txType === "income") formData.set("postedAt", postedAt);
        formData.set("amount", String(dialogAmountToStoredAmount(txType, amount)));
        formData.set("note", note);
        formData.set("toNote", txType === "transfer" ? note : "");
        formData.set("entryId", editEntryId);
        formData.set("keepFundDetail", "true");
        setSubmitting(true);
        try {
          const res = await (editAction ?? action)(formData);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
          requestAnimationFrame(() => {
            dispatchFinanceDataChanged(currentFinanceRefreshDetail());
          });
          resetDraft();
        } catch (err) {
          window.alert(String(err));
        } finally {
          setSubmitting(false);
        }
        return;
      }
    }
    
    if (txType === "fx") {
      const fromValue = parseMoneyDraft(amount);
      const toValue = parseMoneyDraft(fxToAmount);
      const feeValue = String(fxFeeAmount ?? "").trim() ? parseMoneyDraft(fxFeeAmount) : null;
      if (!fromAccountId) {
        window.alert("请选择换出账户");
        return;
      }
      if (accountMetaById.get(fromAccountId)?.kind !== "bank_debit") {
        window.alert("换出账户只能选择借记卡");
        return;
      }
      if (toAccountId && fromAccountId === toAccountId) {
        window.alert("换出账户和换入账户不能相同");
        return;
      }
      if (toAccountId && !isForeignCurrency(accountMetaById.get(toAccountId)?.currency)) {
        window.alert("换入账户只能选择外币账户");
        return;
      }
      if (!toAccountId && !isForeignCurrency(fxToCurrencyDraft)) {
        window.alert("换入币种只能选择外币");
        return;
      }
      if (fxFromCurrency === fxToCurrency) {
        window.alert("同币种账户请使用普通转账，跨币种才使用换汇");
        return;
      }
      if (fromValue <= 0 || toValue <= 0) {
        window.alert("换出金额和换入金额必须大于 0");
        return;
      }
      if (feeValue != null && feeValue <= 0) {
        window.alert("手续费必须大于 0，或留空");
        return;
      }
      setSubmitting(true);
      try {
        const res = await fetch("/api/v1/fx-conversions", {
          method: editEntryId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entryId: editEntryId,
            date,
            fromAccountId,
            toAccountId,
            toCurrency: fxToCurrencyDraft,
            fromAmount: fromValue,
            toAmount: toValue,
            exchangeRate: fxComputedRate,
            feeAmount: feeValue,
            note,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          window.alert(data?.error ?? "换汇保存失败");
          return;
        }
        if (requestId) {
          window.dispatchEvent(new CustomEvent(editEntryId ? "mmh:transaction:edit:success" : "mmh:create-transaction:success", { detail: { requestId } }));
        }
        void notifySettingsDataChanged({ scope: "accounts", reason: "fx:auto-account", prefetch: true });
        requestAnimationFrame(() => {
          dispatchFinanceDataChanged(currentFinanceRefreshDetail());
        });
        if (submitModeRef.current === "repeat" && !editEntryId) {
          repeatDraft();
        } else {
          setOpen(false);
          resetDraft();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "换汇保存失败";
        window.alert(msg);
      } finally {
        submitModeRef.current = "close";
        setSubmitting(false);
      }
      return;
    }

    let formData: FormData;
    if (txType === "investment") {
      formData = new FormData(e.currentTarget);
      formData.set("type", "investment");
      formData.set("date", date);
      formData.set("amount", amount);
      formData.set("note", note);
      formData.set("toNote", "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
    } else {
      formData = new FormData();
      formData.set("type", txType);
      formData.set("date", date);
      if (txType === "expense" || txType === "income") formData.set("postedAt", postedAt);
      formData.set("amount", String(dialogAmountToStoredAmount(txType, amount)));
      formData.set("note", note);
      formData.set("toNote", txType === "transfer" ? note : "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
      if (txType === "transfer") {
        formData.set("fromAccountId", fromAccountId);
        formData.set("toAccountId", toAccountId);
        } else if (txType === "income") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          if (toAccountId) formData.set("toAccountId", toAccountId);
        } else if (txType === "advance") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
        } else {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
      }
      formData.set("tagIds", JSON.stringify(selectedTagIds));
      if (txType === "expense" && createInstallment && !editEntryId) {
        formData.set("createInstallment", "true");
        formData.set("installmentAmount", installmentAmount);
        formData.set("installmentTotal", installmentTotal);
        formData.set("installmentRateType", installmentRateType);
        formData.set("installmentRate", installmentRate);
      }
    }
    setSubmitting(true);
    try {
      const res = editEntryId ? await (editAction ?? action)(formData) : await action(formData);
      if (!res.ok) {
        window.alert(res.error);
        return;
      }
      if (requestId) {
        window.dispatchEvent(
          new CustomEvent(editEntryId ? "mmh:transaction:edit:success" : "mmh:create-transaction:success", { detail: { requestId } }),
        );
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged(currentFinanceRefreshDetail());
      });
      if (submitModeRef.current === "repeat" && !editEntryId) {
        repeatDraft();
      } else {
        setOpen(false);
        resetDraft();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "记账失败";
      window.alert(msg);
    } finally {
      submitModeRef.current = "close";
      setSubmitting(false);
    }
  }

  return (
    <>
      {!hideTrigger ? (
        <UnifiedEntryLauncher
          defaultAction="transaction"
          actions={[
            { key: "transaction", label: "记账" },
            { key: "fx", label: "换汇 / 购汇" },
            { key: "investment", label: "基金 / 贵金属", disabled: !showInvestment },
            { key: "wealth", label: "银行理财" },
            { key: "deposit-buy", label: "存款存入" },
            { key: "insurance", label: "保险" },
          ]}
          context={{
            defaultAccountId: defaultAccountId ?? "",
            defaultCashAccountId: defaultAccountId ?? "",
            defaultDepositAccountId: defaultAccountId ?? "",
            defaultInsuranceAccountId: defaultAccountId ?? "",
          }}
        />
      ) : null}

      {open ? createPortal(
        <div className="app-modal-backdrop z-50">
          <div className="app-modal-panel mobile-transaction-modal max-w-xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">
                {txType === "fx" ? "换汇 / 购汇" : editEntryId ? "编辑记录" : "记一笔"}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  resetDraft();
                }}
                className="secondary-button h-8 px-2"
              >
                关闭
              </button>
            </div>

            <form ref={formRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onSubmit={onSubmit}>
              {txType !== "fx" && lockedType ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    className="segment-button h-9 flex-1 segment-button-active"
                  >
                    {lockedType === "transfer" ? "转账" : lockedType === "income" ? "收入" : lockedType === "advance" ? "代付" : "支出"}
                  </button>
                </div>
              ) : txType !== "fx" ? (
              <div className="flex flex-wrap justify-center gap-2">
                {isCreditCardAccount ? (
                  <>
                    <button
                      type="button"
                      onClick={() => switchType("expense")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "expense"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      支出
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("income")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "income"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      收入
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("advance")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "advance"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      代付
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("transfer")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      转账
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => switchType("expense")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "expense"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      支出
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("income")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "income"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      收入
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("advance")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "advance"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      代付
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("transfer")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      转账
                    </button>
                  </>
                )}
              </div>
              ) : null}

              {txType === "investment" && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-medium text-slate-500 mb-1">选择投资类型：</div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultAccountId, defaultCashAccountId: accountId, defaultDate: date, defaultAmount: Number(amount) || undefined },
                      }));
                    }}
                    className="segment-button segment-button-active h-10 w-full"
                  >
                    基金
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId, defaultProductType: "metal" },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-yellow-200 bg-yellow-50 text-sm text-yellow-700 transition-colors hover:bg-yellow-100"
                  >
                    贵金属
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-amber-200 bg-amber-50 text-sm text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    银行理财
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-emerald-200 bg-emerald-50 text-sm text-emerald-700 transition-colors hover:bg-emerald-100"
                  >
                    活期 / 定期存款
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:insurance:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-sky-200 bg-sky-50 text-sm text-sky-700 transition-colors hover:bg-sky-100"
                  >
                    保险
                  </button>
                </div>
              )}

              {(txType === "expense" || txType === "income" || txType === "advance") && (
                <div className="space-y-3">
                  {txType === "advance" ? (
                    <>
                      <div className="space-y-1">
                        <div className="form-label">日期</div>
                        <DateStepper name="date" value={date} onChange={setDate} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">往来对象</div>
                          <SmartSelect
                            mode="single"
                            value={counterpartyInstitutionId}
                            onChange={setCounterpartyInstitutionId}
                            options={((localNestedFieldData ?? nestedFieldData)?.counterpartyId ?? [])
                              .filter((item) => COUNTERPARTY_TYPES.has(item.type ?? "other"))
                              .map((item) => ({ id: item.id, label: item.name }))}
                            placeholder="请选择"
                            onCreateClick={() => setCounterpartyNestedOpen(true)}
                            createLabel="新增往来对象"
                            searchable
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">所属账户</div>
                          <SmartSelect mode="single" value={accountId}
                            onChange={(id: string) => { setAccountId(id); recordRecentAccount(id); }}
                            options={displayAccountOptions} placeholder="请选择"
                            onCreateClick={() => { void openAccountCreate("account"); }}
                            onCycleOwnerFilter={cycleOwnerFilter}
                            ownerFilterLabel={ownerFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">日期</div>
                          <DateStepper name="date" value={date} onChange={setDate} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">
                            {isCreditCardAccount ? "记账账户" : (txType === "income" ? "收款账户" : "资金账户")}
                          </div>
                          <SmartSelect mode="single" value={accountId}
                            onChange={(id: string) => { setAccountId(id); recordRecentAccount(id); }}
                            options={displayAccountOptions} placeholder="请选择"
                            onCreateClick={() => { void openAccountCreate("account"); }}
                            onCycleOwnerFilter={cycleOwnerFilter}
                            ownerFilterLabel={ownerFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">入账日期</div>
                          <DateStepper
                            value={postedAt}
                            onChange={(value) => {
                              setPostedAt(toDateInputValue(value));
                              setPostedAtEdited(true);
                            }}
                            className="form-input"
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">收支机构</div>
                          <SmartSelect
                            mode="single"
                            value={counterpartyInstitutionId}
                            onChange={setCounterpartyInstitutionId}
                            options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                            placeholder="可选"
                            createLabel="新增往来对象"
                            searchable
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">类别</div>
                      <SmartSelect mode="single" value={categoryId} onChange={setCategoryId}
                        options={categorySSOptions} placeholder="未分类"
                        onCreateClick={() => setCategoryNestedOpen(true)}
                        behavior={{
                          hierarchy: true,
                          search: true,
                          initialCollapsedAll: true,
                          accordionGroups: true,
                          selectableGroups: true,
                          groupSelectOnDoubleClick: false,
                          minDropdownWidth: 560,
                          dropdownMaxHeight: 420,
                          density: "compact",
                          expandedGroupColumns: 4,
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">标签</div>
                      <SmartSelect mode="multi" value={selectedTagIds}
                        onChange={(ids) => setSelectedTagIds(ids)}
                        options={tagList.map(t => ({ id: t.id, label: t.name, color: t.color }))} placeholder="选择标签"
                        onInlineCreate={async (name, color) => {
                          const res = await fetch("/api/v1/tags", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name, color }),
                          });
                          const data = await res.json();
                          if (!data.ok || !data.tag) throw new Error(data.error ?? "创建失败");
                          return { id: data.tag.id, label: data.tag.name, color: data.tag.color };
                        }}
                        onCreated={(tag) => {
                          setTagList(prev => [...prev, { id: tag.id, name: tag.label, color: tag.color }]);
                          setSelectedTagIds(prev => [...prev, tag.id]);
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">金额</div>
                    <CalcInput value={amount} onChange={(value) => {
                      setAmount(value);
                      if (createInstallment && !installmentAmountEdited) {
                        const numeric = Math.abs(Number(value));
                        setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                      }
                    }} placeholder={txType === "expense" ? "正数流出，负数流入/退款" : "正数流入，负数流出/冲减"} label="金额" precision={2} />
                  </div>

                  {txType === "expense" && selectedAccountIsCreditCard && !editEntryId ? (
                    <div className="border-y border-slate-200 py-3 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                        <input
                          type="checkbox"
                          checked={createInstallment}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setCreateInstallment(checked);
                            if (checked && !installmentAmountEdited) {
                              const numeric = Math.abs(Number(amount));
                              setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                            }
                          }}
                          className="h-4 w-4 accent-slate-800"
                        />
                        消费分期
                      </label>
                      {createInstallment ? (
                        <>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <div className="form-label">分期金额</div>
                              <CalcInput value={installmentAmount} onChange={(value) => {
                                setInstallmentAmount(value);
                                setInstallmentAmountEdited(true);
                              }} placeholder="默认全部金额" label="分期金额" precision={2} />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">期数</div>
                              <input
                                type="number"
                                min={2}
                                max={120}
                                step={1}
                                value={installmentTotal}
                                onChange={(event) => setInstallmentTotal(event.target.value)}
                                className="form-input"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">{installmentRateType === "annual_interest" ? "年利率 (%)" : "每期费率 (%)"}</div>
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="0.0001"
                                value={installmentRate}
                                onChange={(event) => setInstallmentRate(event.target.value)}
                                className="form-input"
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <div className="inline-flex h-8 overflow-hidden rounded border border-slate-200 bg-white">
                              <button type="button" onClick={() => setInstallmentRateType("period_fee")}
                                className={`px-3 text-xs ${installmentRateType === "period_fee" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                每期手续费
                              </button>
                              <button type="button" onClick={() => setInstallmentRateType("annual_interest")}
                                className={`border-l border-slate-200 px-3 text-xs ${installmentRateType === "annual_interest" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                年利率
                              </button>
                            </div>
                            {installmentPreview ? (
                              <div className="text-xs tabular-nums text-slate-500">
                                首期 {installmentPreview.summary.firstPayment.toFixed(2)} · 费用 {installmentPreview.summary.totalInterest.toFixed(2)} · 合计 {installmentPreview.summary.totalPayment.toFixed(2)}
                              </div>
                            ) : null}
                          </div>
                          {installmentPreview ? (
                            <div className="max-h-48 overflow-auto rounded-md border border-slate-200">
                              <table className="min-w-full text-xs tabular-nums">
                                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                                  <tr>
                                    <th className="px-2 py-1 text-left font-medium">期数</th>
                                    <th className="px-2 py-1 text-left font-medium">日期</th>
                                    <th className="px-2 py-1 text-right font-medium">本金</th>
                                    <th className="px-2 py-1 text-right font-medium">{installmentRateType === "annual_interest" ? "利息" : "手续费"}</th>
                                    <th className="px-2 py-1 text-right font-medium">应还</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {installmentPreview.rows.map((row) => (
                                    <tr key={row.installmentNo} className="border-t border-slate-100">
                                      <td className="px-2 py-1 text-slate-600">{row.installmentNo}/{installmentTotal}</td>
                                      <td className="px-2 py-1 text-slate-600">{row.date.toISOString().slice(0, 10)}</td>
                                      <td className="px-2 py-1 text-right text-slate-700">{row.principal.toFixed(2)}</td>
                                      <td className="px-2 py-1 text-right text-slate-700">{row.interest.toFixed(2)}</td>
                                      <td className="px-2 py-1 text-right font-medium text-slate-800">{row.payment.toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {/* 第五行：备注 */}
                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      name="note"
                      placeholder="可选"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="form-input"
                    />
                  </div>
                </div>
              )}

              {txType === "fx" && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="form-label">日期</div>
                    <DateStepper name="date" value={date} onChange={setDate} />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">换出账户</div>
                      <SmartSelect mode="single" value={fromAccountId} onChange={(v) => {
                        setFromAccountId(v);
                        const currency = normalizeCurrencyLabel(accountMetaById.get(v)?.currency);
                        if (currency) setFxFromCurrencyDraft(currency);
                        if (v && v === toAccountId) setToAccountId("");
                        recordRecentAccount(v);
                      }}
                        options={fxFromAccountOptions} placeholder="只能选择借记卡"
                        onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增借记卡账户"
                        onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                        behavior={compactAccountSelectBehavior} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">换入账户</div>
                      <SmartSelect mode="single" value={toAccountId} onChange={(v) => {
                        setToAccountId(v);
                        const currency = normalizeCurrencyLabel(accountMetaById.get(v)?.currency);
                        if (currency) setFxToCurrencyDraft(currency);
                        recordRecentAccount(v);
                      }}
                        options={fxToAccountOptions}
                        placeholder={`不选择时，将按 ${fxToCurrencyDraft} 自动建立同机构外币账户`}
                        onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                        onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                        behavior={compactAccountSelectBehavior} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">换出币种</div>
                      <div className="form-input flex h-9 items-center bg-slate-50 text-slate-700">
                        {fromAccountId ? fxFromCurrency : "选择换出账户后自动读取"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">换入币种</div>
                      {toAccountId ? (
                        <div className="form-input flex h-9 items-center bg-slate-50 text-slate-700">
                          {fxToCurrency}
                        </div>
                      ) : (
                        <select
                          value={fxToCurrencyDraft}
                          onChange={(event) => setFxToCurrencyDraft(event.target.value)}
                          className="form-input"
                        >
                          {fxCurrencyOptions.map((currency) => (
                            <option key={`to-${currency}`} value={currency}>{currency}</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">换出金额 ({fxFromCurrency})</div>
                      <CalcInput value={amount} onChange={updateFxFromAmount} placeholder="例如：1000.00" label="换出金额" precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">汇率（可手工填写）</div>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <CalcInput value={fxRate} onChange={updateFxRate} placeholder={`1 ${fxFromCurrency} = ? ${fxToCurrency}`} label="汇率" precision={8} />
                        </div>
                        <button
                          type="button"
                          onClick={() => void fetchFxRateForForm()}
                          disabled={fetchingFxRate || fxFromCurrency === fxToCurrency}
                          className="secondary-button h-9 shrink-0 gap-1 px-2 text-[11px] disabled:opacity-50"
                          title="获取当前币种对汇率，并填入汇率框"
                        >
                          <RefreshCw className={`h-3 w-3 ${fetchingFxRate ? "animate-spin" : ""}`} />
                          {fetchingFxRate ? "获取中" : "获取汇率"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">手续费</div>
                      <CalcInput value={fxFeeAmount} onChange={setFxFeeAmount} placeholder="可选，已含在换出金额" label="手续费" precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">换入金额 ({fxToCurrency})</div>
                      <CalcInput value={fxToAmount} onChange={updateFxToAmount} placeholder="例如：21500.00" label="换入金额" precision={2} />
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {fxCommonQuoteText || "可填写汇率自动计算换入金额，也可以直接填写换入金额反算汇率。"}
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      name="note"
                      placeholder="例如：购汇：日元"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="form-input"
                    />
                  </div>
                </div>
              )}

              {txType === "transfer" && (
                <div className="space-y-3">
                  {/* 第一行：日期 | 收支机构 */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">日期</div>
                      <DateStepper name="date" value={date} onChange={setDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">收支机构</div>
                      <SmartSelect
                        mode="single"
                        value={counterpartyInstitutionId}
                        onChange={setCounterpartyInstitutionId}
                        options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                        placeholder="可选"
                        onCreateClick={() => setInstitutionNestedOpen(true)}
                        createLabel="新增收支机构"
                        searchable
                      />
                    </div>
                  </div>

                  {/* 第二行：转出账户 | 互换 | 转入账户 */}
                  {stockTransferMode ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                          options={stockTransferToOptions} placeholder="请选择"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                    </div>
                  ) : isCreditCardAccount ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">转出账户</div>
                        <SmartSelect mode="single" value={fromAccountId} onChange={(v) => { setFromAccountId(v); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("from"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                      <div className="flex items-center justify-center pb-0.5">
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title="互换转出/转入账户"><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">转入账户</div>
                        <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                          options={displayTransferOptions} placeholder="请选择"
                          onCreateClick={() => { void openAccountCreate("to"); }} createLabel="新增账户"
                          onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                          behavior={compactAccountSelectBehavior} />
                      </div>
                    </div>
                  )}

                  {/* 第三行：金额 */}
                  <div className="space-y-1">
                    <div className="form-label">金额</div>
                    <CalcInput value={amount} onChange={setAmount} placeholder="例如：88.50" label="金额" precision={2} />
                  </div>

                  {/* 第四行：备注 */}
                  <div className="space-y-1">
                    <div className="form-label">备注</div>
                    <input
                      name="note"
                      placeholder="可选"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="form-input"
                    />
                  </div>
                </div>
              )}

              <input type="hidden" name="type" value={txType} />

              <div className="flex items-center justify-end gap-2 pt-1">
                {isFromButton && !editEntryId ? (
                  <button
                    type="button"
                    className="secondary-button h-9 px-3 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                    onClick={() => {
                      submitModeRef.current = "repeat";
                      formRef.current?.requestSubmit();
                    }}
                    disabled={submitting}
                  >
                    保存并再记一笔
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="primary-button h-9 px-3"
                  onClick={() => { submitModeRef.current = "close"; }}
                  disabled={submitting}
                >
                  {submitting ? "保存中…" : editEntryId ? "保存修改" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      , document.body) : null}
    {open && categoryNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        key={currentCategoryType}
        entityType="category"
        open={categoryNestedOpen}
        onClose={() => setCategoryNestedOpen(false)}
        defaultType={currentCategoryType}
        hiddenFields={["type"]}
        parentCategories={categoryParentOptions}
        existingNames={categoryList.map((category) => getCategoryLeafName(category.label))}
        onCreated={(id, name, extra) => {
          const parentId = extra?.parentId;
          const type = extra?.type ?? currentCategoryType;
          if (parentId) {
            const parent = categoryList.find(c => c.id === parentId);
            const fullLabel = parent ? `${parent.label}.${name}` : name;
            setCategoryList(prev => [...prev, { id, label: fullLabel, parentId, type }]);
          } else {
            // Should not happen — parentId is always required in this context
            const typePrefix = currentCategoryType === "expense" ? "支出" : currentCategoryType === "income" ? "收入" : currentCategoryType;
            setCategoryList(prev => [...prev, { id, label: `${typePrefix}.${name}`, parentId: null, type }]);
          }
          setCategoryId(id);
        }}
      />,
      document.body,
    )}
    {open && accountNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="account"
        open={accountNestedOpen}
        onClose={() => setAccountNestedOpen(false)}
        onCreated={(id, name, extra) => {
          const kind = extra?.kind || "bank_debit";
          const institutionLabel = extra?.institutionShortName?.trim() || extra?.institutionName;
          const groupId = extra?.groupId?.trim();
          const groupName = extra?.groupName?.trim();
          const label = institutionLabel ? `${institutionLabel}·${name}` : name;
          const subLabel = kindLabel(kind);
          const option = { id, label, subLabel, kind, currency: extra?.currency };
          setAccountList(prev => [...prev, option]);
          setTransferAccountList(prev => [...prev, option]);
          setLocalAccountSSOpts(prev => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          setLocalTransferAccountSSOpts(prev => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          if (accountCreateTarget === "from") setFromAccountId(id);
          else if (accountCreateTarget === "to") setToAccountId(id);
          else setAccountId(id);
          setAccountNestedOpen(false);
          setAccountCreateTarget("account");
        }}
        nestedFieldData={localNestedFieldData ?? nestedFieldData}
      />,
      document.body,
    )}
    {open && counterpartyNestedOpen && createPortal(
      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="institution"
        open={counterpartyNestedOpen}
        onClose={() => setCounterpartyNestedOpen(false)}
        defaultType="person"
        allowedInstitutionTypes={["person", "organization"]}
        existingNames={(localNestedFieldData?.counterpartyId ?? nestedFieldData?.counterpartyId ?? []).map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "person" };
          setLocalNestedFieldData((prev) => ({
            ...(prev ?? nestedFieldData ?? {}),
            counterpartyId: [...((prev ?? nestedFieldData)?.counterpartyId ?? []), next],
          }));
          setCounterpartyInstitutionId(id);
          setCounterpartyNestedOpen(false);
        }}
      />,
      document.body,
    )}
    {open && institutionNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="institution"
        open={institutionNestedOpen}
        onClose={() => setInstitutionNestedOpen(false)}
        defaultType="payment"
        title="新增收支机构"
        nameLabel="机构名称"
        namePlaceholder="例如：支付宝、微信支付、工商银行"
        allowedInstitutionTypes={["bank", "payment", "ewallet"]}
        existingNames={incomeExpenseInstitutionOptions.map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "payment" };
          setLocalNestedFieldData((prev) => {
            const base = prev ?? nestedFieldData ?? {};
            return {
              ...base,
              institutionId: [...(base.institutionId ?? []), next],
              counterpartyId: base.counterpartyId ?? [],
            };
          });
          setCounterpartyInstitutionId(id);
          setInstitutionNestedOpen(false);
        }}
      />,
      document.body,
    )}
    </>
  );
}
