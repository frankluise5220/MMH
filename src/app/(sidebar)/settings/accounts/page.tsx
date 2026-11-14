"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote, Layers, Trash2, X, CornerDownRight, Plus, Pencil, SlidersHorizontal, Check, ChevronDown, ChevronRight, ChevronsUpDown, ChevronsDownUp } from "lucide-react";
import { TransparentSideNavButtons } from "@/components/TransparentSideNavButtons";
import type { AccountKind } from "@prisma/client";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { institutionTypeLabel, isSettlementCounterpartyType, kindIconName, kindColor, kindOrder } from "@/lib/account-kinds";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSortState } from "@/components/AdvancedDataTable";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { CalcInput } from "@/components/CalcInput";
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
import { CreditCardBillingDayRulesTable } from "@/components/CreditCardBillingDayRulesTable";
import { AccountBatchImportButton } from "@/components/settings/AccountBatchImportButton";
import type { CreditBillingDayRuleView } from "@/lib/credit/billing-day-rules";
import { SettingsActionButton, SettingsInfoHint, SettingsPageHeader, useHideSettingDescriptions } from "@/components/settings/SettingsPageScaffold";
import { SwipeActionRow, type SwipeActionItem } from "@/components/SwipeActionRow";
import SettingsSwitch from "@/components/settings/SettingsSwitch";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { institutionFullName } from "@/lib/institution-display";
import { accountOwnerNameById, buildAccountOwnerOptions } from "@/lib/account-owner-options";
import { getCreditCardLabelTemplatePreference } from "@/lib/client/appPreferences";
import { fetchInternalAccountBalances } from "@/lib/client/account-balances-fetch";
import { readAccountDisplaySettings } from "@/lib/client/account-display-settings";
import {
  fetchSettingsAccountData,
  getCachedSettingsAccountData,
  notifySettingsDataChanged,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  accountKindOptionsForEdit,
  accountRecordLockErrorKey,
  getInvestmentAccountView,
  isDepositAccount,
  supportsMultiCurrencyHierarchy,
} from "@/lib/account-kind-utils";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { supportsTradingCalendarForAccount, TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { useI18n } from "@/lib/i18n";
import { CredentialPasswordField } from "@/components/CredentialPasswordField";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { CURRENCY_OPTIONS, normalizeCurrency } from "@/lib/currency";
import { formatCurrencyMoney } from "@/lib/format";
import { getColorSchemeFromCookie, pnlColor, type ColorScheme } from "@/lib/client/colors";
import { formatDateDisplay } from "@/lib/date-utils";
import {
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  allowedInstitutionTypesForAccount,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";

/* ---- 移动端筛选抽屉用的小组件 ---- */
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "inline-flex h-9 max-w-full items-center gap-1 rounded-full px-3 text-[13px] transition-colors",
        active ? "bg-slate-900 font-medium text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 active:bg-slate-50",
      ].join(" ")}
    >
      {active ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </button>
  );
}

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

/** 多选切换：保持点击顺序（与 AccountScopeFilter 的选择语义一致）。 */
function toggleFilterId(list: string[], id: string) {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

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
  creditBillMode?: "separate" | "consolidated";
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
};

/**
 * 账户列表分组维度（表头下拉）。`none` = 现有平铺状态。
 * 与「设置 → 显示 → 账户下拉分组」无关：那是记账下拉的口径，这里是账户列表的视图。
 */
const ACCOUNT_GROUP_BY_VALUES = ["none", "owner", "institution", "kind", "groupLabel"] as const;
type AccountGroupBy = (typeof ACCOUNT_GROUP_BY_VALUES)[number];
const ACCOUNT_GROUP_BY_STORAGE_KEY = "mmh_settings_accounts_group_by_v1";
const ACCOUNT_GROUP_BY_LABEL_KEYS: Record<AccountGroupBy, string> = {
  none: "settings.accounts.groupByNone",
  owner: "settings.accounts.groupByOwner",
  institution: "settings.accounts.groupByInstitution",
  kind: "settings.accounts.groupByKind",
  groupLabel: "settings.accounts.groupByGroupLabel",
};

/** 余额列用到的账户余额快照（GET /api/v1/accounts/internal 的子集）。 */
type AccountBalanceSnapshot = {
  balance: number;
  convertedBalance: number | null;
  currency: string;
  baseCurrency: string;
  fxRateMissing: boolean;
  /** 多币种子账户：余额是原币，父账户余额已是子户折本位币之和，统计只能算根账户。 */
  parentId: string | null;
};

/** 分组表头行携带的统计结果。 */
type AccountGroupSummary = {
  key: string;
  label: string;
  count: number;
  /** 本位币折算合计（跨币种组也能相加）。 */
  convertedTotal: number;
  /** 组内只有一种币种时的原币合计，便于用户直接对上账户金额。 */
  singleCurrency: { currency: string; amount: number } | null;
  byCurrency: Array<{ currency: string; amount: number }>;
  missingFx: boolean;
  /** 组是否收起。默认收起：组头保留账户数与合计，点组头展开。 */
  collapsed: boolean;
  /** 「分不出组」的组（无所有人 / 无机构 / 无分组标签），排序固定沉底。 */
  unclassified: boolean;
};

/**
 * 分组表头在 ADT 里以「伪账户行」呈现（ADT 没有行分组能力，组头必须占一行）。
 * 任何拿 Account 做事的回调都必须先过 `isGroupSummaryRow` 守卫。
 */
type AccountTableRow = Account & { groupSummary?: AccountGroupSummary };

function isGroupSummaryRow(row: Account): row is AccountTableRow & { groupSummary: AccountGroupSummary } {
  return Boolean((row as AccountTableRow).groupSummary);
}

