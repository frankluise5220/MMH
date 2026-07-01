"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import EditBillAmount from "@/components/EditBillAmount";
import { formatMoney } from "@/lib/format";
import {
  setCreditBillHideSettledPreference,
  setCreditBillHideZeroPreference,
  setCreditBillShowRecentCyclesPreference,
} from "@/lib/client/appPreferences";

export type CreditBillSummaryRow = {
  month: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
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
  const router = useRouter();
  const [localRows, setLocalRows] = useState(rows);
  const [editingCycle, setEditingCycle] = useState<CreditBillSummaryRow | null>(null);
  const [cycleForm, setCycleForm] = useState({ periodStart: "", periodEnd: "", dueDate: "" });
  const [cycleSaving, setCycleSaving] = useState(false);
  const [cycleError, setCycleError] = useState("");
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const [page, setPage] = useState(() => clampPage(initialPage, totalPages));
  const safePage = clampPage(page, totalPages);

  useEffect(() => {
    setLocalRows(rows);
  }, [rows]);

  useEffect(() => {
    function handleBillOverrideChanged(event: Event) {
      const detail = (event as CustomEvent<{
        accountId?: string;
        statementMonth?: string;
        amount?: number;
        hasOverride?: boolean;
      }>).detail;
      if (!detail?.accountId || detail.accountId !== accountId || !detail.statementMonth) return;
      if (typeof detail.amount !== "number") return;
      const nextAmount = detail.amount;
      setLocalRows((prev) =>
        prev.map((row) =>
          row.month === detail.statementMonth
            ? {
                ...row,
                effectiveBill: nextAmount,
                hasOverride: detail.hasOverride ?? row.hasOverride,
              }
            : row,
        ),
      );
    }

    window.addEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
    return () => window.removeEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
  }, [accountId]);

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
    () => localRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [localRows, pageSize, safePage],
  );

  function openCycleEditor(row: CreditBillSummaryRow) {
    setEditingCycle(row);
    setCycleForm({
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      dueDate: row.dueDate || "",
    });
    setCycleError("");
  }

  async function saveCycle() {
    if (!editingCycle || cycleSaving) return;
    setCycleSaving(true);
    setCycleError("");
    try {
      const res = await fetch("/api/v1/bill/cycle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          statementMonth: editingCycle.month,
          periodStart: cycleForm.periodStart,
          periodEnd: cycleForm.periodEnd,
          dueDate: cycleForm.dueDate || null,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error ?? "更新账单周期失败");
      setEditingCycle(null);
      router.refresh();
    } catch (error) {
      setCycleError(error instanceof Error ? error.message : "更新账单周期失败");
    } finally {
      setCycleSaving(false);
    }
  }

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

  function navigateWithQuery(mutator: (q: URLSearchParams) => void) {
    const href = buildHref((q) => {
      mutator(q);
      q.set("billPage", "1");
    });
    router.replace(href, { scroll: false });
  }

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
            <div className="ml-1 flex items-center gap-0.5">
              <button type="button" onClick={() => setPage(1)} disabled={!canPrev} className={pageButtonClass(canPrev, "muted")} title="第一页">
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setPage(safePage - 1)} disabled={!canPrev} className={pageButtonClass(canPrev)} title="上一页">
                <ChevronLeft className="h-3 w-3" />
              </button>
              <span className="px-1 text-xs text-slate-500">{safePage}/{totalPages}</span>
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
          <button
            type="button"
            onClick={() => {
              const next = !showRecentBillCycles;
              setCreditBillShowRecentCyclesPreference(next);
              navigateWithQuery((q) => {
                if (next) q.delete("billMonthsLimit");
                else q.set("billMonthsLimit", "all");
              });
            }}
            className={`h-7 px-2 rounded-md border text-xs flex items-center ${
              showRecentBillCycles
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
            title={showRecentBillCycles ? "当前只显示近10期，点击后显示全部账单" : "当前显示全部账单，点击后恢复近10期"}
          >
            {showRecentBillCycles ? "近10期" : "全部账单"}
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !hideZeroBills;
              setCreditBillHideZeroPreference(next);
              navigateWithQuery((q) => {
                if (next) q.set("hideZeroBills", "1");
                else q.delete("hideZeroBills");
              });
            }}
            className={`h-7 px-2 rounded-md border text-xs flex items-center ${
              hideZeroBills
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            隐藏 0 收支
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !hideSettledBills;
              setCreditBillHideSettledPreference(next);
              navigateWithQuery((q) => {
                if (next) q.set("hideSettledBills", "1");
                else q.delete("hideSettledBills");
              });
            }}
            className={`h-7 px-2 rounded-md border text-xs flex items-center ${
              hideSettledBills
                ? "border-blue-300 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            隐藏已还
          </button>
        </div>
      </div>
      <div className="overflow-auto">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="bg-white">
              <th className="border-b border-slate-200 px-4 py-2 text-left text-xs font-semibold text-slate-600">账单</th>
              <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">周期</th>
              <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">支出</th>
              <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">退回/收入</th>
              <th className="border-b border-slate-200 px-3 py-2 text-right text-xs font-semibold text-slate-600">账单金额</th>
              <th className="border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-600">还款</th>
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
                  <td className="border-b border-slate-100 px-4 py-2">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className={`whitespace-nowrap text-xs font-semibold ${row.isCurrentCycle ? "text-amber-600" : "text-blue-700"}`}>
                        {row.month}{row.isCurrentCycle ? "（未出账单）" : row.month === settledBillMonth ? "（本期账单）" : ""}
                      </span>
                    </Link>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          openCycleEditor(row);
                        }}
                        className="inline-flex cursor-text whitespace-nowrap rounded px-1 text-xs tabular-nums text-slate-700 hover:bg-amber-50 hover:text-amber-700"
                        title="双击修改这一期账单周期，并从这一期开始调整后续周期"
                      >
                        {row.periodLabel}
                      </span>
                    </Link>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs text-red-600">{formatMoney(row.expenseAbs)}</span>
                    </Link>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs text-emerald-700">{formatMoney(row.income)}</span>
                    </Link>
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2 text-right tabular-nums">
                    <EditBillAmount
                      accountId={accountId}
                      statementMonth={row.month}
                      currentAmount={row.effectiveBill}
                      hasOverride={row.hasOverride}
                      displayMultiplier={-1}
                    />
                  </td>
                  <td className="border-b border-slate-100 px-3 py-2">
                    <Link href={href} prefetch={false} scroll={false} className="block">
                      <span className="text-xs tabular-nums text-slate-700">{row.dueLabel}</span>
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editingCycle ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/20 px-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">修改 {editingCycle.month} 账单周期</div>
              <div className="mt-1 text-xs text-slate-500">保存后会从这一期开始调整后续周期，并同步账户管理里的账单日/还款日。</div>
            </div>
            <div className="space-y-3 px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">周期开始</span>
                <input
                  type="date"
                  value={cycleForm.periodStart}
                  onChange={(event) => setCycleForm((prev) => ({ ...prev, periodStart: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">周期结束 / 新账单日</span>
                <input
                  type="date"
                  value={cycleForm.periodEnd}
                  onChange={(event) => setCycleForm((prev) => ({ ...prev, periodEnd: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">还款日</span>
                <input
                  type="date"
                  value={cycleForm.dueDate}
                  onChange={(event) => setCycleForm((prev) => ({ ...prev, dueDate: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              {cycleError ? <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{cycleError}</div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button type="button" onClick={() => setEditingCycle(null)} className="secondary-button h-8 px-3 text-xs" disabled={cycleSaving}>
                取消
              </button>
              <button type="button" onClick={saveCycle} className="primary-button h-8 px-3 text-xs" disabled={cycleSaving}>
                {cycleSaving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
