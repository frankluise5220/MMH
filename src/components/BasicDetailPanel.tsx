"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Upload } from "lucide-react";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";

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
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
};

const PAGE_SIZE_OPTIONS = [10, 20, 40] as const;

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

function pageButtonClass(enabled: boolean, tone: "muted" | "normal" = "normal") {
  if (!enabled) {
    return "h-7 w-7 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300 cursor-not-allowed";
  }
  const color = tone === "muted" ? "text-slate-400" : "text-slate-500";
  return `h-7 w-7 rounded border border-slate-200 bg-white inline-flex items-center justify-center ${color} hover:bg-slate-50`;
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
  investmentProductTypeByAccountId,
  compactRows = false,
}: BasicDetailPanelProps) {
  const normalizedInitialPageSize = PAGE_SIZE_OPTIONS.includes(initialPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? initialPageSize
    : 20;
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);

  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);

  useEffect(() => {
    setPageSize(normalizedInitialPageSize);
    setDetailAll(initialDetailAll);
    setPage(initialDetailAll ? 1 : clampPage(initialPage, Math.max(1, Math.ceil(entries.length / normalizedInitialPageSize))));
  }, [entries, initialDetailAll, initialPage, normalizedInitialPageSize]);

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
    if (detailAll) return entries;
    return entries.slice((safePage - 1) * pageSize, safePage * pageSize);
  }, [detailAll, entries, pageSize, safePage]);

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
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows={compactRows}
          toolbarMode="custom"
          toolbarTitle="资金明细"
          toolbarRightContent={
            <div className="flex items-center gap-2 text-xs">
              <span className="text-xs text-slate-600">共 {entries.length} 条{hasDetailFilters ? ` / 原 ${originalCount} 条` : ""}</span>
              <span className="text-xs text-slate-400 mx-1">|</span>
              <span className="text-xs text-slate-600">每页</span>
              {PAGE_SIZE_OPTIONS.map((n) => {
                const active = !detailAll && pageSize === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPagedSize(n)}
                    className={`h-7 px-2 rounded border inline-flex items-center justify-center ${active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`}
                  >
                    {n}
                  </button>
                );
              })}
              <button type="button" onClick={showAll} className={`h-7 px-2 rounded border inline-flex items-center justify-center ${detailAll ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"}`} title="当前账户全部记录不分页显示">
                全部
              </button>
              <span className="text-xs text-slate-600">条</span>
              <span className="text-slate-400">|</span>
              <button type="button" onClick={() => goPage(1)} disabled={!canPrev} className={pageButtonClass(canPrev, "muted")} title={detailAll ? "全部模式" : "第一页"}>
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => goPage(safePage - 1)} disabled={!canPrev} className={pageButtonClass(canPrev)} title={detailAll ? "全部模式" : "上一页"}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-10 text-center text-xs text-slate-500">{detailAll ? "全部" : `${safePage}/${totalPages}`}</span>
              <button type="button" onClick={() => goPage(safePage + 1)} disabled={!canNext} className={pageButtonClass(canNext)} title={detailAll ? "全部模式" : "下一页"}>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => goPage(totalPages)} disabled={!canNext} className={pageButtonClass(canNext, "muted")} title={detailAll ? "全部模式" : "最后一页"}>
                <ChevronsRight className="h-3.5 w-3.5" />
              </button>
              <span className="text-slate-400">|</span>
              <Link href="/batch-import" className="h-7 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导入账单记录">
                <Upload className="w-3 h-3" />导入
              </Link>
              <a href={normalExportHref} download={normalExportFilename} className="h-7 px-2 rounded border border-slate-200 bg-white text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导出当前资金明细 CSV">
                <Download className="w-3 h-3" />导出
              </a>
            </div>
          }
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