/** 软删除记录预览行（GET /api/v1/entries/deleted 的 data.records 元素）。 */
type DeletedRecord = {
  id: string;
  date: string;
  postedAt: string | null;
  type: string;
  amount: string;
  currency: string;
  note: string | null;
  categoryName: string | null;
  accountId: string;
  accountName: string;
  toAccountId: string | null;
  toAccountName: string | null;
  deletedAt: string | null;
  source: string | null;
  fundCode: string | null;
  fundName: string | null;
  fundSubtype: string | null;
  metalTypeName: string | null;
  insuranceProductName: string | null;
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

function getAccountDetailHref(account: Account) {
  const query = new URLSearchParams();
  if (account.kind === "loan" || account.kind === "settlement") {
    // Match the sidebar's per-person liability entry instead of selecting a detail account.
    query.set("view", "liability");
    query.set("liabilityPerson", `account:${account.id}`);
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
  // 说明类文案跟随首次使用向导开关：只在「新手期」显示，关掉向导后不再啰嗦。
  const hideSettingDescriptions = useHideSettingDescriptions();
  // 余额配色跟随「系统设置 → 涨跌颜色」：红涨绿跌（默认）时正数红、负数绿，绿涨红跌时相反。
  // 首帧先按默认值渲染，挂载后再读 cookie，避免服务端与客户端 className 不一致。
  const [colorScheme, setColorScheme] = useState<ColorScheme>("red_up_green_down");
  useEffect(() => {
    setColorScheme(getColorSchemeFromCookie(document.cookie ?? null));
  }, []);
  const amountClass = useCallback((value: number) => pnlColor(value, colorScheme, "muted"), [colorScheme]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loanCategories, setLoanCategories] = useState<LoanCategoryView[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  // 内存缓存未命中时首屏 accounts=[]；没有 loading 会误显示「暂无账户」。
  const [loadingAccounts, setLoadingAccounts] = useState(() => !getCachedSettingsAccountData());
  const [scope, setScope] = useState<AccountScopeValue>({ userIds: [], institutionIds: [], accountIds: [] });
  const [selectedAccountKinds, setSelectedAccountKinds] = useState<string[]>([]);
  const [hideInactiveAccounts, setHideInactiveAccounts] = useState(false);
  const [swipedAccountId, setSwipedAccountId] = useState<string | null>(null);
  // 移动端：类型页签（单选，"all" = 全部）+ 筛选抽屉开关。桌面端的类型多选下拉不受影响。
  const [mobileKindTab, setMobileKindTab] = useState("all");
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [mobileInstitutionQuery, setMobileInstitutionQuery] = useState("");
  const mobileListRef = useRef<HTMLDivElement | null>(null);
  const [baseCurrency, setBaseCurrency] = useState("CNY");
  const [accountNameQuery, setAccountNameQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editFormBaseline, setEditFormBaseline] = useState<Record<string, string>>({});
  const [billingDayRules, setBillingDayRules] = useState<CreditBillingDayRuleView[]>([]);
  const [billingDayRulesLoading, setBillingDayRulesLoading] = useState(false);
  // 规则表加载失败时必须可见：静默退化成「暂无记录」会让用户以为规则丢了。
  const [billingDayRulesError, setBillingDayRulesError] = useState("");
  const [editError, setEditError] = useState("");
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [upgradingMultiCurrency, setUpgradingMultiCurrency] = useState(false);
  // ADT 表格当前视图（筛选+列排序后的全量行）：编辑弹窗的上一/下一导航沿此顺序。
  const [displayRows, setDisplayRows] = useState<Account[]>([]);
  // 账户列表分组维度（表头下拉）。none = 现有平铺状态。
  const [accountGroupBy, setAccountGroupByState] = useState<AccountGroupBy>("none");
  // 分组默认全部收起。这里只记「用户手动展开过的组」，所以新出现/切换维度后天然是收起态。
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(() => new Set());
  // 余额快照：服务端 /internal 已按各账户口径算好（投资市值、存单、信用卡当期、负债），
  // 前端只做展示，绝不重算，否则与侧边栏/首页对不上。
  const [balanceById, setBalanceById] = useState<Map<string, AccountBalanceSnapshot>>(new Map());
  const [balanceBaseCurrency, setBalanceBaseCurrency] = useState("CNY");
  const guideAccountSetup = searchParams.get("guide") === "accounts";

  // 可选的上级账户 = 家庭里的多币种父账户（聚合账户）。父账户自己不能再挂上级，
  // 所以编辑父账户时这个下拉不渲染；子账户可以改挂到别的父账户或解除归属。
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

  // 软删除记录预览弹窗（「待删」列点击打开）：预览 + 全选/逐条彻底删除。
  const [trashAccount, setTrashAccount] = useState<Account | null>(null);
  const [trashRecords, setTrashRecords] = useState<DeletedRecord[]>([]);
  const [trashTruncated, setTrashTruncated] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState("");
  const [trashSelectedIds, setTrashSelectedIds] = useState<string[]>([]);
  const [trashBusy, setTrashBusy] = useState(false);

  const loadAccountBalances = useCallback(async () => {
    const payload = await fetchInternalAccountBalances();
    const rows = payload?.accounts;
    if (!Array.isArray(rows)) return;
    const next = new Map<string, AccountBalanceSnapshot>();
    for (const raw of rows as Array<Record<string, unknown>>) {
      const id = String(raw.id ?? "").trim();
      if (!id) continue;
      const balance = Number(raw.balance ?? 0);
      const converted = raw.convertedBalance == null ? null : Number(raw.convertedBalance);
      next.set(id, {
        balance: Number.isFinite(balance) ? balance : 0,
        convertedBalance: converted != null && Number.isFinite(converted) ? converted : null,
        currency: normalizeCurrency(String(raw.currency ?? payload?.baseCurrency ?? "CNY")),
        baseCurrency: normalizeCurrency(String(raw.baseCurrency ?? payload?.baseCurrency ?? "CNY")),
        fxRateMissing: raw.fxRateMissing === true,
        parentId: raw.parentId ? String(raw.parentId) : null,
      });
    }
    setBalanceById(next);
    if (payload?.baseCurrency) setBalanceBaseCurrency(normalizeCurrency(payload.baseCurrency));
  }, []);

  // 分组维度是纯设备视图状态（与账簿数据无关），落 localStorage 即可。
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ACCOUNT_GROUP_BY_STORAGE_KEY);
      if (saved && (ACCOUNT_GROUP_BY_VALUES as readonly string[]).includes(saved)) {
        setAccountGroupByState(saved as AccountGroupBy);
      }
    } catch {
      // 隐私模式读不到 localStorage 就用默认值，不打断页面。
    }
  }, []);

  const setAccountGroupBy = useCallback((next: AccountGroupBy) => {
    setAccountGroupByState(next);
    // 换分组维度后组 key 全变了，旧的展开记录没有意义，直接回到「全部收起」。
    setExpandedGroupKeys(new Set());
    try {
      window.localStorage.setItem(ACCOUNT_GROUP_BY_STORAGE_KEY, next);
    } catch {
      // 写不进去只影响下次打开时的记忆，不影响本次视图。
    }
  }, []);

  const toggleAccountGroup = useCallback((key: string) => {
    setExpandedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
    // 余额与账户清单并行拉：两个接口各自 coalesce，不阻塞列表首屏。
    void loadAccountBalances();
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
  }, [loadAccountBalances]);

  // Set right before this page publishes its own change event: the listener
  // below skips that single event because the page already awaits loadAll.
  const selfRefreshRef = useRef(false);

  const refreshSettingsAccounts = useCallback(async (reason: string) => {
    selfRefreshRef.current = true;
    void notifySettingsDataChanged({ scope: "accounts", reason, prefetch: true });
    await loadAll({ force: true });
    dispatchFinanceDataChanged({ reason: "settings-accounts-change" });
  }, [loadAll]);

  // Basic data changed from another dialog in this window (nested institution /
  // counterparty / group, account type quick edit, ...) must refresh the option
  // lists here, otherwise a mounted page keeps its stale snapshot.
  useEffect(() => {
    const onSettingsChanged = (event: Event) => {
      const detail = (event as CustomEvent<SettingsDataChangedDetail>).detail;
      const scope = detail?.scope ?? "all";
      if (scope !== "accounts" && scope !== "all") return;
      if (selfRefreshRef.current) {
        selfRefreshRef.current = false;
        return;
      }
      void loadAll({ force: true });
    };
    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [loadAll]);

  // 正在编辑的信用卡账户：账单日设置走「账单日设置」弹窗（按生效日期的规则表），
  // 这里只读展示当前生效值：账单日 · 还款日（固定日 / 账单日后 N 天）· 交易归属期。
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
      creditBillMode: a.creditBillMode === "consolidated" ? "consolidated" : "separate",
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

  async function changeEditInstitution(institutionId: string) {
    setEditForm((current) => ({ ...current, institutionId }));
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
      creditBillMode: result.data.creditBillMode === "consolidated" ? "consolidated" : "separate",
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

  const toggleActive = useCallback(async (id: string) => {
    await fetch("/api/v1/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    void refreshSettingsAccounts("account:toggle-active");
  }, [refreshSettingsAccounts]);

  // 多币种父子层级（2026-10-18 用户裁定）：父账户是统计单元、子账户是记账单元。
  // 账户设置里必须能看到「谁归属谁」，否则升级/拆分后这一层关系在设置侧完全不可见。
  const accountNameById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.name])),
    [accounts],
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

  const accountDisplayOption = (account: Account) => buildAccountDisplayOption(
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
    getCreditCardLabelTemplatePreference(), readAccountDisplaySettings());

  const accountDisplayName = (account: Account) => accountDisplayOption(account).label;

  const normalizeSearchText = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
  const accountMatchesNameQuery = (account: Account, query: string) => {
    const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    const haystack = [
      account.name,
      accountDisplayName(account),
      // 子账户也能用父账户名搜到；父账户能按「多币种」搜到。
      account.parentId ? accountNameById.get(account.parentId) ?? "" : "",
      account.isAggregate ? t("settings.accounts.hierarchyMultiCurrency") : "",
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
    name: institutionFullName(institution),
    type: institution.type,
  }));
  // 「账户所有人」一律按配对家庭成员的姓名展示（见 src/lib/account-owner-options.ts）：
  // 选项 value 仍是分组 id，只换展示名；在家庭成员或账户所有人任一处改名都双向同步。
  const ownerOptions = useMemo(
    () => buildAccountOwnerOptions(
      groups,
      institutions.filter((institution) => institution.type === "family_member"),
    ),
    [groups, institutions],
  );
  const ownerNameByGroupId = useMemo(() => accountOwnerNameById(ownerOptions), [ownerOptions]);
  const statisticsUsers: StatisticsUserItem[] = ownerOptions;
  const accountKindFilterOptions = useMemo(() => kindOrder.filter((kind) =>
    accounts.some((account) => normalizedAccountKind(account) === kind),
  ), [accounts]);

  // ---- Account merge: allow merging exactly 2 accounts with the same type,
  // same owner, and same institution (currency and, for investment/loan
  // accounts, product type / liability direction must also match). ----
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
    if ((first.kind === "loan" || first.kind === "settlement") && (first.liabilityDirection ?? "") !== (second.liabilityDirection ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.liabilityDirection") };
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

  // 已有分组标签：编辑弹窗用 datalist 提供候选，避免用户把「日常」「日常开销」写成两套。
  const accountGroupLabelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const account of accounts) {
      const label = (account.accountGroup ?? "").trim();
      if (label) seen.add(label);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [accounts]);

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

  /**
   * 账户列表分组渲染（2026-11-13）：ADT 没有行分组能力，组头以「伪账户行」插在每组前面
   * （id 前缀 `__group__:`，靠 groupSummary 识别），账户行原样跟在组头后面，名称列缩进。
   * 组统计只加根账户（多币种子账户的余额是原币，父账户余额已是子户折本位币之和）。
   */
  const accountTableRows = useMemo<AccountTableRow[]>(() => {
    if (accountGroupBy === "none") return filteredAccounts;

    // unclassified：该维度下「分不出组」的账户（没有归属人 / 没有机构 / 没有分组标签），
    // 排序时统一沉到最后，不参与组序号与名称排序。
    const buckets = new Map<string, { label: string; order: number; unclassified: boolean; rows: Account[] }>();
    const push = (key: string, label: string, order: number, account: Account, unclassified = false) => {
      const bucket = buckets.get(key);
      if (bucket) bucket.rows.push(account);
      else buckets.set(key, { label, order, unclassified, rows: [account] });
    };

    for (const account of filteredAccounts) {
      switch (accountGroupBy) {
        case "owner": {
          const groupId = (account.groupId ?? "").trim();
          const ownerName = groupId
            ? ownerNameByGroupId.get(groupId) ?? account.AccountGroup?.name ?? ""
            : "";
          const order = groupId ? groups.findIndex((group) => group.id === groupId) : -1;
          push(
            groupId ? `owner:${groupId}` : "owner:none",
            ownerName || t("settings.accounts.groupOwnerNone"),
            order < 0 ? 9999 : order,
            account,
            !groupId,
          );
          break;
        }
        case "institution": {
          const institutionId = account.Institution?.id ?? account.institutionId ?? CASH_INSTITUTION_ID;
          const isSettlement = normalizedAccountKind(account) === "settlement";
          const label = isSettlement
            ? account.Counterparty?.shortName?.trim() || account.Counterparty?.name || ""
            : institutionFullName(account.Institution);
          push(
            `institution:${institutionId}`,
            label || t("settings.accounts.groupInstitutionNone"),
            0,
            account,
            !label,
          );
          break;
        }
        case "kind": {
          const kind = normalizedAccountKind(account);
          const order = kindOrder.indexOf(kind);
          push(`kind:${kind}`, accountKindLabel(kind), order < 0 ? 9999 : order, account);
          break;
        }
        case "groupLabel": {
          const label = (account.accountGroup ?? "").trim();
          push(
            label ? `label:${label}` : "label:none",
            label || t("settings.accounts.groupLabelNone"),
            0,
            account,
            !label,
          );
          break;
        }
        default:
          break;
      }
    }

    const ordered = Array.from(buckets.entries()).sort((a, b) => {
      // 「无法分组」组永远排在最下面，其余按组序号 + 名称排。
      if (a[1].unclassified !== b[1].unclassified) return a[1].unclassified ? 1 : -1;
      return a[1].order - b[1].order || a[1].label.localeCompare(b[1].label, "zh-Hans-CN");
    });

    const rows: AccountTableRow[] = [];
    for (const [key, bucket] of ordered) {
      const byCurrency = new Map<string, number>();
      let convertedTotal = 0;
      let missingFx = false;
      for (const account of bucket.rows) {
        const snapshot = balanceById.get(account.id);
        if (!snapshot) continue;
        if (snapshot.parentId) continue;
        byCurrency.set(snapshot.currency, (byCurrency.get(snapshot.currency) ?? 0) + snapshot.balance);
        if (snapshot.convertedBalance == null) missingFx = true;
        else convertedTotal += snapshot.convertedBalance;
      }
      const currencies = Array.from(byCurrency.entries())
        .map(([currency, amount]) => ({ currency, amount }))
        .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
      const collapsed = !expandedGroupKeys.has(key);
      const summary: AccountGroupSummary = {
        key,
        label: bucket.label,
        count: bucket.rows.length,
        convertedTotal,
        singleCurrency: currencies.length === 1 ? currencies[0] : null,
        byCurrency: currencies,
        missingFx,
        collapsed,
        unclassified: bucket.unclassified,
      };
      rows.push({
        id: `__group__:${key}`,
        name: bucket.label,
        kind: "cash",
        currency: balanceBaseCurrency,
        isActive: true,
        groupSummary: summary,
      } as unknown as AccountTableRow);
      // 收起的组只留组头——账户数与该组合计已经写在组头上了。
      if (collapsed) continue;
      rows.push(...[...bucket.rows].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")));
    }
    return rows;
  }, [
    accountGroupBy,
    expandedGroupKeys,
    filteredAccounts,
    balanceById,
    balanceBaseCurrency,
    groups,
    ownerNameByGroupId,
    t,
    accountKindLabel,
  ]);

  /**
   * 分组视图下的列头排序 = 排「组」：
   * 以「组头 + 组内账户」为块，按组头在该列上的值给块排序，块内账户顺序不动。
   * 组头值由各列 sortValue 决定（名称 → 组名，余额 → 组合计，其它列基本同值 → 保持分组维度顺序）。
   * （交给 ADT 默认排序会把组头伪行当普通行跟账户一起比，组头被打散到别的组中间。）
   * 平铺模式返回 null，交回 ADT 默认的整表排序。
   */
  const sortAccountRowGroups = useCallback(
    (rows: Account[], sortState: AdvancedDataTableSortState | null, columns: AdvancedDataTableColumn<Account>[]) => {
      if (accountGroupBy === "none" || !sortState) return null;
      const column = columns.find((item) => item.key === sortState.key);
      const readValue = column?.sortValue ?? column?.filterText;
      if (!readValue) return null;

      // 切成「组头 + 组内账户」的连续块；首行不是组头说明行结构不是分组视图，交回默认排序。
      const blocks: { head: Account; members: Account[] }[] = [];
      for (const row of rows) {
        if (isGroupSummaryRow(row)) blocks.push({ head: row, members: [] });
        else if (blocks.length === 0) return null;
        else blocks[blocks.length - 1].members.push(row);
      }

      // 与 ADT 默认排序保持同一口径：空值沉底、数字按大小、其它按本地化字符串、同值保持原序。
      const compare = (a: { value: unknown; index: number }, b: { value: unknown; index: number }) => {
        const aEmpty = a.value == null || a.value === "";
        const bEmpty = b.value == null || b.value === "";
        if (aEmpty || bEmpty) {
          if (aEmpty && bEmpty) return a.index - b.index;
          return aEmpty ? 1 : -1;
        }
        const compared = typeof a.value === "number" && typeof b.value === "number"
          ? a.value - b.value
          : String(a.value).localeCompare(String(b.value), "zh-CN", { numeric: true });
        if (compared === 0) return a.index - b.index;
        return sortState.direction === "asc" ? compared : -compared;
      };

      return blocks
        .map((block, index) => ({ block, index, value: readValue(block.head) }))
        .sort(compare)
        .flatMap((item) => [item.block.head, ...item.block.members]);
    },
    [accountGroupBy],
  );

  /**
   * 分组视图下的全部组 key（组头按维度全量输出，收起的组也有组头），给「全部展开」用。
   * 平铺模式下为空，两个全展开/全收起按钮随之隐藏。
   */
  const accountGroupRowKeys = useMemo(
    () => accountTableRows.filter(isGroupSummaryRow).map((row) => row.groupSummary.key),
    [accountTableRows],
  );
  const expandAllAccountGroups = useCallback(() => {
    setExpandedGroupKeys(new Set(accountGroupRowKeys));
  }, [accountGroupRowKeys]);
  const collapseAllAccountGroups = useCallback(() => {
    setExpandedGroupKeys(new Set());
  }, []);
  const allAccountGroupsExpanded =
    accountGroupRowKeys.length > 0 && accountGroupRowKeys.every((key) => expandedGroupKeys.has(key));

  // ---- 移动端：类型页签（单选） + 按类型分组 ----
  // 页签与桌面端的 selectedAccountKinds（多选下拉）互不影响：移动端是「浏览分组」，
  // 桌面端是「精细多选」，共用一个 state 会让两边互相打架。
  const mobileKindTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of filteredAccounts) {
      const kind = normalizedAccountKind(account);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [
      { key: "all", label: t("common.all"), count: filteredAccounts.length },
      ...kindOrder
        .filter((kind) => counts.has(kind))
        .map((kind) => ({ key: kind, label: accountKindLabel(kind), count: counts.get(kind) ?? 0 })),
    ];
  }, [filteredAccounts, t, accountKindLabel]);

  // 搜索或筛选把当前页签的类型清空后回落「全部」，否则页面会停在一个空分组上。
  useEffect(() => {
    if (mobileKindTab === "all") return;
    if (mobileKindTabs.some((tab) => tab.key === mobileKindTab)) return;
    setMobileKindTab("all");
  }, [mobileKindTab, mobileKindTabs]);

  const mobileAccounts = useMemo(
    () => (mobileKindTab === "all"
      ? filteredAccounts
      : filteredAccounts.filter((account) => normalizedAccountKind(account) === mobileKindTab)),
    [filteredAccounts, mobileKindTab],
  );

  const mobileAccountGroups = useMemo(() => {
    if (mobileKindTab !== "all") return [{ kind: mobileKindTab, items: mobileAccounts }];
    const buckets = new Map<string, Account[]>();
    for (const account of mobileAccounts) {
      const kind = normalizedAccountKind(account);
      const bucket = buckets.get(kind);
      if (bucket) bucket.push(account);
      else buckets.set(kind, [account]);
    }
    return kindOrder
      .filter((kind) => buckets.has(kind))
      .map((kind) => ({ kind, items: buckets.get(kind) ?? [] }));
  }, [mobileAccounts, mobileKindTab]);

  // 筛选抽屉的机构选项：口径与 filteredAccounts 一致（真实机构 id，无机构归「现金」）。
  const mobileScopeInstitutionOptions = useMemo(() => {
    const nameById = new Map(institutions.map((item) => [item.id, institutionFullName(item)]));
    const names = new Map<string, string>();
    for (const account of accounts) {
      const id = account.Institution?.id ?? account.institutionId ?? CASH_INSTITUTION_ID;
      if (names.has(id)) continue;
      names.set(id, id === CASH_INSTITUTION_ID
        ? t("statistics.cashInstitution")
        : (nameById.get(id) ?? account.Institution?.name ?? ""));
    }
    return Array.from(names, ([id, name]) => ({ id, name }))
      .filter((item) => item.name)
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }, [accounts, institutions, t]);

  const mobileScopeInstitutions = useMemo(() => {
    const query = mobileInstitutionQuery.trim().toLowerCase();
    if (!query) return mobileScopeInstitutionOptions;
    return mobileScopeInstitutionOptions.filter((item) => item.name.toLowerCase().includes(query));
  }, [mobileInstitutionQuery, mobileScopeInstitutionOptions]);

  const mobileActiveFilterCount =
    (scope.userIds.length > 0 ? 1 : 0)
    + (scope.institutionIds.length > 0 ? 1 : 0)
    + (hideInactiveAccounts ? 1 : 0);

  // 关抽屉时回到列表顶部：筛选后条数变化很大，停在原来的滚动位置容易看见空白。
  const closeMobileFilter = () => {
    setMobileFilterOpen(false);
    mobileListRef.current?.scrollTo({ top: 0 });
  };

  // ---- ADT 表格 ----
  // 键盘上下导航只能停在真账户上，分组表头（伪行）要滤掉。
  const navigationAccountsState = (displayRows.length > 0 ? displayRows : filteredAccounts)
    .filter((row) => !isGroupSummaryRow(row));

  // event 可为 null：移动端卡片列表的删除按钮不走「行点击冒泡」这一层，无需 stopPropagation。
  const handleDeleteClick = useCallback(async (event: React.MouseEvent | null, a: Account) => {
    event?.stopPropagation();
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

  // Shared by the dialog's Enter key and its confirm button so both submit the
  // same request (they used to duplicate the fetch body verbatim).
  const submitDeleteWithPassword = useCallback(async () => {
    if (!deleteTarget) return;
    const res = await fetch(`/api/v1/accounts?id=${deleteTarget.account.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: deletePassword }),
    });
    const data = await res.json();
    if (data.ok) {
      setDeleteTarget(null);
      void refreshSettingsAccounts("account:delete-with-password");
    } else {
      setDeleteError(data.error);
    }
  }, [deleteTarget, deletePassword, refreshSettingsAccounts]);

  // ---- 软删除记录预览与彻底删除（「待删」列入口） ----
  const openTrash = useCallback((a: Account) => {
    setTrashAccount(a);
    setTrashRecords([]);
    setTrashTruncated(false);
    setTrashSelectedIds([]);
    setTrashError("");
    setTrashLoading(true);
    void (async () => {
      try {
        const res = await fetch(`/api/v1/entries/deleted?accountId=${encodeURIComponent(a.id)}`, { cache: "no-store" });
        const data = await res.json().catch(() => null) as {
          ok?: boolean;
          data?: { records?: DeletedRecord[]; total?: number; truncated?: boolean };
        } | null;
        if (!res.ok || !data?.ok || !data.data) {
          setTrashError(t("settings.accounts.trash.loadFailed"));
          return;
        }
        setTrashRecords(data.data.records ?? []);
        setTrashTruncated(Boolean(data.data.truncated));
      } catch {
        setTrashError(t("settings.accounts.trash.loadFailed"));
      } finally {
        setTrashLoading(false);
      }
    })();
  }, [t]);

  const purgeTrashRecords = useCallback(async (ids: string[]) => {
    if (ids.length === 0 || !trashAccount) return;
    const confirmed = await showConfirmDialog({
      title: t("settings.accounts.trash.confirmTitle"),
      message: tf("settings.accounts.trash.confirmMessage", { count: ids.length }),
      tone: "danger",
    });
    if (!confirmed) return;
    setTrashBusy(true);
    setTrashError("");
    try {
      const res = await fetch("/api/v1/entries/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => null) as {
        ok?: boolean;
        permanentlyDeleted?: number;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok) {
        setTrashError(data?.error || t("settings.accounts.trash.deleteFailed"));
        return;
      }
      const removed = new Set(ids);
      setTrashRecords((prev) => prev.filter((record) => !removed.has(record.id)));
      setTrashSelectedIds((prev) => prev.filter((id) => !removed.has(id)));
      void refreshSettingsAccounts("entries:purge");
    } catch {
      setTrashError(t("settings.accounts.trash.deleteFailed"));
    } finally {
      setTrashBusy(false);
    }
  }, [trashAccount, t, tf, refreshSettingsAccounts]);

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
      cellTitle: (a) => [
        a.parentId ? tf("settings.accounts.hierarchyParentHint", { name: accountNameById.get(a.parentId) ?? "-", currency: a.currency }) : "",
        a.note ? `${a.name} · ${t("settings.accounts.notePrefix")}${a.note}` : a.name,
      ].filter(Boolean).join(" · "),
      render: (a) => {
        if (isGroupSummaryRow(a)) {
          const summary = a.groupSummary;
          const toggleHint = summary.collapsed
            ? t("settings.accounts.groupExpand")
            : t("settings.accounts.groupCollapse");
          // 「无法分组」的组固定沉底，title 里说明原因，免得用户以为排序坏了。
          const rowTitle = summary.unclassified
            ? `${toggleHint} · ${t("settings.accounts.groupUnclassifiedHint")}`
            : toggleHint;
          return (
            <div className="flex min-w-0 items-center gap-1.5" title={rowTitle}>
              {summary.collapsed
                ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />}
              <span className="truncate text-xs font-semibold text-slate-700">{summary.label}</span>
              <span className="shrink-0 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-normal tabular-nums text-slate-500">
                {tf("settings.accounts.groupAccountCount", { count: summary.count })}
              </span>
            </div>
          );
        }
        const parentName = a.parentId ? accountNameById.get(a.parentId) ?? "" : "";
        // 分组视图下账户相对组头缩进一格；多币种子账户在缩进基础上再退一级。
        const indentClass = accountGroupBy !== "none"
          ? (parentName ? "pl-8" : "pl-5")
          : (parentName ? "pl-3" : "");
        return (
          <div className={`flex min-w-0 items-center gap-1.5 ${indentClass}`}>
            {parentName ? <CornerDownRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden="true" /> : null}
            {a.isPlaceholder || a.isAggregate ? (
              // 聚合父账户没有明细，点进去只会是空列表（与侧边栏同一口径：只做折叠）。
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
            {a.isAggregate && (
              <span className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700">{t("settings.accounts.hierarchyMultiCurrency")}</span>
            )}
            {a.isPlaceholder && (
              <span className="shrink-0 rounded-full border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400">{t("settings.accounts.placeholder")}</span>
            )}
            {a.isConsumerLoan && (
              <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{t("account.kind.consumer_loan")}</span>
            )}
          </div>
        );
      },
    },
    {
      // 「归属」列：多币种子账户 → 父账户名；父账户 → 子账户数量。
      key: "hierarchy",
      label: t("settings.accounts.colHierarchy"),
      width: 170,
      minWidth: 120,
      truncate: true,
      hideable: true,
      sortValue: (a) => (a.parentId ? accountNameById.get(a.parentId) ?? "" : ""),
      filterText: (a) => {
        if (a.parentId) return accountNameById.get(a.parentId) ?? null;
        return a.isAggregate ? t("settings.accounts.hierarchyMultiCurrency") : null;
      },
      render: (a) => {
        if (a.parentId) {
          const parentName = accountNameById.get(a.parentId) ?? "";
          return parentName
            ? (
              <span
                className="truncate text-slate-600"
                title={tf("settings.accounts.hierarchyParentHint", { name: parentName, currency: a.currency })}
              >
                {parentName}
              </span>
            )
            : <span className="text-slate-300">-</span>;
        }
        if (a.isAggregate) {
          return (
            <span className="whitespace-nowrap rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
              {tf("settings.accounts.hierarchyChildCount", { count: subAccountCountByParentId.get(a.id) ?? 0 })}
            </span>
          );
        }
        return <span className="text-slate-300">-</span>;
      },
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
            {/* 类型徽章已经带色，副标签再上色就是「一行四五种颜色」——
                这里只用灰字补充产品类型，颜色留给状态语义（停用/占位/父账户）。 */}
            {normalizedKind === "investment" && (
              <span className="truncate text-[11px] text-slate-500" title={investmentLabel(a.investProductType)}>
                {investmentLabel(a.investProductType)}
              </span>
            )}
            {normalizedKind === "fixed_asset" && (
              <span className="truncate text-[11px] text-slate-500" title={fixedAssetTypeLabel(a.fixedAssetType)}>
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
      sortValue: (a) => ownerNameByGroupId.get(a.groupId ?? "") ?? a.AccountGroup?.name ?? "",
      filterText: (a) => ownerNameByGroupId.get(a.groupId ?? "") ?? a.AccountGroup?.name ?? null,
      render: (a) => {
        const ownerName = ownerNameByGroupId.get(a.groupId ?? "") ?? a.AccountGroup?.name;
        return ownerName
          ? <span className="text-slate-700">{ownerName}</span>
          : <span className="text-slate-300">-</span>;
      },
    },
    {
      key: "institution",
      label: t("settings.accounts.institution"),
      width: 170,
      minWidth: 120,
      truncate: true,
      sortValue: (a) => institutionFullName(a.Institution) || a.Counterparty?.shortName?.trim() || a.Counterparty?.name || "",
      filterText: (a) => (normalizedAccountKind(a) === "settlement"
        ? a.Counterparty?.shortName?.trim() || a.Counterparty?.name || null
        : institutionFullName(a.Institution) || null),
      render: (a) => {
        if (normalizedAccountKind(a) === "settlement") {
          const label = a.Counterparty?.shortName?.trim() || a.Counterparty?.name || "";
          return label ? <span className="text-slate-700">{label}</span> : <span className="text-slate-300">-</span>;
        }
        const label = institutionFullName(a.Institution);
        return label ? <span className="text-slate-700">{label}</span> : <span className="text-slate-300">-</span>;
      },
    },
    {
      // The reimbursable column is an object-level projection and is shown only
      // for settlement accounts whose counterparty is included in the account data.
      key: "reimbursable",
      label: t("settings.counterparties.reimbursable"),
      width: 84,
      minWidth: 64,
      sortValue: (a) => (normalizedAccountKind(a) === "settlement" ? (a.Counterparty?.isReimbursable === true ? 0 : 1) : 2),
      filterText: (a) => (normalizedAccountKind(a) === "settlement"
        ? (a.Counterparty?.isReimbursable === true ? t("settings.counterparties.reimbursableYes") : t("settings.counterparties.reimbursableNo"))
        : null),
      render: (a) => {
        if (normalizedAccountKind(a) !== "settlement") return <span className="text-slate-300">-</span>;
        const yes = a.Counterparty?.isReimbursable === true;
        return (
          <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium ${yes ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
            {yes ? t("settings.counterparties.reimbursableYes") : t("settings.counterparties.reimbursableNo")}
          </span>
        );
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
      // 余额列（2026-11-13）：口径全部由服务端 /api/v1/accounts/internal 算好
      // （投资按市值、存单按现金价值、信用卡按当期账单、负债带方向、多币种折算），
      // 这里只展示，绝不重算——重算就会和侧边栏/首页对不上。
      key: "balance",
      label: t("settings.accounts.colBalance"),
      width: 150,
      minWidth: 112,
      align: "right",
      hideable: true,
      sortValue: (a) => {
        // 分组视图按这一列排序时，比较的是「组的合计」而不是组内某个账户：
        // 单币种组给原币合计，跨币种组给本位币折算合计，与组头显示的 primary 数字同一口径。
        if (isGroupSummaryRow(a)) {
          const summary = a.groupSummary;
          return summary.singleCurrency ? summary.singleCurrency.amount : summary.convertedTotal;
        }
        const snapshot = balanceById.get(a.id);
        if (!snapshot) return Number.NEGATIVE_INFINITY;
        return snapshot.currency === snapshot.baseCurrency
          ? snapshot.balance
          : snapshot.convertedBalance ?? Number.NEGATIVE_INFINITY;
      },
      cellTitle: (a) => {
        if (isGroupSummaryRow(a)) {
          return a.groupSummary.byCurrency
            .map((item) => formatCurrencyMoney(item.amount, item.currency))
            .join(" · ");
        }
        const snapshot = balanceById.get(a.id);
        if (!snapshot) return "";
        if (snapshot.fxRateMissing) {
          return tf("settings.accounts.balanceFxMissing", { currency: snapshot.currency });
        }
        if (snapshot.currency === snapshot.baseCurrency) {
          return formatCurrencyMoney(snapshot.balance, snapshot.currency);
        }
        return `${formatCurrencyMoney(snapshot.balance, snapshot.currency)} ≈ ${formatCurrencyMoney(snapshot.convertedBalance ?? 0, snapshot.baseCurrency)}`;
      },
      filterText: () => null,
      render: (a) => {
        if (isGroupSummaryRow(a)) {
          const summary = a.groupSummary;
          const single = summary.singleCurrency;
          // 单币种组直接给原币合计（能和账户对得上）；跨币种组只有折算合计有意义。
          const total = single ? single.amount : summary.convertedTotal;
          const primary = single
            ? formatCurrencyMoney(single.amount, single.currency)
            : formatCurrencyMoney(summary.convertedTotal, balanceBaseCurrency);
          // 跨币种组的 primary 已经是本位币折算值，不能再重复一次；只有单币种外币组才补折算行。
          const hint = summary.missingFx
            ? t("settings.accounts.balanceFxMissingShort")
            : single && single.currency !== balanceBaseCurrency
              ? `≈ ${formatCurrencyMoney(summary.convertedTotal, balanceBaseCurrency)}`
              : "";
          return (
            <div className="flex min-w-0 flex-col items-end leading-tight">
              {/* 合计走统一的金额着色规则（正绿 / 负红 / 零灰），与组内账户行余额同一套颜色。 */}
              <span className={`tabular-nums text-xs font-semibold ${amountClass(total)}`}>{primary}</span>
              {hint ? <span className="text-[10px] font-normal text-slate-400">{hint}</span> : null}
            </div>
          );
        }
        const snapshot = balanceById.get(a.id);
        if (!snapshot) return <span className="text-slate-300">-</span>;
        const converted = snapshot.convertedBalance;
        const isForeign = snapshot.currency !== snapshot.baseCurrency && converted != null;
        return (
          <div className="flex min-w-0 flex-col items-end leading-tight">
            <span className={`tabular-nums ${amountClass(snapshot.balance)}`}>
              {formatCurrencyMoney(snapshot.balance, snapshot.currency)}
            </span>
            {isForeign ? (
              <span className="text-[10px] text-slate-400">
                ≈ {formatCurrencyMoney(converted ?? 0, snapshot.baseCurrency)}
              </span>
            ) : null}
          </div>
        );
      },
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
        </span>
      ),
    },
    {
      // 「待删」独立列：软删除记录数，点击打开预览弹窗（预览 + 全选/逐条彻底删除）。
      key: "deletedRecords",
      label: t("settings.accounts.colDeletedCount"),
      width: 84,
      minWidth: 64,
      align: "right",
      sortValue: (a) => a.deletedRecordCount ?? 0,
      cellTitle: (a) => (a.deletedRecordCount ? tf("settings.accounts.deletedCountTitle", { count: a.deletedRecordCount }) : ""),
      render: (a) => (a.deletedRecordCount ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); openTrash(a); }}
          className="rounded px-1 tabular-nums text-rose-500 underline decoration-dotted underline-offset-2 transition hover:bg-rose-50 hover:text-rose-600 hover:decoration-solid"
          title={tf("settings.accounts.deletedCountTitle", { count: a.deletedRecordCount })}
        >
          {tf("settings.accounts.deletedRecordCountShort", { count: a.deletedRecordCount })}
        </button>
      ) : <span className="text-slate-300">-</span>),
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
      // 自定义分组标签（2026-11-13）：侧边栏「按分组」与账户下拉分组都读它。
      key: "accountGroup",
      label: t("settings.accounts.accountGroup"),
      width: 120,
      minWidth: 88,
      hideable: true,
      sortValue: (a) => (a.accountGroup ?? "").trim(),
      filterText: (a) => (a.accountGroup ?? "").trim() || null,
      render: (a) => {
        const label = (a.accountGroup ?? "").trim();
        return label
          ? <span className="whitespace-nowrap rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{label}</span>
          : <span className="text-slate-300">-</span>;
      },
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
  ], [t, tf, router, accountKindLabel, investmentLabel, fixedAssetTypeLabel, mergeSelectedIds, toggleMergeSelected, openTrash, ownerNameByGroupId, accountNameById, subAccountCountByParentId, accountGroupBy, balanceById, balanceBaseCurrency, amountClass]);

  // 分组表头行只占「名称 + 余额」两格；其余列一律返回 null，
  // 否则伪行会被渲染成「启用」徽章、删除按钮这类真账户才有的内容。
  const accountTableColumnsWithGroupRows = useMemo<AdvancedDataTableColumn<Account>[]>(
    () => accountTableColumns.map((column) => ({
      ...column,
      render: (account: Account, index: number) => {
        if (isGroupSummaryRow(account) && column.key !== "name" && column.key !== "balance") return null;
        return column.render ? column.render(account, index) : null;
      },
    })),
    [accountTableColumns],
  );

  const renderRowActions = useCallback((a: Account) => {
    // 分组表头是伪行，不能有「停用/编辑/删除」这类真账户动作。
    if (isGroupSummaryRow(a)) return null;
    return (
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
    );
  }, [t, toggleActive, openEdit, handleDeleteClick]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* ===== 移动端：单列卡片 =====
          ADT 表格最小宽 1430px、13 列、正文 12px —— 手机上只能横向滚，字号小到看不清。
          窄屏改为卡片列表：标题仍走 accountDisplayName 这一唯一入口（账户显示格式设置生效），
          副标题给类型/币种/归属/停用态，操作收到卡片底部，热区 36px 起。 */}
      <div
        ref={mobileListRef}
        className="h-full min-h-0 overflow-y-auto bg-slate-100 px-3 py-2 desktop:hidden"
        onScroll={() => { if (swipedAccountId) setSwipedAccountId(null); }}
      >
        <div className="space-y-2.5">
          <div className="flex items-end justify-between gap-2">
            <h2 className="text-lg font-semibold leading-tight text-slate-900">{t("settings.accounts.title")}</h2>
            <span className="shrink-0 pb-0.5 text-xs tabular-nums text-slate-500">
              {t("settings.scaffold.itemCount", { count: filteredAccounts.length })}
            </span>
          </div>

          <input
            value={accountNameQuery}
            onChange={(event) => setAccountNameQuery(event.target.value)}
            placeholder={t("settings.accounts.searchPlaceholder")}
            className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-[15px] outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />

          {/* 类型页签：手机上替代桌面端的「类型多选下拉」——一眼看到有哪些类型、
              各有多少个账户，点一下就在该类型内浏览（列表同时按类型分组）。 */}
          <div
            className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            role="tablist"
            aria-label={t("settings.accounts.type")}
          >
            {mobileKindTabs.map((tab) => {
              const active = mobileKindTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setMobileKindTab(tab.key);
                    setSwipedAccountId(null);
                    mobileListRef.current?.scrollTo({ top: 0 });
                  }}
                  className={[
                    "inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] transition-colors",
                    active ? "bg-slate-900 font-medium text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 active:bg-slate-50",
                  ].join(" ")}
                >
                  {tab.label}
                  <span className={`tabular-nums text-[11px] ${active ? "text-white/60" : "text-slate-400"}`}>{tab.count}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileFilterOpen(true)}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 active:bg-slate-50"
            >
              <SlidersHorizontal className="h-4 w-4 text-slate-500" />
              {t("settings.accounts.mobileFilter")}
              {mobileActiveFilterCount > 0 ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1 text-[11px] font-medium tabular-nums text-white">
                  {mobileActiveFilterCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => setShowCreateAccount(true)}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700"
            >
              <Plus className="h-4 w-4" />
              {t("settings.accounts.add")}
            </button>
          </div>

          {mobileAccounts.length === 0 ? (
            <div className="rounded-xl bg-white px-4 py-10 text-center text-sm text-slate-400 ring-1 ring-slate-200">
              {loadingAccounts ? t("common.loading") : t("settings.accounts.empty")}
            </div>
          ) : (
            <div className="space-y-3">
              {mobileAccountGroups.map((group) => (
                <div key={group.kind} data-kind-group={group.kind} className="space-y-2">
                  {mobileKindTab === "all" ? (
                    <div className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-slate-500">
                      <span className={`flex h-5 w-5 items-center justify-center rounded border ${kindColor(group.kind)}`}>{kindIcon(group.kind)}</span>
                      <span>{accountKindLabel(group.kind)}</span>
                      <span className="tabular-nums text-slate-400">{group.items.length}</span>
                    </div>
                  ) : null}
                  {group.items.map((a) => {
                    const kind = normalizedAccountKind(a);
                    const display = accountDisplayOption(a);
                    const isSubAccount = Boolean(a.parentId);
                    const parentName = isSubAccount ? accountNameById.get(a.parentId ?? "") ?? "" : "";
                    const childCount = subAccountCountByParentId.get(a.id) ?? 0;
                    // 名称里已经写出来的字段不再重复一遍：显示格式常含币种/尾号，子账户名也常以父账户名开头。
                    // 本位币也不显示（满屏 CNY 只是噪音），只有外币、尾号、子账户数、停用态才占副行。
                    const metaParts: string[] = [];
                    if (!a.isAggregate && a.currency !== baseCurrency && !display.label.includes(a.currency)) {
                      metaParts.push(a.currency);
                    }
                    if (a.numberMasked && !display.label.includes(a.numberMasked)) metaParts.push(a.numberMasked);
                    if (childCount > 0) metaParts.push(t("settings.accounts.hierarchyChildCount", { count: childCount }));
                    if (parentName && !display.label.includes(parentName)) {
                      metaParts.push(`${t("settings.accounts.colHierarchy")} ${parentName}`);
                    }
                    if (!a.isActive) metaParts.push(t("common.disabled"));

                    const swipeActions: SwipeActionItem[] = [];
                if (!a.isPlaceholder) {
                  swipeActions.push({
                    key: "toggle",
                    label: a.isActive ? t("common.disabled") : t("common.enabled"),
                    icon: a.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />,
                    tone: "neutral",
                    onAction: () => void toggleActive(a.id),
                  });
                  swipeActions.push({
                    key: "edit",
                    label: t("common.edit"),
                    icon: <Pencil className="h-4 w-4" />,
                    tone: "primary",
                    onAction: () => openEdit(a),
                  });
                }
                swipeActions.push({
                  key: "delete",
                  label: t("common.delete"),
                  icon: <Trash2 className="h-4 w-4" />,
                  tone: "danger",
                  onAction: () => void handleDeleteClick(null, a),
                });

                return (
                  <SwipeActionRow
                    key={a.id}
                    actions={swipeActions}
                    swipeOpen={swipedAccountId === a.id}
                    onSwipeOpenChange={(open) => setSwipedAccountId(open ? a.id : null)}
                    onContentClick={() => {
                      setSwipedAccountId(null);
                      if (!a.isPlaceholder) openEdit(a);
                    }}
                    className={[
                      a.isPlaceholder ? "opacity-50" : "",
                      !a.isActive ? "opacity-70" : "",
                      // 子账户整行右缩进：父子同名同类型时靠位置区分，不用再把父账户名重复写在副行。
                      isSubAccount ? "ml-5" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-center gap-2.5 px-3 py-2.5">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${kindColor(kind)}`}>
                        {kindIcon(kind)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className="truncate text-[15px] font-semibold leading-5 text-slate-900"
                          title={display.tableHoverTitle || undefined}
                        >
                          {display.label}
                        </div>
                        {metaParts.length > 0 ? (
                          <div className="mt-0.5 truncate text-xs leading-4 text-slate-500 tabular-nums">
                            {metaParts.join(" · ")}
                          </div>
                        ) : null}
                        {a.note ? <div className="mt-1 truncate text-xs leading-4 text-slate-400">{a.note}</div> : null}
                      </div>
                      {(() => {
                        // 移动端同样给余额：口径与桌面列一致，都来自 /internal 快照。
                        const snapshot = balanceById.get(a.id);
                        if (!snapshot) return null;
                        const converted = snapshot.convertedBalance;
                        const isForeign = snapshot.currency !== snapshot.baseCurrency && converted != null;
                        return (
                          <div className="shrink-0 text-right">
                            <div className={`tabular-nums text-sm font-semibold ${amountClass(snapshot.balance)}`}>
                              {formatCurrencyMoney(snapshot.balance, snapshot.currency)}
                            </div>
                            {isForeign ? (
                              <div className="mt-0.5 text-[10px] tabular-nums text-slate-400">
                                ≈ {formatCurrencyMoney(converted ?? 0, snapshot.baseCurrency)}
                              </div>
                            ) : null}
                          </div>
                        );
                      })()}
                    </div>
                  </SwipeActionRow>
                );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* 筛选抽屉：人员 / 机构 / 停用开关。这三项挤在标题下会把列表压到看不见，
              收进底部抽屉后主界面只留「搜索 + 类型页签 + 筛选 + 新增」。 */}
          {mobileFilterOpen ? (
            <ModalLayer
              className="fixed inset-0 flex items-end justify-center bg-slate-900/40"
              onClick={closeMobileFilter}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={t("settings.accounts.mobileFilter")}
                className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
                  <h3 className="text-base font-semibold text-slate-900">{t("settings.accounts.mobileFilter")}</h3>
                  <button
                    type="button"
                    onClick={closeMobileFilter}
                    aria-label={t("common.close")}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-slate-400 active:bg-slate-100"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
                  <div>
                    <div className="mb-1.5 text-xs font-medium text-slate-500">{t("settings.accounts.owner")}</div>
                    <div className="flex flex-wrap gap-2">
                      <FilterChip active={scope.userIds.length === 0} onClick={() => setScope({ ...scope, userIds: [] })}>
                        {t("common.all")}
                      </FilterChip>
                      {statisticsUsers.map((user) => (
                        <FilterChip
                          key={user.id}
                          active={scope.userIds.includes(user.id)}
                          onClick={() => setScope({ ...scope, userIds: toggleFilterId(scope.userIds, user.id) })}
                        >
                          {user.name}
                        </FilterChip>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 text-xs font-medium text-slate-500">{t("settings.accounts.institution")}</div>
                    <input
                      value={mobileInstitutionQuery}
                      onChange={(event) => setMobileInstitutionQuery(event.target.value)}
                      placeholder={t("settings.accounts.mobileInstitutionSearch")}
                      className="mb-2 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-blue-400 focus:bg-white"
                    />
                    <div className="flex max-h-56 flex-wrap content-start gap-2 overflow-y-auto">
                      <FilterChip active={scope.institutionIds.length === 0} onClick={() => setScope({ ...scope, institutionIds: [] })}>
                        {t("common.all")}
                      </FilterChip>
                      {mobileScopeInstitutions.map((institution) => (
                        <FilterChip
                          key={institution.id}
                          active={scope.institutionIds.includes(institution.id)}
                          onClick={() => setScope({ ...scope, institutionIds: toggleFilterId(scope.institutionIds, institution.id) })}
                        >
                          {institution.name}
                        </FilterChip>
                      ))}
                      {mobileScopeInstitutions.length === 0 ? (
                        <span className="py-1 text-xs text-slate-400">{t("table.empty")}</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2.5">
                    <span className="text-sm text-slate-700">{t("settings.accounts.hideInactiveAccounts")}</span>
                    <SettingsSwitch
                      checked={hideInactiveAccounts}
                      onCheckedChange={setHideInactiveAccounts}
                      label={t("settings.accounts.hideInactiveAccounts")}
                    />
                  </div>
                </div>

                <div className="flex shrink-0 gap-2 border-t border-slate-100 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
                  <button
                    type="button"
                    onClick={() => {
                      setScope({ userIds: [], institutionIds: [], accountIds: [] });
                      setHideInactiveAccounts(false);
                      setMobileInstitutionQuery("");
                    }}
                    className="inline-flex h-11 flex-1 items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-600 active:bg-slate-50"
                  >
                    {t("settings.accounts.mobileFilterClear")}
                  </button>
                  <button
                    type="button"
                    onClick={closeMobileFilter}
                    className="inline-flex h-11 flex-[1.4] items-center justify-center rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700"
                  >
                    {t("settings.accounts.mobileFilterDone")}
                  </button>
                </div>
              </div>
            </ModalLayer>
          ) : null}
        </div>
      </div>

      {/* ===== 桌面端：ADT 表格 ===== */}
      <div className="hidden h-full min-h-0 w-full min-w-0 flex-col overflow-hidden desktop:flex">
      <div className="shrink-0">
      <SettingsPageHeader
        title={t("settings.accounts.title")}
        description={guideAccountSetup ? t("settings.accounts.guideDescription") : t("settings.accounts.description")}
        count={filteredAccounts.length}
        // 右上角永远只放「胶囊菜单」位：最右端固定是胶囊形态的主入口「+ 新增账户」。
        // 页面级动作（导出模板 / 导入 EXCEL）下移到表格工具栏，与「表头设置」按钮同一行。
        actions={
          <button
            type="button"
            onClick={() => setShowCreateAccount(true)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-blue-600 px-3.5 text-[13px] font-medium text-white shadow-sm ring-1 ring-blue-600/90 transition-colors hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            {t("settings.accounts.add")}
          </button>
        }
      />
      </div>

      {/* ===== Account list (ADT table: 类型为独立列，专属参数走编辑弹窗) ===== */}
      <div className="mt-3 min-h-0 flex-1">
        <AdvancedDataTable
          storageKey="mmh_settings_accounts_table_v1"
          columns={accountTableColumnsWithGroupRows}
          rows={accountTableRows}
          rowKey={(a) => a.id}
          minTableWidth={1590}
          // 分组视图靠「组头底色 + 组间横线」分层，列竖线会和它打架，这里关掉。
          columnDividers={false}
          fillHeight
          showFilters={false}
          // 分组时点表头排序的是「组本身」（组头按该列的值重排），块内账户顺序不动，见 sortRows。
          sortable
          sortRows={sortAccountRowGroups}
          emptyText={loadingAccounts ? t("common.loading") : t("settings.accounts.empty")}
          rowClassName={(a, index) => {
            if (isGroupSummaryRow(a)) {
              // 组头上边加一条发丝横线，把相邻两组分开；第一组紧接表头，不重复画线。
              // 表体是 border-separate（tr 边框不生效），线要落在每个 td 上。
              const divider = index > 0 ? " [&>td]:border-t-[0.5px] [&>td]:border-slate-200" : "";
              return `bg-slate-100/80 cursor-pointer select-none${divider}`;
            }
            return a.isPlaceholder ? "opacity-40 bg-slate-50" : !a.isActive ? "opacity-60" : "";
          }}
          // 组头行整行点击即展开/收起；双击组头不触发编辑。
          onRowClick={(a) => {
            if (isGroupSummaryRow(a)) toggleAccountGroup(a.groupSummary.key);
          }}
          onRowDoubleClick={(a) => { if (isGroupSummaryRow(a)) return; if (!a.isPlaceholder) openEdit(a); }}
          onDisplayRowsChange={setDisplayRows}
          rowActions={renderRowActions}
          rowActionsWidth={116}
          rowActionsMinWidth={104}
          // 筛选控件放 ADT 工具栏左侧：与右侧「表头设置」按钮同一行；右上角只留动作按钮。
          toolbarMode="default"
          // 「表头设置」不能走 ADT 内置的右组：`toolbarRightContent` 是个 flex-1 的独立 item，
          // 本页筛选一多它就被挤到单独一行、还夹在中间。改成自绘按钮（`ml-auto` 推到行尾）
          // + `columnVisibilityTriggerId` 唤起 ADT 原生列菜单，视觉上永远贴最右边缘。
          showColumnVisibilityButton={false}
          columnVisibilityTriggerId="mmh:accounts:column-menu"
          toolbarLeftContent={
            <>
              <div className="w-48 max-w-full">
                <input
                  value={accountNameQuery}
                  onChange={(event) => setAccountNameQuery(event.target.value)}
                  placeholder={t("settings.accounts.searchPlaceholder")}
                  className="h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-700 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                />
              </div>
              <AccountScopeFilter
                allAccounts={statisticsAccounts}
                allInstitutions={statisticsInstitutions}
                allUsers={statisticsUsers}
                value={scope}
                onChange={setScope}
                showAccountFilter={false}
                // 这一行还要放分组、隐藏停用与全展开/全收起，人员/机构触发器窄一档。
                compact
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
                <Layers className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                <select
                  value={accountGroupBy}
                  onChange={(event) => setAccountGroupBy(event.target.value as AccountGroupBy)}
                  className="h-full max-w-[8.5rem] bg-transparent text-xs text-slate-600 outline-none"
                  aria-label={t("settings.accounts.groupByLabel")}
                  title={t("settings.accounts.groupByLabel")}
                >
                  {ACCOUNT_GROUP_BY_VALUES.map((value) => (
                    <option key={value} value={value}>{t(ACCOUNT_GROUP_BY_LABEL_KEYS[value])}</option>
                  ))}
                </select>
              </label>
              {/* 全部展开 / 全部收起：只在分组视图有组时出现，图标按钮避免挤占这一行的宽度。 */}
              {accountGroupRowKeys.length > 0 ? (
                <div className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm">
                  <button
                    type="button"
                    onClick={expandAllAccountGroups}
                    disabled={allAccountGroupsExpanded}
                    title={t("settings.accounts.expandAllGroups")}
                    aria-label={t("settings.accounts.expandAllGroups")}
                    className="flex h-full w-7 items-center justify-center text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </button>
                  <span className="h-4 w-px shrink-0 bg-slate-200" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={collapseAllAccountGroups}
                    disabled={expandedGroupKeys.size === 0}
                    title={t("settings.accounts.collapseAllGroups")}
                    aria-label={t("settings.accounts.collapseAllGroups")}
                    className="flex h-full w-7 items-center justify-center text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <ChevronsDownUp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <label className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm">
                <input
                  type="checkbox"
                  checked={hideInactiveAccounts}
                  onChange={(event) => setHideInactiveAccounts(event.target.checked)}
                  className="h-3.5 w-3.5 accent-blue-600"
                />
                <span>{t("settings.accounts.hideInactiveAccounts")}</span>
              </label>
              {/* 「导出模板 / 导入 EXCEL」与「表头设置」跟在筛选胶囊后面；`ml-auto` 把这组
                  推到所在行的最右端 —— 表头设置永远贴右边缘（与右上角胶囊同一条竖线），
                  和其他表格一致；宽度不够时整组换到下一行，仍贴右。 */}
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <AccountBatchImportButton
                  variant="menu"
                  groups={groups}
                  institutions={institutions}
                  counterparties={counterparties}
                  baseCurrency={baseCurrency}
                  onImported={() => void refreshSettingsAccounts("account:batch-import")}
                />
                <button
                  type="button"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    window.dispatchEvent(new CustomEvent("mmh:accounts:column-menu", {
                      detail: { anchorRect: { top: rect.top, bottom: rect.bottom, right: rect.right, left: rect.left } },
                    }));
                  }}
                  title={t("table.columnSettings")}
                  aria-label={t("table.columnSettings")}
                  className="inline-flex h-8 shrink-0 items-center rounded-md border border-slate-200 bg-white px-2 text-slate-500 shadow-sm transition-colors hover:bg-slate-50"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          }
        />
      </div>
      </div>

      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="account"
        open={showCreateAccount}
        onClose={() => setShowCreateAccount(false)}
        fieldData={{
          groupId: statisticsUsers,
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
        <ModalLayer className="fixed inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4" onMouseDown={() => { setDeleteTarget(null); setDeleteError(""); }}>
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
            <CredentialPasswordField
              value={deletePassword}
              onChange={(value) => { setDeletePassword(value); setDeleteError(""); }}
              onEnter={() => void submitDeleteWithPassword()}
              inputClassName={FIELD_INPUT_CLS}
              autoFocus
            />
            {deleteError && <div className="text-xs text-red-500 mt-1">{deleteError}</div>}
            <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
                className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-600 active:bg-slate-50 sm:h-8 sm:w-auto sm:rounded-md sm:px-3 sm:text-xs sm:hover:bg-slate-50">{t("common.cancel")}</button>
              <button onClick={() => void submitDeleteWithPassword()}
                className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-red-600 text-sm font-medium text-white active:bg-red-700 sm:h-8 sm:w-auto sm:rounded-md sm:px-3 sm:text-xs sm:hover:bg-red-700">{t("settings.accounts.confirmDelete")}</button>
            </div>
          </div>
        </ModalLayer>
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
        const currentNavIndex = navigationAccounts.findIndex((account) => account.id === editingId);
        const previousAccountNav = currentNavIndex > 0 ? navigationAccounts[currentNavIndex - 1] : null;
        const nextAccountNav = currentNavIndex >= 0 && currentNavIndex < navigationAccounts.length - 1 ? navigationAccounts[currentNavIndex + 1] : null;
        const closeEditModal = () => {
          setEditingId(null);
          setEditError("");
          setEditFormBaseline({});
        };
        return (
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
                  onPrevious={() => navigateEditAccount(previousAccountNav)}
                  onNext={() => navigateEditAccount(nextAccountNav)}
                  previousDisabled={!previousAccountNav}
                  nextDisabled={!nextAccountNav}
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
                      onChange={id => setEditForm(f => ({ ...f, groupId: id }))}
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
                {/* 多币种归属：只有资金账户（含信用卡）才有上级账户；父账户自己不能有上级。
                    历史数据已有归属时仍显示，方便解除。 */}
                {!editingAccount.isAggregate && (supportsHierarchy || Boolean(editForm.parentId)) && (
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
                      <label className={FIELD_LABEL_CLS}>{t("settings.accounts.billMode")}</label>
                      <select
                        value={editForm.creditBillMode || "separate"}
                        onChange={e => setEditForm(f => ({ ...f, creditBillMode: e.target.value }))}
                        className={FIELD_INPUT_CLS}
                      >
                        <option value="separate">{t("settings.accounts.separateBill")}</option>
                        <option value="consolidated">{t("settings.accounts.consolidatedBill")}</option>
                      </select>
                    </div>
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
          <ModalLayer className="fixed inset-0 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4" onMouseDown={() => { if (!mergeBusy) setMergeModalOpen(false); }}>
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
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" disabled={mergeBusy}
                  onClick={() => setMergeModalOpen(false)}
                  className="inline-flex h-11 w-full items-center justify-center rounded-xl border border-slate-200 bg-white text-sm text-slate-600 active:bg-slate-50 disabled:opacity-60 sm:h-8 sm:w-auto sm:rounded-md sm:px-3 sm:text-xs sm:hover:bg-slate-50">
                  {t("common.cancel")}
                </button>
                <button type="button" disabled={mergeBusy || !mergeKeepId}
                  onClick={() => {
                    const mergeId = mergeSelectedIds.find((id) => id !== mergeKeepId) ?? "";
                    if (mergeKeepId && mergeId) void submitMerge(mergeKeepId, mergeId);
                  }}
                  className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-blue-600 text-sm font-medium text-white active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 sm:h-8 sm:w-auto sm:rounded-md sm:px-3 sm:text-xs sm:hover:bg-blue-700">
                  {mergeBusy ? "..." : t("settings.accounts.merge.confirm")}
                </button>
              </div>
            </div>
          </ModalLayer>
        );
      })()}

      {/* ===== 软删除记录预览弹窗（待删列入口：预览 + 全选/逐条彻底删除） ===== */}
      {trashAccount && (() => {
        const allSelected = trashRecords.length > 0 && trashSelectedIds.length === trashRecords.length;
        return (
          <ModalLayer className="fixed inset-0 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]" onMouseDown={() => { if (!trashBusy) setTrashAccount(null); }}>
            <div
              className="app-modal-panel relative flex max-h-[85vh] w-[860px] max-w-[calc(100vw-2rem)] flex-col"
              role="dialog"
              aria-modal="true"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="modal-header shrink-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-slate-800">
                    {tf("settings.accounts.trash.title", { name: trashAccount.name })}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">{t("settings.accounts.trash.hint")}</div>
                </div>
                <button
                  type="button"
                  onClick={() => { if (!trashBusy) setTrashAccount(null); }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  aria-label={t("table.close")}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-[55vh] min-h-0 flex-1 overflow-y-auto">
                {trashLoading ? (
                  <div className="p-8 text-center text-xs text-slate-400">{t("common.loading")}</div>
                ) : trashRecords.length === 0 ? (
                  <div className="p-8 text-center text-xs text-slate-400">
                    {trashError || t("settings.accounts.trash.empty")}
                  </div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="w-10 px-2 py-2">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={(event) =>
                              setTrashSelectedIds(event.target.checked ? trashRecords.map((record) => record.id) : [])}
                            className="h-3.5 w-3.5 accent-blue-600"
                            aria-label={t("table.selectAll")}
                          />
                        </th>
                        <th className="px-2 py-2 text-left font-medium">{t("detail.column.date")}</th>
                        <th className="px-2 py-2 text-left font-medium">{t("transaction.type.expense")}</th>
                        <th className="px-2 py-2 text-left font-medium">{t("detail.column.category")}</th>
                        <th className="px-2 py-2 text-right font-medium">{t("detail.column.inflow")}/{t("detail.column.outflow")}</th>
                        <th className="px-2 py-2 text-left font-medium">{t("detail.column.remark")}</th>
                        <th className="px-2 py-2 text-left font-medium">{t("settings.accounts.trash.colDeletedAt")}</th>
                        <th className="w-12 px-2 py-2" aria-label={t("detail.column.actions")}></th>
                      </tr>
                    </thead>
                    <tbody>
                            {trashRecords.map((record) => {
                        // 金额口径：amount 按发生账户侧存 raw；预览统一换算成「当前弹窗账户」方向（正=流入）。
                        const fromSelf = record.accountId === trashAccount.id;
                        const value = (Number(record.amount) || 0) * (fromSelf ? 1 : -1);
                        const selected = trashSelectedIds.includes(record.id);
                        return (
                          <tr key={record.id} className={`border-t border-slate-100 ${selected ? "bg-blue-50/40" : ""}`}>
                            <td className="px-2 py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={trashSelectedIds.includes(record.id)}
                                onChange={(event) =>
                                  setTrashSelectedIds((prev) =>
                                    event.target.checked ? [...prev, record.id] : prev.filter((id) => id !== record.id))}
                                className="h-3.5 w-3.5 accent-blue-600"
                                aria-label={t("table.selectRow")}
                              />
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-600">{formatDateDisplay(record.date)}</td>
                            <td className="px-2 py-1.5">
                              <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                                record.type === "income" ? "border-emerald-100 bg-emerald-50 text-emerald-600"
                                  : record.type === "transfer" ? "border-blue-100 bg-blue-50 text-blue-600"
                                    : record.type === "investment" ? "border-purple-100 bg-purple-50 text-purple-600"
                                      : "border-rose-100 bg-rose-50 text-rose-600"
                              }`}>
                                {t(`transaction.type.${record.type}`)}
                              </span>
                            </td>
                            <td className="max-w-[160px] truncate px-2 py-1.5 text-slate-600" title={record.categoryName ?? undefined}>
                              {record.categoryName || record.fundName || record.metalTypeName || record.insuranceProductName || "-"}
                            </td>
                            <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${value < 0 ? "text-rose-600" : value > 0 ? "text-emerald-600" : "text-slate-400"}`}>
                              {formatCurrencyMoney(value, record.currency)}
                            </td>
                            <td className="max-w-[220px] truncate px-2 py-1.5 text-slate-500" title={record.note ?? undefined}>
                              {record.note || "-"}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-slate-400">
                              {record.deletedAt ? formatDateDisplay(record.deletedAt) : "-"}
                            </td>
                            <td className="px-2 py-1.5 text-right">
                              <button
                                type="button"
                                disabled={trashBusy}
                                onClick={() => void purgeTrashRecords([record.id])}
                                className="h-6 w-6 rounded-md border border-slate-200 bg-white text-slate-400 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
                                title={t("settings.accounts.trash.deleteOne")}
                                aria-label={t("settings.accounts.trash.deleteOne")}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-2 border-t border-slate-100 px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:flex-row sm:items-center sm:justify-between sm:pb-3">
                <div className="min-w-0 text-[11px] text-slate-400">
                  {trashTruncated ? tf("settings.accounts.trash.truncated", { count: trashRecords.length }) : ""}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {trashError && trashRecords.length > 0 ? <div className="text-xs text-red-600">{trashError}</div> : null}
                  <span className="shrink-0 text-xs text-slate-500">{tf("table.selectedCount", { count: trashSelectedIds.length })}</span>
                  <button
                    type="button"
                    disabled={trashBusy || trashSelectedIds.length === 0}
                    onClick={() => void purgeTrashRecords(trashSelectedIds)}
                    className="inline-flex h-11 flex-1 items-center justify-center rounded-xl bg-red-600 text-sm font-medium text-white transition active:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 sm:h-8 sm:flex-none sm:rounded-md sm:px-3 sm:text-xs sm:hover:bg-red-700"
                  >
                    {tf("settings.accounts.trash.deleteSelected", { count: trashSelectedIds.length })}
                  </button>
                </div>
              </div>
            </div>
          </ModalLayer>
        );
      })()}
    </div>
  );
}
