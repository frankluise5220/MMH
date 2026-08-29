"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider, type BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { CREDIT_BILL_DETAIL_SELECTION_EVENT, type CreditBillDetailSelectionDetail } from "@/lib/client/creditBillDetailSelection";
import { useI18n } from "@/lib/i18n";
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
  resetKey: string;
  selectedBillMonth: string;
  title: ReactNode;
  periodLabel?: ReactNode;
  accountOptions: Array<{ id: string; label: string; fullLabel?: string | null; title?: string | null; kind?: string | null; debtDirection?: string | null; numberMasked?: string | null }>;
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
  resetKey,
  selectedBillMonth,
  title,
  periodLabel,
  accountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
}: CreditBillDetailPanelProps) {
  const router = useRouter();
  const { t } = useI18n();
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);
  const [isSwitchLoading, setIsSwitchLoading] = useState(false);
  const [clientTitle, setClientTitle] = useState(title);
  const [clientPeriodLabel, setClientPeriodLabel] = useState(periodLabel);
  const [clientScopeKey, setClientScopeKey] = useState(resetKey || `${accountId}:credit-bill-detail`);
  const totalPages = Math.max(1, Math.ceil(localEntries.length / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);
  const propScopeKey = resetKey || `${accountId}:credit-bill-detail`;
  const scopeKey = clientScopeKey;
  const lastScopeKeyRef = useRef(scopeKey);
  const selectionFetchSeqRef = useRef(0);

  useEffect(() => {
    setLocalEntries(entries);
    setClientTitle(title);
    setClientPeriodLabel(periodLabel);
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
      setPageSize(nextPageSize);
      setDetailAll(nextDetailAll);
      setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages));
    }
  }, [accountId, entries, initialDetailAll, initialPage, normalizedInitialPageSize, periodLabel, propScopeKey, selectedBillMonth, title]);

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
          const nextPageSize = storedPreference?.pageSize ?? pageSize;
          // Switching to a specific bill month should show that month's
          // details, not the persisted "show all" preference. Only the page
          // size preference carries over; detailAll resets to false so the
          // user sees the selected period's transactions.
          const nextDetailAll = false;
          const nextTotalPages = Math.max(1, Math.ceil(nextEntries.length / nextPageSize));
          setLocalEntries(nextEntries);
          setPageSize(nextPageSize);
          setDetailAll(nextDetailAll);
          setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? 1, nextTotalPages));
          setClientScopeKey(`${accountId}:${billMonth}:credit-bill-detail`);
          if (payload.data?.showAllDetails) {
            setClientTitle(t("creditBill.allDetails"));
            setClientPeriodLabel(undefined);
          } else {
            const cycle = payload.data?.cycle;
            const statementMonth = cycle?.statementMonth || billMonth;
            setClientTitle(t("creditBill.detailTitleWithMonth", { month: statementMonth }));
            setClientPeriodLabel(
              cycle?.periodLabel
                ? <>{t("creditBill.period")}: {cycle.periodLabel} · {cycle.isCurrentCycle ? t("creditBill.currentCycle") : t("creditBill.currentBill")}</>
                : undefined,
            );
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
  }, [accountId, detailAll, pageSize, router, t]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string; accountIds?: string[]; deletedEntryIds?: string[] }>).detail;
      if (
        detail?.reason === "bill-cycle" &&
        (!detail.accountIds?.length || detail.accountIds.includes(accountId))
      ) {
        router.refresh();
        return;
      }
      const deletedEntryIds = detail?.deletedEntryIds ?? [];
      if (deletedEntryIds.length === 0) return;
      const deletedSet = new Set(deletedEntryIds);
      setLocalEntries((current) => current.filter((entry) => !deletedSet.has(entry.id)));
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
  }, [accountId, router]);

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
    if (nextHref !== currentHref) window.history.replaceState(window.history.state, "", nextHref);
  }, [accountId, detailAll, pageSize, safePage]);

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
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows
          showAccountColumn={showCardColumn}
          accountColumnLabel={t("creditBillDetail.accountNo")}
          accountColumnMode="cardLast4"
          accountColumnDefaultHidden
          relatedAccountDefaultHidden
          showRunningBalance={false}
          reorderAccountIds={reorderAccountIds}
          storageKey="mmh_credit_bill_detail_table_v1"
          resetKey={tableResetKey}
          refreshOnGlobalEvent
          toolbarMode="custom"
          batchReplaceFields={CREDIT_BILL_BATCH_REPLACE_FIELDS}
          toolbarTitle={clientTitle}
          toolbarRightContent={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-slate-500 tabular-nums">
              {clientPeriodLabel ? <span className="hidden whitespace-nowrap md:inline">{clientPeriodLabel}</span> : null}
              <span className="whitespace-nowrap text-slate-600">
                {t("creditBillDetail.recordCount", { count: localEntries.length })}
                {isSwitchLoading ? t("basicDetail.loadingSuffix") : ""}
              </span>
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
          emptyText={t("detail.empty")}
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
