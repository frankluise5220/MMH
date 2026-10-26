"use client";

import { useCallback, useRef } from "react";

/**
 * 自适应行数（ADT 回报「视口能放几行」）的共享落地逻辑。
 *
 * 表格只负责测量，页大小与页码是宿主的状态：**页大小一变，页码就得跟着换**，
 * 否则窗口一缩整屏就跳到别的记录上。窗口缩小 → 一页装的行数变少 → 总页数变多，
 * 页码原地不动意味着「第 3 页在 23 行/页下是第 47~69 行，换成 18 行/页就成了第
 * 37~54 行」。锚点取「原页中间那一行」：它在旧页里的偏移固定，全局序号也固定，
 * 换算到新页大小后仍落在新页中部（误差不超过半页），用户看到的是同一批记录。
 *
 * 所有接了 `onRowsFitChange` 的表格都该用这个 hook，否则各表行为不一致：改了一处
 * 只有那一张表会跟着窗口走。
 */
type RowsFitPageAnchorOptions = {
  /**
   * 「换页」的作用域（账户 id、资产 id、页签……）。它变化时回调 identity 必须变，
   * ADT 会把它当成「父层要我重新测量」重新量一次；量完再保持稳定，避免反复测。
   */
  scopeKey: string;
  /** 当前生效的每页行数（自适应落地值）。 */
  pageSize: number;
  /** 当前生效的页码（已 clamp 的那一页）。 */
  page: number;
  /** 总条数。为 0 时只改页大小，不动页码。 */
  totalCount: number;
  /** 是否处于自适应模式（手动选了固定行数、「全部」模式下为 false）。 */
  enabled: boolean;
  setPageSize: (size: number) => void;
  /**
   * 是否连页码一起搬。本地/客户端分页必须搬；服务端分页（页码写在 URL 上、由服务端
   * 返回那一页）由它自己的定位逻辑负责，这里只改页大小。
   */
  anchorPage?: boolean;
  setPage?: (page: number) => void;
  /** 返回 true 表示此刻不要动（例如正在按日期 / 记录 id 定位页码）。 */
  isBusy?: () => boolean;
};

export function useRowsFitPageAnchor({
  scopeKey,
  pageSize,
  page,
  totalCount,
  enabled,
  setPageSize,
  anchorPage = true,
  setPage,
  isBusy,
}: RowsFitPageAnchorOptions) {
  /** 「重新选自适应」时先套用最近一次测量值，不用等下一帧再量。 */
  const lastFitRowCountRef = useRef<number | null>(null);
  /**
   * 回调里要读「第几页 / 每页多少行 / 共多少条」，但都不能进依赖：它们每渲染都变，
   * 依赖里一有它们，回调 identity 每次都变，ADT 会当成「父层要我重新测量」反复量。
   * 用 ref 快照读，identity 只跟作用域和开关走。
   */
  const latestRef = useRef({ pageSize, page, totalCount, setPageSize, setPage, isBusy });
  latestRef.current = { pageSize, page, totalCount, setPageSize, setPage, isBusy };

  const onRowsFitChange = useCallback((rowCount: number) => {
    // scopeKey 只作 identity 触发器（换账户/资产时 ADT 要重测一次），不参与计算。
    void scopeKey;
    lastFitRowCountRef.current = rowCount;
    if (!enabled) return;
    // isBusy 也走 ref：调用方常写成内联箭头（() => someRef.current），进依赖就
    // 会让 identity 每渲染都变，ADT 反而每帧重测一次。
    if (latestRef.current.isBusy?.()) return;
    const latest = latestRef.current;
    if (latest.pageSize === rowCount) return;
    latest.setPageSize(rowCount);
    if (!anchorPage || !latest.setPage) return;
    const total = latest.totalCount;
    if (!(total > 0)) return;
    const anchorIndex = Math.min(
      (latest.page - 1) * latest.pageSize + Math.floor(latest.pageSize / 2),
      Math.max(0, total - 1),
    );
    const nextTotalPages = Math.max(1, Math.ceil(total / rowCount));
    const nextPage = Math.min(Math.max(1, Math.floor(anchorIndex / rowCount) + 1), nextTotalPages);
    // 页号没变就不 setPage：多数放大场景锚点还在同一页，多一次重取只会白闪。
    if (nextPage !== latest.page) latest.setPage(nextPage);
  }, [anchorPage, enabled, scopeKey]);

  return { onRowsFitChange, lastFitRowCountRef };
}
