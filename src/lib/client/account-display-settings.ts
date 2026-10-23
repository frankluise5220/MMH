"use client";

import { useEffect, useState } from "react";

import type { AccountLabelField } from "@/lib/account-display";
import { APP_PREFS_EVENT, getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { getCachedSettingsAccountData, SETTINGS_DATA_CHANGED_EVENT } from "@/lib/client/settingsCache";

/**
 * 「账户显示格式」的运行时上下文：字段顺序来自偏好 cookie，账簿本位币来自
 * 设置缓存。两个值缺一都会让渲染退化（缺 fields → 不按设置，缺 baseCurrency →
 * 非本位币既不显示也没有 hover），所以统一在这里一次读齐。
 */
export type AccountDisplaySettings = {
  fields: AccountLabelField[];
  baseCurrency: string | null;
};

export function readAccountDisplaySettings(): AccountDisplaySettings {
  const cached = getCachedSettingsAccountData();
  const baseCurrency = (cached?.baseCurrency ?? "").trim();
  return {
    fields: getAccountLabelFieldsPreference(),
    baseCurrency: baseCurrency || null,
  };
}

/**
 * 订阅偏好与设置的变更。首帧用同步读到的值，服务端渲染时 cookies 不可用会拿到
 * 默认字段，水合后 effect 立刻校正——所以不要在 `useMemo(..., [])` 里只读一次。
 */
export function useAccountDisplaySettings(): AccountDisplaySettings {
  const [settings, setSettings] = useState<AccountDisplaySettings>(() => readAccountDisplaySettings());

  useEffect(() => {
    const sync = () => setSettings(readAccountDisplaySettings());
    sync();
    window.addEventListener(APP_PREFS_EVENT, sync);
    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(APP_PREFS_EVENT, sync);
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, sync);
    };
  }, []);

  return settings;
}
