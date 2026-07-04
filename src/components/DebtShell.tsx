"use client";

import { ArrowDownLeft, ArrowUpRight, HandCoins, Percent, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "./AdvancedDataTable";
import { DateStepper } from "./DateStepper";
import { EntryRowActions } from "./EntryRowActions";
import { formatMoney } from "@/lib/format";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageLprSpreadFromDiscount,
  MORTGAGE_BASE_BENCHMARK_RATE,
  MORTGAGE_LPR_CONVERSION_BASE_RATE,
} from "@/lib/loan-lpr";

type DebtRow = {
  key: string;
  name: string;
  accountId: string;
  institutionId: string;
  counterpartyId: string;
  itemType: string;
  repaymentMethod: string;
  repaymentCycle: string;
  annualRate: number | null;
  mortgageLprDiscount: number | null;
  remainingRuns: number | null;
  paidPrincipal: number;
  paidInterest: number;
  remainingPrincipal: number;
  remainingInterest: number;
  nextRepaymentDate: string;
  nextRepaymentPrincipal: number | null;
  nextRepaymentInterest: number | null;
  nextRepaymentCashAccountId: string;
  loanRateAdjustments: Array<{ effectiveDate: string; annualRate: number }>;
  payable: number;
  receivable: number;
  net: number;
  accountCount: number;
};

