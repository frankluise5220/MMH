"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE } from "@/lib/account-display";
import {
  getCreditCardSidebarLabelTemplatePreference,
  getCompactRowHeightPreference,
  getDetailDateBackgroundPreference,
  getDateDisplayFormatPreference,
  getDisplayLanguagePreference,
  getSidebarGroupPreference,
  getSidebarHideInitialDataPreference,
  getSidebarHideZeroPreference,
  getSidebarShowFixedAssetsPreference,
  getTimeZoneModePreference,
  getTimeZonePreference,
  setCreditCardSidebarLabelTemplatePreference,
  setCompactRowHeightPreference,
  setDetailDateBackgroundPreference,
  setDateDisplayFormatPreference,
  setCreditCardLabelTemplatePreference,
  setDisplayLanguagePreference,
  setSidebarGroupPreference,
  setSidebarHideInitialDataPreference,
  setSidebarHideZeroPreference,
  setSidebarShowFixedAssetsPreference,
  setTimeZonePreference,
  type DisplayLanguage,
  type DateDisplayFormat,
  type SidebarGroupMode,
  type TimeZoneMode,
} from "@/lib/client/appPreferences";
import { CURRENCY_OPTIONS } from "@/lib/currency";
import { useI18n } from "@/lib/i18n";

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

const CREDIT_CARD_TEMPLATE_TOKEN = {
  owner: "{\u6240\u6709\u4eba}",
  institutionShort: "{\u673a\u6784\u7b80\u79f0}",
  institutionFull: "{\u673a\u6784\u5168\u79f0}",
  institutionName: "{\u673a\u6784\u540d\u79f0}",
  cardName: "{\u4fe1\u7528\u5361\u540d\u79f0}",
  accountName: "{\u8d26\u6237\u540d\u79f0}",
  last4: "{\u4fe1\u7528\u5361\u540e4\u4f4d}",
  shortLast4: "{\u540e4\u4f4d}",
  separator: "·",
} as const;

const CREDIT_CARD_NAME_PRESETS = [
  {
    value: `${CREDIT_CARD_TEMPLATE_TOKEN.institutionShort}${CREDIT_CARD_TEMPLATE_TOKEN.last4}`,
    labelKey: "settings.display.preset.short",
  },
  {
    value: `${CREDIT_CARD_TEMPLATE_TOKEN.institutionShort}${CREDIT_CARD_TEMPLATE_TOKEN.separator}${CREDIT_CARD_TEMPLATE_TOKEN.last4}`,
    labelKey: "settings.display.preset.shortDot",
  },
  {
    value: `${CREDIT_CARD_TEMPLATE_TOKEN.institutionName}${CREDIT_CARD_TEMPLATE_TOKEN.separator}${CREDIT_CARD_TEMPLATE_TOKEN.cardName}`,
    labelKey: "settings.display.preset.full",
  },
  {
    value: `${CREDIT_CARD_TEMPLATE_TOKEN.institutionShort}${CREDIT_CARD_TEMPLATE_TOKEN.separator}${CREDIT_CARD_TEMPLATE_TOKEN.cardName}${CREDIT_CARD_TEMPLATE_TOKEN.separator}${CREDIT_CARD_TEMPLATE_TOKEN.last4}`,
    labelKey: "settings.display.preset.fullShort",
  },
];

const CREDIT_CARD_NAME_FIELDS = [
  { value: CREDIT_CARD_TEMPLATE_TOKEN.owner, labelKey: "settings.display.creditCardField.owner" },
  { value: CREDIT_CARD_TEMPLATE_TOKEN.institutionShort, labelKey: "settings.display.creditCardField.institutionShort" },
  { value: CREDIT_CARD_TEMPLATE_TOKEN.institutionName, labelKey: "settings.display.creditCardField.institutionName" },
  { value: CREDIT_CARD_TEMPLATE_TOKEN.cardName, labelKey: "settings.display.creditCardField.cardName" },
  { value: CREDIT_CARD_TEMPLATE_TOKEN.last4, labelKey: "settings.display.creditCardField.last4" },
  { value: CREDIT_CARD_TEMPLATE_TOKEN.separator, labelKey: "settings.display.creditCardField.separator" },
];

type CreditCardPreviewSample = {
  ownerName: string;
  institutionShort: string;
  institutionName: string;
  cardName: string;
  last4: string;
};

