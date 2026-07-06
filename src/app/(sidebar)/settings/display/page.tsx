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
import { PRODUCT_INTROS } from "@/lib/product-intro";

type ColorScheme = "red_up_green_down" | "green_up_red_down";

const TIME_ZONE_OPTIONS = [
  { value: "Asia/Shanghai", label: "北京时间 (Asia/Shanghai)" },
  { value: "Asia/Hong_Kong", label: "香港 (Asia/Hong_Kong)" },
  { value: "Asia/Tokyo", label: "东京 (Asia/Tokyo)" },
  { value: "Europe/London", label: "伦敦 (Europe/London)" },
  { value: "America/New_York", label: "纽约 (America/New_York)" },
  { value: "America/Los_Angeles", label: "洛杉矶 (America/Los_Angeles)" },
];

const DISPLAY_LANGUAGE_OPTIONS: DisplayLanguage[] = ["zh-CN", "en-US", "ja-JP"];

const CREDIT_CARD_NAME_PRESETS = [
  { value: "{机构简称}{信用卡后4位}", label: "简称+后四位", example: "招行8333" },
  { value: "{机构简称}·{信用卡后4位}", label: "简称·后四位", example: "招行·8333" },
  { value: "{机构名称}·{信用卡名称}", label: "机构名称·卡名", example: "招商银行·优享白金卡" },
  { value: "{机构简称}·{信用卡名称}·{信用卡后4位}", label: "简称·卡名·后四位", example: "招行·优享白金卡·8333" },
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
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [schemeDraft, setSchemeDraft] = useState<ColorScheme>("red_up_green_down");
  const [displayLanguage, setDisplayLanguage] = useState<DisplayLanguage>("zh-CN");
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [creditCardSidebarDisplayName, setCreditCardSidebarDisplayName] = useState(SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE);
  const [creditCardDisplayName, setCreditCardDisplayName] = useState(DEFAULT_CREDIT_CARD_LABEL_TEMPLATE);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [sidebarHideInitialData, setSidebarHideInitialData] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
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

  const colorOptions: { value: ColorScheme; label: string; desc: string; preview: { up: string; down: string } }[] = [
    {
      value: "red_up_green_down",
      label: "红涨绿跌",
      desc: "适合国内常见金融产品显示习惯。",
      preview: { up: "text-red-600", down: "text-emerald-700" },
    },
    {
      value: "green_up_red_down",
      label: "绿涨红跌",
      desc: "适合国际市场常见显示习惯。",
      preview: { up: "text-emerald-700", down: "text-red-600" },
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">显示与应用设置</h2>
        <p className="mt-1 text-xs text-slate-500">管理显示密度、颜色、时区和侧边栏习惯。</p>
      </div>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title="侧边栏账户分组" desc="控制左侧账户列表按资产类型或机构归类，属于本机浏览器习惯。">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => updateSidebarGroup("kind")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "kind" ? "segment-button-active font-medium" : ""}`}
              >
                按资产类型
              </button>
              <button
                type="button"
                onClick={() => updateSidebarGroup("institution")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "institution" ? "segment-button-active font-medium" : ""}`}
              >
                按机构
              </button>
            </div>
          </SettingRow>
          <SettingRow title="隐藏零余额账户" desc="减少侧边栏噪音。">
            <input
              type="checkbox"
              checked={sidebarHideZero}
              onChange={(e) => updateSidebarHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow title="隐藏初始数据" desc="隐藏左侧导航中“初始数据”入口，避免日常使用时误点。">
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
        <SettingRow title="涨跌颜色" desc="统一收益、净值和盈亏颜色口径。" wide>
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
              {savingScheme ? "应用中" : "应用"}
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title="界面语言" desc="选择中文、英文或日文显示；业务数据不受影响。">
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
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title="信用卡左侧栏显示内容" desc="用于左侧栏账户列表；账户名已包含后四位时，后四位固定自动省略。" wide>
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
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={savingCreditCardSidebarDisplayName}
                  onClick={() => setCreditCardSidebarDisplayName(SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE)}
                  className="secondary-button h-8 px-3 text-xs"
                >
                  默认
                </button>
                <button
                  type="button"
                  disabled={savingCreditCardSidebarDisplayName}
                  onClick={() => void saveCreditCardSidebarDisplayName(creditCardSidebarDisplayName)}
                  className="primary-button h-8 px-3 text-xs"
                >
                  保存
                </button>
              </div>
              <div className="text-xs text-slate-500">预览：<span className="font-medium text-slate-800">{sidebarPreview || "请输入显示内容"}</span></div>
            </div>
          </SettingRow>

          <SettingRow title="信用卡表格内显示内容" desc="用于账户页、概览、业务页面等表格内显示；同样遵守尾号不重复规则。" wide>
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
                    {preset.label}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={savingCreditCardDisplayName}
                  onClick={() => setCreditCardDisplayName(DEFAULT_CREDIT_CARD_LABEL_TEMPLATE)}
                  className="secondary-button h-8 px-3 text-xs"
                >
                  默认
                </button>
                <button
                  type="button"
                  disabled={savingCreditCardDisplayName}
                  onClick={() => void saveCreditCardDisplayName(creditCardDisplayName)}
                  className="primary-button h-8 px-3 text-xs"
                >
                  保存
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {CREDIT_CARD_NAME_FIELDS.map((field) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => setCreditCardDisplayName((current) => `${current}${field}`)}
                    className="secondary-button h-7 px-2 text-[11px]"
                    title={`插入 ${field}`}
                  >
                    {field}
                  </button>
                ))}
              </div>
              <div className="text-xs text-slate-500">预览：<span className="font-medium text-slate-800">{tablePreview || "请输入显示内容"}</span></div>
            </div>
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title="时区模式" desc="控制页面日期与版本信息的显示时区，可跟随系统或固定时区。">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => saveTimeZone("system", timeZone)}
                disabled={savingTimeZone}
                className={`segment-button h-9 px-4 ${timeZoneMode === "system" ? "segment-button-active font-medium" : ""}`}
              >
                跟随系统
              </button>
              <button
                type="button"
                onClick={() => saveTimeZone("specified", timeZone)}
                disabled={savingTimeZone}
                className={`segment-button h-9 px-4 ${timeZoneMode === "specified" ? "segment-button-active font-medium" : ""}`}
              >
                指定时区
              </button>
            </div>
          </SettingRow>

          {timeZoneMode === "specified" ? (
            <SettingRow title="指定时区" desc="选择固定时区，避免跨设备显示不一致。">
              <select
                value={timeZone}
                onChange={(e) => saveTimeZone("specified", e.target.value)}
                disabled={savingTimeZone}
                className="form-input"
              >
                {TIME_ZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </SettingRow>
          ) : null}
        </div>
      </section>
    </div>
  );
}
