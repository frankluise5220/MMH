"use client";

import { useEffect, useState } from "react";
import {
  getFundUnitsDecimalsPreference,
  getSidebarGroupPreference,
  getSidebarHideZeroPreference,
  getTimeZoneModePreference,
  getTimeZonePreference,
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

export default function DisplaySettingsPage() {
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [fundUnitsDecimals, setFundUnitsDecimals] = useState(2);
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingFundUnitsDecimals, setSavingFundUnitsDecimals] = useState(false);

  useEffect(() => {
    fetch("/api/v1/settings/color-scheme")
      .then(r => r.json())
      .then(d => {
        if (d.ok && (d.colorScheme === "red_up_green_down" || d.colorScheme === "green_up_red_down")) {
          setScheme(d.colorScheme);
        }
      })
      .catch(() => {});

    fetch("/api/v1/settings/app-preferences")
      .then(r => r.json())
      .then(d => {
        if (d.ok && Number.isFinite(Number(d.fundUnitsDecimals))) {
          const next = Number(d.fundUnitsDecimals);
          setFundUnitsDecimals(next);
          setFundUnitsDecimalsPreference(next);
        }
        if (d.ok && (d.timeZoneMode === "system" || d.timeZoneMode === "specified")) {
          setTimeZoneMode(d.timeZoneMode);
        }
        if (d.ok && typeof d.timeZone === "string") {
          setTimeZone(d.timeZone);
        }
      })
      .catch(() => {});

    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setFundUnitsDecimals(getFundUnitsDecimalsPreference());
    setTimeZoneMode(getTimeZoneModePreference());
    setTimeZone(getTimeZonePreference());
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

  function updateSidebarGroup(next: SidebarGroupMode) {
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function updateSidebarHideZero(next: boolean) {
    setSidebarHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  const colorOptions: { value: ColorScheme; label: string; desc: string; preview: { up: string; down: string } }[] = [
    {
      value: "red_up_green_down",
      label: "红涨绿跌",
      desc: "更符合国内常见金融产品显示习惯。",
      preview: { up: "text-red-600", down: "text-emerald-700" },
    },
    {
      value: "green_up_red_down",
      label: "绿涨红跌",
      desc: "更符合国际市场常见显示习惯。",
      preview: { up: "text-emerald-700", down: "text-red-600" },
    },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">显示与应用设置</h2>
        <p className="mt-1 text-xs text-slate-500">管理显示密度、颜色、时区和侧边栏行为。</p>
      </div>

      {/* --- 侧边栏 --- */}
      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">侧边栏</div>
            <div className="mt-1 text-xs text-slate-500">这些属于 APP 端使用习惯，不应该每次重新进来再调一遍。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <div className="space-y-2">
            <div className="form-label">账户所有人显示方式</div>
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
              <div className="mt-1 text-xs text-slate-500">减少侧边栏噪音，保留更常用的账户视图。</div>
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

      {/* --- 涨跌颜色 --- */}
      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">涨跌颜色</div>
            <div className="mt-1 text-xs text-slate-500">统一所有收益、净值和盈亏颜色口径。</div>
          </div>
        </div>
        <div className="space-y-2 p-4">
          {colorOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-center gap-3 rounded-[10px] border p-3 transition ${
                scheme === opt.value
                  ? "border-blue-300 bg-blue-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
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
            <div className="mt-1 text-xs text-slate-500">控制基金持仓和交易明细里份额数字的显示精度。</div>
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
                <option key={value} value={value}>{value} 位</option>
              ))}
            </select>
            <p className="text-xs text-slate-500">
              只影响页面显示；数据库仍保留原始精度，计算不会因为这里减少小数位而丢失。
            </p>
          </div>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">时区</div>
            <div className="mt-1 text-xs text-slate-500">控制页面上时间和版本信息的显示时区。</div>
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
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
