"use client";

import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";

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
  /** Optional: jump to the page containing the given date (YYYY-MM-DD). */
  onLocateDate?: (dateYmd: string) => void;
  locateDateBusy?: boolean;
  /** Auto-fit mode: page size follows the viewport height. */
  autoFit?: boolean;
  onAutoFit?: () => void;
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
  onLocateDate,
  locateDateBusy = false,
  autoFit = false,
  onAutoFit,
}: DetailTablePaginationControlsProps) {
  const { t } = useI18n();
  const [pageInput, setPageInput] = useState(() => String(safePage));
  const [locateDate, setLocateDate] = useState("");

  useEffect(() => {
    setPageInput(String(safePage));
  }, [safePage]);

  const commitPageInput = () => {
    const parsed = parseInt(pageInput.trim(), 10);
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), totalPages) : safePage;
    setPageInput(String(safePage));
    if (!detailAll && clamped !== safePage) onPageChange(clamped);
  };

  const handleLocateDateChange = (nextValue: string) => {
    setLocateDate(nextValue);
    if (nextValue && !detailAll) onLocateDate?.(nextValue);
  };

  return (
    <div className="flex items-center gap-1.5 text-xs tabular-nums">
      <span className="text-slate-500">{t("pagination.perPage")}</span>
      <select
        value={detailAll ? "all" : autoFit ? "auto" : String(pageSize)}
        onChange={(event) => {
          const { value } = event.target;
          if (value === "all") {
            onShowAll();
            return;
          }
          if (value === "auto") {
            onAutoFit?.();
            return;
          }
          const nextSize = parseInt(value, 10);
          if (Number.isFinite(nextSize) && nextSize > 0) onPageSizeChange(nextSize);
        }}
        title={t("pagination.perPage")}
        aria-label={t("pagination.perPage")}
        className="h-7 rounded border border-slate-200 bg-white px-1 text-slate-700 hover:bg-slate-50"
      >
        {onAutoFit ? <option value="auto">{t("pagination.autoFit")}</option> : null}
        <option value="all">{t("common.all")}</option>
        {!detailAll && !autoFit && !pageSizeOptions.includes(pageSize) ? <option value={String(pageSize)}>{pageSize}</option> : null}
        {pageSizeOptions.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {!detailAll ? <span className="text-slate-500">{t("pagination.items")}</span> : null}
      <span className="mx-0.5 text-slate-300">|</span>
      <button type="button" onClick={() => onPageChange(1)} disabled={!canPrev} className={pageButtonClass(canPrev, "muted")} title={detailAll ? t("pagination.allMode") : t("creditBill.firstPage")}>
        <ChevronsLeft className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={!canPrev} className={pageButtonClass(canPrev)} title={detailAll ? t("pagination.allMode") : t("creditBill.prevPage")}>
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      {!detailAll ? (
        <>
          <input
            type="text"
            inputMode="numeric"
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value.replace(/\D/g, "").slice(0, 6))}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              }
            }}
            title={t("pagination.pageInputTitle")}
            aria-label={t("pagination.pageInputTitle")}
            className="h-7 w-11 rounded border border-slate-200 bg-white text-center text-xs text-slate-700 outline-none focus:border-blue-300 disabled:cursor-not-allowed disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-300"
          />
          <span className="text-slate-400">/ {totalPages}</span>
        </>
      ) : null}
      <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={!canNext} className={pageButtonClass(canNext)} title={detailAll ? t("pagination.allMode") : t("creditBill.nextPage")}>
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={() => onPageChange(totalPages)} disabled={!canNext} className={pageButtonClass(canNext, "muted")} title={detailAll ? t("pagination.allMode") : t("creditBill.lastPage")}>
        <ChevronsRight className="h-3.5 w-3.5" />
      </button>
      {onLocateDate ? (
        <>
          <span className="mx-0.5 text-slate-300">|</span>
          <label
            className={`inline-flex h-7 items-center gap-1 rounded border px-1.5 focus-within:border-blue-300 ${
              detailAll || locateDateBusy
                ? "cursor-not-allowed border-slate-100 bg-slate-50"
                : "border-slate-200 bg-white"
            }`}
            title={t("pagination.locateDateTitle")}
          >
            <CalendarDays className={`h-3.5 w-3.5 ${detailAll || locateDateBusy ? "text-slate-300" : "text-slate-400"}`} />
            <input
              type="date"
              value={locateDate}
              disabled={detailAll || locateDateBusy}
              onChange={(event) => handleLocateDateChange(event.target.value)}
              aria-label={t("pagination.locateDateTitle")}
              className="w-[6.5rem] bg-transparent text-xs text-slate-700 outline-none disabled:cursor-not-allowed disabled:text-slate-300"
            />
          </label>
        </>
      ) : null}
    </div>
  );
}