type DebtEntry = {
  id: string;
  date: string;
  typeLabel: string;
  relatedAccountLabel: string;
  note: string;
  amount: number;
  principal: number;
  interest: number;
  paymentTotal: number | null;
  balance: number;
  debtEdit?: {
    editEntryId: string;
    mode: "repay_out" | "prepay_out";
    defaultDebtAccountId: string;
    defaultCashAccountId: string;
    defaultDate: string;
    defaultPrincipal: number;
    defaultInterest: number;
  };
  edit?: {
    type: "expense" | "income" | "transfer" | "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    categoryId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  };
};

type RepaymentScheduleRow = {
  rowType: "payment" | "rate_adjustment";
  status?: "paid" | "planned";
  eventType?: "repayment" | "prepayment" | "rate_adjustment";
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  remainingPrincipal: number;
  annualRate: number | null;
};

type RateAdjustmentDraft = {
  id: string;
  effectiveDate: string;
  annualRate: string;
};

type RecalculateStrategy = "reduce_payment" | "reduce_term";

function amountClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function formatRate(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

const SETTLED_DEBT_EPSILON = 0.005;

function isSettledDebtRow(row: DebtRow) {
  return Math.abs(row.net) < SETTLED_DEBT_EPSILON && row.payable + row.receivable < SETTLED_DEBT_EPSILON;
}

function moneyInputValue(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return undefined;
  return value.toFixed(2);
}

function makeDraftId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function stopRowClick(event: React.MouseEvent) {
  event.stopPropagation();
}

export function DebtShell({
  rows,
  selectedKey,
  entries,
  repaymentScheduleRows,
  totalPayable,
  totalReceivable,
}: {
  rows: DebtRow[];
  selectedKey: string;
  entries: DebtEntry[];
  repaymentScheduleRows: RepaymentScheduleRow[];
  totalPayable: number;
  totalReceivable: number;
}) {
  const router = useRouter();
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [detailTab, setDetailTab] = useState<"entries" | "schedule">("entries");
  const [showPaidScheduleRows, setShowPaidScheduleRows] = useState(false);
  const [rateCardOpen, setRateCardOpen] = useState(false);
  const [rateSaving, setRateSaving] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<RateAdjustmentDraft[]>([]);
  const [lprDiscount, setLprDiscount] = useState("");
  const [recalcOpen, setRecalcOpen] = useState(false);
  const [recalcStrategy, setRecalcStrategy] = useState<RecalculateStrategy>("reduce_payment");
  const [recalcStartDate, setRecalcStartDate] = useState("");
  const [recalcSaving, setRecalcSaving] = useState(false);
  const [showSettledRows, setShowSettledRows] = useState(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    return selected ? isSettledDebtRow(selected) : false;
  });
  const rowClickTimerRef = useRef<number | null>(null);
  const visibleRows = useMemo(
    () => showSettledRows ? rows : rows.filter((row) => !isSettledDebtRow(row)),
    [rows, showSettledRows],
  );
  const selectedRow =
    visibleRows.find((row) => row.key === selectedKey) ??
    rows.find((row) => row.key === selectedKey) ??
    null;
  const net = totalReceivable - totalPayable;
  const settledCount = rows.filter(isSettledDebtRow).length;
  const canRepaySelectedRow = !!selectedRow && selectedRow.net < -SETTLED_DEBT_EPSILON;
  const canAdjustRateSelectedRow = canRepaySelectedRow && !!selectedRow?.accountId;
  const canRecalculateSelectedRow = canRepaySelectedRow && !!selectedRow?.accountId && !!selectedRow?.remainingRuns;
  const visibleRepaymentScheduleRows = useMemo(
    () => showPaidScheduleRows ? repaymentScheduleRows : repaymentScheduleRows.filter((row) => row.status !== "paid"),
    [repaymentScheduleRows, showPaidScheduleRows],
  );
  const debtRowSummary = useMemo(() => ({
    paidPrincipal: visibleRows.reduce((sum, row) => sum + Math.abs(row.paidPrincipal), 0),
    paidInterest: visibleRows.reduce((sum, row) => sum + Math.abs(row.paidInterest), 0),
    remainingInterest: visibleRows.reduce((sum, row) => sum + Math.abs(row.remainingInterest), 0),
    net: visibleRows.reduce((sum, row) => sum + Math.abs(row.net), 0),
  }), [visibleRows]);
  useEffect(() => {
    return () => {
      if (rowClickTimerRef.current) {
        window.clearTimeout(rowClickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    if (selected && isSettledDebtRow(selected)) {
      setShowSettledRows(true);
    }
  }, [rows, selectedKey]);

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${selectedEntryIds.size} 条往来明细吗？`)) return;
    const response = await fetch("/api/v1/entries/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: Array.from(selectedEntryIds) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      window.alert(data?.error || "批量删除失败");
      return;
    }
    setSelectedEntryIds(new Set());
    window.dispatchEvent(new Event("mmh:fund:refresh"));
  }

  function openRepayment(row: DebtRow) {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
      rowClickTimerRef.current = null;
    }
    if (!row.accountId || row.net >= 0) return;
    window.dispatchEvent(new CustomEvent("mmh:debt:create", {
      detail: {
        mode: "repay_out",
        defaultDebtAccountId: row.accountId,
        defaultDebtInstitutionId: row.institutionId,
        defaultCashAccountId: row.nextRepaymentCashAccountId,
        defaultDate: row.nextRepaymentDate,
        defaultPrincipal: moneyInputValue(row.nextRepaymentPrincipal ?? Math.abs(row.net)),
        defaultInterest: moneyInputValue(row.nextRepaymentInterest),
        defaultCurrentAnnualRate: row.annualRate,
        defaultMortgageLprDiscount: row.mortgageLprDiscount,
        defaultLoanRateAdjustments: row.loanRateAdjustments,
      },
    }));
  }

  function openDebtRow(row: DebtRow) {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
    }
    rowClickTimerRef.current = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("view", "debt");
      params.set("debtPerson", row.key);
      router.push(`/?${params.toString()}`, { scroll: false });
      rowClickTimerRef.current = null;
    }, 360);
  }

  function openRateAdjustment(row: DebtRow) {
    if (!row.accountId) return;
    const drafts = row.loanRateAdjustments.length > 0
      ? row.loanRateAdjustments.map((item) => ({
          id: makeDraftId(),
          effectiveDate: item.effectiveDate,
          annualRate: String(item.annualRate),
        }))
      : [{
          id: makeDraftId(),
          effectiveDate: new Date().toISOString().slice(0, 10),
          annualRate: row.annualRate == null ? "" : String(row.annualRate),
        }];
    setRateDrafts(drafts);
    setLprDiscount(row.mortgageLprDiscount == null ? "" : String(row.mortgageLprDiscount));
    setRateCardOpen(true);
  }

  function addRateDraft() {
    setRateDrafts((items) => [
      ...items,
      { id: makeDraftId(), effectiveDate: new Date().toISOString().slice(0, 10), annualRate: "" },
    ]);
  }

  function updateRateDraft(id: string, patch: Partial<RateAdjustmentDraft>) {
    setRateDrafts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function deleteRateDraft(id: string) {
    setRateDrafts((items) => items.filter((item) => item.id !== id));
  }

  function generateLprRateDrafts() {
    const discount = Number(lprDiscount.trim());
    if (!Number.isFinite(discount) || discount <= 0) {
      window.alert("请先填写正确的利率折扣，例如 0.85");
      return;
    }
    const adjustments = buildMortgageLprRateAdjustments({
      discount,
      throughDate: new Date().toISOString().slice(0, 10),
    });
    if (adjustments.length === 0) {
      window.alert("没有生成可用的 LPR 利率调整，请检查折扣或重定价日期");
      return;
    }
    setRateDrafts(adjustments.map((item) => ({
      id: makeDraftId(),
      effectiveDate: item.effectiveDate,
      annualRate: item.annualRate.toFixed(3).replace(/\.?0+$/, ""),
    })));
  }

  async function saveRateAdjustments() {
    if (!selectedRow?.accountId || rateSaving) return;
    const adjustments = rateDrafts
      .filter((item) => item.effectiveDate.trim() || item.annualRate.trim())
      .map((item) => ({
        effectiveDate: item.effectiveDate.trim(),
        annualRate: Number(item.annualRate),
      }));
    const duplicateDates = new Set<string>();
    for (const item of adjustments) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) || !Number.isFinite(item.annualRate) || item.annualRate <= 0) {
        window.alert("请检查利率调整记录：生效日期和年利率都必须填写正确");
        return;
      }
      if (duplicateDates.has(item.effectiveDate)) {
        window.alert(`生效日期重复：${item.effectiveDate}`);
        return;
      }
      duplicateDates.add(item.effectiveDate);
    }

    setRateSaving(true);
    try {
      const response = await fetch("/api/v1/loan-rate-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selectedRow.accountId, adjustments }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || "保存利率调整失败");
        return;
      }
      setRateCardOpen(false);
      router.refresh();
    } finally {
      setRateSaving(false);
    }
  }

  async function recalculateRepaymentPlan() {
    if (!selectedRow?.accountId || recalcSaving) return;
    if (
      recalcStartDate &&
      selectedRow.nextRepaymentDate &&
      recalcStartDate < selectedRow.nextRepaymentDate &&
      !window.confirm("重算起始日期早于当前下次还款日，将改写这之后由计划任务生成的历史还款记录。本操作不会改写手工录入记录。是否继续？")
    ) {
      return;
    }
    setRecalcSaving(true);
    try {
      const response = await fetch("/api/v1/loan-repayment/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedRow.accountId,
          strategy: recalcStrategy,
          startDate: recalcStartDate,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || "重算失败");
        return;
      }
      setRecalcOpen(false);
      router.refresh();
    } finally {
      setRecalcSaving(false);
    }
  }

  function openRecalculateDialog(row: DebtRow) {
    setRecalcStartDate(row.nextRepaymentDate || new Date().toISOString().slice(0, 10));
    setRecalcOpen(true);
  }

  const rowColumns = useMemo<AdvancedDataTableColumn<DebtRow>[]>(() => [
    {
      key: "name",
      label: "债权人/债务人 款项",
      width: 360,
      minWidth: 180,
      filterText: (row) => row.name,
      render: (row) => (
        <span className="block truncate text-sm font-semibold text-slate-800" title={row.name}>
          {row.name}
        </span>
      ),
    },
    {
      key: "itemType",
      label: "款项类型",
      width: 150,
      minWidth: 110,
      filterText: (row) => row.itemType,
      render: (row) => <span className={row.net >= 0 ? "text-emerald-700" : "text-slate-700"}>{row.itemType}</span>,
    },
    {
      key: "repaymentMethod",
      label: "收/还款方式",
      width: 140,
      minWidth: 100,
      hideable: true,
      filterText: (row) => row.repaymentMethod || "-",
      render: (row) => <span className="text-slate-600">{row.repaymentMethod || "-"}</span>,
    },
    {
      key: "annualRate",
      label: "利率",
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      render: (row) => <span className="tabular-nums text-slate-600">{formatRate(row.annualRate)}</span>,
    },
    {
      key: "remainingRuns",
      label: "剩余期数",
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      render: (row) => <span className="tabular-nums text-slate-600">{row.remainingRuns == null ? "-" : row.remainingRuns}</span>,
    },
    {
      key: "paidPrincipal",
      label: "已还本金",
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      render: (row) => <span className="tabular-nums text-emerald-700">{formatMoney(Math.abs(row.paidPrincipal))}</span>,
    },
    {
      key: "paidInterest",
      label: "已还利息",
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.paidInterest))}</span>,
    },
    {
      key: "remainingInterest",
      label: "剩余利息",
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.remainingInterest))}</span>,
    },
    {
      key: "net",
      label: "待收/还",
      width: 130,
      minWidth: 96,
      align: "right",
      render: (row) => <span className="font-semibold tabular-nums text-slate-800">{formatMoney(Math.abs(row.net))}</span>,
    },
  ], []);

  const entryColumns = useMemo<AdvancedDataTableColumn<DebtEntry>[]>(() => [
    { key: "date", label: "日期", width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "type", label: "类型", width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "relatedAccount", label: "明细账户", width: 160, minWidth: 100, filterText: (entry) => entry.relatedAccountLabel, render: (entry) => <span className="block truncate text-slate-600" title={entry.relatedAccountLabel}>{entry.relatedAccountLabel || "-"}</span> },
    { key: "note", label: "备注", width: 260, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: "本金",
      width: 120,
      minWidth: 86,
      align: "right",
      render: (entry) => (
        <span className={`inline-flex items-center justify-end gap-1 font-semibold tabular-nums ${amountClass(entry.principal)}`}>
          {entry.principal >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
          {formatMoney(entry.principal)}
        </span>
      ),
    },
    {
      key: "interest",
      label: "利息",
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      render: (entry) => <span className="tabular-nums text-amber-700">{entry.interest ? formatMoney(entry.interest) : "-"}</span>,
    },
    {
      key: "paymentTotal",
      label: "还款总额",
      width: 120,
      minWidth: 92,
      align: "right",
      hideable: true,
      filterText: (entry) => entry.paymentTotal == null ? "-" : entry.paymentTotal.toFixed(2),
      render: (entry) => (
        <span className="font-semibold tabular-nums text-slate-700">
          {entry.paymentTotal == null ? "-" : formatMoney(entry.paymentTotal)}
        </span>
      ),
    },
    { key: "balance", label: "贷款余额", width: 130, minWidth: 92, align: "right", render: (entry) => <span className={`font-semibold tabular-nums ${amountClass(entry.balance)}`}>{formatMoney(entry.balance)}</span> },
    {
      key: "actions",
      label: "操作",
      width: 92,
      minWidth: 76,
      align: "right",
      render: (entry) => (
        <div onClick={stopRowClick}>
          <EntryRowActions
            entryId={entry.id}
            edit={entry.edit}
            customEditEvent={entry.debtEdit ? { name: "mmh:debt:create", detail: entry.debtEdit } : undefined}
          />
        </div>
      ),
    },
  ], []);

  const repaymentScheduleColumns = useMemo<AdvancedDataTableColumn<RepaymentScheduleRow>[]>(() => [
    {
      key: "status",
      label: "状态",
      width: 82,
      minWidth: 64,
      filterText: (row) => row.rowType === "rate_adjustment" ? "利率调整" : row.status === "paid" ? "已还" : "计划",
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="text-blue-700">利率</span>
        : row.status === "paid"
          ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">已还</span>
          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">计划</span>,
    },
    {
      key: "eventType",
      label: "类型",
      width: 100,
      minWidth: 78,
      filterText: (row) => row.rowType === "rate_adjustment" ? "利率调整" : row.eventType === "prepayment" ? "提前还款" : "还款",
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="font-medium text-blue-700">利率调整</span>
        : row.eventType === "prepayment"
          ? <span className="font-medium text-amber-700">提前还款</span>
          : <span className="text-slate-700">还款</span>,
    },
    { key: "period", label: "期次", width: 80, minWidth: 64, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-slate-700">{row.period}</span> },
    { key: "date", label: "日期", width: 110, minWidth: 86, filterText: (row) => row.date, render: (row) => <span className="tabular-nums text-slate-700">{row.date}</span> },
    { key: "principal", label: "本金", width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="tabular-nums text-blue-700">{formatRate(row.annualRate)}</span> : <span className="tabular-nums text-emerald-700">{formatMoney(row.principal)}</span> },
    { key: "interest", label: "利息", width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-amber-700">{formatMoney(row.interest)}</span> },
    { key: "payment", label: "本期还款", width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="font-medium text-blue-700">利率调整</span> : <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.payment)}</span> },
    { key: "remainingPrincipal", label: "剩余本金", width: 140, minWidth: 104, align: "right", render: (row) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.remainingPrincipal)}</span> },
  ], []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden bg-transparent p-4 md:p-5">
        <section className="panel-surface flex min-h-0 flex-[0_0_48%] flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <HandCoins className="h-4 w-4 text-amber-500" />
              债权债务
            </div>
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={showSettledRows}
                  onChange={(event) => setShowSettledRows(event.target.checked)}
                  className="h-3.5 w-3.5 accent-blue-600"
                />
                显示已还完{settledCount > 0 ? `(${settledCount})` : ""}
              </label>
              <div className="text-xs text-slate-400">正数表示借出余额，负数表示借入余额</div>
            </div>
          </div>

          <AdvancedDataTable
            storageKey="mmh_debt_rows_table_v1"
            columns={rowColumns}
            rows={visibleRows}
            rowKey={(row) => row.key}
            minTableWidth={1120}
            emptyText="暂无债务/债权余额"
            fillHeight
            compactRows
            onRowClick={(row) => openDebtRow(row)}
            onRowDoubleClick={(row) => openRepayment(row)}
            rowClassName={(row) => `cursor-pointer ${row.key === (selectedRow?.key ?? "") ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
            summaryRow={{
              rowClassName: "bg-slate-50",
              cellClassName: "py-2.5",
              cells: {
                name: <span className="font-semibold tracking-[0.08em] text-slate-500">汇总</span>,
                paidPrincipal: <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(debtRowSummary.paidPrincipal)}</span>,
                paidInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(debtRowSummary.paidInterest)}</span>,
                remainingInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(debtRowSummary.remainingInterest)}</span>,
                net: <span className="font-semibold tabular-nums text-slate-800">{formatMoney(debtRowSummary.net)}</span>,
              },
            }}
          />
        </section>

        <section className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5">
              <button
                type="button"
                onClick={() => setDetailTab("entries")}
                className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "entries" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
              >
                交易明细
              </button>
              <button
                type="button"
                onClick={() => setDetailTab("schedule")}
                className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "schedule" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
              >
                还款表
              </button>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                disabled={!canAdjustRateSelectedRow}
                onClick={() => selectedRow && openRateAdjustment(selectedRow)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                title={canAdjustRateSelectedRow ? "新增贷款利率调整" : "只有借入贷款可以调整利率"}
              >
                <Percent className="h-3.5 w-3.5" />
                利率调整
              </button>
              <button
                type="button"
                disabled={!canRecalculateSelectedRow}
                onClick={() => selectedRow && openRecalculateDialog(selectedRow)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                title={canRecalculateSelectedRow ? "按当前余额和利率重算后续还款计划" : "只有有固定计划的借入贷款可以重算"}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重算
              </button>
              <button
                type="button"
                disabled={!canRepaySelectedRow}
                onClick={() => selectedRow && openRepayment(selectedRow)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                title={canRepaySelectedRow ? "登记本期还款" : "只有借入余额可以还款"}
              >
                <HandCoins className="h-3.5 w-3.5" />
                还款
              </button>
            </div>
          </div>

          {!selectedRow ? (
            <div className="flex min-h-0 flex-1 items-center justify-center border-t border-slate-100 bg-slate-50/60 px-4 text-sm text-slate-500">
              请先选择上方往来账户
            </div>
          ) : detailTab === "entries" ? (
            <AdvancedDataTable
              storageKey="mmh_debt_entries_table_v1"
              columns={entryColumns}
              rows={entries}
              rowKey={(entry) => entry.id}
              minTableWidth={980}
              emptyText="暂无明细"
              fillHeight
              compactRows
              selectable
              selectedKeys={selectedEntryIds}
              onSelectionChange={setSelectedEntryIds}
              batchActions={[
                { label: "批量删除", onClick: batchDeleteEntries },
                { label: "批量修改", onClick: () => window.alert("批量修改入口已接入，下一步会复用统一批量修改弹窗。") },
              ]}
            />
          ) : (
            <AdvancedDataTable
              storageKey="mmh_debt_repayment_schedule_table_v1"
              columns={repaymentScheduleColumns}
              rows={visibleRepaymentScheduleRows}
              rowKey={(row) => `${row.status ?? ""}:${row.eventType ?? ""}:${row.rowType}:${row.period}:${row.date}:${row.annualRate ?? ""}`}
              minTableWidth={920}
              emptyText="暂无还款计划"
              fillHeight
              compactRows
              toolbarMode="custom"
              toolbarLeftContent={(
                <span>
                  {showPaidScheduleRows ? `显示 ${visibleRepaymentScheduleRows.length}/${repaymentScheduleRows.length} 条` : `未还 ${visibleRepaymentScheduleRows.length} 条`}
                </span>
              )}
              toolbarRightContent={(
                <label className="flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={showPaidScheduleRows}
                    onChange={(event) => setShowPaidScheduleRows(event.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  显示已还
                </label>
              )}
              rowClassName={(row) => row.rowType === "rate_adjustment"
                ? "bg-blue-50 hover:bg-blue-50"
                : row.status === "paid"
                  ? "bg-emerald-50/40 hover:bg-emerald-50"
                  : ""}
            />
          )}
        </section>

        {rateCardOpen ? (
          <div className="app-modal-backdrop z-50">
            <div className="app-modal-panel max-w-2xl">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">利率调整</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedRow?.name ?? "当前贷款"}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setRateCardOpen(false)}
                  className="secondary-button h-8 px-2"
                  disabled={rateSaving}
                >
                  关闭
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                  利率调整会影响生效日之后的还款表和后续自动还款。已执行的还款明细不会自动改写，如需重算历史记录请先确认记录处理方式。
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">按 LPR 折扣生成</div>
                      <div className="mt-0.5 text-[11px] leading-5 text-slate-500">
                        适合老房贷折扣利率。系统按“{MORTGAGE_BASE_BENCHMARK_RATE.toFixed(2)}% × 折扣 - {MORTGAGE_LPR_CONVERSION_BASE_RATE.toFixed(2)}%”计算固定加点，每年 1 月 1 日按上一期 5 年期以上 LPR 重定价。
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_92px] gap-2">
                    <div className="space-y-1">
                      <div className="form-label">利率折扣</div>
                      <input
                        value={lprDiscount}
                        onChange={(event) => setLprDiscount(event.target.value)}
                        inputMode="decimal"
                        placeholder="例如：0.85"
                        className="form-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">固定加点</div>
                      <input
                        value={(() => {
                          const discount = Number(lprDiscount.trim());
                          return Number.isFinite(discount) && discount > 0
                            ? `${calcMortgageLprSpreadFromDiscount(discount).toFixed(3).replace(/\.?0+$/, "")}%`
                            : "";
                        })()}
                        readOnly
                        placeholder="自动计算"
                        className="form-input bg-white/70 text-slate-500"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={generateLprRateDrafts}
                        className="inline-flex h-9 w-full items-center justify-center rounded-full border border-blue-600 bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-500"
                        disabled={rateSaving}
                      >
                        生成
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 px-1 text-xs font-medium text-slate-500">
                    <div>生效日期</div>
                    <div>年利率（%）</div>
                    <div className="text-right">操作</div>
                  </div>
                  <div className="max-h-[230px] space-y-2 overflow-y-auto pr-1">
                    {rateDrafts.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                        暂无利率调整记录
                      </div>
                    ) : rateDrafts.map((item) => (
                      <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2">
                        <DateStepper
                          value={item.effectiveDate}
                          onChange={(value) => updateRateDraft(item.id, { effectiveDate: value })}
                        />
                        <input
                          value={item.annualRate}
                          onChange={(event) => updateRateDraft(item.id, { annualRate: event.target.value })}
                          inputMode="decimal"
                          placeholder="例如：4.015"
                          className="form-input"
                        />
                        <button
                          type="button"
                          onClick={() => deleteRateDraft(item.id)}
                          className="secondary-button h-9 px-2 text-rose-600 hover:bg-rose-50"
                          disabled={rateSaving}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    onClick={addRateDraft}
                    className="secondary-button h-9 px-3"
                    disabled={rateSaving}
                  >
                    新增一行
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRateCardOpen(false)}
                      className="secondary-button h-9 px-3"
                      disabled={rateSaving}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => { void saveRateAdjustments(); }}
                      className="primary-button h-9 px-3"
                      disabled={rateSaving}
                    >
                      {rateSaving ? "保存中..." : "保存利率调整"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {recalcOpen ? (
          <div className="app-modal-backdrop z-50">
            <div className="app-modal-panel max-w-lg">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">重算还款计划</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedRow?.name ?? "当前贷款"}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setRecalcOpen(false)}
                  className="secondary-button h-8 px-2"
                  disabled={recalcSaving}
                >
                  关闭
                </button>
              </div>

              <div className="space-y-3 p-4 text-sm text-slate-700">
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  重算只影响起始日期之后的计划金额或剩余期数，不会新增还款记录，也不会改写已经执行的历史明细。起始日期不能早于当前下次还款日。
                </div>

                <div className="space-y-1 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="form-label">重算起始日期（下次还款日）</div>
                  <DateStepper value={recalcStartDate} onChange={setRecalcStartDate} />
                  <div className="text-[11px] text-slate-500">
                    将从这一天开始使用当前余额和生效利率重算，并把它作为新的下次还款日。
                  </div>
                </div>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <input
                    type="radio"
                    name="loan-recalculate-strategy"
                    checked={recalcStrategy === "reduce_payment"}
                    onChange={() => setRecalcStrategy("reduce_payment")}
                    className="mt-0.5 h-4 w-4 accent-blue-600"
                  />
                  <span>
                    <span className="block font-medium text-slate-800">期限不变，重算月供</span>
                    <span className="block text-xs text-slate-500">保持当前剩余期数，按当前贷款余额和生效利率重新计算每期还款额。</span>
                  </span>
                </label>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <input
                    type="radio"
                    name="loan-recalculate-strategy"
                    checked={recalcStrategy === "reduce_term"}
                    onChange={() => setRecalcStrategy("reduce_term")}
                    className="mt-0.5 h-4 w-4 accent-blue-600"
                  />
                  <span>
                    <span className="block font-medium text-slate-800">月供不变，重算剩余期数</span>
                    <span className="block text-xs text-slate-500">保持当前计划金额，按当前贷款余额向后模拟，缩短或修正剩余还款期数。</span>
                  </span>
                </label>

                <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <div>
                    <div className="text-slate-400">当前剩余本金</div>
                    <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{formatMoney(Math.abs(selectedRow?.net ?? 0))}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">当前剩余期数</div>
                    <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{selectedRow?.remainingRuns ?? "-"}</div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    className="secondary-button h-9 px-3"
                    onClick={() => setRecalcOpen(false)}
                    disabled={recalcSaving}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary-button h-9 px-3"
                    onClick={() => { void recalculateRepaymentPlan(); }}
                    disabled={recalcSaving}
                  >
                    {recalcSaving ? "重算中..." : "确认重算"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
  );
}
