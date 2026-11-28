"use client";

import { canRefreshCurrentRoute, replaceCurrentRouteUrl } from "@/lib/client/route-url-sync";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { TRANSACTION_SOURCE_MONEY_INCOME } from "@/lib/transaction-semantics";
import { BALANCE_RECONCILE_SOURCE } from "@/lib/balance-reconcile";
import { X } from "lucide-react";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DebitBalanceReconcileButton } from "@/components/DebitBalanceReconcileButton";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { foldRunningBalancesInDescOrder, removeEntriesAndUpdateRunningBalances } from "@/lib/detail-running-balance";
import { HANDSET_HIDDEN_CLASS, ViewExcelImportMenuButton } from "@/components/ViewExcelImportMenuButton";
import {
  FINANCE_DATA_CHANGED_EVENT,
  applyReconcileRecords,
  classifyFinanceEntryChange,
  financeChangeAffectsAccount,
  isBulkFinanceEntryChange,
  type FinanceDataChangedDetail,
} from "@/lib/client/refresh";
import { formatDateUtc, todayDateBusinessYmd } from "@/lib/date-utils";
import { getTimeZonePreference } from "@/lib/client/appPreferences";
import { getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  DETAIL_PAGE_SIZE_OPTIONS,
  DETAIL_PRELOAD_IDLE_DELAY_MS,
  clampDetailPage as clampPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
  writeStoredDetailPreference,
  writeStoredDetailRangePreference,
} from "@/lib/detail-pagination-preference";
import { isAbortError } from "@/lib/client/detail-all-entries";
import {
  parseDetailFiltersParam,
  parseDetailTableFiltersParam,
  type DetailFilterDict,
} from "@/lib/detail-search";
import {
  detailAllCacheKey,
  detailRangeCovers,
  dropDetailAllCache,
  ensureDetailAll,
  filterEntriesByRange,
  invalidateDetailAll,
  isDetailAllReady,
  patchDetailAllRowFields,
  patchDetailAllRows,
  peekDetailAll,
  subscribeDetailAll,
  subscribeDetailAllCacheAvailability,
  type DetailAllSnapshot,
} from "@/lib/client/detail-all-store";
import { useI18n } from "@/lib/i18n";
import {
  invalidateDetailOpeningBalance,
  loadDetailOpeningBalance,
  peekDetailOpeningBalance,
} from "@/lib/client/detail-opening-balance";
import { useDetailPagination } from "@/lib/client/use-detail-pagination";
import { ALL_CASH_DETAIL_SCOPE_ID, isAllCashDetailScope } from "@/lib/all-cash-entries";

/** 一页明细分页请求的结果：只保留渲染真正需要的两样。 */
type DetailPagePayload = {
  entries: DetailEntry[];
  totalCount: number | null;
};

/**
 * 进入表头筛选前那一帧的未筛选第 1 页。
 *
 * 后台整份缓存分 5000 行/块加载，用户可能在它到齐前就筛选；取消筛选时先拿这份
 * 快照把第 1 页和「共 N 条」瞬间还原，服务端重取留在后台做。只在同一视图 /
 * 时间轴 / 收益口径 / 页大小下复用，且金融事件一到就作废。
 */
type UnfilteredPageSnapshot = {
  key: string;
  entries: DetailEntry[];
  totalCount: number;
  originalCount: number;
  at: number;
};
const UNFILTERED_PAGE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

/**
 * 取一页明细（`/api/v1/transactions/detail`）。
 *
 * 分页取数与下一页预取共用同一段解析：两边各写一份，迟早一边忘了读 `totalCount`，
 * 表现就是翻页后「共 N 条」忽然变回当前页行数。
 */
async function loadDetailPagePayload(
  url: string,
  signal: AbortSignal | undefined,
  errorMessage: string,
): Promise<DetailPagePayload> {
  const response = await fetch(url, { signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? errorMessage);
  const entries = Array.isArray(payload.data?.entries) ? (payload.data.entries as DetailEntry[]) : [];
  const totalCount = Number(payload.data?.totalCount);
  return { entries, totalCount: Number.isFinite(totalCount) ? totalCount : null };
}

/**
 * 缓存是不是已经把「当前时间窗口」这份数据取全了。
 *
 * 两层判断，缺一不可：
 * 1. 缓存是按哪个范围拉的 —— 按「最近 5 年」拉完的缓存，遇到「最近 10 年」的窗口
 *    依然不够（`detailRangeCovers`）。
 * 2. 那次加载本身跑完了没有 —— 没跑完时，缓存从最新往回拉，所以只要已加载到的最旧
 *    一天不晚于窗口起点，窗口内的行就已经齐了。
 */
function detailCacheCoversWindow<T extends { date?: string | null }>(
  snapshot: DetailAllSnapshot<T>,
  range: string | undefined,
): boolean {
  if (!detailRangeCovers(snapshot.range, range)) return false;
  if (snapshot.done) return true;
  const from = String(range ?? "").split("~")[0]?.trim() ?? "";
  if (!from) return false;
  const oldest = String(snapshot.entries[snapshot.entries.length - 1]?.date ?? "").slice(0, 10);
  return !!oldest && oldest <= from;
}

type BasicDetailPanelProps = {
  accountId: string;
  isInvestAccount: boolean;
  entries: DetailEntry[];
  initialEntriesFromClientCache?: boolean;
  initialClientDetailCacheHint?: boolean;
  totalCount: number;
  originalCount: number;
  hasDetailFilters: boolean;
  /** 绑定货基的电子钱包：表头把「交易类型」筛选换成「收益」开关。 */
  showMoneyIncomeToggle?: boolean;
  /** 「收益」开关是否勾上；默认不勾，勾选后明细才列出货基收益行。 */
  showMoneyIncome?: boolean;
  initialPage: number;
  initialPageSize: number;
  /**
   * 「显示范围」的初值（服务端已经按它查了这一页）。必须由 RSC 传进来：默认的
   * 近 5 年窗口要同时作用在首屏行、`共 N 条`、页码总数上，客户端自己算一个范围
   * 去重取的话，表头会先闪一遍全量数字。
   */
  initialDateRange?: { from: string; to: string };
  /**
   * 表头筛选（展示口径）的初值，由 RSC 从 URL 解析后传入。
   *
   * 不能只在客户端读 `window.location`：服务端渲染时读不到、首屏没有筛选徽标，客户端
   * 一上来又有，React 会判定 hydration 不一致并重建整棵子树（徽标先闪 `null`、再闪
   * `0/0`）。由服务端把同一份条件传下来，两边首帧才一致。
   */
  initialTableFilters?: DetailFilterDict;
  initialDetailAll: boolean;
  initialAutoFit?: boolean;
  normalExportFilename: string;
  normalExportRows?: string[][];
  normalExportRowsByEntryId?: Record<string, string[]>;
  /**
   * 明细导出按导出弹层里选的交易日期范围向服务端重取整份视图（而不是只导表格
   * 当前显示的那些行）。表格时间轴与表头筛选都不进入导出口径。
   *
   * 打开条件是「这个视图可以由服务端按账户 / 全部收支重取整份明细」，与表格
   * 当前是否分页、有没有表头筛选无关。
   */
  fullRangeExport?: boolean;
  /**
   * 账户单元格的显示来源，必须是**全量**账户（含投资 / 保险 / 定期 / 固定资产等），
   * 否则明细表的「账户 / 相关账户」列只能回退到原始账户名，丢了机构和 hover。
   */
  accountOptions: Array<{
    id: string;
    label: string;
    listLabel?: string | null;
    selectorLabel?: string | null;
    fullLabel?: string | null;
    title?: string | null;
    hoverTitle?: string | null;
    tableHoverTitle?: string | null;
    numberMasked?: string | null;
    kind?: string | null;
    liabilityDirection?: string | null;
    isSettlementAccount?: boolean | null;
  }>;
  /** 批量替换账户下拉用的选项；默认与 `accountOptions` 相同。 */
  batchReplaceAccountOptions?: Array<{ id: string; label: string; subLabel?: string | null; listLabel?: string | null; title?: string | null }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  showBalanceReconcile?: boolean;
  /** 是否显示批量「对账」按钮（锁定记录 + 钉住本行余额）。 */
  showReconcile?: boolean;
  showImportExport?: boolean;
  showAccountColumn?: boolean;
  showRunningBalance?: boolean;
  refreshOnGlobalEvent?: boolean;
  draggableRows?: boolean;
  sortable?: boolean;
  showPagination?: boolean;
  scopeAccountIds?: string[];
  /**
   * 该账户属于「全部收支」的账户集合（现金 / 借记卡 / 电子钱包 / 信用卡）。
   *
   * 为 true 时行数据不再单独拉一份：直接复用 `__all_cash__` 那份缓存，
   * 本地筛出本账户的行并补算余额。
   */
  deriveFromAllCashCache?: boolean;
  accountKind?: string | null;
  accountName?: string;
  accountLabel?: string;
  currentBalance?: number;
  focusEntryId?: string;
  showGuideOverlay?: boolean;
};

function detailPaginationFetchKey(accountId: string, pageSize: number, detailAll: boolean, detailPage: number) {
  return `${accountId}:${pageSize}:${detailAll ? "all" : detailPage}`;
}

function detailEntryDayKey(entry: DetailEntry, accountId: string) {
  return formatDateUtc(getDetailEntryDisplayDate(entry, accountId));
}

function findEntryIndexForDate(rows: DetailEntry[], dateYmd: string, accountId: string) {
  const dayKeys = rows.map((entry) => detailEntryDayKey(entry, accountId));
  let index = dayKeys.findIndex((key) => key === dateYmd);
  if (index >= 0) return index;
  if (dayKeys.length === 0) return -1;
  const descending = dayKeys.length < 2 || dayKeys[0] >= dayKeys[dayKeys.length - 1];
  index = dayKeys.findIndex((key) => (descending ? key <= dateYmd : key >= dateYmd));
  return index >= 0 ? index : dayKeys.length - 1;
}

type GuideRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type GuidePoint = {
  x: number;
  y: number;
};

type GuideMetrics = {
  width: number;
  height: number;
  panel: GuideRect | null;
  toolbar: GuideRect | null;
  toolbarActions: GuideRect | null;
  header: GuideRect | null;
  headerCell: GuideRect | null;
  rowControls: GuideRect | null;
  rowActions: GuideRect | null;
  entryButton: GuideRect | null;
  toolbarTools: GuideRect | null;
  columnSettings: GuideRect | null;
  resizeHandle: GuideRect | null;
  bodyRow: GuideRect | null;
  bodyRowFocus: GuideRect | null;
};

type GuideBoxStyle = CSSProperties & {
  left: number;
  top: number;
  width: number;
  height: number;
};

const GUIDE_TOOLTIP_WIDTH = 268;
const GUIDE_TOOLTIP_GAP = 8;

function visibleGuideRect(element: Element | null, rootRect: DOMRect): GuideRect | null {
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left - rootRect.left);
  const top = Math.max(0, rect.top - rootRect.top);
  const right = Math.min(rootRect.width, rect.right - rootRect.left);
  const bottom = Math.min(rootRect.height, rect.bottom - rootRect.top);
  const width = right - left;
  const height = bottom - top;
  if (width < 3 || height < 3) return null;
  return { left, top, right, bottom, width, height };
}

function firstVisibleGuideRect(root: HTMLElement, rootRect: DOMRect, selector: string): GuideRect | null {
  for (const element of Array.from(root.querySelectorAll(selector))) {
    const rect = visibleGuideRect(element, rootRect);
    if (rect) return rect;
  }
  return null;
}

