"use client";

import { useEffect } from "react";
import { applyRemotePreferences } from "@/lib/client/appPreferences";

/**
 * 把数据库中的账簿设置同步到本机 cookie 镜像。
 *
 * 客户端组件是同步读 `getXxxPreference()` 的，所以必须有这层镜像；
 * 但镜像只在这台设备上有效，换设备后由这里拉回真值。
 */
export default function PreferencesSync() {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/v1/settings/app-preferences", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        // 未登录时不覆盖：此时拿到的是默认值，覆盖会把用户本机设置冲掉。
        if (cancelled || !data?.ok || data.authenticated === false) return;
        applyRemotePreferences(data);
      } catch {
        // 离线或接口不可用：继续沿用本地镜像。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
