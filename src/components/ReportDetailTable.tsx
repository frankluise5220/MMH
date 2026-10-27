"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { formatMoney } from "@/lib/format";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";
import { useDetailPagination } from "@/lib/client/use-detail-pagination";

type AccountOption = {
  id: string;
  label: string;
  listLabel?: string | null;
  selectorLabel?: string | null;
  fullLabel?: string | null;
  title?: string | null;
  hoverTitle?: string | null;
  tableHoverTitle?: string | null;
  kind?: string | null;
  liabilityDirection?: string | null;
};

const PAGE_SIZE_OPTIONS = [40, 80] as const;
const REPORT_BATCH_REPLACE_FIELDS: BatchReplaceField[] = [
  "date",
  "postedAt",
  "type",
  "outflow",
  "inflow",
  "account",
  "toAccount",
  "categoryId",
  "institution",
  "tagId",
  "remark",
];

export function ReportDetailTable({
  accountId,
  entries,
  accountOptions,
  categoryOptions,
  tagOptions = [],
  investmentProductTypeByAccountId,
  title,
  total,
  colorValue,
  clearHref,
  onClear,
  onRefresh,
  resetKey,
}: {
  accountId: string;
  entries: DetailEntry[];
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | null | undefined>;
  title: string;
  total: number;
  colorValue: number;
  clearHref?: string;
  onClear?: () => void;
  onRefresh?: () => void | DetailEntry[] | Promise<void | DetailEntry[]>;
  resetKey: string;
}) {
  const colorScheme = typeof document === "undefined"
    ? "red_up_green_down"
    : getColorSchemeFromCookie(document.cookie ?? null);
  const [displayEntries, setDisplayEntries] = useState(entries);
  const { t } = useI18n();
  // 页码 / 每页行数 / 全部只有这一个状态点；上报行数不是单独的状态，
  // 是否采纳由 hook 根据来源判断。
  const detailPager = useDetailPagination({
    scopeKey: resetKey,
    rowCount: displayEntries.length,
  });
  const pageEntries = detailPager.slice(displayEntries);

  useEffect(() => {
    setDisplayEntries(entries);
  }, [entries]);

  // 换账期 / 换视图：退出「全部」并回到第一页（每页行数保持用户当前的选择）。
  const { leaveAll: leaveAllRows, goPage: goDetailPage } = detailPager;
  useEffect(() => {
    leaveAllRows();
    goDetailPage(1);
  }, [resetKey, leaveAllRows, goDetailPage]);

  useEffect(() => {
    let timer: number | null = null;
    let refreshSeq = 0;
    const refresh = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const seq = ++refreshSeq;
        try {
          const refreshedEntries = await onRefresh?.();
        if (Array.isArray(refreshedEntries) && seq === refreshSeq) {
          setDisplayEntries(refreshedEntries);
        }
      } catch {
          // Keep the current view stable; the user can refresh the page manually if needed.
        }
      }, 100);
    };
    const editSuccessEvents = [
      "mmh:transaction:edit:success",
      "mmh:investment:edit:success",
      "mmh:wealth:edit:success",
      "mmh:bond:edit:success",
      "mmh:deposit:edit:success",
      "mmh:insurance:edit:success",
    ];
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    editSuccessEvents.forEach((eventName) => window.addEventListener(eventName, refresh));
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      editSuccessEvents.forEach((eventName) => window.removeEventListener(eventName, refresh));
    };
  }, [onRefresh]);

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
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          storageKey="mmh_report_detail_table_v1"
          refreshOnGlobalEvent={false}
          toolbarMode="custom"
          batchReplaceFields={REPORT_BATCH_REPLACE_FIELDS}
          onRowsFitChange={detailPager.autoFit ? detailPager.fit : undefined}
          toolbarTitle={(
            <span className="flex min-w-0 items-center">
              <span className="truncate text-xs font-normal text-slate-600" title={title}>{title}</span>
            </span>
          )}
          toolbarRightContent={(
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>{t("reportDetail.entryCountTotal", { count: displayEntries.length })} <strong className={`tabular-nums ${pnlColor(colorValue, colorScheme)}`}>{formatMoney(total)}</strong></span>
              {onClear ? (
                <button type="button" onClick={onClear} className="text-blue-600 hover:text-blue-800 hover:underline">{t("reportDetail.clearDetails")}</button>
              ) : clearHref ? (
                <Link href={clearHref} className="text-blue-600 hover:text-blue-800 hover:underline">{t("reportDetail.clearDetails")}</Link>
              ) : null}
              <span className="text-slate-300">|</span>
              <DetailTablePaginationControls pager={detailPager} pageSizeOptions={PAGE_SIZE_OPTIONS} />
            </div>
          )}
          resetKey={resetKey}
          draggableRows={false}
          showAccountColumn
          showRunningBalance={false}
          enableAccountNavigation
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
