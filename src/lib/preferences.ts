/**
 * 账簿级设置的单一事实来源：默认值、归一化、以及 DB 行 ↔ DTO 的映射。
 *
 * 这个模块必须保持「同构」——不能 import prisma、next/headers 或任何只在
 * 服务端可用的东西，因为客户端也要用它做镜像校验。
 *
 * 为什么设置要进库：这里的每一项都是「用户在该账簿上做出的配置」，
 * 换浏览器、换设备、清 cookie 之后都应该还在。浏览器 cookie 只是读缓存。
 */
import {
  DEFAULT_ACCOUNT_LABEL_FIELDS,
  SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
  normalizeCreditCardLabelTemplate,
  parseAccountLabelFields,
  serializeAccountLabelFields,
  type AccountLabelField,
} from "@/lib/account-display";
import {
  DEFAULT_DATE_DISPLAY_FORMAT,
  normalizeDateDisplayFormat,
  type DateDisplayFormat,
} from "@/lib/date-utils";
import { DEFAULT_ROW_HEIGHT_MODE, normalizeRowHeightMode, type RowHeightMode } from "@/lib/row-height";

export type DisplayLanguage = "zh-CN" | "en-US" | "ja-JP";
export type ColorScheme = "red_up_green_down" | "green_up_red_down";
export type CreditCardLabelMode = "short_last4" | "full_name";
export type SidebarGroupMode = "kind" | "institution";

export const DEFAULT_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_SESSION_DAYS = 30;
export const DEFAULT_FUND_UNITS_DECIMALS = 2;
export const DEFAULT_DISPLAY_LANGUAGE: DisplayLanguage = "zh-CN";
const DEFAULT_COLOR_SCHEME: ColorScheme = "red_up_green_down";
export const DEFAULT_CREDIT_CARD_LABEL_MODE: CreditCardLabelMode = "short_last4";
/** 明细默认观测窗口（年）；0 = 不限，「全部」就真的是全部时间。 */
export const DEFAULT_DETAIL_WINDOW_YEARS = 5;
export const DETAIL_WINDOW_YEAR_OPTIONS = [1, 2, 3, 5, 10, 0] as const;

/** DB 行形状（全部可空，便于兼容老数据与手写迁移）。 */
export type PreferenceRow = {
  sessionDays?: number | null;
  fundUnitsDecimals?: number | null;
  aiPanelEnabled?: boolean | null;
  timeZone?: string | null;
  colorScheme?: string | null;
  creditCardLabelMode?: string | null;
  creditCardLabelTemplate?: string | null;
  creditCardSidebarLabelTemplate?: string | null;
  creditBillHideZero?: boolean | null;
  creditBillHideSettled?: boolean | null;
  creditBillShowRecentCycles?: boolean | null;
  displayLanguage?: string | null;
  dateDisplayFormat?: string | null;
  sidebarGroupBy?: string | null;
  sidebarHideZero?: boolean | null;
  sidebarHideInitialData?: boolean | null;
  sidebarShowFixedAssets?: boolean | null;
  sidebarShowAllCashEntries?: boolean | null;
  sidebarShowReimbursements?: boolean | null;
  detailDateBackground?: boolean | null;
  detailWindowYears?: number | null;
  rowHeightMode?: number | string | null;
  accountLabelFields?: string | null;
  accountDropdownRestrictType?: boolean | null;
  accountUsageSortEnabled?: boolean | null;
};

/** 默认按使用频率排序，与引入开关之前的行为一致。 */
export const DEFAULT_ACCOUNT_USAGE_SORT_ENABLED = true;

export type AppPreferences = {
  sessionDays: number;
  fundUnitsDecimals: number;
  aiPanelEnabled: boolean;
  timeZone: string;
  colorScheme: ColorScheme;
  creditCardLabelMode: CreditCardLabelMode;
  creditCardLabelTemplate: string;
  creditCardSidebarLabelTemplate: string;
  creditBillHideZero: boolean;
  creditBillHideSettled: boolean;
  creditBillShowRecentCycles: boolean;
  displayLanguage: DisplayLanguage;
  dateDisplayFormat: DateDisplayFormat;
  sidebarGroupBy: SidebarGroupMode;
  sidebarHideZero: boolean;
  sidebarHideInitialData: boolean;
  sidebarShowFixedAssets: boolean;
  sidebarShowAllCashEntries: boolean;
  sidebarShowReimbursements: boolean;
  detailDateBackground: boolean;
  detailWindowYears: number;
  rowHeightMode: RowHeightMode;
  accountLabelFields: AccountLabelField[];
  accountDropdownRestrictType: boolean;
  /** 是否按最近一个月的记账频率给侧边栏和账户下拉排序。 */
  accountUsageSortEnabled: boolean;
};

