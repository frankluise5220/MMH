"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 明细表格的「每页行数 / 页码 / 全部」——**唯一**的状态点。
 *
 * 这个值只有一个来源，也只有一个写入口：`rows` 由三个事件推动，别处一律不写。
 *
 *  - `fit(n)`     表格量出「视口能放几行」。窗口高度、行高偏好、分栏拖动都走这里。
 *  - `select(n)`  用户手选 40 / 80。
 *  - `showAll()`  用户选「全部」。
 *
 * 「自适应」不是独立开关，而是**来源**（`mode`），所以不存在「页大小说 40、自适应
 * 开关说 true」这种自相矛盾的状态；也因此不需要在每条落地路径上各写一次
 * `setAutoFit(false)`——手选之后 `fit` 事件自然被忽略。
 *
 * 页码（`page`）是第二个必须独立存的值：客户端分页时它由「原页中间行」换算出
 * （见下），服务端分页时由宿主的 URL 定位逻辑负责（`serverPaged`），不能省。
 */

export type DetailRowsMode = "fit" | "manual" | "all";

export type DetailPaginationState = {
  /** 页大小的来源：自适应 / 手选 / 全部。 */
  mode: DetailRowsMode;
  /** fit / manual 下生效的每页行数（永不为 0）。 */
  rows: number;
  /** 当前页码；`all` 时恒为 1。 */
  page: number;
  /** 最近一次量到的视口容量；`null` = 这台设备还没量过。 */
  fitRows: number | null;
  /** 进入「全部」之前的来源，退出「全部」时原样恢复（用户手选 80 就别退回自适应）。 */
  beforeAll: { mode: Exclude<DetailRowsMode, "all">; rows: number } | null;
};

/** 服务端首屏、没有 cookie 落地值时的兜底行数（与偏好里的默认值一致）。 */
export const DEFAULT_DETAIL_PAGE_ROWS = 40;

/**
 * 为什么写这一次状态。
 *
 * - `fit` / `select` / `all` / `restore` 是用户动作或测量直接推动的。
 * - `reset` 宿主按 props / URL 整份替换（换账户、换账单月），不是用户在这个
 *   作用域里调了页大小，`onCommit` 不该再拦一次。
 * - `locate` 宿主已经自己算好页码（按视口中心那天定位、或首屏换算），直接落地。
 *
 * 后两个存在的意义就是「别再拦我」：`onCommit` 只认 `select` / `restore`，
 * 否则「拦截 → 重新定位 → 再 replace」会在自己的回调里无限自调用。
 */
export type DetailPaginationCommitReason = "fit" | "select" | "all" | "restore" | "reset" | "locate";

type DetailPaginationOptions = {
  /**
   * 「换页」的作用域（账户 id、资产 id、账期……）。它变化时 `fit` 的 identity
   * 必须变——表格把它当成「父层要我重新测量」重新量一次；量完保持稳定，避免反复测。
   */
  scopeKey: string;
  /** 总行数。为 0 时只改页大小、不动页码。 */
  rowCount: number;
  /** 首帧初值（服务端 URL / cookie / props 算出来的那一次）。 */
  initial?: Partial<DetailPaginationState>;
  /**
   * 服务端分页：页码写在 URL 上、由宿主自己的定位逻辑搬。这里只改页大小。
   * 客户端分页则连页码一起搬（见 `fit` 里的锚点换算）。
   */
  serverPaged?: boolean;
  /** 返回 true 表示此刻不要动（例如正在按日期 / 记录 id 定位页码）。 */
  isBusy?: () => boolean;
  /**
   * 手选 / 回到自适应时接管落地。返回 true 表示宿主自己处理了这次变更
   * （`BasicDetailPanel` 要按「视口中心那一天的日期」重新定位页码）。
   */
  onCommit?: (
    next: DetailPaginationState,
    previous: DetailPaginationState,
    reason: DetailPaginationCommitReason,
  ) => boolean;
  /**
   * 状态每次变化后调用一次：宿主在这里写 URL / cookie，别处不要再写。
   * 第二个参数是已经按总行数收敛过的页码，写 URL 时直接用它，不要在宿主里再
   * 算一遍 clamp（那又会变成第二处页码口径）。
   */
  onPersist?: (state: DetailPaginationState, safePage: number) => void;
  /**
   * 进入「全部」之前的时机：宿主想记住「此刻视口中心是哪一天」，等全部渲染完
   * 再滚回去。hook 不碰 DOM，只提供这个点。
   */
  onBeforeShowAll?: () => void;
};

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

