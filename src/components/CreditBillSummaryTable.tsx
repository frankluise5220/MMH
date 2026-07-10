"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import EditBillAmount from "@/components/EditBillAmount";
import { CreditBillMailImportButton } from "@/components/CreditBillMailImportButton";
import { formatMoney } from "@/lib/format";
import {
  setCreditBillHideSettledPreference,
  setCreditBillHideZeroPreference,
  setCreditBillShowRecentCyclesPreference,
} from "@/lib/client/appPreferences";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export type CreditBillSummaryRow = {
  month: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  periodLabel: string;
  dueLabel: string;
  expenseAbs: number;
  income: number;
  paid: number;
  effectiveBill: number;
  isCurrentCycle: boolean;
  hasOverride: boolean;
};

type CreditBillSummaryTableProps = {
  accountId: string;
  accountName: string;
  institutionName?: string | null;
  institutionShortName?: string | null;
  accountNumberMasked?: string | null;
  rows: CreditBillSummaryRow[];
  initialPage: number;
  pageSize: number;
  selectedBillMonth: string;
  activeStatementMonth: string;
  settledBillMonth: string;
  hideZeroBills: boolean;
  hideSettledBills: boolean;
  showRecentBillCycles: boolean;
  className?: string;
  fillHeight?: boolean;
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
  accountName,
  institutionName,
  institutionShortName,
  accountNumberMasked,
  rows,
  initialPage,
  pageSize,
  selectedBillMonth,
  activeStatementMonth,
  settledBillMonth,
  hideZeroBills,
  hideSettledBills,
  showRecentBillCycles,
  className,
  fillHeight = false,
}: CreditBillSummaryTableProps) {
  const router = useRouter();
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
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
      setTimeout(() => router.refresh(), 120);
    }

    window.addEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
    return () => window.removeEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
  }, [accountId, router]);

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
      if (!data?.ok) throw new Error(data?.error ?? t("creditBill.updateCycleFailed"));
      setEditingCycle(null);
      dispatchFinanceDataChanged({ reason: "bill-cycle", accountIds: [accountId], statementMonth: editingCycle.month });
      setTimeout(() => router.refresh(), 120);
    } catch (error) {
      setCycleError(error instanceof Error ? error.message : t("creditBill.updateCycleFailed"));
    } finally {
      setCycleSaving(false);
    }
  }

  const buildHref = (mutate?: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams();
    q.set("view", "bill");
    if (accountId) q.set("accountId", accountId);
    q.set("billMonth", selectedBillMonth || "all");
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

  function selectBillMonth(month: string) {
    const href = buildHref((q) => {
      if (selectedBillMonth === month) q.set("billMonth", "all");
      else q.set("billMonth", month);
      q.set("billPage", String(safePage));
    });
    router.replace(href, { scroll: false });
  }

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;
  const billColumns = useMemo<AdvancedDataTableColumn<CreditBillSummaryRow>[]>(() => [
    {
      key: "month",
      label: t("creditBill.bill"),
      width: 118,
      minWidth: 104,
      hideable: false,
      render: (row) => {
        const href = buildHref((q) => {
          if (selectedBillMonth === row.month) q.set("billMonth", "all");
          else q.set("billMonth", row.month);
          q.set("billPage", String(safePage));
        });
        return (
          <Link href={href} prefetch={false} scroll={false} className="block">
            <span className={`whitespace-nowrap text-xs font-semibold ${row.isCurrentCycle ? "text-amber-600" : "text-blue-700"}`}>
              {row.month}{row.isCurrentCycle ? `（${t("creditBill.currentCycle")}）` : row.month === settledBillMonth ? `（${t("creditBill.currentBill")}）` : ""}
            </span>
          </Link>
        );
      },
    },
    {
      key: "period",
      label: t("creditBill.period"),
      width: 150,
      minWidth: 128,
      hideable: true,
      render: (row) => {
        const href = buildHref((q) => {
          if (selectedBillMonth === row.month) q.set("billMonth", "all");
          else q.set("billMonth", row.month);
          q.set("billPage", String(safePage));
        });
        return (
          <Link href={href} prefetch={false} scroll={false} className="block">
            <span
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openCycleEditor(row);
              }}
              className="inline-flex cursor-text whitespace-nowrap rounded px-1 text-xs tabular-nums text-slate-700 hover:bg-amber-50 hover:text-amber-700"
              title={t("creditBill.editCycleHint")}
            >
              {row.periodLabel}
            </span>
          </Link>
        );
      },
    },
    {
      key: "expense",
      label: t("creditBill.expense"),
      width: 104,
      minWidth: 88,
      align: "right",
      hideable: true,
      render: (row) => <span className="text-xs tabular-nums text-red-600">{formatMoney(row.expenseAbs)}</span>,
    },
    {
      key: "income",
      label: "收入",
      width: 104,
      minWidth: 88,
      align: "right",
      hideable: true,
      render: (row) => <span className="text-xs tabular-nums text-emerald-700">{formatMoney(row.income)}</span>,
    },
    {
      key: "billAmount",
      label: t("creditBill.billAmount"),
      width: 122,
      minWidth: 96,
      align: "right",
      hideable: true,
      render: (row) => row.isCurrentCycle ? (
        <span className="text-xs tabular-nums text-slate-400">-</span>
      ) : (
        <span onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <EditBillAmount
            accountId={accountId}
            statementMonth={row.month}
            currentAmount={row.effectiveBill}
            hasOverride={row.hasOverride}
            displayMultiplier={-1}
          />
        </span>
      ),
    },
    {
      key: "dueDate",
      label: "还款日",
      width: 112,
      minWidth: 96,
      hideable: true,
      render: (row) => <span className="whitespace-nowrap text-xs tabular-nums text-slate-700">{row.dueLabel}</span>,
    },
    {
      key: "status",
      label: "状态",
      width: 92,
      minWidth: 76,
      hideable: true,
      render: (row) => {
        const settled = !row.isCurrentCycle && row.effectiveBill > 0 && row.paid >= row.effectiveBill;
        if (settled) {
          return <span className="whitespace-nowrap rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">已回款</span>;
        }
        if (row.isCurrentCycle) {
          return <span className="whitespace-nowrap text-xs text-amber-600">{t("creditBill.currentCycle")}</span>;
        }
        if (row.effectiveBill < 0) {
          return <span className="whitespace-nowrap rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">溢缴</span>;
        }
        if (row.effectiveBill > 0) {
          return <span className="whitespace-nowrap text-xs text-slate-500">待还款</span>;
        }
        return <span className="text-xs text-slate-300">-</span>;
      },
    },
  ], [accountId, hideSettledBills, hideZeroBills, safePage, selectedBillMonth, settledBillMonth, showRecentBillCycles, t]);

  return (
    <div className={["panel-surface overflow-hidden", fillHeight ? "flex h-full min-h-0 flex-col" : "", className ?? ""].filter(Boolean).join(" ")}>
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-800">{t("creditBill.listTitle")}</span>
          <Link href={buildHref((q) => q.set("billMonth", "all"))} prefetch={false} scroll={false} className={`h-6 px-1.5 rounded border text-xs flex items-center ${selectedBillMonth ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50" : "border-blue-300 bg-blue-50 text-blue-700"}`}>
            {t("creditBill.all")}
          </Link>
          {totalPages > 1 ? (
            <div className="ml-1 flex items-center gap-0.5">
              <button type="button" onClick={() => setPage(1)} disabled={!canPrev} className={pageButtonClass(canPrev, "muted")} title={t("creditBill.firstPage")}>
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setPage(safePage - 1)} disabled={!canPrev} className={pageButtonClass(canPrev)} title={t("creditBill.prevPage")}>
                <ChevronLeft className="h-3 w-3" />
              </button>
              <span className="px-1 text-xs text-slate-500">{safePage}/{totalPages}</span>
              <button type="button" onClick={() => setPage(safePage + 1)} disabled={!canNext} className={pageButtonClass(canNext)} title={t("creditBill.nextPage")}>
                <ChevronRight className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => setPage(totalPages)} disabled={!canNext} className={pageButtonClass(canNext, "muted")} title={t("creditBill.lastPage")}>
                <ChevronsRight className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <CreditBillMailImportButton
            accountName={accountName}
            institutionName={institutionName}
            institutionShortName={institutionShortName}
            accountNumberMasked={accountNumberMasked}
          />
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
            title={showRecentBillCycles ? t("creditBill.recentTitle") : t("creditBill.allBillsTitle")}
          >
            {showRecentBillCycles ? t("creditBill.recent10") : t("creditBill.allBills")}
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
            {t("creditBill.hideZero")}
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
            {t("creditBill.hideSettled")}
          </button>
        </div>
      </div>
      <div className={fillHeight ? "min-h-0 flex-1" : "min-h-0"}>
        <AdvancedDataTable
          storageKey="mmh_credit_bill_summary_table_v1"
          columns={billColumns}
          rows={pagedRows}
          rowKey={(row) => row.month}
          compactRows
          showFilters={false}
          fillHeight={fillHeight}
          minTableWidth={760}
          toolbarMode="custom"
          toolbarLeftContent={<span>共 {localRows.length} 期</span>}
          onRowClick={(row) => selectBillMonth(row.month)}
          rowClassName={(row) => {
            const active = selectedBillMonth === row.month || activeStatementMonth === row.month;
            return `cursor-pointer hover:bg-blue-50/40 ${active ? "bg-blue-50" : ""}`;
          }}
          emptyText="暂无账单"
        />
      </div>
      {editingCycle ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/20 px-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{tf("creditBill.editCycleTitle", { month: editingCycle.month })}</div>
              <div className="mt-1 text-xs text-slate-500">{t("creditBill.editCycleDesc")}</div>
            </div>
            <div className="space-y-3 px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("creditBill.periodStart")}</span>
                <input
                  type="date"
                  value={cycleForm.periodStart}
                  onChange={(event) => setCycleForm((prev) => ({ ...prev, periodStart: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("creditBill.periodEnd")}</span>
                <input
                  type="date"
                  value={cycleForm.periodEnd}
                  onChange={(event) => setCycleForm((prev) => ({ ...prev, periodEnd: event.target.value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("creditBill.dueDate")}</span>
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
                {t("common.cancel")}
              </button>
              <button type="button" onClick={saveCycle} className="primary-button h-8 px-3 text-xs" disabled={cycleSaving}>
                {cycleSaving ? t("creditBill.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
