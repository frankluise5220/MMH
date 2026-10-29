"use client";

import { isAbortError, loadAllDetailEntries } from "@/lib/client/detail-all-entries";
import { todayDateBusinessYmd } from "@/lib/date-utils";

/**
 * 「全部」视图的分块加载任务仓库（模块级，跟组件生命周期解耦）。
 *
 * 之前的加载是由 `BasicDetailPanel` 自己在 effect 里发起的：切到别的页面，
 * 组件卸载、请求作废；切回来重新挂载，又从第 1 块开始拉 — 两万条要二十多秒，
 * 用户看到的就是「换了个页面回来，几万条又重头加载」。
 *
 * 现在加载任务属于这个仓库：
 * - 组件卸载只是取消订阅，任务在后台继续跑完并落缓存；
 * - 再回来时 `ensure` 直接拿到当前进度（或在途任务本身），不再重发请求；
 * - 同一 key 的在途任务永远不会并发启动第二份。
 *
 * 数据时效：`finance:changed` 里显式 `invalidateDetailAll()`；另外 TTL 兜底
 * 后台任务 / 其它设备的写入（它们不会触发本端事件）。
 */
export type DetailAllSnapshot<T> = {
  entries: T[];
  totalCount: number;
  /** 已取回的条数（含还没合并进 `entries` 的并发分块），只用于进度文案。 */
  loadedCount: number;
  done: boolean;
  /**
   * 这份数据是按哪个时间范围拉的（`from~to`，空串/undefined 表示无界）。
   * 调用方靠它判断「当前窗口的数据是不是已经在本地了」，不能只看 `done`：
   * 按 5 年窗口拉完的缓存，遇到 10 年窗口仍然是不够的。
   */
  range?: string;
};

type Listener<T> = (snapshot: DetailAllSnapshot<T>) => void;

type Job<T> = {
  key: string;
  entries: T[];
  totalCount: number;
  loadedCount: number;
  done: boolean;
  controller: AbortController;
  finishedAt: number;
  /** 加载时用的数据范围（`from~to`，空串表示无界）。缩小范围时靠它判断能否本地裁剪。 */
  range?: string;
};

const TTL_MS = 10 * 60 * 1000;
/** 最多留几个已完成账户的整份明细，避免切账户切出几百 MB。 */
const MAX_CACHED_JOBS = 3;

const jobs = new Map<string, Job<unknown>>();
const listeners = new Map<string, Set<Listener<unknown>>>();

/**
 * 缓存按**账户**而不是「账户 + 范围」。
 *
 * 观测窗口从「最近 5 年」改成「最近 3 年」时，3 年的行是 5 年的子集：已经拉到
 * 本地的两万行里直接裁掉更早的部分就行，没有任何理由再发一轮请求、重新拉一万多行。
 * 只有范围**变大**（超出已加载的边界）才需要重载。
 */
export function detailAllCacheKey(accountId: string) {
  return accountId;
}

type ParsedDetailRange = { from: string; to: string };

function parseDetailRange(range: string | undefined | null): ParsedDetailRange {
  const [from = "", to = ""] = String(range ?? "").split("~");
  return { from: from.trim(), to: to.trim() };
}

/**
 * `loaded` 的范围是否覆盖 `wanted`（更宽或相同）。
 *
 * 两端的「空」不是同一种无界：
 * - 起点为空 = 最早的那一天，可以覆盖任何起点；
 * - 截止为空 **不再是「到数据末端」，而是「到今天为止」**（未来记账默认不列出，
 *   见 `detail-page-query.ts` 的 `ledger_visible`）。所以拿一份 `to` 为空的缓存去
 *   覆盖一个「截止日在今天之后」的窗口是错的：缓存里根本没有未来那几行，界面会
 *   出现「滑轨已经到 10-31、列表里却没有那笔账」。这种情况必须重取。
 */
export function detailRangeCovers(loaded: string | undefined, wanted: string | undefined): boolean {
  if (loaded === wanted) return true;
  const a = parseDetailRange(loaded);
  const b = parseDetailRange(wanted);
  const todayKey = todayDateBusinessYmd();
  // 截止日两端都按「空 = 今天」展开，再比大小：这样「开着含未来时缓存的整份」
  // 可以覆盖「关掉含未来」的窗口（多出来的未来行在本地裁掉即可），反过来不行。
  const loadedTo = a.to || todayKey;
  const wantedTo = b.to || todayKey;
  const lowerOk = !a.from || (!!b.from && b.from >= a.from);
  const upperOk = wantedTo <= loadedTo;
  return lowerOk && upperOk;
}

/**
 * 按数据范围裁掉已加载的行（本地过滤，不发请求）。
 *
 * 截止为空 = **到今天为止**，不是「到数据末端」：缓存里可能带着未来那几行（用户
 * 之前打开过「含未来」），关掉开关后必须在这里把它们裁掉，否则列表会跟界面上的
 * 范围对不上。
 */
export function filterEntriesByRange<T extends { date?: string | null }>(entries: T[], range: string | undefined): T[] {
  const { from, to } = parseDetailRange(range);
  const upper = to || todayDateBusinessYmd();
  return entries.filter((entry) => {
    const date = String(entry.date ?? "").slice(0, 10);
    if (!date) return true;
    if (from && date < from) return false;
    if (upper && date > upper) return false;
    return true;
  });
}

