"use client";

/**
 * 账户编辑弹窗——全站唯一实现。
 *
 * 「设置 → 账户管理」与各视图表头双击账户名共用这一个组件：字段、校验、多币种升级、
 * 账单日规则只有一份，避免两套表单各自演化后又分叉。
 *
 * 货币基金（货基收益）的关停/换绑/重算不在这个弹窗里，入口是「设置 → 账户」表头的
 * 「货币基金」弹窗（MoneyFundIncomeDialog）；这里保持原本的账户字段布局，不掺货基内容。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banknote, Building2, CreditCard, Landmark, Layers, PiggyBank, Wallet, X } from "lucide-react";
import type { AccountKind } from "@prisma/client";
import { ModalLayer } from "@/components/ModalLayer";
import { SmartSelect } from "@/components/SmartSelect";
import { CalcInput } from "@/components/CalcInput";
import { ClearableNoteField } from "@/components/ClearableNoteField";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { FundConfirmDaysPanel } from "@/components/FundConfirmDaysModal";
import { CreditCardBillingDayRulesTable } from "@/components/CreditCardBillingDayRulesTable";
import { TransparentSideNavButtons } from "@/components/TransparentSideNavButtons";
import { SettingsInfoHint, useHideSettingDescriptions } from "@/components/settings/SettingsPageScaffold";
import { institutionTypeLabel, isSettlementCounterpartyType, kindColor, kindIconName, kindOrder } from "@/lib/account-kinds";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { CURRENCY_OPTIONS, normalizeCurrency } from "@/lib/currency";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { TRADING_CALENDARS, supportsTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import {
  accountKindOptionsForEdit,
  accountRecordLockErrorKey,
  isDepositAccount,
  supportsMultiCurrencyHierarchy,
} from "@/lib/account-kind-utils";
import {
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  allowedInstitutionTypesForAccount,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";
import { institutionFullName } from "@/lib/institution-display";
import { buildAccountOwnerOptions } from "@/lib/account-owner-options";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { fetchSettingsAccountData, getCachedSettingsAccountData } from "@/lib/client/settingsCache";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { useI18n } from "@/lib/i18n";
import type { CreditBillingDayRuleView } from "@/lib/credit/billing-day-rules";

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

type Group = { id: string; name: string; sortOrder: number; institutionId?: string | null };
type LoanCategoryView = { id: string; name: string; baseType: string; sortOrder: number; isSystem: boolean; isActive: boolean };
type Institution = { id: string; name: string; shortName?: string | null; type?: string };
type Counterparty = { id: string; name: string; shortName?: string | null; type?: string | null; isReimbursable?: boolean | null };
type Account = {
  id: string; name: string; kind: AccountKind; currency: string; isActive: boolean;
  note: string | null;
  /** 账户自定义分组标签（2026-11-13），与 groupId 的「所有人分组」无关。 */
  accountGroup?: string | null;
  isPlaceholder?: boolean;
  institutionId: string | null; groupId: string | null;
  Institution: { id: string; name: string; shortName?: string | null } | null;
  AccountGroup: { id: string; name: string } | null;
  Counterparty: { id: string; name: string; shortName?: string | null; isReimbursable?: boolean | null } | null;
  counterpartyId?: string | null;
  billingDay: number | null; repaymentDay: number | null; repaymentOffsetDays?: number | null;
  creditBillMode?: "separate" | "consolidated" | "supplementary";
  /** 卡别：主卡 / 附属卡，与账单模式并存。 */
  cardRole?: "primary" | "supplementary";
  /** 附属卡持卡人（用户自定义填写）与其归属的主卡。 */
  cardHolderName?: string | null;
  primaryCardId?: string | null;
  billingDayTxPeriod?: string | null;
  creditLimit: string | null; numberMasked: string | null;
  investProductType: string | null; costBasisMethod: string | null;
  fundUnitsDecimals?: number | null;
  tradingCalendar?: string | null;
  fixedAssetType?: string | null;
  isConsumerLoan?: boolean | null;
  loanCategoryId?: string | null;
  liabilityDirection?: string | null;
  recordCount?: number;
  deletedRecordCount?: number;
  /** 多币种层级：子账户的父账户 id（null = 根账户）。 */
  parentId?: string | null;
  /** 多币种父账户（聚合账户）：只参与统计，本身没有明细。 */
  isAggregate?: boolean | null;
  linkedFundCode?: string | null;
  /** 轻量货基模式（2026-11-19）：钱包直接挂代码后的计息起始日（YYYY-MM-DD）。 */
  linkedFundStartDate?: string | null;
};


const investmentProductTypeOptions = PRODUCT_TYPES
  .filter((value) => value !== "deposit")
  .map((value) => ({ value, labelKey: `investment.product.${value}` }));

function normalizedAccountKind(account: Pick<Account, "kind" | "investProductType">): string {
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  return isDepositAccount(account) ? "deposit" : account.kind;
}

/** 多币种归属校验错误码 → 本地化文案 key（后端 error 是英文，直接展示体验差）。 */
function accountParentErrorKey(code: string | undefined) {
  switch (code) {
    case "ACCOUNT_PARENT_NOT_FOUND": return "settings.accounts.parentError.notFound";
    case "ACCOUNT_PARENT_NOT_AGGREGATE": return "settings.accounts.parentError.notAggregate";
    case "ACCOUNT_PARENT_IS_AGGREGATE": return "settings.accounts.parentError.isAggregate";
    case "ACCOUNT_PARENT_SELF": return "settings.accounts.parentError.self";
    case "ACCOUNT_PARENT_CURRENCY_CONFLICT": return "settings.accounts.parentError.currencyConflict";
    case "ACCOUNT_PARENT_KIND_MISMATCH": return "settings.accounts.parentError.kindMismatch";
    case "ACCOUNT_HIERARCHY_KIND_NOT_ALLOWED": return "settings.accounts.parentError.kindNotAllowed";
    case "ACCOUNT_PARENT_KIND_NOT_ALLOWED": return "settings.accounts.parentError.kindNotAllowed";
    default: return "";
  }
}

function accountInstitutionTypeMatches(kind: string, investProductType: string | null | undefined, type: string | null | undefined) {
  return accountInstitutionTypeIsAllowed(kind, investProductType, type, { includeLegacyLiabilityInstitution: true });
}

function allowedInstitutionTypesForEdit(kind: string | null | undefined, investProductType: string | null | undefined) {
  return allowedInstitutionTypesForAccount(kind, investProductType, { includeLegacyLiabilityInstitution: true });
}

const SETTINGS_ACCOUNT_KIND_OPTIONS = kindOrder.filter((kind) => kind !== "loan" && kind !== "settlement");

/* ---- 编辑弹窗的字段规格 ----
   高度 / 圆角 / 焦点态只在这里定义一次：此前同一弹窗里混着 h-8 输入框和 h-9 的
   SmartSelect、若干种焦点样式，视觉上「什么都不齐」。 */
