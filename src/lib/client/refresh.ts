"use client";

import { useRouter } from "next/navigation";

export const FINANCE_DATA_CHANGED_EVENT = "mmh:finance:changed";
export const LEGACY_FINANCE_REFRESH_EVENT = "mmh:fund:refresh";

export type FinanceDataChangedDetail = {
  reason?: string;
  accountIds?: string[];
  entryIds?: string[];
  deletedEntryIds?: string[];
  statementMonth?: string;
};

export function dispatchFinanceDataChanged(detail: FinanceDataChangedDetail = {}) {
  window.dispatchEvent(new CustomEvent(FINANCE_DATA_CHANGED_EVENT, { detail }));
  // Keep the old event during migration; many existing views still listen to it.
  window.dispatchEvent(new CustomEvent(LEGACY_FINANCE_REFRESH_EVENT, { detail }));
}

/**
 * Full route refresh helper.
 * Prefer dispatchFinanceDataChanged for ordinary saves/deletes/imports; use this
 * only for explicit user refresh actions or global context switches.
 */
export function useRefresh() {
  const router = useRouter();

  /**
   * Delayed route refresh for true full-page refresh scenarios.
   * @param delay delay in milliseconds, defaults to 100ms
   */
  async function refresh(delay = 100) {
    await new Promise(resolve => setTimeout(resolve, delay));
    router.refresh();
  }

  return refresh;
}

export function useFinanceRefresh() {
  /**
   * Broadcast a scoped finance-data change. Visible views should refresh their
   * own affected rows, balances, and summaries without a full route refresh.
   */
  return function refreshFinanceData(detail: FinanceDataChangedDetail = {}) {
    dispatchFinanceDataChanged(detail);
  };
}