function emit<T>(key: string, job: Job<T>) {
  const set = listeners.get(key);
  if (!set || set.size === 0) return;
  const snapshot: DetailAllSnapshot<T> = {
    entries: job.entries,
    totalCount: job.totalCount,
    loadedCount: Math.max(job.loadedCount, job.entries.length),
    done: job.done,
    range: job.range,
  };
  // 复制一份再派发：监听者在回调里 setState，不能边遍历边被取消订阅影响。
  [...set].forEach((listener) => (listener as Listener<T>)(snapshot));
}

/** 只读当前快照（不启动加载）。范围变化时用它立刻重渲染本地过滤结果。 */
export function peekDetailAll<T>(key: string): DetailAllSnapshot<T> | null {
  const job = jobs.get(key) as Job<T> | undefined;
  if (!job) return null;
  if (job.done && Date.now() - job.finishedAt > TTL_MS) {
    jobs.delete(key);
    return null;
  }
  return {
    entries: job.entries,
    totalCount: job.totalCount,
    loadedCount: Math.max(job.loadedCount, job.entries.length),
    done: job.done,
    range: job.range,
  };
}

/** 订阅某个 key 的加载进度；任务还没建时先登记，`ensure` 启动后会照样收到。 */
export function subscribeDetailAll<T>(key: string, listener: Listener<T>) {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener as Listener<unknown>);
  return () => {
    const current = listeners.get(key);
    if (!current) return;
    current.delete(listener as Listener<unknown>);
    if (current.size === 0) listeners.delete(key);
  };
}

function pruneCache() {
  const settled = [...jobs.entries()].filter(([, job]) => job.done);
  if (settled.length <= MAX_CACHED_JOBS) return;
  settled.sort((a, b) => a[1].finishedAt - b[1].finishedAt);
  settled.slice(0, settled.length - MAX_CACHED_JOBS).forEach(([key]) => jobs.delete(key));
}

/**
 * 拿到这个 key 的整份明细：已完成且未过期直接返回；在途返回当前进度并续上；
 * 都没有才真正发起分块加载。组件重复调用（重挂载、事件刷新）不会重复请求。
 */
export function ensureDetailAll<T>(options: {
  key: string;
  accountId: string;
  range?: string;
  errorMessage?: string;
}): DetailAllSnapshot<T> {
  const existing = jobs.get(options.key) as Job<T> | undefined;
  // 已加载的范围覆盖当前请求的范围 → 直接复用，缩小窗口不会重新拉数据。
  if (
    existing
    && (!existing.done || Date.now() - existing.finishedAt < TTL_MS)
    && detailRangeCovers(existing.range, options.range)
  ) {
    return {
      entries: existing.entries,
      totalCount: existing.totalCount,
      loadedCount: Math.max(existing.loadedCount, existing.entries.length),
      done: existing.done,
      range: existing.range,
    };
  }
  if (existing) {
    // 范围变大 / 过期：这份数据不再够用，先停掉在途任务再重来。
    existing.controller.abort();
    jobs.delete(options.key);
  }

  const job: Job<T> = {
    key: options.key,
    entries: [],
    totalCount: Number.NaN,
    loadedCount: 0,
    done: false,
    controller: new AbortController(),
    finishedAt: 0,
    range: options.range,
  };
  const isCurrent = () => jobs.get(options.key) === (job as Job<unknown>);
  jobs.set(options.key, job as Job<unknown>);

  void loadAllDetailEntries<T>({
    accountId: options.accountId,
    range: options.range,
    errorMessage: options.errorMessage,
    signal: job.controller.signal,
    isCurrent,
    onChunk: (entries, totalCount) => {
      if (!isCurrent()) return;
      job.entries = entries;
      job.totalCount = totalCount;
      emit(options.key, job);
    },
    onProgress: (loadedCount) => {
      if (!isCurrent() || loadedCount <= job.loadedCount) return;
      job.loadedCount = loadedCount;
      emit(options.key, job);
    },
  })
    .then((result) => {
      if (!isCurrent()) return;
      // 被 invalidate 中止的半截结果不落地，下次仍然从头取（总比显示半份强）。
      if (result.stopped) {
        jobs.delete(options.key);
        return;
      }
      job.entries = result.entries;
      job.totalCount = Number.isFinite(result.totalCount) ? result.totalCount : result.entries.length;
      job.loadedCount = job.entries.length;
      job.done = true;
      job.finishedAt = Date.now();
      emit(options.key, job);
      pruneCache();
    })
    .catch((error) => {
      if (isCurrent()) jobs.delete(options.key);
      if (isAbortError(error)) return;
      console.error("Load all transaction detail entries failed:", error);
    });

  return { entries: job.entries, totalCount: job.totalCount, loadedCount: 0, done: false, range: job.range };
}

/**
 * 丢掉已完成的缓存，但**不动在途任务**。
 *
 * 删行时用它：在途任务拉的是服务端最新数据（已删的行不会回来），让它跑完即可；
 * 而已经落地的整份结果会带着被删的行，必须作废，否则下次切「全部」又显示出来。
 */
export function dropDetailAllCache() {
  [...jobs.entries()].forEach(([key, job]) => {
    if (job.done) jobs.delete(key);
  });
}

/** 数据确实变了、马上要重拉：中止在途任务并丢掉所有缓存。 */
export function invalidateDetailAll() {
  jobs.forEach((job) => job.controller.abort());
  jobs.clear();
}
