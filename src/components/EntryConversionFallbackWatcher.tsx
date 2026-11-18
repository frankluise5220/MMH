"use client";

import { useEffect } from "react";

import { callDeleteEntries, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { ENTRY_CONVERSION_SUCCESS_EVENTS, takeEntryConversion } from "@/lib/client/entry-conversion";
import { recordRecentAccounts } from "@/lib/client/recentAccounts";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

/**
 * 「转换」收尾的兜底 Watcher（挂在 (sidebar)/layout 上，全站一份）。
 *
 * 转换入口除了明细表头，现在也在编辑窗标题栏里；编辑窗可能挂在报表、计划投资等
 * 没有明细 Provider 的页面上，那边的 `BasicDetailConvertWatcher` 不存在 ——
 * 没有兜底就会「目标记好了、原记录还留着」。
 *
 * 认领顺序：明细页/往来款页的 Watcher 先同步 `takeEntryConversion`（它负责页面提示），
 * 这里延迟 500ms 再认领，已被认领就什么都不做。会话本身是一次性的，同时挂多份也安全。
 * 兜底路径静默失败：原记录还在，用户能在明细里手动删除。
 */
export function EntryConversionFallbackWatcher() {
  useEffect(() => {
    const handler = (event: Event) => {
      const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId;
      window.setTimeout(() => {
        const session = takeEntryConversion(requestId);
        if (!session) return;
        void (async () => {
          const entryIds = [session.sourceEntryId];
          try {
            const precheck = await callDeleteEntries({ entryIds, checkOnly: true });
            if (!precheck.ok && !precheck.needConfirm) return;
            const hasLinkedBusiness = (precheck.impacts?.length ?? 0) > 0 || Boolean(precheck.needConfirm);
            const data = await callDeleteEntries({
              entryIds,
              linkedAction: hasLinkedBusiness ? "deleteBusiness" : undefined,
            });
            if (!data.ok) return;
            const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
            const accountIds = getDeleteRefreshAccountIds(data);
            recordRecentAccounts(accountIds);
            dispatchFinanceDataChanged({
              reason: "entry-convert",
              accountIds,
              deletedEntryIds: refreshEntryIds,
              entryIds: refreshEntryIds,
            });
          } catch {
            // 静默：删除失败不遮挡其它提示，原记录仍在列表里。
          }
        })();
      }, 500);
    };
    for (const eventName of ENTRY_CONVERSION_SUCCESS_EVENTS) {
      window.addEventListener(eventName, handler);
    }
    return () => {
      for (const eventName of ENTRY_CONVERSION_SUCCESS_EVENTS) {
        window.removeEventListener(eventName, handler);
      }
    };
  }, []);

  return null;
}
