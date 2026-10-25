"use client";

import { DETAIL_ALL_CHUNK_SIZE, DETAIL_ALL_FIRST_PAGE_SIZE, DETAIL_ALL_PAGE_SIZE } from "@/lib/detail-pagination-preference";

export type ChunkedDetailLoadOptions<T> = {
  accountId: string;
  signal?: AbortSignal;
  /** Return false to stop early, e.g. because the account / page / scope changed. */
  isCurrent?: () => boolean;
  /** Called after every chunk so the view can grow while the rest is still in flight. */
  onChunk?: (entries: T[], totalCount: number) => void;
  /** Localized message used when the API rejects a chunk. */
  errorMessage?: string;
};

export type ChunkedDetailLoadResult<T> = {
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
): Promise<DetailPage<T>> {
  const params = new URLSearchParams({
    accountId,
    page: String(page),
    pageSize: String(pageSize),
  });
  const response = await fetch(`/api/v1/transactions/detail?${params.toString()}`, {
    cache: "no-store",
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
 * 先取一页小的（`DETAIL_ALL_FIRST_PAGE_SIZE`）立刻渲染：行数超过表格虚拟化
 * 阈值（200 行）后虚拟滚动条马上出现，用户不用盯着切「全部」前那一页「自适应」
 * 行数干等。随后再取全量（`DETAIL_ALL_PAGE_SIZE`）：实测「全部收支」42636 条约
 * 23s / 82MB，而按 5000 条分块要 9 次、每次都得重算整份排序与逐笔余额，合计
 * 105s —— 单次反而快约 4 倍。所以全量走一次请求，取完整份替换首屏。
 *
 * 只有在全量这一次请求被浏览器/代理重置、或口径超过单次上限时才退回分块：按
 * `DETAIL_ALL_CHUNK_SIZE` 顺序翻页（首屏已展示的前几行跳过，不重复），每块通过
 * `onChunk` 交给视图，边到边显示。服务端按 `rowNumber` 区间取页
 * （`> offset AND <= offset + pageSize`），页间既不重复也不遗漏，逐笔余额都在
 * 全量口径上算好。
 */
export async function loadAllDetailEntries<T>({
  accountId,
  signal,
  isCurrent,
  onChunk,
  errorMessage,
}: ChunkedDetailLoadOptions<T>): Promise<ChunkedDetailLoadResult<T>> {
  const entries: T[] = [];
  let totalCount = Number.NaN;
  const emit = () => onChunk?.([...entries], totalCount);

  // 第一屏：小页先让列表长出来（虚拟滚动阈值 200 行，500 行稳过）。
  try {
    const first = await fetchDetailPage<T>(accountId, 1, DETAIL_ALL_FIRST_PAGE_SIZE, signal, errorMessage);
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

  // 全量：一次请求拿完整份，到了再整份替换首屏。
  try {
    const full = await fetchDetailPage<T>(accountId, 1, DETAIL_ALL_PAGE_SIZE, signal, errorMessage);
    if (Number.isFinite(full.totalCount)) totalCount = full.totalCount;
    if (isCurrent && !isCurrent()) {
      return { entries: full.entries, totalCount, stopped: true };
    }
    onChunk?.(full.entries, totalCount);
    return { entries: full.entries, totalCount, stopped: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    // 大回包被重置 / 超时 → 退回分块，至少能一块块把数据摆出来。
  }

  // 分块回退：从第 1 页开始顺序翻页，首屏已经展示过的前几行跳过（页间按 offset
  // 连续，不重复也不遗漏）。
  const maxChunks = 200;
  for (let page = 1; page <= maxChunks; page += 1) {
    const chunkPage = await fetchDetailPage<T>(
      accountId,
      page,
      DETAIL_ALL_CHUNK_SIZE,
      signal,
      errorMessage,
    );
    if (isCurrent && !isCurrent()) {
      return { entries: [...entries], totalCount: chunkPage.totalCount, stopped: true };
    }
    const chunk = chunkPage.entries;
    if (Number.isFinite(chunkPage.totalCount)) totalCount = chunkPage.totalCount;
    const alreadyLoaded = Math.max(0, Math.min(chunk.length, entries.length - (page - 1) * DETAIL_ALL_CHUNK_SIZE));
    entries.push(...(alreadyLoaded > 0 ? chunk.slice(alreadyLoaded) : chunk));
    emit();
    // 短块 = 最后一页；总数已知时也不必再多探一页。
    if (chunk.length < DETAIL_ALL_CHUNK_SIZE) break;
    if (Number.isFinite(totalCount) && entries.length >= totalCount) break;
  }
  return { entries: [...entries], totalCount, stopped: false };
}

export function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
}
