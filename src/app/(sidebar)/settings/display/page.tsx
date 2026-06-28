"use client";

import { useEffect, useMemo, useState } from "react";

import { DEFAULT_CREDIT_CARD_LABEL_TEMPLATE } from "@/lib/account-display";
import {
  getCreditCardLabelTemplatePreference,
  getFundUnitsDecimalsPreference,
  getSidebarGroupPreference,
  getSidebarHideZeroPreference,
  getTimeZoneModePreference,
  getTimeZonePreference,
  setCreditCardLabelTemplatePreference,
  setFundUnitsDecimalsPreference,
  setSidebarGroupPreference,
  setSidebarHideZeroPreference,
  setTimeZonePreference,
  type SidebarGroupMode,
  type TimeZoneMode,
} from "@/lib/client/appPreferences";

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

export default function DisplaySettingsPage() {
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [fundUnitsDecimals, setFundUnitsDecimals] = useState(2);
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [creditCardDisplayName, setCreditCardDisplayName] = useState(DEFAULT_CREDIT_CARD_LABEL_TEMPLATE);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingFundUnitsDecimals, setSavingFundUnitsDecimals] = useState(false);
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
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <div className="form-label">账户显示方式</div>
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
          </div>
          <label className="flex items-center justify-between rounded-[10px] border border-slate-200 bg-white px-3 py-3">
            <div>
              <div className="text-sm font-medium text-slate-800">隐藏零余额账户</div>
              <div className="mt-1 text-xs text-slate-500">减少侧边栏噪音。</div>
            </div>
            <input
              type="checkbox"
              checked={sidebarHideZero}
              onChange={(e) => updateSidebarHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </label>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">涨跌颜色</div>
            <div className="mt-1 text-xs text-slate-500">统一收益、净值和盈亏颜色口径。</div>
          </div>
        </div>
        <div className="space-y-2 p-4">
          {colorOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-center gap-3 rounded-[10px] border p-3 transition ${
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
              <div className="flex items-center gap-2 text-xs">
                <span className={opt.preview.up}>+1.23%</span>
                <span className="text-slate-400">/</span>
                <span className={opt.preview.down}>-0.56%</span>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">基金显示</div>
            <div className="mt-1 text-xs text-slate-500">控制基金份额小数位数。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid gap-2 sm:max-w-xs">
            <label className="form-label">基金份额小数位</label>
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
          </div>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">信用卡显示名称</div>
            <div className="mt-1 text-xs text-slate-500">后四位为空时只省略后四位；机构简称、机构名称和信用卡名称按模板照常显示。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <div className="form-label">可用字段</div>
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
          </div>

          <div className="space-y-2">
            <div className="form-label">预设</div>
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
          </div>

          <div className="rounded-[10px] border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="text-[11px] font-medium text-slate-500">当前内容</div>
            <div className="mt-1 text-sm font-medium text-slate-900 break-all">{creditCardDisplayName || "已清空"}</div>
            <div className="mt-3 text-[11px] font-medium text-slate-500">预览</div>
            <div className="mt-1 text-sm font-medium text-slate-900">{preview || "请输入显示名称"}</div>
          </div>

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
            <span className="text-xs text-slate-500">保存后只更新相关显示字段，不整页刷新。</span>
          </div>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">时区</div>
            <div className="mt-1 text-xs text-slate-500">控制页面日期与版本信息的显示时区。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
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

          {timeZoneMode === "specified" ? (
            <div className="grid gap-2 sm:max-w-sm">
              <label className="form-label">时区</label>
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
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
