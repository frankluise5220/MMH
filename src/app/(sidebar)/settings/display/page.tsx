"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_CREDIT_CARD_LABEL_TEMPLATE, SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE } from "@/lib/account-display";
import {
  getCreditCardSidebarLabelTemplatePreference,
  getCreditCardLabelTemplatePreference,
  getDisplayLanguagePreference,
  getSidebarGroupPreference,
  getSidebarHideInitialDataPreference,
  getSidebarHideZeroPreference,
  getTimeZoneModePreference,
  getTimeZonePreference,
  setCreditCardSidebarLabelTemplatePreference,
  setCreditCardLabelTemplatePreference,
  setDisplayLanguagePreference,
  setSidebarGroupPreference,
  setSidebarHideInitialDataPreference,
  setSidebarHideZeroPreference,
  setTimeZonePreference,
  type DisplayLanguage,
  type SidebarGroupMode,
  type TimeZoneMode,
} from "@/lib/client/appPreferences";
import { CURRENCY_OPTIONS } from "@/lib/currency";
import { PRODUCT_INTROS } from "@/lib/product-intro";
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

const DISPLAY_LANGUAGE_OPTIONS: DisplayLanguage[] = ["zh-CN", "en-US", "ja-JP"];

const CREDIT_CARD_NAME_PRESETS = [
  { value: "{机构简称}{信用卡后4位}", labelKey: "settings.display.preset.short", example: "招行8333" },
  { value: "{机构简称}·{信用卡后4位}", labelKey: "settings.display.preset.shortDot", example: "招行·8333" },
  { value: "{机构名称}·{信用卡名称}", labelKey: "settings.display.preset.full", example: "招商银行·优享白金卡" },
  { value: "{机构简称}·{信用卡名称}·{信用卡后4位}", labelKey: "settings.display.preset.fullShort", example: "招行·优享白金卡·8333" },
];

const CREDIT_CARD_NAME_FIELDS = [
  "{机构简称}",
  "{机构名称}",
  "{信用卡名称}",
  "{信用卡后4位}",
  "·",
];

