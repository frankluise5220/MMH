"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { DEFAULT_CREDIT_CARD_LABEL_TEMPLATE, SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE } from "@/lib/account-display";
import {
  getCreditCardLabelTemplatePreference,
  getDisplayLanguagePreference,
  getFundUnitsDecimalsPreference,
  getSidebarGroupPreference,
  getSidebarHideZeroPreference,
  getTimeZoneModePreference,
  getTimeZonePreference,
  setCreditCardLabelTemplatePreference,
  setDisplayLanguagePreference,
  setFundUnitsDecimalsPreference,
  setSidebarGroupPreference,
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

const FUND_UNITS_DECIMAL_OPTIONS = [0, 1, 2, 3, 4, 5, 6];
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

function previewCreditCardName(value: string) {
  return value
    .replaceAll("{机构简称}", "招行")
    .replaceAll("{机构全称}", "招商银行")
    .replaceAll("{机构名称}", "招商银行")
    .replaceAll("{信用卡名称}", "优享白金卡")
    .replaceAll("{账户名称}", "优享白金卡")
    .replaceAll("{信用卡后4位}", "8333")
    .replaceAll("{后4位}", "8333");
}

function previewCreditCardListName(accountName = "优享白金卡") {
  const last4 = accountName.includes("8333") ? "" : "8333";
  return SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE
    .replaceAll("{机构简称}", "招行")
    .replaceAll("{机构名称}", "招商银行")
    .replaceAll("{信用卡名称}", accountName)
    .replaceAll("{信用卡后4位}", last4)
    .replace(/[·]{2,}/g, "·")
    .replace(/(^[·\s]+|[·\s]+$)/g, "");
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
  const [fundUnitsDecimals, setFundUnitsDecimals] = useState(2);
  const [displayLanguage, setDisplayLanguage] = useState<DisplayLanguage>("zh-CN");
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [creditCardDisplayName, setCreditCardDisplayName] = useState(DEFAULT_CREDIT_CARD_LABEL_TEMPLATE);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingFundUnitsDecimals, setSavingFundUnitsDecimals] = useState(false);
  const [savingDisplayLanguage, setSavingDisplayLanguage] = useState(false);
  const [savingCreditCardDisplayName, setSavingCreditCardDisplayName] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/color-scheme")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && (d.colorScheme === "red_up_green_down" || d.colorScheme === "green_up_red_down")) {
          setScheme(d.colorScheme);
        }
      })
      .catch(() => {});

    fetch("/api/v1/settings/app-preferences")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && Number.isFinite(Number(d.fundUnitsDecimals))) {
          setFundUnitsDecimals(Number(d.fundUnitsDecimals));
        }
        if (d.ok && (d.displayLanguage === "zh-CN" || d.displayLanguage === "en-US" || d.displayLanguage === "ja-JP")) {
          setDisplayLanguage(d.displayLanguage);
        }
        if (d.ok && (d.timeZoneMode === "system" || d.timeZoneMode === "specified")) {
          setTimeZoneMode(d.timeZoneMode);
        }
        if (d.ok && typeof d.timeZone === "string") {
          setTimeZone(d.timeZone);
        }
        if (d.ok && typeof d.creditCardLabelTemplate === "string") {
          setCreditCardDisplayName(d.creditCardLabelTemplate || DEFAULT_CREDIT_CARD_LABEL_TEMPLATE);
        }
      })
      .catch(() => {});

    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setFundUnitsDecimals(getFundUnitsDecimalsPreference());
    setDisplayLanguage(getDisplayLanguagePreference());
    setTimeZoneMode(getTimeZoneModePreference());
    setTimeZone(getTimeZonePreference());
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
      if (!data.ok) setScheme(prev);
    } catch {
      setScheme(prev);
    } finally {
      setSavingScheme(false);
    }
  }

  async function saveFundUnitsDecimals(next: number) {
    const prev = fundUnitsDecimals;
    setFundUnitsDecimals(next);
    setFundUnitsDecimalsPreference(next);
    setSavingFundUnitsDecimals(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundUnitsDecimals: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setFundUnitsDecimals(prev);
        setFundUnitsDecimalsPreference(prev);
      }
    } catch {
      setFundUnitsDecimals(prev);
      setFundUnitsDecimalsPreference(prev);
    } finally {
      setSavingFundUnitsDecimals(false);
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

  function updateSidebarGroup(next: SidebarGroupMode) {
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function updateSidebarHideZero(next: boolean) {
    setSidebarHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  const preview = useMemo(() => previewCreditCardName(creditCardDisplayName), [creditCardDisplayName]);

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
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">侧边栏</div>
            <div className="mt-1 text-xs text-slate-500">这些属于本机浏览器习惯。</div>
          </div>
        </div>
        <div>
          <SettingRow title="账户显示方式" desc="控制左侧账户列表按资产类型或机构归类。">
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
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">涨跌颜色</div>
            <div className="mt-1 text-xs text-slate-500">统一收益、净值和盈亏颜色口径。</div>
          </div>
        </div>
        <div>
          <SettingRow title="选择颜色规则" desc="设置红涨绿跌或绿涨红跌，并显示示例效果。" wide>
            <div className="grid gap-2 lg:grid-cols-2">
              {colorOptions.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3 py-2 transition ${
                    scheme === opt.value ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <input
                    type="radio"
                    name="colorScheme"
                    value={opt.value}
                    checked={scheme === opt.value}
                    onChange={() => saveScheme(opt.value)}
                    disabled={savingScheme}
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                    <div className="text-xs text-slate-500">{opt.desc}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    <span className={opt.preview.up}>+1.23%</span>
                    <span className="text-slate-400">/</span>
                    <span className={opt.preview.down}>-0.56%</span>
                  </div>
                </label>
              ))}
            </div>
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">界面语言</div>
            <div className="mt-1 text-xs text-slate-500">先用于产品介绍和后续可国际化区域，业务数据不受影响。</div>
          </div>
        </div>
        <div>
          <SettingRow title="显示语言" desc="选择中文、英文或日文显示。">
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
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">基金显示</div>
            <div className="mt-1 text-xs text-slate-500">控制基金份额小数位数。</div>
          </div>
        </div>
        <div>
          <SettingRow title="选择小数位" desc="设置基金份额展示精度。">
            <select
              value={fundUnitsDecimals}
              onChange={(e) => saveFundUnitsDecimals(Number(e.target.value))}
              disabled={savingFundUnitsDecimals}
              className="form-input"
            >
              {FUND_UNITS_DECIMAL_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value} 位
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">账户显示名称</div>
            <div className="mt-1 text-xs text-slate-500">按使用场景控制账户名称显示，列表场景保持紧凑稳定。</div>
          </div>
        </div>
        <div>
          <SettingRow title="列表显示" desc="用于侧边栏等账户列表，固定使用机构简称、账户名称和后四位。" wide>
            <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px]">
                <div>
                  <div className="text-[11px] font-medium text-slate-500">规则</div>
                  <div className="mt-1 break-all text-sm font-medium text-slate-900">{SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE}</div>
                </div>
                <div>
                  <div className="text-[11px] font-medium text-slate-500">普通预览</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{previewCreditCardListName()}</div>
                </div>
                <div>
                  <div className="text-[11px] font-medium text-slate-500">账户名含后四位</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{previewCreditCardListName("优享白金卡8333")}</div>
                </div>
              </div>
              <div className="mt-2 text-[11px] leading-5 text-slate-500">
                如果后四位已经包含在账户名称里，列表显示会自动省略尾号，避免重复。
              </div>
            </div>
          </SettingRow>

          <SettingRow title="可用字段" desc="点击字段可插入到信用卡显示模板。" wide>
            <div className="flex flex-wrap gap-2">
              {CREDIT_CARD_NAME_FIELDS.map((field) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => setCreditCardDisplayName((current) => `${current}${field}`)}
                  className="secondary-button h-8 px-3 text-xs"
                  title={`插入 ${field}`}
                >
                  {field}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow title="预设模板" desc="选择常用命名格式后仍可继续微调。" wide>
            <div className="flex flex-wrap gap-2">
              {CREDIT_CARD_NAME_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setCreditCardDisplayName(preset.value)}
                  className="secondary-button h-8 px-3 text-xs"
                  title={preset.example}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow title="其他场景模板" desc="用于账户页、概览、业务页面等非列表场景；保存后只更新相关显示字段，不整页刷新。" wide>
            <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-3">
              <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
                <div>
                  <div className="text-[11px] font-medium text-slate-500">当前内容</div>
                  <div className="mt-1 break-all text-sm font-medium text-slate-900">{creditCardDisplayName || "已清空"}</div>
                </div>
                <div>
                  <div className="text-[11px] font-medium text-slate-500">预览</div>
                  <div className="mt-1 text-sm font-medium text-slate-900">{preview || "请输入显示名称"}</div>
                </div>
              </div>
            </div>
          </SettingRow>

          <SettingRow title="保存模板" desc="清空或保存当前信用卡显示模板。">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={savingCreditCardDisplayName}
                onClick={() => setCreditCardDisplayName("")}
                className="secondary-button h-9 px-4 text-sm"
              >
                清除
              </button>
              <button
                type="button"
                disabled={savingCreditCardDisplayName}
                onClick={() => void saveCreditCardDisplayName(creditCardDisplayName)}
                className="primary-button h-9 px-4 text-sm"
              >
                保存
              </button>
            </div>
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">时区</div>
            <div className="mt-1 text-xs text-slate-500">控制页面日期与版本信息的显示时区。</div>
          </div>
        </div>
        <div>
          <SettingRow title="选择时区模式" desc="设置为跟随系统或固定时区。">
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
