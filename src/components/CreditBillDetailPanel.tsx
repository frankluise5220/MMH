"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider, type BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
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

type CreditBillDetailPanelProps = {
  accountId: string;
  reorderAccountIds?: string[];
  showCardColumn?: boolean;
  entries: DetailEntry[];
  initialPage: number;
  initialPageSize: number;
  initialDetailAll: boolean;
  resetKey: string;
  title: ReactNode;
  periodLabel?: ReactNode;
  accountOptions: Array<{ id: string; label: string; fullLabel?: string | null; title?: string | null; kind?: string | null; debtDirection?: string | null; numberMasked?: string | null }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
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

export function CreditBillDetailPanel({
  accountId,
  reorderAccountIds,
  showCardColumn = false,
  entries,
  initialPage,
  initialPageSize,
  initialDetailAll,
  resetKey,
  title,
  periodLabel,
  accountOptions,
  categoryOptions = [],
  investmentProductTypeByAccountId,
}: CreditBillDetailPanelProps) {
  const router = useRouter();
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);
  const totalPages = Math.max(1, Math.ceil(localEntries.length / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);
  const scopeKey = resetKey || `${accountId}:credit-bill-detail`;
  const lastScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    setLocalEntries(entries);
    if (lastScopeKeyRef.current !== scopeKey) {
      lastScopeKeyRef.current = scopeKey;
      const storedPreference = readStoredDetailPreference(accountId);
      const nextPageSize = storedPreference?.pageSize ?? normalizedInitialPageSize;
      const nextDetailAll = storedPreference?.detailAll ?? initialDetailAll;
      const nextTotalPages = Math.max(1, Math.ceil(entries.length / nextPageSize));
      setPageSize(nextPageSize);
      setDetailAll(nextDetailAll);
      setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages));
    }
  }, [accountId, entries, initialDetailAll, initialPage, normalizedInitialPageSize, scopeKey]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const deletedEntryIds = (event as CustomEvent<{ deletedEntryIds?: string[] }>).detail?.deletedEntryIds ?? [];
      if (deletedEntryIds.length === 0) return;
      const deletedSet = new Set(deletedEntryIds);
      setLocalEntries((current) => current.filter((entry) => !deletedSet.has(entry.id)));
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
    url.searchParams.set("view", "bill");
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
    if (nextHref !== currentHref) router.replace(nextHref, { scroll: false });
  }, [accountId, detailAll, pageSize, router, safePage]);

  const pageEntries = useMemo(
    () => detailAll ? localEntries : localEntries.slice((safePage - 1) * pageSize, safePage * pageSize),
    [detailAll, localEntries, pageSize, safePage],
  );

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
  const tableResetKey = `${scopeKey}:${detailAll ? "all" : safePage}:${pageSize}`;

  return (
    <BasicDetailSelectionProvider resetKey={scopeKey}>
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <BasicDetailBatchDeleteMessage />
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={false}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows
          showAccountColumn={showCardColumn}
          accountColumnLabel="卡号"
          accountColumnMode="cardLast4"
          accountColumnDefaultHidden
          relatedAccountDefaultHidden
          runningBalanceDefaultHidden
          reorderAccountIds={reorderAccountIds}
          storageKey="mmh_credit_bill_detail_table_v1"
          resetKey={tableResetKey}
          refreshOnGlobalEvent={false}
          toolbarMode="custom"
          toolbarTitle={title}
          sortable={false}
          toolbarRightContent={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-slate-500 tabular-nums">
              {periodLabel ? <span className="hidden whitespace-nowrap md:inline">{periodLabel}</span> : null}
              <span className="whitespace-nowrap text-slate-600">共 {localEntries.length} 条</span>
              <Link href="/batch-import" className="flex h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600" title="导入信用卡账单记录">
                <Upload className="h-3 w-3" />导入
              </Link>
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
          emptyText="暂无记录"
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
