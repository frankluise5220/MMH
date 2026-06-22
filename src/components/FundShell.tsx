"use client";



import { useState, useMemo, useRef, useEffect, useCallback, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

import { useRouter } from "next/navigation";

import Link from "next/link";

import { startTransition } from "react";

import { formatMoney } from "@/lib/format";

import { toNumber } from "@/lib/date-utils";

import { CalendarSync, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Upload, Trash2 } from "lucide-react";

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

function isGenericFundName(name: string, code: string) {
  const value = name.trim();
  if (!value || value === code) return true;
  return ["红利转投", "红利再投", "红利再投资", "现金红利", "分红", "买入", "申购", "赎回", "定投"].includes(value);
}



type Props = any;

type FundTableKey = "positions" | "cleared" | "details";
type FundTableViewportKey = "summary" | "details";

const FUND_TABLE_WIDTHS_KEY = "mmh_fund_shell_column_widths_v1";

const POSITION_COLS = [
  ["fund", 260],
  ["units", 92],
  ["avgCost", 84],
  ["nav", 136],
  ["cost", 112],
  ["marketValue", 112],
  ["pending", 78],
  ["floatingPnL", 104],
  ["floatingRate", 84],
  ["historical", 108],
  ["actions", 112],
] as const;

const CLEARED_COLS = [
  ["fund", 220],
  ["firstBuy", 108],
  ["clearedDate", 108],
  ["buyAmount", 112],
  ["redeemAmount", 112],
  ["historical", 112],
  ["returnRate", 80],
] as const;

const DETAIL_COLS = [
  ["select", 44],
  ["date", 92],
  ["arrivalDate", 92],
  ["cashAccount", 132],
  ["fund", 156],
  ["nav", 86],
  ["units", 84],
  ["subtype", 88],
  ["amount", 76],
  ["profit", 76],
  ["status", 72],
  ["actions", 112],
] as const;

const FUND_COL_MIN_WIDTHS: Record<FundTableKey, Record<string, number>> = {
  positions: {
    avgCost: 76,
    nav: 118,
  },
  cleared: {},
  details: {
    nav: 76,
  },
};

function minFundColWidth(table: FundTableKey, key: string) {
  return FUND_COL_MIN_WIDTHS[table]?.[key] ?? 44;
}



export function FundShell(props: Props) {

  const router = useRouter();

  const {

    view, initialFundCode, positions, clearedPositions, allEntries,

    totalMarketValue, totalCost, totalHistoricalProfit,

    confirmDaysMap, feeRateMap, initialShowCleared, baseQuery,

    accountId, selectedAccount, selectedAccountLabel, accountOptions,

    cashAccounts, investmentAccounts, cashAccountSSOptions, investmentAccountSSOptions, nestedFieldData, createAction, editAction,

    fillNavAction, regularInvestFormAction, lastUsedCashAccount, isRedUp,
    fundUnitsDecimals: fundUnitsDecimalsProp,

  } = props;

  const fundUnitsDecimals = Number.isFinite(Number(fundUnitsDecimalsProp)) ? Math.min(Math.max(Math.round(Number(fundUnitsDecimalsProp)), 0), 6) : 2;

  const formatFundUnits = (value: number) => value.toFixed(fundUnitsDecimals);



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

  const [localData, setLocalData] = useState({ positions, clearedPositions, allEntries, totalMarketValue, totalCost, totalHistoricalProfit, confirmDaysMap, feeRateMap });
  const [fetchedFundNames, setFetchedFundNames] = useState<Record<string, string>>({});
  const [regularPlans, setRegularPlans] = useState<any[]>([]);
  const [editingRegularPlan, setEditingRegularPlan] = useState<any | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, Record<string, number>>>({});
  const summaryTableViewportRef = useRef<HTMLDivElement>(null);
  const detailTableViewportRef = useRef<HTMLDivElement>(null);
  const [tableViewportWidths, setTableViewportWidths] = useState<Record<FundTableViewportKey, number>>({
    summary: 0,
    details: 0,
  });

  // Shadow props with reactive local state
  const d = localData;





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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FUND_TABLE_WIDTHS_KEY);
      if (raw) setColumnWidths(JSON.parse(raw));
    } catch {}
  }, []);

  const colWidth = useCallback((table: FundTableKey, key: string, fallback: number) => {
    const width = columnWidths[table]?.[key];
    const minWidth = minFundColWidth(table, key);
    return Math.max(minWidth, Number.isFinite(width) ? Number(width) : fallback);
  }, [columnWidths]);

  useEffect(() => {
    const targets: Array<[FundTableViewportKey, RefObject<HTMLDivElement | null>]> = [
      ["summary", summaryTableViewportRef],
      ["details", detailTableViewportRef],
    ];

    const updateWidth = (key: FundTableViewportKey, node: HTMLDivElement | null) => {
      if (!node) return;
      const width = Math.floor(node.clientWidth);
      setTableViewportWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width }));
    };

    targets.forEach(([key, ref]) => updateWidth(key, ref.current));

    if (typeof ResizeObserver === "undefined") {
      const onResize = () => targets.forEach(([key, ref]) => updateWidth(key, ref.current));
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    const observers = targets.map(([key, ref]) => {
      if (!ref.current) return null;
      const observer = new ResizeObserver(() => updateWidth(key, ref.current));
      observer.observe(ref.current);
      return observer;
    });

    return () => observers.forEach((observer) => observer?.disconnect());
  }, []);

  const tableLayout = useCallback((
    table: FundTableKey,
    cols: readonly (readonly [string, number])[],
    minTableWidth: number,
    viewportWidth: number,
  ) => {
    const baseWidths = cols.map(([key, fallback]) => [key, colWidth(table, key, fallback)] as const);
    const baseTotal = baseWidths.reduce((sum, [, width]) => sum + width, 0);
    const targetWidth = Math.max(minTableWidth, viewportWidth || 0, baseTotal);
    const scale = baseTotal > 0 && baseTotal < targetWidth ? targetWidth / baseTotal : 1;
    const colWidths = Object.fromEntries(baseWidths.map(([key, width]) => [key, width * scale]));

    return { tableWidth: targetWidth, colWidths };
  }, [colWidth]);

  const positionLayout = useMemo(
    () => tableLayout("positions", POSITION_COLS, 1220, tableViewportWidths.summary),
    [tableLayout, tableViewportWidths.summary],
  );
  const clearedLayout = useMemo(
    () => tableLayout("cleared", CLEARED_COLS, 820, tableViewportWidths.summary),
    [tableLayout, tableViewportWidths.summary],
  );
  const detailLayout = useMemo(
    () => tableLayout("details", DETAIL_COLS, 1100, tableViewportWidths.details),
    [tableLayout, tableViewportWidths.details],
  );

  const setColWidth = useCallback((table: FundTableKey, key: string, width: number) => {
    setColumnWidths((prev) => {
      const next = {
        ...prev,
        [table]: {
          ...(prev[table] ?? {}),
          [key]: Math.max(minFundColWidth(table, key), Math.round(width)),
        },
      };
      try {
        window.localStorage.setItem(FUND_TABLE_WIDTHS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const beginColumnResize = useCallback((event: ReactMouseEvent, table: FundTableKey, key: string, currentWidth: number, minWidth = 48) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = currentWidth;

    const onMove = (moveEvent: MouseEvent) => {
      setColWidth(table, key, Math.max(minWidth, startWidth + moveEvent.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [setColWidth]);

  const ResizeGrip = ({ table, colKey, width, minWidth = 48 }: { table: FundTableKey; colKey: string; width: number; minWidth?: number }) => (
    <span
      role="separator"
      aria-orientation="vertical"
      onMouseDown={(event) => beginColumnResize(event, table, colKey, width, minWidth)}
      className="absolute right-[-3px] top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none hover:bg-blue-300/40"
      title="拖动调整列宽"
    />
  );

  const fundNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of [...(d.positions || []), ...(d.clearedPositions || [])] as any[]) {
      const code = String(p?.fundCode ?? "").trim();
      const name = String(p?.name ?? "").trim();
      if (code && name && name !== code) map.set(code, name);
    }
    return map;
  }, [d.positions, d.clearedPositions]);

  const displayFundName = useCallback((entry: any) => {
    const code = String(entry?.fundCode ?? "").trim();
    const fetched = code ? fetchedFundNames[code] : "";
    if (fetched && !isGenericFundName(fetched, code)) return fetched;
    const mapped = code ? fundNameByCode.get(code) : "";
    if (mapped && !isGenericFundName(mapped, code)) return mapped;
    const stored = String(entry?.fundName ?? "").trim();
    if (stored && !isGenericFundName(stored, code)) return stored;
    return code || "-";
  }, [fetchedFundNames, fundNameByCode]);



  function exportCSV(scope?: "current" | "all") {

    const rows = (scope === "current" ? filtered : (allEntries || [])) as any[];

    const label = scope === "current" ? fundCode || "current" : "all";

    const header = ["申请日期", "确认日期", "到账日期", "资金账户", "基金代码", "基金名称", "净值", "份额", "交易类型", "金额", "收益", "状态"];

    const accountLabelByIdLocal = new Map<string, string>();

    for (const a of accountOptions as any[]) {

      if (a?.id) accountLabelByIdLocal.set(String(a.id), String(a.label ?? ""));

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

      const cashAccLabel = accountLabelByIdLocal.get(String(isR ? e.toAccountId : e.accountId)) ?? "";

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

        displayFundName(e),

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

    return [...d.positions].sort((a: any, b: any) => {

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

  }, [d.positions, sortKey, sortDir]);



  const sortedClearedPositions = useMemo(() => {

    const dir = clearedSortDir === "asc" ? 1 : -1;

    return [...d.clearedPositions].sort((a: any, b: any) => {

      let v = 0;

      switch (clearedSortKey) {

        case "fundCode": v = a.fundCode.localeCompare(b.fundCode); break;

        case "clearedDate": v = a.clearedDate.localeCompare(b.clearedDate); break;

        case "historicalProfit": v = a.historicalProfit - b.historicalProfit; break;

        default: v = a.clearedDate.localeCompare(b.clearedDate); break;

      }

      return v * dir;

    });

  }, [d.clearedPositions, clearedSortKey, clearedSortDir]);



  function toggleSort(key: string) {

    if (sortKey === key) setSortDir(sortDir === "desc" ? "asc" : "desc");

    else { setSortKey(key); setSortDir("desc"); }

  }



  function toggleClearedSort(key: string) {

    if (clearedSortKey === key) setClearedSortDir(clearedSortDir === "desc" ? "asc" : "desc");

    else { setClearedSortKey(key); setClearedSortDir("desc"); }

  }



  function SortHead({
    sk,
    label,
    cls,
    sortType,
    table,
    colKey,
    width,
    minWidth,
  }: {
    sk: string;
    label: string;
    cls: string;
    sortType?: "position" | "cleared";
    table?: FundTableKey;
    colKey?: string;
    width?: number;
    minWidth?: number;
  }) {

    const isCleared = sortType === "cleared";

    const active = isCleared ? clearedSortKey === sk : sortKey === sk;

    const dir = isCleared ? clearedSortDir : sortDir;

    const toggle = isCleared ? toggleClearedSort : toggleSort;

    return (

      <th className={`${cls} relative select-none`} onClick={() => toggle(sk)} style={{ cursor: "pointer" }}>

        <span className={`inline-flex items-center gap-0.5 hover:text-blue-700 ${active ? "text-blue-700" : ""}`}>

          {label} {active ? <span className="text-[10px]">{dir === "asc" ? "↑" : "↓"}</span> : <span className="text-[10px] text-slate-300">↕</span>}

        </span>

        {table && colKey && width ? <ResizeGrip table={table} colKey={colKey} width={width} minWidth={minWidth} /> : null}

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

    const nextCode = on && d.clearedPositions.length > 0 ? d.clearedPositions[0].fundCode : d.positions.length > 0 ? d.positions[0].fundCode : "";

    setFundCode(nextCode);

    setFundPage(1);

  }



  // Listen for fund data refresh event from modals (stable handler with debounce)
  const refreshBusy = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shellDataRequestSeq = useRef(0);
  const fundCodeRef = useRef(fundCode);
  const showClearedRef = useRef(showCleared);
  const accountIdRef = useRef(accountId);

  useEffect(() => {
    fundCodeRef.current = fundCode;
    showClearedRef.current = showCleared;
    accountIdRef.current = accountId;
  }, [fundCode, showCleared, accountId]);

  const loadFundShellData = useCallback(async (code: string, cleared: boolean) => {
    const seq = ++shellDataRequestSeq.current;
    try {
      const sc = cleared ? "1" : "0";
      const res = await fetch(`/api/v1/fund/shell-data?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(code)}&showCleared=${sc}&entryScope=account`);
      const json = await res.json();
      if (json.ok && seq === shellDataRequestSeq.current) {
        startTransition(() => {
          setLocalData((prev) => {
            const refreshedEntries = Array.isArray(json.allEntries) ? json.allEntries : [];
            const refreshedIds = new Set(refreshedEntries.map((entry: any) => entry.id));
            const nextAllEntries = json.entryScope === "account"
              ? refreshedEntries
              : code
              ? [
                  ...prev.allEntries.filter((entry: any) => entry.fundCode !== code && !refreshedIds.has(entry.id)),
                  ...refreshedEntries,
                ]
              : refreshedEntries;

            return {
              positions: json.positions,
              clearedPositions: json.clearedPositions,
              allEntries: nextAllEntries,
              totalMarketValue: json.totalMarketValue,
              totalCost: json.totalCost,
              totalHistoricalProfit: json.totalHistoricalProfit,
              confirmDaysMap: json.confirmDaysMap,
              feeRateMap: json.feeRateMap,
            };
          });
        });
      }
    } catch {}
  }, [accountId]);

  function handleEntryNavFilled(entry: any, data: { nav: number; confirmDate: string; units: number; arrivalDate?: string }) {
    const code = entry.fundCode || fundCodeRef.current;

    if (code) {
      setAdjustedNavByCode((prev) => {
        if (!(code in prev)) return prev;
        const next = { ...prev };
        delete next[code];
        return next;
      });
    }

    setLocalData(prev => ({
      ...prev,
      allEntries: prev.allEntries.map((en: any) => en.id === entry.id ? {
        ...en,
        fundNav: data.nav,
        fundConfirmDate: data.confirmDate ? new Date(data.confirmDate) : en.fundConfirmDate,
        fundUnits: data.units,
        fundArrivalDate: data.arrivalDate ? new Date(data.arrivalDate) : en.fundArrivalDate,
      } : en),
    }));

    if (code) void loadFundShellData(code, showClearedRef.current);
  }

  const shellRefreshHandler = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(async () => {
      if (refreshBusy.current) return;
      refreshBusy.current = true;
      try {
        const fc = fundCodeRef.current;
        if (!fc) return;
        const sc = showClearedRef.current ? "1" : "0";
        const aid = accountIdRef.current;
        const seq = ++shellDataRequestSeq.current;
        const res = await fetch(`/api/v1/fund/shell-data?accountId=${encodeURIComponent(aid)}&fundCode=${encodeURIComponent(fc)}&showCleared=${sc}&entryScope=account`);
        const json = await res.json();
        if (json.ok && seq === shellDataRequestSeq.current) {
          startTransition(() => {
            setLocalData((prev) => {
              const refreshedEntries = Array.isArray(json.allEntries) ? json.allEntries : [];
              const refreshedIds = new Set(refreshedEntries.map((entry: any) => entry.id));
              const nextAllEntries = json.entryScope === "account"
                ? refreshedEntries
                : fc
                ? [
                    ...prev.allEntries.filter((entry: any) => entry.fundCode !== fc && !refreshedIds.has(entry.id)),
                    ...refreshedEntries,
                  ]
                : refreshedEntries;

              return {
                positions: json.positions,
                clearedPositions: json.clearedPositions,
                allEntries: nextAllEntries,
                totalMarketValue: json.totalMarketValue,
                totalCost: json.totalCost,
                totalHistoricalProfit: json.totalHistoricalProfit,
                confirmDaysMap: json.confirmDaysMap,
                feeRateMap: json.feeRateMap,
              };
            });
          });
        }
      } catch {} finally {
        refreshBusy.current = false;
      }
    }, 80);
  }, []);

  useEffect(() => {
    window.addEventListener("mmh:fund:refresh", shellRefreshHandler);
    return () => {
      window.removeEventListener("mmh:fund:refresh", shellRefreshHandler);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [shellRefreshHandler]);







  const filtered = useMemo(() => fundCode ? d.allEntries.filter((e: any) => e.fundCode === fundCode) : d.allEntries, [d.allEntries, fundCode]);
  const selectedPosition = useMemo(
    () => (d.positions || []).find((p: any) => p.fundCode === fundCode) ?? null,
    [d.positions, fundCode],
  );
  const selectedFundCodeCls = selectedPosition ? pnl(toNumber(selectedPosition.historicalProfit ?? selectedPosition.floatingPnL ?? 0)) : "text-slate-500";
  const loadRegularPlans = useCallback(async () => {
    if (!accountId) {
      setRegularPlans([]);
      return;
    }
    try {
      const res = await fetch(`/api/v1/regular-invest?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!data?.ok || !Array.isArray(data.plans)) return;
      setRegularPlans(data.plans.filter((plan: any) => plan.status !== "stopped" && plan.status !== "completed"));
    } catch {}
  }, [accountId]);

  useEffect(() => {
    void loadRegularPlans();
  }, [loadRegularPlans]);

  useEffect(() => {
    window.addEventListener("mmh:fund:refresh", loadRegularPlans);
    return () => window.removeEventListener("mmh:fund:refresh", loadRegularPlans);
  }, [loadRegularPlans]);

  const regularPlanByFundCode = useMemo(() => {
    const map = new Map<string, any>();
    for (const plan of regularPlans) {
      const code = String(plan?.fundCode ?? "").trim();
      if (!code || map.has(code)) continue;
      map.set(code, plan);
    }
    return map;
  }, [regularPlans]);

  useEffect(() => {
    const candidates = new Map<string, string>();
    for (const e of filtered as any[]) {
      const code = String(e?.fundCode ?? "").trim();
      if (!code || code.length !== 6 || fetchedFundNames[code]) continue;
      const mapped = fundNameByCode.get(code) ?? "";
      const stored = String(e?.fundName ?? "").trim();
      if (!isGenericFundName(mapped || stored, code)) continue;
      candidates.set(code, code);
    }
    for (const code of Array.from(candidates.keys()).slice(0, 5)) {
      fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`)
        .then((res) => res.ok ? res.json() : null)
        .then((json) => {
          const name = String(json?.name ?? "").trim();
          if (!name || isGenericFundName(name, code)) return;
          setFetchedFundNames((prev) => prev[code] ? prev : { ...prev, [code]: name });
        })
        .catch(() => {});
    }
  }, [filtered, fetchedFundNames, fundNameByCode]);



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



  const cashAccountInfoOf = (e: any) => {

    const isR = e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash" || (e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund");

    const ca = isR ? e.toAccountId : e.accountId;

    if (!ca || ca === (isR ? e.accountId : e.toAccountId)) return null;

    const o = accountOptions.find((a: any) => a.id === ca);

    const label = String(o?.label ?? "").trim();

    return {
      label: label || "(空)",
      groupName: String(o?.groupName ?? "").trim(),
    };

  };

  const cashAccountNameOf = (e: any) => {

    const info = cashAccountInfoOf(e);

    if (!info) return "(空)";

    return info.label;

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

  const allFundPageSize = Math.max(1, filteredByColumns.length);



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

    window.dispatchEvent(new Event("mmh:fund:refresh")); return `已修改 ${data.updatedCount ?? 0} 条记录`;

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

      window.dispatchEvent(new Event("mmh:fund:refresh"));

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

    <div className="flex-1 min-h-0 flex flex-col gap-4 bg-transparent p-4 md:p-5">

      <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">

        <div className="panel-header shrink-0">

          <div className="flex items-center gap-2">

            <div className="flex items-center gap-0.5">

              <button onClick={() => toggleCleared(false)} className={`h-6 px-2 rounded text-xs ${!showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>持仓基金</button>

              <button onClick={() => toggleCleared(true)} className={`h-6 px-2 rounded text-xs ${showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>清仓基金</button>

            </div>

          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 min-h-[24px]">

            {!showCleared ? (<>

              <RegularInvestForm accountId={accountId} accountLabel={selectedAccountLabel} cashAccounts={cashAccounts} cashAccountSSOptions={cashAccountSSOptions} investmentAccountSSOptions={investmentAccountSSOptions} nestedFieldData={nestedFieldData} action={regularInvestFormAction} lastUsedCashAccountId={lastUsedCashAccount?.accountId} showTriggerButton={true} />

              {d.positions.length > 0 && <RefreshNavButton accountId={accountId} symbols={d.positions.map((p: any) => p.fundCode).filter(Boolean)} />}

            </>) : null}

          </div>

        </div>

        <div ref={summaryTableViewportRef} className="flex-1 min-h-0 overflow-auto">

          {!showCleared ? (

            <table
              className="min-w-[1220px] table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200"
              style={{ width: positionLayout.tableWidth }}
            >
              <colgroup>
                {POSITION_COLS.map(([key, fallback]) => (
                  <col key={key} style={{ width: positionLayout.colWidths[key] ?? colWidth("positions", key, fallback) }} />
                ))}
              </colgroup>

              <thead className="sticky top-0 z-10 bg-white">

                <tr>

                  <SortHead sk="fundCode" label="基金" cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" table="positions" colKey="fund" width={colWidth("positions", "fund", 260)} minWidth={160} />

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    份额
                    <ResizeGrip table="positions" colKey="units" width={colWidth("positions", "units", 92)} minWidth={64} />
                  </th>

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    均价
                    <ResizeGrip table="positions" colKey="avgCost" width={colWidth("positions", "avgCost", 84)} minWidth={76} />
                  </th>

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    净值
                    <ResizeGrip table="positions" colKey="nav" width={colWidth("positions", "nav", 136)} minWidth={118} />
                  </th>

                  <SortHead sk="cost" label="持仓成本" cls="text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200" table="positions" colKey="cost" width={colWidth("positions", "cost", 112)} minWidth={78} />

                  <SortHead sk="marketValue" label="市值" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="marketValue" width={colWidth("positions", "marketValue", 112)} minWidth={78} />

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    未确认
                    <ResizeGrip table="positions" colKey="pending" width={colWidth("positions", "pending", 78)} minWidth={58} />
                  </th>

                  <SortHead sk="floatingPnL" label="浮盈" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="floatingPnL" width={colWidth("positions", "floatingPnL", 104)} minWidth={76} />

                  <SortHead sk="floatingPnLRate" label="浮盈率" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="floatingRate" width={colWidth("positions", "floatingRate", 84)} minWidth={64} />

                  <SortHead sk="historicalProfit" label="历史收益" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="historical" width={colWidth("positions", "historical", 108)} minWidth={78} />

                  <th className="relative select-none text-center text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    操作
                    <ResizeGrip table="positions" colKey="actions" width={colWidth("positions", "actions", 112)} minWidth={88} />
                  </th>

                </tr>

              </thead>

              <tbody className="text-sm">

                {sortedPositions.length === 0 ? (

                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={11}>暂无持仓数据</td></tr>

                ) : sortedPositions.map((p: any) => {

                  const active = p.fundCode === fundCode;

                  const adj = adjustedNavByCode[p.fundCode];

                  const displayNav = adj ? adj.nav : p.nav;

                  const displayNavDate = adj ? adj.date : p.navDate;

                  const displayMV = adj && p.units > 0 ? p.units * adj.nav : p.marketValue;

                  const displayPnL = adj ? displayMV - p.cost : p.floatingPnL;

                  const displayPnLRate = p.cost > 0 ? (displayPnL / p.cost) * 100 : 0;

                  return (

                    <tr

                      key={p.fundCode}

                      onClick={() => switchFund(p.fundCode)}

                      className={`cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`}

                    >

                      <td className="px-4 py-2 border-b border-slate-100"><span className={`block truncate text-xs font-medium ${active ? "text-blue-700" : "text-slate-700"}`} title={`${p.name} ${p.fundCode}`}>{p.name}{p.fundCode !== p.name && <span className={`ml-1 ${pnl(displayPnL)}`}>{p.fundCode}</span>}</span></td>

                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatFundUnits(p.units)}</td>

                      <td className="px-2 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{p.avgCost.toFixed(4)}</td>

                      <td className="overflow-hidden px-2 py-2 border-b border-slate-100 text-right text-xs tabular-nums">

                        <div className="flex min-w-0 items-center justify-end gap-0.5">

                          <span className="min-w-0 truncate">{displayNav != null ? displayNav.toFixed(4) : "-"}{displayNavDate ? <span className="ml-0.5 text-slate-400">({displayNavDate})</span> : null}</span>

                        </div>

                      </td>

                      <td className="px-2 py-2 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(p.cost)}</td>

                      <td className={`px-2 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayMV)}`}>{formatMoney(displayMV)}</td>

                      <td className="px-2 py-2 border-b border-slate-100 text-right text-[11px] tabular-nums">{p.pendingCost > 0 ? <span className="text-amber-600 font-medium">{formatMoney(p.pendingCost)}</span> : <span className="text-slate-300">-</span>}</td>

                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayPnL)}`}>{formatMoney(displayPnL)}</td>

                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayPnLRate)}`}>{displayPnLRate.toFixed(2)}%</td>

                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(p.historicalProfit)}`}>{formatMoney(p.historicalProfit)}</td>

                      <td className="px-2 py-2 border-b border-slate-100" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {regularPlanByFundCode.get(p.fundCode) ? (
                            <button
                              type="button"
                              onClick={() => setEditingRegularPlan(regularPlanByFundCode.get(p.fundCode))}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100"
                              title="编辑定投计划"
                            >
                              <CalendarSync className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          <AddNavButton accountId={accountId} positions={[p]} defaultFundCode={p.fundCode} trigger="icon" />
                        </div>
                      </td>

                    </tr>

                  );

                })}

              </tbody>

              {d.positions.length > 0 && (

                <tfoot className="sticky bottom-0 bg-slate-50/95 font-semibold backdrop-blur">

                  <tr>

                    <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={4}>汇总</td>

                    <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(d.totalCost)}</td>

                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(d.totalMarketValue)}`}>{formatMoney(d.totalMarketValue)}</td>

                    <td className="px-3 py-2 border-t border-slate-200"></td>

                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(d.totalMarketValue - d.totalCost)}`}>{formatMoney(d.totalMarketValue - d.totalCost)}</td>

                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(d.totalMarketValue - d.totalCost)}`}>{d.totalCost !== 0 ? `${(((d.totalMarketValue - d.totalCost) / d.totalCost) * 100).toFixed(2)}%` : "-"}</td>

                    <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(d.totalHistoricalProfit)}`}>{formatMoney(d.totalHistoricalProfit)}</td>

                    <td className="px-2 py-2 border-t border-slate-200"></td>

                  </tr>

                </tfoot>

              )}

            </table>

          ) : (

            <table
              className="min-w-[820px] table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200"
              style={{ width: clearedLayout.tableWidth }}
            >
              <colgroup>
                {CLEARED_COLS.map(([key, fallback]) => (
                  <col key={key} style={{ width: clearedLayout.colWidths[key] ?? colWidth("cleared", key, fallback) }} />
                ))}
              </colgroup>

              <thead className="sticky top-0 z-10 bg-white">

                <tr>

                  <SortHead sk="fundCode" label="基金名称" cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" sortType="cleared" table="cleared" colKey="fund" width={colWidth("cleared", "fund", 220)} minWidth={150} />

                  <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    初次购买
                    <ResizeGrip table="cleared" colKey="firstBuy" width={colWidth("cleared", "firstBuy", 108)} minWidth={78} />
                  </th>

                  <SortHead sk="clearedDate" label="清仓时间" cls="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" sortType="cleared" table="cleared" colKey="clearedDate" width={colWidth("cleared", "clearedDate", 108)} minWidth={78} />

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    申购金额
                    <ResizeGrip table="cleared" colKey="buyAmount" width={colWidth("cleared", "buyAmount", 112)} minWidth={82} />
                  </th>

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    回收金额
                    <ResizeGrip table="cleared" colKey="redeemAmount" width={colWidth("cleared", "redeemAmount", 112)} minWidth={82} />
                  </th>

                  <SortHead sk="historicalProfit" label="清仓收益" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" sortType="cleared" table="cleared" colKey="historical" width={colWidth("cleared", "historical", 112)} minWidth={82} />

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    收益率
                    <ResizeGrip table="cleared" colKey="returnRate" width={colWidth("cleared", "returnRate", 80)} minWidth={62} />
                  </th>

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

                    className={`cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`}

                    >

                      <td className="px-4 py-2 border-b border-slate-100"><span className={`block truncate text-xs font-medium ${active ? "text-blue-700" : "text-slate-700"}`} title={`${c.name} ${c.fundCode}`}>{c.name}<span className="ml-1 text-slate-400">{c.fundCode}</span></span></td>

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

                const totalReturnRate = totalBuyAmt > 0 ? (d.totalHistoricalProfit / totalBuyAmt) : 0;

                return (

                  <tfoot className="sticky bottom-0 bg-slate-50/95 font-semibold backdrop-blur">

                    <tr>

                      <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={3}>汇总</td>

                      <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalBuyAmt)}</td>

                      <td className="px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums text-slate-800">{formatMoney(totalRedeemAmt)}</td>

                      <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(d.totalHistoricalProfit)}`}>{formatMoney(d.totalHistoricalProfit)}</td>

                      <td className={`px-3 py-2 border-t border-slate-200 text-right text-xs tabular-nums ${pnl(totalReturnRate)}`}>{totalBuyAmt > 0 ? `${(totalReturnRate * 100).toFixed(2)}%` : "-"}</td>

                    </tr>

                  </tfoot>

                );

              })()}

            </table>

          )}

        </div>

      </div>

      {editingRegularPlan ? (
        <RegularInvestForm
          mode="edit"
          editData={{
            id: editingRegularPlan.id,
            accountId: editingRegularPlan.accountId,
            fundCode: editingRegularPlan.fundCode,
            fundName: editingRegularPlan.fundName,
            amount: Number(editingRegularPlan.amount ?? 0),
            intervalUnit: editingRegularPlan.intervalUnit,
            intervalValue: Number(editingRegularPlan.intervalValue ?? 1),
            executionDay: editingRegularPlan.executionDay ?? null,
            startDate: String(editingRegularPlan.startDate ?? "").slice(0, 10),
            endDate: editingRegularPlan.endDate ? String(editingRegularPlan.endDate).slice(0, 10) : null,
            totalRuns: editingRegularPlan.totalRuns ?? null,
            cashAccountId: editingRegularPlan.cashAccountId ?? null,
            feeRate: editingRegularPlan.feeRate ?? null,
            confirmDays: editingRegularPlan.confirmDays ?? null,
            arrivalDays: editingRegularPlan.arrivalDays ?? null,
            skipPendingPreceding: editingRegularPlan.skipPendingPreceding ?? true,
          }}
          accountId={editingRegularPlan.accountId}
          accountLabel={editingRegularPlan.accountName ?? ""}
          editAccountLabel={editingRegularPlan.accountName ?? ""}
          cashAccounts={cashAccounts}
          cashAccountSSOptions={cashAccountSSOptions}
          investmentAccountSSOptions={investmentAccountSSOptions}
          nestedFieldData={nestedFieldData}
          showTriggerButton={false}
          open={true}
          onOpenChange={(open) => {
            if (!open) setEditingRegularPlan(null);
          }}
          action={regularInvestFormAction}
          submitMethod="serverAction"
          onSuccess={() => setEditingRegularPlan(null)}
        />
      ) : null}



      {/* 交易明细 */}

      <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">

        <div className="panel-header shrink-0">

          <div className="text-sm font-semibold text-slate-800">

            交易明细{fundCode && <span className={`ml-2 text-xs font-normal ${selectedFundCodeCls}`}>{fundCode}</span>}

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

                <div className="absolute right-0 top-7 z-50 min-w-[160px] rounded-lg border border-slate-200 bg-white py-1 shadow-soft">

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

            <button onClick={() => { setFundPageSize(allFundPageSize); setFundPage(1); }} className={`h-6 px-1.5 rounded border ${fundPageSize === allFundPageSize ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>所有</button>

            <span className="text-slate-300">|</span>

            {safePage > 1 ? (<>

              <button onClick={() => setFundPage(1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsLeft className="h-3 w-3"/></button>

              <button onClick={() => setFundPage(safePage - 1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronLeft className="h-3 w-3"/></button>

            </>) : (<>

              <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronsLeft className="h-3 w-3"/></span>

              <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronLeft className="h-3 w-3"/></span>

            </>)}

            <span className="text-slate-500 px-0.5">{safePage}/{totalPages}</span>

            {safePage < totalPages ? (<>

              <button onClick={() => setFundPage(safePage + 1)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"><ChevronRight className="h-3 w-3"/></button>

              <button onClick={() => setFundPage(totalPages)} className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"><ChevronsRight className="h-3 w-3"/></button>

            </>) : (<>

              <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronRight className="h-3 w-3"/></span>

              <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronsRight className="h-3 w-3"/></span>

            </>)}

          </div>

        </div>

        <div ref={detailTableViewportRef} className="flex-1 min-h-0 overflow-auto">

          <table
            className="min-w-[1100px] table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200"
            style={{ width: detailLayout.tableWidth }}
          >
            <colgroup>
              {DETAIL_COLS.map(([key, fallback]) => (
                <col key={key} style={{ width: detailLayout.colWidths[key] ?? colWidth("details", key, fallback) }} />
              ))}
            </colgroup>

            <thead className="sticky top-0 z-10 bg-white">

              <tr>

                <th className="relative select-none align-middle text-left text-xs font-semibold text-slate-600 px-2 py-1 border-b border-slate-200">

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

                  <ResizeGrip table="details" colKey="select" width={colWidth("details", "select", 44)} minWidth={36} />

                </th>

                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200">

                  <div className="relative inline-flex items-center gap-1" ref={dateFilterRef}>

                    <span>申请日期</span>

                    <button

                      type="button"

                      onClick={(e) => { e.stopPropagation(); setDateFilterOpen((v) => !v); }}

                      className={`h-5 w-4 text-[10px] leading-none ${(dateFrom || dateTo) ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}

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

                  <ResizeGrip table="details" colKey="date" width={colWidth("details", "date", 92)} minWidth={76} />

                </th>

                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  到账日期
                  <ResizeGrip table="details" colKey="arrivalDate" width={colWidth("details", "arrivalDate", 92)} minWidth={76} />
                </th>

                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {renderColumnFilter("cashAccount", "资金账户")}
                  <ResizeGrip table="details" colKey="cashAccount" width={colWidth("details", "cashAccount", 132)} minWidth={92} />
                </th>

                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  基金
                  <ResizeGrip table="details" colKey="fund" width={colWidth("details", "fund", 156)} minWidth={110} />
                </th>

                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  净值
                  <ResizeGrip table="details" colKey="nav" width={colWidth("details", "nav", 86)} minWidth={76} />
                </th>

                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  份额
                  <ResizeGrip table="details" colKey="units" width={colWidth("details", "units", 84)} minWidth={64} />
                </th>

                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {renderColumnFilter("subtype", "交易类型")}
                  <ResizeGrip table="details" colKey="subtype" width={colWidth("details", "subtype", 88)} minWidth={72} />
                </th>

                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                  金额
                  <ResizeGrip table="details" colKey="amount" width={colWidth("details", "amount", 76)} minWidth={58} />
                </th>

                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                  收益
                  <ResizeGrip table="details" colKey="profit" width={colWidth("details", "profit", 76)} minWidth={58} />
                </th>

                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {renderColumnFilter("status", "状态")}
                  <ResizeGrip table="details" colKey="status" width={colWidth("details", "status", 72)} minWidth={58} />
                </th>

                <th className="relative select-none align-middle text-right text-xs font-semibold text-slate-600 px-2 py-1 border-b border-slate-200">

                  <div className="flex h-7 min-w-[92px] flex-nowrap items-center justify-end gap-1">

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

                  <ResizeGrip table="details" colKey="actions" width={colWidth("details", "actions", 112)} minWidth={92} />

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

                    className={`cursor-pointer ${selected ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`}

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

                      {e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : <span className="text-slate-300">-</span>}

                    </td>

                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-500">

                      {(() => {

                        const info = cashAccountInfoOf(e);

                        if (!info || info.label === "(空)") return <span className="text-slate-300">-</span>;

                        return (

                          <div className="min-w-0">

                            <div className="truncate text-slate-600" title={info.label}>{info.label}</div>

                          </div>

                        );

                      })()}

                    </td>

                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-700">
                      <div className="truncate" title={`${displayFundName(e)} ${e.fundCode || ""}`}>
                        {displayFundName(e)}{e.fundCode && displayFundName(e) !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}
                      </div>
                    </td>

                    <td className="overflow-hidden whitespace-nowrap px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{nav != null ? nav.toFixed(4) : <span className="text-slate-400">-</span>}</td>

                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{units != null ? formatFundUnits(units) : <span className="text-slate-400">-</span>}</td>

                    <td className="px-3 py-1 border-b border-slate-100 text-xs"><span className={`px-1 py-0.5 rounded text-[10px] font-medium ${e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls}`}>{info.label}</span></td>

                    <td className="px-2 py-1 border-b border-slate-100 text-right text-xs tabular-nums text-slate-700">

                      {(() => {

                        const absAmt = formatMoney(Math.abs(amount));

                        if (e.source === "dividend" || e.fundSubtype === "dividend_cash") return <span className={`font-medium ${upCls}`}>+{absAmt}</span>;

                        return absAmt;

                      })()}

                    </td>

                    <td className={`px-2 py-1 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(toNumber(e.realizedProfit))}`}>

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

                    <td className="w-[112px] align-middle px-2 py-1 border-b border-slate-100">

                      <div className="flex h-7 min-w-[92px] flex-nowrap items-center justify-end gap-1" onClick={(ev) => ev.stopPropagation()}>

                        {e.fundCode && e.fundSubtype === "buy" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} onFilled={(data) => handleEntryNavFilled(e, data)} /> : null}

                        {e.fundProductType === "wealth" ? (

                          <WealthFormModal

                            mode="edit"

                            accountId={selectedAccount?.id ?? ""}

                            entry={{

                              id: e.id, transactionId: e.id,

                              date: fmtDate(e.date),

                              amount: toNumber(e.amount), note: e.note ?? null,

                              fundName: displayFundName(e) === "-" ? null : displayFundName(e),

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

                              fundName: displayFundName(e) === "-" ? null : displayFundName(e),

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

                              fundCode: e.fundCode ?? null, fundName: displayFundName(e) === "-" ? (e.fundCode ?? null) : displayFundName(e),

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

                              confirmDays: d.confirmDaysMap[e.fundCode ?? ""] ?? selectedAccount?.defaultConfirmDays ?? undefined,

                              feeRate: d.feeRateMap[`${e.fundCode ?? ""}:${e.fundSubtype === "redeem" ? "redeem" : "buy"}`] ?? null,

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

              }) : (<tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={12}>暂无交易记录</td></tr>)}

            </tbody>

          </table>

        </div>

      </div>

    </div>

  );

}