export function normalizeSessionDays(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_SESSION_DAYS;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

export function normalizeFundUnitsDecimals(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_FUND_UNITS_DECIMALS;
  return Math.min(Math.max(Math.round(n), 0), 6);
}

/**
 * 明细观测窗口年数：0 = 不限，其余落在 1–30 年。
 *
 * 这个值直接进 SQL 的日期下界，非法值必须回退到默认 5 年，不能原样透传。
 */
export function normalizeDetailWindowYears(input: unknown): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_DETAIL_WINDOW_YEARS;
  const rounded = Math.round(n);
  if (rounded <= 0) return 0;
  return Math.min(rounded, 30);
}

export function normalizeBoolean(input: unknown, fallback: boolean): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input === "true" || input === "1") return true;
    if (input === "false" || input === "0") return false;
  }
  return fallback;
}

export function normalizeTimeZone(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!value) return DEFAULT_TIME_ZONE;
  try {
    // 只为校验 IANA 名；非法值必须回退，否则 Intl 在渲染时抛错。
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function normalizeColorScheme(input: unknown): ColorScheme {
  return input === "green_up_red_down" ? "green_up_red_down" : DEFAULT_COLOR_SCHEME;
}

export function normalizeCreditCardLabelMode(input: unknown): CreditCardLabelMode {
  return input === "full_name" ? "full_name" : DEFAULT_CREDIT_CARD_LABEL_MODE;
}

export function normalizeDisplayLanguage(input: unknown): DisplayLanguage {
  return input === "en-US" || input === "ja-JP" || input === "zh-CN" ? input : DEFAULT_DISPLAY_LANGUAGE;
}

export function normalizeSidebarGroupMode(input: unknown): SidebarGroupMode {
  return input === "institution" ? "institution" : "kind";
}

export function normalizeAccountLabelFieldsSetting(input: unknown): AccountLabelField[] {
  if (Array.isArray(input)) {
    const fields = parseAccountLabelFields(serializeAccountLabelFields(input as AccountLabelField[]));
    return fields.length > 0 ? fields : [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  }
  if (typeof input === "string") {
    const value = input.trim();
    if (!value) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
    return parseAccountLabelFields(value);
  }
  return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
}

/**
 * DB 行 → 可直接返回给客户端的快照。null 行（从未保存过）与缺列都落到默认值，
 * 因此新账簿不需要预插一行。
 */
export function preferencesFromRow(row: PreferenceRow | null | undefined): AppPreferences {
  const creditCardLabelMode = normalizeCreditCardLabelMode(row?.creditCardLabelMode);
  return {
    sessionDays: normalizeSessionDays(row?.sessionDays),
    fundUnitsDecimals: normalizeFundUnitsDecimals(row?.fundUnitsDecimals),
    aiPanelEnabled: normalizeBoolean(row?.aiPanelEnabled, true),
    timeZone: normalizeTimeZone(row?.timeZone),
    colorScheme: normalizeColorScheme(row?.colorScheme),
    creditCardLabelMode,
    creditCardLabelTemplate: normalizeCreditCardLabelTemplate(row?.creditCardLabelTemplate, creditCardLabelMode),
    creditCardSidebarLabelTemplate: normalizeCreditCardLabelTemplate(
      row?.creditCardSidebarLabelTemplate || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
      "short_last4",
    ),
    creditBillHideZero: normalizeBoolean(row?.creditBillHideZero, false),
    creditBillHideSettled: normalizeBoolean(row?.creditBillHideSettled, false),
    creditBillShowRecentCycles: normalizeBoolean(row?.creditBillShowRecentCycles, true),
    displayLanguage: normalizeDisplayLanguage(row?.displayLanguage),
    dateDisplayFormat: normalizeDateDisplayFormat(row?.dateDisplayFormat ?? DEFAULT_DATE_DISPLAY_FORMAT),
    sidebarGroupBy: normalizeSidebarGroupMode(row?.sidebarGroupBy),
    sidebarHideZero: normalizeBoolean(row?.sidebarHideZero, false),
    sidebarHideInitialData: normalizeBoolean(row?.sidebarHideInitialData, false),
    sidebarShowFixedAssets: normalizeBoolean(row?.sidebarShowFixedAssets, true),
    sidebarShowAllCashEntries: normalizeBoolean(row?.sidebarShowAllCashEntries, true),
    sidebarShowReimbursements: normalizeBoolean(row?.sidebarShowReimbursements, true),
    detailDateBackground: normalizeBoolean(row?.detailDateBackground, false),
    detailWindowYears: normalizeDetailWindowYears(row?.detailWindowYears ?? DEFAULT_DETAIL_WINDOW_YEARS),
    rowHeightMode: normalizeRowHeightMode(row?.rowHeightMode ?? DEFAULT_ROW_HEIGHT_MODE),
    accountLabelFields: row?.accountLabelFields
      ? parseAccountLabelFields(row.accountLabelFields)
      : [...DEFAULT_ACCOUNT_LABEL_FIELDS],
    accountDropdownRestrictType: normalizeBoolean(row?.accountDropdownRestrictType, true),
    accountUsageSortEnabled: normalizeBoolean(row?.accountUsageSortEnabled, DEFAULT_ACCOUNT_USAGE_SORT_ENABLED),
  };
}

/**
 * 浏览器 cookie 镜像的键与序列化规则。
 *
 * 保留镜像的原因：20 多个客户端组件是**同步**读这些值的（`getXxxPreference()`），
 * 改成异步会让首屏闪烁，并牵动大量无关组件。真源仍在 DB，镜像由
 * `GET /api/v1/settings/app-preferences` + `PreferencesSync` 维护。
 */
export const PREFERENCE_COOKIE_MIRROR = [
  { key: "mmh_session_days", pick: (p: AppPreferences) => String(p.sessionDays) },
  { key: "mmh_fund_units_decimals", pick: (p: AppPreferences) => String(p.fundUnitsDecimals) },
  { key: "mmh_ai_panel_enabled", pick: (p: AppPreferences) => String(p.aiPanelEnabled) },
  { key: "mmh_time_zone", pick: (p: AppPreferences) => p.timeZone },
  { key: "colorScheme", pick: (p: AppPreferences) => p.colorScheme },
  { key: "mmh_credit_card_label_mode", pick: (p: AppPreferences) => p.creditCardLabelMode },
  { key: "mmh_credit_card_label_template", pick: (p: AppPreferences) => p.creditCardLabelTemplate },
  { key: "mmh_credit_card_sidebar_label_template", pick: (p: AppPreferences) => p.creditCardSidebarLabelTemplate },
  { key: "mmh_credit_hide_zero_bills", pick: (p: AppPreferences) => (p.creditBillHideZero ? "1" : "0") },
  { key: "mmh_credit_hide_settled_bills", pick: (p: AppPreferences) => (p.creditBillHideSettled ? "1" : "0") },
  { key: "mmh_credit_recent_cycles", pick: (p: AppPreferences) => (p.creditBillShowRecentCycles ? "1" : "0") },
  { key: "mmh_display_language", pick: (p: AppPreferences) => p.displayLanguage },
  { key: "mmh_date_display_format", pick: (p: AppPreferences) => p.dateDisplayFormat },
  { key: "sidebar_group_by", pick: (p: AppPreferences) => p.sidebarGroupBy },
  { key: "sidebar_hide_zero", pick: (p: AppPreferences) => String(p.sidebarHideZero) },
  { key: "sidebar_hide_initial_data", pick: (p: AppPreferences) => String(p.sidebarHideInitialData) },
  { key: "sidebar_show_fixed_assets", pick: (p: AppPreferences) => String(p.sidebarShowFixedAssets) },
  { key: "sidebar_show_all_cash_entries", pick: (p: AppPreferences) => String(p.sidebarShowAllCashEntries) },
  { key: "sidebar_show_reimbursements", pick: (p: AppPreferences) => String(p.sidebarShowReimbursements) },
  { key: "detail_date_background", pick: (p: AppPreferences) => String(p.detailDateBackground) },
  { key: "advanced_data_table_row_height_mode", pick: (p: AppPreferences) => String(p.rowHeightMode) },
  { key: "mmh_account_label_fields", pick: (p: AppPreferences) => serializeAccountLabelFields(p.accountLabelFields) },
  { key: "mmh_account_dropdown_restrict_type", pick: (p: AppPreferences) => (p.accountDropdownRestrictType ? "1" : "0") },
  { key: "mmh_account_usage_sort", pick: (p: AppPreferences) => (p.accountUsageSortEnabled ? "1" : "0") },
] as const;
