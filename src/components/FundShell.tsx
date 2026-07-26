"use client";



import { useState, useMemo, useRef, useEffect, useCallback, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

import { useRouter } from "next/navigation";

import Link from "next/link";

import { startTransition } from "react";

import { CartesianGrid, Line, LineChart as RechartsLineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatMoney } from "@/lib/format";

import { toNumber } from "@/lib/date-utils";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

import { CalendarSync, ChartLine, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsLeft, ChevronsRight, Download, Pause, Pencil, Play, SlidersHorizontal, Trash2, Upload, X } from "lucide-react";

import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { allocateBuyFailedRefunds, findLinkedEntries, getEffectiveBuyUnitsByRefunds, type RefundLinkableEntry } from "@/lib/fund/refund-link";

import { WealthFormModal } from "@/components/WealthFormModal";

import { DepositFormModal } from "@/components/DepositFormModal";

import { FillNavButton } from "@/components/FillNavButton";

import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";

import { RegularInvestForm } from "@/components/RegularInvestForm";

import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";

import { AddNavButton } from "@/components/AddNavButton";

import { DateStepper } from "@/components/DateStepper";

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

function FundMobileDetailItem({
  label,
  value,
  alignRight = false,
  wide = false,
  valueClassName = "text-slate-700",
}: {
  label: string;
  value: string;
  alignRight?: boolean;
  wide?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-0.5 min-w-0 ${alignRight ? "text-right" : ""} break-words text-xs tabular-nums ${valueClassName}`}>
        {value}
      </div>
    </div>
  );
}



type Props = any;

type FundTableKey = "positions" | "cleared" | "details";
type FundTableViewportKey = "summary" | "details";
type FundColumnSpec = readonly [string, number];

const FUND_TABLE_WIDTHS_KEY = "mmh_fund_shell_column_widths_v1";
const FUND_DETAIL_HIDDEN_COLUMNS_KEY = "mmh_fund_shell_detail_hidden_columns_v1";
const FUND_HORIZONTAL_SCROLL_TOLERANCE_PX = 4;

const POSITION_COLS: readonly FundColumnSpec[] = [
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

const WEALTH_POSITION_COLS: readonly FundColumnSpec[] = [
  ["fund", 260],
  ["holdingDate", 96],
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
  ["remainingUnits", 92],
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
  date: "申请日期",
  arrivalDate: "到账日期",
  cashAccount: "资金账户",
  fund: "基金",
  nav: "净值",
  units: "份额",
  remainingUnits: "剩余份额",
  subtype: "交易类型",
  amount: "金额",
  profit: "收益",
  status: "状态",
  actions: "",
};

const FUND_COL_MIN_WIDTHS: Record<FundTableKey, Record<string, number>> = {
  positions: {
    fund: 160,
    holdingDate: 78,
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

type FundChartMode = "profit" | "nav" | "cumNav";
type FundChartRange = "month" | "quarter" | "halfYear" | "oneYear" | "sinceBuy";

type FundNavHistoryPoint = {
  date: string;
  nav: number;
  cumNav: number | null;
};

type FundChartEntry = {
  id: string;
  date: string;
  fundConfirmDate: string;
  fundSubtype: string;
  source: string;
  amount: number;
  units: number | null;
  fee: number;
};

type FundChartPoint = {
  date: string;
  value: number;
  nav: number;
  cumNav: number | null;
  units: number;
  cost: number;
  marketValue: number;
  hasPosition: boolean;
};

const FUND_CHART_RANGE_LABELS: Record<FundChartRange, string> = {
  month: "本月",
  quarter: "三月",
  halfYear: "半年",
  oneYear: "一年",
  sinceBuy: "购买以来",
};

function localYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseYmdDay(value: string | null | undefined) {
  const raw = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function ymdFromDay(day: number) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function addDaysYmd(value: string, days: number) {
  const base = parseYmdDay(value);
  if (base == null) return "";
  return ymdFromDay(base + days);
}

function monthStartYmd(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(0, 8)}01` : value;
}

function formatChartMonthDay(value: string) {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}-${date.slice(8, 10)}` : date;
}

function chartValueText(value: number, mode: FundChartMode) {
  if (mode === "profit") return formatMoney(value);
  return Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(4);
}

function isFundBuyLikeEntry(entry: FundChartEntry) {
  return !entry.fundSubtype || entry.fundSubtype === "buy" || entry.fundSubtype === "regular_invest" || entry.fundSubtype === "dividend_reinvest" || entry.fundSubtype === "switch_in";
}

function firstFundBuyDate(entries: FundChartEntry[]) {
  return entries
    .filter(isFundBuyLikeEntry)
    .map((entry) => String(entry.date ?? "").slice(0, 10))
    .filter(Boolean)
    .sort()[0] ?? "";
}

function effectiveFundEntryDate(entry: FundChartEntry, confirmDays: number) {
  if (entry.fundConfirmDate) return entry.fundConfirmDate;
  const baseDate = String(entry.date ?? "").slice(0, 10);
  if (!baseDate) return "";
  return isFundBuyLikeEntry(entry) ? addDaysYmd(baseDate, Math.max(0, confirmDays)) : baseDate;
}

function availableFundChartRanges(history: FundNavHistoryPoint[], firstBuyDate: string): FundChartRange[] {
  const latest = history.at(-1)?.date ?? localYmd();
  const earliest = history[0]?.date ?? "";
  const canShow = (start: string) => !earliest || earliest <= start;
  const ranges: FundChartRange[] = ["month"];
  if (canShow(addDaysYmd(latest, -90))) ranges.push("quarter");
  if (canShow(addDaysYmd(latest, -180))) ranges.push("halfYear");
  if (canShow(addDaysYmd(latest, -365))) ranges.push("oneYear");
  if (firstBuyDate) ranges.push("sinceBuy");
  return Array.from(new Set(ranges));
}

function filterFundHistoryByRange(history: FundNavHistoryPoint[], range: FundChartRange, firstBuyDate: string) {
  if (history.length === 0) return history;
  const latest = history.at(-1)?.date ?? localYmd();
  const start = range === "month"
    ? monthStartYmd(latest)
    : range === "quarter"
      ? addDaysYmd(latest, -90)
      : range === "halfYear"
        ? addDaysYmd(latest, -180)
        : range === "oneYear"
          ? addDaysYmd(latest, -365)
          : firstBuyDate || history[0]!.date;
  return history.filter((point) => point.date >= start);
}

function buildFundProfitChartPoints(history: FundNavHistoryPoint[], entries: FundChartEntry[], confirmDays: number): FundChartPoint[] {
  const effectiveEntries = entries
    .map((entry) => ({ entry, day: parseYmdDay(effectiveFundEntryDate(entry, confirmDays)) }))
    .filter((item): item is { entry: FundChartEntry; day: number } => item.day != null)
    .sort((a, b) => a.day - b.day || String(a.entry.id).localeCompare(String(b.entry.id)));

  let entryIndex = 0;
  let units = 0;
  let cost = 0;

  return history.map((item) => {
    const navDay = parseYmdDay(item.date);
    if (navDay != null) {
      while (entryIndex < effectiveEntries.length && effectiveEntries[entryIndex]!.day <= navDay) {
        const entry = effectiveEntries[entryIndex]!.entry;
        const entryUnits = entry.units ?? 0;
        const entryAmount = Math.abs(entry.amount);
        if (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out") {
          const reducingUnits = entryUnits > 0 ? entryUnits : 0;
          const avgCost = units > 0 ? cost / units : 0;
          units = Math.max(0, units - reducingUnits);
          cost = Math.max(0, cost - avgCost * reducingUnits);
        } else if (entry.fundSubtype === "dividend_cash" || entry.fundSubtype === "buy_failed") {
          // No share position is created by cash dividends or failed buys.
        } else if (entryUnits > 0) {
          units += entryUnits;
          cost += entryAmount + entry.fee;
        }
        entryIndex += 1;
      }
    }
    const hasPosition = units > 0;
    const marketValue = hasPosition ? item.nav * units : 0;
    return {
      date: item.date,
      value: hasPosition ? marketValue - cost : 0,
      nav: item.nav,
      cumNav: item.cumNav,
      units: hasPosition ? units : 0,
      cost: hasPosition ? cost : 0,
      marketValue,
      hasPosition,
    };
  });
}

function compactFundSubtypeLabel(entry: any, fallback: string) {
  const subtype = String(entry?.fundSubtype ?? "");
  const source = String(entry?.source ?? "");
  if (subtype === "buy_failed" && source === "regular_invest_refund") return "退回";
  if (subtype === "buy_failed") return source === "regular_invest" ? "暂停" : "退回";
  if (subtype === "buy" && source === "regular_invest") return "定投";
  if (subtype === "buy") return "申购";
  if (subtype === "redeem") return "赎回";
  if (subtype === "dividend_cash") return "现金红利";
  if (subtype === "dividend_reinvest" || source === "dividend") return "红利再投";
  if (subtype === "switch_in") return "转入";
  if (subtype === "switch_out") return "转出";
  return fallback.replace(/^基金/, "").replace(/^定期/, "定投");
}

function FundTrendChart({
  fundName,
  fundCode,
  history,
  entries,
  confirmDays,
  loading,
  error,
  mode,
  range,
  upClassName,
  downClassName,
  onModeChange,
  onRangeChange,
  embedded = false,
}: {
  fundName: string;
  fundCode: string;
  history: FundNavHistoryPoint[];
  entries: FundChartEntry[];
  confirmDays: number;
  loading: boolean;
  error: string;
  mode: FundChartMode;
  range: FundChartRange;
  upClassName: string;
  downClassName: string;
  onModeChange: (mode: FundChartMode) => void;
  onRangeChange: (range: FundChartRange) => void;
  embedded?: boolean;
}) {
  const firstBuyDate = firstFundBuyDate(entries);
  const ranges = availableFundChartRanges(history, firstBuyDate);
  const activeRange = ranges.includes(range) ? range : ranges[0] ?? "month";
  const filteredHistory = filterFundHistoryByRange(history, activeRange, firstBuyDate);
  const profitPoints = buildFundProfitChartPoints(filteredHistory, entries, confirmDays);
  const hasCumNav = filteredHistory.some((point) => point.cumNav != null);
  const activeMode = mode === "cumNav" && !hasCumNav ? "nav" : mode;
  const points = activeMode === "profit"
    ? profitPoints
    : filteredHistory.map((item) => ({
        date: item.date,
        value: activeMode === "cumNav" ? item.cumNav ?? item.nav : item.nav,
        nav: item.nav,
        cumNav: item.cumNav,
        units: 0,
        cost: 0,
        marketValue: 0,
        hasPosition: false,
      }));
  const lineClass = activeMode === "profit" && (points.at(-1)?.value ?? 0) < 0 ? downClassName : activeMode === "profit" ? upClassName : "text-blue-600";
  const stroke = lineClass.includes("red") ? "#dc2626" : lineClass.includes("emerald") ? "#047857" : "#2563eb";
  const latestPoint = points.at(-1);

  useEffect(() => {
    if (activeRange !== range) onRangeChange(activeRange);
  }, [activeRange, onRangeChange, range]);

  useEffect(() => {
    if (activeMode !== mode) onModeChange(activeMode);
  }, [activeMode, mode, onModeChange]);

  return (
    <section
      className={embedded ? "mt-3 overflow-hidden border-t border-slate-100 pt-3" : "panel-surface shrink-0 overflow-hidden"}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className={embedded ? "flex flex-wrap items-start justify-between gap-2" : "flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-white px-4 py-3"}>
        <div className={embedded ? "hidden" : "min-w-0"}>
          <div className="truncate text-sm font-semibold text-slate-800">{fundName || fundCode}</div>
          <div className="text-xs tabular-nums text-slate-400">{fundCode}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md bg-slate-100 p-0.5 text-xs">
          {([
            ["profit", "收益走势"],
            ["nav", "净值走势"],
            ...(hasCumNav ? [["cumNav", "累计净值"] as const] : []),
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onModeChange(key)}
              className={`h-7 rounded px-2 ${activeMode === key ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={embedded ? "space-y-2 pt-2" : "space-y-2 px-4 py-3"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {ranges.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onRangeChange(item)}
                className={`h-6 rounded border px-2 text-xs ${activeRange === item ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
              >
                {FUND_CHART_RANGE_LABELS[item]}
              </button>
            ))}
          </div>
          {latestPoint ? (
            <div className={`text-xs tabular-nums ${activeMode === "profit" ? lineClass : "text-slate-600"}`}>
              {chartValueText(latestPoint.value, activeMode)}
            </div>
          ) : null}
        </div>

        <div className={`${embedded ? "h-[180px]" : "h-[210px]"} w-full`}>
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">正在加载历史净值</div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-rose-500">{error}</div>
          ) : points.length < 2 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-400">历史净值不足，至少需要两个净值点才能绘制走势</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <RechartsLineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  minTickGap={28}
                  tickFormatter={formatChartMonthDay}
                />
                <YAxis
                  width={58}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={false}
                  domain={["auto", "auto"]}
                  tickFormatter={(value) => chartValueText(Number(value), activeMode)}
                />
                <Tooltip
                  cursor={{ stroke: "#94a3b8", strokeWidth: 1 }}
                  content={({ active, payload }: any) => {
                    const point = payload?.[0]?.payload as FundChartPoint | undefined;
                    if (!active || !point) return null;
                    return (
                      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
                        <div className="mb-1 font-medium text-slate-700">{point.date}</div>
                        <div className="tabular-nums text-slate-600">
                          {activeMode === "profit" ? "收益" : activeMode === "cumNav" ? "累计净值" : "净值"} {chartValueText(point.value, activeMode)}
                        </div>
                        <div className="tabular-nums text-slate-400">单位净值 {point.nav.toFixed(4)}</div>
                        {activeMode === "profit" ? (
                          point.hasPosition ? (
                            <>
                              <div className="tabular-nums text-slate-400">份额 {point.units.toFixed(2)}</div>
                              <div className="tabular-nums text-slate-400">成本 {formatMoney(point.cost)} · 市值 {formatMoney(point.marketValue)}</div>
                            </>
                          ) : (
                            <div className="text-slate-400">未确认持仓</div>
                          )
                        ) : null}
                      </div>
                    );
                  }}
                />
                <Line type="monotone" dataKey="value" stroke={stroke} strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
              </RechartsLineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </section>
  );
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
  const positionCols = isWealthAccount ? WEALTH_POSITION_COLS : POSITION_COLS;
  const assetNameLabel = isMetalAccount ? "品种" : isWealthAccount ? "理财产品" : "基金";
  const holdingTabLabel = isMetalAccount ? "持仓贵金属" : isWealthAccount ? "持仓理财" : "持仓基金";
  const clearedTabLabel = isWealthAccount ? "已赎回理财" : "清仓基金";
  const noClearedText = isWealthAccount ? "暂无已赎回理财" : "暂无清仓基金";
  const chooseHoldingText = `请先选择上方${isWealthAccount ? "理财持仓" : "基金持仓"}`;
  const investmentAccountLabel = isWealthAccount ? "理财账户" : "基金账户";
  const detailNameLabel = isWealthAccount ? "理财产品" : "基金";
  const navColumnLabel = isMetalAccount ? "单价" : isWealthAccount ? "净值/估值" : "净值";
  const entryAssetKey = useCallback((entry: any) => String(
    isWealthAccount
      ? entry?.wealthProductId ?? ""
      : isMetalAccount
        ? entry?.metalTypeId ?? ""
        : entry?.fundCode ?? "",
  ).trim(), [isMetalAccount, isWealthAccount]);
  const positionAssetKey = useCallback((position: any) => String(
    isWealthAccount
      ? position?.wealthProductId ?? ""
      : position?.fundCode ?? "",
  ).trim(), [isWealthAccount]);



  const [fundCode, setFundCode] = useState(initialFundCode);
  const [fundChartOpen, setFundChartOpen] = useState(false);

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
  const positionEntryDefaultsRef = useRef<any | null>(null);
  const [positionEntryOpenSignal, setPositionEntryOpenSignal] = useState(0);
  const [detailEditSignal, setDetailEditSignal] = useState<{ id: string; value: number } | null>(null);
  const openDetailEdit = useCallback((entryId: string) => {
    setDetailEditSignal({ id: entryId, value: Date.now() });
  }, []);
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
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [fundChartMode, setFundChartMode] = useState<FundChartMode>("profit");
  const [fundChartRange, setFundChartRange] = useState<FundChartRange>("month");
  const [fundNavHistoryState, setFundNavHistoryState] = useState<{
    code: string;
    loading: boolean;
    error: string;
    data: FundNavHistoryPoint[];
  }>({ code: "", loading: false, error: "", data: [] });

  // Shadow props with reactive local state
  const d = localData;

  useEffect(() => {
    if (!detailEditSignal) return;
    const timer = window.setTimeout(() => {
      setDetailEditSignal((current) => (current?.value === detailEditSignal.value ? null : current));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [detailEditSignal]);
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
  const detailAmountOf = useCallback((entry: any) => {
    const rawAmount = toNumber(entry?.amount);
    if (!isWealthAccount) return rawAmount;
    const isCashIn =
      entry?.fundSubtype === "redeem" ||
      entry?.fundSubtype === "switch_out" ||
      entry?.fundSubtype === "dividend_cash";
    if (!isCashIn) return rawAmount;
    const arrivalAmount = entry?.fundArrivalAmount != null ? toNumber(entry.fundArrivalAmount) : null;
    return arrivalAmount != null ? Math.abs(arrivalAmount) : Math.abs(rawAmount);
  }, [isWealthAccount]);
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
  const [singleDeletingIds, setSingleDeletingIds] = useState<Set<string>>(new Set());
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());

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

  const isSingleNormalFundScope = Boolean(fundCode && !isMetalAccount && !isWealthAccount);

  const visibleDetailCols = useMemo(
    () => DETAIL_COLS.filter(([key]) =>
      !(isWealthAccount && key === "status") &&
      !(!isWealthAccount && key === "remainingUnits") &&
      !(isSingleNormalFundScope && key === "fund") &&
      !hiddenDetailColumns.has(key)
    ),
    [hiddenDetailColumns, isSingleNormalFundScope, isWealthAccount],
  );
  const visibleOptionalDetailColumnCount = visibleDetailCols.filter(([key]) => !FIXED_DETAIL_COLUMNS.has(key)).length;
  const detailMinTableWidth = useMemo(
    () => Math.min(1100, visibleDetailCols.reduce((sum, [, fallback]) => sum + fallback, 0)),
    [visibleDetailCols],
  );
  const isDetailColumnVisible = useCallback(
    (key: DetailColumnKey) =>
      !(isWealthAccount && key === "status") &&
      !(!isWealthAccount && key === "remainingUnits") &&
      !(isSingleNormalFundScope && key === "fund") &&
      !hiddenDetailColumns.has(key),
    [hiddenDetailColumns, isSingleNormalFundScope, isWealthAccount],
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
    () => tableLayout("positions", positionCols, minFundTableWidth("positions", positionCols), tableViewportWidths.summary),
    [positionCols, tableLayout, tableViewportWidths.summary],
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
    if (isWealthAccount && key === "status") return;
    if (FIXED_DETAIL_COLUMNS.has(key)) return;
    setHiddenDetailColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        const visibleOptionalCount = DETAIL_COLS.filter(([colKey]) =>
          !(isWealthAccount && colKey === "status") &&
          !(!isWealthAccount && colKey === "remainingUnits") &&
          !FIXED_DETAIL_COLUMNS.has(colKey) &&
          !next.has(colKey)
        ).length;
        if (visibleOptionalCount <= 1) return prev;
        next.add(key);
      }
      try {
        window.localStorage.setItem(FUND_DETAIL_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, [isWealthAccount]);

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
    if (isWealthAccount) {
      return String(entry?.fundName ?? entry?.productName ?? "").trim() || "-";
    }
    const code = String(entry?.fundCode ?? "").trim();
    const fetched = code ? fetchedFundNames[code] : "";
    if (fetched && !isGenericFundName(fetched, code)) return fetched;
    const mapped = code ? fundNameByCode.get(code) : "";
    if (mapped && !isGenericFundName(mapped, code)) return mapped;
    const stored = String(entry?.fundName ?? "").trim();
    if (stored && !isGenericFundName(stored, code)) return stored;
    return code || "-";
  }, [fetchedFundNames, fundNameByCode, isMetalAccount, isWealthAccount]);

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

    const header = [
      "申请日期",
      "确认日期",
      "到账日期",
      "资金账户",
      isWealthAccount ? "理财产品ID" : `${detailNameLabel}代码`,
      `${detailNameLabel}名称`,
      navColumnLabel,
      isMetalAccount ? "数量" : "份额",
      ...(isWealthAccount ? ["剩余份额"] : []),
      "交易类型",
      isWealthAccount ? "入账/出账金额" : "金额",
      "收益",
      ...(isWealthAccount ? [] : ["状态"]),
    ];

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

      const amt = e.amount != null ? detailAmountOf(e) : "";

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

        isWealthAccount ? e.wealthProductId || "" : e.fundCode || "",

        displayFundName(e),

        String(nav),

        String(units),

        ...(isWealthAccount ? [e.wealthRemainingUnits != null ? String(e.wealthRemainingUnits) : ""] : []),

        subtype,

        String(amt),

        String(profit),

        ...(isWealthAccount ? [] : [status]),

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

        case "holdingDate": v = String(a.holdingDate ?? "").localeCompare(String(b.holdingDate ?? "")); break;

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
    if (!code) return;

    setFundCode(code);

    setFundPage(1);

    const q = new URLSearchParams(baseQuery);

    q.set("view", view);
    if (isWealthAccount) {
      q.set("wealthProductId", code);
      q.delete("fundCode");
    } else {
      q.set("fundCode", code);
      q.delete("wealthProductId");
    }

    if (showCleared) q.set("showCleared", "1");

    window.history.replaceState(null, "", `/?${q.toString()}`);

  }

  function toggleAllWealthEntries() {
    if (!isWealthAccount) return;
    const list = showCleared ? sortedClearedPositions : sortedPositions;
    const nextCode = fundCode ? "" : positionAssetKey((list || [])[0] ?? null);
    setFundCode(nextCode);
    setFundPage(1);
    const q = new URLSearchParams(baseQuery);
    q.set("view", view);
    q.delete("fundCode");
    if (nextCode) q.set("wealthProductId", nextCode);
    else q.delete("wealthProductId");
    if (showCleared) q.set("showCleared", "1");
    else q.delete("showCleared");
    window.history.replaceState(null, "", `/?${q.toString()}`);
  }

  function toggleCleared(on: boolean) {

    setShowCleared(on);
    setFundChartOpen(false);

    const q = new URLSearchParams(baseQuery); q.set("view", view);

    if (on) { q.set("showCleared", "1"); q.delete("fundCode"); q.delete("wealthProductId"); }

    else { q.delete("showCleared"); q.delete("fundCode"); q.delete("wealthProductId"); }

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
  const isWealthAccountRef = useRef(isWealthAccount);

  useEffect(() => {
    fundCodeRef.current = fundCode;
    showClearedRef.current = showCleared;
    accountIdRef.current = accountId;
    isWealthAccountRef.current = isWealthAccount;
  }, [fundCode, showCleared, accountId, isWealthAccount]);

  const loadFundShellData = useCallback(async (code: string, cleared: boolean) => {
    const seq = ++shellDataRequestSeq.current;
    try {
      const sc = cleared ? "1" : "0";
      const selectedParam = code
        ? isWealthAccount
          ? `&wealthProductId=${encodeURIComponent(code)}`
          : `&fundCode=${encodeURIComponent(code)}`
        : "";
      const res = await fetch(`/api/v1/fund/shell-data?accountId=${encodeURIComponent(accountId)}${selectedParam}&showCleared=${sc}&entryScope=account`);
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
                  ...prev.allEntries.filter((entry: any) => entryAssetKey(entry) !== code && !refreshedIds.has(entry.id)),
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
  }, [accountId, entryAssetKey, isWealthAccount]);

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
    const nextDefaults = {
      fundCode: code,
      fundName: String(position?.name ?? code),
      fundUnits: position?.units != null ? toNumber(position.units) : null,
      confirmDays: d.confirmDaysMap[code] ?? selectedAccount?.defaultConfirmDays ?? undefined,
      feeRate: d.feeRateMap[`${code}:buy`] ?? null,
    };
    positionEntryDefaultsRef.current = nextDefaults;
    setPositionEntryDefaults(nextDefaults);
    setPositionEntryOpenSignal((value) => value + 1);
  }

  const shellRefreshHandler = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(async () => {
      if (refreshBusy.current) return;
      refreshBusy.current = true;
      try {
        const fc = fundCodeRef.current;
        if (!fc && !isWealthAccountRef.current) return;
        const sc = showClearedRef.current ? "1" : "0";
        const aid = accountIdRef.current;
        const seq = ++shellDataRequestSeq.current;
        const selectedParam = fc
          ? isWealthAccountRef.current
            ? `&wealthProductId=${encodeURIComponent(fc)}`
            : `&fundCode=${encodeURIComponent(fc)}`
          : "";
        const res = await fetch(`/api/v1/fund/shell-data?accountId=${encodeURIComponent(aid)}${selectedParam}&showCleared=${sc}&entryScope=account`);
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
                    ...prev.allEntries.filter((entry: any) => entryAssetKey(entry) !== fc && !refreshedIds.has(entry.id)),
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
  }, [entryAssetKey]);

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
    () => (d.positions || []).find((p: any) => positionAssetKey(p) === fundCode) ?? null,
    [d.positions, fundCode, positionAssetKey],
  );
  const selectedAnyPosition = useMemo(
    () => ([...(d.positions || []), ...(d.clearedPositions || [])] as any[]).find((p: any) => positionAssetKey(p) === fundCode) ?? null,
    [d.positions, d.clearedPositions, fundCode, positionAssetKey],
  );
  const selectedFundCodeCls = selectedPosition ? pnl(toNumber(selectedPosition.historicalProfit ?? selectedPosition.floatingPnL ?? 0)) : "text-slate-500";
  const selectedFundChartEntries = useMemo<FundChartEntry[]>(() => {
    if (!fundCode || isMetalAccount || isWealthAccount) return [];
    return filtered.map((entry: any) => ({
      id: String(entry?.id ?? ""),
      date: fundApplyDateOf(entry),
      fundConfirmDate: fmtDate(entry?.fundConfirmDate),
      fundSubtype: String(entry?.fundSubtype ?? ""),
      source: String(entry?.source ?? ""),
      amount: toNumber(entry?.amount),
      units: displayUnitsOfPlain(entry),
      fee: toNumber(entry?.fundFee ?? entry?.fee ?? 0),
    }));
  }, [displayUnitsOfPlain, filtered, fundApplyDateOf, fundCode, isMetalAccount, isWealthAccount]);
  const selectedFundFirstBuyDate = useMemo(() => firstFundBuyDate(selectedFundChartEntries), [selectedFundChartEntries]);
  const selectedFundChartStartDate = useMemo(() => {
    const oneYearAgo = addDaysYmd(localYmd(), -365);
    return selectedFundFirstBuyDate && selectedFundFirstBuyDate < oneYearAgo ? selectedFundFirstBuyDate : oneYearAgo;
  }, [selectedFundFirstBuyDate]);
  const showSelectedFundChart = Boolean(fundChartOpen && fundCode && !isMetalAccount && !isWealthAccount);
  const selectedFundNameForChart = String(selectedAnyPosition?.name ?? "").trim() || fundNameByCode.get(fundCode) || fetchedFundNames[fundCode] || fundCode;
  const selectedFundConfirmDays = Number(d.confirmDaysMap?.[fundCode] ?? selectedAccount?.defaultConfirmDays ?? 0) || 0;

  useEffect(() => {
    if (!showSelectedFundChart) {
      setFundNavHistoryState({ code: "", loading: false, error: "", data: [] });
      return;
    }
    const controller = new AbortController();
    setFundNavHistoryState((prev) => ({
      code: fundCode,
      loading: true,
      error: "",
      data: prev.code === fundCode ? prev.data : [],
    }));
    const params = new URLSearchParams({
      code: fundCode,
      start: selectedFundChartStartDate,
      end: localYmd(),
    });
    fetch(`/api/v1/fund/nav/history?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        if (controller.signal.aborted) return;
        if (!json?.ok || !Array.isArray(json.data)) {
          setFundNavHistoryState({ code: fundCode, loading: false, error: String(json?.error ?? "历史净值加载失败"), data: [] });
          return;
        }
        const data = json.data
          .map((item: any) => ({
            date: String(item?.date ?? "").slice(0, 10),
            nav: toNumber(item?.nav),
            cumNav: item?.cumNav == null ? null : toNumber(item.cumNav),
          }))
          .filter((item: FundNavHistoryPoint) => item.date && Number.isFinite(item.nav) && item.nav > 0)
          .sort((a: FundNavHistoryPoint, b: FundNavHistoryPoint) => a.date.localeCompare(b.date));
        setFundNavHistoryState({ code: fundCode, loading: false, error: "", data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFundNavHistoryState({ code: fundCode, loading: false, error: error instanceof Error ? error.message : "历史净值加载失败", data: [] });
      });
    return () => controller.abort();
  }, [fundCode, selectedFundChartStartDate, showSelectedFundChart]);

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

    const available = (list || []).map((p: any) => positionAssetKey(p)).filter(Boolean);



    const q = new URLSearchParams(baseQuery);

    q.set("view", view);

    if (showCleared) q.set("showCleared", "1");

    else q.delete("showCleared");



    if (available.length === 0) {

      if (fundCode) setFundCode("");
      if (fundChartOpen) setFundChartOpen(false);

      q.delete("fundCode");
      q.delete("wealthProductId");

      window.history.replaceState(null, "", `/?${q.toString()}`);

      return;

    }



    if (isWealthAccount) {
      if (fundCode && !available.includes(fundCode)) {
        setFundCode("");
        setFundPage(1);
        q.delete("wealthProductId");
      } else if (fundCode) {
        q.set("wealthProductId", fundCode);
      }
      q.delete("fundCode");
      window.history.replaceState(null, "", `/?${q.toString()}`);
      return;
    }

    if (!fundCode || !available.includes(fundCode)) {

      const next = available[0]!;

      setFundCode(next);
      setFundChartOpen(false);

      setFundPage(1);

      q.delete("fundCode");
      q.delete("wealthProductId");

      window.history.replaceState(null, "", `/?${q.toString()}`);

    }

  }, [baseQuery, view, showCleared, fundCode, fundChartOpen, sortedPositions, sortedClearedPositions, isWealthAccount, positionAssetKey]);



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
        selectedRecordLabel: isWealthAccount ? "理财交易" : "基金交易",
        counterpartRecordLabel: "资金交易",
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
      dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });

    } catch {

      setBatchDeleteMessage("批量删除失败");

    } finally {

      setBatchDeleting(false);

    }

  }

  async function deleteDetailEntry(entry: any) {
    const id = String(entry?.id ?? "");
    if (!id || singleDeletingIds.has(id)) return;
    setSingleDeletingIds((prev) => new Set(prev).add(id));
    setBatchDeleteMessage("");
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: [id],
        confirmMessage: `确认删除这条${isWealthAccount ? "理财" : "基金"}明细？删除后会进入回收站。`,
        selectedRecordLabel: isWealthAccount ? "理财交易" : "基金交易",
        counterpartRecordLabel: "资金交易",
      });
      if (!data.ok) {
        if (data.error === "已取消删除") return;
        setBatchDeleteMessage(data.error ?? "删除失败");
        return;
      }
      const refreshEntryIds = getDeleteRefreshEntryIds(data, [id]);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      dispatchFinanceDataChanged({ reason: "entry-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
    } catch {
      setBatchDeleteMessage("删除失败");
    } finally {
      setSingleDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function linkDetailCashFlow(entry: any) {
    const id = String(entry?.id ?? "");
    const businessType =
      entry?.fundProductType === "wealth" || isWealthAccount
        ? "wealth"
        : entry?.fundProductType === "deposit"
          ? "deposit"
          : entry?.fundProductType === "metal"
            ? "metal"
            : "fund";
    const businessTransactionId = String(
      businessType === "fund" ? entry?.fundTransactionId ?? entry?.businessTransactionId ?? "" : entry?.businessTransactionId ?? "",
    ).trim();
    if (!id || linkingIds.has(id)) return;
    if (!businessTransactionId) {
      window.alert(`这条${businessType === "wealth" ? "理财" : "基金"}记录缺少业务记录 ID，无法自动建立关联`);
      return;
    }

    setLinkingIds((prev) => new Set(prev).add(id));
    setBatchDeleteMessage("");
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType, businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? "建立关联失败");
      }
      setBatchDeleteMessage("已建立资金侧关联");
      dispatchFinanceDataChanged({
        reason: "business-link-cash-flow",
        accountIds: [entry.accountId, entry.toAccountId].filter(Boolean),
        entryIds: [data.data?.cashEntryId, id].filter(Boolean),
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "建立关联失败");
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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

        onChange={(values) => setColumnFilters((prev) => {
          if (!values || values.length === 0) {
            const next = { ...prev };
            delete next[column];
            return next;
          }
          return { ...prev, [column]: values };
        })}

      />

    );

  };



  return (

    <div className="flex-1 min-h-0 flex flex-col bg-transparent p-4 md:p-5">

      <ResizableVerticalSplit
        storageKey={`mmh:fund-shell:${accountId}:split-height`}
        hasLowerPane
        defaultUpperHeight={360}
        separatorLabel={`调整${isWealthAccount ? "理财" : "基金"}持仓和明细高度`}
        separatorTitle={`拖动调整${isWealthAccount ? "理财" : "基金"}持仓和明细高度`}
        stackOnMobile
        stackLowerFirstOnMobile={false}
      >

      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">

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
              listenCreateEvents={false}
              fundUnitsDecimals={fundUnitsDecimals}
            />

            <div className="flex items-center gap-0.5">

              <button onClick={() => toggleCleared(false)} className={`h-6 px-2 rounded text-xs ${!showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{holdingTabLabel}</button>

              {!isMetalAccount ? <button onClick={() => toggleCleared(true)} className={`h-6 px-2 rounded text-xs ${showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{clearedTabLabel}</button> : null}

            </div>

          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 min-h-[24px]">

            <Link
              href={`/?accountId=${encodeURIComponent(accountId)}&view=detail&detailAll=1`}
              className="secondary-button h-7 px-2 text-xs"
            >
              全部交易
            </Link>

          </div>

        </div>

        <div ref={summaryTableViewportRef} className="flex-1 min-h-0 overflow-hidden">
          <div className="block h-full overflow-y-auto overscroll-contain px-3 pb-4 pt-2 md:hidden">
            {!showCleared ? (
              sortedPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">暂无持仓数据</div>
              ) : (
                <div className="space-y-2.5">
                  {sortedPositions.map((p: any) => {
                    const positionKey = positionAssetKey(p);
                    const active = positionKey === fundCode;
                    const adj = adjustedNavByCode[p.fundCode];
                    const displayMV = adj && p.units > 0 ? p.units * adj.nav : p.marketValue;
                    const displayPnL = adj ? displayMV - p.cost : p.floatingPnL;
                    const displayPnLRate = p.cost > 0 ? (displayPnL / p.cost) * 100 : 0;
                    return (
                      <article
                        key={positionKey || p.fundCode}
                        className={`rounded-lg border bg-white px-3 py-3 shadow-sm ${
                          active ? "border-blue-200 bg-blue-50/70" : "border-slate-200"
                        }`}
                        onClick={() => switchFund(positionKey)}
                        onDoubleClick={() => {
                          if (!isWealthAccount) openPositionEntryModal(p);
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-sm font-semibold ${active ? "text-blue-700" : "text-slate-900"}`} title={isWealthAccount ? p.name : `${p.name} ${p.fundCode}`}>
                              {p.name}
                            </div>
                            {!isWealthAccount && p.fundCode !== p.name ? (
                              <div className={`mt-1 text-[11px] tabular-nums ${pnl(displayPnL)}`}>{p.fundCode}</div>
                            ) : null}
                            {isWealthAccount ? <div className="mt-1 text-[11px] text-slate-400">{p.holdingDate || "持仓日期 -"}</div> : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <div className={`text-base font-semibold tabular-nums ${pnl(displayMV)}`}>{formatMoney(displayMV)}</div>
                            <div className={`mt-0.5 text-[11px] tabular-nums ${pnl(displayPnLRate)}`}>{displayPnLRate.toFixed(2)}%</div>
                          </div>
                        </div>

                        <div className="mt-2 grid grid-cols-4 gap-x-2">
                          <FundMobileDetailItem label={isMetalAccount ? "数量" : "份额"} value={isWealthAccount && !p.hasUnits ? "-" : formatFundUnits(p.units)} alignRight />
                          <FundMobileDetailItem label="均价" value={isWealthAccount && !p.hasUnits ? "-" : p.avgCost.toFixed(4)} alignRight />
                          <FundMobileDetailItem label="成本" value={formatMoney(p.cost)} alignRight />
                          <FundMobileDetailItem label="收益" value={formatMoney(displayPnL)} valueClassName={pnl(displayPnL)} alignRight />
                        </div>

                      </article>
                    );
                  })}
                </div>
              )
            ) : (
              sortedClearedPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">{noClearedText}</div>
              ) : (
                <div className="space-y-2.5">
                  {sortedClearedPositions.map((c: any) => {
                    const clearedKey = positionAssetKey(c);
                    const active = clearedKey === fundCode;
                    return (
                      <article
                        key={clearedKey || c.fundCode}
                        className={`rounded-lg border bg-white px-3 py-3 shadow-sm ${
                          active ? "border-blue-200 bg-blue-50/70" : "border-slate-200"
                        }`}
                        onClick={() => switchFund(clearedKey)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-sm font-semibold ${active ? "text-blue-700" : "text-slate-900"}`} title={isWealthAccount ? c.name : `${c.name} ${c.fundCode}`}>
                              {c.name}
                            </div>
                            {!isWealthAccount && c.fundCode ? <div className="mt-1 text-[11px] tabular-nums text-slate-400">{c.fundCode}</div> : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <div className={`text-base font-semibold tabular-nums ${pnl(c.historicalProfit)}`}>{formatMoney(c.historicalProfit)}</div>
                            <div className={`mt-0.5 text-[11px] tabular-nums ${pnl(c.returnRate)}`}>{(c.returnRate * 100).toFixed(2)}%</div>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                          <FundMobileDetailItem label="初次购买" value={c.firstBuyDate || "-"} />
                          <FundMobileDetailItem label="清仓时间" value={c.clearedDate || "-"} />
                          <FundMobileDetailItem label="申购金额" value={formatMoney(c.totalBuyAmount)} alignRight />
                          <FundMobileDetailItem label="回收金额" value={formatMoney(c.totalRedeemAmount)} alignRight />
                        </div>
                      </article>
                    );
                  })}
                </div>
              )
            )}
          </div>

          <div className="hidden h-full overflow-x-auto overflow-y-auto md:block">

          {!showCleared ? (

            <table
              className="table-fixed border-separate border-spacing-0 [&_td]:border-r [&_td]:border-slate-100 [&_th]:border-r [&_th]:border-slate-200"
              style={{ minWidth: minFundTableWidth("positions", positionCols), width: positionLayout.tableWidth }}
            >
              <colgroup>
                {positionCols.map(([key, fallback]) => (
                  <col key={key} style={{ width: positionLayout.colWidths[key] ?? colWidth("positions", key, fallback) }} />
                ))}
              </colgroup>

              <thead className="sticky top-0 z-10 bg-white">

                <tr>

                  <SortHead sk="fundCode" label={assetNameLabel} cls="text-left text-xs font-semibold text-slate-600 px-4 py-2 border-b border-slate-200" table="positions" colKey="fund" width={colWidth("positions", "fund", 260)} minWidth={160} />

                  {isWealthAccount ? (
                    <SortHead sk="holdingDate" label="持仓日期" cls="text-left text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="holdingDate" width={colWidth("positions", "holdingDate", 96)} minWidth={78} />
                  ) : null}

                  <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                    {isMetalAccount ? "数量" : "份额"}
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
                    未确认金额
                    <ResizeGrip table="positions" colKey="pending" width={colWidth("positions", "pending", 78)} minWidth={58} />
                  </th>

                  <SortHead sk="floatingPnL" label="浮盈" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="floatingPnL" width={colWidth("positions", "floatingPnL", 104)} minWidth={76} />

                  <SortHead sk="floatingPnLRate" label="浮盈率" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="floatingRate" width={colWidth("positions", "floatingRate", 84)} minWidth={64} />

                  <SortHead sk="historicalProfit" label="历史收益" cls="text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200" table="positions" colKey="historical" width={colWidth("positions", "historical", 108)} minWidth={78} />

                  <th className="relative select-none text-center text-xs font-semibold text-slate-600 px-2 py-2 border-b border-slate-200">
                    <span className="sr-only">Action buttons</span>
                    <ResizeGrip table="positions" colKey="actions" width={colWidth("positions", "actions", 112)} minWidth={88} />
                  </th>

                </tr>

              </thead>

              <tbody className="text-sm">

                {sortedPositions.length === 0 ? (

                  <tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={positionCols.length}>暂无持仓数据</td></tr>

                ) : sortedPositions.map((p: any) => {

                  const positionKey = positionAssetKey(p);

                  const active = positionKey === fundCode;

                  const adj = adjustedNavByCode[p.fundCode];

                  const displayNav = adj ? adj.nav : p.nav;

                  const displayNavDate = adj ? adj.date : p.navDate;

                  const displayMV = adj && p.units > 0 ? p.units * adj.nav : p.marketValue;

                  const displayPnL = adj ? displayMV - p.cost : p.floatingPnL;

                  const displayPnLRate = p.cost > 0 ? (displayPnL / p.cost) * 100 : 0;

                  return (

                    <tr

                      key={positionKey || p.fundCode}

                      onClick={() => switchFund(positionKey)}
                      onDoubleClick={() => {
                        if (!isWealthAccount) openPositionEntryModal(p);
                      }}

                      className={`cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`}

                    >

                      <td className="px-4 py-1.5 border-b border-slate-100"><span className={`block truncate text-xs font-medium ${active ? "text-blue-700" : "text-slate-700"}`} title={isWealthAccount ? p.name : `${p.name} ${p.fundCode}`}>{p.name}{!isWealthAccount && p.fundCode !== p.name && <span className={`ml-1 ${pnl(displayPnL)}`}>{p.fundCode}</span>}</span></td>

                      {isWealthAccount ? (
                        <td className="px-3 py-1.5 border-b border-slate-100 text-left text-xs tabular-nums text-slate-600">{p.holdingDate || "-"}</td>
                      ) : null}

                      <td className="px-3 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums">
                        {isWealthAccount && !p.hasUnits ? <span className="text-slate-300">-</span> : formatFundUnits(p.units)}
                      </td>

                      <td className="px-2 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums">
                        {isWealthAccount && !p.hasUnits ? <span className="text-slate-300">-</span> : p.avgCost.toFixed(4)}
                      </td>

                      <td className="overflow-hidden px-2 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums">

                        <div className="flex min-w-0 items-center justify-end gap-0.5">

                          <span className="min-w-0 truncate">{displayNav != null ? displayNav.toFixed(4) : "-"}{displayNavDate ? <span className="ml-0.5 text-slate-400">({displayNavDate})</span> : null}</span>

                        </div>

                      </td>

                      <td className="px-2 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums">{formatMoney(p.cost)}</td>

                      <td className={`px-2 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayMV)}`}>{formatMoney(displayMV)}</td>

                      <td className="px-2 py-1.5 border-b border-slate-100 text-right text-[11px] tabular-nums">{p.pendingCost > 0 ? <span className="text-amber-600 font-medium">{formatMoney(p.pendingCost)}</span> : <span className="text-slate-300">-</span>}</td>

                      <td className={`px-3 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayPnL)}`}>{formatMoney(displayPnL)}</td>

                      <td className={`px-3 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(displayPnLRate)}`}>{displayPnLRate.toFixed(2)}%</td>

                      <td className={`px-3 py-1.5 border-b border-slate-100 text-right text-xs tabular-nums ${pnl(p.historicalProfit)}`}>{formatMoney(p.historicalProfit)}</td>

                      <td className="px-2 py-1 border-b border-slate-100" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
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
                                    className={`relative inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors disabled:opacity-50 ${
                                      isPaused
                                        ? "border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300 hover:bg-amber-100"
                                        : "border-blue-200 bg-blue-50 text-blue-700 hover:border-blue-300 hover:bg-blue-100"
                                    }`}
                                    title={isPaused ? "当前已暂停，点击选择继续或编辑" : "当前执行中，点击选择暂停或编辑"}
                                    aria-haspopup="menu"
                                    aria-expanded={menuOpen}
                                  >
                                    <CalendarSync className="h-3 w-3" />
                                    {isPaused ? (
                                      <span aria-hidden="true" className="absolute right-0 top-0 flex h-1.5 w-1.5 items-center justify-center rounded-full bg-amber-500 ring-1 ring-white">
                                        <span className="h-1 w-[1px] rounded-full bg-white" />
                                        <span className="ml-[1px] h-1 w-[1px] rounded-full bg-white" />
                                      </span>
                                    ) : (
                                      <span aria-hidden="true" className="absolute right-0 top-0 flex h-1.5 w-1.5 items-center justify-center rounded-full bg-emerald-500 ring-1 ring-white">
                                        <span className="ml-px h-0 w-0 border-y-[1.5px] border-l-[2.5px] border-y-transparent border-l-white" />
                                      </span>
                                    )}
                                  </button>
                                  {menuOpen ? (
                                    <div
                                      className="absolute right-0 top-7 z-50 w-28 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-left shadow-lg"
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
                          {!isMetalAccount && !isWealthAccount ? (
                            <>
                              <AddNavButton accountId={accountId} positions={[p]} defaultFundCode={p.fundCode} trigger="icon" />
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  switchFund(positionKey || p.fundCode);
                                  setFundChartOpen(true);
                                }}
                                className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors ${
                                  active && fundChartOpen
                                    ? "border-blue-300 bg-blue-50 text-blue-700"
                                    : "border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                                }`}
                                title="查看基金曲线图"
                                aria-label="查看基金曲线图"
                              >
                                <ChartLine className="h-3 w-3" />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </td>

                    </tr>

                  );

                })}

              </tbody>

              {d.positions.length > 0 && (

                <tfoot className="sticky bottom-0 bg-slate-50/95 font-semibold backdrop-blur">

                  <tr>

                    <td className="px-4 py-2 border-t border-slate-200 text-xs text-slate-700" colSpan={isWealthAccount ? 5 : 4}>汇总</td>

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

                  const clearedKey = positionAssetKey(c);

                  const active = clearedKey === fundCode;

                  return (

                    <tr

                      key={clearedKey || c.fundCode}

                      onClick={() => switchFund(clearedKey)}

                    className={`cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`}

                    >

                      <td className="px-4 py-2 border-b border-slate-100"><span className={`block truncate text-xs font-medium ${active ? "text-blue-700" : "text-slate-700"}`} title={isWealthAccount ? c.name : `${c.name} ${c.fundCode}`}>{c.name}{!isWealthAccount && <span className="ml-1 text-slate-400">{c.fundCode}</span>}</span></td>

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

      {showSelectedFundChart ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/10 p-4"
          onClick={() => setFundChartOpen(false)}
        >
          <div
            className="w-[min(720px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">{selectedFundNameForChart || fundCode}</div>
                <div className="text-xs tabular-nums text-slate-400">{fundCode}</div>
              </div>
              <button
                type="button"
                onClick={() => setFundChartOpen(false)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                title="收起曲线图"
                aria-label="收起曲线图"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <FundTrendChart
              fundName={selectedFundNameForChart}
              fundCode={fundCode}
              history={fundNavHistoryState.code === fundCode ? fundNavHistoryState.data : []}
              entries={selectedFundChartEntries}
              confirmDays={selectedFundConfirmDays}
              loading={fundNavHistoryState.code === fundCode && fundNavHistoryState.loading}
              error={fundNavHistoryState.code === fundCode ? fundNavHistoryState.error : ""}
              mode={fundChartMode}
              range={fundChartRange}
              upClassName={upCls}
              downClassName={downCls}
              onModeChange={setFundChartMode}
              onRangeChange={setFundChartRange}
              embedded
            />
          </div>
        </div>
      ) : null}

      <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">

      {/* 交易明细 */}

      <div className={`panel-surface flex min-h-0 flex-col overflow-hidden ${detailCollapsed ? "shrink-0" : "flex-1"}`}>

        <div className="panel-header shrink-0">

          <button
            type="button"
            onClick={() => setDetailCollapsed((value) => !value)}
            className="flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-slate-800"
            title={detailCollapsed ? "展开交易明细" : "收起交易明细"}
          >
            {detailCollapsed ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />}
            <span className="shrink-0">交易明细</span>

            {fundCode && (
              <span className={`ml-2 text-xs font-normal ${selectedFundCodeCls}`}>
                {isWealthAccount ? selectedPosition?.name ?? "" : fundCode}
              </span>
            )}

            <span className="ml-2 text-xs text-slate-400 font-normal">{fundCode || isWealthAccount ? `${filteredByColumns.length}/${filtered.length}` : chooseHoldingText}</span>

          </button>

          <div className={`${detailCollapsed ? "hidden" : "flex"} min-w-0 max-w-[62vw] items-center gap-1 overflow-x-auto whitespace-nowrap pb-0.5 text-xs md:max-w-none md:overflow-visible [&>*]:shrink-0`}>

            {isWealthAccount ? (
              <button
                type="button"
                onClick={toggleAllWealthEntries}
                className={`h-6 px-2 rounded border flex items-center gap-1 ${
                  !fundCode
                    ? "border-blue-300 bg-blue-50 text-blue-700 font-medium"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600"
                }`}
                title={fundCode ? "显示当前理财账户下所有交易" : "取消所有交易，回到单个理财产品"}
              >
                所有交易
              </button>
            ) : null}

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

                    {DETAIL_COLS.filter(([key]) =>
                      !(isWealthAccount && key === "status") &&
                      !(!isWealthAccount && key === "remainingUnits") &&
                      !(isSingleNormalFundScope && key === "fund") &&
                      !FIXED_DETAIL_COLUMNS.has(key)
                    ).map(([key]) => {
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

        {detailCollapsed ? null : (
        <>
        <div className="block flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-28 pt-2 md:hidden">
          {paged.length > 0 ? (
            <div className="space-y-2.5">
              {paged.map((e: any) => {
                const units = displayUnitsOf(e);
                const nav = e.fundNav != null ? toNumber(e.fundNav) : null;
                const amount = detailAmountOf(e);
                const info = fl(e.fundSubtype, e.source);
                const detailSubtypeLabel = isSingleNormalFundScope ? (info as { shortLabel?: string }).shortLabel ?? info.label : info.label;
                const cashInfo = cashAccountInfoOf(e);
                const status = statusOf(e);
                const profit = e.realizedProfit != null && (e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash")
                  ? toNumber(e.realizedProfit)
                  : null;
                const selected = selectedIds.has(e.id);
                const businessLinkInfo = entryBusinessLinkInfo(e);
                const businessLinkTitle = businessLinkInfo.active
                  ? (businessLinkInfo.labels.length > 0 ? businessLinkInfo.labels.join("；") : "已关联资金流水")
                  : "未关联";

                return (
                  <article
                    key={e.id}
                    className={`rounded-lg border bg-white shadow-sm transition-colors ${
                      selected ? "border-blue-200 bg-blue-50/70" : "border-slate-200"
                    }`}
                    onClick={() => setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.id)) next.delete(e.id);
                      else next.add(e.id);
                      return next;
                    })}
                    onDoubleClick={() => openDetailEdit(e.id)}
                  >
                    <div className="flex items-start justify-between gap-3 px-3 pt-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls
                          }`}>
                            {detailSubtypeLabel}
                          </span>
                          <span className="truncate text-sm font-semibold text-slate-900" title={displayFundName(e)}>
                            {displayFundName(e)}
                          </span>
                        </div>
                        {!isWealthAccount && e.fundCode && !isSingleNormalFundScope ? (
                          <div className="mt-1 truncate text-[11px] tabular-nums text-slate-400">{e.fundCode}</div>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-base font-semibold tabular-nums text-slate-900">
                          {e.source === "dividend" || e.fundSubtype === "dividend_cash" ? (
                            <span className={upCls}>+{formatMoney(Math.abs(amount))}</span>
                          ) : formatMoney(Math.abs(amount))}
                        </div>
                        <div className={`mt-0.5 text-[11px] ${status === "确认" || status === "买入退回" ? "text-emerald-700" : status === "暂停申购" ? "text-rose-600" : "text-amber-600"}`}>
                          {status}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 px-3 text-xs">
                      <FundMobileDetailItem label="申请日期" value={fundApplyDateOf(e) || "-"} />
                      <FundMobileDetailItem label="到账日期" value={e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : "-"} />
                      <FundMobileDetailItem label={navColumnLabel} value={nav != null ? nav.toFixed(4) : "-"} alignRight />
                      <FundMobileDetailItem label={isMetalAccount ? "数量" : "份额"} value={units != null ? formatFundUnits(units) : "-"} alignRight />
                      {isWealthAccount ? (
                        <FundMobileDetailItem
                          label="剩余份额"
                          value={e.wealthRemainingUnits != null ? formatFundUnits(toNumber(e.wealthRemainingUnits)) : "-"}
                          alignRight
                        />
                      ) : null}
                      {profit != null ? (
                        <FundMobileDetailItem label="收益" value={formatMoney(profit)} valueClassName={pnl(profit)} alignRight />
                      ) : null}
                      <FundMobileDetailItem label="资金账户" value={cashInfo?.label && cashInfo.label !== "(空)" ? cashInfo.label : "-"} wide />
                    </div>

                    <div
                      className="mt-3 flex items-center justify-between border-t border-slate-100 px-3 py-2"
                      onClick={(ev) => ev.stopPropagation()}
                      onDoubleClick={(ev) => ev.stopPropagation()}
                    >
                      <label className="flex h-8 items-center gap-2 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(e.id)) next.delete(e.id);
                            else next.add(e.id);
                            return next;
                          })}
                          className="h-4 w-4 accent-blue-600"
                          aria-label={`选择${isWealthAccount ? "理财" : "基金"}交易明细`}
                        />
                        选择
                      </label>
                      <div className="flex items-center gap-1.5">
                        {!isWealthAccount && e.fundCode && e.fundSubtype === "buy" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? (
                          <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} onFilled={(data) => handleEntryNavFilled(e, data)} />
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            if (!businessLinkInfo.active) void linkDetailCashFlow(e);
                          }}
                          disabled={businessLinkInfo.active || linkingIds.has(String(e.id ?? ""))}
                          className={[
                            "flex h-8 w-8 items-center justify-center rounded border bg-white transition-colors disabled:cursor-default",
                            businessLinkInfo.active
                              ? "border-slate-200 text-slate-500"
                              : "border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-60",
                          ].join(" ")}
                          title={businessLinkInfo.active ? businessLinkTitle : linkingIds.has(String(e.id ?? "")) ? "正在建立资金侧关联..." : "未关联，点击建立资金侧关联"}
                          aria-label={businessLinkInfo.active ? businessLinkTitle : "未关联，点击建立资金侧关联"}
                        >
                          <LinkStatusIcon active={businessLinkInfo.active} title={businessLinkTitle} />
                        </button>
                        <button
                          type="button"
                          onClick={() => openDetailEdit(e.id)}
                          className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
                          title="编辑按钮"
                          aria-label="编辑按钮"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { void deleteDetailEntry(e); }}
                          disabled={singleDeletingIds.has(String(e.id ?? ""))}
                          className="flex h-8 w-8 items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                          title={singleDeletingIds.has(String(e.id ?? "")) ? "删除中..." : "删除按钮"}
                          aria-label={singleDeletingIds.has(String(e.id ?? "")) ? "删除中..." : "删除按钮"}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
              {fundCode || isWealthAccount ? "暂无交易记录" : chooseHoldingText}
            </div>
          )}
        </div>
        <div
          ref={detailTableViewportRef}
          className={`hidden flex-1 min-h-0 pb-10 md:block ${needsDetailHorizontalScroll ? "overflow-x-auto" : "overflow-x-hidden"} overflow-y-auto overscroll-contain`}
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

                            <DateStepper
                              value={dateFrom}

                              onChange={(value) => { setFundPage(1); setDateFrom(value); }}

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

                            <DateStepper
                              value={dateTo}

                              onChange={(value) => { setFundPage(1); setDateTo(value); }}

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
                  {isMetalAccount ? "数量" : "份额"}
                  <ResizeGrip table="details" colKey="units" width={colWidth("details", "units", 84)} minWidth={64} />
                </th>
                ) : null}

                {isDetailColumnVisible("remainingUnits") ? (
                <th className="relative select-none text-right text-xs font-semibold text-slate-600 px-3 py-2 border-b border-slate-200">
                  剩余份额
                  <ResizeGrip table="details" colKey="remainingUnits" width={colWidth("details", "remainingUnits", 92)} minWidth={72} />
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
                  {isWealthAccount ? "入账/出账金额" : "金额"}
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

                      buttonTitle="编辑按钮"

                      buttonClassName="h-7 w-7 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"

                      onApply={applyBatch}

                    />

                    <button

                      type="button"

                      onClick={applyBatchDelete}

                      disabled={batchTargetIds.length === 0 || batchDeleting}

                      className="h-7 w-7 rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"

                      title={batchTargetIds.length === 0 ? "请先勾选记录" : "删除按钮"}

                      aria-label={batchTargetIds.length === 0 ? "请先勾选记录再批量删除" : "删除按钮"}

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

                const amount = detailAmountOf(e);

                const nav = e.fundNav != null ? toNumber(e.fundNav) : null;

                const units = displayUnitsOf(e);

                const info = fl(e.fundSubtype, e.source);
                const detailSubtypeLabel = isSingleNormalFundScope ? compactFundSubtypeLabel(e, info.label) : info.label;

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
                const businessLinkInfo = entryBusinessLinkInfo(e);
                const businessLinkTitle = businessLinkInfo.active
                  ? `已关联${businessLinkInfo.labels.length ? `：${businessLinkInfo.labels.join("、")}` : ""}`
                  : "未关联";

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

                    onDoubleClick={() => openDetailEdit(e.id)}

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
                      <div className="truncate" title={isWealthAccount ? displayFundName(e) : `${displayFundName(e)} ${e.fundCode || ""}`}>
                        {displayFundName(e)}{!isWealthAccount && e.fundCode && displayFundName(e) !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}
                      </div>
                    </td>
                    ) : null}

                    {isDetailColumnVisible("nav") ? (
                    <td className="overflow-hidden whitespace-nowrap px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{nav != null ? nav.toFixed(4) : <span className="text-slate-400">-</span>}</td>
                    ) : null}

                    {isDetailColumnVisible("units") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums">{units != null ? formatFundUnits(units) : <span className="text-slate-400">-</span>}</td>
                    ) : null}

                    {isDetailColumnVisible("remainingUnits") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-right text-xs tabular-nums text-slate-600">
                      {e.wealthRemainingUnits != null ? formatFundUnits(toNumber(e.wealthRemainingUnits)) : <span className="text-slate-400">-</span>}
                    </td>
                    ) : null}

                    {isDetailColumnVisible("subtype") ? (
                    <td className="px-3 py-1 border-b border-slate-100 text-xs"><span className={`px-1 py-0.5 rounded text-[10px] font-medium ${e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls}`}>{detailSubtypeLabel}</span></td>
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

                      {e.realizedProfit != null && (e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash") ? formatMoney(toNumber(e.realizedProfit)) : <span className="text-slate-300">-</span>}

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

                              id: e.id,
                              transactionId: e.id,
                              cashEntryId: e.cashEntryId ?? null,
                              businessTransactionId: e.businessTransactionId ?? null,

                              date: fmtDate(e.date),

                              amount: toNumber(e.amount), note: e.note ?? null,

                              fundName: displayFundName(e) === "-" ? null : displayFundName(e),

                              fundProductType: e.fundProductType ?? null,

                              fundSubtype: e.fundSubtype ?? null,

                              wealthProductId: e.wealthProductId ?? null,

                              fundUnits: displayUnitsOf(e) ?? (e.fundUnits != null ? toNumber(e.fundUnits) : null),

                              fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,

                              fundArrivalDate: fmtDate(e.fundArrivalDate) || null,

                              fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,

                              depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,

                              accountId: e.accountId ?? null,

                              toAccountId: e.toAccountId ?? null,

                              toAccountName: e.toAccountName ?? null,

                            }}

                            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}

                            cashAccounts={cashAccounts}

                            investmentAccounts={investmentAccounts}

                            cashAccountSSOptions={cashAccountSSOptions}

                            investmentAccountSSOptions={investmentAccountSSOptions}

                            wealthHoldingOptions={props.wealthHoldingOptions ?? []}

                            nestedFieldData={nestedFieldData}

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
                            fundUnitsDecimals={fundUnitsDecimals}
                            hideTrigger

                          />

                        )}

                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            if (!businessLinkInfo.active) void linkDetailCashFlow(e);
                          }}
                          disabled={businessLinkInfo.active || linkingIds.has(String(e.id ?? ""))}
                          className={[
                            "flex h-6 w-6 items-center justify-center rounded border bg-white transition-colors disabled:cursor-default",
                            businessLinkInfo.active
                              ? "border-slate-200 text-slate-500"
                              : "border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-60",
                          ].join(" ")}
                          title={businessLinkInfo.active ? businessLinkTitle : linkingIds.has(String(e.id ?? "")) ? "正在建立资金侧关联..." : "未关联，点击建立资金侧关联"}
                          aria-label={businessLinkInfo.active ? businessLinkTitle : "未关联，点击建立资金侧关联"}
                        >
                          <LinkStatusIcon active={businessLinkInfo.active} title={businessLinkTitle} />
                        </button>

                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            openDetailEdit(e.id);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
                          title="编辑按钮"
                          aria-label="编辑按钮"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => { void deleteDetailEntry(e); }}
                          disabled={singleDeletingIds.has(String(e.id ?? ""))}
                          className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                          title={singleDeletingIds.has(String(e.id ?? "")) ? "删除中..." : "删除按钮"}
                          aria-label={singleDeletingIds.has(String(e.id ?? "")) ? "删除中..." : "删除按钮"}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>

                      </div>

                    </td>

                  </tr>

                );

              }) : (<tr><td className="px-4 py-6 text-xs text-slate-500" colSpan={visibleDetailCols.length}>{fundCode || isWealthAccount ? "暂无交易记录" : chooseHoldingText}</td></tr>)}

            </tbody>

          </table>

        </div>
        </>
        )}

      </div>

      </div>

      </ResizableVerticalSplit>

    </div>

  );

}
