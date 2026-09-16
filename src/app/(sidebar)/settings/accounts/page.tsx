"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote, X } from "lucide-react";
import { TransparentSideNavButtons } from "@/components/TransparentSideNavButtons";
import type { AccountKind } from "@prisma/client";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { institutionTypeLabel, isSettlementCounterpartyType, kindIconName, kindColor, kindOrder } from "@/lib/account-kinds";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { FundConfirmDaysPanel } from "@/components/FundConfirmDaysModal";
import { MultiSelectFilterDropdown } from "@/components/MultiSelectFilterDropdown";
import { SmartSelect } from "@/components/SmartSelect";
import {
  AccountScopeFilter,
  CASH_INSTITUTION_ID,
  type AccountScopeValue,
  type StatisticsAccountItem,
  type StatisticsInstitutionItem,
  type StatisticsUserItem,
} from "@/components/AccountScopeFilter";
import { AccountBatchImportButton } from "@/components/settings/AccountBatchImportButton";
import { CreditCardBillingDayRulesTable } from "@/components/CreditCardBillingDayRulesTable";
import { currentBillingDayFromRules, type CreditBillingDayRuleView } from "@/lib/credit/billing-day-rules";
import { CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS } from "@/lib/credit/rules";
import { SettingsActionButton, SettingsPageHeader, SettingsPrimaryAddButton } from "@/components/settings/SettingsPageScaffold";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { getAccountLabelFieldsPreference, getCreditCardLabelTemplatePreference } from "@/lib/client/appPreferences";
import { fetchSettingsAccountData, getCachedSettingsAccountData, notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { getInvestmentAccountView, isDepositAccount } from "@/lib/account-kind-utils";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { supportsTradingCalendarForAccount, TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { useI18n } from "@/lib/i18n";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { CURRENCY_OPTIONS, normalizeCurrency } from "@/lib/currency";
import {
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  allowedInstitutionTypesForAccount,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";
import { isCreditCardMonthEndBillingDay } from "@/lib/credit/rules";

/* ---- Render icon from kindIconName ---- */
function kindIcon(k: string) {
  const map: Record<string, React.ReactNode> = {
    "credit-card": <CreditCard className="w-3.5 h-3.5" />,
    "landmark": <Landmark className="w-3.5 h-3.5" />,
    "wallet": <Wallet className="w-3.5 h-3.5" />,
    "banknote": <Banknote className="w-3.5 h-3.5" />,
    "piggy-bank": <PiggyBank className="w-3.5 h-3.5" />,
    "building-2": <Building2 className="w-3.5 h-3.5" />,
  };
  return map[kindIconName(k)] || <Building2 className="w-3.5 h-3.5" />;
}

type Group = { id: string; name: string; sortOrder: number };
type Institution = { id: string; name: string; shortName?: string | null; type?: string };
type Counterparty = { id: string; name: string; shortName?: string | null; type?: string | null };
type Account = {
  id: string; name: string; kind: AccountKind; currency: string; isActive: boolean;
  note: string | null;
  isPlaceholder?: boolean;
  institutionId: string | null; groupId: string | null;
  Institution: { id: string; name: string; shortName?: string | null } | null;
  AccountGroup: { id: string; name: string } | null;
  Counterparty: { id: string; name: string; shortName?: string | null } | null;
  counterpartyId?: string | null;
  billingDay: number | null; repaymentDay: number | null; repaymentOffsetDays?: number | null;
  creditBillMode?: "separate" | "consolidated";
  billingDayTxPeriod?: string | null;
  creditLimit: string | null; numberMasked: string | null;
  investProductType: string | null; costBasisMethod: string | null;
  fundUnitsDecimals?: number | null;
  tradingCalendar?: string | null;
  fixedAssetType?: string | null;
  isConsumerLoan?: boolean | null;
  debtDirection?: string | null;
  recordCount?: number;
  deletedRecordCount?: number;
};

const investmentProductTypeOptions = PRODUCT_TYPES
  .filter((value) => value !== "deposit")
  .map((value) => ({ value, labelKey: `investment.product.${value}` }));

function normalizedAccountKind(account: Pick<Account, "kind" | "investProductType">): string {
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  return isDepositAccount(account) ? "deposit" : account.kind;
}

function accountInstitutionTypeMatches(kind: string, investProductType: string | null | undefined, type: string | null | undefined) {
  return accountInstitutionTypeIsAllowed(kind, investProductType, type, { includeLegacyDebtInstitution: true });
}

function allowedInstitutionTypesForEdit(kind: string | null | undefined, investProductType: string | null | undefined) {
  return allowedInstitutionTypesForAccount(kind, investProductType, { includeLegacyDebtInstitution: true });
}

function parseOptionalIntegerField(value: string, min: number, max: number) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const numberValue = Number(text);
  return Number.isInteger(numberValue) && numberValue >= min && numberValue <= max ? numberValue : undefined;
}

function billingDayDisplayValue(day: number, t: (key: string, params?: Record<string, string | number>) => string) {
  return isCreditCardMonthEndBillingDay(day)
    ? t("settings.accounts.billingDayMonthEndValue")
    : t("settings.accounts.billingDayValue", { day });
}

const SETTINGS_ACCOUNT_KIND_OPTIONS = kindOrder.filter((kind) => kind !== "loan" && kind !== "settlement");

// 模块级常量：内联对象每次渲染都是新引用，会让 ADT 的显示状态 hydrate effect 每渲染重跑并 setState 新对象 → 无限循环。
const ACCOUNT_TABLE_DEFAULT_SORT = { key: "name", direction: "asc" } as const;

function getAccountDetailHref(account: Account) {
  const query = new URLSearchParams();
  if (account.kind === "loan" || account.kind === "settlement") {
    // Match the sidebar's per-person debt entry instead of selecting a detail account.
    query.set("view", "debt");
    query.set("debtPerson", `account:${account.id}`);
    return `/?${query.toString()}`;
  }
  query.set("accountId", account.id);
  const detailView =
    isDepositAccount(account)
      ? "deposit"
      : account.kind === "investment"
        ? getInvestmentAccountView(account)
        : account.kind === "insurance"
          ? "insurance"
          : account.kind === "bank_credit"
            ? "bill"
            : "detail";
  query.set("view", detailView);
  return `/?${query.toString()}`;
}

export default function SettingsAccountsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const tf = useCallback((key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }, [t]);
  const accountKindLabel = useCallback((kind: string) => t(`account.kind.${kind}`), [t]);
  const institutionKindLabel = (type: string | null | undefined) => institutionTypeLabel(type, t);
  const investmentLabel = useCallback((value: string | null | undefined) => t(`investment.product.${value || "fund"}`), [t]);
  const fixedAssetTypeLabel = useCallback((value: string | null | undefined) => t(`fixedAsset.type.${value || "property"}`), [t]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  // 内存缓存未命中时首屏 accounts=[]；没有 loading 会误显示「暂无账户」。
  const [loadingAccounts, setLoadingAccounts] = useState(() => !getCachedSettingsAccountData());
  const [scope, setScope] = useState<AccountScopeValue>({ userIds: [], institutionIds: [], accountIds: [] });
  const [selectedAccountKinds, setSelectedAccountKinds] = useState<string[]>([]);
  const [hideInactiveAccounts, setHideInactiveAccounts] = useState(false);
  const [baseCurrency, setBaseCurrency] = useState("CNY");
  const [accountNameQuery, setAccountNameQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editFormBaseline, setEditFormBaseline] = useState<Record<string, string>>({});
  const [billingDayRules, setBillingDayRules] = useState<CreditBillingDayRuleView[]>([]);
  const [billingDayRulesLoading, setBillingDayRulesLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  // ADT 表格当前视图（筛选+列排序后的全量行）：编辑弹窗的上一/下一导航沿此顺序。
  const [displayRows, setDisplayRows] = useState<Account[]>([]);
  const guideAccountSetup = searchParams.get("guide") === "accounts";

  // Delete account with password verification
  const [deleteTarget, setDeleteTarget] = useState<{ account: Account; recordCount: number; toRecordCount: number; planCount: number; planGeneratedRecordCount: number } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");

  // Account merge: exactly 2 same-type accounts can be merged into one.
  const [mergeSelectedIds, setMergeSelectedIds] = useState<string[]>([]);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeKeepId, setMergeKeepId] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState("");

  // Nested creation from SmartSelect in inline edit
  const [nestedEntityType, setNestedEntityType] = useState<"institution" | "group" | null>(null);

  useEffect(() => {
    const cached = getCachedSettingsAccountData();
    if (cached) {
      setGroups(cached.groups as Group[]);
      setAccounts(cached.accounts as Account[]);
      setInstitutions(cached.institutions as Institution[]);
      setCounterparties((cached.counterparties ?? []) as Counterparty[]);
      setBaseCurrency(normalizeCurrency(cached.baseCurrency));
      setLoadingAccounts(false);
      void loadAll({ force: true });
      return;
    }
    void loadAll();
    // 仅挂载时加载一次；loadAll 引用稳定（useCallback []），刻意不列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force) setLoadingAccounts(true);
    try {
      const data = await fetchSettingsAccountData(options).catch(() => null);
      if (!data) return;
      setGroups(data.groups as Group[]);
      setAccounts(data.accounts as Account[]);
      setInstitutions(data.institutions as Institution[]);
      setCounterparties((data.counterparties ?? []) as Counterparty[]);
      setBaseCurrency(normalizeCurrency(data.baseCurrency));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  const refreshSettingsAccounts = useCallback(async (reason: string) => {
    void notifySettingsDataChanged({ scope: "accounts", reason, prefetch: true });
    await loadAll({ force: true });
    dispatchFinanceDataChanged({ reason: "settings-accounts-change" });
  }, [loadAll]);

  // 正在编辑的信用卡账户：账单日设置走「账单日设置」弹窗（按生效日期的规则表），
  // 这里只读展示当前生效值：账单日 · 还款日（固定日 / 账单日后 N 天）· 交易归属期。
  const editingBillingAccount = useMemo(
    () => (editingId ? accounts.find((account) => account.id === editingId) ?? null : null),
    [accounts, editingId],
  );
  const editingBillingDayText = useMemo(() => {
    if (!editingBillingAccount || normalizedAccountKind(editingBillingAccount) !== "bank_credit") return "";
    const effectiveDay = currentBillingDayFromRules(billingDayRules, editingBillingAccount.billingDay);
    return effectiveDay ? billingDayDisplayValue(effectiveDay, t) : "";
  }, [billingDayRules, editingBillingAccount, t]);

  const loadBillingDayRules = useCallback(async (accountId: string) => {
    setBillingDayRulesLoading(true);
    try {
      const response = await fetch(
        `/api/v1/bill/billing-day-rules?accountId=${encodeURIComponent(accountId)}`,
        { cache: "no-store" },
      );
      const data = await response.json().catch(() => null) as { ok?: boolean; data?: { rules?: CreditBillingDayRuleView[] } } | null;
      setBillingDayRules(response.ok && data?.ok && Array.isArray(data.data?.rules) ? data.data.rules : []);
    } finally {
      setBillingDayRulesLoading(false);
    }
  }, []);

  // ---- Account handlers ----
  function buildEditForm(a: Account): Record<string, string> {
    const normalizedKind = normalizedAccountKind(a);
    const editKind = normalizedKind;
    const editInvestProductType = editKind === "investment" ? (a.investProductType || "fund") : editKind === "fixed_asset" ? "property" : "";
    const supportsInstitution = editKind !== "settlement" && allowedInstitutionTypesForEdit(editKind, editInvestProductType).length > 0;
    return {
      name: a.name,
      note: a.note || "",
      kind: editKind,
      currency: normalizeCurrency(a.currency || baseCurrency),
      groupId: a.groupId || "",
      institutionId: supportsInstitution ? a.institutionId || "" : "",
      billingDay: a.billingDay?.toString() || "",
      repaymentDay: a.repaymentDay?.toString() || "",
      repaymentOffsetDays: a.repaymentOffsetDays == null ? "" : String(a.repaymentOffsetDays),
      repaymentDayMode: a.repaymentOffsetDays == null ? "fixed" : "offset",
      creditLimit: a.creditLimit || "",
      creditBillMode: a.creditBillMode === "consolidated" ? "consolidated" : "separate",
      billingDayTxPeriod: a.billingDayTxPeriod === "next" ? "next" : "current",
      numberMasked: a.numberMasked || "",
      investProductType: editInvestProductType,
      fixedAssetType: editKind === "fixed_asset" ? (a.fixedAssetType || "property") : "",
      costBasisMethod: a.costBasisMethod || "moving_avg",
      fundUnitsDecimals: String(a.fundUnitsDecimals ?? 2),
      tradingCalendar: a.tradingCalendar || "cn_fund",
      isConsumerLoan: a.isConsumerLoan === true ? "true" : "false",
    };
  }

  // buildEditForm 每渲染重建（读 baseCurrency 等渲染期值）；openEdit 的稳定引用经 ref 间接调用。
  const buildEditFormRef = useRef(buildEditForm);
  buildEditFormRef.current = buildEditForm;

  const openEdit = useCallback((a: Account) => {
    const normalizedKind = normalizedAccountKind(a);
    const nextForm = buildEditFormRef.current(a);
    setEditingId(a.id);
    setEditError("");
    if (normalizedKind === "bank_credit") void loadBillingDayRules(a.id);
    else setBillingDayRules([]);
    setEditForm(nextForm);
    setEditFormBaseline(nextForm);
  }, [loadBillingDayRules]);

  function isEditFormDirty() {
    const keys = new Set([...Object.keys(editForm), ...Object.keys(editFormBaseline)]);
    for (const key of keys) {
      if (String(editForm[key] ?? "") !== String(editFormBaseline[key] ?? "")) return true;
    }
    return false;
  }

  function navigateEditAccount(target: Account | null | undefined) {
    if (!target || target.id === editingId) return;
    if (isEditFormDirty() && !window.confirm(t("settings.accounts.unsavedChanges"))) return;
    openEdit(target);
  }

  async function saveEdit(options?: { closeAfter?: boolean }) {
    const closeAfter = options?.closeAfter === true;
    if (!editingId) return;
    setEditError("");
    const savedId = editingId;
    const previousAccount = accounts.find((account) => account.id === savedId) ?? null;
    const nextKind = editForm.kind;
    const nextInvestProductType = editForm.investProductType || "fund";
    const nextInstitution = institutions.find((institution) => institution.id === editForm.institutionId);
    if (isStockInvestmentAccount(nextKind, nextInvestProductType) && (!editForm.institutionId || !isStockAccountInstitutionType(nextInstitution?.type))) {
      setEditError(t("entityForm.error.stockAccountInstitution"));
      return;
    }
    if (accountRequiresInstitution(nextKind, nextInvestProductType) && !editForm.institutionId) {
      setEditError(t("settings.accounts.import.institutionRequired"));
      return;
    }
    if (editForm.institutionId && !accountInstitutionTypeMatches(nextKind, nextInvestProductType, nextInstitution?.type)) {
      setEditError(t("settings.accounts.import.institutionNotAllowed"));
      return;
    }
    const isFixedAssetKind = nextKind === "fixed_asset";
    const isConsumerLoan = editForm.isConsumerLoan === "true";
    // 口径（2026-09-13）：贷款账户允许挂往来对象（贷款窗口借入）——消费贷有机构
    // 或有往来对象（编辑前账户上已挂的）其一即可。
    if (isConsumerLoan && (nextKind !== "loan" || (!editForm.institutionId && !previousAccount?.counterpartyId))) {
      setEditError(t("settings.accounts.consumerLoanInstitutionRequired"));
      return;
    }
    if (nextKind === "bank_credit") {
      if (editForm.repaymentDayMode === "offset") {
        const offsetDays = parseOptionalIntegerField(editForm.repaymentOffsetDays, 0, CREDIT_CARD_MAX_REPAYMENT_OFFSET_DAYS);
        if (offsetDays == null) {
          setEditError(t("creditBill.billingDayInvalidRepaymentOffsetDays"));
          return;
        }
      } else {
        const repaymentDay = parseOptionalIntegerField(editForm.repaymentDay, 1, 31);
        if (String(editForm.repaymentDay ?? "").trim() && repaymentDay === undefined) {
          setEditError(t("creditBill.billingDayInvalidRepaymentDay"));
          return;
        }
      }
    }
    if (previousAccount?.kind === "bank_credit" && nextKind !== "bank_credit") {
      const confirmed = await showConfirmDialog({
        title: t("settings.accounts.loseCreditConfirmTitle"),
        message: t("settings.accounts.loseCreditConfirmMessage"),
        tone: "danger",
      });
      if (!confirmed) return;
    }
    const payload: Record<string, string> = isFixedAssetKind
      ? { ...editForm, kind: "investment", investProductType: "property", institutionId: "", fixedAssetType: editForm.fixedAssetType || "property", isConsumerLoan: "false" }
      : { ...editForm };
    // 账单日由下方「账单日历史」表按生效日期保存，不随本表单提交 —— 否则表单里的旧值
    // 会把刚加的规则覆盖回去。还款日 / 交易归属期 仍走本表单。
    if (previousAccount?.kind === "bank_credit" && nextKind === "bank_credit") {
      delete payload.billingDay;
    }
    const res = await fetch("/api/v1/accounts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: savedId, ...payload }),
    });
    const data = await res.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      data?: {
        affectedCreditAccountIds?: string[];
        creditCycleRuleChanged?: boolean;
      };
    } | null;
    if (!res.ok || data?.ok === false) {
      setEditError(data?.error ?? t("settings.accounts.saveFailed"));
      return;
    }
    // 保存成功后以当前表单为新基线，便于继续编辑/翻页；「保存并关闭」才关窗。
    setEditFormBaseline({ ...editForm });
    if (closeAfter) {
      setEditingId(null);
      setEditFormBaseline({});
    }
    const affectedCreditAccountIds = Array.isArray(data?.data?.affectedCreditAccountIds)
      ? data.data.affectedCreditAccountIds.filter((id): id is string => Boolean(id))
      : [];
    const creditRuleChanged = Boolean(data?.data?.creditCycleRuleChanged) || Boolean(
      previousAccount &&
      (
        previousAccount.kind === "bank_credit" ||
        nextKind === "bank_credit"
      ) &&
      (
        previousAccount.kind !== nextKind ||
        String(previousAccount.institutionId ?? "") !== String(editForm.institutionId ?? "") ||
        String(previousAccount.creditBillMode ?? "separate") !== String(editForm.creditBillMode ?? "separate")
      ),
    );
    if (creditRuleChanged) {
      dispatchFinanceDataChanged({
        reason: "account-credit-cycle-settings",
        accountIds: affectedCreditAccountIds.length > 0 ? affectedCreditAccountIds : [savedId],
      });
    }
    void refreshSettingsAccounts("account:update");
  }

  async function changeEditInstitution(institutionId: string) {
    setEditForm((current) => ({ ...current, institutionId }));
    if (editForm.kind !== "bank_credit" || !institutionId) return;
    const result = await fetch(`/api/v1/accounts/credit-card-defaults?institutionId=${encodeURIComponent(institutionId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .catch((error) => {
        console.warn("[accounts] failed to load credit-card institution defaults", error);
        return null;
      });
    if (!result?.ok || !result.data) return;
    const offsetDays = result.data.repaymentOffsetDays == null ? "" : String(result.data.repaymentOffsetDays);
    setEditForm((current) => current.institutionId !== institutionId ? current : ({
      ...current,
      billingDay: result.data.billingDay == null ? "" : String(result.data.billingDay),
      repaymentDay: result.data.repaymentDay == null ? "" : String(result.data.repaymentDay),
      repaymentOffsetDays: offsetDays,
      repaymentDayMode: offsetDays ? "offset" : "fixed",
      creditBillMode: result.data.creditBillMode === "consolidated" ? "consolidated" : "separate",
      billingDayTxPeriod: result.data.billingDayTxPeriod === "next" ? "next" : "current",
    }));
  }

  async function changeEditKind(nextKind: string) {
    const nextInvestProductType = nextKind === "investment" ? (editForm.investProductType || "fund") : nextKind === "fixed_asset" ? "property" : "";
    const selectedInstitution = institutions.find((institution) => institution.id === editForm.institutionId);
    const keepInstitution = Boolean(selectedInstitution && accountInstitutionTypeMatches(nextKind, nextInvestProductType, selectedInstitution.type));
    const nextInstitutionId = keepInstitution ? (editForm.institutionId || "") : "";
    setEditForm((f) => ({
      ...f,
      kind: nextKind,
      institutionId: nextInstitutionId,
      investProductType: nextInvestProductType,
      fixedAssetType: nextKind === "fixed_asset" ? (f.fixedAssetType || "property") : "",
    }));
    // Converting into a credit card while keeping the institution: prefill the
    // institution's billing defaults for still-empty day fields (mirrors changeEditInstitution).
    if (nextKind !== "bank_credit" || !nextInstitutionId) return;
    const result = await fetch(`/api/v1/accounts/credit-card-defaults?institutionId=${encodeURIComponent(nextInstitutionId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .catch((error) => {
        console.warn("[accounts] failed to load credit-card institution defaults", error);
        return null;
      });
    if (!result?.ok || !result.data) return;
    const offsetDays = result.data.repaymentOffsetDays == null ? "" : String(result.data.repaymentOffsetDays);
    setEditForm((current) => current.kind !== "bank_credit" || current.institutionId !== nextInstitutionId ? current : ({
      ...current,
      billingDay: current.billingDay || (result.data.billingDay == null ? "" : String(result.data.billingDay)),
      repaymentDay: current.repaymentDay || (result.data.repaymentDay == null ? "" : String(result.data.repaymentDay)),
      repaymentOffsetDays: current.repaymentOffsetDays || offsetDays,
      repaymentDayMode: current.repaymentDay || current.repaymentOffsetDays
        ? current.repaymentDayMode || (current.repaymentOffsetDays ? "offset" : "fixed")
        : offsetDays ? "offset" : "fixed",
    }));
  }

  const toggleActive = useCallback(async (id: string) => {
    await fetch("/api/v1/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    void refreshSettingsAccounts("account:toggle-active");
  }, [refreshSettingsAccounts]);

  const accountDisplayName = (account: Account) => {
    return buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        investProductType: account.investProductType,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup,
        Counterparty: account.Counterparty,
      },
      getCreditCardLabelTemplatePreference(), { fields: getAccountLabelFieldsPreference() }).label;
  };

  const normalizeSearchText = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
  const accountMatchesNameQuery = (account: Account, query: string) => {
    const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    const haystack = [
      account.name,
      accountDisplayName(account),
      account.note,
      account.numberMasked,
      account.AccountGroup?.name,
      account.Institution?.name,
      account.Institution?.shortName,
      accountKindLabel(normalizedAccountKind(account)),
      investmentLabel(account.investProductType),
      fixedAssetTypeLabel(account.fixedAssetType),
    ].map(normalizeSearchText).join(" ");
    return tokens.every((token) => haystack.includes(token));
  };

  const statisticsAccounts: StatisticsAccountItem[] = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    kind: normalizedAccountKind(account),
    label: accountDisplayName(account),
    isPlaceholder: account.isPlaceholder,
    groupId: account.groupId ?? undefined,
    Institution: account.Institution
      ? {
          id: account.Institution.id || account.institutionId || undefined,
          name: account.Institution.name || account.Institution.shortName || "",
        }
      : null,
  }));
  const statisticsInstitutions: StatisticsInstitutionItem[] = institutions.map((institution) => ({
    id: institution.id,
    name: institution.shortName?.trim() || institution.name,
    type: institution.type,
  }));
  const statisticsUsers: StatisticsUserItem[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
  }));
  const accountKindFilterOptions = useMemo(() => kindOrder.filter((kind) =>
    accounts.some((account) => normalizedAccountKind(account) === kind),
  ), [accounts]);

  // ---- Account merge: allow merging exactly 2 accounts with the same type,
  // same owner, and same institution (currency and, for investment/loan
  // accounts, product type / debt direction must also match). ----
  const toggleMergeSelected = useCallback((id: string) => {
    setMergeSelectedIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(-2));
  }, []);

  const mergeCheck = useMemo(() => {
    if (mergeSelectedIds.length < 2) return { ok: false, reason: t("settings.accounts.merge.needTwo") };
    const [first, second] = mergeSelectedIds
      .map((id) => accounts.find((account) => account.id === id))
      .filter((account): account is Account => Boolean(account));
    if (!first || !second) return { ok: false, reason: t("settings.accounts.merge.needTwo") };
    if (normalizedAccountKind(first) !== normalizedAccountKind(second)) {
      return { ok: false, reason: t("settings.accounts.merge.hint.type") };
    }
    if (
      normalizedAccountKind(first) === "investment" &&
      (first.investProductType ?? "") !== (second.investProductType ?? "")
    ) {
      return { ok: false, reason: t("settings.accounts.merge.hint.investType") };
    }
    if ((first.kind === "loan" || first.kind === "settlement") && (first.debtDirection ?? "") !== (second.debtDirection ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.debtDirection") };
    }
    if ((first.groupId ?? "") !== (second.groupId ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.owner") };
    }
    if ((first.institutionId ?? "") !== (second.institutionId ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.institution") };
    }
    if (normalizeCurrency(first.currency || baseCurrency) !== normalizeCurrency(second.currency || baseCurrency)) {
      return { ok: false, reason: t("settings.accounts.merge.hint.currency") };
    }
    return { ok: true, reason: t("settings.accounts.merge.hint.same") };
  }, [accounts, mergeSelectedIds, baseCurrency, t]);

  const mergeSelectedAccounts = mergeSelectedIds
    .map((id) => accounts.find((account) => account.id === id))
    .filter((account): account is Account => Boolean(account));

  async function submitMerge(keepId: string, mergeId: string) {
    setMergeBusy(true);
    setMergeError("");
    try {
      const res = await fetch("/api/v1/accounts/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId, mergeId }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok === false) {
        setMergeError(data?.error || t("settings.accounts.merge.failed"));
        return;
      }
      setMergeModalOpen(false);
      setMergeSelectedIds([]);
      window.alert(t("settings.accounts.merge.success"));
      void refreshSettingsAccounts("account:merge");
    } finally {
      setMergeBusy(false);
    }
  }

  // useMemo：rows 引用不稳定会让 ADT 的 onDisplayRowsChange effect 每渲染回写 setDisplayRows(新数组) → 无限循环。
  const filteredAccounts = useMemo(() => accounts.filter(a => {
    if (scope.userIds.length > 0 && !scope.userIds.includes(a.groupId ?? "")) return false;
    if (scope.institutionIds.length > 0) {
      const institutionKey = a.Institution?.id ?? a.institutionId ?? CASH_INSTITUTION_ID;
      if (!scope.institutionIds.includes(institutionKey)) return false;
    }
    if (scope.accountIds.length > 0 && !scope.accountIds.includes(a.id)) return false;
    if (selectedAccountKinds.length > 0 && !selectedAccountKinds.includes(normalizedAccountKind(a))) return false;
    if (hideInactiveAccounts && !a.isActive) return false;
    if (!accountMatchesNameQuery(a, accountNameQuery)) return false;
    return true;
    // accountMatchesNameQuery 每渲染重建（依赖 accountDisplayName/preferences 读取），其输入
    // accountNameQuery 已在 deps 中；刻意不列入依赖以保持 rows 引用稳定（ADT 回写循环防护）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [accounts, scope, selectedAccountKinds, hideInactiveAccounts, accountNameQuery]);

  // ---- ADT 表格 ----
  const navigationAccountsState = displayRows.length > 0 ? displayRows : filteredAccounts;

  const handleDeleteClick = useCallback(async (event: React.MouseEvent, a: Account) => {
    event.stopPropagation();
    // 删除影响预检（preview=1 不删除）：展示级联范围——
    // 计划任务（还款/定投等）及其已生成的记录会一并删除。
    let impact: { recordCount: number; toRecordCount: number; planCount: number; planGeneratedRecordCount: number } | null = null;
    try {
      const previewRes = await fetch(`/api/v1/accounts?id=${a.id}&preview=1`, { method: "DELETE" });
      const previewJson = await previewRes.json().catch(() => null);
      if (previewJson?.ok && previewJson?.data) impact = previewJson.data;
    } catch { /* 预检失败回落通用确认 */ }
    const isLoan = a.kind === "loan";
    const planCount = impact?.planCount ?? 0;
    if (isLoan) {
      const confirmed = await showConfirmDialog({
        title: t("settings.accounts.deleteLoanTitle"),
        message: planCount > 0 && impact
          ? tf("settings.accounts.deleteLoanCascadeMessage", {
              name: a.name,
              planCount,
              planGeneratedRecordCount: impact.planGeneratedRecordCount,
            })
          : tf("settings.accounts.deleteLoanMessage", { name: a.name }),
        tone: "danger",
      });
      if (!confirmed) return;
    } else if (planCount > 0 && impact) {
      const confirmed = await showConfirmDialog({
        title: t("settings.accounts.deleteCascadeTitle"),
        message: tf("settings.accounts.deleteCascadeMessage", {
          name: a.name,
          planCount,
          planGeneratedRecordCount: impact.planGeneratedRecordCount,
        }),
        tone: "danger",
      });
      if (!confirmed) return;
    } else {
      if (!confirm(tf("settings.accounts.deleteConfirm", { name: a.name }))) return;
    }
    const res = await fetch(`/api/v1/accounts?id=${a.id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      void refreshSettingsAccounts("account:delete");
      return;
    }
    if (data.needPassword) {
      setDeleteTarget({
        account: a,
        recordCount: Number(data.recordCount ?? 0),
        toRecordCount: Number(data.toRecordCount ?? 0),
        planCount: Number(data.planCount ?? 0),
        planGeneratedRecordCount: Number(data.planGeneratedRecordCount ?? 0),
      });
      setDeletePassword("");
      setDeleteError("");
      return;
    }
    window.alert(data.error);
  }, [t, tf, refreshSettingsAccounts]);

  const accountTableColumns = useMemo<AdvancedDataTableColumn<Account>[]>(() => [
    {
      key: "merge",
      label: "",
      width: 44,
      minWidth: 40,
      align: "center",
      render: (a) => (
        <label
          className="flex cursor-pointer items-center justify-center"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
        >
          <input
            type="checkbox"
            checked={mergeSelectedIds.includes(a.id)}
            onChange={(event) => { event.stopPropagation(); toggleMergeSelected(a.id); }}
            onClick={(event) => event.stopPropagation()}
            className="h-3.5 w-3.5 accent-blue-600"
            aria-label={t("settings.accounts.merge.action")}
          />
        </label>
      ),
    },
    {
      key: "name",
      label: t("settings.accounts.name"),
      width: 260,
      minWidth: 160,
      truncate: true,
      // 名称列只显示账户名，排序也只按账户名；机构有独立列，不拼进名称。
      sortValue: (a) => a.name,
      cellTitle: (a) => (a.note ? `${a.name} · ${t("settings.accounts.notePrefix")}${a.note}` : a.name),
      render: (a) => (
        <div className="flex min-w-0 items-center gap-1.5">
          {a.isPlaceholder ? (
            <span className="truncate text-sm font-medium text-slate-800">{a.name}</span>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void router.push(getAccountDetailHref(a));
              }}
              className="min-w-0 max-w-full truncate rounded text-left text-sm font-medium text-slate-800 hover:text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            >
              {a.name}
            </button>
          )}
          {a.isPlaceholder && (
            <span className="shrink-0 rounded-full border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">{t("settings.accounts.placeholder")}</span>
          )}
          {a.isConsumerLoan && (
            <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{t("account.kind.consumer_loan")}</span>
          )}
        </div>
      ),
    },
    {
      key: "lastFour",
      label: t("settings.accounts.colLastFour"),
      width: 88,
      minWidth: 72,
      sortValue: (a) => a.numberMasked || "",
      filterText: (a) => a.numberMasked || null,
      render: (a) => (a.numberMasked
        ? <span className="tabular-nums text-slate-700">{a.numberMasked}</span>
        : <span className="text-slate-300">-</span>),
    },
    {
      key: "kind",
      label: t("settings.accounts.type"),
      width: 190,
      minWidth: 150,
      sortValue: (a) => {
        const index = kindOrder.indexOf(normalizedAccountKind(a));
        return String(index < 0 ? 99 : index).padStart(2, "0");
      },
      filterText: (a) => {
        const normalizedKind = normalizedAccountKind(a);
        if (normalizedKind === "investment") return `${accountKindLabel(normalizedKind)} ${investmentLabel(a.investProductType)}`;
        if (normalizedKind === "fixed_asset") return `${accountKindLabel(normalizedKind)} ${fixedAssetTypeLabel(a.fixedAssetType)}`;
        return accountKindLabel(normalizedKind);
      },
      render: (a) => {
        const normalizedKind = normalizedAccountKind(a);
        return (
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${kindColor(normalizedKind)}`}>
              <span className="shrink-0">{kindIcon(normalizedKind)}</span>
              <span className="truncate">{accountKindLabel(normalizedKind)}</span>
            </span>
            {normalizedKind === "investment" && (
              <span className="truncate text-[11px] text-purple-700" title={investmentLabel(a.investProductType)}>
                {investmentLabel(a.investProductType)}
              </span>
            )}
            {normalizedKind === "fixed_asset" && (
              <span className="truncate text-[11px] text-orange-700" title={fixedAssetTypeLabel(a.fixedAssetType)}>
                {fixedAssetTypeLabel(a.fixedAssetType)}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "owner",
      label: t("settings.accounts.owner"),
      width: 110,
      minWidth: 90,
      truncate: true,
      sortValue: (a) => a.AccountGroup?.name || "",
      filterText: (a) => a.AccountGroup?.name || null,
      render: (a) => (a.AccountGroup
        ? <span className="text-slate-700">{a.AccountGroup.name}</span>
        : <span className="text-slate-300">-</span>),
    },
    {
      key: "institution",
      label: t("settings.accounts.institution"),
      width: 170,
      minWidth: 120,
      truncate: true,
      sortValue: (a) => a.Institution?.shortName?.trim() || a.Institution?.name || a.Counterparty?.shortName?.trim() || a.Counterparty?.name || "",
      filterText: (a) => (normalizedAccountKind(a) === "settlement"
        ? a.Counterparty?.shortName?.trim() || a.Counterparty?.name || null
        : a.Institution?.shortName?.trim() || a.Institution?.name || null),
      render: (a) => {
        if (normalizedAccountKind(a) === "settlement") {
          const label = a.Counterparty?.shortName?.trim() || a.Counterparty?.name || "";
          return label ? <span className="text-slate-700">{label}</span> : <span className="text-slate-300">-</span>;
        }
        const label = a.Institution?.shortName?.trim() || a.Institution?.name || "";
        return label ? <span className="text-slate-700">{label}</span> : <span className="text-slate-300">-</span>;
      },
    },
    {
      key: "currency",
      label: t("settings.accounts.currency"),
      width: 76,
      minWidth: 64,
      sortValue: (a) => a.currency,
      filterText: (a) => a.currency,
      render: (a) => <span className="tabular-nums text-slate-600">{a.currency}</span>,
    },
    {
      key: "records",
      label: t("settings.accounts.colRecords"),
      width: 96,
      minWidth: 76,
      align: "right",
      sortValue: (a) => a.recordCount ?? 0,
      cellTitle: (a) => tf("settings.accounts.recordCountTitle", {
        count: a.recordCount ?? 0,
        deleted: a.deletedRecordCount ?? 0,
      }),
      render: (a) => (
        <span className="tabular-nums text-slate-500">
          {tf("settings.accounts.recordCountShort", { count: a.recordCount ?? 0 })}
          {a.deletedRecordCount ? <span className="ml-1 text-slate-400">{tf("settings.accounts.deletedRecordCountShort", { count: a.deletedRecordCount })}</span> : null}
        </span>
      ),
    },
    {
      key: "status",
      label: t("depositShell.colStatus"),
      width: 84,
      minWidth: 72,
      sortValue: (a) => (a.isActive ? 0 : 1),
      filterText: (a) => (a.isActive ? t("common.enabled") : t("common.disabled")),
      render: (a) => (
        <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${a.isActive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
          {a.isActive ? t("common.enabled") : t("common.disabled")}
        </span>
      ),
    },
    {
      key: "note",
      label: t("settings.accounts.note"),
      width: 220,
      minWidth: 140,
      truncate: true,
      hideable: true,
      sortValue: (a) => a.note || "",
      filterText: (a) => a.note || null,
      render: (a) => (a.note
        ? <span className="text-slate-500">{a.note}</span>
        : <span className="text-slate-300">-</span>),
    },
  ], [t, tf, router, accountKindLabel, investmentLabel, fixedAssetTypeLabel, mergeSelectedIds, toggleMergeSelected]);

  const renderRowActions = useCallback((a: Account) => (
    <>
      {!a.isPlaceholder && (
        <SettingsActionButton
          label={a.isActive ? t("common.disabled") : t("common.enabled")}
          icon={a.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
          onClick={(event) => { event.stopPropagation(); void toggleActive(a.id); }}
        />
      )}
      {!a.isPlaceholder && (
        <SettingsActionButton
          label={t("common.edit")}
          variant="edit"
          onClick={(event) => { event.stopPropagation(); openEdit(a); }}
        />
      )}
      <SettingsActionButton
        label={t("common.delete")}
        variant="delete"
        onClick={(event) => void handleDeleteClick(event, a)}
      />
    </>
  ), [t, toggleActive, openEdit, handleDeleteClick]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="shrink-0">
      <SettingsPageHeader
        title={t("settings.accounts.title")}
        description={guideAccountSetup ? t("settings.accounts.guideDescription") : t("settings.accounts.description")}
        count={filteredAccounts.length}
        toolbar={
          <>
          <div className="w-64 max-w-full">
            <input
              value={accountNameQuery}
              onChange={(event) => setAccountNameQuery(event.target.value)}
              placeholder={t("settings.accounts.searchPlaceholder")}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <AccountScopeFilter
            allAccounts={statisticsAccounts}
            allInstitutions={statisticsInstitutions}
            allUsers={statisticsUsers}
            value={scope}
            onChange={setScope}
            showAccountFilter={false}
          />
          <MultiSelectFilterDropdown
            options={accountKindFilterOptions}
            selectedValues={selectedAccountKinds}
            onChange={setSelectedAccountKinds}
            labelFor={accountKindLabel}
            allLabel={t("settings.accounts.type")}
            selectedSummaryLabel={(first, count) => t("settings.accounts.selectedTypesSummary", { first, count })}
            clearLabel={t("statistics.clearSelection")}
            emptyLabel={t("table.empty")}
            renderOptionLeading={(kind) => (
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 font-semibold ${kindColor(kind)}`}>
                {kindIcon(kind)}
              </span>
            )}
          />
          <label className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm">
            <input
              type="checkbox"
              checked={hideInactiveAccounts}
              onChange={(event) => setHideInactiveAccounts(event.target.checked)}
              className="h-3.5 w-3.5 accent-blue-600"
            />
            <span>{t("settings.accounts.hideInactiveAccounts")}</span>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <AccountBatchImportButton
              groups={statisticsUsers}
              institutions={institutions}
              counterparties={counterparties}
              baseCurrency={baseCurrency}
              onImported={() => void refreshSettingsAccounts("account:import")}
            />
            <SettingsPrimaryAddButton onClick={() => setShowCreateAccount(true)}>{t("settings.accounts.add")}</SettingsPrimaryAddButton>
          </div>
          </>
        }
      />
      </div>

      {/* ===== Account list (ADT table: 类型为独立列，专属参数走编辑弹窗) ===== */}
      <div className="mt-3 min-h-0 flex-1">
        <AdvancedDataTable
          storageKey="mmh_settings_accounts_table_v1"
          columns={accountTableColumns}
          rows={filteredAccounts}
          rowKey={(a) => a.id}
          minTableWidth={1260}
          fillHeight
          showFilters={false}
          sortable
          defaultSort={ACCOUNT_TABLE_DEFAULT_SORT}
          emptyText={loadingAccounts ? t("common.loading") : t("settings.accounts.empty")}
          rowClassName={(a) => (a.isPlaceholder ? "opacity-40 bg-slate-50" : !a.isActive ? "opacity-60" : "")}
          onRowDoubleClick={(a) => { if (!a.isPlaceholder) openEdit(a); }}
          onDisplayRowsChange={setDisplayRows}
          rowActions={renderRowActions}
          rowActionsWidth={116}
          rowActionsMinWidth={104}
          toolbarMode="default"
        />
      </div>

      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="account"
        open={showCreateAccount}
        onClose={() => setShowCreateAccount(false)}
        fieldData={{
          groupId: groups,
          institutionId: institutions,
          // 往来款账户的「往来对象」下拉：只允许 person/organization（merchant 是常用商户，不当往来款对象）
          counterpartyId: counterparties
            .filter((counterparty) => isSettlementCounterpartyType(counterparty.type))
            .map((counterparty) => ({ id: counterparty.id, name: counterparty.shortName?.trim() || counterparty.name, type: counterparty.type ?? undefined })),
        }}
        // 资金账户新建始终带初始余额（日期+金额，生成期初余额锚点）；投资/固定资产由 EntityCreateForm 内部排除。
        // 曾只在首次使用引导（?guide=accounts）显示，导致普通入口建账户无法录期初余额（2026-09-15 用户反馈）。
        includeInitialBalanceFields
        defaultCurrency={baseCurrency}
        onCreated={() => {
          setShowCreateAccount(false);
          void refreshSettingsAccounts("account:create");
        }}
        existingNames={accounts.map(a => a.name)}
      />

      {/* Nested creation modals from SmartSelect in inline edit */}
      {nestedEntityType && (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            if (nestedEntityType === "institution") {
              setInstitutions(prev => [...prev, { id, name, shortName: extra?.institutionShortName ?? null, type: extra?.type }]);
              setEditForm(f => accountInstitutionTypeMatches(f.kind || "other", f.investProductType || "fund", extra?.type) ? { ...f, institutionId: id } : f);
            } else if (nestedEntityType === "group") {
              setGroups(prev => [...prev, { id, name, sortOrder: prev.length }]);
              setEditForm(f => ({ ...f, groupId: id }));
            }
            void refreshSettingsAccounts(nestedEntityType === "institution" ? "institution:create-nested" : "account-group:create-nested");
            setNestedEntityType(null);
          }}
          defaultType={
            nestedEntityType !== "institution" ? undefined
              : isStockInvestmentAccount(editForm.kind, editForm.investProductType || "fund") ? "brokerage"
              : editForm.kind === "investment" && (["fund", "money"].includes(editForm.investProductType || "fund")) ? "fund_company"
              : allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund").length === 1 ? allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund")[0]
              : undefined
          }
          allowedInstitutionTypes={
            nestedEntityType !== "institution" ? undefined
              : isStockInvestmentAccount(editForm.kind, editForm.investProductType || "fund") ? ["brokerage"]
              : allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund").length > 0 ? allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund")
              : undefined
          }
        />
      )}

      {/* Password confirmation dialog for deleting account with records */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4"
          onMouseDown={() => { setDeleteTarget(null); setDeleteError(""); }}>
          <div className="w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl p-4"
            onMouseDown={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-slate-800 mb-1">{t("settings.accounts.passwordTitle")}</div>
            <div className="text-xs text-slate-500 mb-3">
              {tf("settings.accounts.passwordDesc", {
                name: deleteTarget.account.name,
                recordCount: deleteTarget.recordCount,
                linkedCount: deleteTarget.toRecordCount,
              })}
              {deleteTarget.planCount > 0 ? (
                <div className="mt-1 text-rose-600">
                  {tf("settings.accounts.passwordDescPlans", {
                    planCount: deleteTarget.planCount,
                    planGeneratedRecordCount: deleteTarget.planGeneratedRecordCount,
                  })}
                </div>
              ) : null}
            </div>
            <input
              type="password"
              value={deletePassword}
              onChange={e => { setDeletePassword(e.target.value); setDeleteError(""); }}
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  const res = await fetch(`/api/v1/accounts?id=${deleteTarget.account.id}`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password: deletePassword }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    setDeleteTarget(null);
                    void refreshSettingsAccounts("account:delete-with-password");
                  }
                  else setDeleteError(data.error);
                }
              }}
              placeholder={t("settings.accounts.passwordPlaceholder")}
              autoFocus
              className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
            />
            {deleteError && <div className="text-xs text-red-500 mt-1">{deleteError}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
                className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">{t("common.cancel")}</button>
              <button onClick={async () => {
                const res = await fetch(`/api/v1/accounts?id=${deleteTarget.account.id}`, {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: deletePassword }),
                });
                const data = await res.json();
                if (data.ok) {
                  setDeleteTarget(null);
                  void refreshSettingsAccounts("account:delete-with-password");
                }
                else setDeleteError(data.error);
              }}
                className="h-8 px-3 rounded-md bg-red-600 text-white text-xs hover:bg-red-700">{t("settings.accounts.confirmDelete")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Account edit modal */}
      {editingId && (() => {
        const editingAccount = accounts.find((account) => account.id === editingId);
        if (!editingAccount) return null;
        const normalizedKind = normalizedAccountKind(editingAccount);
        // 口径（2026-09-15）：贷款账户建立后基本信息不可修改（与负债侧 4c0a7a7 一致）——
        // 设置侧只读展示，还款资金账户在负债明细中调整；如需变更参数请删除贷款后重建。
        const loanEditLocked = normalizedKind === "loan";
        const loanLockedWrapperCls = loanEditLocked ? "pointer-events-none opacity-60" : "";
        const editKind = (editForm.kind || normalizedKind) as AccountKind | "fixed_asset";
        const isFixedAssetKind = editKind === "fixed_asset";
        const isInvestmentKind = editKind === "investment" || isFixedAssetKind;
        const editInvestProductType = editForm.investProductType || (isFixedAssetKind ? "property" : "fund");
        const showCostBasisMethod = isInvestmentKind && supportsCostBasisMethod(editInvestProductType);
        const isBillLikeKind = editKind === "bank_credit";
        const supportsLastFour = editKind === "bank_credit" || editKind === "bank_debit";
        const editKindOptions = normalizedKind === "loan" || normalizedKind === "settlement" ? [...SETTINGS_ACCOUNT_KIND_OPTIONS, normalizedKind] : SETTINGS_ACCOUNT_KIND_OPTIONS;
        const supportsInstitution = editKind !== "settlement" && allowedInstitutionTypesForEdit(editKind, editInvestProductType).length > 0;
        const filteredInstitutions = institutions.filter((institution) =>
          accountInstitutionTypeMatches(editKind, editInvestProductType, institution.type),
        );
        // 导航顺序 = 表格当前视图顺序（顶部筛选 + 列排序后的行序）。
        const navigationAccounts = navigationAccountsState;
        const currentNavIndex = navigationAccounts.findIndex((account) => account.id === editingId);
        const previousAccountNav = currentNavIndex > 0 ? navigationAccounts[currentNavIndex - 1] : null;
        const nextAccountNav = currentNavIndex >= 0 && currentNavIndex < navigationAccounts.length - 1 ? navigationAccounts[currentNavIndex + 1] : null;
        const closeEditModal = () => {
          setEditingId(null);
          setEditError("");
          setEditFormBaseline({});
        };
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 backdrop-blur-[1px]"
            onMouseDown={closeEditModal}>
            <div
              className="app-modal-panel relative mt-16 !w-[720px] max-w-[calc(100vw-2rem)] sm:mt-20"
              role="dialog"
              aria-modal="true"
              onMouseDown={e => e.stopPropagation()}
            >
              <div className="modal-header shrink-0">
                <div className="text-sm font-semibold text-slate-800">{t("settings.accounts.editTitle", { name: editingAccount.name })}</div>
                <button type="button" onClick={closeEditModal}
                  className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" aria-label={t("table.close")}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              {navigationAccounts.length > 1 ? (
                <TransparentSideNavButtons
                  scope="account"
                  onPrevious={() => navigateEditAccount(previousAccountNav)}
                  onNext={() => navigateEditAccount(nextAccountNav)}
                  previousDisabled={!previousAccountNav}
                  nextDisabled={!nextAccountNav}
                  previousLabel={t("settings.accounts.previousAccount")}
                  nextLabel={t("settings.accounts.nextAccount")}
                />
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {loanEditLocked ? (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                  {t("settings.accounts.loanEditLockedHint")}
                </div>
              ) : null}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.name")}</label>
                  <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    disabled={loanEditLocked}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400 disabled:bg-slate-50 disabled:text-slate-500" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.type")}</label>
                  <select
                    value={editKind}
                    onChange={e => void changeEditKind(e.target.value)}
                    disabled={loanEditLocked}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none disabled:bg-slate-50 disabled:text-slate-500"
                  >
                    {editKindOptions.map((value) => (
                      <option key={value} value={value}>{t(`account.kind.${value}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.owner")}</label>
                  <div className={loanLockedWrapperCls}>
                    <SmartSelect mode="single" value={editForm.groupId || ""}
                      onChange={id => setEditForm(f => ({ ...f, groupId: id }))}
                      options={groups.map(g => ({ id: g.id, label: g.name }))}
                      placeholder={t("settings.accounts.selectOwner")}
                      onCreateClick={() => setNestedEntityType("group")} createLabel={t("settings.accounts.addOwner")} />
                  </div>
                </div>
                {supportsInstitution && (
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.institution")}</label>
                    <div className={loanLockedWrapperCls}>
                      <SmartSelect mode="single" value={editForm.institutionId || ""}
                        onChange={changeEditInstitution}
                        options={filteredInstitutions.map(i => ({
                          id: i.id,
                          label: i.shortName?.trim() || i.name,
                          subLabel: [i.shortName?.trim() ? i.name : "", institutionKindLabel(i.type)].filter(Boolean).join(" · "),
                        }))}
                        placeholder={t("settings.accounts.selectInstitution")}
                        onCreateClick={() => setNestedEntityType("institution")} createLabel={t("settings.accounts.addInstitution")} />
                    </div>
                  </div>
                )}
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.currency")}</label>
                  <select
                    value={normalizeCurrency(editForm.currency || baseCurrency)}
                    onChange={e => setEditForm(f => ({ ...f, currency: e.target.value }))}
                    disabled={loanEditLocked}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none disabled:bg-slate-50 disabled:text-slate-500"
                  >
                    {CURRENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{t(`entityForm.currency.${option.value.toLowerCase()}`)}</option>
                    ))}
                  </select>
                </div>
                {isInvestmentKind && (
                  isFixedAssetKind ? (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("fixedAssetEdit.assetType")}</label>
                      <select
                        value={editForm.fixedAssetType || "property"}
                        onChange={e => setEditForm(f => ({ ...f, fixedAssetType: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        {FIXED_ASSET_TYPES.map((value) => (
                          <option key={value} value={value}>{t(`fixedAsset.type.${value}`)}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.investmentAccountType")}</label>
                      <select value={editInvestProductType} onChange={e => setEditForm(f => {
                        const nextInvestProductType = e.target.value;
                        const selectedInstitution = institutions.find((institution) => institution.id === f.institutionId);
                        return {
                          ...f,
                          investProductType: nextInvestProductType,
                          ...(isStockInvestmentAccount(editKind, nextInvestProductType) && selectedInstitution && !isStockAccountInstitutionType(selectedInstitution.type) ? { institutionId: "" } : {}),
                        };
                      })}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                        {investmentProductTypeOptions.map((item) => <option key={item.value} value={item.value}>{investmentLabel(item.value)}</option>)}
                      </select>
                    </div>
                  )
                )}
              </div>

              {isInvestmentKind && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  {showCostBasisMethod && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.costBasisMethod")}</label>
                      <select value={editForm.costBasisMethod || "moving_avg"} onChange={e => setEditForm(f => ({ ...f, costBasisMethod: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                        <option value="moving_avg">{t("settings.accounts.movingAverage")}</option>
                        <option value="fifo">{t("settings.accounts.fifo")}</option>
                        <option value="lifo">{t("settings.accounts.lifo")}</option>
                      </select>
                    </div>
                  )}
                  {editInvestProductType === "fund" && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.fundUnitsDecimals")}</label>
                      <input
                        value={editForm.fundUnitsDecimals || "2"}
                        onChange={e => setEditForm(f => ({ ...f, fundUnitsDecimals: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                        inputMode="numeric"
                        placeholder={t("settings.accounts.defaultUnitsDecimals")}
                      />
                    </div>
                  )}
                  {supportsTradingCalendarForAccount(editKind, editInvestProductType) && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.tradingCalendar")}</label>
                      <select
                        value={editForm.tradingCalendar || "cn_fund"}
                        onChange={e => setEditForm(f => ({ ...f, tradingCalendar: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        {TRADING_CALENDARS.map((calendar) => (
                          <option key={calendar} value={calendar}>{t(`tradingCalendar.${calendar}`)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {supportsLastFour && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  {isBillLikeKind && (
                    <>
                      {/* 账单日由下方的「账单日历史」表按生效日期管理，这里只读展示当前生效值。 */}
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.billingDayLabel")}</label>
                        <div className="flex h-8 items-center">
                          <span className="text-sm text-slate-700">{editingBillingDayText || "-"}</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.repaymentDayModeLabel")}</label>
                        <select
                          value={editForm.repaymentDayMode || "fixed"}
                          onChange={e => setEditForm(f => ({ ...f, repaymentDayMode: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                        >
                          <option value="fixed">{t("entityForm.repaymentDayMode.fixed")}</option>
                          <option value="offset">{t("entityForm.repaymentDayMode.offset")}</option>
                        </select>
                      </div>
                      {editForm.repaymentDayMode === "offset" ? (
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.repaymentOffsetDaysLabel")}</label>
                          <input value={editForm.repaymentOffsetDays || ""} onChange={e => setEditForm(f => ({ ...f, repaymentOffsetDays: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" inputMode="numeric" placeholder={t("entityForm.repaymentOffsetDaysPlaceholder")} />
                        </div>
                      ) : (
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.repaymentDayLabel")}</label>
                          <input value={editForm.repaymentDay || ""} onChange={e => setEditForm(f => ({ ...f, repaymentDay: e.target.value }))}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" inputMode="numeric" placeholder={t("entityForm.dayRangePlaceholder")} />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.creditLimitLabel")}</label>
                        <input value={editForm.creditLimit || ""} onChange={e => setEditForm(f => ({ ...f, creditLimit: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                      </div>
                    </>
                  )}
                  {isBillLikeKind && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.billingDayTxPeriodLabel")}</label>
                      <select
                        value={editForm.billingDayTxPeriod || "current"}
                        onChange={e => setEditForm(f => ({ ...f, billingDayTxPeriod: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        <option value="current">{t("settings.accounts.billingDayTxPeriod.current")}</option>
                        <option value="next">{t("settings.accounts.billingDayTxPeriod.next")}</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.lastFourLabel")}</label>
                    <input value={editForm.numberMasked || ""} onChange={e => setEditForm(f => ({ ...f, numberMasked: e.target.value }))}
                      className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                  </div>
                  {isBillLikeKind && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.billMode")}</label>
                      <select
                        value={editForm.creditBillMode || "separate"}
                        onChange={e => setEditForm(f => ({ ...f, creditBillMode: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        <option value="separate">{t("settings.accounts.separateBill")}</option>
                        <option value="consolidated">{t("settings.accounts.consolidatedBill")}</option>
                      </select>
                    </div>
                  )}
                </div>
              )}

              {isBillLikeKind && editingBillingAccount ? (
                <div className="mt-3">
                  <div className="mb-1 text-xs font-medium text-slate-500">{t("creditBill.billingDayRuleSectionTitle")}</div>
                  <CreditCardBillingDayRulesTable
                    accountId={editingBillingAccount.id}
                    rules={billingDayRules}
                    onRulesChanged={setBillingDayRules}
                    billingDay={editingBillingAccount.billingDay}
                  />
                  {billingDayRulesLoading ? <div className="mt-1 text-xs text-slate-400">{t("common.loading")}</div> : null}
                </div>
              ) : null}

              <div className="mt-3">
                <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.note")}</label>
                <ClearableNoteField
                  multiline
                  disabled={loanEditLocked}
                  value={editForm.note || ""}
                  onValueChange={value => setEditForm(f => ({ ...f, note: value }))}
                  className="min-h-[96px] w-full resize-y rounded-md border border-slate-200 px-2 py-2 text-sm leading-5 outline-none focus:border-blue-400"
                  placeholder={t("settings.accounts.notePlaceholder")}
                  rows={4}
                />
              </div>

              {isInvestmentKind && editInvestProductType === "fund" ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-600">{t("fundRules.title")}</span>
                    <span className="text-[11px] text-slate-400">{t("fundConfirmDays.embeddedHint")}</span>
                  </div>
                  <FundConfirmDaysPanel
                    accountId={editingAccount.id}
                    compact
                    onSaved={() => {
                      dispatchFinanceDataChanged({ reason: "fund-confirm-days:save", accountIds: [editingAccount.id] });
                    }}
                  />
                </div>
              ) : null}

              <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                {editError ? <div className="mr-auto text-xs text-red-600">{editError}</div> : null}
                {!loanEditLocked && (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveEdit({ closeAfter: false })}
                      className="h-8 rounded-md border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 hover:bg-blue-100"
                    >
                      {t("common.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveEdit({ closeAfter: true })}
                      className="h-8 rounded-md bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700"
                    >
                      {t("settings.accounts.saveAndClose")}
                    </button>
                  </>
                )}
              </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ===== Merge selection bar (bottom floating) ===== */}
      {mergeSelectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2 shadow-lg">
          <span className="shrink-0 text-xs font-medium text-slate-700">
            {tf("settings.accounts.merge.selected", { count: mergeSelectedIds.length })}
          </span>
          {mergeSelectedIds.length === 2 && (
            <span className={`shrink-0 text-xs ${mergeCheck.ok ? "text-emerald-600" : "text-amber-600"}`}>{mergeCheck.reason}</span>
          )}
          <button
            type="button"
            disabled={!mergeCheck.ok}
            onClick={() => { setMergeKeepId(mergeSelectedIds[0] ?? ""); setMergeError(""); setMergeModalOpen(true); }}
            className="h-7 shrink-0 rounded-full bg-blue-600 px-3 text-xs font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {t("settings.accounts.merge.action")}
          </button>
          <button
            type="button"
            onClick={() => setMergeSelectedIds([])}
            className="h-7 shrink-0 rounded-full border border-slate-200 px-3 text-xs text-slate-600 transition hover:bg-slate-50"
          >
            {t("settings.accounts.merge.clear")}
          </button>
        </div>
      )}

      {/* ===== Merge confirm modal ===== */}
      {mergeModalOpen && mergeSelectedAccounts.length === 2 && (() => {
        const [first, second] = mergeSelectedAccounts;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4"
            onMouseDown={() => { if (!mergeBusy) setMergeModalOpen(false); }}>
            <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl p-4"
              onMouseDown={e => e.stopPropagation()}>
              <div className="text-sm font-semibold text-slate-800 mb-1">{t("settings.accounts.merge.title")}</div>
              <div className="text-xs text-slate-500 mb-3">{t("settings.accounts.merge.desc")}</div>
              <div className="mb-1.5 text-xs font-medium text-slate-600">{t("settings.accounts.merge.chooseName")}</div>
              <div className="space-y-2">
                {[first, second].map((account) => {
                  const isKeep = mergeKeepId === account.id;
                  return (
                    <label key={account.id}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${isKeep ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                      onClick={() => setMergeKeepId(account.id)}
                    >
                      <input
                        type="radio"
                        name="merge-keep-account"
                        checked={isKeep}
                        onChange={() => setMergeKeepId(account.id)}
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{accountDisplayName(account)}</span>
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border ${isKeep ? "border-blue-200 bg-blue-50 text-blue-600" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                        {isKeep ? t("settings.accounts.merge.keepLabel") : t("settings.accounts.merge.mergedLabel")}
                      </span>
                    </label>
                  );
                })}
              </div>
              {mergeError && <div className="text-xs text-red-500 mt-2">{mergeError}</div>}
              <div className="flex justify-end gap-2 mt-4">
                <button type="button" disabled={mergeBusy}
                  onClick={() => setMergeModalOpen(false)}
                  className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                  {t("common.cancel")}
                </button>
                <button type="button" disabled={mergeBusy || !mergeKeepId}
                  onClick={() => {
                    const mergeId = mergeSelectedIds.find((id) => id !== mergeKeepId) ?? "";
                    if (mergeKeepId && mergeId) void submitMerge(mergeKeepId, mergeId);
                  }}
                  className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">
                  {mergeBusy ? "..." : t("settings.accounts.merge.confirm")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
