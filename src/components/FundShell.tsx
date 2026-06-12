"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/format";
import { toNumber } from "@/lib/date-utils";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ChevronUp, ChevronDown, Download, Upload, Trash2 } from "lucide-react";
import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { WealthFormModal } from "@/components/WealthFormModal";
import { DepositFormModal } from "@/components/DepositFormModal";
import { FillNavButton } from "@/components/FillNavButton";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { RefreshNavButton } from "@/components/RefreshNavButton";
import { AddNavButton } from "@/components/AddNavButton";
import { TableColumnFilter } from "@/components/TableColumnFilter";

import { subtypeDisplay } from "@/lib/investment-config";

function fl(subtype: string | null | undefined, source: string | null | undefined) {
  return subtypeDisplay(subtype, source);
}
function fmtDate(v: any) { if (!v) return ""; const s = typeof v === "string" ? v : v?.toISOString?.(); return s ? s.slice(0, 10) : ""; }

type Props = any;

export function FundShell(props: Props) {
  const router = useRouter();
  const {
    view, initialFundCode, positions, clearedPositions, allEntries,
    totalMarketValue, totalCost, totalHistoricalProfit,
    confirmDaysMap, feeRateMap, initialShowCleared, baseQuery,
    accountId, selectedAccount, selectedAccountLabel, accountOptions,
    cashAccounts, investmentAccounts, createAction, editAction,
    fillNavAction, regularInvestFormAction, lastUsedCashAccount, isRedUp,
  } = props;

  const [fundCode, setFundCode] = useState(initialFundCode);
  const [showCleared, setShowCleared] = useState(initialShowCleared);
  const [fundPage, setFundPage] = useState(1);
  const [fundPageSize, setFundPageSize] = useState(20);
  const [sortKey, setSortKey] = useState("marketValue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [clearedSortKey, setClearedSortKey] = useState("clearedDate");
  const [clearedSortDir, setClearedSortDir] = useState<"asc" | "desc">("desc");
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const [adjustedNavByCode, setAdjustedNavByCode] = useState<Record<string, { nav: number; date: string }>>({});
  const [navLoading, setNavLoading] = useState<Record<string, boolean>>({});
  const [navDateOffset, setNavDateOffset] = useState<Record<string, number>>({});

  type FundFilterColumn = "cashAccount" | "subtype" | "status";
  const filterColumns: FundFilterColumn[] = ["cashAccount", "subtype", "status"];
  const [activeFilterColumn, setActiveFilterColumn] = useState<FundFilterColumn | null>(null);
  const [columnFilters, setColumnFilters] = useState<Partial<Record<FundFilterColumn, string[]>>>({});
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const dateFilterRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleteMessage, setBatchDeleteMessage] = useState("");
  const [batchDeleting, setBatchDeleting] = useState(false);

  type FundBatchField = "cashAccountId" | "fundAccountId" | "amount" | "fundConfirmDate" | "fundArrivalDate" | "remark";

  const upCls = isRedUp ? "text-red-600" : "text-emerald-700";
  const downCls = isRedUp ? "text-emerald-700" : "text-red-600";
  const pnl = (n: number) => n > 0 ? upCls : n < 0 ? downCls : "text-slate-600";

  function exportCSV(scope?: "current" | "all") {
    const rows = (scope === "current" ? filtered : (allEntries || [])) as any[];
    const label = scope === "current" ? fundCode || "current" : "all";
    const header = ["申请日期", "确认日期", "到账日期", "资金账户", "基金代码", "基金名称", "净值", "份额", "交易类型", "金额", "收益", "状态"];
    const accountLabelById = new Map<string, string>();
    for (const a of accountOptions as any[]) {
      if (a?.id) accountLabelById.set(String(a.id), String(a.label ?? ""));
    }
    const parts: string[] = [];
    parts.push(header.join(","));
    parts.push("\n");

    for (const e of rows) {
      const nav = e.fundNav != null ? e.fundNav : "";
      const units = e.fundUnits != null ? e.fundUnits : "";
      const amt = e.amount != null ? e.amount : "";
      const profit = e.realizedProfit != null ? e.realizedProfit : "";
      const subtype = fl(e.fundSubtype, e.source).label;
      // redeem/dividend_cash: 资金收到方是 toAccountId
      const isR = e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash";
      const cashAccLabel = accountLabelById.get(String(isR ? e.toAccountId : e.accountId)) ?? "";
      const cashAccName = cashAccLabel ? (cashAccLabel.split("·").pop() ?? cashAccLabel) : "-";
      // buy_failed has no actual confirmDate/units — show "-"
      const isBuyFailed = e.fundSubtype === "buy_failed";
      const confirmDate = isBuyFailed ? "-"
        : e.fundSubtype === "dividend_cash" ? fmtDate(e.fundArrivalDate)
        : (e.fundUnits != null && Number(e.fundUnits) > 0) ? fmtDate(e.fundConfirmDate) : "待确认";
      const status = isBuyFailed ? "暂停申购" : (e.fundUnits == null || Number(e.fundUnits) === 0) ? "待确认" : "确认";

      parts.push([
        fmtDate(e.date),
        confirmDate || "",
        e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : "",
        cashAccName,
        e.fundCode || "",
        e.fundName || "",
        String(nav),
        String(units),
        subtype,
        String(amt),
        String(profit),
        status,
      ].join(","));
      parts.push("\n");
    }

    const bom = "﻿";
    const blob = new Blob([bom, ...parts], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `交易明细_${label}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sortedPositions = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...positions].sort((a: any, b: any) => {
      let v = 0;
      switch (sortKey) {
        case "fundCode": v = a.fundCode.localeCompare(b.fundCode); break;
        case "cost": v = a.cost - b.cost; break;
        case "floatingPnL": v = a.floatingPnL - b.floatingPnL; break;
        case "floatingPnLRate": v = a.floatingPnLRate - b.floatingPnLRate; break;
        case "historicalProfit": v = a.historicalProfit - b.historicalProfit; break;
        case "marketValue": default: v = a.marketValue - b.marketValue; break;
      }
      return v * dir;
    });
  }, [positions, sortKey, sortDir]);

  const sortedClearedPositions = useMemo(() => {
    const dir = clearedSortDir === "asc" ? 1 : -1;
    return [...clearedPositions].sort((a: any, b: any) => {
      let v = 0;
      switch (clearedSortKey) {
        case "fundCode": v = a.fundCode.localeCompare(b.fundCode); break;
        case "clearedDate": v = a.clearedDate.localeCompare(b.clearedDate); break;
        case "historicalProfit": v = a.historicalProfit - b.historicalProfit; break;
        default: v = a.clearedDate.localeCompare(b.clearedDate); break;
      }
      return v * dir;
    });
  }, [clearedPositions, clearedSortKey, clearedSortDir]);

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function toggleClearedSort(key: string) {
    if (clearedSortKey === key) setClearedSortDir(clearedSortDir === "desc" ? "asc" : "desc");
    else { setClearedSortKey(key); setClearedSortDir("desc"); }
  }

  function SortHead({ sk, label, cls, sortType }: { sk: string; label: string; cls: string; sortType?: "position" | "cleared" }) {
    const isCleared = sortType === "cleared";
    const active = isCleared ? clearedSortKey === sk : sortKey === sk;
    const dir = isCleared ? clearedSortDir : sortDir;
    const toggle = isCleared ? toggleClearedSort : toggleSort;
    return (
      <th className={cls} onClick={() => toggle(sk)} style={{ cursor: "pointer" }}>
        <span className={`inline-flex items-center gap-0.5 hover:text-blue-700 ${active ? "text-blue-700" : ""}`}>
          {label} {active ? <span className="text-[10px]">{dir === "asc" ? "↑" : "↓"}</span> : <span className="text-[10px] text-slate-300">↕</span>}
        </span>
      </th>
    );
  }

  function switchFund(code: string) {
    setFundCode(code);
    setFundPage(1);
    const q = new URLSearchParams(baseQuery);
    q.set("view", view); q.set("fundCode", code);
    if (showCleared) q.set("showCleared", "1");
    window.history.replaceState(null, "", `/?${q.toString()}`);
  }
  function toggleCleared(on: boolean) {
    setShowCleared(on);
    const q = new URLSearchParams(baseQuery); q.set("view", view);
    if (on) { q.set("showCleared", "1"); q.delete("fundCode"); }
    else { q.delete("showCleared"); q.delete("fundCode"); }
    window.history.replaceState(null, "", `/?${q.toString()}`);
    setFundCode(on && clearedPositions.length > 0 ? clearedPositions[0].fundCode : positions.length > 0 ? positions[0].fundCode : "");
    setFundPage(1);
  }

  const filtered = useMemo(() => fundCode ? allEntries.filter((e: any) => e.fundCode === fundCode) : allEntries, [allEntries, fundCode]);

  useEffect(() => {
    const list = showCleared ? sortedClearedPositions : sortedPositions;
    const available = (list || []).map((p: any) => String(p.fundCode ?? "")).filter(Boolean);

    const q = new URLSearchParams(baseQuery);
    q.set("view", view);
    if (showCleared) q.set("showCleared", "1");
    else q.delete("showCleared");

    if (available.length === 0) {
      if (fundCode) setFundCode("");
      q.delete("fundCode");
      window.history.replaceState(null, "", `/?${q.toString()}`);
      return;
    }

    if (!fundCode || !available.includes(fundCode)) {
      const next = available[0]!;
      setFundCode(next);
      setFundPage(1);
      q.set("fundCode", next);
      window.history.replaceState(null, "", `/?${q.toString()}`);
    }
  }, [baseQuery, view, showCleared, fundCode, sortedPositions, sortedClearedPositions]);

  const cashAccountNameOf = (e: any) => {
    const isR = e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash" || (e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund");
    const ca = isR ? e.toAccountId : e.accountId;
    if (!ca || ca === (isR ? e.accountId : e.toAccountId)) return "(空)";
    const o = accountOptions.find((a: any) => a.id === ca);
    const label = o?.label?.split("·").pop() ?? o?.label ?? "";
    return label.trim() || "(空)";
  };

  const statusOf = (e: any) => {
    if (e.fundSubtype === "buy_failed") return "暂停申购";
    const units = e.fundUnits != null ? toNumber(e.fundUnits) : null;
    return units != null && units > 0 ? "确认" : "待确认";
  };

  const subtypeOf = (e: any) => fl(e.fundSubtype, e.source).label || "(空)";

  const normalizeYmd = (raw: string) => {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    const m8 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m8) return `${m8[1]}-${m8[2]}-${m8[3]}`;
    const replaced = s.replace(/[./]/g, "-");
    const parts = replaced.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 3) return "";
    const [y, m, d] = parts;
    const mm = String(m).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd)) return "";
    return `${y}-${mm}-${dd}`;
  };

  const inDateRange = (value: string, from: string, to: string) => {
    const v = normalizeYmd(value);
    let f = normalizeYmd(from);
    let t = normalizeYmd(to);
    if (f && t && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (!f && !t) return true;
    if (!v) return false;
    if (f && v < f) return false;
    if (t && v > t) return false;
    return true;
  };

  const hasAnyFilters = useMemo(() => {
    if (dateFrom || dateTo) return true;
    return Object.values(columnFilters).some((v) => (v?.length ?? 0) > 0);
  }, [dateFrom, dateTo, columnFilters]);

  const clearAllFilters = () => {
    setFundPage(1);
    setDateFrom("");
    setDateTo("");
    setColumnFilters({});
    setActiveFilterColumn(null);
    setDateFilterOpen(false);
  };

  const getFilterColumnValue = (e: any, column: FundFilterColumn) => {
    if (column === "cashAccount") return cashAccountNameOf(e);
    if (column === "subtype") return subtypeOf(e);
    return statusOf(e);
  };

  const columnFilterOptions = useMemo(() => {
    if (!activeFilterColumn) return [];
    const values: string[] = filtered.map((e: any) => getFilterColumnValue(e, activeFilterColumn));
    return Array.from(new Set(values)).sort((a, b) => (a === "(空)" ? 1 : b === "(空)" ? -1 : a.localeCompare(b, "zh-CN")));
  }, [filtered, activeFilterColumn, accountOptions]);

  const filteredByColumns = useMemo(() => {
    return filtered.filter((e: any) => {
      const applyDate = fmtDate(e.date);
      if (!inDateRange(applyDate, dateFrom, dateTo)) return false;
      return filterColumns.every((column) => {
        const allowedValues = columnFilters[column];
        const v = getFilterColumnValue(e, column);
        return !allowedValues?.length || allowedValues.includes(v);
      });
    });
  }, [filtered, columnFilters, accountOptions, dateFrom, dateTo]);

  const filteredByColumnsIdSet = useMemo(() => new Set(filteredByColumns.map((e: any) => e.id)), [filteredByColumns]);
  const batchTargetIds = useMemo(() => Array.from(selectedIds).filter((id) => filteredByColumnsIdSet.has(id)), [selectedIds, filteredByColumnsIdSet]);

  const totalPages = Math.max(1, Math.ceil(filteredByColumns.length / fundPageSize));
  const safePage = Math.min(fundPage, totalPages);

  useEffect(() => {
    if (!dateFilterOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = dateFilterRef.current;
      if (!el) return;
      if (e.target && el.contains(e.target as Node)) return;
      setDateFilterOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dateFilterOpen]);
  const paged = filteredByColumns.slice((safePage - 1) * fundPageSize, safePage * fundPageSize);

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const id of next) {
        if (!filteredByColumnsIdSet.has(id)) next.delete(id);
      }
      return next;
    });
  }, [filteredByColumnsIdSet]);

  useEffect(() => {
    if (!showExportMenu) return;
    function onOutside(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExportMenu(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [showExportMenu]);

  async function adjustNavDate(code: string, delta: number) {
    if (navLoading[code]) return;
    setNavLoading(prev => ({ ...prev, [code]: true }));
    const offset = (navDateOffset[code] ?? 0) + delta;
    setNavDateOffset(prev => ({ ...prev, [code]: offset }));
    try {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      const dateStr = d.toISOString().slice(0, 10);
      const res = await fetch(`/api/v1/fund/nav?code=${encodeURIComponent(code)}&date=${encodeURIComponent(dateStr)}`);
      const data = await res.json();
      if (data.ok && data.nav) {
        // Show nav date as MM.DD only
        const dd = (data.date || dateStr).slice(5);
        setAdjustedNavByCode(prev => ({ ...prev, [code]: { nav: data.nav, date: dd } }));
      }
    } catch { /* ignore */ }
    finally { setNavLoading(prev => ({ ...prev, [code]: false })); }
  }

  const batchFields = useMemo<BatchReplaceFieldConfig<FundBatchField>[]>(() => [
    {
      value: "cashAccountId",
      label: "资金账户",
      kind: "select",
      options: [{ value: "", label: "选择账户" }, ...cashAccounts.map((a: any) => ({ value: a.id, label: a.label }))],
    },
    {
      value: "fundAccountId",
      label: "基金账户",
      kind: "select",
      options: [{ value: "", label: "选择账户" }, ...investmentAccounts.map((a: any) => ({ value: a.id, label: a.label }))],
    },
    { value: "amount", label: "金额", kind: "number", placeholder: "如 100、*2、+10、-5、/2" },
    { value: "fundConfirmDate", label: "确认日期", kind: "date", allowEmpty: true },
    { value: "fundArrivalDate", label: "到账日期", kind: "date", allowEmpty: true },
    { value: "remark", label: "备注", kind: "text", placeholder: "输入替换内容，可留空清除备注", allowEmpty: true },
  ], [cashAccounts, investmentAccounts]);

  async function applyBatch(field: FundBatchField, value: string) {
    const ids = batchTargetIds;
    if (ids.length === 0) throw new Error("请先勾选记录");

    const updates = ids.map((id) => {
      if (field === "remark") return { id, remark: value };
      if (field === "fundConfirmDate") return { id, fundConfirmDate: value };
      if (field === "fundArrivalDate") return { id, fundArrivalDate: value };
      if (field === "cashAccountId") return { id, cashAccountId: value };
      if (field === "fundAccountId") return { id, fundAccountId: value };
      return { id, amount: value };
    });

    const res = await fetch("/api/v1/entries/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "批量修改失败" }));
    if (!res.ok || !data.ok) throw new Error(data.error ?? "批量修改失败");

    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    router.refresh();
    return `已修改 ${data.updatedCount ?? 0} 条记录`;
  }

  async function applyBatchDelete() {
    const ids = batchTargetIds;
    if (ids.length === 0 || batchDeleting) return;
    if (!window.confirm(`确认删除已勾选 ${ids.length} 条基金明细？删除后会进入回收站。`)) return;

    setBatchDeleting(true);
    setBatchDeleteMessage("");
    try {
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: ids }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "批量删除失败" }));
      if (!res.ok || !data.ok) {
        setBatchDeleteMessage(data.error ?? "批量删除失败");
        return;
      }
      setBatchDeleteMessage(data.message ?? `已删除 ${ids.length} 条记录`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      router.refresh();
    } catch {
      setBatchDeleteMessage("批量删除失败");
    } finally {
      setBatchDeleting(false);
    }
  }

  const renderColumnFilter = (column: FundFilterColumn, label: string) => {
    const selectedValues = columnFilters[column] ?? [];
    const isOpen = activeFilterColumn === column;
    const options = isOpen ? columnFilterOptions : [];
    return (
      <TableColumnFilter
        label={label}
        options={options}
        selectedValues={selectedValues}
        open={isOpen}
        onToggleOpen={() => setActiveFilterColumn((current) => current === column ? null : column)}
        onClose={() => setActiveFilterColumn(null)}
        onChange={(values) => setColumnFilters((prev) => ({ ...prev, [column]: values }))}
      />
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 p-4 bg-slate-50">
      <div className="flex-1 min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5">
              <button onClick={() => toggleCleared(false)} className={`h-6 px-2 rounded text-xs ${!showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>持仓基金</button>
              <button onClick={() => toggleCleared(true)} className={`h-6 px-2 rounded text-xs ${showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>清仓基金</button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 min-h-[24px]">
            {!showCleared ? (<>
              <RegularInvestForm accountId={accountId} accountLabel={selectedAccountLabel} cashAccounts={cashAccounts} action={regularInvestFormAction} lastUsedCashAccountId={lastUsedCashAccount?.accountId} showTriggerButton={true} prefilledFundCode={fundCode} prefilledFundName={positions?.find((p: any) => p.fundCode === fundCode)?.name ?? null} />
              {positions.length > 0 && <RefreshNavButton accountId={accountId} symbols={positions.map((p: any) => p.fundCode).filter(Boolean)} />}
              <AddNavButton accountId={accountId} />
            </>) : null}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {!showCleared ? (
            <table className="min-w-[800px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <SortHead sk="fundCode" label="基金" cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" />
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">份额</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">均价</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">净值</th>
                  <SortHead sk="cost" label="持仓成本" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <SortHead sk="marketValue" label="市值" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">未确认金额</th>
                  <SortHead sk="floatingPnL" label="浮盈" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <SortHead sk="floatingPnLRate" label="浮盈率" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                  <SortHead sk="historicalProfit" label="历史收益" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" />
                </tr>
              </thead>
              <tbody className="text-sm">
                {sortedPositions.length === 0 ? (
                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={10}>暂无持仓数据</td></tr>
                ) : sortedPositions.map((p: any) => {
                  const active = p.fundCode === fundCode;
                  const adj = adjustedNavByCode[p.fundCode];
                  const displayNav = adj ? adj.nav : p.nav;
                  const displayNavDate = adj ? adj.date : p.navDate;
                  const displayMV = adj && p.units > 0 ? p.units * adj.nav : p.marketValue;
                  const displayPnL = adj ? displayMV - p.cost : p.floatingPnL;
                  const displayPnLRate = p.cost > 0 ? (displayPnL / p.cost) * 100 : 0;
                  const loading = navLoading[p.fundCode];
                  return (
                    <tr
                      key={p.fundCode}
                      onClick={() => switchFund(p.fundCode)}
                      className={`cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
                    >
                      <td className="px-4 py-2 border-b border-slate-100"><span className={`text-xs font-medium ${active ? "text-blue-700" : "text-slate-800"}`}>{p.name}{p.fundCode !== p.name && <span className="ml-1 text-slate-400">{p.fundCode}</span>}</span></td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.units.toFixed(2)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.avgCost.toFixed(4)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">
                        <div className="flex items-center justify-end gap-0.5">
                          <span>{displayNav != null ? displayNav.toFixed(4) : "-"}{displayNavDate ? <span className="ml-0.5 text-slate-400">({displayNavDate})</span> : null}{loading && <span className="ml-0.5 text-amber-500 animate-pulse">…</span>}</span>
                          <div className="flex flex-col ml-1" onClick={e => e.stopPropagation()}>
                            <button className="h-3 w-4 flex items-center justify-center text-slate-300 hover:text-blue-600" onClick={() => adjustNavDate(p.fundCode, 1)}><ChevronUp className="w-3 h-3" /></button>
                            <button className="h-3 w-4 flex items-center justify-center text-slate-300 hover:text-blue-600" onClick={() => adjustNavDate(p.fundCode, -1)}><ChevronDown className="w-3 h-3" /></button>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(p.cost)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(displayMV)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.pendingCost > 0 ? <span className="text-amber-600 font-medium">{formatMoney(p.pendingCost)}</span> : <span className="text-slate-300">-</span>}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayPnL)}`}>{formatMoney(displayPnL)}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayPnLRate)}`}>{displayPnLRate.toFixed(2)}%</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(p.historicalProfit)}`}>{formatMoney(p.historicalProfit)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {positions.length > 0 && (
                <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">
                  <tr>
                    <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={4}>汇总</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalCost)}</td>
                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalMarketValue)}</td>
                    <td className="px-3 py-2 border-t border-slate-200"></td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalMarketValue - totalCost)}`}>{formatMoney(totalMarketValue - totalCost)}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalMarketValue - totalCost)}`}>{totalCost !== 0 ? `${(((totalMarketValue - totalCost) / totalCost) * 100).toFixed(2)}%` : "-"}</td>
                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalHistoricalProfit)}`}>{formatMoney(totalHistoricalProfit)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          ) : (
            <table className="min-w-[600px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <SortHead sk="fundCode" label="基金名称" cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" sortType="cleared" />
                  <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">初次购买</th>
                  <SortHead sk="clearedDate" label="清仓时间" cls="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" sortType="cleared" />
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">申购金额</th>
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">赎回金额</th>
                  <SortHead sk="historicalProfit" label="清仓收益" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" sortType="cleared" />
                  <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">收益率</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {sortedClearedPositions.length === 0 ? (
                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={7}>暂无清仓基金</td></tr>
                ) : sortedClearedPositions.map((c: any) => {
                  const active = c.fundCode === fundCode;
                  return (
                    <tr
                      key={c.fundCode}
                      onClick={() => switchFund(c.fundCode)}
                      className={`cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
                    >
                      <td className="px-4 py-2 border-b border-slate-100"><span className={`text-xs font-medium ${active ? "text-blue-700" : "text-slate-800"}`}>{c.name}<span className="ml-1 text-slate-400">{c.fundCode}</span></span></td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">{c.firstBuyDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs tabular-nums text-slate-600">{c.clearedDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(c.totalBuyAmount)}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(c.totalRedeemAmount)}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(c.historicalProfit)}`}>{formatMoney(c.historicalProfit)}</td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(c.returnRate)}`}>{(c.returnRate * 100).toFixed(2)}%</td>
                    </tr>
                  );
                })}
              </tbody>
              {sortedClearedPositions.length > 0 && (() => {
                const totalBuyAmt = sortedClearedPositions.reduce((s: number, c: any) => s + c.totalBuyAmount, 0);
                const totalRedeemAmt = sortedClearedPositions.reduce((s: number, c: any) => s + c.totalRedeemAmount, 0);
                const totalReturnRate = totalBuyAmt > 0 ? (totalHistoricalProfit / totalBuyAmt) : 0;
                return (
                  <tfoot className="sticky bottom-0 bg-slate-50 font-semibold">
                    <tr>
                      <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={3}>汇总</td>
                      <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalBuyAmt)}</td>
                      <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalRedeemAmt)}</td>
                      <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalHistoricalProfit)}`}>{formatMoney(totalHistoricalProfit)}</td>
                      <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalReturnRate)}`}>{totalBuyAmt > 0 ? `${(totalReturnRate * 100).toFixed(2)}%` : "-"}</td>
                    </tr>
                  </tfoot>
                );
              })()}
            </table>
          )}
        </div>
      </div>

      {/* 交易明细 */}
      <div className="flex-1 min-h-0 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
        <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="text-sm font-semibold text-slate-800">
            交易明细{fundCode && <span className="ml-2 text-xs text-slate-500 font-normal">{fundCode}</span>}
            <span className="ml-2 text-xs text-slate-400 font-normal">{filteredByColumns.length}/{filtered.length}</span>
          </div>
          <div className="flex items-center gap-1 text-xs">
            <Link href="/batch-import" className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导入交易明细">
              <Upload className="w-3 h-3" />导入
            </Link>
            {hasAnyFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                title="清除筛选条件"
              >
                清除筛选
              </button>
            )}
            {batchDeleteMessage ? <span className="px-1 text-[10px] text-rose-500">{batchDeleteMessage}</span> : null}
            <div className="relative" ref={exportRef}>
              <button onClick={() => setShowExportMenu(!showExportMenu)} className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导出 CSV">
                <Download className="w-3 h-3" />导出
              </button>
              {showExportMenu && (
                <div className="absolute right-0 top-7 z-50 bg-white border border-slate-200 rounded-md shadow-lg py-1 min-w-[160px]">
                  {fundCode && (
                    <button onClick={() => { setShowExportMenu(false); exportCSV("current"); }}
                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50">
                      导出当前基金明细
                    </button>
                  )}
                  <button onClick={() => { setShowExportMenu(false); exportCSV("all"); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50">
                    导出账户全部基金
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setActiveFilterColumn(null);
                setColumnFilters({});
                setDateFrom(""); setDateTo("");
                setFundPage(1);
              }}
              className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
              title="清空表头筛选"
            >
              清空筛选
            </button>
            <span className="text-slate-300">|</span>
            {[10, 20, 40].map((n) => (
              <button key={n} onClick={() => { setFundPageSize(n); setFundPage(1); }} className={`h-6 px-1.5 rounded border ${fundPageSize === n ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>{n}</button>
            ))}
            <button onClick={() => { setFundPageSize(filteredByColumns.length); setFundPage(1); }} className={`h-6 px-1.5 rounded border ${fundPageSize === filteredByColumns.length ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>所有</button>
            <span className="text-slate-300">|</span>
            {safePage > 1 && (<>
              <button onClick={() => setFundPage(1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsLeft className="h-3 w-3"/></button>
              <button onClick={() => setFundPage(safePage - 1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronLeft className="h-3 w-3"/></button>
            </>)}
            <span className="text-slate-500 px-0.5">{safePage}/{totalPages}</span>
            {safePage < totalPages && (<>
              <button onClick={() => setFundPage(safePage + 1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronRight className="h-3 w-3"/></button>
              <button onClick={() => setFundPage(totalPages)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsRight className="h-3 w-3"/></button>
            </>)}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="min-w-[780px] w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-white">
              <tr>
                <th className="w-10 align-middle text-left text-xs font-semibold text-slate-600 px-2 py-1 border-b border-slate-200">
                  <div className="flex h-7 items-center justify-center">
                    <input
                      type="checkbox"
                      checked={filteredByColumns.length > 0 && filteredByColumns.every((e: any) => selectedIds.has(e.id))}
                      ref={(input) => {
                        if (!input) return;
                        const checked = filteredByColumns.length > 0 && filteredByColumns.every((e: any) => selectedIds.has(e.id));
                        const some = filteredByColumns.some((e: any) => selectedIds.has(e.id));
                        input.indeterminate = !checked && some;
                      }}
                      onChange={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          const ids = filteredByColumns.map((e: any) => e.id);
                          const allSelected = ids.length > 0 && ids.every((id: string) => next.has(id));
                          ids.forEach((id: string) => {
                            if (allSelected) next.delete(id);
                            else next.add(id);
                          });
                          return next;
                        });
                      }}
                      className="h-3.5 w-3.5 accent-blue-600"
                      title="选择当前筛选结果"
                      aria-label="选择当前筛选结果"
                    />
                  </div>
                </th>
                <th className="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">
                  <div className="relative inline-flex items-center gap-1" ref={dateFilterRef}>
                    <span>申请日期</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setDateFilterOpen((v) => !v); }}
                      className={`h-5 w-5 rounded border text-[10px] leading-none ${(dateFrom || dateTo) ? "border-blue-300 bg-blue-50 text-blue-600" : "border-slate-200 bg-white text-slate-500"}`}
                      title="按日期范围筛选"
                    >
                      ▼
                    </button>
                    {dateFilterOpen && (
                      <div className="absolute left-0 top-6 z-30 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
                        <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                          <span className="text-xs font-medium text-slate-700">日期筛选</span>
                          <button type="button" onClick={() => setDateFilterOpen(false)} className="text-xs text-slate-400 hover:text-slate-700">关闭</button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <div className="text-[10px] text-slate-500">从（≥）</div>
                            <input
                              type="date"
                              value={dateFrom}
                              onChange={(ev) => { setFundPage(1); setDateFrom(ev.target.value); }}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") {
                                  ev.preventDefault();
                                  setDateFilterOpen(false);
                                }
                              }}
                              className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[10px] text-slate-500">到（≤）</div>
                            <input
                              type="date"
                              value={dateTo}
                              onChange={(ev) => { setFundPage(1); setDateTo(ev.target.value); }}
                              onKeyDown={(ev) => {
                                if (ev.key === "Enter") {
                                  ev.preventDefault();
                                  setDateFilterOpen(false);
                                }
                              }}
                              className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
                            />
                          </div>
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setDateFilterOpen(false)}
                            className="h-8 px-3 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                          >
                            确认
                          </button>
                          <button
                            type="button"
                            onClick={() => { setFundPage(1); setDateFrom(""); setDateTo(""); setDateFilterOpen(false); }}
                            className="h-8 px-3 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          >
                            清空
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">确认日期</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">到账日期</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{renderColumnFilter("cashAccount", "资金账户")}</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">基金</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">净值</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">份额</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{renderColumnFilter("subtype", "交易类型")}</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">金额</th>
                <th className="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">收益</th>
                <th className="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">{renderColumnFilter("status", "状态")}</th>
                <th className="w-[96px] align-middle text-right text-xs font-semibold text-slate-600 px-2 py-1 border-b border-slate-200">
                  <div className="flex h-7 items-center justify-end gap-1">
                    <BatchReplacePopoverButton
                      fields={batchFields}
                      targetCount={batchTargetIds.length}
                      targetLabel="已勾选"
                      buttonClassName="h-7 w-7 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                      onApply={applyBatch}
                    />
                    <button
                      type="button"
                      onClick={applyBatchDelete}
                      disabled={batchTargetIds.length === 0 || batchDeleting}
                      className="h-7 w-7 rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                      title={batchTargetIds.length === 0 ? "请先勾选记录" : `批量删除已勾选 ${batchTargetIds.length} 条记录`}
                      aria-label={batchTargetIds.length === 0 ? "请先勾选记录再批量删除" : `批量删除已勾选 ${batchTargetIds.length} 条记录`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {paged.length > 0 ? paged.map((e: any) => {
                const amount = toNumber(e.amount);
                const nav = e.fundNav != null ? toNumber(e.fundNav) : null;
                const units = e.fundUnits != null ? toNumber(e.fundUnits) : null;
                const info = fl(e.fundSubtype, e.source);
                const selected = selectedIds.has(e.id);
                return (
                  <tr
                    key={e.id}
                    className={`cursor-pointer ${selected ? "bg-blue-100 hover:bg-blue-100" : "hover:bg-slate-50"}`}
                    onClick={() => setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.id)) next.delete(e.id);
                      else next.add(e.id);
                      return next;
                    })}
                  >
                    <td className="w-10 align-middle px-2 py-1 border-b border-slate-100 text-xs">
                      <div className="flex h-7 items-center justify-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(e.id)}
                          onClick={(ev) => ev.stopPropagation()}
                          onChange={() => setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(e.id)) next.delete(e.id);
                            else next.add(e.id);
                            return next;
                          })}
                          className="h-3.5 w-3.5 accent-blue-600"
                          aria-label="选择基金交易明细"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-600">{fmtDate(e.date)}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
                      {e.fundSubtype === "dividend_cash" ? (fmtDate(e.fundArrivalDate) || "-")
                        : e.fundSubtype === "buy_failed" ? (fmtDate(e.fundConfirmDate) || "-")
                        : units != null && units > 0 ? (fmtDate(e.fundConfirmDate) || "-")
                        : <span className="text-amber-500">待确认</span>}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">
                      {e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : <span className="text-slate-300">-</span>}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">
                      {(() => {
                        const label = cashAccountNameOf(e);
                        return label === "(空)" ? <span className="text-slate-300">-</span> : label;
                      })()}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-700">{e.fundName || e.fundCode || "-"}{e.fundCode && e.fundName && e.fundName !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{nav != null ? nav.toFixed(4) : <span className="text-slate-400">-</span>}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{units != null ? units.toFixed(2) : <span className="text-slate-400">-</span>}</td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs"><span className={`px-1 py-0.5 rounded text-[10px] font-medium ${e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls}`}>{info.label}</span></td>
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums text-slate-700">
                      {(() => {
                        const absAmt = formatMoney(Math.abs(amount));
                        if (e.source === "dividend" || e.fundSubtype === "dividend_cash") return <span className={`font-medium ${upCls}`}>+{absAmt}</span>;
                        return absAmt;
                      })()}
                    </td>
                    <td className={`px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(toNumber(e.realizedProfit))}`}>
                      {e.realizedProfit != null && e.fundSubtype === "redeem" ? formatMoney(toNumber(e.realizedProfit)) : <span className="text-slate-300">-</span>}
                    </td>
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-600">
                      {(() => {
                        const s = statusOf(e);
                        if (s === "待确认") return <span className="text-amber-600">{s}</span>;
                        if (s === "暂停申购") return <span className="text-rose-600">{s}</span>;
                        return <span className="text-emerald-700">{s}</span>;
                      })()}
                    </td>
                    <td className="w-[96px] align-middle px-2 py-1 border-b border-slate-100">
                      <div className="flex h-7 items-center justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>
                        {e.fundCode && e.fundSubtype === "buy" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} /> : null}
                        {e.fundProductType === "wealth" ? (
                          <WealthFormModal
                            mode="edit"
                            accountId={selectedAccount?.id ?? ""}
                            entry={{
                              id: e.id, transactionId: e.id,
                              date: fmtDate(e.date),
                              amount: toNumber(e.amount), note: e.note ?? null,
                              fundName: e.fundName ?? null,
                              fundProductType: e.fundProductType ?? null,
                              fundSubtype: e.fundSubtype ?? null,
                              accountId: e.accountId ?? null,
                              toAccountId: e.toAccountId ?? null,
                              toAccountName: e.toAccountName ?? null,
                            }}
                            cashAccounts={cashAccounts}
                            investmentAccounts={investmentAccounts}
                            createAction={createAction}
                            editAction={editAction}
                          />
                        ) : e.fundProductType === "deposit" ? (
                          <DepositFormModal
                            mode="edit"
                            accountId={selectedAccount?.id ?? ""}
                            entry={{
                              id: e.id, transactionId: e.id,
                              date: fmtDate(e.date),
                              amount: toNumber(e.amount), note: e.note ?? null,
                              fundName: e.fundName ?? null,
                              fundProductType: e.fundProductType ?? null,
                              fundSubtype: e.fundSubtype ?? null,
                              accountId: e.accountId ?? null,
                              toAccountId: e.toAccountId ?? null,
                              toAccountName: e.toAccountName ?? null,
                            }}
                            cashAccounts={cashAccounts}
                            investmentAccounts={investmentAccounts}
                            createAction={createAction}
                            editAction={editAction}
                          />
                        ) : (
                          <InvestmentFormModal
                            mode="edit"
                            entry={{
                              id: e.id, transactionId: e.id,
                              date: fmtDate(e.date),
                              confirmDate: fmtDate(e.fundConfirmDate) || undefined,
                              amount: toNumber(e.amount), note: e.note ?? null, memo: e.note ?? null,
                              fundCode: e.fundCode ?? null, fundName: e.fundName ?? e.fundCode ?? null,
                              fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
                              fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
                              fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
                              fundProductType: e.fundProductType ?? null, fundSubtype: e.fundSubtype ?? null,
                              source: e.source ?? null,
                              accountId: e.accountId ?? null, toAccountId: e.toAccountId ?? null, toAccountName: e.toAccountName ?? null,
                              fundArrivalDate: fmtDate(e.fundArrivalDate) || null,
                              fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
                              realizedProfit: e.realizedProfit != null ? toNumber(e.realizedProfit) : null,
                            }}
                            accountId={selectedAccount?.id ?? ""}
                            accountProductType={selectedAccount?.investProductType ?? null}
                            defaults={{
                              confirmDays: confirmDaysMap[e.fundCode ?? ""] ?? selectedAccount?.defaultConfirmDays ?? undefined,
                              feeRate: feeRateMap[`${e.fundCode ?? ""}:${e.fundSubtype === "redeem" ? "redeem" : "buy"}`] ?? null,
                            }}
                            cashAccounts={cashAccounts}
                            investmentAccounts={investmentAccounts}
                            createAction={createAction}
                            editAction={editAction}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              }) : (<tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={13}>暂无交易记录</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
