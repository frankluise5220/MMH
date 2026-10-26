"use client";

import { DETAIL_ALL_CHUNK_SIZE, DETAIL_ALL_FIRST_PAGE_SIZE } from "@/lib/detail-pagination-preference";

type ChunkedDetailLoadOptions<T> = {
  accountId: string;
  signal?: AbortSignal;
  /** Return false to stop early, e.g. because the account / page / scope changed. */
  isCurrent?: () => boolean;
  /** Called after every chunk so the view can grow while the rest is still in flight. */
  onChunk?: (entries: T[], totalCount: number) => void;
  /**
   * 已取回的条数（只用于进度文案）。剩下的块是并发的，不要在这里 setEntries —
   * 每块重建一次两万行的表格，正是要避免的那二十几秒。
   */
  onProgress?: (loadedCount: number, totalCount: number) => void;
  /** Localized message used when the API rejects a chunk. */
  errorMessage?: string;
  /**
   * 时间范围（`from~to`）。工具栏双滑块是数据范围，不是日期列筛选，所以每一块
   * 都要带上它，否则「全部」视图会把范围外的流水也拉回来。
   */
  range?: string;
};

type ChunkedDetailLoadResult<T> = {
  entries: T[];
  totalCount: number;
  /** True when `isCurrent()` asked the loop to stop before the end. */
  stopped: boolean;
};

type DetailPage<T> = { entries: T[]; totalCount: number };

async function fetchDetailPage<T>(
  accountId: string,
  page: number,
  pageSize: number,
  signal: AbortSignal | undefined,
  errorMessage: string | undefined,
  range: string | undefined,
): Promise<DetailPage<T>> {
  const params = new URLSearchParams({
    accountId,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (range) params.set("range", range);
  // 不要再加 `cache: "no-store"`：明细接口按「条目数 + updatedAt」发了 ETag，
  // 浏览器刷新时会带 If-None-Match 回来，没变就吃 304（本地副本）、一变就回 200。
  // 「全部」一次十几 MB，只有允许缓存才谈得上「刷新不重新加载」。
  const response = await fetch(`/api/v1/transactions/detail?${params.toString()}`, {
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? errorMessage ?? "Failed to load entries");
  }
  const entries: T[] = Array.isArray(payload.data?.entries) ? payload.data.entries : [];
  const nextTotalCount = Number(payload.data?.totalCount);
  return { entries, totalCount: Number.isFinite(nextTotalCount) ? nextTotalCount : Number.NaN };
}

/**
 * 「全部」视图的全量加载。
 *
 * 分两步，全程只有这一条路径：
 * 1. 先取一页小的（`DETAIL_ALL_FIRST_PAGE_SIZE`）立刻渲染：行数超过表格虚拟化
 *    阈值（200 行）后虚拟滚动条马上出现，用户不用盯着切「全部」前那一页「自适应」
 *    行数干等。
 * 2. 其余按 `DETAIL_ALL_CHUNK_SIZE` 顺序翻页补齐（首屏已展示的前几行跳过，不重复），
 *    每块通过 `onChunk` 交给视图，边到边显示。服务端按 `rowNumber` 区间取页
 *    （`> offset AND <= offset + pageSize`），页间既不重复也不遗漏，逐笔余额都在
 *    全量口径上算好。
 *
 * 曾经中间还有「一次性取 50000 条整份替换」这一步：对 4 万条的账户确实快一些，
 * 但界面会长时间停在「已加载 500 条」，请求还常被浏览器中途重置，退化成三条
 * 路径互相兜底。现在超过 `SERVER_PAGED_ALL_THRESHOLD` 的口径直接走服务端分页，
 * 这条路径只服务阈值以内（最多几块）的数据，没有必要再做一次性大请求。
 */
export async function loadAllDetailEntries<T>({
  accountId,
  signal,
  isCurrent,
  onChunk,
  onProgress,
  errorMessage,
  range,
}: ChunkedDetailLoadOptions<T>): Promise<ChunkedDetailLoadResult<T>> {
  const entries: T[] = [];
  let totalCount = Number.NaN;
  const emit = () => onChunk?.([...entries], totalCount);

  // 第一屏：小页先让列表长出来（虚拟滚动阈值 200 行，500 行稳过）。
  try {
    const first = await fetchDetailPage<T>(accountId, 1, DETAIL_ALL_FIRST_PAGE_SIZE, signal, errorMessage, range);
    if (Number.isFinite(first.totalCount)) totalCount = first.totalCount;
    entries.push(...first.entries);
    if (isCurrent && !isCurrent()) {
      return { entries: [...entries], totalCount, stopped: true };
    }
    emit();
    // 短页 = 整份数据都在这一页里，没有必要再取全量。
    if (first.entries.length < DETAIL_ALL_FIRST_PAGE_SIZE || !(totalCount > entries.length)) {
      return { entries: [...entries], totalCount, stopped: false };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // 首屏失败：丢掉已拿到的一部分，交给下面的分块逻辑从头拉。
    entries.length = 0;
    totalCount = Number.NaN;
  }

  // 剩余部分按块**并发**取回，全部到齐后只合并、只渲染一次。
  //
  // 串行时每块 5000 行（约 4MB）都要等上一块渲染完才发下一块：表格重建一次
  // 3~6 秒，5 块叠起来就是二十多秒 —— 用户看到的「几万条一直在重新加载」。
  // 并发只等最慢的一块，代价是内存峰值高一些（5 块 ≈ 25MB），可以接受。
  // 并发度人为压到 3：服务端每个分块都是整份分页查询，全打上去只会互相排队。
  const chunks: Array<{ page: number; entries: T[] }> = [];
  let loadedCount = entries.length;
  let nextPage = 1;
  /** 总量未知时靠「短块」收尾，这里给一个硬上限防止死循环。 */
  const MAX_CHUNKS = 200;
  let exhausted = false;
  const worker = async () => {
    for (;;) {
      if (exhausted) return;
      const page = nextPage;
      if (page > MAX_CHUNKS) return;
      if (Number.isFinite(totalCount) && (page - 1) * DETAIL_ALL_CHUNK_SIZE >= totalCount) return;
      nextPage += 1;
      const chunkPage = await fetchDetailPage<T>(
        accountId,
        page,
        DETAIL_ALL_CHUNK_SIZE,
        signal,
        errorMessage,
        range,
      );
      if (Number.isFinite(chunkPage.totalCount)) totalCount = chunkPage.totalCount;
      chunks.push({ page, entries: chunkPage.entries });
      loadedCount += chunkPage.entries.length;
      onProgress?.(Math.min(loadedCount, Number.isFinite(totalCount) ? totalCount : loadedCount), totalCount);
      // 短块 = 最后一页（总量未知时全靠它收尾）。
      if (chunkPage.entries.length < DETAIL_ALL_CHUNK_SIZE) exhausted = true;
    }
  };
  const CONCURRENCY = 3;
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (isCurrent && !isCurrent()) {
    return { entries: [...entries], totalCount, stopped: true };
  }

  chunks.sort((a, b) => a.page - b.page);
  for (const chunk of chunks) {
    // 首屏那 500 行落在第 1 块的区间里，按位置跳过，别拉出重复行。
    const offset = (chunk.page - 1) * DETAIL_ALL_CHUNK_SIZE;
    const alreadyLoaded = Math.max(0, Math.min(chunk.entries.length, entries.length - offset));
    entries.push(...(alreadyLoaded > 0 ? chunk.entries.slice(alreadyLoaded) : chunk.entries));
  }
  emit();
  return { entries: [...entries], totalCount, stopped: false };
}

export function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}
