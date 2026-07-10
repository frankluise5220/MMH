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
 * 客户端刷新辅助函数
 * 添加100ms延迟等待服务端revalidate完成后再刷新
 */
export function useRefresh() {
  const router = useRouter();

  /**
   * 延迟刷新页面，确保服务端revalidate完成
   * @param delay 延迟时间（毫秒），默认100ms
   */
  async function refresh(delay = 100) {
    await new Promise(resolve => setTimeout(resolve, delay));
    router.refresh();
  }

  return refresh;
}

export function useFinanceRefresh() {
  const router = useRouter();

  return async function refreshFinanceData(detail: FinanceDataChangedDetail = {}, delay = 100) {
    dispatchFinanceDataChanged(detail);
    await new Promise(resolve => setTimeout(resolve, delay));
    router.refresh();
  };
}
