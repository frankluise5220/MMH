"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { ArrowLeftRight, ArrowRight, Lock, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { ClearableNoteField } from "./ClearableNoteField";
import { CurrencySmartSelect } from "./CurrencySmartSelect";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm, NestedAddModal } from "./EntityCreateForm";
import { EntryAttachmentButton, uploadEntryAttachmentFiles } from "./EntryAttachmentPanel";
import { SmartSelect, SmartSelectOption } from "./SmartSelect";
import { UnifiedEntryLauncher } from "./UnifiedEntryLauncher";
import { useAccountSSFilter } from "./accountSSFilter";
import { isSettlementCounterpartyType, kindLabel } from "@/lib/account-kinds";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";
import { getCashTargetOperation, isAdvanceFundingAccount, isDepositAccount, isDepositPostingCategoryAllowed, isIncomeExpensePostingAccount, isIncomeExpensePostingOrDepositAccount, isLoanOrSettlementAccountKind, isTransferDropdownAccount } from "@/lib/account-kind-utils";
import { buildAccountDisplayOption, buildGroupedAccountOptions, formatAccountHoverTitle } from "@/lib/account-display";
import { recordRecentAccount, sortByAccountUsage, useAccountUsage } from "@/lib/client/recentAccounts";
import { useEntryModalReconciledReadOnly, useResetEntryModalReconciledReadOnlyOnClose } from "@/lib/client/entryModalLock";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
/** 必填字段红框（统一实现，见该模块注释）。 */
import { REQUIRED_FIELD_CLASS } from "@/lib/client/required-field";
import type { DepositLotOption } from "@/lib/server/deposit-lot-options";
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
/** 固定弹窗高度：支出/收入/转账/预支四个页签内容长短不同，锁定后切页签窗体不位移。 */
import { useModalHeightLock } from "@/lib/client/useModalHeightLock";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { parseDateInputToUtc as dateInputToUtcDate } from "@/lib/date-utils";
import {
  FIXED_ASSET_EXPENSE_CATEGORY_NAME,
  isFixedAssetAccountLike,
  isFixedAssetExpenseCategoryPath,
} from "@/lib/fixed-asset";
import { useI18n } from "@/lib/i18n";
import {
  buildCreditCardInstallmentSchedule,
  summarizeCreditCardInstallments,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { filterIncomeExpenseInstitutions } from "@/lib/institution-rules";
import { buildCategoryParentOptions, buildCategoryTreeOptions } from "@/components/categorySmartSelect";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { normalizeOptionalCurrency } from "@/lib/currency";

type TxType = "expense" | "income" | "advance" | "transfer" | "fx" | "investment";
type FxDirection = "buy" | "sell";
type TransactionActionResult =
  | { ok: true; data?: { id?: string | null; cashEntryId?: string | null } | null }
  | { ok: false; error: string };
type LiabilityTransferMode = "borrow_in" | "repay_out" | "lend_out" | "collect_in";


type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
  kind?: string | null;
  investProductType?: string | null;
  liabilityDirection?: string | null;
  institutionId?: string | null;
  institutionType?: string | null;
  counterpartyId?: string | null;
  isSettlementAccount?: boolean | null;
  isConsumerLoan?: boolean | null;
  currency?: string | null;
  billingDay?: number | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
  /** 多币种层级里的父账户 id（注意与下拉分组头的 `parentId` 区分）。 */
  accountParentId?: string | null;
  /** 多币种父账户（聚合账户）标记：它自己不能记账。 */
  isAggregate?: boolean | null;
};

type CategoryOption = {
  id: string;
  label: string;
  parentId: string | null;
  type: string;
  sortOrder?: number;
  isSystem?: boolean;
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
  /** FX window direction: buy = CNY -> foreign (购入外汇), sell = foreign -> CNY (卖出外汇). */
  fxDirection?: FxDirection;
  /** Locks the entry type: only this type is kept and the expense/income/advance tab switcher is hidden (e.g. stock-to-cash transfer only allows transfer). */
  lockedType?: TxType;
  /** Stock-to-cash transfer mode: the target account is fixed to the securities cash account of the current stock institution, and the source account is chosen from cash accounts of the same owner. */
  stockTransferMode?: boolean;
  stockCashAccountId?: string;
  stockCashAccountName?: string;
  /** Opens an expense with a fixed-asset account already selected. */
  fixedAssetAccountId?: string;
  fixedAssetAssetId?: string;
  /** Requires the expense to stay linked to a fixed asset, even before an account is selected. */
  fixedAssetRequired?: boolean;
  lockFixedAsset?: boolean;
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

function formatFxQuoteAmount(value: number, locale: string) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

function inferLiabilityTransferMode(
  sourceAccount: AccountOption | SmartSelectOption | undefined,
  targetAccount: AccountOption | SmartSelectOption | undefined,
): LiabilityTransferMode | null {
  const source = sourceAccount as AccountOption | undefined;
  const target = targetAccount as AccountOption | undefined;
  if (source?.kind === "loan") {
    return source.liabilityDirection === "receivable" ? "collect_in" : "borrow_in";
  }
  if (target?.kind === "loan") {
    return target.liabilityDirection === "receivable" ? "lend_out" : "repay_out";
  }
  return null;
}

function isLoanDialogAccount(account: AccountOption | SmartSelectOption | undefined) {
  const option = account as AccountOption | undefined;
  return option?.kind === "loan" && option.isSettlementAccount !== true;
}

function liabilityDialogEventName(sourceAccount: AccountOption | SmartSelectOption | undefined, targetAccount: AccountOption | SmartSelectOption | undefined) {
  return isLoanDialogAccount(sourceAccount) || isLoanDialogAccount(targetAccount) ? "mmh:loan:create" : "mmh:settlement:create";
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
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
    }));
}

function settingsAccountToOption(account: SettingsAccountRecord): AccountOption {
  const display = buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0], undefined, { fields: getAccountLabelFieldsPreference() });
  return {
    id: account.id,
    label: display.selectorLabel || display.label,
    subLabel: display.subLabel,
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    liabilityDirection: account.liabilityDirection ?? null,
    institutionId: account.institutionId ?? null,
    institutionType: account.Institution?.type ?? null,
    currency: account.currency ?? null,
    billingDay: account.billingDay ?? null,
  };
}

