"use client";

import { useEffect, useState } from "react";

export const RECENT_ACCOUNTS_KEY = "mmh_recent_accounts";
export const RECENT_ACCOUNTS_EVENT = "mmh:recent-account-changed";

export function readRecentAccountIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function recordRecentAccount(accountId: string) {
  if (typeof window === "undefined" || !accountId) return;
  try {
    const list = readRecentAccountIds().filter((id) => id && id !== accountId);
    const next = [accountId, ...list].slice(0, 20);
    window.localStorage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(next));
    window.dispatchEvent(
      new CustomEvent(RECENT_ACCOUNTS_EVENT, {
        detail: { accountId, ids: next },
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

export function sortOptionsByRecent<T extends { id: string }>(options: T[], recentIds: string[]) {
  if (!options.length || !recentIds.length) return options;

  const rank = new Map<string, number>();
  recentIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });

  return options
    .map((option, index) => ({
      option,
      index,
      rank: rank.get(option.id) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => {
      const aRecent = Number.isFinite(a.rank);
      const bRecent = Number.isFinite(b.rank);
      if (aRecent && bRecent) return a.rank - b.rank;
      if (aRecent) return -1;
      if (bRecent) return 1;
      return a.index - b.index;
    })
    .map((item) => item.option);
}
