"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DebitBalanceReconcileButton } from "@/components/DebitBalanceReconcileButton";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { foldRunningBalancesInDescOrder, removeEntriesAndUpdateRunningBalances } from "@/lib/detail-running-balance";
import { ViewExcelImportMenuButton } from "@/components/ViewExcelImportMenuButton";
import { FINANCE_DATA_CHANGED_EVENT, type FinanceDataChangedDetail } from "@/lib/client/refresh";
import { formatDateUtc, todayDateBusinessYmd } from "@/lib/date-utils";
import { getTimeZonePreference } from "@/lib/client/appPreferences";
import { getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  DETAIL_PAGE_SIZE_OPTIONS,
  clampDetailPage as clampPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
  writeStoredDetailPreference,
} from "@/lib/detail-pagination-preference";
import { isAbortError } from "@/lib/client/detail-all-entries";
import {
  detailAllCacheKey,
  detailRangeCovers,
  dropDetailAllCache,
  ensureDetailAll,
  filterEntriesByRange,
  invalidateDetailAll,
  peekDetailAll,
  subscribeDetailAll,
  type DetailAllSnapshot,
} from "@/lib/client/detail-all-store";
import { useI18n } from "@/lib/i18n";
import { useRowsFitPageAnchor } from "@/lib/client/use-rows-fit-page-anchor";
import { ALL_CASH_DETAIL_SCOPE_ID, isAllCashDetailScope } from "@/lib/all-cash-entries";

/** 一页明细分页请求的结果：只保留渲染真正需要的两样。 */
type DetailPagePayload = {
  entries: DetailEntry[];
  totalCount: number | null;
};

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
  totalCount: number;
  originalCount: number;
  hasDetailFilters: boolean;
  initialPage: number;
  initialPageSize: number;
  /**
   * 「显示范围」的初值（服务端已经按它查了这一页）。必须由 RSC 传进来：默认的
   * 近 5 年窗口要同时作用在首屏行、`共 N 条`、页码总数上，客户端自己算一个范围
   * 去重取的话，表头会先闪一遍全量数字。
   */
  initialDateRange?: { from: string; to: string };
  initialDetailAll: boolean;
  initialAutoFit?: boolean;
  normalExportFilename: string;
  normalExportRows?: string[][];
  normalExportRowsByEntryId?: Record<string, string[]>;
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
  batchReplaceAccountOptions?: Array<{ id: string; label: string; listLabel?: string | null }>;
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

/**
 * 「全部」= 整份拉到本地，**不再按数据量切换成服务端分页**。
 *
 * 曾经有一条 2 万行的阈值：超过就切成「每页自适应」的分页浏览（表头还写着「全部」）。
 * 结果只要在「全部」里动一次时间轴、总量跨过阈值，表格就从「一屏滚动看全部」变回
 * 自适应的二三十行 —— 表头说全部、实际是分页，用户会认为「全部」失效了。
 *
 * 现在把语义定死：选中「全部」就一直是一屏滚动的全部（虚拟滚动 + 分块加载，加载
 * 期间照样能滚）。代价是大范围要等分块取完（有进度提示），这比「悄悄变成另一种
 * 模式」可预期得多。
 *
 * 服务端分页那一整套（`serverPagedAll` 分支、filters/sort 下推、facets）保留着不用：
 * 数据规模真的到几十万行时，唯一可行的仍然是分页 + 下推，届时把下面这条阈值恢复
 * 成 `detailAll && localTotalCount > THRESHOLD` 即可。
 */
// const SERVER_PAGED_ALL_THRESHOLD = 20000;

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

