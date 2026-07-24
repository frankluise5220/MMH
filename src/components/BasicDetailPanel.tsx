"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Upload } from "lucide-react";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DebitBalanceReconcileButton } from "@/components/DebitBalanceReconcileButton";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { FINANCE_DATA_CHANGED_EVENT, LEGACY_FINANCE_REFRESH_EVENT } from "@/lib/client/refresh";
import {
  DETAIL_PAGE_SIZE_OPTIONS,
  decodeDetailPaginationPreference,
  detailPaginationCookieName,
  encodeDetailPaginationPreference,
  normalizeDetailPageSize,
} from "@/lib/detail-pagination-preference";

type BasicDetailPanelProps = {
  accountId: string;
  isInvestAccount: boolean;
  entries: DetailEntry[];
  totalCount: number;
  originalCount: number;
  hasDetailFilters: boolean;
  initialPage: number;
  initialPageSize: number;
  initialDetailAll: boolean;
  normalExportHref: string;
  normalExportFilename: string;
  accountOptions: Array<{ id: string; label: string; fullLabel?: string | null; title?: string | null }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  showBalanceReconcile?: boolean;
  accountLabel?: string;
  currentBalance?: number;
  focusEntryId?: string;
};

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

function readStoredDetailPreference(accountId: string) {
  if (typeof window === "undefined") return null;
  return decodeDetailPaginationPreference(window.sessionStorage.getItem(detailPaginationCookieName(accountId)));
}

function writeStoredDetailPreference(accountId: string, pageSize: number, detailAll: boolean, detailPage: number) {
  if (typeof window === "undefined") return;
  const cookieName = detailPaginationCookieName(accountId);
  const value = encodeDetailPaginationPreference({ pageSize, detailAll, detailPage });
  window.sessionStorage.setItem(cookieName, value);
  document.cookie = `${cookieName}=${value}; path=/; max-age=31536000; SameSite=Lax`;
}