function buildGroupedOptionsFromSettingsAccounts(accounts: SettingsAccountRecord[]): SmartSelectOption[] {
  const displayOptions = accounts.map((account) => buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0], undefined, { fields: getAccountLabelFieldsPreference() }));
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
  liabilityDirection?: string | null;
  currency?: string | null;
  billingDay?: number | null;
  Institution?: { name: string | null; shortName?: string | null; type?: string | null } | null;
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
  fixedAssetAccounts,
  fixedAssetAccountSSOptions,
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
  action: (formData: FormData) => Promise<TransactionActionResult>;
  editAction?: (formData: FormData) => Promise<TransactionActionResult>;
  allTags?: TagOption[];
  /** Hierarchical SmartSelect options for spending account dropdown (grouped by AccountGroup) */
  accountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for transfer account dropdown (grouped by AccountGroup) */
  transferAccountSSOptions?: SmartSelectOption[];
  /** Property investment accounts usable as fixed asset targets from normal expense entries */
  fixedAssetAccounts?: AccountOption[];
  /** Hierarchical SmartSelect options for fixed asset account dropdown */
  fixedAssetAccountSSOptions?: SmartSelectOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  hideTrigger?: boolean;
}) {
  const { t, language } = useI18n();
  const quickEntryConsumedRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  // 已「对账」的记录：编辑窗照常打开，但整张表单禁用（可查看、不可改）。
  const reconciledReadOnly = useEntryModalReconciledReadOnly();
  useResetEntryModalReconciledReadOnlyOnClose(open);
  const [txType, setTxType] = useState<TxType>("expense");
  const [lockedType, setLockedType] = useState<TxType | null>(null);
  const [stockTransferMode, setStockTransferMode] = useState(false);
  const [stockCashAccountId, setStockCashAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  /**
   * 弹窗高度锁定：支出/收入/转账/预支（以及外汇）子页内容长短不同，
   * 未锁定时弹窗在遮罩的居中布局里会随内容上下位移。
   * 锁定到这个弹窗**内容出现过的最大自然高度**后，短页签底部留白、长页签内部滚动，外框恒定。
   * 只在「新增」态测量：编辑态会多出分期表、基金明细等临时区块，量进去会把之后
   * 每一次新增记账的窗口都撑到那个高度（窗口底部一大片空白）；编辑态若已量到高度照常套用，
   * 未量到就按内容自适应，不会反向污染缓存。
   */
  const { panelRef, scrollRef, fixedHeightProps } = useModalHeightLock<HTMLDivElement, HTMLDivElement>(
    "transaction-form",
    open && !editEntryId,
  );
  const [editEntryOriginalType, setEditEntryOriginalType] = useState<TxType | null>(null);
  const [editEntryHasFundDetail, setEditEntryHasFundDetail] = useState(false);
  const [editOriginalTransferAccounts, setEditOriginalTransferAccounts] = useState<{ fromAccountId: string; toAccountId: string } | null>(null);
  // Original balance-affecting values captured when an edit dialog opens,
  // used to decide whether the save changes any balance (refresh scope).
  const editOriginalRef = useRef<{
    type: TxType;
    amountStored: number;
    date: string;
    accountId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  } | null>(null);
  // True while the advance settlement account came from the record being
  // edited (or was picked explicitly by the user). The auto-default effect
  // must not substitute the counterparty's first settlement account for it.
  const advanceAccountPinnedRef = useRef(false);
  // 「对方账户」视角编辑转账：备注框里看到的是第二备注，保存时也只写第二备注，
  // 第一备注保持原值（用户明确要求：默认一个备注，只有在这一侧编辑才分开存）。
  const editNoteScopeRef = useRef<"" | "toNote">("");
  const [fromAccountIdEdited, setFromAccountIdEdited] = useState(false);
  const [categoryList, setCategoryList] = useState(expenseCategories);
  const [editCategoryFallback, setEditCategoryFallback] = useState<CategoryOption | null>(null);
  const [categoryNestedOpen, setCategoryNestedOpen] = useState(false);
  const [accountNestedOpen, setAccountNestedOpen] = useState(false);
  const [counterpartyNestedOpen, setCounterpartyNestedOpen] = useState(false);
  /** 交易地点（常用商户）下拉里新增 —— 新增的往来对象类型固定为「常用商户」 */
  const [locationNestedOpen, setLocationNestedOpen] = useState(false);
  const [institutionNestedOpen, setInstitutionNestedOpen] = useState(false);
  const [accountCreateTarget, setAccountCreateTarget] = useState<"account" | "from" | "to" | "advance">("account");
  const [tagList, setTagList] = useState(allTags ?? []);
  const [accountList, setAccountList] = useState(accounts);
  const [transferAccountList, setTransferAccountList] = useState(transferAccounts);
  const [localAccountSSOpts, setLocalAccountSSOpts] = useState(accountSSOptions);
  const [localTransferAccountSSOpts, setLocalTransferAccountSSOpts] = useState(transferAccountSSOptions);
  const [fixedAssetAccountList, setFixedAssetAccountList] = useState(fixedAssetAccounts ?? []);
  const [localFixedAssetAccountSSOpts, setLocalFixedAssetAccountSSOpts] = useState(fixedAssetAccountSSOptions);
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

  async function openAccountCreate(target: "account" | "from" | "to" | "advance") {
    setAccountCreateTarget(target);
    setAccountNestedOpen(true);
    void (async () => {
      const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
      if (!data) return;
      setLocalNestedFieldData({
            groupId: (data.groups ?? []).filter((group: { name: string }) => group.name !== "未指定").map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
            institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
              id: institution.id,
              name: institution.shortName?.trim() || institution.name,
              type: institution.type ?? "",
            })),
            counterpartyId: (data.counterparties ?? [])
              .filter((counterparty: { type?: string | null }) => isSettlementCounterpartyType(counterparty.type))
              .map((counterparty: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
                id: counterparty.id,
                name: counterparty.shortName?.trim() || counterparty.name,
                type: counterparty.type ?? "other",
              })),
            merchantId: (data.counterparties ?? [])
              .filter((counterparty: { type?: string | null }) => counterparty.type === "merchant")
              .map((counterparty: { id: string; name: string; shortName?: string | null }) => ({
                id: counterparty.id,
                name: counterparty.shortName?.trim() || counterparty.name,
              })),
          });
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

  // Keep the flat account lists in step with fresh prop data (e.g. after an
  // account rename on another view) so labels and counterparty bindings never
  // go stale while the dialog stays mounted. Locally created accounts reappear
  // in the next accounts fetch, so nothing is lost by the full resync.
  useEffect(() => {
    setAccountList(accounts);
  }, [accounts]);

  useEffect(() => {
    setTransferAccountList(transferAccounts);
  }, [transferAccounts]);

  useEffect(() => {
    setFixedAssetAccountList(fixedAssetAccounts ?? []);
  }, [fixedAssetAccounts]);

  useEffect(() => {
    if (fixedAssetAccountSSOptions) {
      setLocalFixedAssetAccountSSOpts((prev) => mergeSmartSelectOptions(fixedAssetAccountSSOptions, prev));
    }
  }, [fixedAssetAccountSSOptions]);

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
  const categoryParentOptions = useMemo(
    () => buildCategoryParentOptions(categoryList, t, currentCategoryType),
    [categoryList, currentCategoryType, t],
  );

  useEffect(() => {
    const nextCategoryList = txType === "income" ? incomeCategories : txType === "advance" ? (advanceCategories ?? []) : expenseCategories;
    const fallback = editCategoryFallback && editCategoryFallback.type === currentCategoryType
      ? editCategoryFallback
      : null;
    setCategoryList(() => {
      if (!fallback || nextCategoryList.some((category) => category.id === fallback.id)) return nextCategoryList;
      return [...nextCategoryList, fallback];
    });
    setCategoryId((current) => current && (nextCategoryList.some((c) => c.id === current) || fallback?.id === current) ? current : "");
  }, [currentCategoryType, editCategoryFallback, txType, incomeCategories, advanceCategories, expenseCategories]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [date, setDate] = useState(today);
  const [postedAt, setPostedAt] = useState(() => toDateInputValue(today));
  const [postedAtEdited, setPostedAtEdited] = useState(false);
  const [amount, setAmount] = useState("");
  const [fxToAmount, setFxToAmount] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxFeeAmount, setFxFeeAmount] = useState("");
  const [fxDirection, setFxDirection] = useState<FxDirection>("buy");
  const [fxFromCurrencyDraft, setFxFromCurrencyDraft] = useState("CNY");
  const [fxToCurrencyDraft, setFxToCurrencyDraft] = useState("USD");
  const [fetchingFxRate, setFetchingFxRate] = useState(false);
  // Foreign-expense posting model: store the bank-posted local amount as `amount`
  // and keep the original settlement currency/amount as provenance fields.
  const [localAmount, setLocalAmount] = useState("");
  const [fxPostingV2, setFxPostingV2] = useState(true);
  const [createInstallment, setCreateInstallment] = useState(false);
  const [installmentAmount, setInstallmentAmount] = useState("");
  const [installmentAmountEdited, setInstallmentAmountEdited] = useState(false);
  const [installmentTotal, setInstallmentTotal] = useState("12");
  const [installmentRateType, setInstallmentRateType] = useState<CreditCardInstallmentRateType>("period_fee");
  const [installmentRate, setInstallmentRate] = useState("0");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  // 选中账户的存款判定：分类下拉的存款白名单过滤依赖它（须在 accountId 声明之后）。
  const selectedAccountOption = useMemo(
    () => accountList.find((option) => option.id === accountId),
    [accountList, accountId],
  );
  const selectedAccountIsDeposit = isDepositAccount(selectedAccountOption ?? null);
  const [depositLotId, setDepositLotId] = useState("");
  const [depositLotOptions, setDepositLotOptions] = useState<DepositLotOption[]>([]);
  const [depositLotsLoading, setDepositLotsLoading] = useState(false);

  /** Build hierarchical SmartSelect options for category dropdown.
   * All real categories are selectable. Categories with children are collapsible
   * groups, and their caret toggles expansion without taking away selection.
   * 存款账户落账时只显示白名单分类（利息收入/存款手续费等，2026-09-18）。
   */
  const categorySSOptions = useMemo(() => {
    const options = buildCategoryTreeOptions(categoryList, t);
    if ((txType !== "income" && txType !== "expense") || !selectedAccountIsDeposit) return options;
    const allowed = options.filter((option) => {
      if (option.isGroup) return true;
      return isDepositPostingCategoryAllowed(option.sourceName ?? option.label, txType);
    });
    // 组头保留当且仅当组内有命中白名单的子项；没有命中子项的组整组隐藏。
    const groupIdsWithChildren = new Set(allowed.filter((option) => !option.isGroup && option.parentId).map((option) => option.parentId as string));
    const filtered = allowed.filter((option) => {
      if (!option.isGroup) return true;
      return groupIdsWithChildren.has(option.id);
    });
    return filtered.length > 0 ? filtered : options;
  }, [categoryList, t, txType, selectedAccountIsDeposit]);
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const selectedTransferDepositAccountIds = useMemo(
    () => [fromAccountId, toAccountId].filter((id) => {
      const option = transferAccountList.find((item) => item.id === id)
        ?? accountList.find((item) => item.id === id);
      return isDepositAccount(option ?? null);
    }),
    [accountList, fromAccountId, toAccountId, transferAccountList],
  );
  const shouldLoadDepositLotOptions = (txType === "income" && selectedAccountIsDeposit)
    || (txType === "transfer" && Boolean(editEntryId) && selectedTransferDepositAccountIds.length > 0);
  const showDepositLotSelect = (txType === "income" && selectedAccountIsDeposit)
    || (txType === "transfer" && Boolean(editEntryId) && Boolean(depositLotId) && selectedTransferDepositAccountIds.length > 0);
  const depositLotAccountIds = useMemo(
    () => txType === "income" ? (accountId ? [accountId] : []) : selectedTransferDepositAccountIds,
    [accountId, selectedTransferDepositAccountIds, txType],
  );
  const [categoryId, setCategoryId] = useState("");
  useEffect(() => {
    if (!open || !shouldLoadDepositLotOptions || depositLotAccountIds.length === 0) {
      setDepositLotOptions([]);
      setDepositLotsLoading(false);
      return;
    }
    let cancelled = false;
    setDepositLotsLoading(true);
    const params = new URLSearchParams({
      accountIds: depositLotAccountIds.join(","),
      includeClosed: editEntryId ? "1" : "0",
    });
    fetch(`/api/v1/deposit/lots?${params.toString()}`, { cache: "no-store" })
      .then((res) => res.json().catch(() => null))
      .then((data) => {
        if (!cancelled) setDepositLotOptions(data?.ok && Array.isArray(data.lots) ? data.lots : []);
      })
      .catch(() => {
        if (!cancelled) setDepositLotOptions([]);
      })
      .finally(() => {
        if (!cancelled) setDepositLotsLoading(false);
      });
    return () => { cancelled = true; };
  }, [depositLotAccountIds, editEntryId, open, shouldLoadDepositLotOptions]);

  useEffect(() => {
    if (!open || !showDepositLotSelect || depositLotsLoading || depositLotOptions.length === 0) return;
    setDepositLotId((current) => {
      if (depositLotOptions.some((option) => option.id === current)) return current;
      if (editEntryId) return current;
      return depositLotOptions.length === 1 ? depositLotOptions[0].id : "";
    });
  }, [depositLotOptions, depositLotsLoading, editEntryId, open, showDepositLotSelect]);
  const [fixedAssetLinked, setFixedAssetLinked] = useState(false);
  const [fixedAssetAccountId, setFixedAssetAccountId] = useState("");
  const [fixedAssetAssetId, setFixedAssetAssetId] = useState("");
  const [fixedAssetLinkLocked, setFixedAssetLinkLocked] = useState(false);
  const [fixedAssetAccountNestedOpen, setFixedAssetAccountNestedOpen] = useState(false);
  const [fixedAssetAccountAutoOpen, setFixedAssetAccountAutoOpen] = useState(false);
  const [txCurrency, setTxCurrency] = useState("");
  const [convertingPostedAmount, setConvertingPostedAmount] = useState(false);
  const [counterpartyInstitutionId, setCounterpartyInstitutionId] = useState("");
  const [advanceAccountId, setAdvanceAccountId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  /** 标签下拉选项与「就地新建」回调：收支页签与转账页签共用一套，避免两处各写一份新建逻辑。 */
  const tagSelectOptions = useMemo(
    () => tagList.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color })),
    [tagList],
  );
  async function createTagInline(name: string, color: string): Promise<SmartSelectOption> {
    const res = await fetch("/api/v1/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, color }),
    });
    const data = await res.json();
    if (!data.ok || !data.tag) throw new Error(data.error ?? t("txForm.createFailed"));
    return { id: data.tag.id, label: data.tag.name, color: data.tag.color };
  }
  function handleTagCreated(tag: SmartSelectOption) {
    setTagList((prev) => [...prev, { id: tag.id, name: tag.label, color: tag.color ?? null }]);
    setSelectedTagIds((prev) => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
  }
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<File[]>([]);
  const amountInputRef = useRef<HTMLInputElement>(null);

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
      // 存款账户也进收支落账候选（2026-09-18）：分类在选中存款账户时收窄白名单。
      const postingOptions = allOptions.filter((option) => isIncomeExpensePostingOrDepositAccount(option));
      const nextAccountOptions = restrictAccountsByType(postingOptions, (option) => !allowedKinds.size || allowedKinds.has(option.kind ?? ""));
      const nextFixedAssetAccountOptions = allOptions.filter(isFixedAssetAccountLike);
      const selectedIds = new Set([accountId, fromAccountId, toAccountId].filter(Boolean));
      setAccountList((prev) => {
        const selectedOnly = prev.filter((option) => selectedIds.has(option.id) && !nextAccountOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(nextAccountOptions, selectedOnly);
      });
      const transferOptions = allOptions.filter((option) => isTransferDropdownAccount(option));
      setTransferAccountList((prev) => {
        const selectedOnly = prev.filter((option) => selectedIds.has(option.id) && !transferOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(transferOptions, selectedOnly);
      });
      setFixedAssetAccountList((prev) => {
        const selectedOnly = prev.filter((option) => fixedAssetAccountId === option.id && !nextFixedAssetAccountOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(nextFixedAssetAccountOptions, selectedOnly);
      });
      const groupedAll = buildGroupedOptionsFromSettingsAccounts(rawAccounts.filter((account) => isTransferDropdownAccount(account)));
      const groupedAccount = buildGroupedOptionsFromSettingsAccounts(
        rawAccounts.filter((account) =>
          isIncomeExpensePostingOrDepositAccount(account) && (!allowedKinds.size || allowedKinds.has(account.kind ?? "")),
        ),
      );
      const groupedFixedAsset = buildGroupedOptionsFromSettingsAccounts(
        rawAccounts.filter(isFixedAssetAccountLike),
      );
      setLocalAccountSSOpts(groupedAccount);
      setLocalTransferAccountSSOpts(groupedAll);
      setLocalFixedAssetAccountSSOpts(groupedFixedAsset);
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
    fixedAssetAccountId,
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
  const {
    filteredOptions: fixedAssetFiltered,
    visibleOptionIds: fixedAssetVisibleOptionIds,
  } = useAccountSSFilter(localFixedAssetAccountSSOpts, ownerFilter);

  const accountUsage = useAccountUsage();
  const displayTransferOptions = useMemo(() => {
    const source = (transferFiltered?.length ? transferFiltered : localTransferAccountSSOpts) ?? [];
    const filtered = source.filter((option) => !option.isHeader);
    let merged = mergeSmartSelectOptions(filtered, transferAccountList);
    const selectedIds = new Set([fromAccountId, toAccountId].filter(Boolean));
    const selectedOptions = merged.filter((option) => selectedIds.has(option.id));
    if (transferVisibleOptionIds) {
      merged = merged.filter((option) => transferVisibleOptionIds.has(option.id));
    }
    // Stock-to-cash transfer: the source account cannot be the securities cash account itself; keep only cash accounts of the same owner.
    if (stockTransferMode && stockCashAccountId) {
      merged = merged.filter((option) => option.id !== stockCashAccountId);
    }
    for (const option of selectedOptions) {
      if (!merged.some((item) => item.id === option.id)) merged.push(option);
    }
    return sortByAccountUsage(merged, accountUsage);
  }, [accountUsage, fromAccountId, localTransferAccountSSOpts, stockCashAccountId, stockTransferMode, toAccountId, transferAccountList, transferFiltered, transferVisibleOptionIds]);

  // Stock-to-cash transfer target: securities cash account of the current stock institution + cash accounts of the same owner.
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
    return sortByAccountUsage(merged, accountUsage);
  }, [accountUsage, localTransferAccountSSOpts, stockCashAccountId, transferAccountList, transferFiltered, transferVisibleOptionIds]);

  const displayAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(accountSSOptionsFiltered, accountList);
    if (accountVisibleOptionIds) {
      base = base.filter((option) => accountVisibleOptionIds.has(option.id));
    }
    // 贷款 / 基金资金 / 股票资金 / 基金持仓是硬排除，不受「账户下拉限制类型」开关影响。
    // 存款账户（2026-09-18 用户口径）：也放行——分类在提交时校验白名单（利息收入/
    // 利息支出、手续费）。
    const filtered = base.filter((option) => option.isHeader || option.isGroup || isIncomeExpensePostingOrDepositAccount(option));
    return sortByAccountUsage(filtered, accountUsage);
  }, [accountSSOptionsFiltered, accountList, accountUsage, accountVisibleOptionIds, accountId]);
  // 代付资金侧硬排除贷款/往来款，不受「账户下拉限制类型」开关影响。
  const advanceCashAccountOptions = useMemo(
    () => displayAccountOptions.filter((option) => option.isHeader || option.isGroup || isAdvanceFundingAccount(option)),
    [displayAccountOptions],
  );
  const advanceAccountOptions = useMemo(() => {
    if (txType !== "advance" || !counterpartyInstitutionId) return [];
    const seen = new Set<string>();
    const options: AccountOption[] = [];
    for (const option of [...displayAccountOptions, ...accountList]) {
      if (option.isHeader || option.isGroup) continue;
      // 口径（2026-09-13）：代付的账户侧只能是往来款账户——挂往来对象的 kind=loan
      // 账户是贷款窗口建的贷款账户，不进代付账户下拉（服务端同样只认 settlement）。
      if (option.kind !== "settlement") continue;
      // SS hierarchy options are plain SmartSelectOption rows without counterpartyId.
      const counterpartyId = (option as Partial<AccountOption>).counterpartyId ?? "";
      if (counterpartyId !== counterpartyInstitutionId) continue;
      if (seen.has(option.id)) continue;
      seen.add(option.id);
      options.push(option);
    }
    return options;
  }, [txType, counterpartyInstitutionId, displayAccountOptions, accountList]);
  const advanceAccountPlaceholder = useMemo(() => {
    if (!counterpartyInstitutionId || advanceAccountOptions.some((option) => option.id === advanceAccountId)) {
      return t("txForm.selectPlaceholder");
    }
    const objectName = (localNestedFieldData ?? nestedFieldData)?.counterpartyId
      ?.find((item) => item.id === counterpartyInstitutionId)?.name ?? "";
    return objectName ? t("txForm.advanceAccountAutoCreate", { name: objectName }) : t("liabilityTx.placeholder.autoReuseOrCreate");
  }, [advanceAccountId, advanceAccountOptions, counterpartyInstitutionId, localNestedFieldData, nestedFieldData, t]);
  // Auto-default to the counterparty's first existing settlement account;
  // empty selection means "resolve or create on save". A pinned account (edit
  // prefill or explicit user pick) is authoritative and is kept even while the
  // options are still loading, so the record's own account is never silently
  // swapped for the counterparty's first one.
  useEffect(() => {
    if (!open || txType !== "advance") return;
    setAdvanceAccountId((current) => {
      if (current && advanceAccountPinnedRef.current) return current;
      if (current && advanceAccountOptions.some((option) => option.id === current)) return current;
      return advanceAccountOptions[0]?.id ?? "";
    });
  }, [open, txType, advanceAccountOptions]);
  // Advance-edit self-heal: some legacy advance rows store a dangling
  // counterparty ref from old/external data (e.g. `counterparty_<32hex>`) that
  // no longer matches any Counterparty row. The counterparty dropdown only
  // lists current Counterparty rows, so such a ref leaves both the counterparty
  // and settlement account fields empty when editing. The settlement account's
  // own counterpartyId binding is the source of truth for which counterparty
  // the row belongs to, so re-derive from it (also normalizes legacy prefixed
  // refs when the bare id still exists); saving then writes the canonical id
  // back server-side and the row self-heals.
  useEffect(() => {
    if (!open || txType !== "advance" || !counterpartyInstitutionId) return;
    const counterpartyOptions = (localNestedFieldData ?? nestedFieldData)?.counterpartyId ?? [];
    const bareId = counterpartyInstitutionId.replace(/^(?:counterparty|institution)[_:]/, "");
    const match = counterpartyOptions.find(
      (item) => isSettlementCounterpartyType(item.type) && (item.id === counterpartyInstitutionId || item.id === bareId),
    );
    if (match) {
      if (match.id !== counterpartyInstitutionId) setCounterpartyInstitutionId(match.id);
      return;
    }
    const settlementOption = accountList.find(
      (option) => option.id === advanceAccountId && !option.isHeader && !option.isGroup,
    );
    const derivedId = (settlementOption?.counterpartyId ?? "").trim();
    if (derivedId) setCounterpartyInstitutionId(derivedId);
  }, [open, txType, counterpartyInstitutionId, advanceAccountId, accountList, localNestedFieldData, nestedFieldData]);
  const displayFixedAssetAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(fixedAssetFiltered, fixedAssetAccountList);
    const selected = fixedAssetAccountList.find((option) => option.id === fixedAssetAccountId);
    if (fixedAssetVisibleOptionIds) {
      base = base.filter((option) => fixedAssetVisibleOptionIds.has(option.id));
    }
    if (selected && !base.some((option) => option.id === selected.id)) base.push(selected);
    return sortByAccountUsage(base, accountUsage);
  }, [accountUsage, fixedAssetAccountId, fixedAssetAccountList, fixedAssetFiltered, fixedAssetVisibleOptionIds]);
  const fixedAssetSelectableOptions = useMemo(
    () => displayFixedAssetAccountOptions.filter((option) => !option.isHeader && !option.isGroup),
    [displayFixedAssetAccountOptions],
  );
  const incomeExpenseInstitutionOptions = useMemo(
    () => filterIncomeExpenseInstitutions(localNestedFieldData?.institutionId ?? nestedFieldData?.institutionId ?? []),
    [localNestedFieldData, nestedFieldData],
  );
  /**
   * 弹窗内所有下拉共用的行为配置。**不要在这里设 `density: "compact"`**：
   * compact 会把触发框压成 `h-8 / px-2 / text-xs / 圆角 8`，而同一行的日期、金额是
   * `form-input` 的 `h-9 / px-3 / text-sm / 圆角 10`，两者并排时下拉矮 4px、文字小一号；
   * 切换子标签（支出/收入/转账/预支）后同一位置换成另一种控件，字段会上下错位、宽度观感也不同。
   * 故统一走默认尺寸，与 `form-input` 逐项对齐；只有弹层高度仍单独限制。
   */
  const accountSelectBehavior = useMemo(() => ({
    dropdownMaxHeight: 320,
  }), []);
  const fixedAssetAccountSelectBehavior = useMemo(() => ({
    ...accountSelectBehavior,
    autoOpen: fixedAssetAccountAutoOpen,
    onDropdownClose: () => setFixedAssetAccountAutoOpen(false),
  }), [accountSelectBehavior, fixedAssetAccountAutoOpen]);

  useEffect(() => {
    if (!open || txType !== "expense" || !fixedAssetLinked) return;
    if (fixedAssetAccountId) return;
    if (fixedAssetSelectableOptions.length !== 1) return;
    const [onlyOption] = fixedAssetSelectableOptions;
    setFixedAssetAccountId(onlyOption.id);
    setFixedAssetAssetId("");
    setFixedAssetAccountAutoOpen(false);
  }, [fixedAssetAccountId, fixedAssetLinked, fixedAssetSelectableOptions, open, txType]);

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
    [...transferAccountList, ...accountList, ...fixedAssetAccountList].forEach(add);
    (localTransferAccountSSOpts ?? []).forEach(add);
    (localAccountSSOpts ?? []).forEach(add);
    (localFixedAssetAccountSSOpts ?? []).forEach(add);
    return map;
  }, [accountList, fixedAssetAccountList, localAccountSSOpts, localFixedAssetAccountSSOpts, localTransferAccountSSOpts, transferAccountList]);
  const selectedAccountIsCreditCard = accountMetaById.get(accountId)?.kind === "bank_credit"
    || (isCreditCardAccount && accountId === (defaultAccountId ?? accountId));
  // 只有信用卡消费允许选择交易币种：现金、借记卡、电子钱包等账户一律跟随账户币种。
  const selectedAccountKind = accountMetaById.get(accountId)?.kind ?? null;
  const canChooseTxCurrency = txType === "expense"
    && (selectedAccountKind ? selectedAccountKind === "bank_credit" : selectedAccountIsCreditCard);
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
  const fxFromAccountOptions = useMemo(
    () => displayTransferOptions.filter((option) => {
      const account = option as AccountOption;
      if (account.kind !== "bank_debit") return false;
      // 卖出外汇：换出侧必须是外币账户；购入时换出侧不限币种（默认人民币账户）。
      return fxDirection === "sell" ? isForeignCurrency(account.currency) : true;
    }),
    [displayTransferOptions, fxDirection],
  );
  const fxToAccountOptions = useMemo(
    () => displayTransferOptions.filter((option) => {
      const account = option as AccountOption;
      const currencyOk = fxDirection === "sell"
        ? !isForeignCurrency(account.currency)
        : isForeignCurrency(account.currency);
      return account.id !== fromAccountId
        && account.kind !== "bank_credit"
        && account.kind !== "loan"
        && currencyOk;
    }),
    [displayTransferOptions, fromAccountId, fxDirection],
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
  // 记账账户币种就是支出弹窗里的"本币"：交易货币留空表示跟随账户币种，
  // 只有用户显式选了别的币种才算外币支出。
  const txAccountCurrency = normalizeCurrencyLabel(accountMetaById.get(accountId)?.currency) || "CNY";
  const effectiveTxCurrency = txCurrency ? normalizeCurrencyLabel(txCurrency) : txAccountCurrency;
  const txPostingIsForeign = txType === "expense" && effectiveTxCurrency !== txAccountCurrency;
  // Income has no editable "transaction currency": it always follows the posting account
  // (deposit interest follows the selected certificate) and the server stores the same
  // value. The dialog used to hide the currency and store null, so the detail table showed
  // income on foreign-currency accounts as CNY (user report 2026-10-18).
  const incomeLotCurrency = depositLotId
    ? depositLotOptions.find((lot) => lot.id === depositLotId)?.currency ?? null
    : null;
  const incomeCurrency = txType === "income"
    ? normalizeCurrencyLabel(incomeLotCurrency ?? accountMetaById.get(accountId)?.currency)
    : effectiveTxCurrency;
  // 旧模型记录（currency 即外币、没有 originalCurrency）编辑时保持原语义，
  // 不强行升级成"本币入账 + 原币事实"。
  const showPostedAmount = txPostingIsForeign && fxPostingV2;

  async function loadTxFxRate(refresh: boolean): Promise<number | null> {
    try {
      const params = new URLSearchParams({ from: effectiveTxCurrency, to: txAccountCurrency });
      if (refresh) params.set("refresh", "1");
      const res = await fetch(`/api/v1/fx-rates?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !Array.isArray(data.rates)) return null;
      const rateRow = data.rates.find((rate: { fromCurrency?: string; toCurrency?: string }) =>
        normalizeCurrencyLabel(rate.fromCurrency) === effectiveTxCurrency
        && normalizeCurrencyLabel(rate.toCurrency) === txAccountCurrency);
      const rate = Number(rateRow?.rate);
      return Number.isFinite(rate) && rate > 0 ? rate : null;
    } catch {
      return null;
    }
  }

  // 「换算」：先取缓存汇率，取不到再强制刷新一次，然后按最新汇率折算入账金额。
  // 折算结果仍可手工改，也允许填 0。
  async function convertPostedAmount() {
    if (convertingPostedAmount || !txPostingIsForeign) return;
    setConvertingPostedAmount(true);
    try {
      const rate = (await loadTxFxRate(false)) ?? (await loadTxFxRate(true));
      if (!rate) {
        window.alert(t("txForm.alert.fxRateUnavailable"));
        return;
      }
      const originalValue = parseMoneyDraft(amount);
      const converted = formatFxAmount(Math.abs(originalValue) * rate);
      setLocalAmount(originalValue < 0 && converted ? `-${converted}` : converted);
    } finally {
      setConvertingPostedAmount(false);
    }
  }

  async function fetchFxRateForForm() {    if (fetchingFxRate) return;
    if (!fxFromCurrency || !fxToCurrency || fxFromCurrency === fxToCurrency) {
      window.alert(t("txForm.alert.selectDifferentCurrencies"));
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
        throw new Error(data?.error || t("txForm.alert.fxFetchFailed"));
      }
      const rateRow = data.rates.find((rate: { fromCurrency?: string; toCurrency?: string }) =>
        normalizeCurrencyLabel(rate.fromCurrency) === fxFromCurrency &&
        normalizeCurrencyLabel(rate.toCurrency) === fxToCurrency
      );
      const rate = Number(rateRow?.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(t("txForm.alert.fxRateUnavailable"));
      }
      const formattedRate = formatFxRate(rate);
      setFxRate(formattedRate);
      const fromValue = parseMoneyDraft(amount);
      if (fromValue > 0) setFxToAmount(formatFxAmount(fromValue * rate));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("txForm.alert.fxFetchFailedManual"));
    } finally {
      setFetchingFxRate(false);
    }
  }
  const fxCommonQuoteText = useMemo(() => {
    if (fxFromCurrency === fxToCurrency) return t("txForm.alert.sameCurrency");
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(fxToAmount);
    if (fromValue <= 0 || toValue <= 0) return "";
    const quoteBase = 100;
    const quoteAmount = (fromValue / toValue) * quoteBase;
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return "";
    return t("txForm.fxCommonQuote", { base: quoteBase, to: fxToCurrency, amount: formatFxQuoteAmount(quoteAmount, language), from: fxFromCurrency });
  }, [amount, fxFromCurrency, language, fxToAmount, fxToCurrency, t]);
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
    const liabilityMode = inferLiabilityTransferMode(sourceAccount, targetAccount);
    const operation = liabilityMode ? "liability" : getCashTargetOperation(targetAccount);
    if (operation === "transfer") return false;

    // 「资金账户 ↔ 贷款账户」直接保存为普通转账，不再跳负债专用窗口
    // （2026-10-13 用户口径：允许资金账户向贷款账户输出资金）。
    // 服务端此时已放行这一对：按 liabilityDirection 与现金流记为 repay_out / lend_out /
    // borrow_in / collect_in（source=liability_*），贷款余额同步减少。
    // 例外：① 两侧都是贷款/往来款时服务端仍拒，这里先拦，别让用户白跑一趟；
    //       ② 编辑已有的负债记录仍跳专用窗口——利息/手续费拆分只有负债窗口能填。
    if (liabilityMode && !editEntryId) {
      if (
        isLoanOrSettlementAccountKind((sourceAccount as AccountOption | undefined)?.kind) &&
        isLoanOrSettlementAccountKind((targetAccount as AccountOption | undefined)?.kind)
      ) {
        window.alert(t("sidebar.action.settlementTransferNotAllowed"));
        return true;
      }
      return false;
    }

    // Settlement accounts are identified by the account kind, not by the entry
    // dialog. A transfer into/out of a settlement account is saved directly and
    // the server records it as a liability entry (borrow/lend/repay/collect) based on
    // the account's liabilityDirection and the cash flow.
    if (operation === "liability" && !liabilityMode) return false;

    if (editEntryId) {
      // Allow edits in place when the account pair is unchanged: scheduled
      // deposit/bond interest transfers use dedicated accounts, but their
      // amount/date/note can be corrected. Dedicated-window rules still block
      // account-pair changes and new records; liability pairs keep their own window.
      if (
        !liabilityMode &&
        editOriginalTransferAccounts &&
        fromAccountId === editOriginalTransferAccounts.fromAccountId &&
        toAccountId === editOriginalTransferAccounts.toAccountId
      ) {
        return false;
      }
      if (operation === "liability" && liabilityMode && editEntryOriginalType !== "transfer") {
        return false;
      }
      if (operation === "liability" && liabilityMode) {
        const isLiabilitySourceFlow = liabilityMode === "borrow_in" || liabilityMode === "collect_in";
        const cashAccountId = isLiabilitySourceFlow ? toAccountId : fromAccountId;
        const liabilityAccountId = isLiabilitySourceFlow ? fromAccountId : toAccountId;
        if (!cashAccountId) {
          window.alert(isLiabilitySourceFlow ? t("txForm.alert.selectCashInAccount") : t("txForm.alert.selectCashSourceAccount"));
          return true;
        }
        const amountNumber = Number(amount);
        if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
          window.alert(t("txForm.alert.invalidAmount"));
          return true;
        }

        window.dispatchEvent(new CustomEvent(liabilityDialogEventName(sourceAccount, targetAccount), {
          detail: {
            requestId: requestId ?? makeRequestId(operation),
            editEntryId,
            mode: liabilityMode,
            defaultLiabilityAccountId: liabilityAccountId,
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
      window.alert(t("txForm.alert.specialTargetAccount"));
      return true;
    }
    const isLiabilitySourceFlow = liabilityMode === "borrow_in" || liabilityMode === "collect_in";
    const cashAccountId = isLiabilitySourceFlow ? toAccountId : fromAccountId;
    const liabilityAccountId = isLiabilitySourceFlow ? fromAccountId : toAccountId;
    if (!cashAccountId) {
      window.alert(isLiabilitySourceFlow ? t("txForm.alert.selectCashInAccount") : t("txForm.alert.selectCashSourceAccount"));
      return true;
    }
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      window.alert(t("txForm.alert.invalidAmount"));
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
      const targetProductType = targetAccount?.investProductType;
      const productType = targetProductType === "metal" || targetProductType === "money"
        ? targetProductType
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
    } else if (operation === "liability") {
      window.dispatchEvent(new CustomEvent(liabilityDialogEventName(sourceAccount, targetAccount), {
        detail: {
          requestId: nextRequestId,
          mode: liabilityMode ?? (targetAccount?.liabilityDirection === "receivable" ? "lend_out" : "repay_out"),
          defaultLiabilityAccountId: liabilityAccountId,
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
    setFxDirection("buy");
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
    setEditCategoryFallback(null);
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setFixedAssetLinkLocked(false);
    setFixedAssetAccountNestedOpen(false);
    setFixedAssetAccountAutoOpen(false);
    setTxCurrency("");
    setCounterpartyInstitutionId("");
    setAdvanceAccountId("");
    advanceAccountPinnedRef.current = false;
    setLocationId("");
    setDepositLotId("");
    setDepositLotOptions([]);
    setLocalAmount("");
    setFxPostingV2(true);
    setNote("");
    setSelectedTagIds([]);
    setPendingAttachmentFiles([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    setFromAccountIdEdited(false);
    editOriginalRef.current = null;
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  /**
   * 保存并再记一笔：记账类型、账户、分类、日期、备注、标签保留（同一天连记多笔是常态，日期不动）；
   * 金额以及由金额派生出的分期/汇率/本币金额清空 —— 表单必须看得出已经换了一笔。
   * 同时清掉本笔的会话态（requestId、编辑标识、已上传附件）。
   */
  function repeatDraft() {
    setAmount("");
    setFxToAmount("");
    setFxRate("");
    setFxFeeAmount("");
    setLocalAmount("");
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setPendingAttachmentFiles([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    editOriginalRef.current = null;
    editNoteScopeRef.current = "";
    if ((txType === "transfer" || txType === "fx") && !isCreditCardAccount && !fromAccountId && defaultAccountId) {
      setFromAccountId(defaultAccountId);
    }
    focusAmountInput();
  }

  function focusAmountInput() {
    if (txType === "fx" || txType === "investment") return;
    requestAnimationFrame(() => {
      amountInputRef.current?.focus();
    });
  }

  function swapTransferAccounts() {
    const prevFrom = fromAccountId;
    const prevTo = toAccountId;
    setFromAccountId(prevTo);
    setToAccountId(prevFrom);
  }

  function switchType(nextType: TxType) {
    if (lockedType && nextType !== lockedType) return;
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
      setEditCategoryFallback(null);
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
    if (nextType !== "expense") {
      // 交易币种只属于信用卡消费；切到其它类型时清空，避免残留外币语义。
      setTxCurrency("");
      setLocalAmount("");
      setFixedAssetLinked(false);
      setFixedAssetAccountId("");
      setFixedAssetAssetId("");
      setFixedAssetLinkLocked(false);
      setFixedAssetAccountNestedOpen(false);
      setFixedAssetAccountAutoOpen(false);
    }
  }

  function handleCategoryChange(nextCategoryId: string) {
    setCategoryId(nextCategoryId);
    if (txType !== "expense") return;
    const selected = categoryList.find((category) => category.id === nextCategoryId);
    if (!isFixedAssetExpenseCategoryPath(selected?.label)) return;
    setFixedAssetLinked(true);
    setFixedAssetAccountNestedOpen(true);
    setFixedAssetAccountAutoOpen(false);
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
      const effectiveType = detail.lockedType ?? mappedType;
      const effectiveFxDirection: FxDirection = detail.fxDirection === "sell" ? "sell" : "buy";

      setRequestId(detail.requestId);
      setOpen(true);
      setLockedType(detail.lockedType ?? null);
      setStockTransferMode(detail.stockTransferMode === true);
      setStockCashAccountId(detail.stockCashAccountId ?? "");
      const forcedFixedAssetAccountId = detail.fixedAssetAccountId?.trim() ?? "";
      const fixedAssetRequired = effectiveType === "expense" && (
        detail.fixedAssetRequired === true
        || detail.lockFixedAsset === true
        || Boolean(forcedFixedAssetAccountId)
      );
      setFixedAssetLinked(fixedAssetRequired);
      setFixedAssetAccountId(forcedFixedAssetAccountId);
      setFixedAssetAssetId(detail.fixedAssetAssetId?.trim() ?? "");
      setFixedAssetLinkLocked(effectiveType === "expense" && detail.lockFixedAsset === true);
      setFixedAssetAccountNestedOpen(false);
      setFixedAssetAccountAutoOpen(fixedAssetRequired && !forcedFixedAssetAccountId);
      setTxCurrency("");
      setTxType(effectiveType);
      setFxDirection(effectiveFxDirection);

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

      if (effectiveType === "transfer" || effectiveType === "fx") {
        let nextFromAccountId = findAccountIdByLabel(item.fromAccount, transferAccounts) || detail.defaultFromAccountId || detail.defaultAccountId || (defaultAccountId ?? "");
        const rawNextToAccountId = findAccountIdByLabel(item.toAccount ?? item.account, transferAccounts) || detail.defaultToAccountId || "";
        const rawNextToAccount = transferAccounts.find((account) => account.id === rawNextToAccountId);
        const fromAccountForFx = transferAccounts.find((account) => account.id === nextFromAccountId);
        // 预填账户必须符合当前换汇方向：卖出时换出侧须为外币账户，购入时换入侧须为外币账户。
        if (effectiveType === "fx" && effectiveFxDirection === "sell" && fromAccountForFx && !isForeignCurrency(fromAccountForFx.currency)) {
          nextFromAccountId = "";
        }
        const nextToAccountId = effectiveType === "fx" && rawNextToAccount && (
          effectiveFxDirection === "sell"
            ? isForeignCurrency(rawNextToAccount.currency)
            : !isForeignCurrency(rawNextToAccount.currency)
        )
          ? ""
          : rawNextToAccountId;
        // Stock-to-cash transfer: the target account is fixed to the securities cash account of the current stock institution.
        const effectiveToAccountId = detail.stockTransferMode
          ? (detail.stockCashAccountId || nextToAccountId)
          : nextToAccountId;
        const effectiveFromAccountId = detail.stockTransferMode && effectiveToAccountId === nextFromAccountId
          ? ""
          : nextFromAccountId;
        setFromAccountId(effectiveFromAccountId);
        setToAccountId(effectiveToAccountId);
        if (effectiveType === "fx") {
          const fromCurrency = transferAccounts.find((account) => account.id === effectiveFromAccountId)?.currency;
          const toCurrency = transferAccounts.find((account) => account.id === effectiveToAccountId)?.currency;
          if (effectiveFxDirection === "sell") {
            setFxFromCurrencyDraft(effectiveFromAccountId ? normalizeCurrencyLabel(fromCurrency) : "USD");
            setFxToCurrencyDraft(BASE_CASH_CURRENCY);
          } else {
            setFxFromCurrencyDraft(normalizeCurrencyLabel(fromCurrency));
            setFxToCurrencyDraft(toCurrency ? normalizeCurrencyLabel(toCurrency) : "USD");
          }
        }
        setCategoryId("");
        setAccountId("");
      } else {
        setAccountId(findAccountIdByLabel(item.account, accounts) || (defaultAccountId ?? ""));

        const rawCat = (item.category ?? "").trim();
        const withTypePrefix = rawCat ? `支出.${rawCat}` : "";
        const nextCatId = fixedAssetRequired
          ? findCategoryIdByLabel(FIXED_ASSET_EXPENSE_CATEGORY_NAME, expenseCategories)
            || findCategoryIdByLabel(withTypePrefix, expenseCategories)
            || findCategoryIdByLabel(rawCat, expenseCategories)
          : findCategoryIdByLabel(withTypePrefix, expenseCategories)
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
    const url = new URL(window.location.href);
    if (url.searchParams.get("quickEntry") !== "1") return;
    const key = url.searchParams.toString();
    if (quickEntryConsumedRef.current === key) return;
    quickEntryConsumedRef.current = key;
    window.dispatchEvent(
      new CustomEvent("mmh:create-transaction:open", {
        detail: {
          requestId: `url-${Date.now()}`,
          source: "launcher",
          item: { type: "expense" },
          defaultAccountId: defaultAccountId ?? "",
        },
      }),
    );
    url.searchParams.delete("quickEntry");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [defaultAccountId]);

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
        /** "toNote" 表示当前在转账的对方（转入）账户里编辑，备注只写第二备注。 */
        noteTarget?: "" | "toNote";
        accountId?: string;
        accountLabel?: string;
        categoryId?: string;
        depositSourceEntryId?: string | null;
        counterpartyInstitutionId?: string;
        advanceAccountId?: string;
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
        categoryName?: string;
        fixedAssetAccountId?: string;
        fixedAssetAssetId?: string;
        fixedAssetLinked?: boolean;
        currency?: string | null;
        locationId?: string;
        locationName?: string;
        originalCurrency?: string | null;
        originalAmount?: number | null;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setEditEntryOriginalType(detail.type);
      setEditEntryHasFundDetail(detail.hasFundDetail ?? false);
      editNoteScopeRef.current = detail.type === "transfer" && detail.noteTarget === "toNote" ? "toNote" : "";
      editOriginalRef.current = {
        type: detail.type,
        amountStored: Number(detail.amount),
        date: detail.date || today,
        accountId: detail.accountId ?? undefined,
        fromAccountId: detail.fromAccountId ?? undefined,
        toAccountId: detail.toAccountId ?? undefined,
      };
      setCreateInstallment(false);
      setFixedAssetLinked(detail.fixedAssetLinked === true || Boolean(detail.fixedAssetAccountId));
      setFixedAssetAccountId(detail.fixedAssetAccountId?.trim() ?? "");
      setFixedAssetAssetId(detail.fixedAssetAssetId?.trim() ?? "");
      setFixedAssetLinkLocked(false);
      setFixedAssetAccountNestedOpen(false);
      setFixedAssetAccountAutoOpen(false);
      // Foreign-currency expense: the transaction currency differs from the
      // posting account's own currency (e.g. JPY spend on a CNY credit card),
      // or the row carries settlement facts (originalCurrency) under the
      // local-posting model.
      const editRecordCurrency = normalizeCurrencyLabel(detail.currency);
      const editAccountId = detail.type === "transfer" ? "" : (detail.accountId ?? defaultAccountId ?? "");
      const editAccountCurrency = normalizeCurrencyLabel(accountMetaById.get(editAccountId)?.currency);
      const editOriginalCurrency = normalizeCurrencyLabel(detail.originalCurrency);
      const editForeignTxn = detail.type === "expense" && (
        (Boolean(editOriginalCurrency) && editOriginalCurrency !== editAccountCurrency)
        || (Boolean(detail.currency) && editRecordCurrency !== editAccountCurrency)
      );
      setTxCurrency(editForeignTxn ? (editOriginalCurrency || editRecordCurrency) : "");
      setFxPostingV2(editForeignTxn && Boolean(editOriginalCurrency));
      setLocationId(detail.locationId?.trim() ?? "");
      setOpen(true);
      setTxType(detail.type);
      setDate(detail.date || today);
      setPostedAt(toDateInputValue(detail.postedAt || detail.date || today));
      setPostedAtEdited(Boolean(detail.postedAt));
      const numericAmount = Number(detail.amount);
      const originalNumeric = Number(detail.originalAmount);
      const dialogAmount = Number.isFinite(numericAmount) ? storedAmountToDialogAmount(detail.type, numericAmount) : 0;
      if (editForeignTxn && editOriginalCurrency) {
        // New-model row: dialog shows the original settlement amount; the posted
        // local amount goes into the dedicated local-amount field.
        const originalNumericAbs = Number.isFinite(originalNumeric) && originalNumeric !== 0 ? Math.abs(originalNumeric) : 0;
        setAmount(originalNumericAbs !== 0 ? String(originalNumericAbs) : "");
        setLocalAmount(numericAmount !== 0 ? String(Math.abs(numericAmount)) : "");
      } else {
        setAmount(
          dialogAmount !== 0
            ? String(dialogAmount)
            : "",
        );
        setLocalAmount("");
      }
      setNote(detail.note ?? "");
      setCounterpartyInstitutionId(detail.counterpartyInstitutionId ?? "");
      setAdvanceAccountId(detail.advanceAccountId ?? "");
      advanceAccountPinnedRef.current = Boolean(detail.advanceAccountId);
      setEditCategoryFallback(detail.categoryId && detail.categoryName
        ? { id: detail.categoryId, label: detail.categoryName, parentId: null, type: detail.type === "income" ? "income" : "expense" }
        : null);
      const detailTags = normalizeEditTagOptions(detail.tags);
      const nextTagIds = detail.tagIds?.length ? detail.tagIds : detailTags.map((tag) => tag.id);
      setTagList((prev) => {
        const knownIds = new Set([...prev.map((tag) => tag.id), ...detailTags.map((tag) => tag.id)]);
        const missingSelectedTags = nextTagIds
          .filter((id) => !knownIds.has(id))
          .map((id) => ({ id, name: t("txForm.unknownTag"), color: null }));
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
        // 存款利息收入等「收入/支出落账账户不在下拉候选内」的记录（如定期存款账户），
        // 必须靠载荷里的账户名兜底补一个选项，否则编辑弹窗会带不出账户、显示为空。
        // 两个字段都要看：明细面板发 accountName，其它入口可能发 accountLabel。
        // 注意用 || 而不是 ??：明细面板会给 accountLabel 传空串 ""，?? 不会跳过空串。
        const accountLabelFallback = (detail.accountLabel || detail.accountName || "").trim();
        setLocalAccountSSOpts((prev) => {
          const extra = accountList.find((opt) => opt.id === nextAccountId);
          if (extra) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [extra]);
          }
          if (nextAccountId && accountLabelFallback) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [{ id: nextAccountId, label: accountLabelFallback }]);
          }
          return prev ?? accountSSOptions;
        });
        setAccountId(nextAccountId);
        setCategoryId(detail.categoryId ?? "");
        setDepositLotId(detail.depositSourceEntryId ?? "");
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
    accountMetaById,
    accountSSOptions,
    defaultAccountId,
    today,
    transferAccountList,
    transferAccountSSOptions,
    t,
  ]);

  useEffect(() => {
    if (!open || (txType !== "expense" && txType !== "income" && txType !== "transfer") || postedAtEdited) return;
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
        const fromCurrencyLabel = normalizeCurrencyLabel(conversion.fromCurrency);
        const toCurrencyLabel = normalizeCurrencyLabel(conversion.toCurrency);
        // 方向以换入侧币种为准：外币 -> CNY 视为卖出，其余（CNY->外币、外币->外币）沿用购入表单。
        setFxDirection(toCurrencyLabel === BASE_CASH_CURRENCY ? "sell" : "buy");
        setFxFromCurrencyDraft(fromCurrencyLabel);
        setFxToCurrencyDraft(toCurrencyLabel);
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
    if (!open || txType === "fx" || txType === "investment") return;
    focusAmountInput();
  }, [open, txType]);

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
        : compactIds([accountId, toAccountId, defaultAccountId, fixedAssetLinked ? fixedAssetAccountId : ""]);

    // A save only skips the heavy refresh when editing an existing record and
    // every balance-affecting field (type, amount, date, accounts) is unchanged.
    const original = editOriginalRef.current;
    const currentStoredAmount = dialogAmountToStoredAmount(txType, amount);
    const balanceChanged = !editEntryId || !original
      ? true
      : !(
          original.type === txType &&
          Math.abs(original.amountStored - currentStoredAmount) < 0.005 &&
          original.date === date &&
          (txType === "transfer" || txType === "fx"
            ? original.fromAccountId === fromAccountId && original.toAccountId === toAccountId
            : original.accountId === accountId && original.toAccountId === toAccountId)
        );

    return {
      reason: "transaction-save",
      accountIds: accountIds.length > 0 ? accountIds : undefined,
      entryIds: editEntryId ? [editEntryId] : undefined,
      balanceChanged,
    };
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    if (openSpecialTransferTargetIfNeeded()) return;

    if (editEntryId && editEntryOriginalType === "investment" && txType !== "investment" && editEntryHasFundDetail) {
      const confirmed = await showConfirmDialog({
        title: t("txForm.fundDetailTitle"),
        message: t("txForm.fundDetailMessage"),
      });
      if (!confirmed) {
        const formData = new FormData(e.currentTarget);
        formData.set("type", txType);
        formData.set("date", date);
        if (txType === "expense" || txType === "income" || txType === "transfer") formData.set("postedAt", postedAt);
        formData.set("amount", String(dialogAmountToStoredAmount(txType, amount)));
        // 默认一个备注：note 与 toNote 同值。
        // 例外——在转账的对方账户里编辑时，备注只写第二备注，第一备注由服务端保留原值。
        const toNoteOnly = txType === "transfer" && editNoteScopeRef.current === "toNote";
        formData.set("noteScope", toNoteOnly ? "toNote" : "");
        formData.set("note", toNoteOnly ? "" : note);
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

    const shouldLinkFixedAsset = txType === "expense" && (fixedAssetLinked || Boolean(fixedAssetAccountId));
    if (shouldLinkFixedAsset && !fixedAssetAccountId) {
      window.alert(t("txForm.alert.selectFixedAssetAccount"));
      return;
    }

    // Required account validation: transfers need both a source and a
    // destination account; income/expense/advance need a posting account.
    if (txType === "transfer") {
      if (!fromAccountId) {
        window.alert(t("txForm.alert.selectTransferFromAccount"));
        return;
      }
      if (!toAccountId) {
        window.alert(t("txForm.alert.selectTransferToAccount"));
        return;
      }
    } else if ((txType === "income" || txType === "expense" || txType === "advance") && !accountId) {
      window.alert(t("txForm.alert.selectAccount"));
      return;
    }

    // 转入外币到本币资金账户（2026-10-18 用户裁定）：币种不一致且转入账户是资金类
    // 账户时，先问一句「是否为它创建一个对应币种的子账户」。确认后建好子账户并把
    // 这笔转账落到子账户上，标准转账就变成同币种转账。
    // 转入账户本身已是多币种子账户时不能再往下分层（用户 2026-10-18 口径）：这里
    // 不自动建兄弟子户，直接拦下让用户自己改选账户。
    let transferToAccountId = toAccountId;
    if (txType === "transfer" && fromAccountId && toAccountId) {
      const fromMeta = accountMetaById.get(fromAccountId);
      const toMeta = accountMetaById.get(toAccountId);
      const fromCurrency = normalizeCurrencyLabel(fromMeta?.currency);
      const toCurrency = normalizeCurrencyLabel(toMeta?.currency);
      const toKind = String(toMeta?.kind ?? "");
      const toIsCashLike = toKind === "cash" || toKind === "bank_debit" || toKind === "ewallet";
      const isChildTarget = !!String(toMeta?.accountParentId ?? "");
      if (fromMeta && toMeta && fromCurrency !== toCurrency && toIsCashLike) {
        if (isChildTarget) {
          // 子账户不能再分子账户：请用户改选同币种账户，或改选一个独立账户
          // （非子账户），由系统为它创建同币种子账户。
          window.alert(t("txForm.alert.currencyChildPickSameCurrencyAccount", {
            fromCurrency,
            toCurrency,
            name: toMeta.label || "",
          }));
          return;
        }
        const confirmed = await showConfirmDialog({
          title: t("txForm.currencyChildTitle"),
          message: t("txForm.currencyChildMessage", {
            fromCurrency,
            toCurrency,
            name: toMeta.label || "",
          }),
        });
        if (!confirmed) return;
        try {
          const response = await fetch(`/api/v1/accounts/${encodeURIComponent(toAccountId)}/currency-child`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currency: fromCurrency }),
          });
          const payload = await response.json().catch(() => null) as
            | { ok?: boolean; upgraded?: boolean; accountId?: string; accountName?: string; parentId?: string; error?: string }
            | null;
          const childId = String(payload?.accountId ?? "");
          if (!response.ok || !payload?.ok || !childId) {
            window.alert(payload?.error || t("txForm.currencyChildFailed"));
            return;
          }
          transferToAccountId = childId;
          setToAccountId(childId);
          const childName = String(payload?.accountName ?? "");
          // 子户始终挂在某个多币种父账户下：把父 id 带回候选列表，下次转入才能
          // 认出「这是子账户」而不是再问一遍「是否创建子账户」。
          const childParentId = String(payload?.parentId ?? "") || String(toMeta.accountParentId ?? "");
          if (payload?.upgraded && childParentId) {
            // 刚才那个账户已被原地升级成默认币种子户（id 不变），本地候选也要记住
            // 它的父账户，否则下一次转入还会按「独立账户」提问。
            setTransferAccountList((prev) => prev.map((item) => (
              item.id === toAccountId ? { ...item, accountParentId: childParentId } : item
            )));
          }
          setTransferAccountList((prev) => (
            prev.some((item) => item.id === childId)
              ? prev
              : [...prev, {
                  ...toMeta,
                  id: childId,
                  label: childName || toMeta.label,
                  currency: fromCurrency,
                  accountParentId: childParentId || null,
                  isAggregate: false,
                }]
          ));
        } catch (error) {
          window.alert(String(error));
          return;
        }
      }
    }

    // 存款账户落账的分类白名单（2026-09-18）：收入只允许利息收入类，
    // 支出只允许利息支出/手续费类。其余分类请挂在普通资金账户上。
    if ((txType === "income" || txType === "expense") && accountId) {
      const selected = accountList.find((option) => option.id === accountId);
      const selectedCategory = categoryList.find((category) => category.id === categoryId);
      const selectedCategoryName = getCategoryLeafName(selectedCategory?.label ?? "");
      if (isDepositAccount(selected ?? null) && !isDepositPostingCategoryAllowed(selectedCategoryName, txType)) {
        window.alert(t("txForm.alert.depositCategoryRestricted"));
        return;
      }
      if (txType === "income" && isDepositAccount(selected ?? null) && !depositLotId) {
        window.alert(depositLotsLoading ? t("txForm.alert.loadingDepositLot") : t("txForm.alert.selectDepositLot"));
        return;
      }
    }

    if (txType === "fx") {
      const fromValue = parseMoneyDraft(amount);
      const toValue = parseMoneyDraft(fxToAmount);
      const feeValue = String(fxFeeAmount ?? "").trim() ? parseMoneyDraft(fxFeeAmount) : null;
      if (!fromAccountId) {
        window.alert(t("txForm.alert.selectFromAccount"));
        return;
      }
      if (accountMetaById.get(fromAccountId)?.kind !== "bank_debit") {
        window.alert(t("txForm.alert.fromAccountDebitOnly"));
        return;
      }
      if (fxDirection === "sell" && !isForeignCurrency(accountMetaById.get(fromAccountId)?.currency)) {
        window.alert(t("txForm.alert.sellFromAccountForeignOnly"));
        return;
      }
      if (toAccountId && fromAccountId === toAccountId) {
        window.alert(t("txForm.alert.accountsSame"));
        return;
      }
      if (fxDirection === "buy") {
        if (toAccountId && !isForeignCurrency(accountMetaById.get(toAccountId)?.currency)) {
          window.alert(t("txForm.alert.toAccountForeignOnly"));
          return;
        }
        if (!toAccountId && !isForeignCurrency(fxToCurrencyDraft)) {
          window.alert(t("txForm.alert.toCurrencyForeignOnly"));
          return;
        }
      } else {
        if (toAccountId && isForeignCurrency(accountMetaById.get(toAccountId)?.currency)) {
          window.alert(t("txForm.alert.sellToAccountBaseOnly"));
          return;
        }
      }
      if (fxFromCurrency === fxToCurrency) {
        window.alert(t("txForm.alert.sameCurrencyUseTransfer"));
        return;
      }
      if (fromValue <= 0 || toValue <= 0) {
        window.alert(t("txForm.alert.amountsPositive"));
        return;
      }
      if (feeValue != null && feeValue <= 0) {
        window.alert(t("txForm.alert.feePositiveOrEmpty"));
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
          window.alert(data?.error ?? t("txForm.alert.fxSaveFailed"));
          return;
        }
        const fxEntryId = editEntryId || data?.entries?.fromEntry?.id || data?.conversion?.fromEntryId || null;
        if (fxEntryId && pendingAttachmentFiles.length > 0) {
          try {
            await uploadEntryAttachmentFiles(fxEntryId, pendingAttachmentFiles);
            setPendingAttachmentFiles([]);
          } catch (attachmentError) {
            window.alert(t("attachments.saveAfterCreateFailed", {
              reason: attachmentError instanceof Error ? attachmentError.message : t("attachments.uploadFailed"),
            }));
          }
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
        const msg = err instanceof Error ? err.message : t("txForm.alert.fxSaveFailed");
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
      if (txType === "expense" || txType === "income" || txType === "transfer") formData.set("postedAt", postedAt);
      formData.set("amount", String(dialogAmountToStoredAmount(txType, amount)));
      // 默认一个备注：note 与 toNote 同值。
      // 例外——在转账的对方账户里编辑时，备注只写第二备注，第一备注由服务端保留原值。
      const toNoteOnly = txType === "transfer" && editNoteScopeRef.current === "toNote";
      formData.set("noteScope", toNoteOnly ? "toNote" : "");
      formData.set("note", toNoteOnly ? "" : note);
      formData.set("toNote", txType === "transfer" ? note : "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
      if (txType === "transfer") {
        formData.set("fromAccountId", fromAccountId);
        // 外币转账可能刚自动建了币种子账户，落账要用子账户 id。
        formData.set("toAccountId", transferToAccountId);
        if (showDepositLotSelect) formData.set("depositSourceEntryId", depositLotId);
        } else if (txType === "income") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          formData.set("depositSourceEntryId", depositLotId);
          if (toAccountId) formData.set("toAccountId", toAccountId);
        } else if (txType === "advance") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
          formData.set("advanceAccountId", advanceAccountId);
        } else {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          const normalizedTxCurrency = normalizeOptionalCurrency(effectiveTxCurrency);
          if (txPostingIsForeign && normalizedTxCurrency) {
            if (fxPostingV2) {
              // New posting model: amount = bank-posted local amount; the
              // original settlement currency/amount ride along as facts. A zero
              // posted amount is allowed (bank has not posted / manual entry).
              const localValue = parseMoneyDraft(localAmount);
              const originalValue = parseMoneyDraft(amount);
              if (!(originalValue > 0)) {
                window.alert(t("txForm.alert.amountsPositive"));
                return;
              }
              formData.set("amount", String(-localValue));
              formData.set("currency", "");
              formData.set("originalCurrency", normalizedTxCurrency);
              formData.set("originalAmount", String(-originalValue));
            } else {
              // Legacy model (unmigrated rows): amount stays in the chosen currency.
              formData.set("currency", normalizedTxCurrency);
            }
          } else {
            // Explicitly reset to the posting account's currency on edit;
            // the server treats an empty value as "use account currency".
            formData.set("currency", "");
          }
          if (shouldLinkFixedAsset) {
            formData.set("fixedAssetAccountId", fixedAssetAccountId);
            if (fixedAssetAssetId) formData.set("fixedAssetAssetId", fixedAssetAssetId);
          }
          formData.set("locationId", locationId);
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
      const attachmentEntryId = editEntryId || res.data?.id || res.data?.cashEntryId || null;
      if (attachmentEntryId && pendingAttachmentFiles.length > 0) {
        try {
          await uploadEntryAttachmentFiles(attachmentEntryId, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        } catch (attachmentError) {
          window.alert(t("attachments.saveAfterCreateFailed", {
            reason: attachmentError instanceof Error ? attachmentError.message : t("attachments.uploadFailed"),
          }));
        }
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
      const msg = err instanceof Error ? err.message : t("txForm.alert.saveFailed");
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
            { key: "transaction", label: t("txForm.record") },
            {
              key: "fx",
              label: t("entry.kind.fxGroup"),
              children: [
                { key: "fx", label: t("entry.kind.fx") },
                { key: "fx-sell", label: t("entry.kind.fxSell") },
              ],
            },
            { key: "investment", label: t("txForm.fundMetal"), disabled: !showInvestment },
            { key: "wealth", label: t("investment.product.wealth") },
            { key: "bond", label: t("entry.kind.bond") },
            { key: "deposit-buy", label: t("txForm.depositIn") },
            { key: "insurance", label: t("account.kind.insurance") },
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
        <ModalLayer className="app-modal-backdrop">
          <div
            ref={panelRef}
            className={`app-modal-panel mobile-transaction-modal max-w-xl ${fixedHeightProps.className ?? ""}`.trim()}
            style={fixedHeightProps.style}
          >
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">
                {txType === "fx"
                  ? (fxDirection === "sell" ? t("txForm.fxSellTitle") : t("txForm.fxBuyTitle"))
                  : editEntryId ? t("txForm.editEntry") : t("txForm.addEntry")}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  resetDraft();
                }}
                className="secondary-button h-8 px-2"
              >
                {t("table.close")}
              </button>
            </div>

            {reconciledReadOnly ? (
              <div className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
                <Lock className="h-3.5 w-3.5 shrink-0" />
                <span>{t("reconcile.readOnlyNotice")}</span>
              </div>
            ) : null}

            <fieldset disabled={reconciledReadOnly} className="contents">
            <form
              ref={formRef}
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={onSubmit}
            >
            {/* 字段区（滚动）：窗口高度锁定后，短页签的余量留在**这里**，
                由下面的固定页脚兜住窗口底边，不会出现「保存按钮下面一片空白」。 */}
            <div ref={scrollRef} className="tx-entry-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {txType !== "fx" && lockedType ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    className="segment-button h-9 flex-1 segment-button-active"
                  >
                    {lockedType === "transfer" ? t("transaction.type.transfer") : lockedType === "income" ? t("transaction.type.income") : lockedType === "advance" ? t("txForm.advance") : t("transaction.type.expense")}
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
                      {t("transaction.type.expense")}
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
                      {t("transaction.type.income")}
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
                      {t("txForm.advance")}
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
                      {t("transaction.type.transfer")}
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
                      {t("transaction.type.expense")}
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
                      {t("transaction.type.income")}
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
                      {t("txForm.advance")}
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
                      {t("transaction.type.transfer")}
                    </button>
                  </>
                )}
              </div>
              ) : null}

              {txType === "investment" && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-medium text-slate-500 mb-1">{t("txForm.chooseInvestmentType")}</div>
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
                    {t("txForm.fund")}
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
                    {t("investment.product.metal")}
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
                    {t("investment.product.wealth")}
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
                    {t("txForm.deposit")}
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
                    {t("account.kind.insurance")}
                  </button>
                </div>
              )}

              {(txType === "expense" || txType === "income" || txType === "advance") && (
                <div className="space-y-3">
                  {txType === "advance" ? (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.date")}</div>
                          <DateStepper name="date" value={date} onChange={setDate} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("txForm.cashAccount")}</div>
                          <div className={REQUIRED_FIELD_CLASS}>
                            <SmartSelect mode="single" value={accountId}
                              onChange={(id: string) => { setAccountId(id); recordRecentAccount(id); }}
                              options={advanceCashAccountOptions} placeholder={t("txForm.selectPlaceholder")}
                              onCreateClick={() => { void openAccountCreate("account"); }}
                              onCycleOwnerFilter={cycleOwnerFilter}
                              ownerFilterLabel={ownerFilterLabel}
                              behavior={accountSelectBehavior} />
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("txForm.counterparty")}</div>
                          <SmartSelect
                            mode="single"
                            value={counterpartyInstitutionId}
                            onChange={(id: string) => { advanceAccountPinnedRef.current = false; setCounterpartyInstitutionId(id); setAdvanceAccountId(""); }}
                            options={((localNestedFieldData ?? nestedFieldData)?.counterpartyId ?? [])
                              .filter((item) => isSettlementCounterpartyType(item.type))
                              .map((item) => ({ id: item.id, label: item.name }))}
                            placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => setCounterpartyNestedOpen(true)}
                            createLabel={t("txForm.addCounterparty")}
                            searchable
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("txForm.advanceAccount")}</div>
                          <SmartSelect
                            mode="single"
                            value={advanceAccountId}
                            onChange={(id: string) => { advanceAccountPinnedRef.current = Boolean(id); setAdvanceAccountId(id); }}
                            options={advanceAccountOptions.map((option) => ({ id: option.id, label: option.label, subLabel: option.subLabel }))}
                            placeholder={advanceAccountPlaceholder}
                            onCreateClick={() => { void openAccountCreate("advance"); }}
                            createLabel={t("txForm.addAdvanceAccount")}
                            behavior={{ ...accountSelectBehavior, clearable: true }}
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.date")}</div>
                          <DateStepper name="date" value={date} onChange={setDate} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">
                            {isCreditCardAccount ? t("txForm.recordAccount") : (txType === "income" ? t("txForm.receiveAccount") : t("txForm.cashAccount"))}
                          </div>
                          <div className={REQUIRED_FIELD_CLASS}>
                            <SmartSelect mode="single" value={accountId}
                              onChange={(id: string) => {
                                setAccountId(id);
                                recordRecentAccount(id);
                                // 换账户后交易币种跟随新账户，避免把信用卡外币选值带到现金/借记卡上。
                                setTxCurrency("");
                                setLocalAmount("");
                              }}
                              options={displayAccountOptions} placeholder={t("txForm.selectPlaceholder")}
                              onCreateClick={() => { void openAccountCreate("account"); }}
                              onCycleOwnerFilter={cycleOwnerFilter}
                              ownerFilterLabel={ownerFilterLabel}
                              behavior={accountSelectBehavior} />
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.postedAt")}</div>
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
                          <div className="form-label">{t("detail.column.counterparty")}</div>
                          <SmartSelect
                            mode="single"
                            value={counterpartyInstitutionId}
                            onChange={setCounterpartyInstitutionId}
                            options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                            placeholder={t("stockFee.optional")}
                            createLabel={t("txForm.addCounterparty")}
                            searchable
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div className={(txType === "expense" ? "grid grid-cols-3" : "grid grid-cols-2") + " gap-3"}>
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.category")}</div>
                      <SmartSelect mode="single" value={categoryId} onChange={handleCategoryChange}
                        options={categorySSOptions} placeholder={t("txForm.uncategorized")}
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
                          expandedGroupColumns: 4,
                        }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.tags")}</div>
                      <SmartSelect mode="multi" value={selectedTagIds}
                        onChange={(ids) => setSelectedTagIds(ids)}
                        options={tagSelectOptions} placeholder={t("txForm.selectTags")}
                        onInlineCreate={createTagInline}
                        onCreated={handleTagCreated}
                      />
                    </div>
                    {txType === "expense" ? (
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.location")}</div>
                        <SmartSelect
                          mode="single"
                          value={locationId}
                          onChange={setLocationId}
                          options={((localNestedFieldData ?? nestedFieldData)?.merchantId ?? [])
                            .map((item) => ({ id: item.id, label: item.name }))}
                          placeholder={t("stockFee.optional")}
                          searchable
                          onCreateClick={() => setLocationNestedOpen(true)}
                          createLabel={t("txForm.addMerchant")}
                        />
                      </div>
                    ) : null}
                  </div>

                  {showDepositLotSelect ? (
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.depositLot")}</div>
                      <div className={REQUIRED_FIELD_CLASS}>
                        <SmartSelect
                          mode="single"
                          value={depositLotId}
                          onChange={setDepositLotId}
                          options={depositLotOptions.map((lot) => ({
                            id: lot.id,
                            // 老存单 fundName 为 null，真实名称在 DepositProduct.name（接口以 productName 返回）。
                            // 只回退 fundName 会显示成「未命名存款」（2026-10-01 实测：编辑利息收入时关联存单下拉显示占位名）。
                            label: (lot.fundName ?? "").trim() || (lot.productName ?? "").trim() || t("sidebar.deposit.unnamed"),
                            subLabel: [
                              lot.startDate ?? "",
                              lot.maturityDate ?? "",
                              lot.remainingAmount.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                            ].filter(Boolean).join(" · "),
                          }))}
                          placeholder={depositLotsLoading ? t("common.loading") : t("txForm.selectPlaceholder")}
                          behavior={{ ...accountSelectBehavior, clearable: false }}
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className={txType === "expense"
                    ? showPostedAmount
                      ? "grid grid-cols-[4.5rem_5.33rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3"
                      : "grid grid-cols-[4.5rem_5.33rem_minmax(0,1fr)] items-end gap-3"
                    : txType === "income"
                      ? "grid grid-cols-[5.33rem_minmax(0,1fr)] items-end gap-3"
                      : "space-y-1"}>
                    {txType === "expense" ? (
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.fixedAssetToggle")}</div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={fixedAssetLinked}
                          aria-disabled={fixedAssetLinkLocked}
                          aria-label={t("txForm.fixedAssetToggle")}
                          onClick={() => {
                            if (fixedAssetLinkLocked) return;
                            setFixedAssetLinked((current) => {
                              const next = !current;
                              if (next) {
                                setFixedAssetAccountAutoOpen(true);
                              } else {
                                setFixedAssetAccountId("");
                                setFixedAssetAccountAutoOpen(false);
                              }
                              return next;
                            });
                          }}
                          className={[
                            "flex h-9 w-12 items-center justify-center rounded-[10px] border px-2 text-xs font-medium transition",
                            fixedAssetLinkLocked ? "cursor-not-allowed opacity-80" : "",
                            fixedAssetLinked
                              ? "border-blue-300 bg-blue-50 text-blue-700"
                              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                          ].join(" ")}
                        >
                          <span
                            className={[
                              "relative h-4 w-7 shrink-0 rounded-full transition",
                              fixedAssetLinked ? "bg-blue-600" : "bg-slate-300",
                            ].join(" ")}
                          >
                            <span
                              className={[
                                "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition",
                                fixedAssetLinked ? "left-3.5" : "left-0.5",
                              ].join(" ")}
                            />
                          </span>
                        </button>
                      </div>
                    ) : null}
                    {txType === "expense" ? (
                      <div className="min-w-0 space-y-1">
                        <div className="form-label">{t("txForm.txnCurrency")}</div>
                        {canChooseTxCurrency ? (
                          <CurrencySmartSelect
                            value={effectiveTxCurrency}
                            onChange={(code) => { setTxCurrency(code); setFxPostingV2(true); }}
                            onSubmitted={(code) => { setTxCurrency(code); setFxPostingV2(true); }}
                            labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                            placeholder={t("txForm.txnCurrency")}
                            density="regular"
                          />
                        ) : (
                          <div className="flex h-9 items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-600">
                            {effectiveTxCurrency}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {txType === "income" ? (
                      <div className="min-w-0 space-y-1">
                        <div className="form-label">{t("txForm.txnCurrency")}</div>
                        <div className="flex h-9 items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-600">
                          {incomeCurrency}
                        </div>
                      </div>
                    ) : null}
                    <div className="min-w-0 space-y-1">
                      <div className="form-label">{t("txForm.amount")}</div>
                      <CalcInput ref={amountInputRef} value={amount} onChange={(value) => {
                        setAmount(value);
                        if (createInstallment && !installmentAmountEdited) {
                          const numeric = Math.abs(Number(value));
                          setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                        }
                      }} placeholder={txType === "expense" ? t("txForm.amountPlaceholderExpense") : t("txForm.amountPlaceholderIncome")} label={t("txForm.amount")} precision={2} />
                    </div>
                    {showPostedAmount ? (
                      <>
                        <div className="min-w-0 space-y-1">
                          <div className="form-label">{t("txForm.localAmount")}</div>
                          <CalcInput
                            value={localAmount}
                            onChange={setLocalAmount}
                            placeholder={t("txForm.localAmountPlaceholder")}
                            label={t("txForm.localAmount")}
                            precision={2}
                          />
                        </div>
                        <div className="space-y-1">
                          <button
                            type="button"
                            onClick={() => { void convertPostedAmount(); }}
                            disabled={convertingPostedAmount}
                            title={t("txForm.convertAmount")}
                            aria-label={t("txForm.convertAmount")}
                            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${convertingPostedAmount ? "animate-spin" : ""}`} />
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>

                  {txType === "expense" && fixedAssetLinked ? (
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fixedAssetAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={fixedAssetAccountId}
                        onChange={(id: string) => {
                          setFixedAssetAccountId(id);
                          setFixedAssetAssetId("");
                          recordRecentAccount(id);
                        }}
                        options={displayFixedAssetAccountOptions}
                        placeholder={t("txForm.selectFixedAssetAccount")}
                        onCreateClick={() => setFixedAssetAccountNestedOpen(true)}
                        createLabel={t("txForm.createFixedAssetAccount")}
                        onCycleOwnerFilter={cycleOwnerFilter}
                        ownerFilterLabel={ownerFilterLabel}
                        behavior={fixedAssetAccountSelectBehavior}
                      />
                    </div>
                  ) : null}

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
                        {t("txForm.installment")}
                      </label>
                      {createInstallment ? (
                        <>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <div className="form-label">{t("txForm.installmentAmount")}</div>
                              <CalcInput value={installmentAmount} onChange={(value) => {
                                setInstallmentAmount(value);
                                setInstallmentAmountEdited(true);
                              }} placeholder={t("txForm.installmentAmountPlaceholder")} label={t("txForm.installmentAmount")} precision={2} />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">{t("txForm.periods")}</div>
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
                              <div className="form-label">{installmentRateType === "annual_interest" ? t("txForm.annualRatePercent") : t("txForm.periodRatePercent")}</div>
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
                                {t("txForm.periodFee")}
                              </button>
                              <button type="button" onClick={() => setInstallmentRateType("annual_interest")}
                                className={`border-l border-slate-200 px-3 text-xs ${installmentRateType === "annual_interest" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                {t("txForm.annualRate")}
                              </button>
                            </div>
                            {installmentPreview ? (
                              <div className="text-xs tabular-nums text-slate-500">
                                {t("txForm.installmentSummary", { first: installmentPreview.summary.firstPayment.toFixed(2), interest: installmentPreview.summary.totalInterest.toFixed(2), total: installmentPreview.summary.totalPayment.toFixed(2) })}
                              </div>
                            ) : null}
                          </div>
                          {installmentPreview ? (
                            <div className="max-h-48 overflow-auto rounded-md border border-slate-200">
                              <table className="min-w-full text-xs tabular-nums">
                                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                                  <tr>
                                    <th className="px-2 py-1 text-left font-medium">{t("txForm.periods")}</th>
                                    <th className="px-2 py-1 text-left font-medium">{t("detail.column.date")}</th>
                                    <th className="px-2 py-1 text-right font-medium">{t("txForm.principal")}</th>
                                    <th className="px-2 py-1 text-right font-medium">{installmentRateType === "annual_interest" ? t("txForm.interest") : t("txForm.fee")}</th>
                                    <th className="px-2 py-1 text-right font-medium">{t("txForm.dueAmount")}</th>
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

                  {/* Row 5: note + attachment */}
                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.remark")}</div>
                    <div className="flex items-start gap-2">
                      <ClearableNoteField
                        wrapperClassName="flex-1"
                        name="note"
                        placeholder={t("stockFee.optional")}
                        value={note}
                        onValueChange={setNote}
                        className="form-input"
                      />
                      <EntryAttachmentButton
                        entryId={editEntryId}
                        pendingFiles={pendingAttachmentFiles}
                        onPendingFilesChange={setPendingAttachmentFiles}
                      />
                    </div>
                  </div>
                </div>
              )}

              {txType === "fx" && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.date")}</div>
                    <DateStepper name="date" value={date} onChange={setDate} />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxFromAccount")}</div>
                      <SmartSelect mode="single" value={fromAccountId} onChange={(v) => {
                        setFromAccountId(v);
                        const currency = normalizeCurrencyLabel(accountMetaById.get(v)?.currency);
                        if (currency) setFxFromCurrencyDraft(currency);
                        if (v && v === toAccountId) setToAccountId("");
                        recordRecentAccount(v);
                      }}
                        options={fxFromAccountOptions}
                        placeholder={fxDirection === "sell" ? t("txForm.fxSellFromAccountPlaceholder") : t("txForm.fxFromAccountPlaceholder")}
                        onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("txForm.addDebitAccount")}
                        onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                        behavior={accountSelectBehavior} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxToAccount")}</div>
                      <SmartSelect mode="single" value={toAccountId} onChange={(v) => {
                        setToAccountId(v);
                        const currency = normalizeCurrencyLabel(accountMetaById.get(v)?.currency);
                        if (currency) setFxToCurrencyDraft(currency);
                        recordRecentAccount(v);
                      }}
                        options={fxToAccountOptions}
                        placeholder={fxDirection === "sell"
                          ? t("txForm.fxSellToAccountPlaceholder")
                          : t("txForm.fxToAccountPlaceholder", { currency: fxToCurrencyDraft })}
                        onCreateClick={() => { void openAccountCreate("to"); }} createLabel={t("settings.accounts.add")}
                        onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                        behavior={accountSelectBehavior} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxFromCurrency")}</div>
                      {fromAccountId || fxDirection === "buy" ? (
                        <div className="form-input flex h-9 items-center bg-slate-50 text-slate-700">
                          {fromAccountId ? fxFromCurrency : t("txForm.fxCurrencyAuto")}
                        </div>
                      ) : (
                        <CurrencySmartSelect
                          value={fxFromCurrencyDraft}
                          onChange={setFxFromCurrencyDraft}
                          labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                          excludeCodes={[BASE_CASH_CURRENCY]}
                          showRequestButton={false}
                          density="regular"
                        />
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxToCurrency")}</div>
                      {toAccountId || fxDirection === "sell" ? (
                        <div className="form-input flex h-9 items-center bg-slate-50 text-slate-700">
                          {fxToCurrency}
                        </div>
                      ) : (
                        <CurrencySmartSelect
                          value={fxToCurrencyDraft}
                          onChange={setFxToCurrencyDraft}
                          labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                          excludeCodes={[BASE_CASH_CURRENCY]}
                          showRequestButton={false}
                          density="regular"
                        />
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxFromAmountLabel", { currency: fxFromCurrency })}</div>
                      <CalcInput value={amount} onChange={updateFxFromAmount} placeholder={t("txForm.exampleAmount")} label={t("txForm.fxFromAmount")} precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxRateLabel")}</div>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <CalcInput value={fxRate} onChange={updateFxRate} placeholder={t("txForm.fxRatePlaceholder", { from: fxFromCurrency, to: fxToCurrency })} label={t("txForm.fxRate")} precision={8} />
                        </div>
                        <button
                          type="button"
                          onClick={() => void fetchFxRateForForm()}
                          disabled={fetchingFxRate || fxFromCurrency === fxToCurrency}
                          className="secondary-button h-9 shrink-0 gap-1 px-2 text-[11px] disabled:opacity-50"
                          title={t("txForm.fxFetchTitle")}
                        >
                          <RefreshCw className={`h-3 w-3 ${fetchingFxRate ? "animate-spin" : ""}`} />
                          {fetchingFxRate ? t("txForm.fxFetching") : t("txForm.fxFetch")}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fee")}</div>
                      <CalcInput value={fxFeeAmount} onChange={setFxFeeAmount} placeholder={t("txForm.fxFeePlaceholder")} label={t("txForm.fee")} precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxToAmountLabel", { currency: fxToCurrency })}</div>
                      <CalcInput value={fxToAmount} onChange={updateFxToAmount} placeholder={t("txForm.exampleAmount")} label={t("txForm.fxToAmount")} precision={2} />
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {fxCommonQuoteText || t("txForm.fxQuoteHint")}
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.remark")}</div>
                    <div className="flex items-start gap-2">
                      <ClearableNoteField
                        wrapperClassName="flex-1"
                        name="note"
                        placeholder={fxDirection === "sell" ? t("txForm.fxSellNotePlaceholder") : t("txForm.fxNotePlaceholder")}
                        value={note}
                        onValueChange={setNote}
                        className="form-input"
                      />
                      <EntryAttachmentButton
                        entryId={editEntryId}
                        pendingFiles={pendingAttachmentFiles}
                        onPendingFilesChange={setPendingAttachmentFiles}
                      />
                    </div>
                  </div>
                </div>
              )}

              {txType === "transfer" && (
                <div className="space-y-3">
                  {/* Row 1: date | income/expense institution */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.date")}</div>
                      <DateStepper name="date" value={date} onChange={setDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.counterparty")}</div>
                      <SmartSelect
                        mode="single"
                        value={counterpartyInstitutionId}
                        onChange={setCounterpartyInstitutionId}
                        options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                        placeholder={t("stockFee.optional")}
                        onCreateClick={() => setInstitutionNestedOpen(true)}
                        createLabel={t("txForm.addInstitution")}
                        searchable
                      />
                    </div>
                  </div>

                  {/* Row 2: from account | swap | to account */}
                  {stockTransferMode ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferFrom")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                            behavior={accountSelectBehavior} />
                        </div>
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title={t("txForm.swapAccounts")}><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferTo")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                            options={stockTransferToOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                            behavior={accountSelectBehavior} />
                        </div>
                      </div>
                    </div>
                  ) : isCreditCardAccount ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferFrom")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                            behavior={accountSelectBehavior} />
                        </div>
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title={t("txForm.swapAccounts")}><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferTo")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("to"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                            behavior={accountSelectBehavior} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferFrom")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={fromAccountId} onChange={(v) => { setFromAccountId(v); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                            behavior={accountSelectBehavior} />
                        </div>
                      </div>
                      <div className="flex items-center justify-center pb-0.5">
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title={t("txForm.swapAccountsTitle")}><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferTo")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("to"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleOwnerFilter} ownerFilterLabel={ownerFilterLabel}
                            behavior={accountSelectBehavior} />
                        </div>
                      </div>
                    </div>
                  )}

                  {showDepositLotSelect ? (
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.depositLot")}</div>
                      <div className={REQUIRED_FIELD_CLASS}>
                        <SmartSelect
                          mode="single"
                          value={depositLotId}
                          onChange={setDepositLotId}
                          options={depositLotOptions.map((lot) => ({
                            id: lot.id,
                            label: (lot.fundName ?? "").trim() || (lot.productName ?? "").trim() || t("sidebar.deposit.unnamed"),
                            subLabel: [lot.startDate ?? "", lot.maturityDate ?? "", lot.remainingAmount.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 })].filter(Boolean).join(" · "),
                          }))}
                          placeholder={depositLotsLoading ? t("common.loading") : t("txForm.selectPlaceholder")}
                          behavior={{ ...accountSelectBehavior, clearable: false }}
                        />
                      </div>
                    </div>
                  ) : null}

                  {/* Row 3: posted date | tags */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.postedAt")}</div>
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
                      <div className="form-label">{t("detail.column.tags")}</div>
                      <SmartSelect mode="multi" value={selectedTagIds}
                        onChange={(ids) => setSelectedTagIds(ids)}
                        options={tagSelectOptions} placeholder={t("txForm.selectTags")}
                        onInlineCreate={createTagInline}
                        onCreated={handleTagCreated}
                      />
                    </div>
                  </div>

                  {/* Row 4: amount（独占一行，排备注上方） */}
                  <div className="space-y-1">
                    <div className="form-label">{t("txForm.amount")}</div>
                    <CalcInput ref={amountInputRef} value={amount} onChange={setAmount} placeholder={t("txForm.amountExample")} label={t("txForm.amount")} precision={2} />
                  </div>

                  {/* Row 5: note + attachment */}
                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.remark")}</div>
                    <div className="flex items-start gap-2">
                      <ClearableNoteField
                        wrapperClassName="flex-1"
                        name="note"
                        placeholder={t("stockFee.optional")}
                        value={note}
                        onValueChange={setNote}
                        className="form-input"
                      />
                      <EntryAttachmentButton
                        entryId={editEntryId}
                        pendingFiles={pendingAttachmentFiles}
                        onPendingFilesChange={setPendingAttachmentFiles}
                      />
                    </div>
                  </div>
                </div>
              )}

              <input type="hidden" name="type" value={txType} />
            </div>

            {/* 固定页脚：贴着窗口底边，切页签/内容长短变化时按钮位置不动 */}
            <div className="tx-entry-footer flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-white px-4 py-3">
                {!editEntryId ? (
                  <button
                    type="button"
                    className="secondary-button h-9 px-3 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                    onClick={() => {
                      submitModeRef.current = "repeat";
                      formRef.current?.requestSubmit();
                    }}
                    disabled={submitting}
                  >
                    {submitting ? t("txForm.saving") : t("txForm.saveAndRepeat")}
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="primary-button h-9 px-3"
                  onClick={() => { submitModeRef.current = "close"; }}
                  disabled={submitting}
                >
                  {submitting ? t("txForm.saving") : editEntryId ? t("txForm.saveChanges") : t("common.save")}
                </button>
              </div>
            </form>
            </fieldset>
          </div>
        </ModalLayer>
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
        title={accountCreateTarget === "advance" ? t("txForm.addAdvanceAccount") : undefined}
        allowedAccountKinds={accountCreateTarget === "advance" ? ["settlement"] : undefined}
        extraFields={accountCreateTarget === "advance" ? { counterpartyId: counterpartyInstitutionId } : undefined}
        hiddenFields={accountCreateTarget === "advance" ? ["counterpartyId"] : undefined}
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
          if (accountCreateTarget === "advance") {
            // 下拉里新建的往来款账户：选项必须带 counterpartyId 才会进「往来款账户」候选
            setAccountList(prev => [...prev, { ...option, counterpartyId: extra?.counterpartyId ?? counterpartyInstitutionId }]);
            setAdvanceAccountId(id);
          } else if (accountCreateTarget === "from") setFromAccountId(id);
          else if (accountCreateTarget === "to") setToAccountId(id);
          else setAccountId(id);
          setAccountNestedOpen(false);
          setAccountCreateTarget("account");
        }}
        nestedFieldData={localNestedFieldData ?? nestedFieldData}
      />,
      document.body,
    )}
    {open && fixedAssetAccountNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="account"
        open={fixedAssetAccountNestedOpen}
        onClose={() => setFixedAssetAccountNestedOpen(false)}
        title={t("txForm.createFixedAssetAccount")}
        nameLabel={t("txForm.fixedAssetAccountName")}
        namePlaceholder={t("txForm.fixedAssetAccountPlaceholder")}
        defaultType="investment"
        extraFields={{ kind: "investment", investProductType: "property" }}
        hiddenFields={["kind", "investProductType", "institutionId", "fundUnitsDecimals", "tradingCalendar", "costBasisMethod"]}
        onCreated={(id, name, extra) => {
          const kind = "investment";
          const groupId = extra?.groupId?.trim();
          const groupName = extra?.groupName?.trim();
          // 显示口径与既有账户下拉一致：所有人 · 投资（不再单独显示「固定资产账户」）。
          const kindText = t("account.kind.investment");
          const option = {
            id,
            label: name,
            subLabel: [groupName, kindText].filter(Boolean).join(" · "),
            // 悬浮只补行里看不到的：所有人/类型都在 subLabel 里，传进去让它自我去重。
            title: formatAccountHoverTitle({
              groupName: groupName ?? "",
              label: name,
              subLabel: [groupName, kindText].filter(Boolean).join(" · "),
            }),
            kind,
            investProductType: "property",
            currency: extra?.currency,
          };
          setFixedAssetAccountList((prev) => [...prev, option]);
          setLocalFixedAssetAccountSSOpts((prev) => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          setFixedAssetLinked(true);
          setFixedAssetAccountId(id);
          setFixedAssetAccountNestedOpen(false);
          setFixedAssetAccountAutoOpen(false);
        }}
        nestedFieldData={localNestedFieldData ?? nestedFieldData}
      />,
      document.body,
    )}
    {open && locationNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="counterparty"
        open={locationNestedOpen}
        onClose={() => setLocationNestedOpen(false)}
        title={t("txForm.addMerchant")}
        defaultType="merchant"
        allowedCounterpartyTypes={["merchant"]}
        hiddenFields={["type"]}
        existingNames={((localNestedFieldData ?? nestedFieldData)?.merchantId ?? []).map((item) => item.name)}
        onCreated={(id, name, extra) => {
          setLocalNestedFieldData((prev) => ({
            ...(prev ?? nestedFieldData ?? {}),
            merchantId: [...((prev ?? nestedFieldData)?.merchantId ?? []), { id, name, type: extra?.type ?? "merchant" }],
          }));
          setLocationId(id);
          setLocationNestedOpen(false);
        }}
      />,
      document.body,
    )}
    {open && counterpartyNestedOpen && createPortal(
      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="counterparty"
        open={counterpartyNestedOpen}
        onClose={() => setCounterpartyNestedOpen(false)}
        defaultType="person"
        allowedCounterpartyTypes={["person", "organization"]}
        existingNames={(localNestedFieldData?.counterpartyId ?? nestedFieldData?.counterpartyId ?? []).map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "person" };
          setLocalNestedFieldData((prev) => ({
            ...(prev ?? nestedFieldData ?? {}),
            counterpartyId: [...((prev ?? nestedFieldData)?.counterpartyId ?? []), next],
          }));
          advanceAccountPinnedRef.current = false;
          setAdvanceAccountId("");
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
        title={t("txForm.addInstitution")}
        nameLabel={t("txForm.institutionName")}
        namePlaceholder={t("txForm.institutionNamePlaceholder")}
        allowedInstitutionTypes={["bank", "payment"]}
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