export function BasicDetailPanel({
  accountId,
  isInvestAccount,
  entries,
  totalCount,
  originalCount,
  hasDetailFilters,
  initialPage,
  initialPageSize,
  initialDateRange,
  initialDetailAll,
  initialAutoFit = true,
  normalExportFilename,
  normalExportRows = [],
  normalExportRowsByEntryId,
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
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [localTotalCount, setLocalTotalCount] = useState(totalCount);
  const [localOriginalCount, setLocalOriginalCount] = useState(originalCount);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);
  const [autoFit, setAutoFit] = useState(initialAutoFit);
  const [isPageLoading, setIsPageLoading] = useState(false);
  // 「全部」分块加载的进度（已回到本地的行数），仅用于加载提示文案。
  const [allLoadedCount, setAllLoadedCount] = useState(0);
  const [displayedEntryIds, setDisplayedEntryIds] = useState<string[] | null>(null);
  const [guideOverlayOpen, setGuideOverlayOpen] = useState(showGuideOverlay);
  const [guideMetrics, setGuideMetrics] = useState<GuideMetrics | null>(null);
  const [guidePortalHost, setGuidePortalHost] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const totalPages = Math.max(1, Math.ceil(localTotalCount / pageSize));
  // 「全部」超过阈值后走服务端分页：detailAll 的产品语义不变（就是要看全部），
  // 但数据改成按页取，漏斗与排序下推 SQL（见 detail-query-filters）。
  // 只在没有 RSC 侧筛选时启用，避免和 URL 筛选两套口径打架。
  const [serverSort, setServerSort] = useState<{ key: string; direction: "asc" | "desc" } | null>(null);
  const [serverFacets, setServerFacets] = useState<Record<string, Array<{ value: string; count: number }>> | null>(null);
  /** 「显示范围」滑轨两端（全量数据的最早/最晚一天）。 */
  const [serverDateBounds, setServerDateBounds] = useState<{ min: string; max: string } | null>(null);
  /** 时间轴两端还在取数：弹层里提示「正在读取时间轴」，chip 本身照常显示。 */
  const [serverDateBoundsLoading, setServerDateBoundsLoading] = useState(true);
  // 恒为 false：见 SERVER_PAGED_ALL_THRESHOLD 的说明 —— 「全部」始终整份拉到本地，
  // 不再因为时间轴把总量推过阈值就偷偷切成「每页自适应」的分页浏览。
  //
  // 为什么不按「进入全部那一刻的总量」做快照：快照同样会撞上同一个矛盾 —— 默认
  // 窗口（2.1 万行）点「全部」得到的是分页浏览，表头却写着「全部」。
  const serverPagedAll = false;
  const [serverFilters, setServerFilters] = useState<Partial<Record<string, string[]>>>({});
  const serverFilterKey = JSON.stringify(serverFilters);
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
  const lastInitialRangeKeyRef = useRef(initialDateRange ? `${initialDateRange.from}~${initialDateRange.to}` : "");
  useEffect(() => {
    const nextKey = initialDateRange ? `${initialDateRange.from}~${initialDateRange.to}` : "";
    if (nextKey === lastInitialRangeKeyRef.current) return;
    lastInitialRangeKeyRef.current = nextKey;
    setDetailDateRange(initialDateRange ? { from: initialDateRange.from, to: initialDateRange.to } : { from: "", to: "" });
  }, [initialDateRange]);
  const serverSortKey = serverSort ? `${serverSort.key}:${serverSort.direction}` : "";
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const locatingDateRef = useRef(false);
  // Do not clamp the target page to 1 using stale totalPages while locating a date;
  // otherwise the pagination effect will fetch page 1 again.
  const safePage = detailAll && !serverPagedAll ? 1 : locatingDateRef.current ? Math.max(1, page) : clampPage(page, totalPages);
  const accountScopeKey = `${accountId}:${isInvestAccount ? "invest" : "detail"}`;
  const lastAccountScopeKeyRef = useRef(accountScopeKey);
  const lastFocusEntryIdRef = useRef(focusEntryId ?? "");
  const lastClientPaginationKeyRef = useRef("");
  const clientPaginationEnabled = !hasDetailFilters;
  // 「当前在看哪一页」的标识。重取结果是否采用，看它是否仍等于当前页：
  // 之前用的是单调递增的 seq —— 任何一次重取（包括马上被 abort 的那次）都会让
  // 之前那笔仍然有效、数据更新的响应被判成过期丢掉，表现就是「记一笔保存成功，
  // 表格里却没有新行」。同一个 key 的响应谁先到都能用，key 变了（翻页 / 改页大小）
  // 才丢。
  const detailPageKey = `${accountId}|${detailAll && !serverPagedAll ? "all" : String(safePage)}|${pageSize}|${serverPagedAll ? `${serverFilterKey}|${serverSortKey}` : ""}|${serverDateRangeKey}`;
  const detailPageKeyRef = useRef(detailPageKey);
  detailPageKeyRef.current = detailPageKey;

  /**
   * 「全部」模式：整份明细由模块级仓库（`detail-all-store`）持有，分块进度、完成
   * 结果都留在那里。组件只负责「订阅 + 渲染」：
   * - 换页面再回来（组件重挂载）拿的是仓库里的当前进度，不会从头再拉；
   * - 在途任务不会因为卸载而作废，也不会被重复发起第二份。
   */
  /**
   * 行数据只有一份。
   *
   * 现金类账户（`deriveFromAllCashCache`）不再单独拉自己的明细，而是复用
   * `__all_cash__` 那份缓存：两者的行只差一个筛选条件（本账户 / 作为收款侧，
   * 外加排除外币转换行），字段逐行相同，顺序也是同一套排序键的子序列。
   * 余额不在缓存里，筛出来之后本地补（`foldRunningBalancesInDescOrder`，
   * 与服务端 `balanced` CTE 等价，实测逐分一致）。
   *
   * 非现金账户（贷款 / 往来款 / 存款 / 保险 / 基金理财）不在那份集合里，
   * 仍然按自己的 accountId 各存一份。
   */
  const detailCacheScopeId = deriveFromAllCashCache ? ALL_CASH_DETAIL_SCOPE_ID : accountId;
  const detailAllKey = detailAllCacheKey(detailCacheScopeId);
  const detailAllRangeKey = hasDetailDateRange ? serverDateRangeKey : undefined;
  const businessTodayKey = todayDateBusinessYmd(getTimeZonePreference());

  /** 让共享缓存的行变成「本视图口径」：筛出本账户的行 + 补算余额。 */
  const scopeEntriesOf = useCallback((shared: DetailEntry[]) => {
    if (!deriveFromAllCashCache) return shared;
    const own = shared.filter(
      (entry) => entry.accountId === accountId
        || (entry.toAccountId === accountId && entry.source !== "fx_conversion"),
    );
    return foldRunningBalancesInDescOrder(own, accountId, accountKind, businessTodayKey);
  }, [accountId, accountKind, businessTodayKey, deriveFromAllCashCache]);

  const lastAppliedAllRef = useRef<{ entries: DetailEntry[] | null; range: string | undefined }>({ entries: null, range: undefined });

  /**
   * 把仓库快照落到表格上（「全部」模式）。
   *
   * 仓库里那份永远是「全部时间」的整份明细，所以时间轴怎么改都不需要重新请求：
   * 这里按当前窗口本地裁掉窗口外的行（`filterEntriesByRange`）即可。
   */
  const applyDetailAllSnapshot = useCallback((snapshot: DetailAllSnapshot<DetailEntry>) => {
    const last = lastAppliedAllRef.current;
    const rows = filterEntriesByRange(scopeEntriesOf(snapshot.entries), detailAllRangeKey);
    if (snapshot.entries !== last.entries || detailAllRangeKey !== last.range) {
      lastAppliedAllRef.current = { entries: snapshot.entries, range: detailAllRangeKey };
      setLocalEntries(rows);
    }
    if (snapshot.done) {
      // 计数必须是「当前窗口内」的行数：窗口从 5 年收到 3 年，表头不能还报 5 年的总数。
      setAllLoadedCount(rows.length);
      setLocalTotalCount(rows.length);
      setLocalOriginalCount(rows.length);
      locatingDateRef.current = false;
      setIsPageLoading(false);
    } else {
      setAllLoadedCount(snapshot.loadedCount);
      if (Number.isFinite(snapshot.totalCount)) {
        setLocalTotalCount(snapshot.totalCount);
        setLocalOriginalCount(snapshot.totalCount);
      }
      setIsPageLoading(true);
    }
  }, [detailAllRangeKey, scopeEntriesOf]);

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
    const windowed = filterEntriesByRange(scopeEntriesOf(snapshot.entries), detailAllRangeKey);
    const start = (pageNo - 1) * size;
    // 页码落在还没拉回来的那一段：交给按页取数兜底，别显示空页。
    if (start >= windowed.length && windowed.length > 0) return null;
    return { entries: windowed.slice(start, start + size), totalCount: windowed.length };
  }, [detailAllKey, detailAllRangeKey, scopeEntriesOf]);

  const reloadDetailPage = useCallback((signal?: AbortSignal) => {
    if (!clientPaginationEnabled) return;
    const requestKey = `${accountId}|${detailAll && !serverPagedAll ? "all" : String(safePage)}|${pageSize}|${serverPagedAll ? `${serverFilterKey}|${serverSortKey}` : ""}|${serverDateRangeKey}`;
    if (detailAll && !serverPagedAll) {
      // 「全部」= 窗口内整份：缓存里已经有了，只取快照，不发请求。
      const snapshot = ensureDetailAll<DetailEntry>({
        key: detailAllKey,
        accountId: detailCacheScopeId,
        range: detailAllRangeKey,
        errorMessage: t("basicDetail.loadFailed"),
      });
      // 空快照 = 刚发起的任务还没有数据，别把已有列表清空。
      if (snapshot.entries.length > 0 || snapshot.done) applyDetailAllSnapshot(snapshot);
      return;
    }
    // 缓存优先：窗口内数据齐了就从本地切这一页。
    const cached = readCachedDetailPage(safePage, pageSize);
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
      return;
    }
    const params = new URLSearchParams({
      accountId,
      page: String(safePage),
      pageSize: String(pageSize),
    });
    // 窗口还没齐（刚进页面）：照旧按页取一次，范围无条件下推。
    if (hasDetailDateRange) params.set("range", serverDateRangeKey);
    if (serverPagedAll) {
      if (serverFilterKey !== "{}") params.set("filters", serverFilterKey);
      if (serverSortKey) params.set("sort", serverSortKey);
    }
    // 不带 `no-store`：接口发了 ETag，刷新/重进时浏览器会带 If-None-Match 回来，
    // 没变就 304 用本地副本。
    setIsPageLoading(true);
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
      setLocalEntries(payload.entries);
      if (payload.totalCount != null) {
        setLocalTotalCount(payload.totalCount);
        setLocalOriginalCount(payload.totalCount);
      }
      locatingDateRef.current = false;
      setIsPageLoading(false);
    })();
  }, [accountId, applyDetailAllSnapshot, clientPaginationEnabled, detailAll, detailAllKey, detailAllRangeKey, detailCacheScopeId, hasDetailDateRange, pageSize, readCachedDetailPage, safePage, serverDateRangeKey, serverFilterKey, serverPagedAll, serverSortKey, t]);

  // 后台按「当前窗口」（默认就是设置里的观测年数）把整份明细读进缓存，与页码无关：
  // 之后翻到哪一页、把窗口缩小都只在本地切，不再产生请求。窗口放大到超出已拉范围时
  // 才重新拉一份更宽的 —— 缩窗永远不丢缓存。任务归 detail-all-store 所有，
  // 切页面、组件卸载都不会中断它。
  useEffect(() => {
    if (!clientPaginationEnabled) return;
    ensureDetailAll<DetailEntry>({
      key: detailAllKey,
      accountId: detailCacheScopeId,
      range: detailAllRangeKey,
      errorMessage: t("basicDetail.loadFailed"),
    });
  }, [clientPaginationEnabled, detailAllKey, detailAllRangeKey, detailCacheScopeId, t]);

  // 「全部」的加载由仓库推进，这里只订阅：整份到齐才重建表格（并发分块阶段
  // 只滚进度数字，不为每一块重建两万行），完成时收掉加载态。
  // 组件卸载只取消订阅，任务继续在后台跑完（下次回来直接是成品）。
  useEffect(() => {
    if (!detailAll || serverPagedAll || !clientPaginationEnabled) return;
    const unsubscribe = subscribeDetailAll<DetailEntry>(detailAllKey, applyDetailAllSnapshot);
    // 订阅只在「有新块到达」时回调；范围刚变（重挂载 / 改窗口）时先拿现有快照
    // 按新范围重渲染一次 —— 这一刻不该有任何请求。
    const current = peekDetailAll<DetailEntry>(detailAllKey);
    if (current) applyDetailAllSnapshot(current);
    return unsubscribe;
  }, [applyDetailAllSnapshot, clientPaginationEnabled, detailAll, detailAllKey, serverPagedAll]);

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
    }
    if (accountScopeChanged || focusEntryChanged) {
      lastAccountScopeKeyRef.current = accountScopeKey;
      lastFocusEntryIdRef.current = nextFocusEntryId;
      const storedPreference = nextFocusEntryId ? null : readStoredDetailPreference(accountId);
      const nextPageSize = nextFocusEntryId ? normalizedInitialPageSize : storedPreference?.pageSize ?? normalizedInitialPageSize;
      const nextDetailAll = nextFocusEntryId ? initialDetailAll : storedPreference?.detailAll ?? initialDetailAll;
      const nextAutoFit = nextFocusEntryId ? initialAutoFit : storedPreference?.autoFit ?? initialAutoFit;
      const nextTotalPages = Math.max(1, Math.ceil(totalCount / nextPageSize));
      setPageSize(nextPageSize);
      setDetailAll(nextDetailAll);
      setAutoFit(nextAutoFit);
      setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages));
    }
  }, [accountId, accountScopeKey, clientPaginationEnabled, entries, focusEntryId, initialAutoFit, initialDetailAll, initialPage, normalizedInitialPageSize, originalCount, totalCount]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail ?? {};
      const eventAccountIds = detail.accountIds ?? [];
      // 已落地的「全部」结果可能已经过期：只作废缓存，不碰在途任务 —— 在途那
      // 份拉的是服务端最新数据，中途打断它才是真正的「又从头加载几万条」。
      // startup-check 只是每日任务的例行提示，数据没变，连缓存都不用丢。
      if (detail.reason !== "startup-check") dropDetailAllCache();
      const isCurrentAccountEvent = eventAccountIds.length === 0
        || eventAccountIds.includes(accountId)
        || (isAllCashDetailScope(accountId) && (scopeAccountIds?.some((id) => eventAccountIds.includes(id)) ?? true));
      if (
        event.type === FINANCE_DATA_CHANGED_EVENT &&
        detail.reason === "view-normal-excel-import" &&
        isCurrentAccountEvent
      ) {
        invalidateDetailAll();
        reloadDetailPage();
        return;
      }

      // 对账 / 解锁只改写明细行的 reconciledAt / reconciledBalance（锁标记 + 余额锚点），
      // 本地快照推不出这两个字段的差异（删行重算那套逻辑用不上）→ 必须重取。
      // 没有这个分支，锁定/解锁后列表不刷新，行上的锁图标永远不出现，也就无从解锁。
      if (
        event.type === FINANCE_DATA_CHANGED_EVENT &&
        detail.reason === "entry-reconcile" &&
        isCurrentAccountEvent
      ) {
        // 有明细筛选时 localEntries 由 RSC 的 entries prop 持有，客户端分页
        // 取数路径是禁用的，只能整棵刷新。
        invalidateDetailAll();
        if (clientPaginationEnabled) reloadDetailPage();
        else router.refresh();
        return;
      }

      const deletedEntryIds = detail.deletedEntryIds ?? [];
      if (deletedEntryIds.length === 0) {
        // 新增（「记一笔」）：客户端分页打开时这里刻意不接收 RSC 传来的新
        // entries（否则翻页会被冲回第 1 页），而「共 N 条」计数同样来自本地
        // 快照 —— 只有按当前页重取一次，新行和计数才会一起出现。
        // 没有这个分支时的表现：保存成功，但表格里看不到新行、计数不动，
        // 用户以为「记一笔失败」。
        const isCreateEvent = detail.reason === "transaction-save" && (detail.entryIds?.length ?? 0) === 0;
        if (isCurrentAccountEvent && clientPaginationEnabled && refreshOnGlobalEvent && isCreateEvent) {
          if (detailAll) invalidateDetailAll();
          reloadDetailPage();
          return;
        }
        // 编辑类改动：常规视图交给 DetailViewClient 按当前页重取（不再整页刷新，
        // 服务端编辑保存也不再 purge 当前路由）。下面两种情形它补不了，只能
        // 整棵刷新：① 有明细筛选——数据由 RSC 的 entries prop 持有，客户端
        // 分页取数被禁用，且重取不带筛选条件会把筛选结果冲掉；
        // ② refreshOnGlobalEvent 关闭（标签视图）——子组件根本不监听。
        // ③「全部」视图——子组件的全量重取已交给父层分块（见 refreshOnGlobalEvent
        //   的传参），编辑后必须由这里重取，否则改完一行列表不动。
        if (isCurrentAccountEvent) {
          // 「全部」整份重拉要十几秒，只有**确实改到具体条目**的事件才值得。
          // 后台例行刷新（行情、净值、定投自动执行、startup-check、通知触发…）
          // 不带 entryIds，以前一律 invalidate + 重拉，用户看到的就是「明明没动，
          // 几万条又在转圈」。这些事件前面已经 dropDetailAllCache()，下次进入会重取。
          const touchesEntries =
            (detail.entryIds?.length ?? 0) > 0 || (detail.deletedEntryIds?.length ?? 0) > 0;
          if (detailAll && clientPaginationEnabled && touchesEntries) {
            invalidateDetailAll();
            reloadDetailPage();
            return;
          }
          if (!clientPaginationEnabled || !refreshOnGlobalEvent) router.refresh();
        }
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
      );
      const removedCount = localEntries.length - result.entries.length;
      if (removedCount > 0) {
        setLocalEntries(result.entries);
        setLocalTotalCount((count) => Math.max(0, count - removedCount));
        setLocalOriginalCount((count) => Math.max(0, count - removedCount));
      }
      if (!result.complete && !detailAll) reloadDetailPage();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    };
  }, [accountId, accountKind, clientPaginationEnabled, detailAll, localEntries, refreshOnGlobalEvent, reloadDetailPage, router, scopeAccountIds]);

  useEffect(() => {
    if (detailAll || page === safePage || locatingDateRef.current) return;
    setPage(safePage);
  }, [detailAll, page, safePage]);

  useEffect(() => {
    const url = new URL(window.location.href);
    // 全部资金明细（scope = __all_cash__）的规范 URL 是 view=allcash：根路由在
    // URL 既没有 accountId/account/tagId、view 又不是 allcash/liability/… 时
    // 会 redirect("/overview")。这里若把 view 写成 detail、又补不上 accountId，
    // 之后任何一次服务端重渲染（保存后 router.refresh、刷新页面、分享链接）都会
    // 把用户弹回概况页——保存一笔就「跳回首页」的真正来源。
    url.searchParams.set("view", isAllCashDetailScope(accountId) ? "allcash" : "detail");
    url.searchParams.set("pageSize", String(pageSize));
    if (detailAll) {
      url.searchParams.set("detailAll", "1");
      url.searchParams.delete("detailPage");
    } else {
      url.searchParams.delete("detailAll");
      url.searchParams.set("detailPage", String(safePage));
    }
    writeStoredDetailPreference(accountId, pageSize, detailAll, safePage, autoFit);
    const nextHref = `${url.pathname}${url.search}${url.hash}`;
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref !== currentHref) {
      if (clientPaginationEnabled) {
        // Next 16: must pass null, not window.history.state — reusing the
        // router's internal state object breaks canonicalUrl sync, so later
        // router.refresh() calls re-render from the OLD URL (dropping
        // detailAll=1) and overwrite the client-fetched full list.
        window.history.replaceState(null, "", nextHref);
      } else {
        router.replace(nextHref, { scroll: false });
      }
    }
  }, [accountId, autoFit, clientPaginationEnabled, detailAll, pageSize, router, safePage]);

  useEffect(() => {
    if (!clientPaginationEnabled) return;
    // 筛选 / 排序 / 时间范围都拼进 key：条件一变就必须重取，否则只是本地这份
    // page 上又筛了一遍。
    // `detailAll && !serverPagedAll` 才是「整份拉到本地」：服务端分页的「全部」
    // 仍然一页一页取，key 里必须带页码，否则翻页时 key 不变、表格永远停在第一页。
    const key = `${detailPaginationFetchKey(accountId, pageSize, detailAll && !serverPagedAll, safePage)}|${serverPagedAll ? `${serverFilterKey}|${serverSortKey}` : ""}|${serverDateRangeKey}`;
    const isFirstRun = !lastClientPaginationKeyRef.current;
    if (!isFirstRun && lastClientPaginationKeyRef.current === key) return;
    lastClientPaginationKeyRef.current = key;
    // 首次进入且不是「全部」时，服务端 RSC 已经给了这一页，不必再取。
    // 「全部」则必须立刻补：服务端现在只渲染一页（全量渲染 4 万行会产出上百 MB
    // HTML），剩下的要靠这里按块拉回来，否则表格永远停在那一页。
    //
    // 默认观测窗口也由 RSC 带上了（`initialDateRange`）：首屏那页、`共 N 条`、页码
    // 总数都是范围口径，客户端不必再按同一个范围重复取一遍。只有 URL 筛选或
    // 服务端分页的筛选/排序下推才需要另取。
    if (isFirstRun && serverPagedAll && serverFilterKey === "{}" && !serverSort && !hasDetailDateRange) return;
    if (isFirstRun && !detailAll && (initialDateRange || !hasDetailDateRange)) return;

    const controller = new AbortController();
    reloadDetailPage(controller.signal);

    return () => controller.abort();
  }, [accountId, clientPaginationEnabled, detailAll, hasDetailDateRange, initialDateRange, pageSize, reloadDetailPage, safePage, serverDateRangeKey, serverFilterKey, serverPagedAll, serverSortKey]);

  // 服务端模式：表头漏斗的候选值来自服务端 distinct。缺了这一步，百万行下
  // 漏斗只能从当前页去重出几十个值，用户会以为「分类只剩这几个」。
  useEffect(() => {
    if (!serverPagedAll) {
      setServerFacets(null);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ accountId, facets: "1" });
    if (serverFilterKey !== "{}") params.set("filters", serverFilterKey);
    if (hasDetailDateRange) params.set("range", serverDateRangeKey);
    fetch(`/api/v1/transactions/detail?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) return;
        const facets = payload.data?.facets;
        if (facets && typeof facets === "object") setServerFacets(facets);
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        console.error("Load transaction detail facets failed:", error);
      });
    return () => controller.abort();
  }, [accountId, hasDetailDateRange, serverDateRangeKey, serverFilterKey, serverPagedAll]);

  // 时间轴两端（双滑块的可拖范围）永远取自**全量**数据：不受时间范围本身、也不受
  // 日期列筛选、URL 筛选影响，否则拖一次区间滑轨就缩到刚选的范围，再也拖不回更早
  // 的日期。分页模式下当前页只有几十行，从 rows 推导出来只有几天，所以任何模式下
  // 都取一次；拿到之前 chip 保持置灰，绝不拿一页的跨度冒充整条时间轴。
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ accountId, bounds: "1" });
    setServerDateBoundsLoading(true);
    fetch(`/api/v1/transactions/detail?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) return;
        const bounds = payload.data?.dateBounds;
        if (bounds && typeof bounds.min === "string" && typeof bounds.max === "string") {
          setServerDateBounds({ min: bounds.min, max: bounds.max });
        }
      })
      .catch((error) => {
        if (isAbortError(error)) return;
        console.error("Load transaction detail date bounds failed:", error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setServerDateBoundsLoading(false);
      });
    return () => controller.abort();
  }, [accountId]);

  const serverFilterOptions = useMemo(() => {
    if (!serverFacets) return undefined;
    const mapped: Record<string, { options: string[]; counts?: Record<string, number> }> = {};
    for (const [key, list] of Object.entries(serverFacets)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const counts: Record<string, number> = {};
      for (const item of list) counts[item.value] = item.count;
      mapped[key] = { options: list.map((item) => item.value), counts };
    }
    return mapped;
  }, [serverFacets]);

  const handleServerFiltersChange = useCallback((next: Partial<Record<string, string[]>>) => {
    setServerFilters(next);
    setPage(1);
  }, []);
  /** 时间范围变化 = 数据范围变化：回到第 1 页并重新取数（不是本地筛当前页）。 */
  const handleDetailDateRangeChange = useCallback((next: { from: string; to: string }) => {
    setDetailDateRange(next);
    setPage(1);
  }, []);
  const handleServerSortChange = useCallback((next: { key: string; direction: "asc" | "desc" } | null) => {
    setServerSort(next);
    setPage(1);
  }, []);

  const pageEntries = useMemo(() => localEntries, [localEntries]);
  const displayRowsRef = useRef<DetailEntry[]>([]);
  const locateDateSeqRef = useRef(0);
  const pendingCenterDateRef = useRef<string | null>(null);
  const [isLocatingDate, setIsLocatingDate] = useState(false);
  const [locateScrollKey, setLocateScrollKey] = useState<string | null>(null);

  const readCenteredDetailDate = () => {
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
    return target ? detailEntryDayKey(target, accountId) : null;
  };

  useEffect(() => {
    const dateYmd = pendingCenterDateRef.current;
    if (!dateYmd || localEntries.length === 0) return;
    const index = findEntryIndexForDate(localEntries, dateYmd, accountId);
    if (index < 0) return;
    pendingCenterDateRef.current = null;
    const target = localEntries[index];
    if (!target) return;
    setLocateScrollKey(null);
    window.setTimeout(() => setLocateScrollKey(target.id), 0);
  }, [accountId, localEntries]);

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
    if (!normalExportRowsByEntryId || displayedEntryIds === null || displayedEntryIds.length === pageEntries.length) return normalExportRows;
    const [header = []] = normalExportRows;
    const rows = displayedEntryIds
      .map((id) => normalExportRowsByEntryId[id])
      .filter((row): row is string[] => Array.isArray(row));
    return [header, ...rows];
  }, [displayedEntryIds, normalExportRows, normalExportRowsByEntryId, pageEntries.length]);

  const applyPageSizeKeepingCenter = (nextPageSize: number) => {
    const centerDate = readCenteredDetailDate();
    if (!clientPaginationEnabled || !centerDate) {
      setPageSize(nextPageSize);
      setPage(1);
      return;
    }
    pendingCenterDateRef.current = centerDate;
    const seq = ++locateDateSeqRef.current;
    setIsLocatingDate(true);
    const params = new URLSearchParams({
      accountId,
      locateDate: centerDate,
      pageSize: String(nextPageSize),
    });
    // 定位/换页大小也在同一个数据范围内算页码，否则定位结果与表格不一致。
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
        if (Number.isFinite(nextTotalCount)) {
          setLocalTotalCount(nextTotalCount);
          setLocalOriginalCount(nextTotalCount);
        }
        const pages = Math.max(1, Math.ceil((Number.isFinite(nextTotalCount) ? nextTotalCount : localTotalCount) / nextPageSize));
        setPageSize(nextPageSize);
        setPage(Number.isFinite(locatePage) && locatePage >= 1 ? clampPage(locatePage, pages) : 1);
      })
      .catch((error) => {
        if (seq !== locateDateSeqRef.current) return;
        console.error("Keep centered date after page-size change failed:", error);
        pendingCenterDateRef.current = null;
        setPageSize(nextPageSize);
        setPage(1);
      })
      .finally(() => {
        if (seq === locateDateSeqRef.current) setIsLocatingDate(false);
      });
  };

  const setPagedSize = (nextPageSize: number) => {
    setDetailAll(false);
    setAutoFit(false);
    applyPageSizeKeepingCenter(nextPageSize);
  };

  const showAll = () => {
    const centerDate = readCenteredDetailDate();
    if (centerDate) pendingCenterDateRef.current = centerDate;
    setDetailAll(true);
    setPage(1);
  };

  const goPage = (nextPage: number) => {
    // 服务端分页的「全部」仍然要能翻页（数据在服务端，一页一页取）。
    if (detailAll && !serverPagedAll) return;
    setPage(clampPage(nextPage, totalPages));
  };

  // Auto-fit: the table reports how many rows fit the viewport; when auto mode
  // is on that count becomes the page size (the "自适应" option restores it).
  // 触发时机由表格一侧决定：视图重开 / 重新选自适应（靠这个回调的 identity 变化）、
  // 行高偏好变化、视口高度变化（窗口 resize、拖动分栏）都会重算。翻页、筛选、
  // 数据刷新不触发；表格内部「行数没变就不上报」挡住了重复更新，不会来回抖。
  //
  // 「全部」要看是哪一种：超过阈值时它其实是服务端分页浏览，一次只取 pageSize
  // 行、表格里也只有这一页，页大小照样必须跟着视口走，否则底部会空出几行 ——
  // 这里刻意不看 autoFit：进「全部」之前手动选过的每页行数（18/40…）只在分页
  // 模式下有意义，「全部」下没有「每页多少条」可选，页大小必须自适应填满。
  // 只有本地全量的「全部」（整份列表一次渲染完）才真的没有页大小可调。
  const rowsFitEnabled = detailAll ? serverPagedAll : autoFit;
  // 页大小跟着视口走；页大小一变，页码以「原页中间行」为锚点换算，窗口缩小后仍
  // 停在同一批记录上（逻辑见 useRowsFitPageAnchor，所有 ADT 表格共用）。服务端
  // 分页时页码写在 URL 上、由定位逻辑负责，这里只改页大小。
  const { onRowsFitChange: handleRowsFitChange, lastFitRowCountRef } = useRowsFitPageAnchor({
    scopeKey: accountScopeKey,
    pageSize,
    page: safePage,
    totalCount: localTotalCount,
    enabled: rowsFitEnabled,
    anchorPage: clientPaginationEnabled,
    setPageSize,
    setPage,
    isBusy: () => locatingDateRef.current,
  });

  const enableAutoFitRows = () => {
    // Same contract as picking a concrete size: leave show-all mode first.
    setDetailAll(false);
    setAutoFit(true);
    const fitCount = lastFitRowCountRef.current;
    applyPageSizeKeepingCenter(fitCount ?? pageSize);
  };

  const handleLocateDate = (dateYmd: string) => {
    if (!clientPaginationEnabled || !dateYmd) return;
    if (detailAll && !serverPagedAll) {
      // Show-all mode: the loaded list is fully rendered (virtualized beyond
      // ROW_VIRTUALIZATION_THRESHOLD rows), so locating is a client-side
      // viewport scroll — center the first entry of the requested date, or the
      // nearest day in list order when that date has no entries.
      const rows = displayRowsRef.current;
      if (!rows || rows.length === 0) return;
      const index = findEntryIndexForDate(rows, dateYmd, accountId);
      const target = index >= 0 ? rows[index] : undefined;
      if (!target) return;
      // Reset first so re-locating the same date scrolls again (the table
      // centers each row key at most once).
      setLocateScrollKey(null);
      window.setTimeout(() => setLocateScrollKey(target.id), 0);
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
        setLocalTotalCount(nextCount);
        setLocalOriginalCount(nextCount);
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
              setLocateScrollKey(null);
              window.setTimeout(() => setLocateScrollKey(target.id), 0);
            }
          }
          return;
        }
        pendingCenterDateRef.current = dateYmd;
        setPage(nextPage);
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

  const canPrev = (!detailAll || serverPagedAll) && safePage > 1;
  const canNext = (!detailAll || serverPagedAll) && safePage < totalPages;
  const selectionResetKey = accountScopeKey;
  const tableResetKey = selectionResetKey;
  const closeGuideOverlay = () => {
    setGuideOverlayOpen(false);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("guide");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const guideWidth = guideMetrics?.width ?? 1024;
  const guideHeight = guideMetrics?.height ?? 560;
  const headerTargetRect = guideMetrics?.headerCell ?? guideMetrics?.header ?? null;

  return (
    <BasicDetailSelectionProvider resetKey={selectionResetKey}>
      <BasicDetailBatchDeleteMessage />
      <div ref={panelRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 md:hidden">
          <span className="text-xs text-slate-500">{t("creditBillDetail.recordCount", { count: localTotalCount })}</span>
          {showPagination ? (
            <DetailTablePaginationControls
              key={accountScopeKey}
              pageSize={pageSize}
              pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
              detailAll={detailAll}
              paged={!detailAll || serverPagedAll}
              safePage={safePage}
              totalPages={totalPages}
              canPrev={canPrev}
              canNext={canNext}
              autoFit={autoFit || serverPagedAll}
              onAutoFit={enableAutoFitRows}
              onPageSizeChange={setPagedSize}
              onShowAll={showAll}
              onPageChange={goPage}
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
          scrollToRowKey={locateScrollKey}
          showAccountColumn={showAccountColumn}
          reorderAccountIds={scopeAccountIds}
          toolbarMode="custom"
          toolbarTitle={t("basicDetail.entriesTitle")}
          showRunningBalance={showRunningBalance ?? !isInvestAccount}
          serverMode={serverPagedAll}
          onServerFiltersChange={serverPagedAll ? handleServerFiltersChange : undefined}
          onServerSortChange={serverPagedAll ? handleServerSortChange : undefined}
          serverFilterOptions={serverPagedAll ? serverFilterOptions : undefined}
          // 时间筛选器在两种模式下都开：滑轨两端取全量边界（bounds=1），与当前
          // 页有多少行、以及范围/日期列筛选都无关。
          showDateRangeFilter
          dateRange={detailDateRange}
          dateRangeBounds={serverDateBounds}
          dateRangeBoundsLoading={serverDateBoundsLoading}
          onDateRangeChange={handleDetailDateRangeChange}
          detailQueryRange={hasDetailDateRange ? serverDateRangeKey : undefined}
          reconcileEnabled={showReconcile}
          // 有明细筛选时列表由 RSC 的 entries prop 持有，DetailViewClient 的
          // 重取不带筛选参数，会把筛选结果冲掉 —— 交给上面的整棵刷新。
          // 「全部」也全部交给父层（reloadDetailPage）：父层知道当前是服务端分页
          // 还是本地分块，子组件只会无脑 loadAllDetailEntries（先 500 条再一次性
          // 拉五万条）。两边同时订阅 finance:changed 的后果是——父层刚按分页摆好
          // 40 行，子层又塞回整份五万行，下一次父层刷新再摆回 40 行，表格看起来
          // 一直在闪，工具栏还长时间停在「已加载 500 条」。
          refreshOnGlobalEvent={refreshOnGlobalEvent && clientPaginationEnabled && !detailAll}
          draggableRows={draggableRows}
          sortable={sortable}
          onRowsFitChange={rowsFitEnabled ? handleRowsFitChange : undefined}
          toolbarRightContent={
            <div className="flex items-center gap-2 text-xs">
              <span className="text-xs text-slate-600">{t("creditBillDetail.recordCount", { count: localTotalCount })}{hasDetailFilters ? t("basicDetail.filteredSuffix", { count: localOriginalCount }) : ""}{isPageLoading ? (detailAll && !serverPagedAll
            ? allLoadedCount > 0
              ? t("basicDetail.loadingAllSuffix", { count: localTotalCount, loaded: allLoadedCount })
              : t("basicDetail.loadingAllPending", { count: localTotalCount })
            : t("basicDetail.loadingSuffix")) : ""}</span>
              {showImportExport ? (
                <>
                  <span className="text-slate-400">|</span>
                  <ViewExcelImportMenuButton
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
                    pageSize={pageSize}
                    pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
                    detailAll={detailAll}
                    paged={!detailAll || serverPagedAll}
                    safePage={safePage}
                    totalPages={totalPages}
                    canPrev={canPrev}
                    canNext={canNext}
                    autoFit={autoFit}
                    onAutoFit={enableAutoFitRows}
                    onPageSizeChange={setPagedSize}
                    onShowAll={showAll}
                    onPageChange={goPage}
                    onLocateDate={clientPaginationEnabled ? handleLocateDate : undefined}
                    locateDateBusy={isLocatingDate}
                  />
                </>
              ) : null}
            </div>
          }
          onDisplayRowsChange={handleDisplayRowsChange}
        />
        {guideOverlayOpen && guidePortalHost ? createPortal((
          <div className="pointer-events-none fixed inset-0 z-[80] hidden overflow-hidden md:block" aria-live="polite">
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
              <X className="h-3.5 w-3.5" />
              {t("basicDetail.guide.close")}
            </button>
          </div>
        ), guidePortalHost) : null}
      </div>
    </BasicDetailSelectionProvider>
  );
}