export function useDetailPagination({
  scopeKey,
  rowCount,
  initial,
  serverPaged = false,
  isBusy,
  onCommit,
  onPersist,
  onBeforeShowAll,
}: DetailPaginationOptions) {
  const [state, setState] = useState<DetailPaginationState>(() => ({
    mode: initial?.mode ?? "fit",
    rows: Math.max(1, Math.floor(initial?.rows ?? DEFAULT_DETAIL_PAGE_ROWS)),
    page: Math.max(1, Math.floor(initial?.page ?? 1)),
    fitRows: initial?.fitRows ?? null,
    beforeAll: initial?.beforeAll ?? null,
  }));
  /**
   * 回调里要读最新状态、最新行数与最新挂载参数，但都不能进依赖：它们几乎每渲染
   * 都变，依赖里一有它们，`fit` 的 identity 每次都变，表格会当成「父层要我重新
   * 测量」反复量。用 ref 快照读。
   */
  const stateRef = useRef(state);
  stateRef.current = state;
  const optionsRef = useRef({ rowCount, serverPaged, isBusy, onCommit, onPersist, onBeforeShowAll });
  optionsRef.current = { rowCount, serverPaged, isBusy, onCommit, onPersist, onBeforeShowAll };

  const commit = useCallback((next: DetailPaginationState, reason: DetailPaginationCommitReason) => {
    const previous = stateRef.current;
    if (
      next.mode === previous.mode
      && next.rows === previous.rows
      && next.page === previous.page
      && next.fitRows === previous.fitRows
      && next.beforeAll === previous.beforeAll
    ) {
      return;
    }
    if (optionsRef.current.onCommit?.(next, previous, reason)) return;
    // 立刻同步 ref：同一帧里可能连着来几个事件（测量 + 用户点击），
    // 只等 setState 生效的话第二个事件会读到旧状态。
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * 页大小一变，页码就得跟着换，否则窗口一缩整屏就跳到别的记录上。
   *
   * 锚点取「原页中间那一行」：它在旧页里的偏移固定，全局序号也固定，换算到新页
   * 大小后仍落在新页中部（误差不超过半页），用户看到的是同一批记录。
   */
  const anchorPage = useCallback((previous: DetailPaginationState, nextRows: number) => {
    const total = optionsRef.current.rowCount;
    if (optionsRef.current.serverPaged) return previous.page;
    if (!(total > 0)) return previous.page;
    const anchorIndex = Math.min(
      (previous.page - 1) * previous.rows + Math.floor(previous.rows / 2),
      Math.max(0, total - 1),
    );
    const nextTotalPages = Math.max(1, Math.ceil(total / nextRows));
    return Math.min(Math.max(1, Math.floor(anchorIndex / nextRows) + 1), nextTotalPages);
  }, []);

  /**
   * 表格回报视口容量。identity 只跟作用域走，且与其它事件共用同一个状态点。
   */
  const fit = useCallback((measured: number) => {
    // scopeKey 只作 identity 触发器（换账户 / 资产时表格要重测一次），不参与计算。
    void scopeKey;
    const previous = stateRef.current;
    if (!Number.isFinite(measured)) return;
    const rows = Math.floor(measured);
    if (rows < 1) return;
    // 手选 / 全部时只记账、不改页大小：用户的选择优先于窗口。
    if (previous.mode !== "fit") {
      if (previous.fitRows !== rows) commit({ ...previous, fitRows: rows }, "fit");
      return;
    }
    if (optionsRef.current.isBusy?.()) {
      if (previous.fitRows !== rows) commit({ ...previous, fitRows: rows }, "fit");
      return;
    }
    if (previous.rows === rows) {
      if (previous.fitRows !== rows) commit({ ...previous, fitRows: rows }, "fit");
      return;
    }
    commit({ ...previous, rows, fitRows: rows, page: anchorPage(previous, rows) }, "fit");
  }, [anchorPage, commit, scopeKey]);

  /** 用户手选固定行数。 */
  const select = useCallback((rows: number) => {
    const previous = stateRef.current;
    const nextRows = Math.max(1, Math.floor(rows));
    commit({ ...previous, mode: "manual", rows: nextRows, page: 1 }, "select");
  }, [commit]);

  /** 「全部」：不分页，整份渲染（大列表由表格自己虚拟化）。 */
  const showAll = useCallback(() => {
    const previous = stateRef.current;
    if (previous.mode === "all") return;
    optionsRef.current.onBeforeShowAll?.();
    commit({
      ...previous,
      mode: "all",
      page: 1,
      beforeAll: { mode: previous.mode, rows: previous.rows },
    }, "all");
  }, [commit]);

  /** 退出「全部」，回到进入前的来源（手选的 80 还是 80，不是被打回自适应）。 */
  const leaveAll = useCallback(() => {
    const previous = stateRef.current;
    if (previous.mode !== "all") return;
    const before = previous.beforeAll;
    commit({
      ...previous,
      mode: before?.mode ?? "fit",
      rows: before?.rows ?? previous.fitRows ?? previous.rows,
      page: 1,
      beforeAll: null,
    }, "restore");
  }, [commit]);

  /**
   * 整份替换（换账户 / 换账单月时从 URL、props、偏好里一次算好）。
   * 缺省字段沿用当前值，不会把没提到的部分打回默认。
   *
   * `reason` 默认 `reset`（宿主按外部来源整份替换），**不会**被 `onCommit` 拦截；
   * 宿主的 `onCommit` 里自己算出页码再落地时要显式传 `locate`。
   */
  const replace = useCallback((next: Partial<DetailPaginationState>, reason: DetailPaginationCommitReason = "reset") => {
    const previous = stateRef.current;
    const mode = next.mode ?? previous.mode;
    commit({
      mode,
      rows: Math.max(1, Math.floor(next.rows ?? previous.rows)),
      page: Math.max(1, Math.floor(next.page ?? previous.page)),
      fitRows: next.fitRows === undefined ? previous.fitRows : next.fitRows,
      // 进入「全部」时记下之前的来源；退出时恢复。
      beforeAll: mode === "all"
        ? (previous.mode === "all" ? previous.beforeAll : { mode: previous.mode, rows: previous.rows })
        : null,
    }, reason);
  }, [commit]);

  /** 回到自适应：立刻套用最近一次测量值，不用等下一帧再量。 */
  const restoreFit = useCallback(() => {
    const previous = stateRef.current;
    commit({ ...previous, mode: "fit", rows: previous.fitRows ?? previous.rows, page: 1 }, "restore");
  }, [commit]);

  /**
   * 定位专用：按服务端刚给的 totalCount 算好的页码直接落地，**不**按旧的
   * `totalPages` 钳。否则定位到第 75 条时，旧总数还只有一个首页的量，
   * 页码会被打回 1，看起来就是「点了某天又跳回第一页」。
   */
  const forcePage = useCallback((page: number) => {
    const previous = stateRef.current;
    const next = Math.max(1, Math.floor(page) || 1);
    if (next === previous.page) return;
    commit({ ...previous, page: next }, "fit");
  }, [commit]);

  const goPage = useCallback((page: number) => {
    const previous = stateRef.current;
    if (previous.mode === "all") return;
    const totalPages = Math.max(1, Math.ceil(optionsRef.current.rowCount / Math.max(1, previous.rows)));
    const next = clampPage(page, totalPages);
    if (next === previous.page) return;
    commit({ ...previous, page: next }, "fit");
  }, [commit]);

  useEffect(() => {
    if (!optionsRef.current.onPersist) return;
    const rowCount = optionsRef.current.rowCount;
    const total = state.mode === "all" ? 1 : Math.max(1, Math.ceil(rowCount / Math.max(1, state.rows)));
    optionsRef.current.onPersist(state, state.mode === "all" ? 1 : clampPage(state.page, total));
  }, [state]);

  const all = state.mode === "all";
  const measured = state.fitRows != null;
  const totalPages = all ? 1 : Math.max(1, Math.ceil(rowCount / Math.max(1, state.rows)));
  const safePage = all ? 1 : clampPage(state.page, totalPages);

  /** 按当前页切一份（本地分页的宿主用；走表格内置分页的不要切）。 */
  const slice = useCallback(<T,>(list: readonly T[]): T[] => (
    all ? (list as T[]) : list.slice((safePage - 1) * state.rows, safePage * state.rows)
  ), [all, safePage, state.rows]);

  return useMemo(() => ({
    mode: state.mode,
    /** 页大小来源是否为「自适应」。 */
    autoFit: state.mode === "fit",
    /** 是否整份渲染。 */
    all,
    /** 每页行数（永不为 0）。 */
    rows: state.rows,
    /** 是否已经量过一次视口容量。 */
    measured,
    /** 最近一次量到的容量。 */
    fitRows: state.fitRows,
    page: state.page,
    safePage,
    totalPages,
    canPrev: !all && safePage > 1,
    canNext: !all && safePage < totalPages,
    fit,
    select,
    showAll,
    leaveAll,
    replace,
    restoreFit,
    goPage,
    forcePage,
    slice,
  }), [all, fit, forcePage, goPage, leaveAll, measured, replace, restoreFit, safePage, select, showAll, slice, state, totalPages]);
}

export type DetailPagination = ReturnType<typeof useDetailPagination>;
