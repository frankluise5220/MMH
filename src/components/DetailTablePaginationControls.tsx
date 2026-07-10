"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

type DetailTablePaginationControlsProps = {
  pageSize: number;
  pageSizeOptions?: readonly number[];
  detailAll: boolean;
  safePage: number;
  totalPages: number;
  canPrev: boolean;
  canNext: boolean;
  onPageSizeChange: (pageSize: number) => void;
  onShowAll: () => void;
  onPageChange: (page: number) => void;
};

function pageButtonClass(enabled: boolean, tone: "muted" | "normal" = "normal") {
  if (!enabled) {
    return "inline-flex h-7 w-7 cursor-not-allowed items-center justify-center rounded border border-slate-100 bg-slate-50 text-slate-300";
  }
  const color = tone === "muted" ? "text-slate-400" : "text-slate-500";
  return `inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white ${color} hover:bg-slate-50`;
}

export function DetailTablePaginationControls({
  pageSize,
  pageSizeOptions = [10, 20, 40],
  detailAll,
  safePage,
  totalPages,
  canPrev,
  canNext,
  onPageSizeChange,
  onShowAll,
  onPageChange,
}: DetailTablePaginationControlsProps) {
  return (
    <div className="flex items-center gap-1.5 text-xs tabular-nums">
      <span className="text-slate-500">每页</span>
      {pageSizeOptions.map((n) => {
        const active = !detailAll && pageSize === n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onPageSizeChange(n)}
            className={`inline-flex h-7 items-center justify-center rounded border px-2 ${
              active
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {n}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onShowAll}
        className={`inline-flex h-7 items-center justify-center rounded border px-2 ${
          detailAll
            ? "border-blue-300 bg-blue-50 text-blue-700"
            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        }`}
        title="当前账户全部记录不分页显示"
      >
        全部
      </button>
      <span className="text-slate-500">条</span>
      <span className="mx-0.5 text-slate-300">|</span>
      <button type="button" onClick={() => onPageChange(1)} disabled={!canPrev} className={pageButtonClass(canPrev, "muted")} title={detailAll ? "全部模式" : "第一页"}>
        <ChevronsLeft className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={!canPrev} className={pageButtonClass(canPrev)} title={detailAll ? "全部模式" : "上一页"}>
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-10 text-center text-xs text-slate-500">{detailAll ? "全部" : `${safePage}/${totalPages}`}</span>
      <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={!canNext} className={pageButtonClass(canNext)} title={detailAll ? "全部模式" : "下一页"}>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => onPageChange(totalPages)} disabled={!canNext} className={pageButtonClass(canNext, "muted")} title={detailAll ? "全部模式" : "最后一页"}>
        <ChevronsRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