function previewCreditCardName(value: string, accountName = "优享白金卡") {
  const last4 = accountName.includes("8333") ? "" : "8333";
  return value
    .replaceAll("{机构简称}", "招行")
    .replaceAll("{机构全称}", "招商银行")
    .replaceAll("{机构名称}", "招商银行")
    .replaceAll("{信用卡名称}", accountName)
    .replaceAll("{账户名称}", accountName)
    .replaceAll("{信用卡后4位}", last4)
    .replaceAll("{后4位}", last4)
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

function SettingRow({
  title,
  desc,
  children,
  wide = false,
}: {
  title: string;
  desc: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0 lg:w-56 lg:shrink-0">
        <div className="text-sm font-medium text-slate-800">{title}</div>
        <div className="mt-1 text-xs text-slate-500">{desc}</div>
      </div>
      <div className={wide ? "min-w-0 flex-1 lg:max-w-3xl" : "min-w-0 lg:min-w-[280px] lg:max-w-xl"}>
        {children}
      </div>
    </div>
  );
}

export default function DisplaySettingsPage() {
  const { t, language: currentLanguage } = useI18n();
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [schemeDraft, setSchemeDraft] = useState<ColorScheme>("red_up_green_down");
  const [displayLanguage, setDisplayLanguage] = useState<DisplayLanguage>(currentLanguage);
  const [baseCurrency, setBaseCurrency] = useState("CNY");
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [creditCardSidebarDisplayName, setCreditCardSidebarDisplayName] = useState(SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE);
  const [creditCardDisplayName, setCreditCardDisplayName] = useState(DEFAULT_CREDIT_CARD_LABEL_TEMPLATE);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [sidebarHideInitialData, setSidebarHideInitialData] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingBaseCurrency, setSavingBaseCurrency] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingDisplayLanguage, setSavingDisplayLanguage] = useState(false);
  const [savingCreditCardSidebarDisplayName, setSavingCreditCardSidebarDisplayName] = useState(false);
  const [savingCreditCardDisplayName, setSavingCreditCardDisplayName] = useState(false);

  useEffect(() => {
    const colorScheme = getColorSchemePreference();
    setScheme(colorScheme);
    setSchemeDraft(colorScheme);
    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setSidebarHideInitialData(getSidebarHideInitialDataPreference());
    setDisplayLanguage(getDisplayLanguagePreference());
    setTimeZoneMode(getTimeZoneModePreference());
    setTimeZone(getTimeZonePreference());
    setCreditCardSidebarDisplayName(getCreditCardSidebarLabelTemplatePreference());
    setCreditCardDisplayName(getCreditCardLabelTemplatePreference());
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
        setSchemeDraft(prev);
      }
    } catch {
      setScheme(prev);
      setSchemeDraft(prev);
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
      }
    } catch {
      setDisplayLanguage(prev);
      setDisplayLanguagePreference(prev);
    } finally {
      setSavingDisplayLanguage(false);
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

  async function saveCreditCardDisplayName(next: string) {
    const prev = creditCardDisplayName;
    setCreditCardDisplayName(next);
    setCreditCardLabelTemplatePreference(next);
    setSavingCreditCardDisplayName(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditCardLabelTemplate: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCreditCardDisplayName(prev);
        setCreditCardLabelTemplatePreference(prev);
      }
    } catch {
      setCreditCardDisplayName(prev);
      setCreditCardLabelTemplatePreference(prev);
    } finally {
      setSavingCreditCardDisplayName(false);
    }
  }

  async function saveCreditCardSidebarDisplayName(next: string) {
    const prev = creditCardSidebarDisplayName;
    const normalized = next || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE;
    setCreditCardSidebarDisplayName(normalized);
    setCreditCardSidebarLabelTemplatePreference(normalized);
    setSavingCreditCardSidebarDisplayName(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditCardSidebarLabelTemplate: normalized }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCreditCardSidebarDisplayName(prev);
        setCreditCardSidebarLabelTemplatePreference(prev);
      }
    } catch {
      setCreditCardSidebarDisplayName(prev);
      setCreditCardSidebarLabelTemplatePreference(prev);
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

  const sidebarPreview = useMemo(() => previewCreditCardName(creditCardSidebarDisplayName), [creditCardSidebarDisplayName]);
  const tablePreview = useMemo(() => previewCreditCardName(creditCardDisplayName), [creditCardDisplayName]);
  const timeZoneOptions = useMemo(() => buildTimeZoneOptions(t), [t]);

  const colorOptions: { value: ColorScheme; label: string; desc: string; preview: { up: string; down: string } }[] = [
    {
      value: "red_up_green_down",
      label: t("settings.display.colorRedUp"),
      desc: t("settings.display.colorRedUpDesc"),
      preview: { up: "text-red-600", down: "text-emerald-700" },
    },
    {
      value: "green_up_red_down",
      label: t("settings.display.colorGreenUp"),
      desc: t("settings.display.colorGreenUpDesc"),
      preview: { up: "text-emerald-700", down: "text-red-600" },
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{t("settings.display.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("settings.display.description")}</p>
      </div>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.sidebarGroup")} desc={t("settings.display.sidebarGroupDesc")}>
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
          <SettingRow title={t("settings.display.hideZero")} desc={t("settings.display.hideZeroDesc")}>
            <input
              type="checkbox"
              checked={sidebarHideZero}
              onChange={(e) => updateSidebarHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow title={t("settings.display.hideInitialData")} desc={t("settings.display.hideInitialDataDesc")}>
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
        <SettingRow title={t("settings.display.colorScheme")} desc={t("settings.display.colorSchemeDesc")} wide>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-2">
              {colorOptions.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm transition ${
                    schemeDraft === opt.value ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                  }`}
                  title={opt.desc}
                >
                  <input
                    type="radio"
                    name="colorScheme"
                    value={opt.value}
                    checked={schemeDraft === opt.value}
                    onChange={() => setSchemeDraft(opt.value)}
                    disabled={savingScheme}
                    className="shrink-0"
                  />
                  <span className="font-medium">{opt.label}</span>
                  <span className={`text-xs ${opt.preview.up}`}>+1.23%</span>
                  <span className="text-xs text-slate-400">/</span>
                  <span className={`text-xs ${opt.preview.down}`}>-0.56%</span>
                </label>
              ))}
            </div>
            <button
              type="button"
              onClick={() => saveScheme(schemeDraft)}
              disabled={savingScheme || schemeDraft === scheme}
              className="primary-button h-9 px-4 text-sm disabled:opacity-50"
            >
              {savingScheme ? t("settings.display.applying") : t("settings.display.apply")}
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.baseCurrency")} desc={t("settings.display.baseCurrencyDesc")}>
            <select
              value={baseCurrency}
              onChange={(e) => void saveBaseCurrency(e.target.value)}
              disabled={savingBaseCurrency}
              className="form-input"
            >
              {CURRENCY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.display.language")} desc={t("settings.display.languageDesc")}>
            <select
              value={displayLanguage}
              onChange={(e) => saveDisplayLanguage(e.target.value as DisplayLanguage)}
              disabled={savingDisplayLanguage}
              className="form-input"
            >
              {DISPLAY_LANGUAGE_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {PRODUCT_INTROS[value].languageLabel}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.display.timeZone")} desc={t("settings.display.timeZoneDesc")}>
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
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.creditCardSidebar")} desc={t("settings.display.creditCardSidebarDesc")} wide>
            <div className="space-y-2">
              <input
                value={creditCardSidebarDisplayName}
                onChange={(e) => setCreditCardSidebarDisplayName(e.target.value)}
                className="form-input"
                placeholder={SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE}
              />
              <div className="flex flex-wrap items-center gap-2">
                {CREDIT_CARD_NAME_PRESETS.map((preset) => (
                  <button
                    key={`sidebar-${preset.value}`}
                    type="button"
                    onClick={() => setCreditCardSidebarDisplayName(preset.value)}
                    className="secondary-button h-8 px-3 text-xs"
                    title={preset.example}
                  >
                    {t(preset.labelKey)}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={savingCreditCardSidebarDisplayName}
                  onClick={() => setCreditCardSidebarDisplayName(SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE)}
                  className="secondary-button h-8 px-3 text-xs"
                >
                  {t("settings.display.default")}
                </button>
                <button
                  type="button"
                  disabled={savingCreditCardSidebarDisplayName}
                  onClick={() => void saveCreditCardSidebarDisplayName(creditCardSidebarDisplayName)}
                  className="primary-button h-8 px-3 text-xs"
                >
                  {t("common.save")}
                </button>
              </div>
              <div className="text-xs text-slate-500">{t("settings.display.preview")}<span className="font-medium text-slate-800">{sidebarPreview || t("settings.display.previewEmpty")}</span></div>
            </div>
          </SettingRow>

          <SettingRow title={t("settings.display.creditCardTable")} desc={t("settings.display.creditCardTableDesc")} wide>
            <div className="space-y-2">
              <input
                value={creditCardDisplayName}
                onChange={(e) => setCreditCardDisplayName(e.target.value)}
                className="form-input"
                placeholder={DEFAULT_CREDIT_CARD_LABEL_TEMPLATE}
              />
              <div className="flex flex-wrap items-center gap-2">
                {CREDIT_CARD_NAME_PRESETS.map((preset) => (
                  <button
                    key={`table-${preset.value}`}
                    type="button"
                    onClick={() => setCreditCardDisplayName(preset.value)}
                    className="secondary-button h-8 px-3 text-xs"
                    title={preset.example}
                  >
                    {t(preset.labelKey)}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={savingCreditCardDisplayName}
                  onClick={() => setCreditCardDisplayName(DEFAULT_CREDIT_CARD_LABEL_TEMPLATE)}
                  className="secondary-button h-8 px-3 text-xs"
                >
                  {t("settings.display.default")}
                </button>
                <button
                  type="button"
                  disabled={savingCreditCardDisplayName}
                  onClick={() => void saveCreditCardDisplayName(creditCardDisplayName)}
                  className="primary-button h-8 px-3 text-xs"
                >
                  {t("common.save")}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {CREDIT_CARD_NAME_FIELDS.map((field) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => setCreditCardDisplayName((current) => `${current}${field}`)}
                    className="secondary-button h-7 px-2 text-[11px]"
                    title={t("settings.display.insertField", { field })}
                  >
                    {field}
                  </button>
                ))}
              </div>
              <div className="text-xs text-slate-500">{t("settings.display.preview")}<span className="font-medium text-slate-800">{tablePreview || t("settings.display.previewEmpty")}</span></div>
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  );
}
