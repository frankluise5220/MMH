"use client";

import { useEffect, useState } from "react";
import {
  incrementAccountUsageDaily,
  sortAccountsByUsageScore,
  type AccountUsageMap,
  type AccountUsageStat,
} from "@/lib/account-usage-score";

export const RECENT_ACCOUNTS_KEY = "mmh_recent_accounts";
export const ACCOUNT_USAGE_KEY = "mmh_account_usage";
export const RECENT_ACCOUNTS_EVENT = "mmh:recent-account-changed";

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

export function readRecentAccountIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function readAccountUsage(): AccountUsageMap {
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

export function recordRecentAccount(accountId: string) {
  if (typeof window === "undefined" || !accountId) return;
  try {
    const now = Date.now();
    const list = readRecentAccountIds().filter((id) => id && id !== accountId);
    const next = [accountId, ...list].slice(0, 20);
    const usage = readAccountUsage();
    const prev = usage[accountId];
    const nextUsage = {
      ...usage,
      [accountId]: incrementAccountUsageDaily(
        {
          count: (prev?.count ?? 0) + 1,
          lastUsedAt: now,
          ...(prev?.daily ? { daily: prev.daily } : {}),
        },
        now,
      ),
    };
    window.localStorage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(next));
    window.localStorage.setItem(ACCOUNT_USAGE_KEY, JSON.stringify(nextUsage));
    window.dispatchEvent(
      new CustomEvent(RECENT_ACCOUNTS_EVENT, {
        detail: { accountId, ids: next, usage: nextUsage },
      }),
    );
  } catch {
    // ignore local preference write failures
  }
}

export function useRecentAccountIds() {
  const [recentIds, setRecentIds] = useState<string[]>([]);

  useEffect(() => {
    const sync = () => setRecentIds(readRecentAccountIds());
    sync();
    window.addEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return recentIds;
}

export function useAccountUsage() {
  const [usage, setUsage] = useState<AccountUsageMap>({});

  useEffect(() => {
    const sync = () => setUsage(readAccountUsage());
    sync();
    window.addEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return usage;
}

/**
 * Score-based ordering for account pickers. Delegates to the shared algorithm
 * in `src/lib/account-usage-score.ts`: weighted operation count inside the
 * last 5 days first, then last-used recency, then all-time count, then the
 * original order. Kept under the historical name for existing call sites.
 */
export function sortByAccountUsage<T extends { id?: string | null }>(
  items: T[],
  usage: AccountUsageMap,
  now?: number,
) {
  return now === undefined
    ? sortAccountsByUsageScore(items, usage)
    : sortAccountsByUsageScore(items, usage, now);
}
