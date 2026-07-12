"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { formatMoney } from "@/lib/format";
import { FINANCE_DATA_CHANGED_EVENT, LEGACY_FINANCE_REFRESH_EVENT } from "@/lib/client/refresh";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";

type AccountOption = {
  id: string;
  label: string;
  kind?: string | null;
  debtDirection?: string | null;
};

const PAGE_SIZE_OPTIONS = [10, 20, 40] as const;

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, page), totalPages);
}

export function ReportDetailTable({
  accountId,
  entries,
  accountOptions,
  categoryOptions,
  investmentProductTypeByAccountId,
  title,
  total,
  colorValue,
  clearHref,
  resetKey,
}: {
  accountId: string;
  entries: DetailEntry[];
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | null | undefined>;
  title: string;
  total: number;
  colorValue: number;
  clearHref: string;
  resetKey: string;
}) {
  const router = useRouter();
  const colorScheme = typeof document === "undefined"
    ? "red_up_green_down"
    : getColorSchemeFromCookie(document.cookie ?? null);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = showAll ? 1 : clampPage(page, totalPages);
  const pageEntries = useMemo(
    () => showAll ? entries : entries.slice((safePage - 1) * pageSize, safePage * pageSize),
    [entries, pageSize, safePage, showAll],
  );

  useEffect(() => {
    setPage(1);
    setShowAll(false);
  }, [resetKey]);

  useEffect(() => {
    if (!showAll && page !== safePage) setPage(safePage);
  }, [page, safePage, showAll]);

  useEffect(() => {
    let timer: number | null = null;
    const refresh = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => router.refresh(), 100);
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    window.addEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      window.removeEventListener(LEGACY_FINANCE_REFRESH_EVENT, refresh);
    };
  }, [router]);

  return (
    <BasicDetailSelectionProvider resetKey={resetKey}>
      <BasicDetailBatchDeleteMessage />
      <div className="min-h-0 flex-1 overflow-hidden">
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={false}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows
          storageKey="mmh_report_detail_table_v1"
          refreshOnGlobalEvent={false}
          toolbarMode="custom"
          toolbarTitle={(
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">MMH明细表</span>
              <span className="truncate text-xs font-normal text-slate-500" title={title}>{title}</span>
            </span>
          )}
          toolbarRightContent={(
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>{entries.length} 条，合计 <strong className={`tabular-nums ${pnlColor(colorValue, colorScheme)}`}>{formatMoney(total)}</strong></span>
              <Link href={clearHref} className="text-blue-600 hover:text-blue-800 hover:underline">清除明细</Link>
              <span className="text-slate-300">|</span>
              <DetailTablePaginationControls
                pageSize={pageSize}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                detailAll={showAll}
                safePage={safePage}
                totalPages={totalPages}
                canPrev={!showAll && safePage > 1}
                canNext={!showAll && safePage < totalPages}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                  setShowAll(false);
                }}
                onShowAll={() => {
                  setShowAll(true);
                  setPage(1);
                }}
                onPageChange={(nextPage) => {
                  if (showAll) return;
                  setPage(clampPage(nextPage, totalPages));
                }}
              />
            </div>
          )}
          resetKey={resetKey}
          draggableRows={false}
          showAccountColumn
          showRunningBalance={false}
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
