"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider, type BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { withoutBasePath } from "@/lib/base-path";
import { CREDIT_BILL_DETAIL_SELECTION_EVENT, type CreditBillDetailSelectionDetail } from "@/lib/client/creditBillDetailSelection";
import { useI18n } from "@/lib/i18n";
import { useDetailPagination } from "@/lib/client/use-detail-pagination";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import {
  DETAIL_PAGE_SIZE_OPTIONS,
  clampDetailPage as clampPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
  writeStoredDetailPreference,
} from "@/lib/detail-pagination-preference";

type CreditBillDetailPanelProps = {
  accountId: string;
  reorderAccountIds?: string[];
  showCardColumn?: boolean;
  entries: DetailEntry[];
  initialPage: number;
  initialPageSize: number;
  initialDetailAll: boolean;
  initialAutoFit?: boolean;
  resetKey: string;
  selectedBillMonth: string;
  title: ReactNode;
  /** 账户单元格的显示来源，应为全量账户（按「账户显示格式」渲染标签与 hover）。 */
  accountOptions: Array<{ id: string; label: string; listLabel?: string | null; selectorLabel?: string | null; fullLabel?: string | null; title?: string | null; hoverTitle?: string | null; tableHoverTitle?: string | null; kind?: string | null; liabilityDirection?: string | null; numberMasked?: string | null; isSettlementAccount?: boolean | null }>;
  /** 批量替换账户下拉的选项；缺省时沿用 `accountOptions`。 */
  batchReplaceAccountOptions?: Array<{ id: string; label: string; listLabel?: string | null }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
};

const CREDIT_BILL_BATCH_REPLACE_FIELDS: BatchReplaceField[] = [
  "date",
  "postedAt",
  "type",
  "outflow",
  "inflow",
  "amount",
  "viewAccount",
  "toAccount",
  "categoryId",
  "institution",
  "tagId",
  "remark",
];

type CreditBillDetailPayload = {
  ok?: boolean;
  error?: string;
  data?: {
    billMonth?: string;
    showAllDetails?: boolean;
    totalCount?: number;
    entries?: DetailEntry[];
    cycle?: {
      statementMonth?: string;
      periodLabel?: string;
      isCurrentCycle?: boolean;
    } | null;
  };
};

