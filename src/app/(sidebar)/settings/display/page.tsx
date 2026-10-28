"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { useIsMobileDevice } from "@/components/DeviceKindProvider";
import SettingsSwitch from "@/components/settings/SettingsSwitch";

import {
  DEFAULT_ACCOUNT_LABEL_FIELDS,
  normalizeAccountLabelFields,
  renderAccountLabel,
  type AccountLabelField,
} from "@/lib/account-display";
import {
  APP_PREFS_EVENT,
  getAccountLabelFieldsPreference,
  getAccountDropdownRestrictTypePreference,
  getAccountUsageSortEnabledPreference,
  getDetailDateBackgroundPreference,
  getDateDisplayFormatPreference,
  getDisplayLanguagePreference,
  getSidebarGroupPreference,
  getSidebarHideInitialDataPreference,
  getSidebarHideZeroPreference,
  getSidebarShowFixedAssetsPreference,
  getSidebarShowAllCashEntriesPreference,
  getSidebarShowReimbursementsPreference,
  getTimeZonePreference,
  DEFAULT_ROW_HEIGHT_MODE,
  ROW_HEIGHT_OPTIONS,
  getRowHeightModePreference,
  normalizeRowHeightMode,
  setAccountLabelFieldsPreference,
  setAccountDropdownRestrictTypePreference,
  setAccountUsageSortEnabledPreference,
  setRowHeightModePreference,
  setDetailDateBackgroundPreference,
  setDateDisplayFormatPreference,
  setDisplayLanguagePreference,
  setSidebarGroupPreference,
  setSidebarHideInitialDataPreference,
  setSidebarHideZeroPreference,
  setSidebarShowFixedAssetsPreference,
  setSidebarShowAllCashEntriesPreference,
  setSidebarShowReimbursementsPreference,
  setTimeZonePreference,
  type DisplayLanguage,
  type DateDisplayFormat,
  type RowHeightMode,
  type SidebarGroupMode,
} from "@/lib/client/appPreferences";
import {
  DEFAULT_DETAIL_WINDOW_YEARS,
  DETAIL_WINDOW_YEAR_OPTIONS,
  normalizeDetailWindowYears,
} from "@/lib/preferences";
import { kindLabel } from "@/lib/account-kinds";
import { CurrencySmartSelect } from "@/components/CurrencySmartSelect";
import { useI18n } from "@/lib/i18n";
import { ChevronLeft, GripVertical, X } from "lucide-react";

type ColorScheme = "red_up_green_down" | "green_up_red_down";

function buildTimeZoneOptions(t: (key: string) => string) {
  return [
    { value: "Asia/Shanghai", label: t("settings.display.timezone.beijing") },
    { value: "Asia/Hong_Kong", label: t("settings.display.timezone.hongKong") },
    { value: "Asia/Tokyo", label: t("settings.display.timezone.tokyo") },
    { value: "Europe/London", label: t("settings.display.timezone.london") },
    { value: "America/New_York", label: t("settings.display.timezone.newYork") },
    { value: "America/Los_Angeles", label: t("settings.display.timezone.losAngeles") },
  ];
}

const DISPLAY_LANGUAGE_OPTIONS: ReadonlyArray<{ value: DisplayLanguage; labelKey: string }> = [
  { value: "zh-CN", labelKey: "settings.display.language.zhCN" },
  { value: "en-US", labelKey: "settings.display.language.enUS" },
  { value: "ja-JP", labelKey: "settings.display.language.jaJP" },
];

const DATE_DISPLAY_FORMAT_OPTIONS: ReadonlyArray<{ value: DateDisplayFormat; labelKey: string }> = [
  { value: "yyyy-mm-dd", labelKey: "settings.display.dateFormat.yyyyMmDd" },
  { value: "yyyy/mm/dd", labelKey: "settings.display.dateFormat.yyyySlashMmSlashDd" },
  { value: "mm/dd/yyyy", labelKey: "settings.display.dateFormat.mmDdYyyy" },
  { value: "dd/mm/yyyy", labelKey: "settings.display.dateFormat.ddMmYyyy" },
];

const ACCOUNT_LABEL_FIELD_OPTIONS: ReadonlyArray<{ value: AccountLabelField; labelKey: string }> = [
  { value: "owner", labelKey: "settings.display.accountFormatField.owner" },
  { value: "institution", labelKey: "settings.display.accountFormatField.institution" },
  { value: "institutionShort", labelKey: "settings.display.accountFormatField.institutionShort" },
  { value: "name", labelKey: "settings.display.accountFormatField.name" },
  { value: "last4", labelKey: "settings.display.accountFormatField.last4" },
  { value: "kind", labelKey: "settings.display.accountFormatField.kind" },
  { value: "currency", labelKey: "settings.display.accountFormatField.currency" },
];

const ACCOUNT_FORMAT_PREVIEW_SAMPLES = [
  {
    id: "debit",
    labelKey: "settings.display.accountFormatSampleDebit",
    ownerName: "\u5f20\u56db",
    institution: { name: "\u62db\u5546\u94f6\u884c", shortName: "\u62db\u884c" },
    accountName: "\u4e00\u5361\u901a",
    numberMasked: "8333",
    kind: "bank_debit",
    // 本位币账户：勾了币种也不显示（示例用 CNY 让这一点可见）。
    currency: "CNY",
  },
  {
    id: "fund",
    labelKey: "settings.display.accountFormatSampleFund",
    ownerName: "\u5f20\u56db",
    institution: { name: "\u62db\u5546\u94f6\u884c", shortName: "\u62db\u884c" },
    accountName: "\u62db\u5546\u94f6\u884c\u57fa\u91d1\u00b7\u5f00\u653e\u5f0f\u57fa\u91d1",
    numberMasked: "",
    kind: "investment",
    // 非本位币账户：勾了币种就显示「· USD」。
    currency: "USD",
  },
] as const;

