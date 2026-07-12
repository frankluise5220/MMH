"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, Upload } from "lucide-react";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DebitBalanceReconcileButton } from "@/components/DebitBalanceReconcileButton";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { FINANCE_DATA_CHANGED_EVENT, LEGACY_FINANCE_REFRESH_EVENT } from "@/lib/client/refresh";

type BasicDetailPanelProps = {
  accountId: string;
  isInvestAccount: boolean;
  entries: DetailEntry[];
  originalCount: number;
  hasDetailFilters: boolean;
  initialPage: number;
  initialPageSize: number;
  initialDetailAll: boolean;
  normalExportHref: string;
  normalExportFilename: string;
  accountOptions: Array<{ id: string; label: string }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  showBalanceReconcile?: boolean;
  accountLabel?: string;
  currentBalance?: number;
};

const PAGE_SIZE_OPTIONS = [10, 20, 40] as const;

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

export function BasicDetailPanel({
  accountId,
  isInvestAccount,
  entries,
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
}: BasicDetailPanelProps) {
  const normalizedInitialPageSize = PAGE_SIZE_OPTIONS.includes(initialPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? initialPageSize
    : 20;
  const [localEntries, setLocalEntries] = useState(entries);
  const [localOriginalCount, setLocalOriginalCount] = useState(originalCount);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);

  const totalPages = Math.max(1, Math.ceil(localEntries.length / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);

  useEffect(() => {
    setLocalEntries(entries);
    setLocalOriginalCount(originalCount);
    setPageSize(normalizedInitialPageSize);
    setDetailAll(initialDetailAll);
    setPage(initialDetailAll ? 1 : clampPage(initialPage, Math.max(1, Math.ceil(entries.length / normalizedInitialPageSize))));
  }, [entries, initialDetailAll, initialPage, normalizedInitialPageSize, originalCount]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const deletedEntryIds = (event as CustomEvent<{ deletedEntryIds?: string[] }>).detail?.deletedEntryIds ?? [];
      if (deletedEntryIds.length === 0) return;
      const deletedSet = new Set(deletedEntryIds);
      setLocalEntries((current) => {
        const next = current.filter((entry) => !deletedSet.has(entry.id));
        const removedCount = current.length - next.length;
        if (removedCount > 0) {
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
    window.history.replaceState(window.history.state, "", url);
  }, [detailAll, pageSize, safePage]);

  const pageEntries = useMemo(() => {
    if (detailAll) return localEntries;
    return localEntries.slice((safePage - 1) * pageSize, safePage * pageSize);
  }, [detailAll, localEntries, pageSize, safePage]);

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
  const selectionResetKey = `${accountId}:${isInvestAccount ? "invest" : "detail"}`;

  return (
    <BasicDetailSelectionProvider resetKey={selectionResetKey}>
      <BasicDetailBatchDeleteMessage />
      <div className="flex-1 min-h-0 overflow-hidden">
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={isInvestAccount}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows={compactRows}
          toolbarMode="custom"
          toolbarTitle="资金明细"
          toolbarRightContent={
            <div className="flex items-center gap-2 text-xs">
              <span className="text-xs text-slate-600">共 {localEntries.length} 条{hasDetailFilters ? ` / 原 ${localOriginalCount} 条` : ""}</span>
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
                pageSizeOptions={PAGE_SIZE_OPTIONS}
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