export function CreditBillDetailPanel({
  accountId,
  reorderAccountIds,
  showCardColumn = false,
  entries,
  initialPage,
  initialPageSize,
  initialDetailAll,
  initialAutoFit = true,
  resetKey,
  selectedBillMonth,
  title,
  accountOptions,
  batchReplaceAccountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
}: CreditBillDetailPanelProps) {
  const router = useRouter();
  const { t } = useI18n();
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [isSwitchLoading, setIsSwitchLoading] = useState(false);
  const [clientTitle, setClientTitle] = useState(title);
  const [clientScopeKey, setClientScopeKey] = useState(resetKey || `${accountId}:credit-bill-detail`);
  const propScopeKey = resetKey || `${accountId}:credit-bill-detail`;
  const scopeKey = clientScopeKey;
  const lastScopeKeyRef = useRef(scopeKey);
  const selectionFetchSeqRef = useRef(0);
  // 页码 / 每页行数 / 全部只有一个状态点：初值来自服务端 props，之后换账户、
  // 换账单月都走 `replace`，用户操作走 `select` / `showAll` / `restoreFit`。
  // URL 与 cookie 是它的镜像，只在下面这一处写。
  const billPager = useDetailPagination({
    scopeKey: propScopeKey,
    rowCount: localEntries.length,
    initial: {
      mode: initialDetailAll ? "all" : initialAutoFit ? "fit" : "manual",
      rows: normalizedInitialPageSize,
      page: initialPage,
    },
    onPersist: (state, safePage) => {
      const url = new URL(window.location.href);
      url.searchParams.set("view", "bill");
      url.searchParams.set("pageSize", String(state.rows));
      if (state.mode === "all") {
        url.searchParams.set("detailAll", "1");
        url.searchParams.delete("detailPage");
      } else {
        url.searchParams.delete("detailAll");
        url.searchParams.set("detailPage", String(safePage));
      }
      writeStoredDetailPreference(accountId, state.rows, state.mode === "all", safePage, state.mode === "fit");
      const nextHref = `${url.pathname}${url.search}${url.hash}`;
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextHref !== currentHref) window.history.replaceState(window.history.state, "", nextHref);
    },
  });
  const { replace: replaceBillPagination } = billPager;

  useEffect(() => {
    setLocalEntries(entries);
    setClientTitle(title);
    setClientScopeKey(propScopeKey);
    if (lastScopeKeyRef.current !== propScopeKey) {
      lastScopeKeyRef.current = propScopeKey;
      const storedPreference = readStoredDetailPreference(accountId);
      const nextPageSize = storedPreference?.pageSize ?? normalizedInitialPageSize;
      // When the scope is a specific bill month (not "all"), show that
      // month's details rather than the persisted "show all" preference.
      const isAllScope = /:all:credit-bill-detail$/.test(propScopeKey);
      const nextDetailAll = isAllScope ? (storedPreference?.detailAll ?? initialDetailAll) : false;
      const nextTotalPages = Math.max(1, Math.ceil(entries.length / nextPageSize));
      replaceBillPagination({
        mode: nextDetailAll ? "all" : (storedPreference?.autoFit ?? initialAutoFit) ? "fit" : "manual",
        rows: nextPageSize,
        page: nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages),
      });
    }
  }, [accountId, entries, initialAutoFit, initialDetailAll, initialPage, normalizedInitialPageSize, propScopeKey, replaceBillPagination, selectedBillMonth, title]);

  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<CreditBillDetailSelectionDetail>).detail;
      if (!detail?.accountId || detail.accountId !== accountId) return;
      const billMonth = detail.billMonth || "all";
      const seq = ++selectionFetchSeqRef.current;
      const params = new URLSearchParams({ accountId, billMonth });
      setIsSwitchLoading(true);
      fetch(`/api/v1/bill/details?${params.toString()}`, { cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json().catch(() => null) as CreditBillDetailPayload | null;
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error ?? t("basicDetail.loadFailed"));
          }
          if (seq !== selectionFetchSeqRef.current) return;
          const nextEntries = Array.isArray(payload.data?.entries) ? payload.data.entries : [];
          const storedPreference = readStoredDetailPreference(accountId);
          const nextPageSize = storedPreference?.pageSize ?? billPager.rows;
          // Switching to a specific bill month should show that month's
          // details, not the persisted "show all" preference. Only the page
          // size preference carries over; detailAll resets to false so the
          // user sees the selected period's transactions.
          const nextDetailAll = false;
          const nextTotalPages = Math.max(1, Math.ceil(nextEntries.length / nextPageSize));
          setLocalEntries(nextEntries);
          replaceBillPagination({
            mode: nextDetailAll ? "all" : (storedPreference?.autoFit ?? billPager.autoFit) ? "fit" : "manual",
            rows: nextPageSize,
            page: nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? 1, nextTotalPages),
          });
          setClientScopeKey(`${accountId}:${billMonth}:credit-bill-detail`);
          if (payload.data?.showAllDetails) {
            setClientTitle(t("creditBill.allDetails"));
          } else {
            const cycle = payload.data?.cycle;
            const statementMonth = cycle?.statementMonth || billMonth;
            setClientTitle(t("creditBill.detailTitleWithMonth", { month: statementMonth }));
          }
        })
        .catch((error) => {
          console.error("Load credit bill details failed:", error);
          router.replace(detail.href, { scroll: false });
        })
        .finally(() => {
          if (seq === selectionFetchSeqRef.current) setIsSwitchLoading(false);
        });
    };
    window.addEventListener(CREDIT_BILL_DETAIL_SELECTION_EVENT, handleSelection as EventListener);
    return () => window.removeEventListener(CREDIT_BILL_DETAIL_SELECTION_EVENT, handleSelection as EventListener);
  }, [accountId, billPager.autoFit, billPager.rows, replaceBillPagination, router, t]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string; accountIds?: string[]; deletedEntryIds?: string[] }>).detail;
      if (detail?.reason === "bill-override" || detail?.reason === "bill-override-reset") return;
      const accountIds = detail?.accountIds ?? [];
      if (accountIds.length > 0 && !accountIds.includes(accountId)) return;
      // The bill-month selector uses the browser history API for a lightweight
      // client-side switch. Refreshing through the router alone can therefore
      // use an older router URL and fall back to an empty/current bill scope.
      // Re-submit the URL currently visible in the address bar so the selected
      // bill month remains part of the server-render request.
      // The address bar already carries the fnOS gateway prefix, and
      // router.replace() adds basePath itself -- without the strip a saving
      // entry on the credit-card page navigated to /app/mmh/app/mmh?... (404).
      const currentHref = withoutBasePath(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
      router.replace(currentHref, { scroll: false });
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
  }, [accountId, router]);

  const pageEntries = billPager.slice(localEntries);

  const showAllBillDetails = () => {
    if (!selectedBillMonth) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "bill");
    url.searchParams.set("billMonth", "all");
    // Same double-prefix trap as above: url.pathname comes from the address bar.
    router.replace(withoutBasePath(`${url.pathname}${url.search}${url.hash}`), { scroll: false });
  };

  const tableResetKey = scopeKey;

  return (
    <BasicDetailSelectionProvider resetKey={scopeKey}>
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <BasicDetailBatchDeleteMessage />
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={false}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          batchReplaceAccountOptions={batchReplaceAccountOptions}
          categoryOptions={categoryOptions}
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          showAccountColumn={showCardColumn}
          accountColumnLabel={t("creditBillDetail.accountNo")}
          accountColumnMode="cardLast4"
          accountColumnDefaultHidden
          relatedAccountDefaultHidden
          showRunningBalance={false}
          reorderAccountIds={reorderAccountIds}
          storageKey="mmh_credit_bill_detail_table_v1"
          resetKey={tableResetKey}
          refreshOnGlobalEvent={false}
          toolbarMode="custom"
          batchReplaceFields={CREDIT_BILL_BATCH_REPLACE_FIELDS}
          onRowsFitChange={billPager.autoFit ? billPager.fit : undefined}
          toolbarTitle={clientTitle}
          toolbarRightContent={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-slate-500 tabular-nums">
              <button
                type="button"
                onClick={showAllBillDetails}
                disabled={!selectedBillMonth}
                className={`inline-flex h-7 items-center rounded-md border px-2 text-xs ${
                  selectedBillMonth
                    ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    : "border-blue-300 bg-blue-50 text-blue-700"
                }`}
              >
                {t("creditBill.showAllDetails")}
              </button>
              <span className="whitespace-nowrap text-slate-600">
                {t("creditBillDetail.recordCount", { count: localEntries.length })}
                {isSwitchLoading ? t("basicDetail.loadingSuffix") : ""}
              </span>
              <DetailTablePaginationControls pager={billPager} pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS} />
            </div>
          }
          emptyText={t("detail.empty")}
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
