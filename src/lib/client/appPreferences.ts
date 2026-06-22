"use client";

export const SESSION_DAYS_COOKIE = "mmh_session_days";
export const FUND_UNITS_DECIMALS_COOKIE = "mmh_fund_units_decimals";
export const SIDEBAR_GROUP_BY_KEY = "sidebar_group_by";
export const SIDEBAR_HIDE_ZERO_KEY = "sidebar_hide_zero";
export const APP_PREFS_EVENT = "mmh:app-preferences";

export type SidebarGroupMode = "kind" | "institution";

export type AppPreferencesSnapshot = {
  sessionDays: number;
  fundUnitsDecimals: number;
  sidebarGroupBy: SidebarGroupMode;
  sidebarHideZero: boolean;
};

const DEFAULT_SESSION_DAYS = 30;
const DEFAULT_FUND_UNITS_DECIMALS = 2;

function parseCookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function emitPreferencesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(APP_PREFS_EVENT, { detail: getAppPreferences() }));
}

export function getSessionDaysPreference(): number {
  const raw = parseCookieValue(SESSION_DAYS_COOKIE);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_DAYS;
  return Math.min(Math.round(n), 365);
}

export function setSessionDaysPreference(days: number) {
  if (typeof document === "undefined") return;
  const normalized = Math.min(Math.max(Math.round(days), 1), 365);
  document.cookie = `${SESSION_DAYS_COOKIE}=${encodeURIComponent(String(normalized))}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getFundUnitsDecimalsPreference(): number {
  const raw = parseCookieValue(FUND_UNITS_DECIMALS_COOKIE);
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FUND_UNITS_DECIMALS;
  return Math.min(Math.max(Math.round(n), 0), 6);
}

export function setFundUnitsDecimalsPreference(decimals: number) {
  if (typeof document === "undefined") return;
  const normalized = Math.min(Math.max(Math.round(decimals), 0), 6);
  document.cookie = `${FUND_UNITS_DECIMALS_COOKIE}=${encodeURIComponent(String(normalized))}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getSidebarGroupPreference(): SidebarGroupMode {
  try {
    return localStorage.getItem(SIDEBAR_GROUP_BY_KEY) === "institution" ? "institution" : "kind";
  } catch {
    return "kind";
  }
}

export function setSidebarGroupPreference(mode: SidebarGroupMode) {
  try {
    localStorage.setItem(SIDEBAR_GROUP_BY_KEY, mode);
  } catch {}
  emitPreferencesChanged();
}

export function getSidebarHideZeroPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_HIDE_ZERO_KEY) === "true";
  } catch {
    return false;
  }
}

export function setSidebarHideZeroPreference(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_HIDE_ZERO_KEY, String(value));
  } catch {}
  emitPreferencesChanged();
}

export function getAppPreferences(): AppPreferencesSnapshot {
  return {
    sessionDays: getSessionDaysPreference(),
    fundUnitsDecimals: getFundUnitsDecimalsPreference(),
    sidebarGroupBy: getSidebarGroupPreference(),
    sidebarHideZero: getSidebarHideZeroPreference(),
  };
}
