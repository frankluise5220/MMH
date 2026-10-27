"use client";

import { useEffect, useState } from "react";
import {
  incrementAccountUsageDaily,
  sortAccountsByUsageScore,
  type AccountUsageMap,
  type AccountUsageStat,
} from "@/lib/account-usage-score";
import { APP_PREFS_EVENT, getAccountUsageSortEnabledPreference } from "@/lib/client/appPreferences";

const RECENT_ACCOUNTS_KEY = "mmh_recent_accounts";
const ACCOUNT_USAGE_KEY = "mmh_account_usage";
const RECENT_ACCOUNTS_EVENT = "mmh:recent-account-changed";

export type { AccountUsageMap, AccountUsageStat };

function normalizeAccountUsage(raw: unknown): AccountUsageMap {
  if (!raw || typeof raw !== "object") return {};
  const next: AccountUsageMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== "object") continue;
    const item = value as { count?: unknown; lastUsedAt?: unknown; daily?: unknown };
    const count = Number(item.count);
    const lastUsedAt = Number(item.lastUsedAt);
    if (!Number.isFinite(count) || count <= 0) continue;
    let daily: Record<string, number> | undefined;
    if (item.daily && typeof item.daily === "object") {
      daily = {};
      for (const [day, dayCount] of Object.entries(item.daily as Record<string, unknown>)) {
        const normalizedDayCount = Number(dayCount);
        if (day && Number.isFinite(normalizedDayCount) && normalizedDayCount > 0) daily[day] = normalizedDayCount;
      }
      if (Object.keys(daily).length === 0) daily = undefined;
    }
    next[id] = {
      count,
      lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
      ...(daily ? { daily } : {}),
    };
  }
  return next;
}

function readRecentAccountIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function readAccountUsage(): AccountUsageMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ACCOUNT_USAGE_KEY);
    const parsed = raw ? normalizeAccountUsage(JSON.parse(raw)) : {};
    if (Object.keys(parsed).length > 0) return parsed;
    const now = Date.now();
    return Object.fromEntries(
      readRecentAccountIds().map((id, index) => [
        id,
        {
          count: 1,
          lastUsedAt: now - index,
        },
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * 记「使用一次」。
 *
 * 口径（2026-10-27 修订）：**只有新增 / 编辑 / 删除业务单据成功之后才算一次**，
 * 仅仅在账户下拉里选中账户不算。因此调用点必须放在各表单提交成功分支（或
 * 删除成功分支）里，不要再挂到 SmartSelect 的 onChange 上。
 *
 * 一笔业务涉及多个账户时（转账的转出+转入、投资的投资账户+资金账户、
 * 借贷的负债账户+收款账户）每个账户各记一次。
 */
export function recordRecentAccounts(accountIds: Array<string | null | undefined>) {
  if (typeof window === "undefined") return;
  const ids = Array.from(new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (!ids.length) return;
  try {
    const now = Date.now();
    const list = readRecentAccountIds();
    const next = [...ids, ...list.filter((id) => id && !ids.includes(id))].slice(0, 20);
    const usage = readAccountUsage();
    const nextUsage = { ...usage };
    for (const id of ids) {
      const prev = usage[id];
      nextUsage[id] = incrementAccountUsageDaily(
        {
          count: (prev?.count ?? 0) + 1,
          lastUsedAt: now,
          ...(prev?.daily ? { daily: prev.daily } : {}),
        },
        now,
      );
    }
    window.localStorage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(next));
    window.localStorage.setItem(ACCOUNT_USAGE_KEY, JSON.stringify(nextUsage));
    window.dispatchEvent(
      new CustomEvent(RECENT_ACCOUNTS_EVENT, {
        detail: { accountId: ids[0], ids: next, usage: nextUsage },
      }),
    );
  } catch {
    // ignore local preference write failures
  }
}



export function useAccountUsage() {
  const [usage, setUsage] = useState<AccountUsageMap>({});

  useEffect(() => {
    // 「按使用频率排序」关掉时返回空表：所有选择器保持原始顺序，
    // 同时因为 state 变空，切换开关会立刻触发重渲染。
    const sync = () => setUsage(getAccountUsageSortEnabledPreference() ? readAccountUsage() : {});
    sync();
    window.addEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    window.addEventListener(APP_PREFS_EVENT, sync);
    return () => {
      window.removeEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
      window.removeEventListener(APP_PREFS_EVENT, sync);
    };
  }, []);

  return usage;
}

/**
 * Score-based ordering for account pickers. Delegates to the shared algorithm
 * in `src/lib/account-usage-score.ts`: 长期习惯分（全时次数，不衰减）+
 * 起步阻尼后的近期分（近 30 天衰减计数 + 最近使用加成），因此单次操作只能
 * 让账户小幅前移，位置是缓慢变化的。Kept under the historical name for
 * existing call sites.
 *
 * 「设置 → 显示 → 按使用频率调整账户顺序」关掉时原样返回，不做任何重排。
 */
export function sortByAccountUsage<T extends { id?: string | null }>(
  items: T[],
  usage: AccountUsageMap,
  now?: number,
) {
  if (!getAccountUsageSortEnabledPreference()) return items;
  return now === undefined
    ? sortAccountsByUsageScore(items, usage)
    : sortAccountsByUsageScore(items, usage, now);
}