export function BasicDetailPanel({
  accountId,
  isInvestAccount,
  entries,
  totalCount,
  originalCount,
  hasDetailFilters,
  initialPage,
  initialPageSize,
  initialDetailAll,
  normalExportHref,
  normalExportFilename,
  accountOptions,
  categoryOptions = [],
  investmentProductTypeByAccountId,
  compactRows = false,
  showBalanceReconcile = false,
  accountLabel = "",
  currentBalance = 0,
  focusEntryId,
}: BasicDetailPanelProps) {
  const router = useRouter();
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [localTotalCount, setLocalTotalCount] = useState(totalCount);
  const [localOriginalCount, setLocalOriginalCount] = useState(originalCount);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);

  const totalPages = Math.max(1, Math.ceil(localTotalCount / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);
  const accountScopeKey = `${accountId}:${isInvestAccount ? "invest" : "detail"}`;
  const lastAccountScopeKeyRef = useRef(accountScopeKey);
  const lastFocusEntryIdRef = useRef(focusEntryId ?? "");

  useEffect(() => {
    setLocalEntries(entries);
    setLocalTotalCount(totalCount);
    setLocalOriginalCount(originalCount);
    const nextFocusEntryId = focusEntryId ?? "";
    const accountScopeChanged = lastAccountScopeKeyRef.current !== accountScopeKey;
    const focusEntryChanged = lastFocusEntryIdRef.current !== nextFocusEntryId;
    if (accountScopeChanged || focusEntryChanged) {
      lastAccountScopeKeyRef.current = accountScopeKey;
      lastFocusEntryIdRef.current = nextFocusEntryId;
      const storedPreference = nextFocusEntryId ? null : readStoredDetailPreference(accountId);
      const nextPageSize = nextFocusEntryId ? normalizedInitialPageSize : storedPreference?.pageSize ?? normalizedInitialPageSize;
      const nextDetailAll = nextFocusEntryId ? initialDetailAll : storedPreference?.detailAll ?? initialDetailAll;
      const nextTotalPages = Math.max(1, Math.ceil(totalCount / nextPageSize));
      setPageSize(nextPageSize);
      setDetailAll(nextDetailAll);
      setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages));
    }
  }, [accountId, accountScopeKey, entries, focusEntryId, initialDetailAll, initialPage, normalizedInitialPageSize, originalCount, totalCount]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const deletedEntryIds = (event as CustomEvent<{ deletedEntryIds?: string[] }>).detail?.deletedEntryIds ?? [];
      if (deletedEntryIds.length === 0) return;
      const deletedSet = new Set(deletedEntryIds);
      setLocalEntries((current) => {
        const next = current.filter((entry) => !deletedSet.has(entry.id));
        const removedCount = current.length - next.length;
        if (removedCount > 0) {
          setLocalTotalCount((count) => Math.max(0, count - removedCount));
          setLocalOriginalCount((count) => Math.max(0, count - removedCount));
        }
        return next;
      });
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    window.addEventListener(LEGACY_FINANCE_REFRESH_EVENT, handleFinanceChange);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
      window.removeEventListener(LEGACY_FINANCE_REFRESH_EVENT, handleFinanceChange);
    };
  }, []);

  useEffect(() => {
    if (detailAll || page === safePage) return;
    setPage(safePage);
  }, [detailAll, page, safePage]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "detail");
    url.searchParams.set("pageSize", String(pageSize));
    if (detailAll) {
      url.searchParams.set("detailAll", "1");
      url.searchParams.delete("detailPage");
    } else {
      url.searchParams.delete("detailAll");
      url.searchParams.set("detailPage", String(safePage));
    }
    writeStoredDetailPreference(accountId, pageSize, detailAll, safePage);
    const nextHref = `${url.pathname}${url.search}${url.hash}`;
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref !== currentHref) {
      router.replace(nextHref, { scroll: false });
    }
  }, [accountId, detailAll, pageSize, router, safePage]);

  const pageEntries = useMemo(() => localEntries, [localEntries]);

  const setPagedSize = (nextPageSize: number) => {
    setDetailAll(false);
    setPageSize(nextPageSize);
    setPage(1);
  };

  const showAll = () => {
    setDetailAll(true);
    setPage(1);
  };

  const goPage = (nextPage: number) => {
    if (detailAll) return;
    setPage(clampPage(nextPage, totalPages));
  };

  const canPrev = !detailAll && safePage > 1;
  const canNext = !detailAll && safePage < totalPages;
  const selectionResetKey = accountScopeKey;
  const tableResetKey = `${selectionResetKey}:${detailAll ? "all" : safePage}:${pageSize}`;

  return (
    <BasicDetailSelectionProvider resetKey={selectionResetKey}>
      <BasicDetailBatchDeleteMessage />
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 md:hidden">
          <span className="text-xs text-slate-500">共 {localTotalCount} 条</span>
          <DetailTablePaginationControls
            pageSize={pageSize}
            pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
            detailAll={detailAll}
            safePage={safePage}
            totalPages={totalPages}
            canPrev={canPrev}
            canNext={canNext}
            onPageSizeChange={setPagedSize}
            onShowAll={showAll}
            onPageChange={goPage}
          />
        </div>
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={isInvestAccount}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows={compactRows}
          resetKey={tableResetKey}
          focusEntryId={focusEntryId}
          toolbarMode="custom"
          toolbarTitle="资金明细"
          toolbarRightContent={
            <div className="flex items-center gap-2 text-xs">
              <span className="text-xs text-slate-600">共 {localTotalCount} 条{hasDetailFilters ? ` / 原 ${localOriginalCount} 条` : ""}</span>
              <span className="text-slate-400">|</span>
              <Link href="/batch-import" className="h-7 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导入账单记录">
                <Upload className="w-3 h-3" />导入
              </Link>
              {showBalanceReconcile ? (
                <DebitBalanceReconcileButton
                  accountId={accountId}
                  accountLabel={accountLabel}
                  currentBalance={currentBalance}
                />
              ) : null}
              <a href={normalExportHref} download={normalExportFilename} className="h-7 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导出当前资金明细 CSV">
                <Download className="w-3 h-3" />导出
              </a>
              <span className="text-slate-400">|</span>
              <DetailTablePaginationControls
                pageSize={pageSize}
                pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
                detailAll={detailAll}
                safePage={safePage}
                totalPages={totalPages}
                canPrev={canPrev}
                canNext={canNext}
                onPageSizeChange={setPagedSize}
                onShowAll={showAll}
                onPageChange={goPage}
              />
            </div>
          }
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