function unionGuideRects(rects: Array<GuideRect | null | undefined>): GuideRect | null {
  const visibleRects = rects.filter((rect): rect is GuideRect => !!rect);
  if (visibleRects.length === 0) return null;
  const left = Math.min(...visibleRects.map((rect) => rect.left));
  const top = Math.min(...visibleRects.map((rect) => rect.top));
  const right = Math.max(...visibleRects.map((rect) => rect.right));
  const bottom = Math.max(...visibleRects.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function guideCenteredRect(rect: GuideRect | null, width: number, height: number): GuideRect | null {
  const center = guideCenter(rect);
  if (!center) return null;
  const left = center.x - width / 2;
  const top = center.y - height / 2;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function guideCenter(rect: GuideRect | null): GuidePoint | null {
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function expandedGuideRectStyle(rect: GuideRect, padding = 4): GuideBoxStyle {
  const left = Math.max(0, rect.left - padding);
  const top = Math.max(0, rect.top - padding);
  return {
    left,
    top,
    width: rect.width + (rect.left - left) + padding,
    height: rect.height + (rect.top - top) + padding,
  };
}

function clampGuidePosition(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function guideRectFromBoxStyle(style: GuideBoxStyle): GuideRect {
  return {
    left: style.left,
    top: style.top,
    right: style.left + style.width,
    bottom: style.top + style.height,
    width: style.width,
    height: style.height,
  };
}

function guideTooltipOffsetStyle(hotspotRect: GuideRect, guideWidth: number, guideHeight: number): CSSProperties {
  const width = Math.min(GUIDE_TOOLTIP_WIDTH, Math.max(180, guideWidth - 24));
  const absoluteLeft = clampGuidePosition(hotspotRect.left + hotspotRect.width / 2 - width / 2, 12, guideWidth - width - 12);
  const openAbove = hotspotRect.bottom + 120 > guideHeight && hotspotRect.top > 120;
  return openAbove
    ? { left: absoluteLeft - hotspotRect.left, bottom: hotspotRect.height + GUIDE_TOOLTIP_GAP, width }
    : { left: absoluteLeft - hotspotRect.left, top: hotspotRect.height + GUIDE_TOOLTIP_GAP, width };
}

function GuideHotspot({
  rect,
  guideWidth,
  guideHeight,
  style,
  tone = "blue",
  title,
  children,
}: {
  rect: GuideRect | null;
  guideWidth: number;
  guideHeight: number;
  style?: GuideBoxStyle;
  tone?: "blue" | "emerald";
  title: string;
  children: string;
}) {
  const { t } = useI18n();
  if (!rect) return null;
  const hotspotStyle = style ?? expandedGuideRectStyle(rect);
  const hotspotRect = guideRectFromBoxStyle(hotspotStyle);
  const tooltipStyle = guideTooltipOffsetStyle(hotspotRect, guideWidth, guideHeight);
  const hotspotToneClass = tone === "emerald"
    ? "border-emerald-500/55 bg-emerald-200/25 shadow-[0_0_0_1px_rgba(16,185,129,0.24)] hover:bg-emerald-200/35 focus-visible:ring-2 focus-visible:ring-emerald-500/60"
    : "border-blue-500/55 bg-blue-200/25 shadow-[0_0_0_1px_rgba(59,130,246,0.24)] hover:bg-blue-200/35 focus-visible:ring-2 focus-visible:ring-blue-500/60";
  const badgeToneClass = tone === "emerald"
    ? "border-emerald-200/80 bg-white/80 text-emerald-700"
    : "border-blue-200/80 bg-white/80 text-blue-700";
  const tooltipToneClass = tone === "emerald"
    ? "border-emerald-500/45 text-emerald-950"
    : "border-blue-500/45 text-blue-950";

  return (
    <div
      data-basic-detail-guide-hotspot={title}
      tabIndex={0}
      role="note"
      aria-label={`${title}：${children}`}
      title={t("basicDetail.guideHoverHint")}
      className={`group pointer-events-auto absolute z-20 cursor-help rounded-md border transition-colors outline-none ${hotspotToneClass}`}
      style={hotspotStyle}
    >
      {hotspotRect.width >= 40 && hotspotRect.height >= 20 ? (
        <span className={`pointer-events-none absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded border px-1 text-[10px] font-semibold leading-none shadow-sm ${badgeToneClass}`}>
          ?
        </span>
      ) : null}
      <div
        className={`pointer-events-none invisible absolute z-30 box-border rounded-lg border bg-white/90 px-3 py-2 text-xs opacity-0 shadow-lg shadow-slate-900/10 backdrop-blur-sm transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 ${tooltipToneClass}`}
        style={tooltipStyle}
      >
        <div className="font-semibold">{title}</div>
        <div className="mt-0.5 whitespace-normal break-words leading-5 text-slate-700">{children}</div>
      </div>
    </div>
  );
}

/**
 * 表头列筛选下推服务端时占用的 filter key。
 * 变更时先把这些 key 从 URL 的 `filters` 里清掉再合并新的，避免「取消勾选某列」后
 * 旧条件还留在查询串上继续生效。
 */
const TABLE_FILTER_SERVER_KEYS = [
  "date",
  "postedAt",
  "createdAt",
  "updatedAt",
  "inflow",
  "outflow",
  "currency",
  "account",
  /** 关联账户列：下推的是账户 id（展示 label 在前端反查成 id，见 translateTableFilters）。 */
  "related",
  "categoryId",
  /** 分类列的表头筛选：能反查回 id 时用 categoryId，落空时按展示名下发（见 translateTableFilters）。 */
  "category",
  "type",
  "remark",
  /** 表头漏斗「全不选」的恒假条件，换筛选时必须一起清掉。 */
  "emptyResult",
] as const;

/**
 * 这份 `filters` 是否圈出了「结果集」（第三层）。
 *
 * `entryOriginNot` 是默认隐藏口径（收益 / 余额校准），它只缩小显示面、不是用户
 * 筛的条件 —— 只有它时不改变「全部 = 整窗口」的语义。其余任一 key 都说明用户
 * 已经筛过，整份加载必须按这份条件取，而不是先拉整窗口再在表格里本地筛。
 */
function hasResultSetFilter(filters: DetailFilterDict | null): boolean {
  if (!filters) return false;
  return Object.keys(filters).some(
    (key) => key !== "entryOriginNot" && (filters[key]?.length ?? 0) > 0,
  );
}

export function BasicDetailPanel({
  accountId,
  isInvestAccount,
  entries,
  initialEntriesFromClientCache = false,
  initialClientDetailCacheHint = false,
  totalCount,
  originalCount,
  hasDetailFilters,
  showMoneyIncomeToggle = false,
  showMoneyIncome = false,
  initialPage,
  initialPageSize,
  initialDateRange,
  initialTableFilters: initialTableFiltersProp,
  initialDetailAll,
  initialAutoFit = true,
  normalExportFilename,
  normalExportRows = [],
  normalExportRowsByEntryId,
  fullRangeExport = false,
  accountOptions,
  batchReplaceAccountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
  compactRows = false,
  showBalanceReconcile = false,
  showReconcile = false,
  showImportExport = true,
  showAccountColumn = false,
  showRunningBalance,
  refreshOnGlobalEvent = true,
  draggableRows = true,
  sortable = true,
  showPagination = true,
  scopeAccountIds,
  deriveFromAllCashCache = false,
  accountKind = null,
  accountName = "",
  accountLabel = "",
  currentBalance = 0,
  focusEntryId,
  showGuideOverlay = false,
}: BasicDetailPanelProps) {
  const router = useRouter();
  const { t } = useI18n();
  // 「收益」开关：关掉时只在 SQL 显示层排除货基收益行；余额折叠链仍把这些收益
  // 记进账户余额，所以隐藏行不会让余额凭空少一块。
  //
  // URL 写回是 replaceState（不触发 RSC），所以 props 里的值不会立刻跟着变；
  // 开关必须自己是受控的，否则点一下会被旧 prop 弹回去。
  const [localShowMoneyIncome, setLocalShowMoneyIncome] = useState(showMoneyIncome);
  useEffect(() => setLocalShowMoneyIncome(showMoneyIncome), [showMoneyIncome]);
  const hideMoneyIncome = showMoneyIncomeToggle && !localShowMoneyIncome;
  // 「全部记录」不列出余额校准行；余额折叠链仍保留它们，单账户明细也不受影响。
  const hideBalanceReconcile = isAllCashDetailScope(accountId);
  const implicitHiddenOrigins = useMemo(() => [
    ...(hideMoneyIncome ? [TRANSACTION_SOURCE_MONEY_INCOME] : []),
    ...(hideBalanceReconcile ? [BALANCE_RECONCILE_SOURCE] : []),
  ], [hideBalanceReconcile, hideMoneyIncome]);
  const implicitFilters = useMemo(
    () => implicitHiddenOrigins.length > 0 ? { entryOriginNot: implicitHiddenOrigins } : null,
    [implicitHiddenOrigins],
  );
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [localTotalCount, setLocalTotalCount] = useState(totalCount);
  const [localOriginalCount, setLocalOriginalCount] = useState(originalCount);
  // 页码 / 每页行数 / 全部只有一个状态点（见下方 detailPager）。「自适应」是页大小
  // 的来源而不是独立开关，「视口能放几行」也不再单独存一份副本：它就是自适应模式
  // 下的每页行数，还没量过时等于服务端给的首屏页大小。
  const [isPageLoading, setIsPageLoading] = useState(false);
  /**
   * 「全部」的整份数据是不是已经到齐。
   *
   * 筛选徽标的命中数只有在这一刻才是「整份里命中多少」；之前表格只拿到首屏一页 /
   * 前几个分块，数出来的是「已加载的行里命中多少」（11 条），和工具栏的「共 701 条」
   * 对不上，看起来就像同时挂了两个筛选。未到齐时用服务端算好的那个数。
   */
  const [allSnapshotDone, setAllSnapshotDone] = useState(false);
  // 「全部」分块加载的进度（已回到本地的行数），仅用于加载提示文案。
  const [allLoadedCount, setAllLoadedCount] = useState(0);
  const [displayedEntryIds, setDisplayedEntryIds] = useState<string[] | null>(null);
  const [guideOverlayOpen, setGuideOverlayOpen] = useState(showGuideOverlay);
  const [guideMetrics, setGuideMetrics] = useState<GuideMetrics | null>(null);
  const [guidePortalHost, setGuidePortalHost] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * 「显示范围」滑轨两端（全量数据的最早/最晚一天）。
   * `futureMax` = 今天之后还有记账时的最晚一天，滑轨右端伸到那里。
   */
  const [serverDateBounds, setServerDateBounds] = useState<
    { min: string; max: string; futureMax?: string | null } | null
  >(null);
  /** 时间轴两端还在取数：弹层里提示「正在读取时间轴」，chip 本身照常显示。 */
  const [serverDateBoundsLoading, setServerDateBoundsLoading] = useState(true);
  /**
   * 显示范围（工具栏双滑块）。变化即按范围重取，与日期列筛选无关（走独立的
   * `range` 参数下推 SQL，不写进 `filters.date`）。
   *
   * 初值 = 最近 5 年：这是产品设定的**起始观测窗口**（十年老账不该在首屏铺满），
   * 不是用户筛出来的条件。所以只在挂载时用惰性初始化算一次，绝不放进 effect
   * 重算 —— 否则跨天或一次重渲染就会让用户没动过的区间自己往后滚一天。
   * 之后能改它的只有弹层里的「确认」。
   */
  const [detailDateRange, setDetailDateRange] = useState<{ from: string; to: string }>(() => {
    // 初值一律用服务端算好的那份（RSC 已经按它查了首屏那一页、总数和页码）。
    // 客户端不再自己算「今天 − 5 年」：两边各算一次迟早差一天，chip 与表头就会
    // 互相矛盾。没有传（其它调用点）时按「全部时间」处理，不偷偷缩小范围。
    if (initialDateRange) return { from: initialDateRange.from, to: initialDateRange.to };
    return { from: "", to: "" };
  });
  const serverDateRangeKey = `${detailDateRange.from}~${detailDateRange.to}`;
  const hasDetailDateRange = !!(detailDateRange.from || detailDateRange.to);
  // 观测窗口改设置后 RSC 会带着新的 `initialDateRange` 重渲染。只在**服务端那份
  // 真的变了**时应用：用户自己拖滑轨改的范围不能因为一次 router.refresh 就被重置。
  const initialRangeKey = initialDateRange ? `${initialDateRange.from}~${initialDateRange.to}` : "";
  const lastInitialRangeKeyRef = useRef(initialRangeKey);
  useEffect(() => {
    const nextKey = initialDateRange ? `${initialDateRange.from}~${initialDateRange.to}` : "";
    if (nextKey === lastInitialRangeKeyRef.current) return;
    lastInitialRangeKeyRef.current = nextKey;
    const nextRange = initialDateRange ? { from: initialDateRange.from, to: initialDateRange.to } : { from: "", to: "" };
    setDetailDateRange(nextRange);
    // 服务端默认观测窗口改了：这是全局意图，所有视图都跟着重置，并把落盘的那份
    // 一起更新 —— 否则下次进这个账户又会被旧范围顶回去。
    writeStoredDetailRangePreference(accountId, nextRange.from || nextRange.to ? nextRange : null);
  }, [accountId, initialDateRange]);
  const locatingDateRef = useRef(false);
  const accountScopeKey = `${accountId}:${isInvestAccount ? "invest" : "detail"}`;
  const lastAccountScopeKeyRef = useRef(accountScopeKey);
  const lastFocusEntryIdRef = useRef(focusEntryId ?? "");
  const lastClientPaginationKeyRef = useRef("");
  /**
   * RSC 直出的那一页是「谁」：账户 + 观测窗口 + 行数 + 首行 id。
   *
   * 「自适应」的页大小要等表格量完才知道，服务端按 cookie 里的旧值取数（至少
   * `DETAIL_PAGED_FIRST_FETCH_ROWS` 行），量完往往差几行。以前页大小一变就当成
   * 「窗口变了」重新请求一次 `page=1&pageSize=N`——首屏已经显示出来了，这一次
   * 往返纯粹是白花：它占着服务端去重算整条账本 CTE，用户紧接着切下一个账户时
   * RSC 渲染就得排队。只要当前窗口还能在这份行里本地切片，就不再发请求。
   */
  const rscPageWindowRef = useRef<{ accountId: string; rangeKey: string; count: number; headId: string } | null>(null);
  const clientPaginationEnabled = !hasDetailFilters;
  const originalCountRequestKeyRef = useRef("");
  /**
   * 表头徽标的分母：当前视图/时间范围下未做表头筛选的总数。
   * 只带默认隐藏口径（收益 / 余额校准），绝不携带 tableFilters/filters，
   * 否则筛选后分母会一起缩成分子（300/300）。
   */
  const loadOriginalCount = useCallback(async (
    range: { from: string; to: string },
    hideIncomeOverride?: boolean,
    signal?: AbortSignal,
  ) => {
    if (!clientPaginationEnabled) return;
    const origins = [
      ...((hideIncomeOverride ?? hideMoneyIncome) ? [TRANSACTION_SOURCE_MONEY_INCOME] : []),
      ...(hideBalanceReconcile ? [BALANCE_RECONCILE_SOURCE] : []),
    ];
    const key = `${accountId}|${range.from}~${range.to}|${origins.join(",")}`;
    originalCountRequestKeyRef.current = key;
    const params = new URLSearchParams({ accountId, page: "1", pageSize: "1" });
    if (origins.length > 0) params.set("filters", JSON.stringify({ entryOriginNot: origins }));
    if (range.from || range.to) params.set("range", `${range.from}~${range.to}`);
    try {
      const payload = await loadDetailPagePayload(
        `/api/v1/transactions/detail?${params.toString()}`,
        signal,
        t("basicDetail.loadFailed"),
      );
      if (originalCountRequestKeyRef.current !== key || payload.totalCount == null) return;
      setLocalOriginalCount(payload.totalCount);
    } catch (error) {
      if (!isAbortError(error)) console.error("Load unfiltered detail count failed:", error);
    }
  }, [accountId, clientPaginationEnabled, hideBalanceReconcile, hideMoneyIncome, t]);
  /**
   * 表头筛选的**展示值**口径：分页模式下从 URL 的 `tableFilters` 恢复（漏斗勾选态）。
   * 「全部」模式仍是本地筛选，筛选态由表格自己持久化，这里不参与。
   */
  const [initialTableFilters] = useState<DetailFilterDict | undefined>(() => {
    // 服务端给的那份优先：首帧必须与 RSC 直出的 HTML 完全一致。没有（老调用方）才在
    // 客户端读地址栏兜底。
    if (initialTableFiltersProp) return initialTableFiltersProp;
    if (typeof window === "undefined") return undefined;
    const raw = new URL(window.location.href).searchParams.get("tableFilters");
    return parseDetailTableFiltersParam(raw) ?? undefined;
  });
  /**
   * 页码 / 每页行数 / 全部 / 自适应——**唯一**的状态点。三个事件推动它：
   *
   *  - `fit(n)`    表格量出视口能放几行（窗口高度、行高偏好变化都走这里）
   *  - `select(n)` 用户手选 40 / 80（要按视口中心那天重新定位，见 onCommit）
   *  - `showAll()` 全部（分块回填）
   *
   * URL 与 cookie 都是它的镜像，只在 onPersist 里写一次；别处不再各自 setState。
   */
  const detailPager = useDetailPagination({
    scopeKey: accountScopeKey,
    rowCount: localTotalCount,
    serverPaged: !clientPaginationEnabled,
    isBusy: () => locatingDateRef.current,
    initial: {
      mode: initialDetailAll ? "all" : initialAutoFit ? "fit" : "manual",
      rows: normalizedInitialPageSize,
      page: initialPage,
    },
    onCommit: (next, _previous, reason) => {
      // 手选 / 回到自适应：页大小要落到服务端，得按「视口中心那一天」重新定位
      // 页码（客户端只持有一页数据，算不出目标页），交给下面那个方法做完再落地。
      // `reset`（换账户整份替换）与 `locate`（下面那个方法算好页码回填）不拦，
      // 否则会「拦 → 重新定位 → 再 replace → 再拦」自己转圈。
      if (reason !== "select" && reason !== "restore") return false;
      applyPageSizeKeepingCenter(next.rows, reason === "select" ? "manual" : "fit");
      return true;
    },
    // 进入「全部」前记住「此刻视口中心是哪一天」，全部渲染完再滚回去。
    onBeforeShowAll: () => {
      const centerDate = readCenteredDetailDate();
      if (centerDate) pendingCenterDateRef.current = centerDate;
    },
    onPersist: (state, nextSafePage) => {
      const url = new URL(window.location.href);
      // 全部资金明细（scope = __all_cash__）的规范 URL 是 view=allcash：根路由在
      // URL 既没有 accountId/account/tagId、view 又不是 allcash/liability/… 时
      // 会 redirect("/overview")。这里若把 view 写成 detail、又补不上 accountId，
      // 之后任何一次服务端重渲染（保存后 router.refresh、刷新页面、分享链接）都会
      // 把用户弹回概况页——保存一笔就「跳回首页」的真正来源。
      url.searchParams.set("view", isAllCashDetailScope(accountId) ? "allcash" : "detail");
      // 「自适应」的落地行数是**这台设备这个窗口**的属性，不是这一页的内容：
      // 写进地址栏只会把上一次的行数固化成显式参数 —— 下次用旧链接打开（换了
      // 窗口、换了屏幕）时，服务端只能照这个旧值铺首屏，比不做还糟；而它本身
      // 也没有任何分享价值。所以自适应时只落 cookie（服务端照样读得到），地址栏
      // 保持干净；只有用户手选了固定行数，才把数字写进 URL。
      if (state.mode === "fit") {
        url.searchParams.delete("pageSize");
      } else {
        url.searchParams.set("pageSize", String(state.rows));
      }
      if (state.mode === "all") {
        url.searchParams.set("detailAll", "1");
        url.searchParams.delete("detailPage");
      } else {
        url.searchParams.delete("detailAll");
        url.searchParams.set("detailPage", String(nextSafePage));
      }
      writeStoredDetailPreference(accountId, state.rows, state.mode === "all", nextSafePage, state.mode === "fit");
      const nextHref = `${url.pathname}${url.search}${url.hash}`;
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextHref !== currentHref && canRefreshCurrentRoute()) {
        if (clientPaginationEnabled) {
          // Next 16: must pass null, not window.history.state — reusing the
          // router's internal state object breaks canonicalUrl sync, so later
          // router.refresh() calls re-render from the OLD URL (dropping
          // detailAll=1) and overwrite the client-fetched full list.
          // replaceCurrentRouteUrl also refuses to write while another route
          // is being navigated to: even a no-op replaceState dispatches
          // ACTION_RESTORE and cancels that navigation.
          replaceCurrentRouteUrl(nextHref);
        } else {
          router.replace(nextHref, { scroll: false });
        }
      }
    },
  });
  /** 下面这些是派生别名，只读；写入口只有上面的 detailPager。 */
  // 稳定的方法解构出来单独引用：effect / useCallback 依赖里只列它，
  // 既满足 exhaustive-deps，又不会因为「对象每次渲染都新」而在每帧重置页码。
  const { goPage: goDetailPage, replace: replaceDetailPagination } = detailPager;
  const pageSize = detailPager.rows;
  const detailAll = detailPager.all;
  const page = detailPager.page;
  // 定位某一天时 page 可能暂时大于旧的 totalPages：不要把它夹回 1，
  // 否则分页 effect 会立刻又取一次第 1 页。
  const safePage = detailAll ? 1 : locatingDateRef.current ? Math.max(1, page) : detailPager.safePage;
  /**
   * 当前查询串上的明细筛选（服务端口径）。分页模式下表头筛选就写在这里：
   * 翻页、重取、导出都必须沿用它，否则翻到第 2 页就退回「未筛选」。
   */
  const readUrlDetailFilters = useCallback((): DetailFilterDict | null => {
    if (typeof window === "undefined") return null;
    return parseDetailFiltersParam(new URL(window.location.href).searchParams.get("filters"));
  }, []);
  /**
   * 一次取数 / 一次定位要下推的筛选：URL 上的表头筛选 + 「收益」开关。
   *
   * 取一页、只刷文本、定位页码三处必须同一口径。定位少了这一份，服务端就按
   * 「未筛选」算页码与总数 —— 用户切每页行数时表头的「共 N 条」会跳回全量，
   * 看起来就是「翻页把筛选范围改了」。
   *
   * 时间范围（`range`）不在这里：它是地址栏上独立的参数，只跟时间轴有关，
   * 翻页 / 换页大小一律不许改它。
   */
  const buildPageFilters = useCallback((hideIncomeOverride?: boolean): DetailFilterDict => {
    const filters: DetailFilterDict = { ...(readUrlDetailFilters() ?? {}) };
    const excluded = [
      ...(filters.entryOriginNot ?? []),
      ...((hideIncomeOverride ?? hideMoneyIncome) ? [TRANSACTION_SOURCE_MONEY_INCOME] : []),
      ...(hideBalanceReconcile ? [BALANCE_RECONCILE_SOURCE] : []),
    ];
    if (excluded.length > 0) filters.entryOriginNot = Array.from(new Set(excluded));
    return filters;
  }, [hideBalanceReconcile, hideMoneyIncome, readUrlDetailFilters]);
  /**
   * 一份页数据的身份：页码 + 页大小 + 时间戳范围 + 侧筛选。
   * 侧筛选必须在内 —— 否则「筛 A」和「筛 B」的响应会被当成同一页互相覆盖。
   */
  const buildDetailPageRequestKey = useCallback((pageNo: number, size: number, all: boolean) => (
    `${accountId}|${all ? "all" : String(pageNo)}|${size}|${serverDateRangeKey}|${JSON.stringify(readUrlDetailFilters() ?? {})}`
  ), [accountId, readUrlDetailFilters, serverDateRangeKey]);
  /**
   * 键盘 PageUp / PageDown：明细页的页码由这里持有（页数据是切好/取好再传给表格的），
   * 表格自己算不出下一页，所以由这里翻页。返回 true = 已翻页，表格据此把活动行落到
   * 新页首/末行；到首页/末页返回 false，表格就不动。
   */
  const handleKeyboardPageStep = useCallback((delta: 1 | -1) => {
    if (detailAll) return false;
    if (delta > 0 ? !detailPager.canNext : !detailPager.canPrev) return false;
    goDetailPage(detailPager.safePage + delta);
    return true;
  }, [detailAll, detailPager.canNext, detailPager.canPrev, detailPager.safePage, goDetailPage]);
  // 「当前在看哪一页」的标识。重取结果是否采用，看它是否仍等于当前页：
  // 之前用的是单调递增的 seq —— 任何一次重取（包括马上被 abort 的那次）都会让
  // 之前那笔仍然有效、数据更新的响应被判成过期丢掉，表现就是「记一笔保存成功，
  // 表格里却没有新行」。同一个 key 的响应谁先到都能用，key 变了（翻页 / 改页大小）
  // 才丢。
  const detailPageKey = buildDetailPageRequestKey(safePage, pageSize, detailAll);
  const detailPageKeyRef = useRef(detailPageKey);
  detailPageKeyRef.current = detailPageKey;
  /**
   * 「这次换页大小已经在本地切完，别再取一遍」的一次性标记（存取页 effect 的 key）。
   *
   * 换页大小只改变「一页装几行」：新页要的行如果是手上这份已加载页的前缀，切片就能
   * 显示，服务端那一页的行一模一样。以前这个 effect 只认「RSC 首屏那份行数正好等于
   * 已加载行数」，行数对不上就整页重取一次（实测 +0.9s），用户看到的就是切完行数
   * 还停一下。这里把「本地已经切好」的结论交接给 effect，一跳过就失效。
   */
  const skipPageFetchKeyRef = useRef<string | null>(null);

  /** 取消表头筛选时的瞬时还原快照：只用于第 1 页，且必须和当前视图口径完全一致。 */
  const unfilteredPageSnapshotRef = useRef<UnfilteredPageSnapshot | null>(null);
  // 页大小不进 key：快照存的是页面 1 的前缀，当前行数变小直接切片即可。自动适配
  // 常把首屏从第 1 页挪到第 2 页，所以挂在挂载时的第 1 页上，而不是等用户筛选那一刻。
  const unfilteredSnapshotKey = `${accountId}|${serverDateRangeKey}|${hideMoneyIncome ? "hideIncome" : "all"}|${hideBalanceReconcile ? "hideBalanceReconcile" : "all"}`;

  useEffect(() => {
    if (!clientPaginationEnabled || detailAll || safePage !== 1 || localEntries.length === 0) return;
    if (readUrlDetailFilters()) return;
    const current = unfilteredPageSnapshotRef.current;
    if (current?.key === unfilteredSnapshotKey && current.entries === localEntries) return;
    unfilteredPageSnapshotRef.current = {
      key: unfilteredSnapshotKey,
      entries: localEntries,
      totalCount: localTotalCount,
      originalCount: localOriginalCount,
      at: Date.now(),
    };
  }, [clientPaginationEnabled, detailAll, localEntries, localOriginalCount, localTotalCount, readUrlDetailFilters, safePage, unfilteredSnapshotKey]);

  useEffect(() => {
    if (!initialClientDetailCacheHint) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("_detailCache") !== "1") return;
    url.searchParams.delete("_detailCache");
    replaceCurrentRouteUrl(`${url.pathname}${url.search}${url.hash}`);
  }, [initialClientDetailCacheHint]);

  /**
   * 「全部」模式：整份明细由模块级仓库（`detail-all-store`）持有，分块进度、完成
   * 结果都留在那里。组件只负责「订阅 + 渲染」：
   * - 换页面再回来（组件重挂载）拿的是仓库里的当前进度，不会从头再拉；
   * - 在途任务不会因为卸载而作废，也不会被重复发起第二份。
   */
  /**
   * 行数据的缓存范围：**先读当前账户**。
   *
   * 曾经的做法是「现金类账户一律复用 `__all_cash__` 那份缓存」：行只差一个筛选
   * 条件（本账户 / 作为收款侧，外加排除外币转换行），字段逐行相同，能省一份内存。
   * 代价是打开一个只有几条记录的零钱 / 钱包账户，也要把整个「全部收支」集合
   * （十万级行）分三块并发拉一遍再本地筛 —— 小账户被大集合拖死。
   *
   * 现在只有那份缓存**已经整份到齐**（用户先看过「全部收支」）才顺手复用；否则
   * 一律按本账户自己的 `accountId` 取数。语义完全一样（本账户的行就是同一批行、
   * 同一套排序键的子序列），但小账户只查自己的几十行；「全部」按钮在单账户视图
   * 里本来就意味着「本账户的全部」，不需要全账簿。
   *
   * 走到复用分支时才需要本地筛 + 折余额（余额不在共享缓存里），见 `scopeEntriesOf`。
   *
   * 「已经整份到齐」必须**实时**判断：缓存是模块级 Map，`dropDetailAllCache` /
   * `invalidateDetailAll` / TTL 都会把它删掉，却不会给「订阅进度」的组件发快照。
   * 以前只在挂载时用 `useMemo` 看一次，缓存作废后单账户仍把 `detailCacheScopeId`
   * 钉在 `__all_cash__` 上 —— 一个只有三千行的账户会跟着重拉全账簿四万多行，
   * 表头还把「共 N 条」报成全账簿的总数。现在订阅缓存可用性，一失效就回落到
   * 本账户自己的 `accountId`；范围比缓存更宽（例如「全部时间」）同样不复用。
   */
  const detailAllRangeKey = hasDetailDateRange ? serverDateRangeKey : undefined;
  const sharedAllCashReady = useSyncExternalStore(
    subscribeDetailAllCacheAvailability,
    () => deriveFromAllCashCache && isDetailAllReady(ALL_CASH_DETAIL_SCOPE_ID, detailAllRangeKey),
    () => false,
  );
  const reuseSharedAllCash = deriveFromAllCashCache && sharedAllCashReady;
  const detailCacheScopeId = reuseSharedAllCash ? ALL_CASH_DETAIL_SCOPE_ID : accountId;
  // 缓存按显示层口径分桶：「收益」关掉 / 「全部记录」隐藏余额校准都不能和全量混用。
  // 全部记录用的是带后缀的桶，单账户复用共享缓存时只会认不带后缀的全量桶。
  const detailAllKey = `${detailAllCacheKey(detailCacheScopeId)}${hideMoneyIncome ? ":hideIncome" : ""}${hideBalanceReconcile ? ":hideBalanceReconcile" : ""}`;
  /**
   * 「全部」的整份加载按**第三层结果集**取数。
   *
   * 三层模型：`range`（第二层）圈出窗口，`tableFilters`/`filters`（第三层）圈出
   * 结果集，「全部 / 每页多少行」只是结果集之上的浏览方式。所以「全部」要拉的是
   * **结果集**，不是整个窗口 —— 第三层筛到 705 条时刷新页面，只该取这 705 条。
   *
   * 以前这里只带默认隐藏口径（`entryOriginNot`），把 3 万多条整份拉回来再在表格里
   * 本地筛：工具栏一直报「正在加载全部 35804 条记录」，而且是真的在拉那 3 万条
   * （1×500 + 若干×5000 块，几十秒）。
   *
   * 缓存按筛选项分桶：不筛的那份仍留在 `detailAllKey` 下（分页模式的备料要用它），
   * 带筛选的放在 `:f:` 后缀的桶里，互不覆盖 —— 取消筛选时不需要重拉整窗口那份。
   */
  const [allViewFiltersJson, setAllViewFiltersJson] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URL(window.location.href).searchParams.get("filters") ?? "";
  });
  const allViewFilters = useMemo(
    () => parseDetailFiltersParam(allViewFiltersJson),
    [allViewFiltersJson],
  );
  const allViewResultFiltered = useMemo(() => hasResultSetFilter(allViewFilters), [allViewFilters]);
  /** 「全部」这一份要下推的条件：第三层条件 + 默认隐藏口径（与 `buildPageFilters` 同口径）。 */
  const buildAllViewFilters = useCallback((hideIncomeOverride?: boolean): DetailFilterDict => {
    const filters: DetailFilterDict = { ...(allViewFilters ?? {}) };
    const excluded = [
      ...(filters.entryOriginNot ?? []),
      ...((hideIncomeOverride ?? hideMoneyIncome) ? [TRANSACTION_SOURCE_MONEY_INCOME] : []),
      ...(hideBalanceReconcile ? [BALANCE_RECONCILE_SOURCE] : []),
    ];
    if (excluded.length > 0) filters.entryOriginNot = Array.from(new Set(excluded));
    return filters;
  }, [allViewFilters, hideBalanceReconcile, hideMoneyIncome]);
  const allViewFetchFilters = useMemo(
    () => (allViewResultFiltered ? buildAllViewFilters() : implicitFilters),
    [allViewResultFiltered, buildAllViewFilters, implicitFilters],
  );
  const detailAllViewKey = allViewResultFiltered
    ? `${detailAllKey}:f:${JSON.stringify(allViewFetchFilters ?? {})}`
    : detailAllKey;
  // 「全部 + 筛选」这次加载的结果集条数（进度文案用；表头那行仍是第二层的未筛总数）。
  const [allViewTotal, setAllViewTotal] = useState(0);
  const businessTodayKey = todayDateBusinessYmd(getTimeZonePreference());

  /**
   * 窗口化取数缺的那一段余额起点（期初余额）。
   *
   * 余额要在**全量账本**上折叠，而缓存只按窗口拉（省流量）：差的那一段向服务端要
   * **一个数字**（列表同一条折叠链算出的「截至窗口起点前一天的账户余额」），
   * 于是「期初余额 + 窗口内本地折叠」=「服务端整表折叠」，网络上却只多一个数字。
   *
   * 只有复用「全部收支」那份共享缓存（`reuseSharedAllCash`）才需要：它的行不带
   * 本账户余额，要在本地折。按自己 accountId 拉的那份，行里本来就带着服务端算好的
   * 余额，不需要期初余额，也不需要这一趟请求。
   */
  const openingBalanceFrom = reuseSharedAllCash ? detailDateRange.from : "";
  const openingBalanceKey = openingBalanceFrom ? `${accountId}|${openingBalanceFrom}` : "";
  const [openingBalanceState, setOpeningBalanceState] = useState<{ key: string; value: number }>({ key: "", value: 0 });
  // key 不匹配时按 0 处理（换账户 / 改窗口起点的那一帧），拿到值后自动重折一次。
  const openingBalance = openingBalanceState.key === openingBalanceKey ? openingBalanceState.value : 0;
  /**
   * 期初余额还没到：这一刻折出来的余额是错的，先**别把表格换成这份**（沿用上一份 /
   * 首屏那份服务端算好的余额），等数字到了再整体换，用户不会看到一闪而过的错值。
   */
  const openingBalancePending = !!openingBalanceKey && openingBalanceState.key !== openingBalanceKey;
  useEffect(() => {
    if (!openingBalanceKey) return;
    const cached = peekDetailOpeningBalance(accountId, openingBalanceFrom);
    if (cached != null) {
      setOpeningBalanceState({ key: openingBalanceKey, value: cached });
      return;
    }
    const controller = new AbortController();
    loadDetailOpeningBalance(accountId, openingBalanceFrom, controller.signal)
      .then((value) => {
        setOpeningBalanceState({ key: openingBalanceKey, value });
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        console.error("Load detail opening balance failed:", error);
        // 拿不到就按 0 继续（等价于窗口内自折叠），绝不能让表格一直停在「等期初余额」。
        setOpeningBalanceState({ key: openingBalanceKey, value: 0 });
      });
    return () => controller.abort();
  }, [accountId, openingBalanceFrom, openingBalanceKey]);

  /**
   * 让缓存的行变成「本视图口径」。
   *
   * 按自己 accountId 拉的（`reuseSharedAllCash === false`）已经是本账户口径、余额
   * 也由服务端算好，原样返回；复用 `__all_cash__` 那份时才需要筛出本账户的行并
   * 本地补算余额。
   */
  const scopeEntriesOf = useCallback((shared: DetailEntry[]) => {
    if (!reuseSharedAllCash) return shared;
    const fromDay = detailDateRange.from;
    const own = shared.filter((entry) => {
      if (
        entry.accountId !== accountId
        && !(entry.toAccountId === accountId && entry.source !== "fx_conversion")
      ) return false;
      // 折叠集合必须与期初余额的切分同一口径（都按**生效日**）：窗口起点之前入账的
      // 行已经算进期初余额里，再折一次就重复计。
      if (!fromDay) return true;
      return formatDateUtc(getDetailEntryDisplayDate(entry, accountId)) >= fromDay;
    });
    return foldRunningBalancesInDescOrder(own, accountId, accountKind, businessTodayKey, openingBalance);
  }, [accountId, accountKind, businessTodayKey, detailDateRange.from, openingBalance, reuseSharedAllCash]);

  const lastAppliedAllRef = useRef<{
    /**
     * 上一次落地的是「哪个视图 + 哪个窗口」。
     *
     * 必须带视图标识：切换账户时这个组件实例是复用的，`localEntries` 已经换成
     * 新账户那一页，而缓存快照很可能还是同一个引用（全部收支那份没变）。
     * 只看引用的话守卫会判定「已经落过了，不用再 set」，于是切回「全部」时
     * 表格停在一页，表头/页脚却是全部的总数。
     */
    scopeKey: string;
    entries: DetailEntry[] | null;
    range: string | undefined;
  }>({ scopeKey: "", entries: null, range: undefined });

  /**
   * 把仓库快照落到表格上（「全部」模式）。
   *
   * 仓库里那份永远是「全部时间」的整份明细，所以时间轴怎么改都不需要重新请求：
   * 这里按当前窗口本地裁掉窗口外的行（`filterEntriesByRange`）即可。
   */
  const applyDetailAllSnapshot = useCallback((snapshot: DetailAllSnapshot<DetailEntry>) => {
    // 期初余额还没到：这一刻本地折出来的余额是错的，先不动表格 —— 沿用上一份（或首屏
    // 那份服务端算好的）余额，也不收掉加载态，等数字到了再整体换一次。
    if (openingBalancePending) return;
    // 任务刚发起、一行都还没回来：这时候绝不能把表格清空。首屏那份（服务端按同一
    // 口径算好的）正好可以继续显示，清空只会让用户对着空表等十几秒。
    if (snapshot.entries.length === 0 && !snapshot.done) {
      setAllSnapshotDone(false);
      setIsPageLoading(true);
      return;
    }
    const last = lastAppliedAllRef.current;
    // 期初余额要进 scopeKey：它比整份明细晚到（一个数字 vs 几万行），不进来就会被
    // 「同一份快照已经落过」的守卫吞掉，表格停在起点为 0 的那一份余额上。
    // 筛选口径也要进：同一份窗口、换一个筛选结果是另一份行，必须重新落到表格上。
    const scopeKey = `${detailAllViewKey}|${accountId}|${openingBalance}`;
    const rows = filterEntriesByRange(scopeEntriesOf(snapshot.entries), detailAllRangeKey);
    if (
      scopeKey !== last.scopeKey
      || snapshot.entries !== last.entries
      || detailAllRangeKey !== last.range
    ) {
      lastAppliedAllRef.current = { scopeKey, entries: snapshot.entries, range: detailAllRangeKey };
      setLocalEntries(rows);
    }
    if (snapshot.done) {
      // 已加载进度用「当前窗口内」的行数：窗口从 5 年收到 3 年，表头不能还报 5 年的总数。
      setAllLoadedCount(rows.length);
      // 分母是「窗口内未筛总数」：服务端 count 与本地的整份行都按未筛口径，取大值兜底。
      // 绝不能直接赋值 rows.length —— 首屏那份 rows 可能是服务端先按表头筛选给的一页，
      // 赋值后徽标就变成「133/133」。
      setLocalOriginalCount((previous) => Math.max(previous, rows.length));
      // 注意：不再写 localTotalCount。它是**分页结果集**的条数（第三层的分子），只有
      // 筛选变化 / 取回一页时才能改；「全部」模式把它写成窗口总行数，会让切回按页时
      // 徽标先变成「20367/20367」，换每页行数也会顺手把它改掉。
      if (allViewResultFiltered && Number.isFinite(snapshot.totalCount)) {
        setAllViewTotal(snapshot.totalCount);
      }
      locatingDateRef.current = false;
      setIsPageLoading(false);
      setAllSnapshotDone(true);
    } else {
      // 共享缓存里的 totalCount / loadedCount 是「全部收支」的全局口径，绝不能写进
      // 单账户表头：本账户只有三千多行，界面却会显示「共 43629 条 · 已加载 15500 条」。
      // 复用期间按本账户已到行数报进度、总数沿用服务端的账户口径；按自己 accountId
      // 加载时仓库里的数本来就是本账户口径，照常用。
      setAllLoadedCount(reuseSharedAllCash ? rows.length : snapshot.loadedCount);
      setAllSnapshotDone(false);
      // 带第三层筛选时 snapshot.totalCount 是**命中数**（结果集条数），写进分母会把
      // 「共 N 条」压成命中数；它只用来报进度（见 allViewTotal）。
      if (!reuseSharedAllCash && Number.isFinite(snapshot.totalCount)) {
        if (allViewResultFiltered) setAllViewTotal(snapshot.totalCount);
        else setLocalOriginalCount(snapshot.totalCount);
      }
      setIsPageLoading(true);
    }
  }, [accountId, allViewResultFiltered, detailAllRangeKey, detailAllViewKey, openingBalance, openingBalancePending, reuseSharedAllCash, scopeEntriesOf]);

  /**
   * 整份明细缓存（`detail-all-store`，按账户）是**唯一数据源**。
   *
   * 以前是「分页模式按页去服务端取、切到全部才整份拉」两条路：翻一页一次往返
   * （300-430ms），缩一下时间轴又要重取一次，两套缓存各管一半。现在只有一份缓存，
   * 永远拉「全部时间」那份，不随窗口变；时间轴只是显示层的窗口 ——
   * 范围怎么改都在本地裁、翻到第几页都在本地切，一次请求都不发。
   * 只有当窗口内的行还没到齐（刚进页面那一两秒）时才退回按页取一次。
   */
  const readCachedDetailPage = useCallback((pageNo: number, size: number): DetailPagePayload | null => {
    const snapshot = peekDetailAll<DetailEntry>(detailAllKey);
    if (!snapshot || snapshot.entries.length === 0) return null;
    if (!detailCacheCoversWindow(snapshot, detailAllRangeKey)) return null;
    // 期初余额没到时这份缓存折出来的余额是错的：交给按页取数兜底（服务端算好的）。
    if (openingBalancePending) return null;
    const windowed = filterEntriesByRange(scopeEntriesOf(snapshot.entries), detailAllRangeKey);
    const start = (pageNo - 1) * size;
    // 页码落在还没拉回来的那一段：交给按页取数兜底，别显示空页。
    if (start >= windowed.length && windowed.length > 0) return null;
    return { entries: windowed.slice(start, start + size), totalCount: windowed.length };
  }, [detailAllKey, detailAllRangeKey, openingBalancePending, scopeEntriesOf]);

  /**
   * 取数前按仓库的**当前**状态重新解析一次数据口径。
   *
   * `finance:changed` 这类事件回调里的闭包可能还是「共享缓存可用」那一帧，而同一个
   * handler 刚刚 `dropDetailAllCache()` / `invalidateDetailAll()` 把它作废了。照抄
   * 渲染时的 `detailCacheScopeId` 会用旧 key 把 `__all_cash__` 重新拉一遍（几万行），
   * 所以这里重新看一眼缓存，失效就回落到本账户自己的 accountId。
   */
  const resolveDetailCacheScope = useCallback(() => {
    const sharedReady = deriveFromAllCashCache
      && isDetailAllReady(ALL_CASH_DETAIL_SCOPE_ID, detailAllRangeKey);
    const scopeId = sharedReady ? ALL_CASH_DETAIL_SCOPE_ID : accountId;
    return {
      key: `${detailAllCacheKey(scopeId)}${hideMoneyIncome ? ":hideIncome" : ""}${hideBalanceReconcile ? ":hideBalanceReconcile" : ""}`,
      accountId: scopeId,
    };
  }, [accountId, deriveFromAllCashCache, detailAllRangeKey, hideBalanceReconcile, hideMoneyIncome]);

  const reloadDetailPage = useCallback((
    signal?: AbortSignal,
    hideIncomeOverride?: boolean,
    revalidateCached = false,
    /**
     * 目标页码。默认用当前渲染的页码；改筛选时条件变了、页码也回到第 1 页，
     * 但这一帧的 `safePage` 还是旧值——不显式指过来，取回来的就是「新条件 + 旧页码」，
     * 而表头「共 N 条」与这一页的行会互相矛盾（2026-11-27 实测：勾了关联账户筛选，
     * 总数还是全量，因为这次重取压根没发生）。
     */
    pageOverride?: number,
  ) => {
    if (!clientPaginationEnabled) return;
    const requestPage = pageOverride ?? safePage;
    const urlFilters = readUrlDetailFilters();
    const filtersSignature = urlFilters ? JSON.stringify(urlFilters) : "";
    const requestKey = buildDetailPageRequestKey(requestPage, pageSize, detailAll);
    if (detailAll) {
      const scope = resolveDetailCacheScope();
      // 共享缓存刚作废：渲染用的 key 下一帧就会切到本账户，由那个 effect 启动加载；
      // 这里按旧 key 发起的 `ensureDetailAll` 会变成一次全账簿重拉，必须跳过。
      // 收益开关刚切时 props 还是旧值，key 要按 override 现算，不能用这一帧的闭包。
      if (hideIncomeOverride === undefined && scope.key !== detailAllKey) return;
      const hide = hideIncomeOverride ?? hideMoneyIncome;
      const baseKey = hideIncomeOverride === undefined
        ? detailAllKey
        : `${detailAllCacheKey(scope.accountId)}${hide ? ":hideIncome" : ""}${hideBalanceReconcile ? ":hideBalanceReconcile" : ""}`;
      // 第三层筛选圈出的是**结果集**：整份要按它取数（见 `detailAllViewKey`），
      // 不能拿整窗口那份本地筛 —— 那等于为了 705 条去拉 3 万多条。
      const viewFilters = buildAllViewFilters(hideIncomeOverride);
      const effectiveKey = hasResultSetFilter(viewFilters)
        ? `${baseKey}:f:${JSON.stringify(viewFilters)}`
        : baseKey;
      // 「全部」= 结果集整份：缓存里已经有了，只取快照，不发请求。
      const snapshot = ensureDetailAll<DetailEntry>({
        key: effectiveKey,
        accountId: scope.accountId,
        range: detailAllRangeKey,
        filters: hasResultSetFilter(viewFilters) ? viewFilters : implicitFilters,
        errorMessage: t("basicDetail.loadFailed"),
      });
      // 空快照 = 刚发起的任务还没有数据，别把已有列表清空。
      if (snapshot.entries.length > 0 || snapshot.done) applyDetailAllSnapshot(snapshot);
      return;
    }
    // 缓存优先：窗口内数据齐了就从本地切这一页。
    // 收益开关刚切时缓存还是旧口径，必须跳过缓存直接打接口。
    // 带筛选时不能读本地缓存：缓存是时间轴窗口内的整份（未筛），在本地上切页
    // 会把没命中条件的行也带出来。收益开关刚切时同理（缓存还是旧口径）。
    const cached = hideIncomeOverride === undefined && !filtersSignature
      ? readCachedDetailPage(requestPage, pageSize)
      : null;
    if (cached) {
      if (requestKey !== detailPageKeyRef.current) return;
      setLocalEntries(cached.entries);
      // 缓存只知道这一页时总数是 null（窗口还没回填），这时别把已有计数清零，沿用旧值。
      if (cached.totalCount != null) {
        setLocalTotalCount(cached.totalCount);
        setLocalOriginalCount(cached.totalCount);
      }
      locatingDateRef.current = false;
      setIsPageLoading(false);
      if (!revalidateCached) return;
    }
    const params = new URLSearchParams({
      accountId,
      page: String(requestPage),
      pageSize: String(pageSize),
    });
    // 表头筛选 / 查找条件 + 收益开关，一起下推。
    const pageFilters = buildPageFilters(hideIncomeOverride);
    if (Object.keys(pageFilters).length > 0) params.set("filters", JSON.stringify(pageFilters));
    // 窗口还没齐（刚进页面）：照旧按页取一次，范围无条件下推。
    if (hasDetailDateRange) params.set("range", serverDateRangeKey);
    // 不带 `no-store`：接口发了 ETag，刷新/重进时浏览器会带 If-None-Match 回来，
    // 没变就 304 用本地副本。
    setIsPageLoading(!cached);
    void (async () => {
      let payload: DetailPagePayload;
      try {
        payload = await loadDetailPagePayload(
          `/api/v1/transactions/detail?${params.toString()}`,
          signal,
          t("basicDetail.loadFailed"),
        );
      } catch (error) {
        if (isAbortError(error)) return;
        console.error("Load transaction detail page failed:", error);
        if (requestKey === detailPageKeyRef.current) {
          locatingDateRef.current = false;
          setIsPageLoading(false);
        }
        return;
      }
      // 期间又翻页 / 改了条件：这份结果已经不是用户要看的那一页。
      if (requestKey !== detailPageKeyRef.current) return;
      if (cached) {
        const unchanged =
          cached.totalCount === payload.totalCount
          && cached.entries.length === payload.entries.length
          && cached.entries.every((entry, index) =>
            entry.id === payload.entries[index]?.id
            && JSON.stringify(entry) === JSON.stringify(payload.entries[index]),
          );
        if (unchanged) patchDetailAllRows(detailAllKey, payload.entries);
        else dropDetailAllCache([detailAllKey]);
      }
      setLocalEntries(payload.entries);
      // totalCount 是**当前结果集**（含表头筛选）的条数；分母 localOriginalCount
      // 只能由 RSC 的 originalCount 或 loadOriginalCount 更新，别在这里覆盖。
      if (payload.totalCount != null) setLocalTotalCount(payload.totalCount);
      locatingDateRef.current = false;
      setIsPageLoading(false);
    })();
  }, [accountId, applyDetailAllSnapshot, buildAllViewFilters, buildDetailPageRequestKey, buildPageFilters, clientPaginationEnabled, detailAll, detailAllKey, detailAllRangeKey, hasDetailDateRange, hideBalanceReconcile, hideMoneyIncome, implicitFilters, pageSize, readCachedDetailPage, readUrlDetailFilters, resolveDetailCacheScope, safePage, serverDateRangeKey, t]);

  /**
   * 表头「收益」开关：写回 URL（刷新/分享后口径不变），然后按新口径把表格重取一次。
   *
   * 不能只做本地行过滤：服务端分页的页码 / 共 N 条都是按过滤后的结果集算的，
   * 本地藏几行只会让这一页看起来少、翻页还是对不上。所以这里让 SQL 显示层
   * （entryOriginNot）重新查，余下的排序 / 合计由服务端同一口径给出。
   */
  const handleMoneyIncomeChange = useCallback((next: boolean) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("showMoneyIncome", "1");
    else url.searchParams.delete("showMoneyIncome");
    const nextHref = `${url.pathname}${url.search}${url.hash}`;
    // 口径变了：整份明细缓存不能再用，否则点「全部」又冒出刚关掉的收益行。
    setLocalShowMoneyIncome(next);
    if (clientPaginationEnabled) void loadOriginalCount(detailDateRange, !next);
    dropDetailAllCache([detailAllKey]);
    if (!clientPaginationEnabled) {
      router.replace(nextHref, { scroll: false });
      if (canRefreshCurrentRoute()) router.refresh();
      return;
    }
    replaceCurrentRouteUrl(nextHref);
    reloadDetailPage(undefined, !next);
  }, [clientPaginationEnabled, detailAllKey, detailDateRange, loadOriginalCount, reloadDetailPage, router]);

  /**
   * 漏斗候选值的行集（分页模式）：按**时间轴范围内的整份记录**汇总，不是当前页。
   *
   * 表格只拿到当前一页（几十行），拿它做 distinct 只能得到「这一页出现过的值」——
   * 用户看到的下拉就永远缺项。后台备料（`detail-all-store`）本来就持有窗口内的整份
   * 明细，这里在漏斗打开的瞬间取一份快照交给表格：候选值 / 计数 / 搜索文本都按全量
   * 算，而且用的还是行内同一套 `filterText`，不需要任何展示值→服务端值的翻译。
   *
   * 只在打开时取一次：备料是分块到达的，逐块 setState 会让几万行的表格反复重建；
   * 关掉再打开就能拿到更新的快照。快照还没备好时传 undefined，表格退回当前页汇总，
   * 行为不倒退。
   */
  const [tableFilterOptionRows, setTableFilterOptionRows] = useState<DetailEntry[] | undefined>(undefined);
  // 换账户 / 换时间窗口 / 切收益口径：旧行集不能继续当候选值，否则会在新账户的漏斗里
  // 列出上一个账户的分类与账户名。下一次打开漏斗自然取到新的快照。
  useEffect(() => {
    setTableFilterOptionRows(undefined);
    // 换了账户 / 窗口 / 筛选口径：上一份「整份已到齐」的结论作废，徽标先回到服务端口径。
    setAllSnapshotDone(false);
  }, [detailAllKey, detailAllRangeKey, detailAllViewKey]);
  const handleTableFilterColumnOpen = useCallback(() => {
    // 候选值要按**第二层**（时间轴窗口内未筛的行）给，否则「全部 + 已筛选」时手上
    // 只有结果集那几百行，漏斗里就只剩当前这个值，再也换不回别的账户 / 分类。
    // 整窗口那份缓存还在（先看过不筛的全部）就顺手用它；没有就让表格按自己的行兜底，
    // 绝不为了候选值再拉一遍整窗口。
    const snapshot = peekDetailAll<DetailEntry>(detailAllKey);
    if (!snapshot || snapshot.entries.length === 0) return;
    const windowed = filterEntriesByRange(scopeEntriesOf(snapshot.entries), detailAllRangeKey);
    setTableFilterOptionRows(windowed.length > 0 ? windowed : undefined);
  }, [detailAllKey, detailAllRangeKey, scopeEntriesOf]);

  /**
   * 表头列筛选在分页模式下的落点：**下推服务端**，作用于「时间轴范围内的全部记录」，
   * 而不是当前这一页；「全部」模式整份已在本地，仍由表格自己筛（`remoteTableFilters`）。
   *
   * 为什么走整页刷新（router.replace + RSC 重渲染）而不是 `reloadDetailPage`：
   * 分页模式的第一页和「共 N 条」是 RSC 按查询串直出的，页码 / 合计 / 余额折叠加总
   * 都必须和服务端同一口径重算。只在客户端换一页会把「共 N 条」留在旧值上。
   */
  const handleTableFiltersChange = useCallback((next: {
    display: Partial<Record<string, string[]>>;
    server: DetailFilterDict;
  }) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const currentDisplayJson = url.searchParams.get("tableFilters") ?? "";
    const currentFiltersJson = url.searchParams.get("filters") ?? "";
    // 展示值口径：只用来恢复漏斗勾选态。
    const nextDisplayJson = Object.keys(next.display).length > 0 ? JSON.stringify(next.display) : "";
    // 服务端口径：保留查找窗 / 收益开关这类非表头条件，只替换表头那几个 key。
    const merged: DetailFilterDict = { ...(parseDetailFiltersParam(url.searchParams.get("filters")) ?? {}) };
    for (const key of TABLE_FILTER_SERVER_KEYS) delete merged[key];
    Object.assign(merged, next.server);
    const nextFiltersJson = Object.keys(merged).length > 0 ? JSON.stringify(merged) : "";
    // 从 URL 恢复勾选态后，组件会主动把同一份条件再抛一次；一模一样就别再取一遍。
    if (nextDisplayJson === currentDisplayJson && nextFiltersJson === currentFiltersJson) {
      return;
    }
    // 进入筛选时留住未筛选的第 1 页：后台整份缓存还没到齐时，取消筛选不能让用户
    // 干等服务端。快照只存一页，口径键不同就自动失效。
    const enteringFilter = !currentFiltersJson && !!nextFiltersJson;
    const clearingFilter = !!currentFiltersJson && !nextFiltersJson;
    if (enteringFilter && clientPaginationEnabled && !detailAll && safePage === 1 && localEntries.length > 0) {
      unfilteredPageSnapshotRef.current = {
        key: unfilteredSnapshotKey,
        entries: localEntries,
        totalCount: localTotalCount,
        originalCount: localOriginalCount,
        at: Date.now(),
      };
    }
    if (nextDisplayJson) url.searchParams.set("tableFilters", nextDisplayJson);
    else url.searchParams.delete("tableFilters");
    if (nextFiltersJson) url.searchParams.set("filters", nextFiltersJson);
    else url.searchParams.delete("filters");
    // 条件变了，页码回到第一页。参数名是 `detailPage`（见 onPersist），不是 `page`：
    // 删错名字等于没删，地址栏会带着旧页码让 RSC 按新条件取第 5 页。
    url.searchParams.delete("detailPage");
    const nextHref = `${url.pathname}${url.search}${url.hash}`;
    // 分页模式下列表由本组件持有，RSC 重渲染不会覆盖它 —— 必须自己按新口径取一次。
    replaceCurrentRouteUrl(nextHref);
    // 取消筛选：先同步把刚才那一帧的未筛选第 1 页放回去，用户立刻看到全量记录；
    // 服务端重取和后台缓存补料照常在后面跑，回来后按同一口径校正行数 / 合计。
    if (clearingFilter && clientPaginationEnabled && !detailAll && safePage === 1) {
      const snapshot = unfilteredPageSnapshotRef.current;
      if (
        snapshot
        && snapshot.key === unfilteredSnapshotKey
        && Date.now() - snapshot.at <= UNFILTERED_PAGE_SNAPSHOT_TTL_MS
        && snapshot.entries.length >= pageSize
      ) {
        setLocalEntries(snapshot.entries.slice(0, pageSize));
        setLocalTotalCount(snapshot.totalCount);
        setLocalOriginalCount(snapshot.originalCount);
        setIsPageLoading(false);
        locatingDateRef.current = false;
      }
      unfilteredPageSnapshotRef.current = null;
    }
    // 「全部」模式：整份加载按第三层结果集取数（见 `detailAllViewKey`）。条件刚写进
    // URL，这里把口径状态推过去，加载 effect 会按新 key 重取一份；旧口径那份留在
    // 它自己的缓存桶里，切回去不用重拉。表格此刻仍按本地行先筛，等新结果到齐再整体换。
    if (detailAll) {
      setAllViewFiltersJson(nextFiltersJson);
      return;
    }
    // 条件变了，旧页码没有意义；页码回第 1 页与「按新条件重取」是两件事——
    // 以前这里在非第 1 页直接 return，指望分页状态变更顺手触发一次取数，
    // 但 ref 身份没对齐时那次取数会被过期判定丢掉，界面就停在旧结果上
    // （用户看到的就是「勾了筛选，还是两万多条」）。现在两件事都显式做。
    if (safePage !== 1) goDetailPage(1);
    // 先把「当前页身份」对齐到新条件，否则请求回来的结果会被过期判定（requestKey !== ref）丢掉。
    detailPageKeyRef.current = buildDetailPageRequestKey(1, pageSize, detailAll);
    reloadDetailPage(undefined, undefined, false, 1);
  }, [buildDetailPageRequestKey, clientPaginationEnabled, detailAll, goDetailPage, localEntries, localOriginalCount, localTotalCount, pageSize, reloadDetailPage, safePage, unfilteredSnapshotKey]);

  /**
   * 只改行文本（备注 / 分类 / 标签…）时的最低限度刷新，只在索引分页视图使用：
   * 按当前页取一次**服务端列表口径的完整行**，按 id 覆盖表格与缓存里的那几行。
   * 行数 / 排序 / 逐笔余额 / 总条数都不变，所以不作废整份缓存、不重算期初余额、
   * 不动页码，也不惊动其它账户。取完整行而不是猜字段白名单，是为了连入账日、
   * 币种这类「不影响余额但会显示在明细里」的字段一起更新，不漏刷。
   *
   * 「全部」视图和筛选 / 标签视图不走这里：前者编辑的行可能不在当前页，后者改了
   * 筛选列值会让该行进出结果集，两者都必须重算整个结果集。
   */
  const refreshTextOnlyPage = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({
      accountId,
      page: String(safePage),
      pageSize: String(pageSize),
    });
    // 只改行文本也要沿用当前筛选：不带 filters 取回来的是未筛的一页，
    // 拿它按 id 覆盖会把筛选结果替换成别的行。
    const textOnlyFilters = buildPageFilters();
    if (Object.keys(textOnlyFilters).length > 0) params.set("filters", JSON.stringify(textOnlyFilters));
    if (hasDetailDateRange) params.set("range", serverDateRangeKey);
    const requestKey = detailPageKeyRef.current;
    try {
      const payload = await loadDetailPagePayload(
        `/api/v1/transactions/detail?${params.toString()}`,
        signal,
        t("basicDetail.loadFailed"),
      );
      if (requestKey !== detailPageKeyRef.current) return;
      const byId = new Map(payload.entries.map((entry) => [entry.id, entry]));
      // 只替换同 id 的行：不增删、不重排，其余行保持同一引用。
      setLocalEntries((prev) => prev.map((entry) => byId.get(entry.id) ?? entry));
      patchDetailAllRows(detailAllKey, payload.entries);
      setIsPageLoading(false);
    } catch (error) {
      if (isAbortError(error)) return;
      console.error("Refresh detail row text failed:", error);
      // 兜底：作废当前视图缓存再按结构变化完整重取，绝不把旧文本留在界面上。
      dropDetailAllCache([detailAllKey]);
      reloadDetailPage();
    }
  }, [accountId, buildPageFilters, detailAllKey, hasDetailDateRange, pageSize, reloadDetailPage, safePage, serverDateRangeKey, t]);

  // 后台按「当前窗口」（默认就是设置里的观测年数）把整份明细读进缓存，与页码无关：
  // 之后翻到哪一页、把窗口缩小都只在本地切，不再产生请求。窗口放大到超出已拉范围时
  // 才重新拉一份更宽的 —— 缩窗永远不丢缓存。任务归 detail-all-store 所有，
  // 切页面、组件卸载都不会中断它。
  //
  // 但**分页模式**下这份整份明细只是备料：首屏那一页已由 RSC 直出，翻页/缩窗没它
  // 也能按页取。以前它和首屏同时发起（3924 这种账户一次就是「500 行 + 5000 行」两
  // 个整表查询），服务端 CPU 被自己占住，用户紧接着切下一个账户时 RSC 渲染就得排队
  // ——实测同一个切换动作会从 1.3s 变成 2.3-3.2s。所以分页模式推后到首帧之后的空档
  // 再拉；「全部」模式没有别的数据来源，仍然立刻开始。
  useEffect(() => {
    if (!clientPaginationEnabled) return;
    const start = () => {
      const scope = resolveDetailCacheScope();
      // 缓存状态在定时器等待期间变了：等 key 切换后本 effect 重跑，别按旧口径备料。
      if (scope.key !== detailAllKey) return;
      // 「全部」按第三层结果集取数；分页模式那份备料仍按整窗口（本地切页要用未筛的行）。
      ensureDetailAll<DetailEntry>({
        key: detailAll ? detailAllViewKey : detailAllKey,
        accountId: scope.accountId,
        range: detailAllRangeKey,
        filters: detailAll ? allViewFetchFilters : implicitFilters,
        errorMessage: t("basicDetail.loadFailed"),
      });
    };
    if (detailAll) {
      start();
      return;
    }
    const timer = window.setTimeout(start, DETAIL_PRELOAD_IDLE_DELAY_MS);
    // 期间又切了账户：这一份备料已经没人要了，别再压到服务端上。
    return () => window.clearTimeout(timer);
  }, [allViewFetchFilters, clientPaginationEnabled, detailAll, detailAllKey, detailAllRangeKey, detailAllViewKey, implicitFilters, resolveDetailCacheScope, t]);

  // 从按页切回「全部」：让「同一份快照已经落过」的护栏失效。
  // 快照引用确实没变（整份缓存还在），但表格里的行已经换成了按页那 40 行；护栏若
  // 继续认为「落过了」，整份行永远回不到表格，徽标就停在「40/20367」。
  // 先于下面的订阅 effect 执行：同一帧里重新把整份行落回表格。
  useEffect(() => {
    if (!detailAll) return;
    lastAppliedAllRef.current = { scopeKey: "", entries: null, range: undefined };
    // 落回之前徽标先回到服务端口径，别拿那 40 行去数命中数。
    setAllSnapshotDone(false);
    // 换了筛选口径：上一份结果集的条数不能拿来报新一份的进度。
    setAllViewTotal(0);
  }, [detailAll, detailAllViewKey]);

  // 「全部」的加载由仓库推进，这里只订阅：整份到齐才重建表格（并发分块阶段
  // 只滚进度数字，不为每一块重建两万行），完成时收掉加载态。
  // 组件卸载只取消订阅，任务继续在后台跑完（下次回来直接是成品）。
  useEffect(() => {
    if (!detailAll || !clientPaginationEnabled) return;
    const unsubscribe = subscribeDetailAll<DetailEntry>(detailAllViewKey, applyDetailAllSnapshot);
    // 订阅只在「有新块到达」时回调；范围刚变（重挂载 / 改窗口）时先拿现有快照
    // 按新范围重渲染一次 —— 这一刻不该有任何请求。
    const current = peekDetailAll<DetailEntry>(detailAllViewKey);
    if (current) applyDetailAllSnapshot(current);
    return unsubscribe;
  }, [applyDetailAllSnapshot, clientPaginationEnabled, detailAll, detailAllViewKey]);

  useEffect(() => {
    if (showGuideOverlay) setGuideOverlayOpen(true);
  }, [accountId, showGuideOverlay]);

  useEffect(() => {
    setGuidePortalHost(document.body);
  }, []);

  useEffect(() => {
    if (!guideOverlayOpen) {
      setGuideMetrics(null);
      return;
    }

    const root = panelRef.current;
    if (!root) return;

    let frameId = 0;
    const measureGuideTargets = () => {
      const rootRect = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const panel = visibleGuideRect(root, rootRect);
      const toolbar = visibleGuideRect(root.querySelector("[data-advanced-table-toolbar]"), rootRect);
      const toolbarTools = unionGuideRects([
        visibleGuideRect(root.querySelector("[data-basic-detail-import]"), rootRect),
        visibleGuideRect(root.querySelector("[data-basic-detail-reconcile]"), rootRect),
        visibleGuideRect(root.querySelector("[data-basic-detail-export]"), rootRect),
      ]);
      const header = visibleGuideRect(root.querySelector("[data-advanced-table-header-row]"), rootRect);
      const headerCell =
        firstVisibleGuideRect(root, rootRect, '[data-advanced-table-header-cell="type"]') ??
        firstVisibleGuideRect(root, rootRect, "[data-advanced-table-header-cell]");
      const rowControls = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-row-controls]");
      const rowActions = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-row-actions]");
      const columnSettings = visibleGuideRect(root.querySelector("[data-advanced-table-column-settings]"), rootRect);
      const resizeHandle = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-resize-handle]");
      const bodyRow = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-body-row]");
      const bodyRowFocus = bodyRow
        ? guideCenteredRect(bodyRow, Math.min(360, Math.max(180, bodyRow.width * 0.42)), Math.max(24, bodyRow.height))
        : null;
      const entryButton =
        firstVisibleGuideRect(document.body, rootRect, '[data-entry-launcher-primary-action="transaction"]') ??
        firstVisibleGuideRect(document.body, rootRect, "[data-entry-launcher-primary]");
      setGuideMetrics({
        width: rootRect.width,
        height: rootRect.height,
        panel,
        toolbar,
        toolbarActions: toolbarTools,
        header,
        headerCell,
        rowControls,
        rowActions,
        entryButton,
        toolbarTools,
        columnSettings,
        resizeHandle,
        bodyRow,
        bodyRowFocus,
      });
    };
    const requestMeasure = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(measureGuideTargets);
    };

    requestMeasure();
    window.addEventListener("resize", requestMeasure);
    window.addEventListener("scroll", requestMeasure, true);

    const tableViewport = root.querySelector(".advanced-table-viewport");
    tableViewport?.addEventListener("scroll", requestMeasure, { passive: true });

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(requestMeasure);
    resizeObserver?.observe(root);
    if (tableViewport instanceof HTMLElement) resizeObserver?.observe(tableViewport);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", requestMeasure);
      window.removeEventListener("scroll", requestMeasure, true);
      tableViewport?.removeEventListener("scroll", requestMeasure);
      resizeObserver?.disconnect();
    };
  }, [detailAll, guideOverlayOpen, guidePortalHost, localEntries.length, pageSize, safePage]);

  useEffect(() => {
    const nextFocusEntryId = focusEntryId ?? "";
    const accountScopeChanged = lastAccountScopeKeyRef.current !== accountScopeKey;
    const focusEntryChanged = lastFocusEntryIdRef.current !== nextFocusEntryId;
    // Client pagination owns localEntries after the first load. Copying RSC
    // `entries` on every parent refresh would overwrite a just-located page
    // with page 1 (page number jumps, list stays put).
    if (!clientPaginationEnabled || accountScopeChanged || focusEntryChanged) {
      setLocalEntries(entries);
      setLocalTotalCount(totalCount);
      setLocalOriginalCount(originalCount);
      // 记下「这一份行是谁给的」：RSC 直出的首屏页按它自己的观测窗口取数，
      // 客户端量出真实页大小后只要能在这份行里切片，就不该再问服务端要一次。
      rscPageWindowRef.current = {
        accountId,
        rangeKey: initialDateRange ? `${initialDateRange.from}~${initialDateRange.to}` : "",
        count: entries.length,
        headId: entries[0]?.id ?? "",
      };
    }
    if (accountScopeChanged || focusEntryChanged) {
      lastAccountScopeKeyRef.current = accountScopeKey;
      lastFocusEntryIdRef.current = nextFocusEntryId;
      const storedPreference = nextFocusEntryId ? null : readStoredDetailPreference(accountId);
      const nextPageSize = nextFocusEntryId ? normalizedInitialPageSize : storedPreference?.pageSize ?? normalizedInitialPageSize;
      const nextDetailAll = nextFocusEntryId ? initialDetailAll : storedPreference?.detailAll ?? initialDetailAll;
      const nextAutoFit = nextFocusEntryId ? initialAutoFit : storedPreference?.autoFit ?? initialAutoFit;
      const nextTotalPages = Math.max(1, Math.ceil(totalCount / nextPageSize));
      // 时间轴范围也按视图各自一份：换账户后不能沿用上一个账户选的那段，要恢复
      // 这个账户自己存的范围；没存过就用服务端给这个视图算的默认观测窗口。
      // 顺带把 `lastInitialRangeKeyRef` 对齐，免得上面那个 effect 再把默认值盖回来。
      const nextRange = storedPreference?.range
        ?? (initialDateRange ? { from: initialDateRange.from, to: initialDateRange.to } : { from: "", to: "" });
      lastInitialRangeKeyRef.current = initialRangeKey;
      setDetailDateRange(nextRange);
      // 换账户 / 换作用域：整份替换这一个状态点；视口行数清空（等表格量完新容器
      // 再切片），所以 fitRows 显式置 null。
      replaceDetailPagination({
        mode: nextDetailAll ? "all" : nextAutoFit ? "fit" : "manual",
        rows: nextPageSize,
        page: nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages),
        fitRows: null,
      });
    }
  }, [accountId, accountScopeKey, clientPaginationEnabled, entries, focusEntryId, initialAutoFit, initialDateRange, initialDetailAll, initialPage, initialRangeKey, normalizedInitialPageSize, originalCount, replaceDetailPagination, totalCount]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail ?? {};
      // ① 行情 / 净值 / 开机巡检：明细行一行都没变，不刷界面也不作废缓存。
      //    其余事件（含不带 entryIds 的导入、定投执行、撤销、通知落账）按结构变化
      //    处理 —— 触发宁可偏敏感，不能让刚记的一笔不出现。
      const impact = classifyFinanceEntryChange(detail);
      if (impact === "none") return;
      // 行集合可能变了：取消筛选时绝不能拿修改前的第 1 页做瞬时还原。
      unfilteredPageSnapshotRef.current = null;

      const eventAccountIds = detail.accountIds ?? [];
      const isCurrentAccountEvent = financeChangeAffectsAccount(
        detail,
        accountId,
        isAllCashDetailScope(accountId) ? scopeAccountIds : undefined,
      );
      // ② 按影响域算出要作废的缓存 key：受影响账户 + 被它们影响的「全部收支」共享缓存。
      const affectsCashScope = eventAccountIds.some((id) => scopeAccountIds?.includes(id) ?? true);
      const affectedKeys = eventAccountIds.length === 0
        ? undefined
        : Array.from(new Set([
          ...eventAccountIds.flatMap((id) => [
            detailAllCacheKey(id),
            `${detailAllCacheKey(id)}:hideIncome`,
          ]),
          ...(affectsCashScope ? [
            detailAllCacheKey(ALL_CASH_DETAIL_SCOPE_ID),
            `${detailAllCacheKey(ALL_CASH_DETAIL_SCOPE_ID)}:hideIncome`,
          ] : []),
        ]));

      // ②.5 对账锁定 / 解锁：只写 `reconciledAt` / `reconciledBalance` 两列，
      // 行集合、排序、逐笔余额都不变（锚点值就是当时显示的事后余额）。服务端已经把
      // 落库值带回事件里了，就地合并即可 —— 以前它落在「结构变化」档，「全部」视图
      // 会整份重拉几万行，用户点一次锁要等好几秒。缓存同样按字段补，不整行替换。
      const reconciledRecords = detail.reconciledRecords ?? [];
      if (detail.reason === "entry-reconcile" && reconciledRecords.length > 0) {
        const patchedRows = applyReconcileRecords(localEntries, reconciledRecords);
        if (patchedRows !== localEntries) setLocalEntries(patchedRows);
        for (const key of affectedKeys ?? []) patchDetailAllRowFields(key, reconciledRecords);
        return;
      }

      // ③ 只改行文本：行数 / 排序 / 逐笔余额 / 总条数都不变。
      //    索引分页视图 → 取回当前页完整行、按 id 覆盖，零整份重拉、零期初余额重算；
      //    不命中当前视图 → 只让受影响账户的缓存失效，界面一行不动；
      //    「全部」/ 筛选 / 标签视图 → 行可能不在当前页或会进出筛选结果集，落到 ④ 重算。
      if (impact === "text") {
        if (isCurrentAccountEvent && clientPaginationEnabled && refreshOnGlobalEvent && !detailAll) {
          void refreshTextOnlyPage();
          return;
        }
        if (!isCurrentAccountEvent) {
          dropDetailAllCache(affectedKeys);
          return;
        }
      }

      // ④ 结构变化（或必须重算结果集）：按域作废缓存，必要时连在途分块一起停掉。
      // 一并带上本次事件的行标识：作废时留作展示兜底的旧行要据此剔除已删行、给新增行
      // 让位 —— 否则删除后兜底行会把删掉的那条又渲染回来，新增的行则一直藏到整份拉完。
      const deletedEntryIds = detail.deletedEntryIds ?? [];
      const cacheChangeOptions = {
        entryIds: detail.entryIds,
        deletedEntryIds,
      };
      dropDetailAllCache(affectedKeys, cacheChangeOptions);
      if (isBulkFinanceEntryChange(detail)) invalidateDetailAll(affectedKeys, cacheChangeOptions);
      // 备注-only 编辑不改余额，期初余额不用重算；影响域未知时清空整张缓存。
      // 本视图不显示逐笔余额列（全部收支 / 标签筛选 / 投资账户）时，这个缓存根本
      // 不会被读取，也不用清 —— header / 侧栏余额由 LiveAccountBalance、
      // SidebarClient 各自按 balanceChanged 刷新，与这里无关。
      if ((showRunningBalance ?? !isInvestAccount) && detail.balanceChanged !== false) {
        invalidateDetailOpeningBalance(eventAccountIds.length > 0 ? eventAccountIds : undefined);
      }
      // 没命中当前账户视图：缓存口径已按域更新，界面一行都不用动。
      if (!isCurrentAccountEvent) return;

      if (deletedEntryIds.length === 0) {
        // ⑤ 明细刷新的唯一入口（子层通过 parentOwnsRefresh 让出，避免同页取两遍）：
        //    有筛选 / 标签视图 → 筛选结果集在 RSC 内存里算，按页 API 的口径不一致，
        //    重取会冲掉筛选条件；只能整棵重算一次（且只在命中当前账户时触发）；
        //    普通分页 → 按当前页重取一次，新行与「共 N 条」一起出现；
        //    「全部」→ 缓存已按域作废，ensureDetailAll 按当前账户口径重取整份。
        if (!clientPaginationEnabled || !refreshOnGlobalEvent) {
          if (canRefreshCurrentRoute()) router.refresh();
          return;
        }
        reloadDetailPage();
        void loadOriginalCount(detailDateRange);
        return;
      }
      const deletedSet = new Set(deletedEntryIds);
      // 剔除已删行的同时重算「余额」列：子组件拿到新的 initialEntries 引用后会
      // 丢弃自己的本地快照，所以重算结果必须由父层写进这份数据里，否则删除一条
      // 之后后续行的余额不会变，只有刷新页面才对。
      // 重算全程只动当前已渲染页的行，不发请求。只有本地确实推不出（被删的校准
      // 锚点行之前没有任何已加载行）才按当前页重取一次；且绝不走 detailAll 的
      // DETAIL_ALL_PAGE_SIZE(=50000) 全量拉取——那正是要避免的卡壳路径。
      const result = removeEntriesAndUpdateRunningBalances(
        localEntries,
        deletedSet,
        accountId,
        accountKind,
        todayDateBusinessYmd(getTimeZonePreference()),
        openingBalance,
      );
      const removedCount = localEntries.length - result.entries.length;
      if (removedCount > 0) {
        setLocalEntries(result.entries);
        setLocalTotalCount((count) => Math.max(0, count - removedCount));
        setLocalOriginalCount((count) => Math.max(0, count - removedCount));
      }
      if (!result.complete && !detailAll) reloadDetailPage();
      void loadOriginalCount(detailDateRange);
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    };
  }, [accountId, accountKind, clientPaginationEnabled, detailAll, detailDateRange, isInvestAccount, loadOriginalCount, localEntries, openingBalance, refreshOnGlobalEvent, refreshTextOnlyPage, reloadDetailPage, router, scopeAccountIds, showRunningBalance]);

  // 取数实现放进 ref：下面这个 effect 只在「页码 / 页大小 / 时间范围」变的那一刻重取。
  // 不能把 reloadDetailPage 当依赖 —— 它随 openingBalancePending、缓存快照、期初余额换
  // 身份，换一次就会 abort 掉刚发出的那次取数；而 abort 之后的 re-run 又被 key 守卫挡
  // 回，切到缓存还没覆盖的窗口（缓存正在加载、期初余额刚发起）就会一直停在旧窗口的行和
  // 「共 N 条」上。abort 只应发生在 key 真的变了的时候。
  const reloadDetailPageRef = useRef(reloadDetailPage);
  reloadDetailPageRef.current = reloadDetailPage;

  // 页码写回与 URL / cookie 同步都收进 detailPager（onPersist）：这里不再有第二份。
  useEffect(() => {
    if (!clientPaginationEnabled) return;
    // 页码 / 页大小 / 时间范围都拼进 key：条件一变就必须重取，否则只是本地这份
    // page 上又筛了一遍。「全部」时页码固定为 1。
    const key = `${detailPaginationFetchKey(accountId, pageSize, detailAll, safePage)}|${serverDateRangeKey}`;
    const isFirstRun = !lastClientPaginationKeyRef.current;
    if (!isFirstRun && lastClientPaginationKeyRef.current === key) return;
    lastClientPaginationKeyRef.current = key;
    // 换页大小已在本地切完（同一页、行还在手上）：这一页不用再问服务端。
    // 一跳过就作废；key 对不上（期间又换了页 / 账户）也直接清掉，别留着挡后续取数。
    const skippedKey = skipPageFetchKeyRef.current;
    if (skippedKey !== null) {
      skipPageFetchKeyRef.current = null;
      if (skippedKey === key) return;
    }
    // 首次进入且不是「全部」时，服务端 RSC 已经给了这一页，不必再取。
    // 「全部」则必须立刻补：服务端现在只渲染一页（全量渲染 4 万行会产出上百 MB
    // HTML），剩下的要靠这里按块拉回来，否则表格永远停在那一页。
    //
    // 默认观测窗口也由 RSC 带上了（`initialDateRange`）：首屏那页、`共 N 条`、页码
    // 总数都是范围口径，客户端不必再按同一个范围重复取一遍。
    if (isFirstRun && !initialEntriesFromClientCache && !detailAll && (initialDateRange || !hasDetailDateRange)) return;
    // 首屏那份行还在、还是同一个账户同一个观测窗口、而且第 1 页能整页切片出来：
    // 量出来的页大小（比如 22）只是「一屏放几行」，RSC 给的行数够用，直接在本地切。
    // 只有真的要换窗口（翻页到第 2 页、拉宽观测范围、行已被别的取数替换）才发请求。
    const rscPage = rscPageWindowRef.current;
    if (
      !detailAll
      && safePage === 1
      && rscPage != null
      && rscPage.accountId === accountId
      && rscPage.rangeKey === serverDateRangeKey
      && rscPage.count >= Math.min(pageSize, localTotalCount)
      && localEntries.length === rscPage.count
      && (localEntries[0]?.id ?? "") === rscPage.headId
    ) {
      return;
    }

    const controller = new AbortController();
    reloadDetailPageRef.current(controller.signal, undefined, initialEntriesFromClientCache);

    return () => controller.abort();
  }, [accountId, clientPaginationEnabled, detailAll, hasDetailDateRange, initialDateRange, initialEntriesFromClientCache, localEntries, localTotalCount, pageSize, safePage, serverDateRangeKey]);

  // 时间轴两端（双滑块的可拖范围）永远取自**全量**数据：不受时间范围本身、也不受
  // 日期列筛选、URL 筛选影响，否则拖一次区间滑轨就缩到刚选的范围，再也拖不回更早
  // 的日期。分页模式下当前页只有几十行，从 rows 推导出来只有几天，所以任何模式下
  // 都取一次；拿到之前 chip 保持置灰，绝不拿一页的跨度冒充整条时间轴。
  const dateBoundsControllerRef = useRef<AbortController | null>(null);
  const dateBoundsLoadedAtRef = useRef(0);
  const dateBoundsRequestedAtRef = useRef(0);
  /** 已经拿到的边界（给 silent 补取判断「还没取到过」用，避免把 loading 藏掉）。 */
  const serverDateBoundsRef = useRef<{ min: string; max: string; futureMax?: string | null } | null>(null);
  /**
   * 取时间轴两端。
   *
   * 挂载后空闲时取一次就够 —— 边界是「这份数据最早/最晚到哪天」，不是每次打开
   * 弹层都要重算的派生值。唯一的例外是刚记了一笔未来流水：那会改变右端，所以
   * 「显示范围」打开时会静默补取一次（不显示读取中、3 秒内不重复发）。取到的值
   * 与手上的一致时不再 setState，避免无意义地重渲染整张表。
   */
  const loadServerDateBounds = useCallback((options?: { silent?: boolean }) => {
    const now = Date.now();
    if (options?.silent) {
      // 刚取过 / 正在取：点开弹层不该再打一趟接口。
      if (now - dateBoundsLoadedAtRef.current < 3000) return;
      if (now - dateBoundsRequestedAtRef.current < 3000) return;
    }
    dateBoundsRequestedAtRef.current = now;
    dateBoundsControllerRef.current?.abort();
    const controller = new AbortController();
    dateBoundsControllerRef.current = controller;
    const params = new URLSearchParams({ accountId, bounds: "1" });
    // 还没取到过边界时，即使是打开弹层触发的也要显示「读取中」，否则弹层只会是一句
    // 「没有可用的日期范围」。
    if (!options?.silent || serverDateBoundsRef.current == null) setServerDateBoundsLoading(true);
    return fetch(`/api/v1/transactions/detail?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) return null;
        const bounds = payload.data?.dateBounds;
        if (!bounds || typeof bounds.min !== "string" || typeof bounds.max !== "string") return null;
        const next = {
          min: bounds.min,
          max: bounds.max,
          futureMax: typeof bounds.futureMax === "string" && bounds.futureMax > bounds.max
            ? bounds.futureMax
            : null,
        };
        dateBoundsLoadedAtRef.current = Date.now();
        serverDateBoundsRef.current = next;
        setServerDateBounds((current) => (
          current && current.min === next.min && current.max === next.max && current.futureMax === next.futureMax
            ? current
            : next
        ));
        return next;
      })
      .catch((error) => {
        if (isAbortError(error)) return null;
        console.error("Load transaction detail date bounds failed:", error);
        return null;
      })
      .finally(() => {
        if (!controller.signal.aborted) setServerDateBoundsLoading(false);
      });
  }, [accountId]);

  /** 弹层打开时的补取：静默（不显示读取中）、3 秒内不重复发。 */
  const refreshServerDateBounds = useCallback(() => {
    void loadServerDateBounds({ silent: true });
  }, [loadServerDateBounds]);

  /**
   * 导出弹层打开时取一次整份视图的边界：它不能拿当前表格的 rows 当初值，
   * 那部分可能被时间轴和表头筛选裁过，导出窗口会跟着缩水。
   */
  const loadExportDefaultDateRange = useCallback(async () => {
    const bounds = await loadServerDateBounds();
    return bounds ? { start: bounds.min, end: bounds.max } : null;
  }, [loadServerDateBounds]);

  useEffect(() => {
    // 这一趟（整表 min/max，`no-store`）只给时间轴滑轨用，首屏一行都用不上；和首屏
    // 同时发等于替下一次「切账户」的 RSC 渲染争 CPU，所以推到首帧之后。
    const timer = window.setTimeout(loadServerDateBounds, DETAIL_PRELOAD_IDLE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      dateBoundsControllerRef.current?.abort();
    };
  }, [loadServerDateBounds]);

  /** 时间范围变化 = 数据范围变化：回到第 1 页并重新取数（不是本地筛当前页）。 */
  const handleDetailDateRangeChange = useCallback((next: { from: string; to: string }) => {
    setDetailDateRange(next);
    // 分母跟着范围走：表头筛选不变，但可见记录总数变了。
    void loadOriginalCount(next);
    // 按视图落盘：下次回到这个账户 / 刷新页面，首屏仍按这段范围取数。
    writeStoredDetailRangePreference(accountId, next.from || next.to ? next : null);
    goDetailPage(1);
  }, [accountId, goDetailPage, loadOriginalCount]);

  /**
   * 当前页要显示的行：
   * - 「全部」整份都在本地，不切；
   * - 自适应：量出行数后切到正好一屏（首屏多取的那几十行就是备料）；
   * - 手动选了固定行数：切到那个行数（首屏也可能多取了）。
   * 还没量过（服务端直出 / 首帧）时原样显示 —— 那样第一帧就铺满视口，不会
   * 出现「打开账户空一大格、选自适应才补上」。
   */
  const pageEntries = useMemo(() => {
    if (detailAll) return localEntries;
    // 量出行数之前（服务端直出 / 首帧）先按 cookie 里的页大小显示 —— 那是上一次
    // 的落地值，窗口没变时正好是一屏；不拿「多取的那 60 行」铺出去，否则页面
    // 先多出半屏、等表格量完才收缩，看起来就是「自适应判断得太靠后」。真正的
    // 行数由 detailPager 在 hydration 的绘制前测量里立刻落地，这一帧不会被
    // 用户看到。
    const visibleRows = pageSize;
    if (localEntries.length <= visibleRows) return localEntries;
    return localEntries.slice(0, visibleRows);
  }, [detailAll, localEntries, pageSize]);
  const displayRowsRef = useRef<DetailEntry[]>([]);
  const locateDateSeqRef = useRef(0);
  const pendingCenterDateRef = useRef<string | null>(null);
  const [isLocatingDate, setIsLocatingDate] = useState(false);
  const [locateScrollRequest, setLocateScrollRequest] = useState<{ key: string; id: number } | null>(null);
  const locateScrollRequestIdRef = useRef(0);
  const requestLocateScroll = useCallback((key: string) => {
    locateScrollRequestIdRef.current += 1;
    setLocateScrollRequest({ key, id: locateScrollRequestIdRef.current });
  }, []);

  /**
   * 视口正中那一行（滚动容器内按中心距离取最近的一行）。
   *
   * 换页大小、进入「全部」都靠它把「用户正在看哪批记录」固定住。只读 DOM、不触发
   * 网络；拿不到（虚拟化占位 / 空白区）时退回已渲染行的中间那一行。
   */
  const readCenteredEntry = (): DetailEntry | null => {
    const rows = displayRowsRef.current;
    if (rows.length === 0) return null;
    const viewport = panelRef.current?.querySelector(".advanced-table-viewport");
    let target: DetailEntry | undefined;
    if (viewport instanceof HTMLElement) {
      const viewportBox = viewport.getBoundingClientRect();
      if (viewportBox.height > 0) {
        const centerY = viewportBox.top + viewportBox.height / 2;
        let bestKey: string | null = null;
        let bestDist = Infinity;
        for (const el of Array.from(viewport.querySelectorAll<HTMLElement>("[data-advanced-row-key]"))) {
          const box = el.getBoundingClientRect();
          if (box.bottom < viewportBox.top || box.top > viewportBox.bottom) continue;
          const dist = Math.abs(box.top + box.height / 2 - centerY);
          if (dist < bestDist) {
            bestDist = dist;
            bestKey = el.getAttribute("data-advanced-row-key");
          }
        }
        if (bestKey) target = rows.find((entry) => entry.id === bestKey);
      }
    }
    if (!target) target = rows[Math.floor(rows.length / 2)];
    return target ?? null;
  };

  const readCenteredDetailDate = () => {
    const entry = readCenteredEntry();
    return entry ? detailEntryDayKey(entry, accountId) : null;
  };

  useEffect(() => {
    const dateYmd = pendingCenterDateRef.current;
    if (!dateYmd || localEntries.length === 0) return;
    const index = findEntryIndexForDate(localEntries, dateYmd, accountId);
    if (index < 0) return;
    pendingCenterDateRef.current = null;
    const target = localEntries[index];
    if (!target) return;
    requestLocateScroll(target.id);
  }, [accountId, localEntries, requestLocateScroll]);

  const handleDisplayRowsChange = useCallback((rows: DetailEntry[]) => {
    displayRowsRef.current = rows;
    const nextIds = rows.map((entry) => entry.id);
    setDisplayedEntryIds((current) => {
      if (!current) return nextIds;
      if (current.length !== nextIds.length) return nextIds;
      const currentIds = new Set(current);
      if (nextIds.every((id) => currentIds.has(id))) return current;
      return nextIds;
    });
  }, []);

  const visibleNormalExportRows = useMemo(() => {
    // 一律按「表格实际显示的行」重建：首屏为了自适应会多取
    // `DETAIL_PAGED_FIRST_FETCH_ROWS` 行，切片后多出来的备料不能跟着导出。
    if (!normalExportRowsByEntryId || displayedEntryIds === null || displayedEntryIds.length === 0) return normalExportRows;
    const [header = []] = normalExportRows;
    const rows = displayedEntryIds
      .map((id) => normalExportRowsByEntryId[id])
      .filter((row): row is string[] => Array.isArray(row));
    return [header, ...rows];
  }, [displayedEntryIds, normalExportRows, normalExportRowsByEntryId]);

  const applyPageSizeKeepingCenter = (nextPageSize: number, mode: "manual" | "fit") => {
    const centerEntry = readCenteredEntry();
    const centerDate = centerEntry ? detailEntryDayKey(centerEntry, accountId) : null;
    if (!clientPaginationEnabled || !centerDate) {
      detailPager.replace({ mode, rows: nextPageSize, page: 1 }, "locate");
      return;
    }
    /**
     * 中心行还在当前页：页码本地就能算出来，不必问服务端。
     *
     * `localEntries` 是当前页开头连续的一段，中心行在里面的下标就是页内偏移，
     * 全局序号 = (当前页 − 1) × 旧页大小 + 下标；除以新页大小取整即新页码。
     * 算出来仍是当前页时，这些行已经在手上，`pageEntries` 按新大小切片即可 ——
     * 以前这里固定发一次 `locateDate` 请求（服务端要重跑两遍全量排序链，实测
     * 1.2–1.5s），用户看到的就是「下拉已经变 40、表格还停在 80」的那一下停顿。
     *
     * 缩小后中心行跨到下一页时才回退服务端定位：那时手上没有那一页的行，
     * 直接改页码会先把前一页的内容当成新页渲染出来。
     */
    const localIndex = centerEntry ? localEntries.findIndex((entry) => entry.id === centerEntry.id) : -1;
    if (localIndex >= 0) {
      const globalIndex = (safePage - 1) * pageSize + localIndex;
      const nextPage = Math.floor(globalIndex / Math.max(1, nextPageSize)) + 1;
      if (nextPage === safePage) {
        // 新页要的行就是手上这份已加载页的前缀：切片即可。若行数不够（页变长），
        // 把标记留空，让取页 effect 照常补齐。
        const needed = Math.min(
          nextPageSize,
          Math.max(0, localTotalCount - (nextPage - 1) * nextPageSize),
        );
        skipPageFetchKeyRef.current = localEntries.length >= needed
          ? `${detailPaginationFetchKey(accountId, nextPageSize, detailAll, nextPage)}|${serverDateRangeKey}`
          : null;
        detailPager.replace({ mode, rows: nextPageSize, page: nextPage }, "locate");
        return;
      }
    }
    pendingCenterDateRef.current = centerDate;
    const seq = ++locateDateSeqRef.current;
    setIsLocatingDate(true);
    const params = new URLSearchParams({
      accountId,
      locateDate: centerDate,
      pageSize: String(nextPageSize),
    });
    // 换页大小只是「一页装几行」，不是把筛选放开：定位必须带同一份 filters，
    // 否则服务端按未筛选的结果算页码和 totalCount，表头会跳回全量条数。
    const locateFilters = buildPageFilters();
    if (Object.keys(locateFilters).length > 0) params.set("filters", JSON.stringify(locateFilters));
    // 定位/换页大小也在同一个时间范围内算页码，否则定位结果与表格不一致。
    if (hasDetailDateRange) params.set("range", serverDateRangeKey);
    fetch(`/api/v1/transactions/detail?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? t("basicDetail.loadFailed"));
        }
        if (seq !== locateDateSeqRef.current) return;
        const locatePage = Number(payload.data?.locatePage);
        const nextTotalCount = Number(payload.data?.totalCount);
        // 只拿 totalCount 算页码上限，绝不写回第三层的分子 / 分母：换每页行数只是
        // 「一页装几行」，筛选命中数与未筛总数都只能由筛选本身（取消 / 重新筛）改写。
        // 以前两处都写，徽标就从「701/20367」变成「701/701」。
        const pages = Math.max(1, Math.ceil((Number.isFinite(nextTotalCount) ? nextTotalCount : localTotalCount) / nextPageSize));
        detailPager.replace({
          mode,
          rows: nextPageSize,
          page: Number.isFinite(locatePage) && locatePage >= 1 ? clampPage(locatePage, pages) : 1,
        }, "locate");
      })
      .catch((error) => {
        if (seq !== locateDateSeqRef.current) return;
        console.error("Keep centered date after page-size change failed:", error);
        pendingCenterDateRef.current = null;
        detailPager.replace({ mode, rows: nextPageSize, page: 1 }, "locate");
      })
      .finally(() => {
        if (seq === locateDateSeqRef.current) setIsLocatingDate(false);
      });
  };

  // 「全部」加载进度里的总数：有第三层筛选时就是**结果集条数**（要拉的就是它），
  // 没有时仍按第二层窗口总数报。表头那行「共 N 条」永远是第二层的未筛总数，
  // 两者不混用：前者说「这次在拉多少」，后者说「窗口里一共多少」。
  const allLoadTotalCount = allViewResultFiltered
    ? (allViewTotal > 0 ? allViewTotal : localTotalCount)
    : localOriginalCount;
  // 「全部」：整份列表一次渲染完，没有页大小可调，所以不测自适应。
  const rowsFitEnabled = detailPager.autoFit;
  /**
   * 表格量出视口容量 → 唯一状态点。
   *
   * 切片是同步的、改页大小要等一次重取：hook 落地后 `pageSize` 当帧就变，
   * 表格当帧填满，重取回来的行数与之一致，没有肉眼可见的空档。
   */
  const handleRowsFitChange = detailPager.fit;

  const handleLocateDate = (dateYmd: string) => {
    if (!clientPaginationEnabled || !dateYmd) return;
    if (detailAll) {
      // Show-all mode: the loaded list is fully rendered (virtualized beyond
      // ROW_VIRTUALIZATION_THRESHOLD rows), so locating is a client-side
      // viewport scroll — center the first entry of the requested date, or the
      // nearest day in list order when that date has no entries.
      const rows = displayRowsRef.current;
      if (!rows || rows.length === 0) return;
      const index = findEntryIndexForDate(rows, dateYmd, accountId);
      const target = index >= 0 ? rows[index] : undefined;
      if (!target) return;
      requestLocateScroll(target.id);
      return;
    }
    const seq = ++locateDateSeqRef.current;
    const locatePageSize = pageSize;
    locatingDateRef.current = true;
    setIsLocatingDate(true);
    const params = new URLSearchParams({
      accountId,
      locateDate: dateYmd,
      pageSize: String(locatePageSize),
    });
    // 定位是「在筛选结果里翻到那天」，不是「回到未筛选的整份」：不带 filters
    // 的话定位出的页码和 totalCount 都属于另一个结果集。
    const locateFilters = buildPageFilters();
    if (Object.keys(locateFilters).length > 0) params.set("filters", JSON.stringify(locateFilters));
    if (hasDetailDateRange) params.set("range", serverDateRangeKey);
    fetch(`/api/v1/transactions/detail?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? t("basicDetail.loadFailed"));
        }
        if (seq !== locateDateSeqRef.current) return;
        const locatePage = Number(payload.data?.locatePage);
        const nextTotalCount = Number(payload.data?.totalCount);
        const nextCount = Number.isFinite(nextTotalCount) ? nextTotalCount : localTotalCount;
        // 同 applyPageSizeKeepingCenter：定位只算页码，不写第三层的任何数字。
        const pages = Math.max(1, Math.ceil(nextCount / locatePageSize));
        if (!Number.isFinite(locatePage) || locatePage < 1) {
          locatingDateRef.current = false;
          return;
        }
        // 不能走 goPage：它按当前 totalPages 钳页。定位前若 localTotalCount
        // 还是首页条数，totalPages=1，75 会被打回 1。用接口 totalCount 先算
        // pages，再 setPage；跨页交给分页 effect 拉数，不要预写 fetch key
        // 再自己打一枪——预写后一旦这枪失败，页码和列表都会停在原地。
        const nextPage = clampPage(locatePage, pages);
        const locateIndex = Number(payload.data?.locateIndex);
        if (nextPage === page) {
          locatingDateRef.current = false;
          if (Number.isFinite(locateIndex)) {
            const inPageIndex = locateIndex - (nextPage - 1) * locatePageSize;
            const rows = displayRowsRef.current;
            const target = rows && inPageIndex >= 0 && inPageIndex < rows.length ? rows[inPageIndex] : null;
            if (target) {
              requestLocateScroll(target.id);
            }
          }
          return;
        }
        pendingCenterDateRef.current = dateYmd;
        detailPager.forcePage(nextPage);
      })
      .catch((error) => {
        if (seq === locateDateSeqRef.current) {
          locatingDateRef.current = false;
          console.error("Locate date failed:", error);
        }
      })
      .finally(() => {
        if (seq === locateDateSeqRef.current) setIsLocatingDate(false);
      });
  };

  const selectionResetKey = accountScopeKey;
  const tableResetKey = selectionResetKey;
  const closeGuideOverlay = () => {
    setGuideOverlayOpen(false);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("guide");
    replaceCurrentRouteUrl(`${url.pathname}${url.search}${url.hash}`);
  };
  const guideWidth = guideMetrics?.width ?? 1024;
  const guideHeight = guideMetrics?.height ?? 560;
  const headerTargetRect = guideMetrics?.headerCell ?? guideMetrics?.header ?? null;

  return (
    <BasicDetailSelectionProvider resetKey={selectionResetKey}>
      <BasicDetailBatchDeleteMessage />
      <div ref={panelRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 desktop:hidden">
          <span className="text-xs text-slate-500">{t("creditBillDetail.recordCount", { count: localOriginalCount })}</span>
          {showPagination ? (
            <DetailTablePaginationControls
              key={accountScopeKey}
              pager={detailPager}
              pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
              onLocateDate={clientPaginationEnabled ? handleLocateDate : undefined}
              locateDateBusy={isLocatingDate}
            />
          ) : null}
        </div>
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={isInvestAccount}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          batchReplaceAccountOptions={batchReplaceAccountOptions}
          categoryOptions={categoryOptions}
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows={compactRows}
          resetKey={tableResetKey}
          focusEntryId={focusEntryId}
          scrollToRowKey={locateScrollRequest?.key ?? null}
          scrollToRowRequestId={locateScrollRequest?.id}
          showAccountColumn={showAccountColumn}
          reorderAccountIds={scopeAccountIds}
          toolbarMode="custom"
          toolbarTitle={t("basicDetail.entriesTitle")}
          showRunningBalance={showRunningBalance ?? !isInvestAccount}
          // 时间筛选器在两种模式下都开：滑轨两端取全量边界（bounds=1），与当前
          // 页有多少行、以及范围/日期列筛选都无关。
          showDateRangeFilter
          // 绑定货基的钱包：表头换成「收益」开关（默认关）。
          showMoneyIncomeToggle={showMoneyIncomeToggle}
          showMoneyIncome={localShowMoneyIncome}
          onMoneyIncomeChange={handleMoneyIncomeChange}
          dateRange={detailDateRange}
          dateRangeBounds={serverDateBounds}
          onDateRangeBoundsRefresh={refreshServerDateBounds}
          dateRangeBoundsLoading={serverDateBoundsLoading}
          onDateRangeChange={handleDetailDateRangeChange}
          detailQueryRange={hasDetailDateRange ? serverDateRangeKey : undefined}
          // 表头列筛选：分页模式 -> 下推服务端（作用于时间轴内的全部记录）；
          // 「全部」模式整份都在本地，保持表格自己的本地筛选。
          remoteTableFilters={!detailAll}
          initialTableFilters={initialTableFilters}
          onTableFiltersChange={handleTableFiltersChange}
          // 筛选徽标按服务端口径报「筛选后/全部」：分页模式下表格只有一页行，
          // 按页内行数算会显示成「23/23」，跟筛选无关。「全部」模式整份在本地，
          // 命中数交给表格自己数；**整份还没到齐时**必须用服务端算好的命中数 ——
          // 拿已加载的前几百分块去数，会先显示「11/20367」再跳成「701/20367」，
          // 看起来就像挂了两个筛选。分母在任何时候都是未筛选的窗口总数。
          filterCounts={detailAll
            ? (allSnapshotDone
              ? { total: localOriginalCount }
              : { filtered: totalCount, total: localOriginalCount })
            : { filtered: localTotalCount, total: localOriginalCount }}
          // 分页模式下 `rows` 只有当前页：漏斗候选值单独用「时间轴范围内的整份记录」
          // 汇总，打开漏斗时取一次最新快照。
          filterOptionRows={tableFilterOptionRows}
          onFilterColumnOpen={handleTableFilterColumnOpen}
          reconcileEnabled={showReconcile}
          // 有明细筛选时列表由 RSC 的 entries prop 持有，DetailViewClient 的
          // 重取不带筛选参数，会把筛选结果冲掉 —— 交给上面的整棵刷新。
          // 「全部」也全部交给父层（reloadDetailPage）：父层知道当前是服务端分页
          // 还是本地分块，子组件只会无脑 loadAllDetailEntries（先 500 条再一次性
          // 拉五万条）。两边同时订阅 finance:changed 的后果是——父层刚按分页摆好
          // 40 行，子层又塞回整份五万行，下一次父层刷新再摆回 40 行，表格看起来
          // 一直在闪，工具栏还长时间停在「已加载 500 条」。
          refreshOnGlobalEvent={refreshOnGlobalEvent && clientPaginationEnabled && !detailAll}
          parentOwnsRefresh
          draggableRows={draggableRows}
          sortable={sortable}
          onRowsFitChange={rowsFitEnabled ? handleRowsFitChange : undefined}
          toolbarRightContent={
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 text-xs">
              {/* 「共 N 条」恒为第二层（窗口）的未筛总数，与「全部 / 每页 40 / 80」无关；
                  第三层筛选的命中数只在徽标 `n/m` 里报（用户 2026-11-28 裁定）。 */}
              <span className="min-w-0 text-xs text-slate-600">{t("creditBillDetail.recordCount", { count: localOriginalCount })}{isPageLoading ? (detailAll
            ? allLoadedCount > 0
              ? t("basicDetail.loadingAllSuffix", { count: allLoadTotalCount, loaded: allLoadedCount })
              : t("basicDetail.loadingAllPending", { count: allLoadTotalCount })
            : t("basicDetail.loadingSuffix")) : ""}</span>
              {showImportExport ? (
                <>
                  <span className={`${HANDSET_HIDDEN_CLASS} text-slate-400`}>|</span>
                  <ViewExcelImportMenuButton
                    className={HANDSET_HIDDEN_CLASS}
                    kind="normal"
                    accountId={accountId}
                    accountName={accountName || accountLabel || t("basicDetail.currentAccount")}
                    mailImport={{
                      accountId,
                      accountName: accountName || accountLabel || t("basicDetail.currentAccount"),
                    }}
                    excelExport={{
                      rows: visibleNormalExportRows,
                      filename: normalExportFilename,
                      sheetName: t("basicDetail.entriesTitle"),
                      title: t("basicDetail.exportExcelTitle"),
                      description: accountKind === "bank_credit" ? t("basicDetail.exportCreditDesc") : t("basicDetail.exportNormalDesc"),
                      dateColumnIndex: 0,
                      // 初值取「这个视图最早 / 最晚的一条记录」（`bounds=1`），不取
                      // 表格时间轴那一段。还没取到就回退到表格当前这段（`rows` 推导），
                      // 不会给出空的日期框。
                      defaultDateRange: fullRangeExport && serverDateBounds
                        ? { start: serverDateBounds.min, end: serverDateBounds.max }
                        : undefined,
                      // 弹层打开时再取一次：首屏的 idle 补取可能还没回来，不能让
                      // 默认日期退回当前页 / 当前筛选结果的 rows 边界。
                      loadDefaultDateRange: fullRangeExport ? loadExportDefaultDateRange : undefined,
                      // 有它，导出内容才是「账户 / 视图 × 导出弹层所选日期区间」的
                      // 整份明细：不继承表格时间轴，也不继承表头筛选。
                      loadRows: fullRangeExport
                        ? async ({ start, end }) => {
                          const params = new URLSearchParams({ accountId, export: "1" });
                          // 导出是独立的只读动作：URL 的 filters / tableFilters 只用来
                          // 恢复表格漏斗，绝不进入导出口径；range 也只取弹层里选的
                          // 那一段，不是表格的显示范围。
                          if (start || end) params.set("range", `${start}~${end}`);
                          const response = await fetch(`/api/v1/transactions/detail?${params.toString()}`, { cache: "no-store" });
                          const payload = await response.json().catch(() => null);
                          if (!response.ok || !payload?.ok) {
                            throw new Error(payload?.error ?? t("basicDetail.loadFailed"));
                          }
                          return Array.isArray(payload.data?.rows) ? (payload.data.rows as string[][]) : [];
                        }
                        : undefined,
                    }}
                    dataBasicDetailImport
                  />
                </>
              ) : null}
              {showBalanceReconcile ? (
                <DebitBalanceReconcileButton
                  accountId={accountId}
                  accountLabel={accountLabel}
                  currentBalance={currentBalance}
                />
              ) : null}
              {showPagination ? (
                <>
                  <span className="text-slate-400">|</span>
                  <DetailTablePaginationControls
                    key={accountScopeKey}
                    pager={detailPager}
                    pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
                    onLocateDate={clientPaginationEnabled ? handleLocateDate : undefined}
                    locateDateBusy={isLocatingDate}
                  />
                </>
              ) : null}
            </div>
          }
          onDisplayRowsChange={handleDisplayRowsChange}
          // 只有真的分页时才接管 PageUp/PageDown：「全部」模式没有页可翻，
          // 不传这个入口，表格就退回「翻一屏」（几万行的虚拟列表更好用）。
          onPageStep={showPagination && !detailAll ? handleKeyboardPageStep : undefined}
        />
        {guideOverlayOpen && guidePortalHost ? createPortal((
          <div className="pointer-events-none fixed inset-0 z-[80] hidden overflow-hidden desktop:block" aria-live="polite">
            <div className="absolute inset-0 bg-slate-900/[0.02]" />
            <GuideHotspot
              rect={guideMetrics?.entryButton ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.entry.title")}
            >
              {t("basicDetail.guide.entry.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.toolbarTools ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.importExport.title")}
            >
              {t("basicDetail.guide.importExport.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={headerTargetRect}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.headerSort.title")}
            >
              {t("basicDetail.guide.headerSort.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.rowControls ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.dragSelect.title")}
            >
              {t("basicDetail.guide.dragSelect.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.bodyRowFocus ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.doubleClickEdit.title")}
            >
              {t("basicDetail.guide.doubleClickEdit.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.rowActions ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.rowActions.title")}
            >
              {t("basicDetail.guide.rowActions.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.resizeHandle ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              tone="emerald"
              title={t("basicDetail.guide.resizeColumn.title")}
            >
              {t("basicDetail.guide.resizeColumn.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.columnSettings ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              tone="emerald"
              title={t("basicDetail.guide.columnSettings.title")}
            >
              {t("basicDetail.guide.columnSettings.text")}
            </GuideHotspot>

            <button
              type="button"
              onClick={closeGuideOverlay}
              className="pointer-events-auto absolute bottom-5 right-5 z-40 flex h-7 items-center gap-1.5 rounded-md border border-slate-200/80 bg-white/[0.74] px-2 text-xs font-medium text-slate-600 shadow-sm backdrop-blur-sm transition-colors hover:bg-white/90 hover:text-slate-900"
              title={t("basicDetail.guide.close")}
            >
              <X className="h-4 w-4" />
              {t("basicDetail.guide.close")}
            </button>
          </div>
        ), guidePortalHost) : null}
      </div>
    </BasicDetailSelectionProvider>
  );
}
