"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import EditBillAmount from "@/components/EditBillAmount";
import { formatMoney } from "@/lib/format";

export type CreditBillSummaryRow = {
  month: string;
  periodLabel: string;
  dueLabel: string;
  expenseAbs: number;
  income: number;
  effectiveBill: number;
  isCurrentCycle: boolean;
  hasOverride: boolean;
};

type CreditBillSummaryTableProps = {
  accountId: string;
  rows: CreditBillSummaryRow[];
  initialPage: number;
  pageSize: number;
  selectedBillMonth: string;
  activeStatementMonth: string;
  settledBillMonth: string;
  hideZeroBills: boolean;
  hideSettledBills: boolean;
  showRecentBillCycles: boolean;
};

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

function pageButtonClass(enabled: boolean, tone: "muted" | "normal" = "normal") {
  if (!enabled) {
    return "h-6 px-1 rounded border border-slate-100 bg-slate-50 text-slate-300 text-xs cursor-not-allowed inline-flex items-center justify-center";
  }
  const color = tone === "muted" ? "text-slate-500" : "text-slate-600";
  return `h-6 px-1 rounded border border-slate-200 bg-white ${color} text-xs hover:bg-slate-50 inline-flex items-center justify-center`;
}

export function CreditBillSummaryTable({
  accountId,
  rows,
  initialPage,
  pageSize,
  selectedBillMonth,
  activeStatementMonth,
  settledBillMonth,
  hideZeroBills,
  hideSettledBills,
  showRecentBillCycles,
}: CreditBillSummaryTableProps) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const [page, setPage] = useState(() => clampPage(initialPage, totalPages));
  const safePage = clampPage(page, totalPages);

  useEffect(() => {
    setPage(clampPage(initialPage, Math.max(1, Math.ceil(rows.length / pageSize))));
  }, [initialPage, pageSize, rows.length]);

  useEffect(() => {
    if (page === safePage) return;
    setPage(safePage);
  }, [page, safePage]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "bill");
    url.searchParams.set("billPage", String(safePage));
    window.history.replaceState(window.history.state, "", url);
  }, [safePage]);

  const pagedRows = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [pageSize, rows, safePage],
  );

  const buildHref = (mutate?: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams();
    q.set("view", "bill");
    if (accountId) q.set("accountId", accountId);
    if (selectedBillMonth) q.set("billMonth", selectedBillMonth);
    q.set("billPage", String(safePage));
    if (hideZeroBills) q.set("hideZeroBills", "1");
    if (hideSettledBills) q.set("hideSettledBills", "1");
    if (!showRecentBillCycles) q.set("billMonthsLimit", "all");
    mutate?.(q);
    return `/?${q.toString()}`;
  };

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;

  return (
    <div className="panel-surface overflow-hidden">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-800">账单列表</span>
          <Link href={buildHref()} prefetch={false} scroll={false} className="h-6 px-1.5 rounded border text-xs flex items-center border-blue-300 bg-blue-50 text-blue-700">
            全部
          </Link>
          {totalPages > 1 ? (
            <div className="flex items-center gap-0.5 ml-1">
              <button type="button" onClick={() => setPage(1)} disabled={!canPrev} className={pageButtonClass(canPrev, "muted")} title="第一页">
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setPage(safePage - 1)} disabled={!canPrev} className={pageButtonClass(canPrev)} title="上一页">
                <ChevronLeft className="h-3 w-3" />
              </button>
              <span className="text-xs text-slate-500 px-1">{safePage}/{totalPages}</span>
              <button type="button" onClick={() => setPage(safePage + 1)} disabled={!canNext} className={pageButtonClass(canNext)} title="下一页">
                <ChevronRight className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => setPage(totalPages)} disabled={!canNext} className={pageButtonClass(canNext, "muted")} title="最后一页">
                <ChevronsRight className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={buildHref((q) => {
              if (showRecentBillCycles) q.set("billMonthsLimit", "all");
              else q.delete("billMonthsLimit");
              q.set("billPage", "1");
            })}
            prefetch={false}
            scroll={false}
            className={`h-7 px-2 rounded-md border text-xs flex items-center ${
              showRecentBillCycles
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            title={showRecentBillCycles ? "当前只显示近10期；点击后显示全部并重新计算" : "当前显示全部账单；点击后恢复近10期"}
          >
            {showRecentBillCycles ? "近10期" : "全部账单"}
          </Link>
          <Link
            href={buildHref((q) => {
              if (hideZeroBills) q.delete("hideZeroBills");
              else q.set("hideZeroBills", "1");
              q.set("billPage", "1");
            })}
            prefetch={false}
            scroll={false}
            className={`h-7 px-2 rounded-md border text-xs flex items-center ${
              hideZeroBills
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            隐藏 0 收支
          </Link>
          <Link
            href={buildHref((q) => {
              if (hideSettledBills) q.delete("hideSettledBills");
              else q.set("hideSettledBills", "1");
              q.set("billPage", "1");
            })}
            prefetch={false}
            scroll={false}
            className={`h-7 px-2 rounded-md border text-xs flex items-center ${
              hideSettledBills
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            隐藏已还
          </Link>
        </div>
      </div>
      <div className="overflow-auto">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="bg-white">
              <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">账单</th>
              <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">周期</th>
              <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">支出</th>
              <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">退/收入</th>
              <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">账单金额</th>
              <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">还款</th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {pagedRows.map((row) => {
              const href = buildHref((q) => {
                q.set("billMonth", row.month);
                q.set("billPage", String(safePage));
              });
              const active = selectedBillMonth === row.month || activeStatementMonth === row.month;
              return (
                <tr key={row.month} className={`hover:bg-blue-50/40 ${active ? "bg-blue-50" : ""}`}>
                  <td className="px-4 py-2 border-b border-slate-100">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className={`text-xs font-semibold whitespace-nowrap ${row.isCurrentCycle ? "text-amber-600" : "text-blue-700"}`}>
                        {row.month}{row.isCurrentCycle ? "（未出账单）" : row.month === settledBillMonth ? "（本期账单）" : ""}
                      </span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 border-b border-slate-100">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs text-slate-700 tabular-nums whitespace-nowrap">{row.periodLabel}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs text-red-600">{formatMoney(row.expenseAbs)}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs text-emerald-700">{formatMoney(row.income)}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2 border-b border-slate-100 text-right tabular-nums">
                    <EditBillAmount accountId={accountId} statementMonth={row.month} currentAmount={row.effectiveBill} hasOverride={row.hasOverride} displayMultiplier={-1} />
                  </td>
                  <td className="px-3 py-2 border-b border-slate-100">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs text-slate-700 tabular-nums">{row.dueLabel}</span>
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
