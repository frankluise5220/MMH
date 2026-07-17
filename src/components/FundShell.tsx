"use client";



import { useState, useMemo, useRef, useEffect, useCallback, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

import { useRouter } from "next/navigation";

import Link from "next/link";

import { startTransition } from "react";

import { formatMoney } from "@/lib/format";

import { toNumber } from "@/lib/date-utils";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

import { CalendarSync, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Pause, Play, SlidersHorizontal, Trash2, Upload } from "lucide-react";

import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { allocateBuyFailedRefunds, findLinkedEntries, getEffectiveBuyUnitsByRefunds, type RefundLinkableEntry } from "@/lib/fund/refund-link";

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

function LinkHeaderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mx-auto h-3.5 w-3.5">
      <path
        d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function LinkStatusIcon({ active, title }: { active: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={[
        "inline-flex h-4 w-4 items-center justify-center rounded-full border",
        active
          ? "border-sky-300 bg-sky-100 text-sky-700 shadow-[0_0_0_2px_rgba(14,165,233,0.08)]"
          : "border-slate-200 bg-transparent text-slate-300",
      ].join(" ")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-2.5 w-2.5">
        <path
          d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    </span>
  );
}



type Props = any;

type FundTableKey = "positions" | "cleared" | "details";
type FundTableViewportKey = "summary" | "details";

const FUND_TABLE_WIDTHS_KEY = "mmh_fund_shell_column_widths_v1";
const FUND_DETAIL_HIDDEN_COLUMNS_KEY = "mmh_fund_shell_detail_hidden_columns_v1";
const FUND_HORIZONTAL_SCROLL_TOLERANCE_PX = 4;

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
  ["link", 38],
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

type DetailColumnKey = typeof DETAIL_COLS[number][0];

const FIXED_DETAIL_COLUMNS = new Set<DetailColumnKey>(["select", "actions"]);
const DETAIL_COLUMN_LABELS: Record<DetailColumnKey, string> = {
  select: "选择",
  link: "关联",
  date: "申请日期",
  arrivalDate: "到账日期",
  cashAccount: "资金账户",
  fund: "基金",
  nav: "净值",
  units: "份额",
  subtype: "交易类型",
  amount: "金额",
  profit: "收益",
  status: "状态",
  actions: "操作",
};

const FUND_COL_MIN_WIDTHS: Record<FundTableKey, Record<string, number>> = {
  positions: {
    fund: 160,
    units: 64,
    avgCost: 76,
    nav: 118,
    cost: 78,
    marketValue: 78,
    pending: 58,
    floatingPnL: 76,
    floatingRate: 64,
    historical: 78,
    actions: 88,
  },
  cleared: {},
  details: {
    nav: 76,
  },
};

function minFundColWidth(table: FundTableKey, key: string) {
  return FUND_COL_MIN_WIDTHS[table]?.[key] ?? 44;
}

function minFundTableWidth(table: FundTableKey, cols: readonly (readonly [string, number])[]) {
  return cols.reduce((sum, [key]) => sum + minFundColWidth(table, key), 0);
}



export function FundShell(props: Props) {

  const router = useRouter();

  const {

    view, initialFundCode, positions, clearedPositions, allEntries,

    totalMarketValue, totalCost, totalHistoricalProfit,

    confirmDaysMap, feeRateMap, initialShowCleared, baseQuery,

    accountId, selectedAccount, selectedAccountLabel, accountOptions,

    cashAccounts, investmentAccounts, cashAccountSSOptions, investmentAccountSSOptions, metalTypes, metalUnits, nestedFieldData, createAction, editAction,

    fillNavAction, regularInvestFormAction, lastUsedCashAccount, isRedUp,
    fundUnitsDecimals: fundUnitsDecimalsProp,

  } = props;

  const fundUnitsDecimals = Number.isFinite(Number(fundUnitsDecimalsProp)) ? Math.min(Math.max(Math.round(Number(fundUnitsDecimalsProp)), 0), 6) : 2;

  const formatFundUnits = (value: number) => value.toFixed(fundUnitsDecimals);
  const accountProductType = selectedAccount?.investProductType ?? null;
  const isMetalAccount = accountProductType === "metal";
  const isWealthAccount = accountProductType === "wealth";
  const assetNameLabel = isMetalAccount ? "品种" : isWealthAccount ? "理财产品" : "基金";
  const holdingTabLabel = isMetalAccount ? "持仓贵金属" : isWealthAccount ? "持仓理财" : "持仓基金";
  const clearedTabLabel = isWealthAccount ? "已赎回理财" : "清仓基金";
  const noClearedText = isWealthAccount ? "暂无已赎回理财" : "暂无清仓基金";
  const chooseHoldingText = `请先选择上方${isWealthAccount ? "理财持仓" : "基金持仓"}`;
  const investmentAccountLabel = isWealthAccount ? "理财账户" : "基金账户";
  const detailNameLabel = isWealthAccount ? "理财产品" : "基金";
  const navColumnLabel = isMetalAccount ? "单价" : isWealthAccount ? "净值/估值" : "净值";
  const entryAssetKey = useCallback((entry: any) => String(isMetalAccount ? entry?.metalTypeId ?? "" : entry?.fundCode ?? "").trim(), [isMetalAccount]);



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
  const [regularPlanMenu, setRegularPlanMenu] = useState<any | null>(null);
  const [regularPlanActionBusy, setRegularPlanActionBusy] = useState(false);
  const [regularPlanBusyId, setRegularPlanBusyId] = useState<string | null>(null);
  const [positionEntryDefaults, setPositionEntryDefaults] = useState<any | null>(null);
  const [positionEntryOpenSignal, setPositionEntryOpenSignal] = useState(0);
  const [detailEditSignal, setDetailEditSignal] = useState<{ id: string; value: number } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, Record<string, number>>>({});
  const summaryTableViewportRef = useRef<HTMLDivElement>(null);
  const detailTableViewportRef = useRef<HTMLDivElement>(null);
  const detailColumnMenuRef = useRef<HTMLDivElement>(null);
  const [tableViewportWidths, setTableViewportWidths] = useState<Record<FundTableViewportKey, number>>({
    summary: 0,
    details: 0,
  });
  const [needsDetailHorizontalScroll, setNeedsDetailHorizontalScroll] = useState(false);
  const [detailColumnMenuOpen, setDetailColumnMenuOpen] = useState(false);
  const [hiddenDetailColumns, setHiddenDetailColumns] = useState<Set<DetailColumnKey>>(new Set());

  // Shadow props with reactive local state
  const d = localData;
  const refundLinkAllocation = useMemo(() => {
    return allocateBuyFailedRefunds((d.allEntries || []).map((entry: any) => ({
      id: String(entry.id ?? ""),
      date: entry.date,
      createdAt: entry.createdAt,
      fundConfirmDate: entry.fundConfirmDate,
      fundArrivalDate: entry.fundArrivalDate,
      accountId: entry.accountId ?? null,
      toAccountId: entry.toAccountId ?? null,
      fundCode: entryAssetKey(entry),
      fundSubtype: entry.fundSubtype ?? null,
      source: entry.source ?? null,
      fundSourceEntryId: entry.fundSourceEntryId ?? null,
      amount: toNumber(entry.amount),
    })));
  }, [d.allEntries, entryAssetKey, isMetalAccount]);
  const refundAmountByBuyId = refundLinkAllocation.refundAmountByBuyId;
  const displayUnitsOfPlain = useCallback((entry: any) => {
    if (isMetalAccount) return entry.metalQuantity != null ? toNumber(entry.metalQuantity) : null;
    const storedUnits = entry.fundUnits != null ? toNumber(entry.fundUnits) : null;
    if (entry.fundSubtype === "buy" && storedUnits != null) {
      return getEffectiveBuyUnitsByRefunds(
        { id: String(entry.id ?? ""), amount: toNumber(entry.amount), fundUnits: storedUnits },
        refundAmountByBuyId,
      );
    }
    return storedUnits;
  }, [isMetalAccount, refundAmountByBuyId]);
  const displayUnitsOf = displayUnitsOfPlain;
  const linkedCandidateEntries = useMemo(() => {
    return (d.allEntries || []).map((entry: any) => ({
      id: String(entry.id ?? ""),
      date: fmtDate(entry.date),
      createdAt: entry.createdAt,
      fundConfirmDate: fmtDate(entry.fundConfirmDate),
      fundArrivalDate: fmtDate(entry.fundArrivalDate),
      accountId: entry.accountId ?? null,
      toAccountId: entry.toAccountId ?? null,
      fundCode: entryAssetKey(entry),
      fundSubtype: entry.fundSubtype ?? null,
      fundUnits: displayUnitsOfPlain(entry),
      source: entry.source ?? null,
      fundSourceEntryId: entry.fundSourceEntryId ?? null,
      amount: toNumber(entry.amount),
    }));
  }, [d.allEntries, entryAssetKey, displayUnitsOfPlain]);





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

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FUND_DETAIL_HIDDEN_COLUMNS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return;
      const allowed = new Set(DETAIL_COLS.map(([key]) => key).filter((key) => !FIXED_DETAIL_COLUMNS.has(key)));
      setHiddenDetailColumns(new Set(saved.filter((key): key is DetailColumnKey => allowed.has(key))));
    } catch {}
  }, []);

  useEffect(() => {
    if (!detailColumnMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = detailColumnMenuRef.current;
      if (!node || !(event.target instanceof Node) || node.contains(event.target)) return;
      setDetailColumnMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [detailColumnMenuOpen]);

  const colWidth = useCallback((table: FundTableKey, key: string, fallback: number) => {
    const width = columnWidths[table]?.[key];
    const minWidth = minFundColWidth(table, key);
    return Math.max(minWidth, Number.isFinite(width) ? Number(width) : fallback);
  }, [columnWidths]);

  const visibleDetailCols = useMemo(
    () => DETAIL_COLS.filter(([key]) => !hiddenDetailColumns.has(key)),
    [hiddenDetailColumns],
  );
  const visibleOptionalDetailColumnCount = visibleDetailCols.filter(([key]) => !FIXED_DETAIL_COLUMNS.has(key)).length;
  const detailMinTableWidth = useMemo(
    () => Math.min(1100, visibleDetailCols.reduce((sum, [, fallback]) => sum + fallback, 0)),
    [visibleDetailCols],
  );
  const isDetailColumnVisible = useCallback(
    (key: DetailColumnKey) => !hiddenDetailColumns.has(key),
    [hiddenDetailColumns],
  );

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
    const viewport = viewportWidth || 0;
    const targetWidth = Math.max(minTableWidth, viewport);
    const scale = baseTotal > 0 && baseTotal < targetWidth ? targetWidth / baseTotal : 1;
    const compressScale = baseTotal > 0 && baseTotal > targetWidth ? targetWidth / baseTotal : 1;
    const colWidths = Object.fromEntries(baseWidths.map(([key, width]) => [
      key,
      Math.max(minFundColWidth(table, key), width * Math.min(scale, compressScale)),
    ]));

    return { tableWidth: targetWidth, colWidths };
  }, [colWidth]);

  const positionLayout = useMemo(
    () => tableLayout("positions", POSITION_COLS, minFundTableWidth("positions", POSITION_COLS), tableViewportWidths.summary),
    [tableLayout, tableViewportWidths.summary],
  );
  const clearedLayout = useMemo(
    () => tableLayout("cleared", CLEARED_COLS, 820, tableViewportWidths.summary),
    [tableLayout, tableViewportWidths.summary],
  );
  const detailLayout = useMemo(
    () => tableLayout("details", visibleDetailCols, detailMinTableWidth, tableViewportWidths.details),
    [detailMinTableWidth, tableLayout, tableViewportWidths.details, visibleDetailCols],
  );

  useEffect(() => {
    const node = detailTableViewportRef.current;
    if (!node) return;
    const update = () => setNeedsDetailHorizontalScroll(node.scrollWidth > node.clientWidth + FUND_HORIZONTAL_SCROLL_TOLERANCE_PX);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const table = node.querySelector("table");
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [detailLayout.tableWidth, visibleDetailCols]);

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

  const toggleDetailColumnVisibility = useCallback((key: DetailColumnKey) => {
    if (FIXED_DETAIL_COLUMNS.has(key)) return;
    setHiddenDetailColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        const visibleOptionalCount = DETAIL_COLS.filter(([colKey]) => !FIXED_DETAIL_COLUMNS.has(colKey) && !next.has(colKey)).length;
        if (visibleOptionalCount <= 1) return prev;
        next.add(key);
      }
      try {
        window.localStorage.setItem(FUND_DETAIL_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(next)));
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
    if (isMetalAccount) {
      const typeName = String(entry?.metalTypeName ?? "").trim();
      const unitName = String(entry?.metalUnitName ?? "").trim();
      return [typeName, unitName].filter(Boolean).join(" · ") || String(entry?.metalTypeId ?? "").trim() || "-";
    }
    const code = String(entry?.fundCode ?? "").trim();
    const fetched = code ? fetchedFundNames[code] : "";
    if (fetched && !isGenericFundName(fetched, code)) return fetched;
    const mapped = code ? fundNameByCode.get(code) : "";
    if (mapped && !isGenericFundName(mapped, code)) return mapped;
    const stored = String(entry?.fundName ?? "").trim();
    if (stored && !isGenericFundName(stored, code)) return stored;
    return code || "-";
  }, [fetchedFundNames, fundNameByCode, isMetalAccount]);

  const entryBusinessLinkInfo = useCallback((entry: any) => {
    const countFromSummary = Number(entry?.businessLinkCount ?? 0);
    const cashLinks = Array.isArray(entry?.EntryBusinessLinkCash) ? entry.EntryBusinessLinkCash : [];
    const businessLinks = Array.isArray(entry?.EntryBusinessLinkBusiness) ? entry.EntryBusinessLinkBusiness : [];
    const fundLinks = Array.isArray(entry?.EntryBusinessLink) ? entry.EntryBusinessLink : [];
    const count = countFromSummary || cashLinks.length + businessLinks.length + fundLinks.length;
    const labels = Array.isArray(entry?.businessLinkLabels) ? entry.businessLinkLabels.filter(Boolean) : [];
    return { active: count > 0, labels };
  }, []);



  function exportCSV(scope?: "current" | "all") {

    const rows = (scope === "current" ? filtered : (allEntries || [])) as any[];

    const label = scope === "current" ? fundCode || "current" : "all";

    const header = ["申请日期", "确认日期", "到账日期", "资金账户", `${detailNameLabel}代码`, `${detailNameLabel}名称`, navColumnLabel, isWealthAccount ? "份额/本金" : "份额", "交易类型", "金额", "收益", "状态"];

    const accountLabelByIdLocal = new Map<string, string>();

    for (const a of accountOptions as any[]) {

      if (a?.id) accountLabelByIdLocal.set(String(a.id), String(a.label ?? ""));

    }

    const parts: string[] = [];

    parts.push(header.join(","));

    parts.push("\n");



    for (const e of rows) {

      const nav = e.fundNav != null ? e.fundNav : "";

      const units = displayUnitsOf(e) != null ? displayUnitsOf(e) : "";

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

        : (displayUnitsOf(e) != null && Number(displayUnitsOf(e)) > 0) ? fmtDate(e.fundConfirmDate) : "待确认";

      const status = isBuyFailed
        ? (e.source === "regular_invest_refund" ? "买入退回" : "暂停申购")
        : (e.fundSubtype === "buy" && (refundAmountByBuyId.get(String(e.id ?? "")) ?? 0) > 0) ? "部分确认" : (e.fundUnits == null || Number(e.fundUnits) === 0) ? "待确认" : "确认";



      parts.push([

        fundApplyDateOf(e),

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

    const nextCode = isWealthAccount ? "" : on && d.clearedPositions.length > 0 ? d.clearedPositions[0].fundCode : d.positions.length > 0 ? d.positions[0].fundCode : "";

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

  function openPositionEntryModal(position: any) {
    const code = String(position?.fundCode ?? "").trim();
    if (!code) return;
    setPositionEntryDefaults({
      fundCode: code,
      fundName: String(position?.name ?? code),
      fundUnits: position?.units != null ? toNumber(position.units) : null,
      confirmDays: d.confirmDaysMap[code] ?? selectedAccount?.defaultConfirmDays ?? undefined,
      feeRate: d.feeRateMap[`${code}:buy`] ?? null,
    });
    setPositionEntryOpenSignal((value) => value + 1);
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







  const fundApplyDateOf = useCallback((entry: any) => {
    if (entry?.fundSubtype === "buy_failed" && entry?.source === "regular_invest_refund") {
      const linkedBuyId = String(entry.fundSourceEntryId ?? "").trim()
        || Array.from(refundLinkAllocation.buyIdsByRefundId.get(String(entry?.id ?? "")) ?? [])[0]
        || "";
      if (linkedBuyId) {
        const linkedBuy = (d.allEntries || []).find((item: any) => String(item?.id ?? "") === linkedBuyId);
        const linkedDate = fmtDate(linkedBuy?.date);
        if (linkedDate) return linkedDate;
      }
    }
    return fmtDate(entry?.date);
  }, [d.allEntries, refundLinkAllocation]);

  const filtered = useMemo(() => {
    const source = fundCode
      ? d.allEntries.filter((e: any) => entryAssetKey(e) === fundCode)
      : d.allEntries ?? [];
    return [...source]
      .sort((a: any, b: any) => {
        const byApplyDate = fundApplyDateOf(b).localeCompare(fundApplyDateOf(a));
        if (byApplyDate !== 0) return byApplyDate;
        const byCreatedAt = fmtDate(b.createdAt).localeCompare(fmtDate(a.createdAt));
        if (byCreatedAt !== 0) return byCreatedAt;
        return String(b.id ?? "").localeCompare(String(a.id ?? ""));
      });
  }, [d.allEntries, entryAssetKey, fundApplyDateOf, fundCode]);
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

  const createRegularPlanViaApi = useCallback(async (payload: any) => {
    const res = await fetch("/api/v1/regular-invest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.error || `保存失败(${res.status})` };
    }
    await loadRegularPlans();
    window.dispatchEvent(new Event("mmh:fund:refresh"));
    return { ok: true };
  }, [loadRegularPlans]);

  const updateRegularPlanStatus = useCallback(async (plan: any, action: "pause" | "resume" | "stop") => {
    if (!plan?.id || regularPlanActionBusy) return;
    const actionLabel = action === "pause" ? "暂停" : action === "resume" ? "恢复" : "停止";
    if (action === "stop" && !window.confirm(`确认停止 ${plan.fundCode} 的定投计划吗？`)) return;
    setRegularPlanActionBusy(true);
    setRegularPlanBusyId(String(plan.id));
    try {
      const res = await fetch("/api/v1/regular-invest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: plan.id, action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        window.alert(data?.error || `${actionLabel}失败`);
        return;
      }
      setRegularPlanMenu(null);
      await loadRegularPlans();
      dispatchFinanceDataChanged({ reason: "regular-invest-plan-status" });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : `${actionLabel}失败`);
    } finally {
      setRegularPlanActionBusy(false);
      setRegularPlanBusyId(null);
    }
  }, [loadRegularPlans, regularPlanActionBusy]);

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



    if (isWealthAccount) {
      if (fundCode && !available.includes(fundCode)) {
        setFundCode("");
        setFundPage(1);
        q.delete("fundCode");
        window.history.replaceState(null, "", `/?${q.toString()}`);
      }
      return;
    }

    if (!fundCode || !available.includes(fundCode)) {

      const next = available[0]!;

      setFundCode(next);

      setFundPage(1);

      q.set("fundCode", next);

      window.history.replaceState(null, "", `/?${q.toString()}`);

    }

  }, [baseQuery, view, showCleared, fundCode, sortedPositions, sortedClearedPositions, isWealthAccount]);



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
    if (e.fundSubtype === "buy_failed") return e.source === "regular_invest_refund" ? "买入退回" : "暂停申购";
    if (e.fundSubtype === "buy") {
      if ((refundAmountByBuyId.get(String(e.id ?? "")) ?? 0) > 0) {
        const units = displayUnitsOf(e);
        return units != null && units > 0 ? "部分确认" : "待确认";
      }
    }
    const units = displayUnitsOf(e);
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

      const applyDate = fundApplyDateOf(e);

      if (!inDateRange(applyDate, dateFrom, dateTo)) return false;

      return filterColumns.every((column) => {

        const allowedValues = columnFilters[column];

        const v = getFilterColumnValue(e, column);

        return !allowedValues?.length || allowedValues.includes(v);

      });

    });

  }, [filtered, columnFilters, accountOptions, dateFrom, dateTo, fundApplyDateOf]);



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

      label: investmentAccountLabel,

      kind: "select",

      options: [{ value: "", label: "选择账户" }, ...investmentAccounts.map((a: any) => ({ value: a.id, label: a.label }))],

    },

    { value: "amount", label: "金额", kind: "number", placeholder: "如 100、*2、+10、-5、/2" },

    { value: "fundConfirmDate", label: "确认日期", kind: "date", allowEmpty: true },

    { value: "fundArrivalDate", label: "到账日期", kind: "date", allowEmpty: true },

    { value: "remark", label: "备注", kind: "text", placeholder: "输入替换内容，可留空清除备注", allowEmpty: true },

  ], [cashAccounts, investmentAccountLabel, investmentAccounts]);



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

    setBatchDeleting(true);

    setBatchDeleteMessage("");

    try {

      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: ids,
        confirmMessage: `确认删除已勾选 ${ids.length} 条${isWealthAccount ? "理财" : "基金"}明细？删除后会进入回收站。`,
      });

      if (!data.ok) {

        if (data.error === "已取消删除") return;
        setBatchDeleteMessage(data.error ?? "批量删除失败");

        return;

      }

      setBatchDeleteMessage(data.message ?? `已删除 ${ids.length} 条记录`);

      setSelectedIds((prev) => {

        const next = new Set(prev);

        ids.forEach((id) => next.delete(id));

        return next;

      });

      const refreshEntryIds = getDeleteRefreshEntryIds(data, ids);
      dispatchFinanceDataChanged({ reason: "entry-batch-delete", deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });

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
            <InvestmentFormModal
              mode="create"
              accountId={accountId}
              accountProductType={selectedAccount?.investProductType ?? null}
              defaults={positionEntryDefaults ?? undefined}
              cashAccounts={cashAccounts}
              investmentAccounts={investmentAccounts}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              holdings={d.positions.map((p: any) => ({ fundCode: p.fundCode, name: p.name, units: p.units }))}
              allEntries={d.allEntries.map((e: any) => ({ id: e.id, date: fmtDate(e.date), createdAt: e.createdAt, fundConfirmDate: fmtDate(e.fundConfirmDate), fundArrivalDate: fmtDate(e.fundArrivalDate), fundSourceEntryId: e.fundSourceEntryId ?? null, fundCode: entryAssetKey(e), fundSubtype: e.fundSubtype, fundUnits: displayUnitsOf(e), source: e.source ?? null, accountId: e.accountId ?? null, toAccountId: e.toAccountId ?? null, amount: toNumber(e.amount) }))}
              createAction={createAction}
              openSignal={positionEntryOpenSignal}
              hideTrigger
              fundUnitsDecimals={fundUnitsDecimals}
            />

            <div className="flex items-center gap-0.5">

              <button onClick={() => toggleCleared(false)} className={`h-6 px-2 rounded text-xs ${!showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{holdingTabLabel}</button>

              {!isMetalAccount ? <button onClick={() => toggleCleared(true)} className={`h-6 px-2 rounded text-xs ${showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{clearedTabLabel}</button> : null}

            </div>

          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 min-h-[24px]">

            {!showCleared ? (<>

              {!isMetalAccount && !isWealthAccount && d.positions.length > 0 && <RefreshNavButton accountId={accountId} symbols={d.positions.map((p: any) => p.fundCode).filter(Boolean)} />}

            </>) : null}

          </div>

        </div>

        <div ref={summaryTableViewportRef} className="flex-1 min-h-0 overflow-x-auto overflow-y-auto">

          {!showCleared ? (

            <table
              className="table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200"
              style={{ minWidth: minFundTableWidth("positions", POSITION_COLS), width: positionLayout.tableWidth }}
            >
              <colgroup>
                {POSITION_COLS.map(([key, fallback]) => (
                  <col key={key} style={{ width: positionLayout.colWidths[key] ?? colWidth("positions", key, fallback) }} />
                ))}
              </colgroup>

              <thead className="sticky top-0 z-10 bg-white">

                <tr>

                  <SortHead sk="fundCode" label={assetNameLabel} cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" table="positions" colKey="fund" width={colWidth("positions", "fund", 260)} minWidth={160} />

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    {isMetalAccount ? "数量" : isWealthAccount ? "份额/本金" : "份额"}
                    <ResizeGrip table="positions" colKey="units" width={colWidth("positions", "units", 92)} minWidth={64} />
                  </th>

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    均价
                    <ResizeGrip table="positions" colKey="avgCost" width={colWidth("positions", "avgCost", 84)} minWidth={76} />
                  </th>

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    {navColumnLabel}
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
                      onDoubleClick={() => {
                        if (!isWealthAccount) openPositionEntryModal(p);
                      }}

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

                      <td className="px-2 py-2 border-b border-slate-100" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {regularPlanByFundCode.get(p.fundCode) ? (
                            (() => {
                              const plan = regularPlanByFundCode.get(p.fundCode);
                              const isPaused = plan.status === "paused";
                              const menuOpen = regularPlanMenu?.id === plan.id;
                              return (
                                <div className="relative">
                                  <button
                                    type="button"
                                    disabled={regularPlanBusyId === plan.id || (plan.status !== "active" && plan.status !== "paused")}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setRegularPlanMenu(menuOpen ? null : plan);
                                    }}
                                    className={`relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
                                      isPaused
                                        ? "border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100"
                                        : "border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100"
                                    }`}
                                    title={isPaused ? "当前已暂停，点击选择继续或编辑" : "当前执行中，点击选择暂停或编辑"}
                                    aria-haspopup="menu"
                                    aria-expanded={menuOpen}
                                  >
                                    <CalendarSync className="h-3.5 w-3.5" />
                                    {isPaused ? (
                                      <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex h-2 w-2 items-center justify-center rounded-full bg-amber-500 ring-1 ring-white">
                                        <span className="h-1 w-[1px] rounded-full bg-white" />
                                        <span className="ml-[1px] h-1 w-[1px] rounded-full bg-white" />
                                      </span>
                                    ) : (
                                      <span aria-hidden="true" className="absolute right-0.5 top-0.5 flex h-2 w-2 items-center justify-center rounded-full bg-emerald-500 ring-1 ring-white">
                                        <span className="ml-[1px] h-0 w-0 border-y-[2px] border-l-[3px] border-y-transparent border-l-white" />
                                      </span>
                                    )}
                                  </button>
                                  {menuOpen ? (
                                    <div
                                      className="absolute right-0 top-8 z-50 w-28 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-left shadow-lg"
                                      role="menu"
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      {plan.status === "active" ? (
                                        <button
                                          type="button"
                                          disabled={regularPlanActionBusy}
                                          onClick={() => updateRegularPlanStatus(plan, "pause")}
                                          className="flex h-8 w-full items-center gap-1.5 px-3 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                                          role="menuitem"
                                        >
                                          <Pause className="h-3.5 w-3.5" />暂停
                                        </button>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={regularPlanActionBusy}
                                          onClick={() => updateRegularPlanStatus(plan, "resume")}
                                          className="flex h-8 w-full items-center gap-1.5 px-3 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                                          role="menuitem"
                                        >
                                          <Play className="h-3.5 w-3.5" />继续
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setEditingRegularPlan(plan);
                                          setRegularPlanMenu(null);
                                        }}
                                        className="flex h-8 w-full items-center gap-1.5 px-3 text-xs text-blue-700 hover:bg-blue-50"
                                        role="menuitem"
                                      >
                                        <CalendarSync className="h-3.5 w-3.5" />编辑
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })()
                          ) : null}
                          {!isMetalAccount && !isWealthAccount ? <AddNavButton accountId={accountId} positions={[p]} defaultFundCode={p.fundCode} trigger="icon" /> : null}
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

                  <SortHead sk="fundCode" label={`${assetNameLabel}名称`} cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" sortType="cleared" table="cleared" colKey="fund" width={colWidth("cleared", "fund", 220)} minWidth={150} />

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

                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={7}>{noClearedText}</td></tr>

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
          submitMethod="api"
          onSuccess={() => {
            setEditingRegularPlan(null);
            void loadRegularPlans();
            window.dispatchEvent(new Event("mmh:fund:refresh"));
          }}
        />
      ) : null}

      {/* 交易明细 */}

      <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">

        <div className="panel-header shrink-0">

          <div className="text-sm font-semibold text-slate-800">

            交易明细{fundCode && <span className={`ml-2 text-xs font-normal ${selectedFundCodeCls}`}>{fundCode}</span>}

            <span className="ml-2 text-xs text-slate-400 font-normal">{fundCode || isWealthAccount ? `${filteredByColumns.length}/${filtered.length}` : chooseHoldingText}</span>

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

            <div className="relative order-last" ref={detailColumnMenuRef}>

              <button
                type="button"
                onClick={() => setDetailColumnMenuOpen((open) => !open)}
                className="secondary-button h-7 px-2 text-xs"
                title="Columns"
                aria-label="Columns"
              >

                <SlidersHorizontal className="h-3.5 w-3.5" />

              </button>

              {detailColumnMenuOpen ? (

                <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">

                  <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">Columns</div>

                  <div className="max-h-56 space-y-1 overflow-y-auto">

                    {DETAIL_COLS.filter(([key]) => !FIXED_DETAIL_COLUMNS.has(key)).map(([key]) => {
                      const checked = isDetailColumnVisible(key);
                      const disabled = checked && visibleOptionalDetailColumnCount <= 1;
                      return (
                        <label
                          key={key}
                          className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
                            disabled ? "text-slate-400" : "cursor-pointer text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleDetailColumnVisibility(key)}
                            className="h-3.5 w-3.5 rounded border-slate-300"
                          />
                          <span className="truncate">
                            {key === "fund"
                              ? detailNameLabel
                              : key === "nav"
                                ? navColumnLabel
                                : key === "units" && isWealthAccount
                                  ? "份额/本金"
                                  : DETAIL_COLUMN_LABELS[key]}
                          </span>
                        </label>
                      );
                    })}

                  </div>

                </div>

              ) : null}

            </div>

            <div className="relative" ref={exportRef}>

              <button onClick={() => setShowExportMenu(!showExportMenu)} className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title="导出 CSV">

                <Download className="w-3 h-3" />导出

              </button>

              {showExportMenu && (

                <div className="absolute right-0 top-7 z-50 min-w-[160px] rounded-lg border border-slate-200 bg-white py-1 shadow-soft">

                  {fundCode && (

                    <button onClick={() => { setShowExportMenu(false); exportCSV("current"); }}

                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50">

                      导出当前{isWealthAccount ? "理财" : "基金"}明细

                    </button>

                  )}

                  <button onClick={() => { setShowExportMenu(false); exportCSV("all"); }}

                    className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50">

                    导出账户全部{isWealthAccount ? "理财" : "基金"}

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

        <div
          ref={detailTableViewportRef}
          className={`flex-1 min-h-0 ${needsDetailHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden"} overflow-y-auto`}
        >

            <table
              className="table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200"
              style={{ minWidth: detailMinTableWidth, width: detailLayout.tableWidth }}
            >
              <colgroup>
                {visibleDetailCols.map(([key, fallback]) => (
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

                {isDetailColumnVisible("link") ? (
                <th className="relative select-none text-center text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                  <LinkHeaderIcon />
                  <ResizeGrip table="details" colKey="link" width={colWidth("details", "link", 38)} minWidth={34} />
                </th>
                ) : null}

                {isDetailColumnVisible("date") ? (
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
                ) : null}

                {isDetailColumnVisible("arrivalDate") ? (
                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  到账日期
                  <ResizeGrip table="details" colKey="arrivalDate" width={colWidth("details", "arrivalDate", 92)} minWidth={76} />
                </th>
                ) : null}

                {isDetailColumnVisible("cashAccount") ? (
                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {renderColumnFilter("cashAccount", "资金账户")}
                  <ResizeGrip table="details" colKey="cashAccount" width={colWidth("details", "cashAccount", 132)} minWidth={92} />
                </th>
                ) : null}

                {isDetailColumnVisible("fund") ? (
                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {detailNameLabel}
                  <ResizeGrip table="details" colKey="fund" width={colWidth("details", "fund", 156)} minWidth={110} />
                </th>
                ) : null}

                {isDetailColumnVisible("nav") ? (
                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {navColumnLabel}
                  <ResizeGrip table="details" colKey="nav" width={colWidth("details", "nav", 86)} minWidth={76} />
                </th>
                ) : null}

                {isDetailColumnVisible("units") ? (
                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {isWealthAccount ? "份额/本金" : "份额"}
                  <ResizeGrip table="details" colKey="units" width={colWidth("details", "units", 84)} minWidth={64} />
                </th>
                ) : null}

                {isDetailColumnVisible("subtype") ? (
                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {renderColumnFilter("subtype", "交易类型")}
                  <ResizeGrip table="details" colKey="subtype" width={colWidth("details", "subtype", 88)} minWidth={72} />
                </th>
                ) : null}

                {isDetailColumnVisible("amount") ? (
                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                  金额
                  <ResizeGrip table="details" colKey="amount" width={colWidth("details", "amount", 76)} minWidth={58} />
                </th>
                ) : null}

                {isDetailColumnVisible("profit") ? (
                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                  收益
                  <ResizeGrip table="details" colKey="profit" width={colWidth("details", "profit", 76)} minWidth={58} />
                </th>
                ) : null}

                {isDetailColumnVisible("status") ? (
                <th className="relative select-none text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  {renderColumnFilter("status", "状态")}
                  <ResizeGrip table="details" colKey="status" width={colWidth("details", "status", 72)} minWidth={58} />
                </th>
                ) : null}

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

                const units = displayUnitsOf(e);

                const info = fl(e.fundSubtype, e.source);

                const selected = selectedIds.has(e.id);
                const isRegularInvestRefund = e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund";
                const linkedBuyForRefund = isRegularInvestRefund
                  ? (() => {
                      const target: RefundLinkableEntry = {
                        id: String(e.id ?? ""),
                        date: fmtDate(e.date),
                        createdAt: e.createdAt,
                        fundConfirmDate: fmtDate(e.fundConfirmDate),
                        fundArrivalDate: fmtDate(e.fundArrivalDate),
                        accountId: e.accountId ?? null,
                        toAccountId: e.toAccountId ?? null,
                        fundCode: entryAssetKey(e),
                        fundSubtype: e.fundSubtype ?? null,
                        fundUnits: displayUnitsOfPlain(e),
                        source: e.source ?? null,
                        fundSourceEntryId: e.fundSourceEntryId ?? null,
                        amount: toNumber(e.amount),
                      };
                      const linked = findLinkedEntries(target, linkedCandidateEntries);
                      const linkedBuyId = linked.linkedBuys[0]?.id;
                      return linkedBuyId ? d.allEntries.find((item: any) => String(item.id ?? "") === linkedBuyId) ?? null : null;
                    })()
                  : null;
                const editableInvestmentEntry = linkedBuyForRefund ?? e;

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

                    onDoubleClick={() => setDetailEditSignal({ id: e.id, value: Date.now() })}

                  >

                    <td className="w-10 align-middle px-2 py-1 border-b border-slate-100 text-xs">

                      <div className="flex h-7 items-center justify-center">

                        <input

                          type="checkbox"

                          checked={selectedIds.has(e.id)}

                          onClick={(ev) => ev.stopPropagation()}

                          onDoubleClick={(ev) => ev.stopPropagation()}

                          onChange={() => setSelectedIds((prev) => {

                            const next = new Set(prev);

                            if (next.has(e.id)) next.delete(e.id);

                            else next.add(e.id);

                            return next;

                          })}

                          className="h-3.5 w-3.5 accent-blue-600"

                          aria-label={`选择${isWealthAccount ? "理财" : "基金"}交易明细`}

                        />

                      </div>

                    </td>

                    {isDetailColumnVisible("link") ? (
                    <td className="px-2 py-1 border-b border-slate-100 text-center text-xs">
                      {(() => {
                        const linkInfo = entryBusinessLinkInfo(e);
                        const title = linkInfo.active
                          ? `已关联${linkInfo.labels.length ? `：${linkInfo.labels.join("、")}` : ""}`
                          : "未关联";
                        return <LinkStatusIcon active={linkInfo.active} title={title} />;
                      })()}
                    </td>
                    ) : null}

                    {isDetailColumnVisible("date") ? (
                    <td className="px-4 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-600">{fundApplyDateOf(e)}</td>
                    ) : null}

                    {isDetailColumnVisible("arrivalDate") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-xs tabular-nums text-slate-500">

                      {e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : <span className="text-slate-300">-</span>}

                    </td>
                    ) : null}

                    {isDetailColumnVisible("cashAccount") ? (
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
                    ) : null}

                    {isDetailColumnVisible("fund") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-700">
                      <div className="truncate" title={`${displayFundName(e)} ${e.fundCode || ""}`}>
                        {displayFundName(e)}{e.fundCode && displayFundName(e) !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}
                      </div>
                    </td>
                    ) : null}

                    {isDetailColumnVisible("nav") ? (
                    <td className="overflow-hidden whitespace-nowrap px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{nav != null ? nav.toFixed(4) : <span className="text-slate-400">-</span>}</td>
                    ) : null}

                    {isDetailColumnVisible("units") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{units != null ? formatFundUnits(units) : <span className="text-slate-400">-</span>}</td>
                    ) : null}

                    {isDetailColumnVisible("subtype") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-xs"><span className={`px-1 py-0.5 rounded text-[10px] font-medium ${e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls}`}>{info.label}</span></td>
                    ) : null}

                    {isDetailColumnVisible("amount") ? (
                    <td className="px-2 py-1 border-b border-slate-100 text-right text-xs tabular-nums text-slate-700">

                      {(() => {

                        const absAmt = formatMoney(Math.abs(amount));

                        if (e.source === "dividend" || e.fundSubtype === "dividend_cash") return <span className={`font-medium ${upCls}`}>+{absAmt}</span>;

                        return absAmt;

                      })()}

                    </td>
                    ) : null}

                    {isDetailColumnVisible("profit") ? (
                    <td className={`px-2 py-1 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(toNumber(e.realizedProfit))}`}>

                      {e.realizedProfit != null && e.fundSubtype === "redeem" ? formatMoney(toNumber(e.realizedProfit)) : <span className="text-slate-300">-</span>}

                    </td>
                    ) : null}

                    {isDetailColumnVisible("status") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-xs text-slate-600">

                      {(() => {

                        const s = statusOf(e);

                        if (s === "待确认") return <span className="text-amber-600">{s}</span>;

                        if (s === "暂停申购") return <span className="text-rose-600">{s}</span>;

                        if (s === "买入退回") return <span className="text-emerald-700">{s}</span>;

                        if (s === "部分确认") return <span className="text-amber-600">{s}</span>;

                        return <span className="text-emerald-700">{s}</span>;

                      })()}

                    </td>
                    ) : null}

                    <td className="w-[112px] align-middle px-2 py-1 border-b border-slate-100">

                      <div
                        className="flex h-7 min-w-[92px] flex-nowrap items-center justify-end gap-1"
                        onClick={(ev) => ev.stopPropagation()}
                        onDoubleClick={(ev) => ev.stopPropagation()}
                      >

                        {!isWealthAccount && e.fundCode && e.fundSubtype === "buy" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} onFilled={(data) => handleEntryNavFilled(e, data)} /> : null}

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

                            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}

                            cashAccounts={cashAccounts}

                            investmentAccounts={investmentAccounts}

                            cashAccountSSOptions={cashAccountSSOptions}

                            investmentAccountSSOptions={investmentAccountSSOptions}

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

                            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}

                            cashAccounts={cashAccounts}

                            investmentAccounts={investmentAccounts}

                            cashAccountSSOptions={cashAccountSSOptions}

                            investmentAccountSSOptions={investmentAccountSSOptions}

                            createAction={createAction}

                            editAction={editAction}

                          />

                        ) : (

                          <InvestmentFormModal

                            mode="edit"

                            entry={{

                              id: editableInvestmentEntry.id, transactionId: editableInvestmentEntry.id,

                              date: fmtDate(editableInvestmentEntry.date),

                              confirmDate: fmtDate(editableInvestmentEntry.fundConfirmDate) || undefined,

                              amount: toNumber(editableInvestmentEntry.amount), note: editableInvestmentEntry.note ?? null, memo: editableInvestmentEntry.note ?? null,

                              fundCode: editableInvestmentEntry.fundCode ?? null, fundName: displayFundName(editableInvestmentEntry) === "-" ? (editableInvestmentEntry.fundCode ?? null) : displayFundName(editableInvestmentEntry),

                              fundUnits: editableInvestmentEntry.fundUnits != null ? toNumber(editableInvestmentEntry.fundUnits) : null,
                              displayFundUnits: displayUnitsOf(editableInvestmentEntry),

                              fundNav: editableInvestmentEntry.fundNav != null ? toNumber(editableInvestmentEntry.fundNav) : null,

                              fundFee: editableInvestmentEntry.fundFee != null ? toNumber(editableInvestmentEntry.fundFee) : null,

                              fundProductType: editableInvestmentEntry.fundProductType ?? null, fundSubtype: editableInvestmentEntry.fundSubtype ?? null,
                              metalTypeId: editableInvestmentEntry.metalTypeId ?? null,
                              metalTypeName: editableInvestmentEntry.metalTypeName ?? null,
                              metalUnitId: editableInvestmentEntry.metalUnitId ?? null,
                              metalUnitName: editableInvestmentEntry.metalUnitName ?? null,
                              metalQuantity: editableInvestmentEntry.metalQuantity != null ? toNumber(editableInvestmentEntry.metalQuantity) : null,
                              metalUnitPrice: editableInvestmentEntry.metalUnitPrice != null ? toNumber(editableInvestmentEntry.metalUnitPrice) : null,
                              metalFee: editableInvestmentEntry.metalFee != null ? toNumber(editableInvestmentEntry.metalFee) : null,

                              source: editableInvestmentEntry.source ?? null,

                              accountId: editableInvestmentEntry.accountId ?? null, toAccountId: editableInvestmentEntry.toAccountId ?? null, toAccountName: editableInvestmentEntry.toAccountName ?? null,

                              fundArrivalDate: fmtDate(editableInvestmentEntry.fundArrivalDate) || null,

                              fundArrivalAmount: editableInvestmentEntry.fundArrivalAmount != null ? toNumber(editableInvestmentEntry.fundArrivalAmount) : null,

                              realizedProfit: editableInvestmentEntry.realizedProfit != null ? toNumber(editableInvestmentEntry.realizedProfit) : null,

                            }}

                            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}

                            accountId={selectedAccount?.id ?? ""}

                            accountProductType={selectedAccount?.investProductType ?? null}

                            defaults={{

                              confirmDays: d.confirmDaysMap[editableInvestmentEntry.fundCode ?? ""] ?? selectedAccount?.defaultConfirmDays ?? undefined,

                              feeRate: d.feeRateMap[`${editableInvestmentEntry.fundCode ?? ""}:${editableInvestmentEntry.fundSubtype === "redeem" ? "redeem" : "buy"}`] ?? null,

                            }}

                            cashAccounts={cashAccounts}

                            investmentAccounts={investmentAccounts}

                            cashAccountSSOptions={cashAccountSSOptions}

                            investmentAccountSSOptions={investmentAccountSSOptions}
                            metalTypes={metalTypes}
                            metalUnits={metalUnits}

                           nestedFieldData={nestedFieldData}

                            allEntries={linkedCandidateEntries}

                            createAction={createAction}

                            editAction={editAction}

                          />

                        )}

                      </div>

                    </td>

                  </tr>

                );

              }) : (<tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={visibleDetailCols.length}>{fundCode || isWealthAccount ? "暂无交易记录" : chooseHoldingText}</td></tr>)}

            </tbody>

          </table>

        </div>

      </div>

    </div>

  );

}
