"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { CalcInput } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import EditBillAmount from "@/components/EditBillAmount";
import { CreditBillMailImportButton } from "@/components/CreditBillMailImportButton";
import { formatMoney } from "@/lib/format";
import {
  buildCreditCardInstallmentSchedule,
  summarizeCreditCardInstallments,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { toStatementMonth } from "@/lib/date-utils";
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
  statementInstallmentPrincipal: number | null;
};

type CreditBillSummaryTableProps = {
  accountId: string;
  accountName: string;
  billingDay: number | null;
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

function statementMonthFromDateText(dateText: string, rows: CreditBillSummaryRow[]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return "";
  return rows.find((row) => row.periodStart <= dateText && dateText <= row.periodEnd)?.month ?? "";
}

function installmentAvailableAmount(row: CreditBillSummaryRow | null | undefined) {
  return row ? Math.max(0, row.effectiveBill - row.paid) : 0;
}

export function CreditBillSummaryTable({
  accountId,
  accountName,
  billingDay,
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
  const [installmentOpen, setInstallmentOpen] = useState(false);
  const [installmentForm, setInstallmentForm] = useState({
    amount: "",
    date: "",
    firstPaymentDate: "",
    totalRuns: "12",
    rateType: "period_fee" as CreditCardInstallmentRateType,
    rate: "0",
  });
  const [installmentSaving, setInstallmentSaving] = useState(false);
  const [installmentError, setInstallmentError] = useState("");
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

  const selectedBillRow = useMemo(
    () => localRows.find((row) => row.month === selectedBillMonth && !row.isCurrentCycle) ?? null,
    [localRows, selectedBillMonth],
  );
  const defaultInstallmentRow = useMemo(
    () => selectedBillRow
      ?? localRows.find((row) => !row.isCurrentCycle && row.effectiveBill - row.paid > 0)
      ?? localRows.find((row) => !row.isCurrentCycle)
      ?? localRows[0]
      ?? null,
    [localRows, selectedBillRow],
  );
  const installmentSourceMonth = useMemo(() => {
    return statementMonthFromDateText(installmentForm.date, localRows);
  }, [installmentForm.date, localRows]);
  const installmentSourceRow = useMemo(
    () => installmentSourceMonth ? localRows.find((row) => row.month === installmentSourceMonth) ?? null : null,
    [installmentSourceMonth, localRows],
  );
  const installmentAvailable = installmentAvailableAmount(installmentSourceRow);
  const installmentBlocked = Boolean(installmentSourceRow && (installmentSourceRow.isCurrentCycle || installmentSourceRow.statementInstallmentPrincipal != null));

  function openCycleEditor(row: CreditBillSummaryRow) {
    setEditingCycle(row);
    setCycleForm({
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      dueDate: row.dueDate || "",
    });
    setCycleError("");
  }

  function openStatementInstallment() {
    const seedRow = defaultInstallmentRow;
    setInstallmentForm({
      amount: seedRow ? installmentAvailableAmount(seedRow).toFixed(2) : "",
      date: seedRow?.periodEnd ?? "",
      firstPaymentDate: seedRow?.periodEnd ?? "",
      totalRuns: "12",
      rateType: "period_fee",
      rate: "0",
    });
    setInstallmentOpen(true);
    setInstallmentError("");
  }

  const installmentPreview = useMemo(() => {
    if (!installmentOpen || !billingDay || !installmentSourceMonth) return null;
    try {
      const firstDate = new Date(`${installmentForm.firstPaymentDate || installmentForm.date}T00:00:00.000Z`);
      if (Number.isNaN(firstDate.getTime())) return null;
      const rows = buildCreditCardInstallmentSchedule({
        principal: Number(installmentForm.amount),
        totalRuns: Number(installmentForm.totalRuns),
        rateType: installmentForm.rateType,
        rate: Number(installmentForm.rate),
        billingDay,
        firstDate,
      });
      return {
        rows,
        summary: summarizeCreditCardInstallments(rows),
      };
    } catch {
      return null;
    }
  }, [billingDay, installmentForm, installmentOpen, installmentSourceMonth]);

  async function saveStatementInstallment() {
    if (!installmentOpen || installmentSaving) return;
    setInstallmentSaving(true);
    setInstallmentError("");
    try {
      const res = await fetch("/api/v1/bill/installment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          amount: Number(installmentForm.amount),
          totalRuns: Number(installmentForm.totalRuns),
          rateType: installmentForm.rateType,
          rate: Number(installmentForm.rate),
          date: installmentForm.date,
          firstPaymentDate: installmentForm.firstPaymentDate || installmentForm.date,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error ?? "创建账单分期失败");
      setInstallmentOpen(false);
      dispatchFinanceDataChanged({
        reason: "statement-installment",
        accountIds: [accountId],
        statementMonth: installmentSourceMonth || undefined,
      });
      router.refresh();
    } catch (error) {
      setInstallmentError(error instanceof Error ? error.message : "创建账单分期失败");
    } finally {
      setInstallmentSaving(false);
    }
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
  const billColumns: AdvancedDataTableColumn<CreditBillSummaryRow>[] = [
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
      label: t("creditBill.outflow"),
      width: 104,
      minWidth: 88,
      align: "right",
      hideable: true,
      render: (row) => <span className="text-xs tabular-nums text-red-600">{formatMoney(row.expenseAbs)}</span>,
    },
    {
      key: "income",
      label: t("creditBill.inflow"),
      width: 104,
      minWidth: 88,
      align: "right",
      hideable: true,
      render: (row) => <span className="text-xs tabular-nums text-emerald-700">{formatMoney(row.income)}</span>,
    },
    {
      key: "netAmount",
      label: "本期金额",
      width: 112,
      minWidth: 96,
      align: "right",
      hideable: true,
      render: (row) => {
        const net = row.expenseAbs - row.income;
        const tone = net > 0 ? "text-red-600" : net < 0 ? "text-emerald-700" : "text-slate-500";
        return <span className={`text-xs tabular-nums ${tone}`}>{formatMoney(net)}</span>;
      },
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
            postOverrideAdjustment={0}
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
          return <span className="whitespace-nowrap rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">已还款</span>;
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
  ];

  return (
    <div className={["panel-surface overflow-hidden", fillHeight ? "flex h-full min-h-0 flex-col" : "", className ?? ""].filter(Boolean).join(" ")}>
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
          toolbarLeftContent={(
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-sm font-semibold text-slate-800">{t("creditBill.listTitle")}</span>
              <Link href={buildHref((q) => q.set("billMonth", "all"))} prefetch={false} scroll={false} className={`flex h-6 items-center rounded border px-1.5 text-xs ${selectedBillMonth ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50" : "border-blue-300 bg-blue-50 text-blue-700"}`}>
                {t("creditBill.all")}
              </Link>
              <span className="whitespace-nowrap text-xs text-slate-500">共 {localRows.length} 期</span>
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
          )}
          toolbarRightContent={(
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={openStatementInstallment}
                disabled={!billingDay || localRows.length === 0}
                className="flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                title={billingDay ? "按日期创建账单分期，系统会自动归属到账单月" : "当前信用卡缺少账单日，无法创建账单分期"}
              >
                <CalendarClock className="h-3.5 w-3.5" />
                账单分期
              </button>
              <CreditBillMailImportButton
                accountId={accountId}
                accountName={accountName}
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
                className={`flex h-7 items-center rounded-md border px-2 text-xs ${
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
                className={`flex h-7 items-center rounded-md border px-2 text-xs ${
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
                className={`flex h-7 items-center rounded-md border px-2 text-xs ${
                  hideSettledBills
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {t("creditBill.hideSettled")}
              </button>
            </div>
          )}
          onRowClick={(row) => selectBillMonth(row.month)}
          rowClassName={(row) => {
            const active = selectedBillMonth === row.month || activeStatementMonth === row.month;
            return `cursor-pointer hover:bg-blue-50/40 ${active ? "bg-blue-50" : ""}`;
          }}
          emptyText="暂无账单"
        />
      </div>
      {installmentOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/25 px-4">
          <div className="w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex items-start justify-between border-b border-slate-100 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">账单分期</div>
                <div className="mt-1 text-xs tabular-nums text-slate-500">
                  归属账单 {installmentSourceMonth || "-"}
                  {installmentSourceRow ? ` · 参考未还 ${formatMoney(installmentAvailable)}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setInstallmentOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                title="关闭"
                disabled={installmentSaving}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 px-4 py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_72px_minmax(92px,0.75fr)]">
                <label className="space-y-1">
                  <span className="form-label">分期金额</span>
                  <CalcInput
                    value={installmentForm.amount}
                    onChange={(value) => setInstallmentForm((prev) => ({ ...prev, amount: value }))}
                    placeholder="例如：1200"
                    label="分期金额"
                    precision={2}
                  />
                </label>
                <label className="space-y-1">
                  <span className="form-label">期数</span>
                  <input
                    type="number"
                    min={2}
                    max={120}
                    step={1}
                    value={installmentForm.totalRuns}
                    onChange={(event) => setInstallmentForm((prev) => ({ ...prev, totalRuns: event.target.value }))}
                    className="form-input tabular-nums"
                  />
                </label>
                <label className="space-y-1">
                  <span className="form-label">{installmentForm.rateType === "annual_interest" ? "年利率 (%)" : "每期费率 (%)"}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.0001"
                    value={installmentForm.rate}
                    onChange={(event) => setInstallmentForm((prev) => ({ ...prev, rate: event.target.value }))}
                    className="form-input tabular-nums"
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="form-label">分期日期</span>
                  <DateStepper
                    value={installmentForm.date}
                    onChange={(value) => {
                      setInstallmentForm((prev) => {
                        const next = { ...prev, date: value };
                        const prevMonth = statementMonthFromDateText(prev.date, localRows);
                        const nextMonth = statementMonthFromDateText(value, localRows);
                        const prevRow = prevMonth ? localRows.find((row) => row.month === prevMonth) : null;
                        const nextRow = nextMonth ? localRows.find((row) => row.month === nextMonth) : null;
                        const prevDefaultAmount = prevRow ? installmentAvailableAmount(prevRow).toFixed(2) : "";
                        if (!prev.amount || prev.amount === prevDefaultAmount) {
                          next.amount = nextRow ? installmentAvailableAmount(nextRow).toFixed(2) : prev.amount;
                        }
                        if (!prev.firstPaymentDate || prev.firstPaymentDate === prev.date) {
                          next.firstPaymentDate = value;
                        }
                        return next;
                      });
                    }}
                  />
                </label>
                <label className="space-y-1">
                  <span className="form-label">首期入账日期</span>
                  <DateStepper
                    value={installmentForm.firstPaymentDate}
                    onChange={(value) => setInstallmentForm((prev) => ({ ...prev, firstPaymentDate: value }))}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="inline-flex h-8 overflow-hidden rounded border border-slate-200 bg-white">
                  <button
                    type="button"
                    onClick={() => setInstallmentForm((prev) => ({ ...prev, rateType: "period_fee" }))}
                    className={`px-3 text-xs ${installmentForm.rateType === "period_fee" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                  >
                    每期手续费
                  </button>
                  <button
                    type="button"
                    onClick={() => setInstallmentForm((prev) => ({ ...prev, rateType: "annual_interest" }))}
                    className={`border-l border-slate-200 px-3 text-xs ${installmentForm.rateType === "annual_interest" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}
                  >
                    年利率
                  </button>
                </div>
                {installmentPreview ? (
                  <div className="text-xs tabular-nums text-slate-500">
                    首期本金 {formatMoney(installmentPreview.rows[0]?.principal ?? 0)}
                    {" · "}
                    首期{installmentForm.rateType === "annual_interest" ? "利息" : "手续费"} {formatMoney(installmentPreview.rows[0]?.interest ?? 0)}
                    {" · "}
                    首期合计 {formatMoney(installmentPreview.summary.firstPayment)}
                  </div>
                ) : null}
              </div>
              {installmentSourceRow && installmentSourceRow.isCurrentCycle ? (
                <div className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  当前日期归属到的账单还未出账，不能创建账单分期。
                </div>
              ) : null}
              {installmentPreview ? (
                <div className="max-h-56 overflow-auto rounded-md border border-slate-200">
                  <table className="min-w-full text-xs tabular-nums">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">期数</th>
                        <th className="px-2 py-1 text-left font-medium">日期</th>
                        <th className="px-2 py-1 text-right font-medium">本金</th>
                        <th className="px-2 py-1 text-right font-medium">{installmentForm.rateType === "annual_interest" ? "利息" : "手续费"}</th>
                        <th className="px-2 py-1 text-right font-medium">应还</th>
                      </tr>
                    </thead>
                    <tbody>
                      {installmentPreview.rows.map((row) => (
                        <tr key={row.installmentNo} className="border-t border-slate-100">
                          <td className="px-2 py-1 text-slate-600">{row.installmentNo}/{installmentForm.totalRuns}</td>
                          <td className="px-2 py-1 text-slate-600">{row.date.toISOString().slice(0, 10)}</td>
                          <td className="px-2 py-1 text-right text-slate-700">{formatMoney(row.principal)}</td>
                          <td className="px-2 py-1 text-right text-slate-700">{formatMoney(row.interest)}</td>
                          <td className="px-2 py-1 text-right font-medium text-slate-800">{formatMoney(row.payment)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {installmentError ? <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{installmentError}</div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button type="button" onClick={() => setInstallmentOpen(false)} className="secondary-button h-8 px-3 text-xs" disabled={installmentSaving}>
                取消
              </button>
              <button
                type="button"
                onClick={saveStatementInstallment}
                className="primary-button h-8 px-3 text-xs"
                disabled={installmentSaving || !installmentPreview || installmentBlocked}
              >
                {installmentSaving ? "保存中..." : "创建账单分期"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
                <DateStepper
                  value={cycleForm.periodStart}
                  onChange={(value) => setCycleForm((prev) => ({ ...prev, periodStart: value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("creditBill.periodEnd")}</span>
                <DateStepper
                  value={cycleForm.periodEnd}
                  onChange={(value) => setCycleForm((prev) => ({ ...prev, periodEnd: value }))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("creditBill.dueDate")}</span>
                <DateStepper
                  value={cycleForm.dueDate}
                  onChange={(value) => setCycleForm((prev) => ({ ...prev, dueDate: value }))}
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