const FIELD_LABEL_CLS = "mb-1 block text-[11px] font-medium text-slate-500";
const FIELD_INPUT_CLS = "h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none transition-colors placeholder:text-slate-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-500";

/** 弹窗里的一组字段：小标题 + 右侧细线。组间距由调用方的 className 控制。 */
function EditSection({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={className}>
      <div className="mb-2 flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-semibold text-slate-400">{title}</span>
        <span className="h-px min-w-0 flex-1 bg-slate-200/70" />
      </div>
      {children}
    </section>
  );
}

export type AccountEditDialogProps = {
  /** 要编辑的账户 id。组件内部自己取账户数据，宿主不必先加载完。 */
  accountId: string;
  /** 关闭弹窗（点遮罩、X、保存后关闭都走这里）。 */
  onClose: () => void;
  /** 上一/下一账户的导航顺序（设置页传表格当前视图顺序）；不传则隐藏导航按钮。 */
  navigationAccounts?: Account[];
  /** 保存成功后的额外回调（宿主可用来滚动定位、提示）；数据刷新由组件内部广播完成。 */
  onSaved?: (reason: string) => void;
};

export function AccountEditDialog({
  accountId,
  onClose,
  navigationAccounts: navigationAccountsProp,
  onSaved,
}: AccountEditDialogProps) {
  const { t } = useI18n();
  const hideSettingDescriptions = useHideSettingDescriptions();

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const cached = getCachedSettingsAccountData();
  const [accounts, setAccounts] = useState<Account[]>(() => (cached?.accounts as Account[] | undefined) ?? []);
  const [institutions, setInstitutions] = useState<Institution[]>(() => (cached?.institutions as Institution[] | undefined) ?? []);
  const [counterparties, setCounterparties] = useState<Counterparty[]>(() => (cached?.counterparties as Counterparty[] | undefined) ?? []);
  const [groups, setGroups] = useState<Group[]>(() => (cached?.groups as Group[] | undefined) ?? []);
  const [baseCurrency, setBaseCurrency] = useState(cached?.baseCurrency ?? "CNY");

  // 宿主给的是初始账户；「上一/下一」只切内部 activeId，不要求宿主重建组件。
  const [activeId, setActiveId] = useState(accountId);
  useEffect(() => {
    setActiveId(accountId);
  }, [accountId]);
  const editingId = activeId;
  const setEditingId = useCallback((next: string | null) => {
    if (!next) {
      onCloseRef.current();
      return;
    }
    setActiveId(next);
  }, []);
  // 组件不管理 URL（设置页的 ?edit= 由宿主清理）。
  const clearEditQuery = useCallback(() => {}, []);
  const tf = useCallback((key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }, [t]);

  const [loanCategories, setLoanCategories] = useState<LoanCategoryView[]>([]);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editFormBaseline, setEditFormBaseline] = useState<Record<string, string>>({});
  const [billingDayRules, setBillingDayRules] = useState<CreditBillingDayRuleView[]>([]);
  const [billingDayRulesLoading, setBillingDayRulesLoading] = useState(false);
  // 规则表加载失败时必须可见：静默退化成「暂无记录」会让用户以为规则丢了。
  const [billingDayRulesError, setBillingDayRulesError] = useState("");
  const [editError, setEditError] = useState("");
  const [upgradingMultiCurrency, setUpgradingMultiCurrency] = useState(false);
  const parentAccountOptions = useMemo<Array<{ id: string; label: string; kind: string; subLabel: string }>>(
    () => accounts
      // 只有资金账户（含信用卡）能当父账户；历史遗留的非资金父账户不再作为新挂接候选。
      .filter((account) => account.isAggregate === true && account.id !== editingId && supportsMultiCurrencyHierarchy(account.kind))
      .map((account) => ({
        id: account.id,
        label: account.name,
        // 子账户必须与父账户同类型：选项按当前编辑的类型过滤，避免选到保存必失败的项。
        kind: normalizedAccountKind(account),
        subLabel: tf("settings.accounts.hierarchyChildCount", {
          count: accounts.filter((child) => child.parentId === account.id).length,
        }),
      })),
    [accounts, editingId, tf],
  );
  // Nested creation from SmartSelect in inline edit
  const [nestedEntityType, setNestedEntityType] = useState<"institution" | "group" | null>(null);

  const navigationAccountsState = useMemo(
    () => navigationAccountsProp ?? [],
    [navigationAccountsProp],
  );

  const loadAll = useCallback(async (options?: { force?: boolean }) => {
    const data = await fetchSettingsAccountData(options);
    setAccounts((data.accounts ?? []) as Account[]);
    setInstitutions((data.institutions ?? []) as Institution[]);
    setCounterparties((data.counterparties ?? []) as Counterparty[]);
    setGroups((data.groups ?? []) as Group[]);
    setBaseCurrency(data.baseCurrency || "CNY");
  }, []);

  useEffect(() => {
    void loadAll().catch(() => {});
  }, [loadAll]);

  // 保存/降级后：广播刷新（设置页表格、侧边栏、当前视图都靠它），再拉一次本地列表。
  const refreshSettingsAccounts = useCallback(async (reason: string) => {
    dispatchFinanceDataChanged({ reason: "settings-accounts-change" });
    try {
      await loadAll({ force: true });
    } catch {
      // 刷新失败不影响「已保存」的事实，弹窗内继续用旧列表即可。
    }
    onSavedRef.current?.(reason);
  }, [loadAll]);

  const accountKindLabel = useCallback((kind: string) => t(`account.kind.${kind}`), [t]);
  const institutionKindLabel = (type: string | null | undefined) => institutionTypeLabel(type, t);
  const investmentLabel = useCallback((value: string | null | undefined) => t(`investment.product.${value || "fund"}`), [t]);

  const accountNameById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.name])),
    [accounts],
  );
  // 「账户所有人」= 分组，展示名走配对家庭成员（与设置页同一口径）。
  const statisticsUsers = useMemo(
    () => buildAccountOwnerOptions(groups, institutions.filter((institution) => institution.type === "family_member")),
    [groups, institutions],
  );
  const subAccountCountByParentId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      const parentId = account.parentId ?? "";
      if (!parentId) continue;
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    }
    return counts;
  }, [accounts]);
  const accountGroupLabelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const account of accounts) {
      const label = (account.accountGroup ?? "").trim();
      if (label) seen.add(label);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [accounts]);

  const editingBillingAccount = useMemo(
    () => (editingId ? accounts.find((account) => account.id === editingId) ?? null : null),
    [accounts, editingId],
  );


  const loadBillingDayRules = useCallback(async (accountId: string) => {
    setBillingDayRulesLoading(true);
    setBillingDayRulesError("");
    try {
      const response = await fetch(
        `/api/v1/bill/billing-day-rules?accountId=${encodeURIComponent(accountId)}`,
        { cache: "no-store" },
      );
      const data = await response.json().catch(() => null) as
        { ok?: boolean; error?: string; data?: { rules?: CreditBillingDayRuleView[] } } | null;
      const rules = response.ok && data?.ok && Array.isArray(data.data?.rules) ? data.data.rules : null;
      setBillingDayRules(rules ?? []);
      // 读取失败不能退化成空表：这里保留服务端 error 便于定位（例如 Prisma client 未重新生成）。
      if (!rules) setBillingDayRulesError(data?.error || t("creditBill.readFailed"));
    } catch {
      setBillingDayRules([]);
      setBillingDayRulesError(t("creditBill.readFailed"));
    } finally {
      setBillingDayRulesLoading(false);
    }
  }, [t]);

  // 贷款类别下拉数据源（2026-10-07）：贷款账户可在此处改类别，服务端按类别派生口径 loanType。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const response = await fetch("/api/v1/loan-categories", { cache: "no-store" }).catch(() => null);
      const data = await response?.json().catch(() => null) as {
        ok?: boolean;
        categories?: LoanCategoryView[];
      } | null;
      if (cancelled) return;
      setLoanCategories(response?.ok && data?.ok && Array.isArray(data.categories) ? data.categories : []);
    })();
    return () => {
      cancelled = true;
    };
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
      // 自定义分组标签（2026-11-13）：空串 = 未分组。
      accountGroup: a.accountGroup || "",
      kind: editKind,
      currency: normalizeCurrency(a.currency || baseCurrency),
      groupId: a.groupId || "",
      institutionId: supportsInstitution ? a.institutionId || "" : "",
      counterpartyId: editKind === "settlement" ? a.counterpartyId || "" : "",
      counterpartyReimbursable: (a.Counterparty?.isReimbursable === true).toString(),
      billingDay: a.billingDay?.toString() || "",
      repaymentDay: a.repaymentDay?.toString() || "",
      repaymentOffsetDays: a.repaymentOffsetDays == null ? "" : String(a.repaymentOffsetDays),
      repaymentDayMode: a.repaymentOffsetDays == null ? "fixed" : "offset",
      creditLimit: a.creditLimit || "",
      creditBillMode: a.creditBillMode === "consolidated" ? "consolidated" : a.creditBillMode === "supplementary" ? "supplementary" : "separate",
      cardRole: a.cardRole === "supplementary" ? "supplementary" : "primary",
      cardHolderName: a.cardHolderName || "",
      primaryCardId: a.primaryCardId || "",
      billingDayTxPeriod: a.billingDayTxPeriod === "next" ? "next" : "current",
      numberMasked: a.numberMasked || "",
      investProductType: editInvestProductType,
      fixedAssetType: editKind === "fixed_asset" ? (a.fixedAssetType || "property") : "",
      costBasisMethod: a.costBasisMethod || "moving_avg",
      fundUnitsDecimals: String(a.fundUnitsDecimals ?? 2),
      tradingCalendar: a.tradingCalendar || "cn_fund",
      isConsumerLoan: a.isConsumerLoan === true ? "true" : "false",
      loanCategoryId: editKind === "loan" ? a.loanCategoryId || "" : "",
      // 多币种归属：空串 = 根账户（独立账户），否则为父账户 id。
      parentId: a.parentId || "",
      // 货基关联不随表单提交：卡片上的「关联 / 解绑」直接 PUT，避免顺手保存把计息起始日覆盖成今天。
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
    else {
      setBillingDayRules([]);
      setBillingDayRulesError("");
    }
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

  function navigateEditAccountBy(direction: -1 | 1) {
    const currentIndex = navigationAccountsState.findIndex((account) => account.id === editingId);
    if (currentIndex < 0) return;
    for (let index = currentIndex + direction; index >= 0 && index < navigationAccountsState.length; index += direction) {
      const candidate = navigationAccountsState[index];
      if (!candidate) continue;
      navigateEditAccount(candidate);
      return;
    }
  }

  function hasEditableAccountInDirection(direction: -1 | 1) {
    const currentIndex = navigationAccountsState.findIndex((account) => account.id === editingId);
    if (currentIndex < 0) return false;
    for (let index = currentIndex + direction; index >= 0 && index < navigationAccountsState.length; index += direction) {
      if (navigationAccountsState[index]) return true;
    }
    return false;
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
    if (nextKind === "settlement" && !String(editForm.counterpartyId ?? "").trim()) {
      setEditError(t("liabilityTx.placeholder.selectCounterparty"));
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
    // 账单日 / 还款日都不再随本表单提交：两者都由下方「账单日 / 还款日变更记录」
    // 按生效日期保存（银行通常同时改），表单里的旧值会把刚加的记录覆盖回去。
    if (previousAccount?.kind === "bank_credit" && nextKind !== "bank_credit") {
      const confirmed = await showConfirmDialog({
        title: t("settings.accounts.loseCreditConfirmTitle"),
        message: t("settings.accounts.loseCreditConfirmMessage"),
        tone: "danger",
      });
      if (!confirmed) return;
    }
    const payload: Record<string, string> = isFixedAssetKind
      ? { ...editForm, kind: "investment", investProductType: "property", institutionId: "", counterpartyId: "", fixedAssetType: editForm.fixedAssetType || "property", isConsumerLoan: "false" }
      : nextKind === "settlement"
        ? { ...editForm, institutionId: "", isConsumerLoan: "false" }
        : { ...editForm, counterpartyId: nextKind === "loan" ? (editForm.counterpartyId || previousAccount?.counterpartyId || "") : "" };
    // Convert the reimbursable switch to a JSON boolean; only settlement-account
    // edits submit it because the field belongs to the counterparty object.
    if (nextKind === "settlement") {
      payload.counterpartyReimbursable = editForm.counterpartyReimbursable === "true" ? "true" : "false";
    } else {
      delete payload.counterpartyReimbursable;
    }
    // 账单日 / 还款日由下方「账单日 / 还款日变更记录」按生效日期保存，不随本表单提交 ——
    // 否则表单里的旧值会把刚加的记录覆盖回去（还款日现在也跟着记录走）。
    // 交易归属期（billingDayTxPeriod）仍走本表单。
    if (previousAccount?.kind === "bank_credit" && nextKind === "bank_credit") {
      delete payload.billingDay;
      delete payload.repaymentDay;
      delete payload.repaymentOffsetDays;
      delete payload.repaymentDayMode;
    }
    const res = await fetch("/api/v1/accounts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: savedId, ...payload, counterpartyReimbursable: payload.counterpartyReimbursable === "true" ? true : payload.counterpartyReimbursable === "false" ? false : undefined }),
    });
    const data = await res.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      code?: string;
      data?: {
        affectedCreditAccountIds?: string[];
        creditCycleRuleChanged?: boolean;
      };
    } | null;
    if (!res.ok || data?.ok === false) {
      const lockKey = accountRecordLockErrorKey(data?.code);
      const parentKey = accountParentErrorKey(data?.code);
      setEditError(lockKey ? t(lockKey) : parentKey ? t(parentKey) : (data?.error ?? t("settings.accounts.saveFailed")));
      return;
    }
    // 保存成功后以当前表单为新基线，便于继续编辑/翻页；「保存并关闭」才关窗。
    setEditFormBaseline({ ...editForm });
    if (closeAfter) {
      setEditingId(null);
      setEditFormBaseline({});
      clearEditQuery();
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
        String(previousAccount.creditBillMode ?? "separate") !== String(editForm.creditBillMode ?? "separate") ||
        String(previousAccount.primaryCardId ?? "") !== String(editForm.primaryCardId ?? "")
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

  /** 取消多币种：只在父账户仅剩一个子户时可用（子户提为根账户、父行删除）。 */
  async function downgradeMultiCurrencyParent(target: Account) {
    if (upgradingMultiCurrency) return;
    const childCount = subAccountCountByParentId.get(target.id) ?? 0;
    const confirmed = await showConfirmDialog({
      title: t("settings.accounts.parentAccountDowngradeTitle"),
      message: tf("settings.accounts.parentAccountDowngradeMessage", { name: target.name, count: childCount }),
      tone: "danger",
    });
    if (!confirmed) return;
    setUpgradingMultiCurrency(true);
    setEditError("");
    try {
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(target.id)}/multi-currency`, { method: "DELETE" });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok !== true) {
        setEditError(data?.error ?? t("settings.accounts.parentAccountDowngradeFailed"));
        return;
      }
      setEditingId(null);
      setEditFormBaseline({});
      clearEditQuery();
      await refreshSettingsAccounts("account:multi-currency-downgrade");
    } catch {
      setEditError(t("settings.accounts.parentAccountDowngradeFailed"));
    } finally {
      setUpgradingMultiCurrency(false);
    }
  }

  /** 把正在编辑的账户升级为多币种父账户（父行新建、本账户原地降级为币种子户）。 */
  async function upgradeEditingAccountToMultiCurrency(target: Account) {
    if (upgradingMultiCurrency) return;
    const confirmed = await showConfirmDialog({
      title: t("settings.accounts.parentAccountUpgradeTitle"),
      message: tf("settings.accounts.parentAccountUpgradeMessage", { name: target.name }),
    });
    if (!confirmed) return;
    setUpgradingMultiCurrency(true);
    setEditError("");
    try {
      const res = await fetch(`/api/v1/accounts/${encodeURIComponent(target.id)}/multi-currency`, { method: "POST" });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok !== true) {
        setEditError(data?.error ?? t("settings.accounts.parentAccountUpgradeFailed"));
        return;
      }
      await refreshSettingsAccounts("account:multi-currency-upgrade");
      // 升级后本账户变成子账户（id 不变），用最新数据重开编辑以显示新的归属。
      const freshAccounts = (getCachedSettingsAccountData()?.accounts ?? []) as Account[];
      const freshAccount = freshAccounts.find((account) => account.id === target.id);
      if (freshAccount) openEdit(freshAccount);
    } catch {
      setEditError(t("settings.accounts.parentAccountUpgradeFailed"));
    } finally {
      setUpgradingMultiCurrency(false);
    }
  }

  /** 换「所有人」：货基关联（代码 + 起始日）不随表单走，由卡片单独操作，这里只改归属。 */
  function changeEditOwner(ownerId: string) {
    setEditForm((current) => ({ ...current, groupId: ownerId }));
  }

  async function changeEditInstitution(institutionId: string) {
    // 主卡按机构筛选：换机构后原主卡不在候选里，必须同步清空。
    setEditForm((current) => ({ ...current, institutionId, primaryCardId: "" }));
    if (editForm.kind !== "bank_credit" || !institutionId) return;
    const result = await fetch(`/api/v1/accounts/credit-card-defaults?institutionId=${encodeURIComponent(institutionId)}&groupId=${encodeURIComponent(editForm.groupId || "")}`, { cache: "no-store" })
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
      // 机构默认值模板不含附属卡：已选附属卡时切机构只换候选，不重置账单模式。
      creditBillMode: current.creditBillMode === "supplementary"
        ? "supplementary"
        : result.data.creditBillMode === "consolidated" ? "consolidated" : "separate",
      billingDayTxPeriod: result.data.billingDayTxPeriod === "next" ? "next" : "current",
    }));
  }

  async function changeEditKind(nextKind: string) {
    const nextInvestProductType = nextKind === "investment" ? (editForm.investProductType || "fund") : nextKind === "fixed_asset" ? "property" : "";
    const selectedInstitution = institutions.find((institution) => institution.id === editForm.institutionId);
    const keepInstitution = Boolean(selectedInstitution && accountInstitutionTypeMatches(nextKind, nextInvestProductType, selectedInstitution.type));
    const nextInstitutionId = keepInstitution ? (editForm.institutionId || "") : "";
    const existingCounterpartyId = accounts.find((account) => account.id === editingId)?.counterpartyId || "";
    setEditForm((f) => ({
      ...f,
      kind: nextKind,
      institutionId: nextInstitutionId,
      counterpartyId: nextKind === "settlement" ? (f.counterpartyId || existingCounterpartyId) : "",
      investProductType: nextInvestProductType,
      fixedAssetType: nextKind === "fixed_asset" ? (f.fixedAssetType || "property") : "",
      // Loan category sits one level below the account kind: default it when switching to "loan",
      // clear it when switching away (the server clears it too).
      loanCategoryId: nextKind === "loan" ? (f.loanCategoryId || loanCategories[0]?.id || "") : "",
      // 子账户必须与父账户同类型：切换类型时先解除归属，否则保存会被后端拒绝。
      parentId: nextKind === f.kind ? f.parentId : "",
      // 换类型/机构后附属卡主卡候选可能整组变化，不允许沿用旧选择。
      primaryCardId: nextInstitutionId === f.institutionId && nextKind === f.kind ? f.primaryCardId : "",
    }));
    // Converting into a credit card while keeping the institution: prefill the
    // institution's billing defaults for still-empty day fields (mirrors changeEditInstitution).
    if (nextKind !== "bank_credit" || !nextInstitutionId) return;
    const result = await fetch(`/api/v1/accounts/credit-card-defaults?institutionId=${encodeURIComponent(nextInstitutionId)}&groupId=${encodeURIComponent(editForm.groupId || "")}`, { cache: "no-store" })
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

  // 数据到位后按传入的 accountId 初始化表单；缓存未命中时等 fetch 回来。
  const bootstrappedRef = useRef<string | null>(null);
  useEffect(() => {
    if (bootstrappedRef.current === editingId) return;
    const target = accounts.find((account) => account.id === editingId);
    if (!target) return;
    bootstrappedRef.current = editingId;
    openEdit(target);
  }, [accounts, editingId, openEdit]);

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
        // 卡别=附属卡才显示主卡选择；兼容历史上「账单模式=附属卡」的存量数据。
        const isSupplementaryCard = isBillLikeKind
          && (editForm.cardRole === "supplementary" || editForm.creditBillMode === "supplementary");
        // 主卡候选：先按当前机构过滤，再排除自身与其他附属卡（附属卡不能再挂附属卡）。
        const primaryCardOptions = accounts
          .filter((candidate) => candidate.kind === "bank_credit"
            && candidate.id !== editingAccount.id
            && candidate.creditBillMode !== "supplementary"
            && candidate.cardRole !== "supplementary"
            && candidate.institutionId === editForm.institutionId)
          .map((candidate) => ({ id: candidate.id, label: candidate.name, subLabel: candidate.numberMasked || "" }));
        const supportsLastFour = editKind === "bank_credit" || editKind === "bank_debit";
        const hasRecords = (editingAccount.recordCount ?? 0) > 0;
        const kindEdit = accountKindOptionsForEdit({
          currentKind: normalizedKind,
          hasRecords,
          emptyAccountKinds: SETTINGS_ACCOUNT_KIND_OPTIONS,
        });
        const editKindOptions = kindEdit.options;
        // 父账户的类型必须与子户一致，编辑时锁死（服务端同样拒绝变更）。
        const kindSelectDisabled = loanEditLocked || kindEdit.kindSelectDisabled || editingAccount.isAggregate === true;
        // 父账户候选按账户类型过滤：子账户必须与父账户同类型。
        const parentOptionsForKind = parentAccountOptions
          .filter((option) => option.kind === editKind)
          .map(({ id, label, subLabel }) => ({ id, label, subLabel }));
        // 只有资金账户（含信用卡）允许父子层级（2026-10-20 用户裁定）。
        // 历史数据里若已有归属，仍显示下拉以便解除，但不允许新挂接/升级。
        const supportsHierarchy = supportsMultiCurrencyHierarchy(editKind);
        const settlementCounterparties = counterparties.filter((counterparty) => isSettlementCounterpartyType(counterparty.type));
        // Resolve the current account's object even when it is outside the
        // settlement-counterparty filter, such as a merchant fallback.
        const editingCounterparty = settlementCounterparties.find((counterparty) => counterparty.id === (editForm.counterpartyId || editingAccount.counterpartyId))
          ?? counterparties.find((counterparty) => counterparty.id === (editForm.counterpartyId || editingAccount.counterpartyId))
          ?? null;
        const supportsInstitution = editKind !== "settlement" && allowedInstitutionTypesForEdit(editKind, editInvestProductType).length > 0;
        const filteredInstitutions = institutions.filter((institution) =>
          accountInstitutionTypeMatches(editKind, editInvestProductType, institution.type),
        );
        // 导航顺序 = 表格当前视图顺序（顶部筛选 + 列排序后的行序）。
        const navigationAccounts = navigationAccountsState;
        const closeEditModal = () => {
          setEditingId(null);
          setEditError("");
          setEditFormBaseline({});
          clearEditQuery();
        };

  return (
    <>
          <ModalLayer className="fixed inset-0 flex items-start justify-center overflow-y-auto bg-black/30 p-0 backdrop-blur-[1px] md:p-4" onMouseDown={closeEditModal}>
            <div
              className="app-modal-panel relative mt-0 w-full max-w-[calc(100vw-2rem)] md:mt-20 md:!w-[720px] md:max-h-[calc(100dvh-7rem)]"
              role="dialog"
              aria-modal="true"
              onMouseDown={e => e.stopPropagation()}
            >
              <div className="modal-header shrink-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-800">{t("settings.accounts.editTitle", { name: editingAccount.name })}</div>
                  {/* 副标题把「这是什么账户」一次说清：类型 · 币种 · 归属状态，省得在表单里再找。 */}
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500">
                    <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1 py-px font-medium [&>svg]:h-3 [&>svg]:w-3 ${kindColor(normalizedKind)}`}>
                      {kindIcon(normalizedKind)}
                      {accountKindLabel(normalizedKind)}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-400">{normalizeCurrency(editForm.currency || editingAccount.currency || baseCurrency)}</span>
                    {editingAccount.isAggregate ? (
                      <span className="shrink-0 rounded bg-sky-50 px-1 py-px text-sky-700">{t("settings.accounts.hierarchyMultiCurrency")}</span>
                    ) : editingAccount.parentId ? (
                      <span className="shrink-0 rounded bg-slate-100 px-1 py-px text-slate-500">
                        {t("settings.accounts.hierarchyChildBadge")}
                      </span>
                    ) : null}
                    {!editingAccount.isActive ? <span className="shrink-0 text-slate-400">{t("common.disabled")}</span> : null}
                  </div>
                </div>
                <button type="button" onClick={closeEditModal}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-colors hover:border-slate-300 hover:bg-white hover:text-slate-700" aria-label={t("table.close")}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              {navigationAccounts.length > 1 ? (
                <TransparentSideNavButtons
                  scope="account"
                  onPrevious={() => navigateEditAccountBy(-1)}
                  onNext={() => navigateEditAccountBy(1)}
                  previousDisabled={!hasEditableAccountInDirection(-1)}
                  nextDisabled={!hasEditableAccountInDirection(1)}
                  previousLabel={t("settings.accounts.previousAccount")}
                  nextLabel={t("settings.accounts.nextAccount")}
                />
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {/* 多币种归属：父账户/子账户的关系只读展示（关系由转账时自动创建或升级产生）。
                  「父账户只统计、不能记账」这类解释只在新手期显示，老用户只看归属事实。 */}
              {editingAccount.parentId ? (
                <div className="mb-3 rounded-md border border-slate-200/70 border-l-[3px] border-l-slate-300 bg-slate-50/80 px-2.5 py-1.5 text-[11px] leading-4 text-slate-600">
                  {hideSettingDescriptions
                    ? tf("settings.accounts.hierarchyParentOwner", {
                        name: accountNameById.get(editingAccount.parentId) ?? "-",
                        currency: editingAccount.currency,
                      })
                    : tf("settings.accounts.hierarchyParentHint", {
                        name: accountNameById.get(editingAccount.parentId) ?? "-",
                        currency: editingAccount.currency,
                      })}
                </div>
              ) : editingAccount.isAggregate ? (
                <div className="mb-3 rounded-md border border-slate-200/70 border-l-[3px] border-l-slate-300 bg-slate-50/80 px-2.5 py-1.5 text-[11px] leading-4 text-slate-600">
                  <div>
                    {hideSettingDescriptions
                      ? `${t("settings.accounts.hierarchyMultiCurrency")} · ${tf("settings.accounts.hierarchyChildCount", { count: subAccountCountByParentId.get(editingAccount.id) ?? 0 })}`
                      : tf("settings.accounts.hierarchyAggregateHint", { count: subAccountCountByParentId.get(editingAccount.id) ?? 0 })}
                  </div>
                  {/* 0 个子户（可直接新建的空父账户）也能取消：后端会删掉父行。 */}
                  {(subAccountCountByParentId.get(editingAccount.id) ?? 0) <= 1 ? (
                    <button
                      type="button"
                      onClick={() => void downgradeMultiCurrencyParent(editingAccount)}
                      disabled={upgradingMultiCurrency}
                      className="mt-1 text-[11px] font-medium text-rose-600 underline decoration-dotted underline-offset-2 transition-colors hover:text-rose-700 disabled:cursor-not-allowed disabled:text-slate-300"
                    >
                      {t("settings.accounts.parentAccountDowngrade")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {loanEditLocked ? (
                <div className="mb-3 rounded-md border border-amber-200/70 border-l-[3px] border-l-amber-400 bg-amber-50/70 px-2.5 py-1.5 text-[11px] leading-4 text-amber-700">
                  {t("settings.accounts.loanEditableHint")}
                </div>
              ) : null}
              <EditSection title={t("settings.accounts.editSectionBasic")}>
              {/* 基本资料恢复成原来的平铺栅格（桌面 4 列 / 窄屏 2 列）：货基设定搬到
                  设置 → 账户 表头的「货币基金」弹窗后，这里不再为侧栏卡片留位置。 */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 md:grid-cols-4">
                <div>
                  <label className={FIELD_LABEL_CLS}>{t("settings.accounts.name")}</label>
                  <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    className={FIELD_INPUT_CLS} />
                </div>
                <div>
                  <label className={FIELD_LABEL_CLS}>{t("settings.accounts.type")}</label>
                  <select
                    value={editKind}
                    onChange={e => void changeEditKind(e.target.value)}
                    disabled={kindSelectDisabled}
                    className={FIELD_INPUT_CLS}
                  >
                    {editKindOptions.map((value) => (
                      <option key={value} value={value}>{t(`account.kind.${value}`)}</option>
                    ))}
                  </select>
                </div>
                {editKind === "loan" ? (
                  <div>
                    <label className={FIELD_LABEL_CLS}>{t("settings.accounts.loanCategory")}</label>
                    <select
                      value={editForm.loanCategoryId || loanCategories[0]?.id || ""}
                      onChange={e => setEditForm(f => ({ ...f, loanCategoryId: e.target.value }))}
                      className={FIELD_INPUT_CLS}
                    >
                      {loanCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.isSystem ? t(`loan.type.${category.baseType}`) : category.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <div>
                  <label className={FIELD_LABEL_CLS}>{t("settings.accounts.owner")}</label>
                  <div className={loanLockedWrapperCls}>
                    <SmartSelect mode="single" value={editForm.groupId || ""}
                      onChange={changeEditOwner}
                      options={statisticsUsers.map((owner) => ({ id: owner.id, label: owner.name }))}
                      placeholder={t("settings.accounts.selectOwner")}
                      behavior={{ density: "compact" }}
                      onCreateClick={() => setNestedEntityType("group")} createLabel={t("settings.accounts.addOwner")} />
                  </div>
                </div>
                {/* 自定义分组标签（2026-11-13）：用户自己起的分类名，只影响侧边栏 / 账户下拉的分组显示，
                    与上面的「所有人」无关。用 datalist 复用已有标签，既省输入又避免同义重名。 */}
                <div>
                  <label className="mb-1 flex items-center gap-1 text-xs text-slate-500">
                    <span>{t("settings.accounts.accountGroup")}</span>
                    <SettingsInfoHint text={t("settings.accounts.accountGroupHint")} />
                  </label>
                  <input
                    value={editForm.accountGroup || ""}
                    onChange={e => setEditForm(f => ({ ...f, accountGroup: e.target.value }))}
                    list="account-group-label-options"
                    placeholder={t("settings.accounts.accountGroupPlaceholder")}
                    className={FIELD_INPUT_CLS}
                  />
                  <datalist id="account-group-label-options">
                    {accountGroupLabelOptions.map((label) => (
                      <option key={label} value={label} />
                    ))}
                  </datalist>
                </div>
                {/* 信用卡（2026-11-22 用户裁定）：不提供手工选择上级账户，多币种改造走下方勾选开关。
                    其他资金账户仍保留上级账户下拉；历史数据已有归属时仍显示，方便解除。 */}
                {editKind !== "bank_credit" && !editingAccount.isAggregate && (supportsHierarchy || Boolean(editForm.parentId)) && (
                  <div>
                    {/* 表单里不再写解释长句：「父账户只统计不记账」「怎么产生父账户」都收进 i 图标悬浮。
                        「改为多币种父账户」是下拉底部的动作行，同样只在悬浮时给出后果说明。 */}
                    <label className="mb-1 flex items-center gap-1 text-xs text-slate-500">
                      <span>{t("settings.accounts.parentAccount")}</span>
                      <SettingsInfoHint
                        text={parentOptionsForKind.length === 0
                          ? t("settings.accounts.parentAccountEmpty")
                          : editForm.parentId
                            ? t("settings.accounts.parentAccountHint")
                            : t("settings.accounts.parentAccountNoneHint")}
                      />
                    </label>
                    <SmartSelect mode="single" value={editForm.parentId || ""}
                      onChange={id => setEditForm(f => ({ ...f, parentId: id }))}
                      options={parentOptionsForKind}
                      placeholder={t("settings.accounts.parentAccountNone")}
                      behavior={{
                        // 触发器和同排输入框一样高（h-8），否则整行高度参差不齐。
                        density: "compact",
                        // 下拉比单元格宽：底部动作行带一句后果说明，挤在 130px 的格子里会被截断。
                        minDropdownWidth: 264,
                        // 子账户不能再升级成父账户（服务端同样拒绝），先解除归属保存后再升级；
                        // 非资金账户不允许升级为多币种父账户。
                        footerAction: !editForm.parentId && supportsHierarchy
                          ? {
                              label: upgradingMultiCurrency
                                ? t("settings.accounts.parentAccountUpgrading")
                                : t("settings.accounts.parentAccountUpgrade"),
                              hint: t("settings.accounts.parentAccountUpgradeInlineHint"),
                              title: t("settings.accounts.parentAccountUpgradeHint"),
                              icon: <Layers className="h-3.5 w-3.5" />,
                              tone: "accent",
                              disabled: upgradingMultiCurrency,
                              onClick: () => void upgradeEditingAccountToMultiCurrency(editingAccount),
                            }
                          : undefined,
                      }}
                    />
                  </div>
                )}
                {editKind === "bank_credit" && (
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={editingAccount.isAggregate === true}
                      disabled={editingAccount.isAggregate === true || Boolean(editForm.parentId) || upgradingMultiCurrency}
                      onChange={() => void upgradeEditingAccountToMultiCurrency(editingAccount)}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-600"
                    />
                    <div className="min-w-0">
                      <label className="block text-xs font-medium text-slate-700">
                        {t("settings.accounts.createAggregateLabel")}
                      </label>
                      <div className="mt-0.5 text-[11px] leading-4 text-slate-500">
                        {t("settings.accounts.parentAccountUpgradeInlineHint")}
                      </div>
                    </div>
                  </div>
                )}
                {supportsInstitution && (
                  <div>
                    <label className={FIELD_LABEL_CLS}>{t("settings.accounts.institution")}</label>
                    <div className={loanLockedWrapperCls}>
                      <SmartSelect mode="single" value={editForm.institutionId || ""}
                        onChange={changeEditInstitution}
                        options={filteredInstitutions.map(i => ({
                          id: i.id,
                          label: institutionFullName(i),
                          subLabel: institutionKindLabel(i.type),
                        }))}
                        placeholder={t("settings.accounts.selectInstitution")}
                        behavior={{ density: "compact" }}
                        onCreateClick={() => setNestedEntityType("institution")} createLabel={t("settings.accounts.addInstitution")} />
                    </div>
                  </div>
                )}
                {editKind === "settlement" && (
                  <div>
                    <label className={FIELD_LABEL_CLS}>{t("txForm.counterparty")}</label>
                    <select
                      value={editForm.counterpartyId || ""}
                      onChange={(e) => setEditForm((f) => {
                        // When switching objects, follow the new object's value;
                        // never carry the previous object's object-level value over.
                        const nextCp = counterparties.find((counterparty) => counterparty.id === e.target.value);
                        return { ...f, counterpartyId: e.target.value, counterpartyReimbursable: (nextCp?.isReimbursable === true).toString() };
                      })}
                      disabled={loanEditLocked}
                      className={FIELD_INPUT_CLS}
                    >
                      <option value="">{t("liabilityTx.placeholder.selectCounterparty")}</option>
                      {settlementCounterparties.map((counterparty) => (
                        <option key={counterparty.id} value={counterparty.id}>{counterparty.shortName?.trim() || counterparty.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {editKind === "settlement" && (
                  <div>
                    <label className={FIELD_LABEL_CLS}>{t("institutionEdit.reimbursable")}</label>
                    <select
                      value={editForm.counterpartyReimbursable || "false"}
                      onChange={(e) => setEditForm((f) => ({ ...f, counterpartyReimbursable: e.target.value }))}
                      disabled={loanEditLocked || !editingCounterparty}
                      className={FIELD_INPUT_CLS}
                    >
                      <option value="true">{t("settings.counterparties.reimbursableYes")}</option>
                      <option value="false">{t("settings.counterparties.reimbursableNo")}</option>
                    </select>
                    {editingCounterparty ? (
                      <p className="mt-1 text-[11px] leading-4 text-slate-400">
                        {tf("settings.accounts.reimbursableObjectHint", { name: editingCounterparty.shortName?.trim() || editingCounterparty.name })} {t("institutionEdit.reimbursableHint")}
                      </p>
                    ) : null}
                  </div>
                )}
                <div>
                  <label className={FIELD_LABEL_CLS}>{t("settings.accounts.currency")}</label>
                  <select
                    value={normalizeCurrency(editForm.currency || baseCurrency)}
                    onChange={e => setEditForm(f => ({ ...f, currency: e.target.value }))}
                    // 父账户是统计单元：币种固定为账簿本位币（服务端同样强制）。
                    disabled={loanEditLocked || hasRecords || editingAccount.isAggregate === true}
                    className={FIELD_INPUT_CLS}
                  >
                    {CURRENCY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{t(`entityForm.currency.${option.value.toLowerCase()}`)}</option>
                    ))}
                  </select>
                </div>
                {isInvestmentKind && (
                  isFixedAssetKind ? (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("fixedAssetEdit.assetType")}</label>
                      <select
                        value={editForm.fixedAssetType || "property"}
                        onChange={e => setEditForm(f => ({ ...f, fixedAssetType: e.target.value }))}
                        className={FIELD_INPUT_CLS}
                      >
                        {FIXED_ASSET_TYPES.map((value) => (
                          <option key={value} value={value}>{t(`fixedAsset.type.${value}`)}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.investmentAccountType")}</label>
                      <select value={editInvestProductType} onChange={e => setEditForm(f => {
                        const nextInvestProductType = e.target.value;
                        const selectedInstitution = institutions.find((institution) => institution.id === f.institutionId);
                        return {
                          ...f,
                          investProductType: nextInvestProductType,
                          ...(isStockInvestmentAccount(editKind, nextInvestProductType) && selectedInstitution && !isStockAccountInstitutionType(selectedInstitution.type) ? { institutionId: "" } : {}),
                        };
                      })}
                        disabled={hasRecords}
                        className={FIELD_INPUT_CLS}>
                        {investmentProductTypeOptions.map((item) => <option key={item.value} value={item.value}>{investmentLabel(item.value)}</option>)}
                      </select>
                    </div>
                  )
                )}
              </div>
              </EditSection>

              {isInvestmentKind && (
                <EditSection title={t("settings.accounts.editSectionInvest")} className="mt-4 rounded-lg border border-slate-200/60 bg-slate-50/50 p-3">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 md:grid-cols-4">
                  {showCostBasisMethod && (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.costBasisMethod")}</label>
                      <select value={editForm.costBasisMethod || "moving_avg"} onChange={e => setEditForm(f => ({ ...f, costBasisMethod: e.target.value }))}
                        className={FIELD_INPUT_CLS}>
                        <option value="moving_avg">{t("settings.accounts.movingAverage")}</option>
                        <option value="fifo">{t("settings.accounts.fifo")}</option>
                        <option value="lifo">{t("settings.accounts.lifo")}</option>
                      </select>
                    </div>
                  )}
                  {editInvestProductType === "fund" && (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.fundUnitsDecimals")}</label>
                      <input
                        value={editForm.fundUnitsDecimals || "2"}
                        onChange={e => setEditForm(f => ({ ...f, fundUnitsDecimals: e.target.value }))}
                        className={FIELD_INPUT_CLS}
                        inputMode="numeric"
                        placeholder={t("settings.accounts.defaultUnitsDecimals")}
                      />
                    </div>
                  )}
                  {supportsTradingCalendarForAccount(editKind, editInvestProductType) && (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.tradingCalendar")}</label>
                      <select
                        value={editForm.tradingCalendar || "cn_fund"}
                        onChange={e => setEditForm(f => ({ ...f, tradingCalendar: e.target.value }))}
                        className={FIELD_INPUT_CLS}
                      >
                        {TRADING_CALENDARS.map((calendar) => (
                          <option key={calendar} value={calendar}>{t(`tradingCalendar.${calendar}`)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                </EditSection>
              )}

              {supportsLastFour && (
                <EditSection title={t("settings.accounts.editSectionCard")} className="mt-4 rounded-lg border border-slate-200/60 bg-slate-50/50 p-3">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 md:grid-cols-4">
                  {isBillLikeKind && (
                    <>
                      {/* 账单日与还款日都不在这里单独放字段：银行通常两者一起改，所以都由
                          下方的「账单日 / 还款日变更记录」按生效日期管理。 */}
                      <div>
                        <label className={FIELD_LABEL_CLS}>{t("settings.accounts.creditLimitLabel")}</label>
                        <CalcInput
                          value={editForm.creditLimit || ""}
                          onChange={(value) => setEditForm((f) => ({ ...f, creditLimit: value }))}
                          label={t("settings.accounts.creditLimitLabel")}
                          precision={2}
                          compact
                          inputClassName={`${FIELD_INPUT_CLS} pr-6`}
                        />
                      </div>
                    </>
                  )}
                  {isBillLikeKind && (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.billingDayTxPeriodLabel")}</label>
                      <select
                        value={editForm.billingDayTxPeriod || "current"}
                        onChange={e => setEditForm(f => ({ ...f, billingDayTxPeriod: e.target.value }))}
                        className={FIELD_INPUT_CLS}
                      >
                        <option value="current">{t("settings.accounts.billingDayTxPeriod.current")}</option>
                        <option value="next">{t("settings.accounts.billingDayTxPeriod.next")}</option>
                      </select>
                    </div>
                  )}
                  <div>
                    <label className={FIELD_LABEL_CLS}>{t("settings.accounts.lastFourLabel")}</label>
                    <input value={editForm.numberMasked || ""} onChange={e => setEditForm(f => ({ ...f, numberMasked: e.target.value }))}
                      className={FIELD_INPUT_CLS} />
                  </div>
                  {isBillLikeKind && (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.cardRole")}</label>
                      <select
                        value={editForm.cardRole || "primary"}
                        onChange={e => setEditForm(f => ({
                          ...f,
                          cardRole: e.target.value,
                          ...(e.target.value === "supplementary"
                            ? {} : { cardHolderName: "", primaryCardId: "" }),
                        }))}
                        className={FIELD_INPUT_CLS}
                      >
                        <option value="primary">{t("settings.accounts.cardRolePrimary")}</option>
                        <option value="supplementary">{t("settings.accounts.cardRoleSupplementary")}</option>
                      </select>
                    </div>
                  )}
                  {/* 附属卡的账单无条件并入主卡，账单模式对它无意义，不显示。 */}
                  {isBillLikeKind && !isSupplementaryCard && (
                    <div>
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.billMode")}</label>
                      <select
                        value={editForm.creditBillMode === "supplementary" ? "separate" : editForm.creditBillMode || "separate"}
                        onChange={e => setEditForm(f => ({ ...f, creditBillMode: e.target.value }))}
                        className={FIELD_INPUT_CLS}
                      >
                        <option value="separate">{t("settings.accounts.separateBill")}</option>
                        <option value="consolidated">{t("settings.accounts.consolidatedBill")}</option>
                      </select>
                    </div>
                  )}
                  {isSupplementaryCard && (
                    <>
                      <div>
                        <label className={FIELD_LABEL_CLS}>{t("settings.accounts.cardHolderName")}</label>
                        <input
                          value={editForm.cardHolderName || ""}
                          onChange={e => setEditForm(f => ({ ...f, cardHolderName: e.target.value }))}
                          className={FIELD_INPUT_CLS}
                        />
                      </div>
                      <div>
                        <label className={FIELD_LABEL_CLS}>{t("settings.accounts.primaryCard")}</label>
                        <SmartSelect
                          mode="single"
                          value={editForm.primaryCardId || ""}
                          onChange={id => setEditForm(f => ({ ...f, primaryCardId: id }))}
                          options={primaryCardOptions}
                          placeholder={t("settings.accounts.selectPrimaryCard")}
                          searchable
                          behavior={{ density: "compact" }}
                        />
                      </div>
                    </>
                  )}
                </div>
                </EditSection>
              )}

              {isBillLikeKind && editingBillingAccount ? (
                // 这张表自带卡片头（标题 + 「新增」按钮），外面不再套分区标题，避免重复。
                <div className="mt-4">
                  <CreditCardBillingDayRulesTable
                    accountId={editingBillingAccount.id}
                    rules={billingDayRules}
                    onRulesChanged={setBillingDayRules}
                    billingDay={editingBillingAccount.billingDay}
                    // 账户级还款日只作为「记录里没写」时的默认值；口径由它是否有 offset 决定。
                    repaymentDay={editingBillingAccount.repaymentDay ?? null}
                    repaymentOffsetDays={editingBillingAccount.repaymentOffsetDays ?? null}
                  />
                  {billingDayRulesLoading ? <div className="mt-1 text-xs text-slate-400">{t("common.loading")}</div> : null}
                  {!billingDayRulesLoading && billingDayRulesError ? (
                    <div className="mt-1 text-xs text-rose-600">{billingDayRulesError}</div>
                  ) : null}
                </div>
              ) : null}

              <EditSection title={t("settings.accounts.note")} className="mt-4">
                <ClearableNoteField
                  multiline
                  value={editForm.note || ""}
                  onValueChange={value => setEditForm(f => ({ ...f, note: value }))}
                  className="min-h-[76px] w-full resize-y rounded-md border border-slate-200 px-2 py-2 text-sm leading-5 outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  placeholder={t("settings.accounts.notePlaceholder")}
                  rows={3}
                />
              </EditSection>

              {isInvestmentKind && editInvestProductType === "fund" ? (
                <EditSection title={t("fundRules.title")} className="mt-4">
                  <div className="mb-2 text-[11px] text-slate-400">{t("fundConfirmDays.embeddedHint")}</div>
                  <FundConfirmDaysPanel
                    accountId={editingAccount.id}
                    compact
                    onSaved={() => {
                      dispatchFinanceDataChanged({ reason: "fund-confirm-days:save", accountIds: [editingAccount.id] });
                    }}
                  />
                </EditSection>
              ) : null}

              </div>
              {/* 按钮行移出滚动区：移动端整屏弹窗里，保存按钮要贴底不动，
                  不能跟着长表单（备注、基金规则、账单日历史）滚到看不见的地方。
                  桌面端仍是内容末尾的一行小按钮，视觉与改动前一致。 */}
              <div className="shrink-0 border-t border-slate-100 bg-white px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:px-4 md:pb-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-end">
                  {editError ? <div className="text-xs text-red-600 md:mr-auto">{editError}</div> : null}
                  <div className="flex gap-2 md:justify-end">
                    <button
                      type="button"
                      onClick={() => void saveEdit({ closeAfter: false })}
                      className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 transition-colors active:bg-slate-100 md:h-8 md:flex-none md:rounded-md md:px-3 md:text-xs md:hover:bg-slate-50"
                    >
                      {t("common.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void saveEdit({ closeAfter: true })}
                      className="inline-flex h-11 flex-[1.4] items-center justify-center rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700 md:h-8 md:flex-none md:rounded-md md:px-4 md:text-xs md:hover:bg-blue-700"
                    >
                      {t("settings.accounts.saveAndClose")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </ModalLayer>

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
              changeEditOwner(id);
            }
            void refreshSettingsAccounts(nestedEntityType === "institution" ? "institution:create-nested" : "account-group:create-nested");
            setNestedEntityType(null);
          }}
          defaultType={
            nestedEntityType !== "institution" ? undefined
              : isStockInvestmentAccount(editForm.kind, editForm.investProductType || "fund") ? "brokerage"
              : editForm.kind === "investment" && (["fund", "money"].includes(editForm.investProductType || "fund")) ? "fund_company"
              // 电子钱包的机构已放开（银行/基金公司/证券等），新增机构仍默认第三方支付。
              : editForm.kind === "ewallet" ? "payment"
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
    </>
  );
}