const CREDIT_CARD_PREVIEW_SAMPLE: CreditCardPreviewSample = {
  ownerName: "\u5f20\u56db",
  institutionShort: "\u62db\u884c",
  institutionName: "\u62db\u5546\u94f6\u884c",
  cardName: "\u4f18\u4eab\u767d\u91d1\u5361",
  last4: "8333",
};

function previewCreditCardName(value: string, sample: CreditCardPreviewSample) {
  const last4 = sample.cardName.includes(sample.last4) ? "" : sample.last4;
  return value
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.institutionShort, sample.institutionShort)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.institutionFull, sample.institutionName)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.institutionName, sample.institutionName)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.owner, sample.ownerName)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.cardName, sample.cardName)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.accountName, sample.cardName)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.last4, last4)
    .replaceAll(CREDIT_CARD_TEMPLATE_TOKEN.shortLast4, last4)
    .replace(/[·]{2,}/g, "·")
    .replace(/(^[·\s]+|[·\s]+$)/g, "")
    .trim();
}

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
      <div className={wide ? "min-w-0 flex-1 lg:max-w-3xl" : "min-w-0 lg:min-w-[280px] lg:max-w-xl"}>
        {children}
      </div>
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
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [creditCardSidebarDisplayName, setCreditCardSidebarDisplayName] = useState(SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [sidebarHideInitialData, setSidebarHideInitialData] = useState(false);
  const [sidebarShowFixedAssets, setSidebarShowFixedAssets] = useState(true);
  const [detailDateBackground, setDetailDateBackground] = useState(false);
  const [compactRowHeight, setCompactRowHeight] = useState(30);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingBaseCurrency, setSavingBaseCurrency] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingDisplayLanguage, setSavingDisplayLanguage] = useState(false);
  const [savingDateDisplayFormat, setSavingDateDisplayFormat] = useState(false);
  const [savingCreditCardSidebarDisplayName, setSavingCreditCardSidebarDisplayName] = useState(false);

  useEffect(() => {
    const colorScheme = getColorSchemePreference();
    setScheme(colorScheme);
    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setSidebarHideInitialData(getSidebarHideInitialDataPreference());
    setSidebarShowFixedAssets(getSidebarShowFixedAssetsPreference());
    setDetailDateBackground(getDetailDateBackgroundPreference());
    setCompactRowHeight(getCompactRowHeightPreference());
    setDisplayLanguage(getDisplayLanguagePreference());
    setDateDisplayFormat(getDateDisplayFormatPreference());
    setTimeZoneMode(getTimeZoneModePreference());
    setTimeZone(getTimeZonePreference());
    setCreditCardSidebarDisplayName(getCreditCardSidebarLabelTemplatePreference());
  }, []);

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

  async function saveTimeZone(nextMode: TimeZoneMode, nextTimeZone: string) {
    const prevMode = timeZoneMode;
    const prevTimeZone = timeZone;
    setTimeZoneMode(nextMode);
    setTimeZone(nextTimeZone);
    setTimeZonePreference(nextMode, nextTimeZone);
    setSavingTimeZone(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZoneMode: nextMode, timeZone: nextTimeZone }),
      });
      const data = await res.json();
      if (!data.ok) {
        setTimeZoneMode(prevMode);
        setTimeZone(prevTimeZone);
        setTimeZonePreference(prevMode, prevTimeZone);
      }
    } catch {
      setTimeZoneMode(prevMode);
      setTimeZone(prevTimeZone);
      setTimeZonePreference(prevMode, prevTimeZone);
    } finally {
      setSavingTimeZone(false);
    }
  }

  async function saveCreditCardSidebarDisplayName(next: string) {
    const prev = creditCardSidebarDisplayName;
    const normalized = next || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE;
    setCreditCardSidebarDisplayName(normalized);
    setCreditCardSidebarLabelTemplatePreference(normalized);
    setCreditCardLabelTemplatePreference(normalized);
    setSavingCreditCardSidebarDisplayName(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          creditCardSidebarLabelTemplate: normalized,
          creditCardLabelTemplate: normalized,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCreditCardSidebarDisplayName(prev);
        setCreditCardSidebarLabelTemplatePreference(prev);
        setCreditCardLabelTemplatePreference(prev);
      }
    } catch {
      setCreditCardSidebarDisplayName(prev);
      setCreditCardSidebarLabelTemplatePreference(prev);
      setCreditCardLabelTemplatePreference(prev);
    } finally {
      setSavingCreditCardSidebarDisplayName(false);
    }
  }

  function updateSidebarGroup(next: SidebarGroupMode) {
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function updateSidebarHideZero(next: boolean) {
    setSidebarHideZero(next);
    setSidebarHideZeroPreference(next);
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

  async function updateCompactRowHeight(next: number) {
    const normalized = Math.min(Math.max(Math.round(next), 25), 35);
    const prev = compactRowHeight;
    setCompactRowHeight(normalized);
    setCompactRowHeightPreference(normalized);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ compactRowHeight: normalized }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCompactRowHeight(prev);
        setCompactRowHeightPreference(prev);
      } else if (typeof data.compactRowHeight === "number") {
        setCompactRowHeight(data.compactRowHeight);
        setCompactRowHeightPreference(data.compactRowHeight);
      }
    } catch {
      setCompactRowHeight(prev);
      setCompactRowHeightPreference(prev);
    }
  }

  const sidebarPreview = useMemo(
    () => previewCreditCardName(creditCardSidebarDisplayName, CREDIT_CARD_PREVIEW_SAMPLE),
    [creditCardSidebarDisplayName]
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

  return (
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
                onClick={() => updateSidebarGroup("kind")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "kind" ? "segment-button-active font-medium" : ""}`}
              >
                {t("settings.display.groupByKind")}
              </button>
              <button
                type="button"
                onClick={() => updateSidebarGroup("institution")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "institution" ? "segment-button-active font-medium" : ""}`}
              >
                {t("settings.display.groupByInstitution")}
              </button>
            </div>
          </SettingRow>
          <SettingRow title={t("settings.display.hideZero")} desc={t("settings.display.hideZeroDesc")} hideDesc={hideSettingDescriptions}>
            <input
              type="checkbox"
              checked={sidebarHideZero}
              onChange={(e) => updateSidebarHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow title={t("settings.display.showFixedAssets")} desc={t("settings.display.showFixedAssetsDesc")} hideDesc={hideSettingDescriptions}>
            <input
              type="checkbox"
              checked={sidebarShowFixedAssets}
              onChange={(e) => void updateSidebarShowFixedAssets(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow
            title={t("settings.display.hideInitialData")}
            desc={t("settings.display.hideInitialDataDesc")}
            hideDesc={hideSettingDescriptions}
          >
            <input
              type="checkbox"
              checked={sidebarHideInitialData}
              onChange={(e) => void updateSidebarHideInitialData(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
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
          <input
            type="checkbox"
            checked={detailDateBackground}
            onChange={(e) => void updateDetailDateBackground(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
          />
        </SettingRow>
        <SettingRow title={t("settings.display.compactRowHeight")} desc={t("settings.display.compactRowHeightDesc")} hideDesc={hideSettingDescriptions}>
          <div className="flex w-full max-w-xl items-center gap-3">
            <input
              type="range"
              min={25}
              max={35}
              step={1}
              value={compactRowHeight}
              onChange={(e) => void updateCompactRowHeight(Number(e.target.value))}
              className="h-2 w-full cursor-pointer accent-blue-600"
            />
            <span className="w-14 shrink-0 text-right text-sm tabular-nums text-slate-600">{compactRowHeight}px</span>
          </div>
        </SettingRow>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.baseCurrency")} desc={t("settings.display.baseCurrencyDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={baseCurrency}
              onChange={(e) => void saveBaseCurrency(e.target.value)}
              disabled={savingBaseCurrency}
              className="form-input"
            >
              {CURRENCY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(`entityForm.currency.${option.value.toLowerCase()}`)}
                </option>
              ))}
            </select>
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
              value={timeZoneMode === "system" ? "system" : timeZone}
              onChange={(e) => {
                const value = e.target.value;
                void (value === "system" ? saveTimeZone("system", timeZone) : saveTimeZone("specified", value));
              }}
              disabled={savingTimeZone}
              className="form-input"
            >
              <option value="system">{t("settings.display.timeZoneSystem")}</option>
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
            <div className="text-sm text-slate-700">
              {t("settings.display.accountFormatExample")}
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  );
}