function getColorSchemePreference(): ColorScheme {
  if (typeof document === "undefined") return "red_up_green_down";
  const match = document.cookie.match(/(?:^|; )colorScheme=([^;]*)/);
  const value = match ? decodeURIComponent(match[1]) : "";
  return value === "green_up_red_down" ? "green_up_red_down" : "red_up_green_down";
}

function setColorSchemePreference(value: ColorScheme) {
  if (typeof document === "undefined") return;
  document.cookie = `colorScheme=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

function SettingRow({
  title,
  desc,
  children,
  wide = false,
  hideDesc = false,
}: {
  title: string;
  desc: string;
  children: ReactNode;
  wide?: boolean;
  hideDesc?: boolean;
}) {
  const showDesc = Boolean(desc) && !hideDesc;

  return (
    <div
      className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 lg:flex-row lg:items-center lg:justify-between"
      title={hideDesc ? desc : undefined}
    >
      <div className="min-w-0 lg:w-56 lg:shrink-0">
        <div className="text-sm font-medium text-slate-800">{title}</div>
        {showDesc ? <div className="mt-1 text-xs text-slate-500">{desc}</div> : null}
      </div>
      {/* 右侧控件一律贴右：原来的 min-w-[280px] 在窄栏里撑破行宽，控件停在容器左端，
          看起来像"跑到左边"；flex-1 + justify-end 让它跟着行右边界走。 */}
      <div
        className={
          wide
            ? "min-w-0 flex-1 @container lg:max-w-none"
            : "min-w-0 lg:flex lg:flex-1 lg:max-w-xl lg:items-center lg:justify-end"
        }
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 手机端设置页的卡片分组：大圆角 + 浅色分组标题，和「我的」目录页保持同一套外观。
 * 桌面端用 `panel-surface` 列表，两者不共用，避免一边改动影响另一边。
 */
function MobileSettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200/70">
      <h3 className="border-b border-slate-100 px-4 py-2.5 text-xs font-semibold text-slate-500">{title}</h3>
      <div className="divide-y divide-slate-100">{children}</div>
    </section>
  );
}

/**
 * 手机端的一行设置。`inline` 用于开关这类右侧控件，其余（下拉、滑块、多选芯片）
 * 铺满整行宽度 —— 手机上用手指点，横向挤在右侧按不准。
 */
function MobileSettingRow({
  title,
  desc,
  hideDesc = false,
  inline = false,
  children,
}: {
  title: string;
  desc?: string;
  hideDesc?: boolean;
  inline?: boolean;
  children: ReactNode;
}) {
  const showDesc = Boolean(desc) && !hideDesc;
  if (inline) {
    return (
      <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900">{title}</div>
          {showDesc ? <div className="mt-0.5 text-xs leading-5 text-slate-500">{desc}</div> : null}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    );
  }
  return (
    <div className="px-4 py-3.5">
      <div className="text-sm font-medium text-slate-900">{title}</div>
      {showDesc ? <div className="mt-0.5 text-xs leading-5 text-slate-500">{desc}</div> : null}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

export default function DisplaySettingsPage() {
  const { t, language: currentLanguage } = useI18n();
  const router = useRouter();
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [displayLanguage, setDisplayLanguage] = useState<DisplayLanguage>(currentLanguage);
  const [dateDisplayFormat, setDateDisplayFormat] = useState<DateDisplayFormat>("yyyy-mm-dd");
  const [baseCurrency, setBaseCurrency] = useState("CNY");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [accountLabelFields, setAccountLabelFieldsState] = useState<AccountLabelField[]>(DEFAULT_ACCOUNT_LABEL_FIELDS);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [sidebarHideInitialData, setSidebarHideInitialData] = useState(false);
  const [sidebarShowFixedAssets, setSidebarShowFixedAssets] = useState(true);
  const [sidebarShowAllCashEntries, setSidebarShowAllCashEntries] = useState(true);
  const [sidebarShowReimbursements, setSidebarShowReimbursements] = useState(true);
  const [detailDateBackground, setDetailDateBackground] = useState(false);
  const [accountDropdownRestrictType, setAccountDropdownRestrictType] = useState(true);
  const [accountUsageSortEnabled, setAccountUsageSortEnabled] = useState(true);
  const [rowHeightMode, setRowHeightMode] = useState<RowHeightMode>(DEFAULT_ROW_HEIGHT_MODE);
  // 明细默认观测窗口（年）。0 = 不限；只作用于服务端首次取数，不进 cookie 镜像。
  const [detailWindowYears, setDetailWindowYears] = useState<number>(DEFAULT_DETAIL_WINDOW_YEARS);
  const [savingDetailWindowYears, setSavingDetailWindowYears] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingBaseCurrency, setSavingBaseCurrency] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingDisplayLanguage, setSavingDisplayLanguage] = useState(false);
  const [savingDateDisplayFormat, setSavingDateDisplayFormat] = useState(false);
  const [savingAccountLabelFields, setSavingAccountLabelFields] = useState(false);
  const [draggingAccountLabelField, setDraggingAccountLabelField] = useState<AccountLabelField | null>(null);
  const [dragOverAccountLabelField, setDragOverAccountLabelField] = useState<AccountLabelField | null>(null);

  // cookie 只是 DB 设置的镜像：新设备首次打开时镜像为空，
  // 由 PreferencesSync 拉取真值后广播事件，这里跟着刷新一次。
  const applyLocalPreferences = useCallback(() => {
    setScheme(getColorSchemePreference());
    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setSidebarHideInitialData(getSidebarHideInitialDataPreference());
    setSidebarShowFixedAssets(getSidebarShowFixedAssetsPreference());
    setSidebarShowAllCashEntries(getSidebarShowAllCashEntriesPreference());
    setSidebarShowReimbursements(getSidebarShowReimbursementsPreference());
    setDetailDateBackground(getDetailDateBackgroundPreference());
    setAccountDropdownRestrictType(getAccountDropdownRestrictTypePreference());
    setAccountUsageSortEnabled(getAccountUsageSortEnabledPreference());
    setRowHeightMode(getRowHeightModePreference());
    setDisplayLanguage(getDisplayLanguagePreference());
    setDateDisplayFormat(getDateDisplayFormatPreference());
    setTimeZone(getTimeZonePreference());
    setAccountLabelFieldsState(getAccountLabelFieldsPreference());
  }, []);

  useEffect(() => {
    applyLocalPreferences();
    window.addEventListener(APP_PREFS_EVENT, applyLocalPreferences);
    return () => window.removeEventListener(APP_PREFS_EVENT, applyLocalPreferences);
  }, [applyLocalPreferences]);

  async function loadBaseCurrency() {
    try {
      const res = await fetch("/api/v1/fx-rates", { cache: "no-store" });
      const data = await res.json();
      if (data.baseCurrency) setBaseCurrency(String(data.baseCurrency).toUpperCase());
    } catch {
      // Display settings can still render with the default currency if this read fails.
    }
  }

  useEffect(() => {
    void loadBaseCurrency();
  }, []);

  // 观测窗口只有服务端取数用，没进 cookie 镜像，所以这里读一次真值。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/settings/app-preferences", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled && data?.ok && data.detailWindowYears != null) {
          setDetailWindowYears(normalizeDetailWindowYears(data.detailWindowYears));
        }
      } catch {
        // 读不到就先按默认值显示；保存时会写回真值。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveScheme(next: ColorScheme) {
    const prev = scheme;
    setScheme(next);
    setColorSchemePreference(next);
    setSavingScheme(true);
    try {
      const res = await fetch("/api/v1/settings/color-scheme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ colorScheme: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setScheme(prev);
        setColorSchemePreference(prev);
      } else {
        const saved = data.colorScheme === "green_up_red_down" ? "green_up_red_down" : "red_up_green_down";
        setScheme(saved);
        setColorSchemePreference(saved);
        router.refresh();
      }
    } catch {
      setScheme(prev);
      setColorSchemePreference(prev);
    } finally {
      setSavingScheme(false);
    }
  }

  async function saveDisplayLanguage(next: DisplayLanguage) {
    const prev = displayLanguage;
    setDisplayLanguage(next);
    setDisplayLanguagePreference(next);
    setSavingDisplayLanguage(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayLanguage: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDisplayLanguage(prev);
        setDisplayLanguagePreference(prev);
      } else {
        // Server components render with getServerT() from the cookie, so
        // re-render the current route so server-translated copy catches up to
        // the client text right away.
        router.refresh();
      }
    } catch {
      setDisplayLanguage(prev);
      setDisplayLanguagePreference(prev);
    } finally {
      setSavingDisplayLanguage(false);
    }
  }

  async function saveDateDisplayFormat(next: DateDisplayFormat) {
    const prev = dateDisplayFormat;
    setDateDisplayFormat(next);
    setDateDisplayFormatPreference(next);
    setSavingDateDisplayFormat(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateDisplayFormat: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDateDisplayFormat(prev);
        setDateDisplayFormatPreference(prev);
      } else if (data.dateDisplayFormat) {
        setDateDisplayFormat(data.dateDisplayFormat as DateDisplayFormat);
        setDateDisplayFormatPreference(data.dateDisplayFormat as DateDisplayFormat);
        router.refresh();
      }
    } catch {
      setDateDisplayFormat(prev);
      setDateDisplayFormatPreference(prev);
    } finally {
      setSavingDateDisplayFormat(false);
    }
  }

  async function saveBaseCurrency(next: string) {
    const normalized = next.toUpperCase();
    const prev = baseCurrency;
    setBaseCurrency(normalized);
    setSavingBaseCurrency(true);
    try {
      const res = await fetch("/api/v1/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseCurrency: normalized }),
      });
      const data = await res.json();
      if (!data?.ok) {
        setBaseCurrency(prev);
      } else if (data.baseCurrency) {
        setBaseCurrency(String(data.baseCurrency).toUpperCase());
      }
    } catch {
      setBaseCurrency(prev);
    } finally {
      setSavingBaseCurrency(false);
    }
  }

  async function saveTimeZone(nextTimeZone: string) {
    const prevTimeZone = timeZone;
    setTimeZone(nextTimeZone);
    setTimeZonePreference(nextTimeZone);
    setSavingTimeZone(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZone: nextTimeZone }),
      });
      const data = await res.json();
      if (!data.ok) {
        setTimeZone(prevTimeZone);
        setTimeZonePreference(prevTimeZone);
      } else if (typeof data.timeZone === "string") {
        setTimeZone(data.timeZone);
        setTimeZonePreference(data.timeZone);
      }
    } catch {
      setTimeZone(prevTimeZone);
      setTimeZonePreference(prevTimeZone);
    } finally {
      setSavingTimeZone(false);
    }
  }

  async function saveAccountLabelFields(next: AccountLabelField[]) {
    const normalized = normalizeAccountLabelFields(next);
    const prev = accountLabelFields;
    setAccountLabelFieldsState(normalized);
    setAccountLabelFieldsPreference(normalized);
    setSavingAccountLabelFields(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountLabelFields: normalized }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAccountLabelFieldsState(prev);
        setAccountLabelFieldsPreference(prev);
      } else if (Array.isArray(data.accountLabelFields)) {
        const saved = normalizeAccountLabelFields(data.accountLabelFields);
        setAccountLabelFieldsState(saved);
        setAccountLabelFieldsPreference(saved);
        // Account labels are rendered on the server from this preference, so
        // re-render the current route to apply the new format everywhere.
        router.refresh();
      }
    } catch {
      setAccountLabelFieldsState(prev);
      setAccountLabelFieldsPreference(prev);
    } finally {
      setSavingAccountLabelFields(false);
    }
  }

  function toggleAccountLabelField(field: AccountLabelField) {
    const next = accountLabelFields.includes(field)
      ? accountLabelFields.filter((item) => item !== field)
      : [...accountLabelFields, field];
    void saveAccountLabelFields(next);
  }

  /**
   * Moves a selected field onto another one's slot. Dropping a field onto its
   * own chip is a no-op, so an accidental short drag cannot reorder anything.
   */
  function reorderAccountLabelFields(from: AccountLabelField, to: AccountLabelField) {
    if (from === to) return;
    const fromIndex = accountLabelFields.indexOf(from);
    const toIndex = accountLabelFields.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...accountLabelFields];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, from);
    void saveAccountLabelFields(next);
  }

  function clearAccountLabelDragState() {
    setDraggingAccountLabelField(null);
    setDragOverAccountLabelField(null);
  }

  async function updateSidebarGroup(next: SidebarGroupMode) {
    const prev = sidebarGroupBy;
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarGroupBy: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarGroupBy(prev);
        setSidebarGroupPreference(prev);
      }
    } catch {
      setSidebarGroupBy(prev);
      setSidebarGroupPreference(prev);
    }
  }

  async function updateSidebarHideZero(next: boolean) {
    const prev = sidebarHideZero;
    setSidebarHideZero(next);
    setSidebarHideZeroPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarHideZero: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarHideZero(prev);
        setSidebarHideZeroPreference(prev);
      }
    } catch {
      setSidebarHideZero(prev);
      setSidebarHideZeroPreference(prev);
    }
  }

  async function updateSidebarHideInitialData(next: boolean) {
    const prev = sidebarHideInitialData;
    setSidebarHideInitialData(next);
    setSidebarHideInitialDataPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarHideInitialData: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarHideInitialData(prev);
        setSidebarHideInitialDataPreference(prev);
      }
    } catch {
      setSidebarHideInitialData(prev);
      setSidebarHideInitialDataPreference(prev);
    }
  }

  async function updateSidebarShowFixedAssets(next: boolean) {
    const prev = sidebarShowFixedAssets;
    setSidebarShowFixedAssets(next);
    setSidebarShowFixedAssetsPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarShowFixedAssets: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarShowFixedAssets(prev);
        setSidebarShowFixedAssetsPreference(prev);
      }
    } catch {
      setSidebarShowFixedAssets(prev);
      setSidebarShowFixedAssetsPreference(prev);
    }
  }

  async function updateSidebarShowAllCashEntries(next: boolean) {
    const prev = sidebarShowAllCashEntries;
    setSidebarShowAllCashEntries(next);
    setSidebarShowAllCashEntriesPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarShowAllCashEntries: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarShowAllCashEntries(prev);
        setSidebarShowAllCashEntriesPreference(prev);
      }
    } catch {
      setSidebarShowAllCashEntries(prev);
      setSidebarShowAllCashEntriesPreference(prev);
    }
  }

  async function updateSidebarShowReimbursements(next: boolean) {
    const prev = sidebarShowReimbursements;
    setSidebarShowReimbursements(next);
    setSidebarShowReimbursementsPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarShowReimbursements: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarShowReimbursements(prev);
        setSidebarShowReimbursementsPreference(prev);
      }
    } catch {
      setSidebarShowReimbursements(prev);
      setSidebarShowReimbursementsPreference(prev);
    }
  }

  async function updateDetailDateBackground(next: boolean) {
    const prev = detailDateBackground;
    setDetailDateBackground(next);
    setDetailDateBackgroundPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detailDateBackground: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDetailDateBackground(prev);
        setDetailDateBackgroundPreference(prev);
      }
    } catch {
      setDetailDateBackground(prev);
      setDetailDateBackgroundPreference(prev);
    }
  }

  async function updateAccountDropdownRestrictType(next: boolean) {
    const prev = accountDropdownRestrictType;
    setAccountDropdownRestrictType(next);
    setAccountDropdownRestrictTypePreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountDropdownRestrictType: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAccountDropdownRestrictType(prev);
        setAccountDropdownRestrictTypePreference(prev);
      }
    } catch {
      setAccountDropdownRestrictType(prev);
      setAccountDropdownRestrictTypePreference(prev);
    }
  }

  async function updateAccountUsageSortEnabled(next: boolean) {
    const prev = accountUsageSortEnabled;
    setAccountUsageSortEnabled(next);
    setAccountUsageSortEnabledPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountUsageSortEnabled: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAccountUsageSortEnabled(prev);
        setAccountUsageSortEnabledPreference(prev);
      } else {
        const saved = data.accountUsageSortEnabled !== false;
        setAccountUsageSortEnabled(saved);
        setAccountUsageSortEnabledPreference(saved);
      }
    } catch {
      setAccountUsageSortEnabled(prev);
      setAccountUsageSortEnabledPreference(prev);
    }
  }

  async function updateRowHeightMode(next: RowHeightMode) {
    const prev = rowHeightMode;
    setRowHeightMode(next);
    setRowHeightModePreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowHeightMode: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setRowHeightMode(prev);
        setRowHeightModePreference(prev);
      } else {
        const saved = normalizeRowHeightMode(data.rowHeightMode);
        setRowHeightMode(saved);
        setRowHeightModePreference(saved);
      }
    } catch {
      setRowHeightMode(prev);
      setRowHeightModePreference(prev);
    }
  }

  async function updateDetailWindowYears(next: number) {
    const normalized = normalizeDetailWindowYears(next);
    const prev = detailWindowYears;
    setDetailWindowYears(normalized);
    setSavingDetailWindowYears(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detailWindowYears: normalized }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDetailWindowYears(prev);
      } else {
        const saved = normalizeDetailWindowYears(data.detailWindowYears ?? normalized);
        setDetailWindowYears(saved);
        // 首屏窗口是 RSC 算的（见 page.tsx 的 initialDetailDateRange），
        // 不刷这一棵路由就还用着旧窗口。
        router.refresh();
      }
    } catch {
      setDetailWindowYears(prev);
    } finally {
      setSavingDetailWindowYears(false);
    }
  }

  const accountFormatPreviews = useMemo(
    () =>
      ACCOUNT_FORMAT_PREVIEW_SAMPLES.map((sample) => ({
        id: sample.id,
        label: t(sample.labelKey),
        text: renderAccountLabel({
          accountName: sample.accountName,
          institution: sample.institution,
          numberMasked: sample.numberMasked,
          ownerName: sample.ownerName,
          kindLabelText: kindLabel(sample.kind, t),
          currency: sample.currency,
          baseCurrency: "CNY",
          fields: accountLabelFields,
        }),
      })),
    [t, accountLabelFields]
  );
  const unselectedAccountLabelFields = useMemo(
    () => ACCOUNT_LABEL_FIELD_OPTIONS.filter((option) => !accountLabelFields.includes(option.value)),
    [accountLabelFields]
  );
  const timeZoneOptions = useMemo(() => buildTimeZoneOptions(t), [t]);
  const hideSettingDescriptions = sidebarHideInitialData;

  const colorOptions: { value: ColorScheme; label: string; preview: { up: string; down: string } }[] = [
    {
      value: "red_up_green_down",
      label: t("settings.display.colorRedUp"),
      preview: { up: "text-red-600", down: "text-emerald-700" },
    },
    {
      value: "green_up_red_down",
      label: t("settings.display.colorGreenUp"),
      preview: { up: "text-emerald-700", down: "text-red-600" },
    },
  ];
  const selectedColorOption = colorOptions.find((opt) => opt.value === scheme) ?? colorOptions[0];
  const rowHeightSliderIndex = Math.max(0, ROW_HEIGHT_OPTIONS.indexOf(rowHeightMode));
  // 手机端下拉：44px 高，刚好一个手指的点击热区。
  const mobileSelectClass = "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 disabled:opacity-60";
  // 两套 UI 树按「设备」二选一，不按窗口宽度 —— md: 断点只负责几何细节，
  // 桌面浏览器把窗口拉窄仍然是下面那套 panel 列表，不会变成手机版。
  const isMobileDevice = useIsMobileDevice();

  return (
    <>
      {/* 手机端专版：独立外壳（返回条 + 分组卡片 + 大号触摸控件）。
          桌面端仍是下面那套 panel 列表，两套共用同一批状态与保存函数，不会各存一份。 */}
      {isMobileDevice ? (
      <div className="space-y-3 pb-6">
        <header className="sticky top-0 z-20 -mx-3 -mt-3 flex h-12 items-center gap-1 border-b border-slate-200 bg-white/95 pl-1 pr-2 backdrop-blur">
          <Link
            href="/settings"
            prefetch={false}
            className="flex h-9 items-center gap-0.5 rounded-lg px-1.5 text-sm font-medium text-blue-600 active:bg-slate-100"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            {t("settings.display.mobile.backToProfile")}
          </Link>
          <span className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-slate-900">
            {t("settings.display.title")}
          </span>
          <span className="w-[64px] shrink-0" aria-hidden="true" />
        </header>

        <MobileSettingGroup title={t("settings.display.mobile.appearance")}>
          <MobileSettingRow title={t("settings.display.colorScheme")} desc={t("settings.display.colorSchemeDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={scheme}
              onChange={(e) => void saveScheme(e.target.value as ColorScheme)}
              disabled={savingScheme}
              className={mobileSelectClass}
              aria-label={t("settings.display.colorScheme")}
            >
              {colorOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="mt-1.5 flex items-center gap-1 text-xs text-slate-500" aria-live="polite">
              <span className={`font-medium ${selectedColorOption.preview.up}`}>+1.23%</span>
              <span className="text-slate-400">/</span>
              <span className={`font-medium ${selectedColorOption.preview.down}`}>-0.56%</span>
              {savingScheme ? <span className="ml-2 text-slate-400">{t("settings.display.applying")}</span> : null}
            </div>
          </MobileSettingRow>

          <MobileSettingRow
            title={t("settings.display.detailDateBackground")}
            desc={t("settings.display.detailDateBackgroundDesc")}
            hideDesc={hideSettingDescriptions}
            inline
          >
            <SettingsSwitch
              checked={detailDateBackground}
              onCheckedChange={(next) => void updateDetailDateBackground(next)}
              label={t("settings.display.detailDateBackground")}
            />
          </MobileSettingRow>

        </MobileSettingGroup>

        <MobileSettingGroup title={t("settings.display.mobile.language")}>
          <MobileSettingRow title={t("settings.display.language")} desc={t("settings.display.languageDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={displayLanguage}
              onChange={(e) => saveDisplayLanguage(e.target.value as DisplayLanguage)}
              disabled={savingDisplayLanguage}
              className={mobileSelectClass}
              aria-label={t("settings.display.language")}
            >
              {DISPLAY_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </MobileSettingRow>

          <MobileSettingRow title={t("settings.display.dateFormat")} desc={t("settings.display.dateFormatDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={dateDisplayFormat}
              onChange={(e) => void saveDateDisplayFormat(e.target.value as DateDisplayFormat)}
              disabled={savingDateDisplayFormat}
              className={mobileSelectClass}
              aria-label={t("settings.display.dateFormat")}
            >
              {DATE_DISPLAY_FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </MobileSettingRow>

          <MobileSettingRow title={t("settings.display.baseCurrency")} desc={t("settings.display.baseCurrencyDesc")} hideDesc={hideSettingDescriptions}>
            {/* SmartSelect 触发器默认 36px，比这一页其它下拉矮；只用 aria-haspopup 命中触发器，
                不动旁边那个 28px 的「新增货币」小按钮。 */}
            <div className="[&_[aria-haspopup]]:h-11">
              <CurrencySmartSelect
                value={baseCurrency}
                onChange={(code) => void saveBaseCurrency(code)}
                labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                placeholder={t("settings.display.baseCurrencyPlaceholder")}
              />
            </div>
            {savingBaseCurrency ? <p className="mt-1 text-[11px] text-slate-400">{t("common.loading")}</p> : null}
          </MobileSettingRow>

          <MobileSettingRow title={t("settings.display.timeZone")} desc={t("settings.display.timeZoneDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={timeZone}
              onChange={(e) => void saveTimeZone(e.target.value)}
              disabled={savingTimeZone}
              className={mobileSelectClass}
              aria-label={t("settings.display.timeZone")}
            >
              {timeZoneOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </MobileSettingRow>

          <MobileSettingRow title={t("settings.display.accountFormat")} desc={t("settings.display.accountFormatDesc")} hideDesc={hideSettingDescriptions}>
            <div className="flex flex-wrap gap-1.5">
              {accountLabelFields.map((field) => {
                const option = ACCOUNT_LABEL_FIELD_OPTIONS.find((item) => item.value === field);
                if (!option) return null;
                return (
                  <button
                    key={field}
                    type="button"
                    onClick={() => toggleAccountLabelField(field)}
                    aria-label={t("settings.display.accountFormatRemove")}
                    className="inline-flex h-9 items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 active:bg-blue-100"
                  >
                    {t(option.labelKey)}
                    <X className="h-3.5 w-3.5 text-blue-400" aria-hidden="true" />
                  </button>
                );
              })}
            </div>
            {unselectedAccountLabelFields.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {unselectedAccountLabelFields.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleAccountLabelField(option.value)}
                    className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-2.5 text-xs text-slate-600 active:bg-slate-50"
                  >
                    + {t(option.labelKey)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
              <button
                type="button"
                onClick={() => void saveAccountLabelFields(DEFAULT_ACCOUNT_LABEL_FIELDS)}
                className="text-blue-600 active:underline"
              >
                {t("settings.display.accountFormatReset")}
              </button>
              {savingAccountLabelFields ? <span className="text-slate-400">{t("settings.display.applying")}</span> : null}
            </div>
            <div className="mt-2.5 space-y-1 rounded-xl bg-slate-50 px-3 py-2">
              <div className="text-[11px] text-slate-500">{t("settings.display.preview")}</div>
              {accountFormatPreviews.map((preview) => (
                <div key={preview.id} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 text-[11px] text-slate-400">{preview.label}</span>
                  <span className="truncate text-xs text-slate-800" title={preview.text}>{preview.text}</span>
                </div>
              ))}
            </div>
          </MobileSettingRow>
        </MobileSettingGroup>

        <MobileSettingGroup title={t("settings.display.mobile.detailGroup")}>
          <MobileSettingRow title={t("settings.display.detailWindow")} desc={t("settings.display.detailWindowDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={String(detailWindowYears)}
              onChange={(e) => void updateDetailWindowYears(Number(e.target.value))}
              disabled={savingDetailWindowYears}
              className={mobileSelectClass}
              aria-label={t("settings.display.detailWindow")}
            >
              {DETAIL_WINDOW_YEAR_OPTIONS.map((years) => (
                <option key={years} value={years}>
                  {years === 0 ? t("settings.display.detailWindowAll") : t("settings.display.detailWindowYears", { years })}
                </option>
              ))}
            </select>
          </MobileSettingRow>
        </MobileSettingGroup>

        {/* 只留手机上真的会变的选项：侧边栏分组、隐藏零余额、固定/收支/报销入口、
            使用向导都只画在桌面侧边栏，表格行高只作用于桌面表格，手机上一律没有效果。 */}
        <MobileSettingGroup title={t("settings.display.mobile.entryGroup")}>
          <MobileSettingRow
            title={t("settings.display.accountDropdownRestrictType")}
            desc={t("settings.display.accountDropdownRestrictTypeDesc")}
            hideDesc={hideSettingDescriptions}
            inline
          >
            <SettingsSwitch
              checked={accountDropdownRestrictType}
              onCheckedChange={(next) => void updateAccountDropdownRestrictType(next)}
              label={t("settings.display.accountDropdownRestrictType")}
            />
          </MobileSettingRow>
          <MobileSettingRow title={t("settings.display.accountUsageSort")} desc={t("settings.display.accountUsageSortDesc")} hideDesc={hideSettingDescriptions} inline>
            <SettingsSwitch
              checked={accountUsageSortEnabled}
              onCheckedChange={(next) => void updateAccountUsageSortEnabled(next)}
              label={t("settings.display.accountUsageSort")}
            />
          </MobileSettingRow>
        </MobileSettingGroup>
      </div>
      ) : (
      <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{t("settings.display.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("settings.display.description")}</p>
      </div>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.sidebarGroup")} desc={t("settings.display.sidebarGroupDesc")} hideDesc={hideSettingDescriptions}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void updateSidebarGroup("kind")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "kind" ? "segment-button-active font-medium" : ""}`}
              >
                {t("settings.display.groupByKind")}
              </button>
              <button
                type="button"
                onClick={() => void updateSidebarGroup("institution")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "institution" ? "segment-button-active font-medium" : ""}`}
              >
                {t("settings.display.groupByInstitution")}
              </button>
            </div>
          </SettingRow>
          <SettingRow title={t("settings.display.hideZero")} desc={t("settings.display.hideZeroDesc")} hideDesc={hideSettingDescriptions}>
            <SettingsSwitch
              checked={sidebarHideZero}
              onCheckedChange={updateSidebarHideZero}
              label={t("settings.display.hideZero")}
            />
          </SettingRow>
          <SettingRow title={t("settings.display.showFixedAssets")} desc={t("settings.display.showFixedAssetsDesc")} hideDesc={hideSettingDescriptions}>
            <SettingsSwitch
              checked={sidebarShowFixedAssets}
              onCheckedChange={(next) => void updateSidebarShowFixedAssets(next)}
              label={t("settings.display.showFixedAssets")}
            />
          </SettingRow>
          <SettingRow title={t("settings.display.showAllCashEntries")} desc={t("settings.display.showAllCashEntriesDesc")} hideDesc={hideSettingDescriptions}>
            <SettingsSwitch
              checked={sidebarShowAllCashEntries}
              onCheckedChange={(next) => void updateSidebarShowAllCashEntries(next)}
              label={t("settings.display.showAllCashEntries")}
            />
          </SettingRow>
          <SettingRow title={t("settings.display.showReimbursements")} desc={t("settings.display.showReimbursementsDesc")} hideDesc={hideSettingDescriptions}>
            <SettingsSwitch
              checked={sidebarShowReimbursements}
              onCheckedChange={(next) => void updateSidebarShowReimbursements(next)}
              label={t("settings.display.showReimbursements")}
            />
          </SettingRow>
          <SettingRow title={t("settings.display.accountDropdownRestrictType")} desc={t("settings.display.accountDropdownRestrictTypeDesc")} hideDesc={hideSettingDescriptions}>
            <SettingsSwitch
              checked={accountDropdownRestrictType}
              onCheckedChange={(next) => void updateAccountDropdownRestrictType(next)}
              label={t("settings.display.accountDropdownRestrictType")}
            />
          </SettingRow>
          <SettingRow title={t("settings.display.accountUsageSort")} desc={t("settings.display.accountUsageSortDesc")} hideDesc={hideSettingDescriptions}>
            <SettingsSwitch
              checked={accountUsageSortEnabled}
              onCheckedChange={(next) => void updateAccountUsageSortEnabled(next)}
              label={t("settings.display.accountUsageSort")}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.display.hideInitialData")}
            desc={t("settings.display.hideInitialDataDesc")}
            hideDesc={hideSettingDescriptions}
          >
            {/* The preference is stored inverted (sidebarHideInitialData) while the row
                reads "Show First-Use Guide", so the switch follows the label, not the key. */}
            <SettingsSwitch
              checked={!sidebarHideInitialData}
              onCheckedChange={(next) => void updateSidebarHideInitialData(!next)}
              label={t("settings.display.hideInitialData")}
            />
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <SettingRow title={t("settings.display.colorScheme")} desc={t("settings.display.colorSchemeDesc")} hideDesc={hideSettingDescriptions}>
          <div className="space-y-2">
            <select
              value={scheme}
              onChange={(e) => void saveScheme(e.target.value as ColorScheme)}
              disabled={savingScheme}
              className="form-input"
            >
              {colorOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1 text-xs text-slate-500" aria-live="polite">
              <span className={`font-medium ${selectedColorOption.preview.up}`}>+1.23%</span>
              <span className="text-slate-400">/</span>
              <span className={`font-medium ${selectedColorOption.preview.down}`}>-0.56%</span>
              {savingScheme ? <span className="ml-2 text-slate-400">{t("settings.display.applying")}</span> : null}
            </div>
          </div>
        </SettingRow>
        <SettingRow title={t("settings.display.detailDateBackground")} desc={t("settings.display.detailDateBackgroundDesc")} hideDesc={hideSettingDescriptions}>
          <SettingsSwitch
            checked={detailDateBackground}
            onCheckedChange={(next) => void updateDetailDateBackground(next)}
            label={t("settings.display.detailDateBackground")}
          />
        </SettingRow>
        <SettingRow title={t("settings.display.detailWindow")} desc={t("settings.display.detailWindowDesc")} hideDesc={hideSettingDescriptions}>
          <select
            value={String(detailWindowYears)}
            onChange={(e) => void updateDetailWindowYears(Number(e.target.value))}
            disabled={savingDetailWindowYears}
            className="form-input"
            aria-label={t("settings.display.detailWindow")}
          >
            {DETAIL_WINDOW_YEAR_OPTIONS.map((years) => (
              <option key={years} value={years}>
                {years === 0
                  ? t("settings.display.detailWindowAll")
                  : t("settings.display.detailWindowYears", { years })}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title={t("settings.display.rowHeight")} desc={t("settings.display.rowHeightDesc")} hideDesc={hideSettingDescriptions}>
          <div className="w-full max-w-md space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">{rowHeightMode}px</span>
              <span className="text-slate-400">{ROW_HEIGHT_OPTIONS[0]}px / {ROW_HEIGHT_OPTIONS[ROW_HEIGHT_OPTIONS.length - 1]}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={ROW_HEIGHT_OPTIONS.length - 1}
              step={1}
              value={rowHeightSliderIndex}
              onChange={(event) => {
                const index = Number(event.currentTarget.value);
                const next = ROW_HEIGHT_OPTIONS[index] ?? DEFAULT_ROW_HEIGHT_MODE;
                void updateRowHeightMode(next);
              }}
              className="h-2 w-full cursor-pointer accent-blue-600"
              aria-label={t("settings.display.rowHeight")}
            />
            <div className="flex justify-between text-[11px] tabular-nums text-slate-400">
              {ROW_HEIGHT_OPTIONS.map((height) => (
                <span key={height}>{height}</span>
              ))}
            </div>
          </div>
        </SettingRow>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.baseCurrency")} desc={t("settings.display.baseCurrencyDesc")} hideDesc={hideSettingDescriptions}>
            <div className="w-full sm:max-w-xs">
              <CurrencySmartSelect
                value={baseCurrency}
                onChange={(code) => void saveBaseCurrency(code)}
                labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                placeholder={t("settings.display.baseCurrencyPlaceholder")}
              />
              {savingBaseCurrency ? (
                <p className="mt-1 text-[11px] text-slate-400">{t("common.loading")}</p>
              ) : null}
            </div>
          </SettingRow>
          <SettingRow title={t("settings.display.language")} desc={t("settings.display.languageDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={displayLanguage}
              onChange={(e) => saveDisplayLanguage(e.target.value as DisplayLanguage)}
              disabled={savingDisplayLanguage}
              className="form-input"
            >
              {DISPLAY_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.display.timeZone")} desc={t("settings.display.timeZoneDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={timeZone}
              onChange={(e) => void saveTimeZone(e.target.value)}
              disabled={savingTimeZone}
              className="form-input"
            >
              {timeZoneOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.display.dateFormat")} desc={t("settings.display.dateFormatDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={dateDisplayFormat}
              onChange={(e) => void saveDateDisplayFormat(e.target.value as DateDisplayFormat)}
              disabled={savingDateDisplayFormat}
              className="form-input"
            >
              {DATE_DISPLAY_FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.accountFormat")} desc={t("settings.display.accountFormatDesc")} hideDesc={hideSettingDescriptions} wide>
            {/* 横排与否看容器宽度，不看视口：1280 视口下这一栏只有约 200px 可用，
                `lg:` 按视口命中会把字段芯片压成竖排。 */}
            <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-start @3xl:gap-4 @4xl:gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex min-h-8 flex-nowrap items-center gap-2 overflow-x-auto pb-1">
                  {accountLabelFields.length === 0 ? (
                    <span className="text-xs text-slate-400">{t("settings.display.accountFormatEmpty")}</span>
                  ) : (
                    accountLabelFields.map((field, index) => {
                      const option = ACCOUNT_LABEL_FIELD_OPTIONS.find((item) => item.value === field);
                      if (!option) return null;
                      const isDragging = draggingAccountLabelField === field;
                      const isDropTarget = dragOverAccountLabelField === field && !isDragging;
                      return (
                        <div
                          key={field}
                          draggable
                          onDragStart={(event) => {
                            setDraggingAccountLabelField(field);
                            event.dataTransfer.effectAllowed = "move";
                            // Firefox only starts a drag when payload data is set.
                            event.dataTransfer.setData("text/plain", field);
                          }}
                          onDragOver={(event) => {
                            if (!draggingAccountLabelField || draggingAccountLabelField === field) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setDragOverAccountLabelField(field);
                          }}
                          onDragLeave={() => {
                            if (dragOverAccountLabelField === field) setDragOverAccountLabelField(null);
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            if (draggingAccountLabelField) {
                              reorderAccountLabelFields(draggingAccountLabelField, field);
                            }
                            clearAccountLabelDragState();
                          }}
                          onDragEnd={clearAccountLabelDragState}
                          title={t("settings.display.accountFormatDragHint")}
                          className={`flex h-8 shrink-0 cursor-grab items-center gap-1 rounded-[8px] border px-2 text-xs shadow-sm active:cursor-grabbing ${
                            isDropTarget
                              ? "border-blue-400 bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-300"
                              : "border-blue-200 bg-blue-50/70 text-blue-700"
                          } ${isDragging ? "opacity-50" : ""}`}
                        >
                          <GripVertical className="h-3.5 w-3.5 shrink-0 text-blue-300" aria-hidden="true" />
                          <span className="shrink-0 tabular-nums text-blue-400">{index + 1}.</span>
                          <span className="whitespace-nowrap font-medium">{t(option.labelKey)}</span>
                          <button
                            type="button"
                            onClick={() => toggleAccountLabelField(field)}
                            title={t("settings.display.accountFormatRemove")}
                            aria-label={t("settings.display.accountFormatRemove")}
                            className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-blue-400 hover:bg-blue-100 hover:text-blue-700"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
                {unselectedAccountLabelFields.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">{t("settings.display.accountFormatAdd")}</span>
                    {unselectedAccountLabelFields.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => toggleAccountLabelField(option.value)}
                        className="segment-button h-7 px-2 text-xs"
                      >
                        + {t(option.labelKey)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>{t("settings.display.accountFormatHint")}</span>
                  <button
                    type="button"
                    onClick={() => void saveAccountLabelFields(DEFAULT_ACCOUNT_LABEL_FIELDS)}
                    className="text-blue-600 hover:underline"
                  >
                    {t("settings.display.accountFormatReset")}
                  </button>
                  {savingAccountLabelFields ? <span className="text-slate-400">{t("settings.display.applying")}</span> : null}
                </div>
              </div>
              <div className="w-full shrink-0 rounded-[10px] border border-slate-200 bg-slate-50/70 px-3 py-2 @3xl:w-64 @4xl:w-72">
                <div className="text-xs text-slate-500">{t("settings.display.preview")}</div>
                <div className="mt-1 space-y-1">
                  {accountFormatPreviews.map((preview) => (
                    <div key={preview.id} className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 text-xs text-slate-400">{preview.label}</span>
                      <span className="truncate text-sm text-slate-800" title={preview.text}>{preview.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </SettingRow>
        </div>
      </section>
      </div>
      )}
    </>
  );
}
