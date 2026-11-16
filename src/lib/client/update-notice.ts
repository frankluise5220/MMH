"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 「有新版本可升级」的客户端缓存。
 *
 * 为什么不是只打一次接口：设置页的系统更新接口只有管理员能调，而且成本高（读
 * Release 正文、更新器清单、GitHub 兜底）。这里存一份极小的结果在本地，节流
 * 6 小时再问一次服务端（服务端本身还有 30 分钟缓存），既能让侧边栏一打开就知道
 * 有更新，也不会让每次切页面都去摸镜像源。
 *
 * 「稍后再说」按**版本号**记：0.1.86 被忽略之后，0.1.87 发布时还要重新提示，
 * 否则用户一次点掉就永远收不到后续升级通知了。
 */

export const UPDATE_NOTICE_EVENT = "mmh:update-notice";

const STORAGE_KEY = "mmh_update_notice";
const DISMISSED_KEY = "mmh_update_notice_dismissed";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateNotice = {
  available: boolean;
  canCheck: boolean;
  localVersion: string;
  remoteVersion: string;
  remoteCommit: string;
  checkedAt: number;
};

function parseNotice(raw: string | null): UpdateNotice | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateNotice> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.checkedAt !== "number" || !Number.isFinite(parsed.checkedAt)) return null;
    return {
      available: Boolean(parsed.available),
      canCheck: Boolean(parsed.canCheck),
      localVersion: String(parsed.localVersion ?? ""),
      remoteVersion: String(parsed.remoteVersion ?? ""),
      remoteCommit: String(parsed.remoteCommit ?? ""),
      checkedAt: parsed.checkedAt,
    };
  } catch {
    return null;
  }
}

export function readUpdateNotice(): UpdateNotice | null {
  if (typeof window === "undefined") return null;
  try {
    return parseNotice(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeUpdateNotice(notice: UpdateNotice) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notice));
    window.dispatchEvent(new CustomEvent(UPDATE_NOTICE_EVENT));
  } catch {
    // 本地缓存写失败不影响主流程，下次挂载再查一遍
  }
}

/** 同一次「有新版本」的标识：优先版本号，镜像没有 version 标签时退回 commit。 */
export function updateNoticeKey(notice: UpdateNotice | null): string {
  if (!notice?.available) return "";
  return notice.remoteVersion || notice.remoteCommit;
}

export function readDismissedUpdateKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(DISMISSED_KEY) ?? "";
  } catch {
    return "";
  }
}

export function dismissUpdateNotice(notice: UpdateNotice | null) {
  const key = updateNoticeKey(notice);
  if (typeof window === "undefined" || !key) return;
  try {
    window.localStorage.setItem(DISMISSED_KEY, key);
    window.dispatchEvent(new CustomEvent(UPDATE_NOTICE_EVENT));
  } catch {
    // ignore
  }
}

async function fetchUpdateNotice(): Promise<UpdateNotice | null> {
  try {
    const res = await fetch("/api/v1/settings/system-update/notice", { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return null;
    return {
      available: Boolean(data.available),
      canCheck: Boolean(data.canCheck),
      localVersion: String(data.localVersion ?? ""),
      remoteVersion: String(data.remoteVersion ?? ""),
      remoteCommit: String(data.remoteCommit ?? ""),
      checkedAt: Number(data.checkedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

/** 距上次检查是否已经超过节流窗口（没有缓存视为需要检查）。 */
function needsRefresh(notice: UpdateNotice | null): boolean {
  if (!notice) return true;
  return Date.now() - notice.checkedAt > CHECK_INTERVAL_MS;
}

export function useUpdateNotice() {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  const [dismissedKey, setDismissedKey] = useState("");

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      setNotice(readUpdateNotice());
      setDismissedKey(readDismissedUpdateKey());
    };
    sync();

    const current = readUpdateNotice();
    if (needsRefresh(current)) {
      void fetchUpdateNotice().then((next) => {
        if (!cancelled && next) writeUpdateNotice(next);
      });
    }

    window.addEventListener(UPDATE_NOTICE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      cancelled = true;
      window.removeEventListener(UPDATE_NOTICE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const dismiss = useCallback(() => dismissUpdateNotice(notice), [notice]);
  const pending = Boolean(notice?.available) && updateNoticeKey(notice) !== dismissedKey;

  return { notice, pending, dismiss };
}
