"use client";

import { useEffect, useState } from "react";
import {
  getFundUnitsDecimalsPreference,
  getSidebarGroupPreference,
  getSidebarHideZeroPreference,
  setFundUnitsDecimalsPreference,
  setSessionDaysPreference,
  setSidebarGroupPreference,
  setSidebarHideZeroPreference,
  type SidebarGroupMode,
} from "@/lib/client/appPreferences";

type ColorScheme = "red_up_green_down" | "green_up_red_down";

const SESSION_DAY_OPTIONS = [
  { value: 1, label: "1 天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 180, label: "180 天" },
  { value: 365, label: "365 天" },
];

const FUND_UNITS_DECIMAL_OPTIONS = [0, 1, 2, 3, 4, 5, 6];

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default function DisplaySettingsPage() {
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [sessionDays, setSessionDays] = useState(30);
  const [fundUnitsDecimals, setFundUnitsDecimals] = useState(2);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingSession, setSavingSession] = useState(false);
  const [savingFundUnitsDecimals, setSavingFundUnitsDecimals] = useState(false);
  const [currentUserName, setCurrentUserName] = useState("加载中…");
  const [activeHousehold, setActiveHousehold] = useState<{ id: string; name: string } | null>(null);
  const [allHouseholds, setAllHouseholds] = useState<Array<{ id: string; name: string }>>([]);
  const [, setIsAdmin] = useState(false);
  const [switchLoading, setSwitchLoading] = useState(false);

  useEffect(() => {
    const cookieUser = getCookie("mmh_username");
    if (cookieUser) setCurrentUserName(cookieUser);

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
        if (d.ok && Number.isFinite(Number(d.sessionDays))) {
          const next = Number(d.sessionDays);
          setSessionDays(next);
          setSessionDaysPreference(next);
        }
        if (d.ok && Number.isFinite(Number(d.fundUnitsDecimals))) {
          const next = Number(d.fundUnitsDecimals);
          setFundUnitsDecimals(next);
          setFundUnitsDecimalsPreference(next);
        }
      })
      .catch(() => {});

    fetch("/api/v1/households")
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          if (d.active) setActiveHousehold(d.active);
          if (d.households) setAllHouseholds(d.households);
          setIsAdmin(d.isAdmin === true);
        }
      })
      .catch(() => {});

    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setFundUnitsDecimals(getFundUnitsDecimalsPreference());
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

  async function saveSessionDays(next: number) {
    const prev = sessionDays;
    setSessionDays(next);
    setSessionDaysPreference(next);
    setSavingSession(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionDays: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSessionDays(prev);
        setSessionDaysPreference(prev);
      }
    } catch {
      setSessionDays(prev);
      setSessionDaysPreference(prev);
    } finally {
      setSavingSession(false);
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

  function updateSidebarGroup(next: SidebarGroupMode) {
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function updateSidebarHideZero(next: boolean) {
    setSidebarHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  async function switchHousehold(hid: string) {
    setSwitchLoading(true);
    try {
      const res = await fetch("/api/v1/households/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ householdId: hid }),
      });
      const data = await res.json();
      if (data.ok) {
        window.location.href = "/";
      } else {
        alert(data.error || "切换失败");
      }
    } catch {
      alert("切换失败");
    } finally {
      setSwitchLoading(false);
    }
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
        <p className="mt-1 text-xs text-slate-500">把登录保留、账簿切换和侧边栏行为集中放这里管理。</p>
      </div>

      {/* --- 账簿与账户 --- */}
      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">当前账簿</div>
            <div className="mt-1 text-xs text-slate-500">当前正在管理和记录的账簿，可在此切换。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-slate-800">
                {activeHousehold ? activeHousehold.name : "加载中…"}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                登录账户：{currentUserName}
              </div>
            </div>
          </div>
          {allHouseholds.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-600">切换账簿</div>
              <div className="flex flex-wrap gap-2">
                {allHouseholds.map(h => (
                  <button
                    key={h.id}
                    disabled={switchLoading}
                    onClick={() => switchHousehold(h.id)}
                    className={`h-8 px-3 rounded-md border text-sm transition ${
                      activeHousehold?.id === h.id
                        ? "border-blue-300 bg-blue-50 text-blue-700 font-medium"
                        : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {h.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <a
              href="/login"
              className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-1.5"
            >
              重新登录
            </a>
            <a
              href="/login?reset=1"
              className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-500 hover:text-blue-700 hover:border-blue-200 flex items-center gap-1.5"
            >
              找回密码
            </a>
          </div>
        </div>
      </section>

      {/* --- 登录与会话 --- */}
      <section className="panel-surface overflow-hidden">
        <div className="panel-header">
          <div>
            <div className="text-sm font-medium text-slate-800">登录与会话</div>
            <div className="mt-1 text-xs text-slate-500">控制桌面端重新打开后是否还需要重新登录。</div>
          </div>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid gap-2 sm:max-w-xs">
            <label className="form-label">登录保留时长</label>
            <select
              value={sessionDays}
              onChange={(e) => saveSessionDays(Number(e.target.value))}
              disabled={savingSession}
              className="form-input"
            >
              {SESSION_DAY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="text-xs text-slate-500">
              当前设备会尽量在这段时间内保持登录。退出登录后不会自动恢复。
            </p>
          </div>
        </div>
      </section>

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
    </div>
  );
}
