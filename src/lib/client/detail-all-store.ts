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
 * 「缓存是否可用」的变更通知。
 *
 * `subscribeDetailAll` 只派发某个 key 的加载进度，看不到「整份到齐 / 被作废 /
 * 过期」这些状态变化 —— 而单账户视图正是靠它决定复用「全部收支」共享缓存还是
 * 按自己的 accountId 取数。漏一次就会在共享缓存作废后继续挂着 `__all_cash__`，
 * 为只有几千行的账户把全账簿几万行重拉一遍。
 */
const cacheAvailabilityListeners = new Set<() => void>();

function notifyCacheAvailabilityChanged() {
  [...cacheAvailabilityListeners].forEach((listener) => listener());
}

/** 配合 `useSyncExternalStore`：缓存可用性一变就重算数据口径。 */
export function subscribeDetailAllCacheAvailability(listener: () => void) {
  cacheAvailabilityListeners.add(listener);
  return () => {
    cacheAvailabilityListeners.delete(listener);
  };
}

/**
 * 作废缓存时留下的「上一份完整结果」，只用于**展示兜底**，不参与数据正确性判断。
 *
 * 保存一笔账之后整份重拉，第一块只有 500 行：`entries` 从两万行骤降到 500 行，
 * 浏览器把 `scrollTop` 夹到新内容的底部，用户看到的就是「保存后一下跳到最底下」。
 * 所以在重拉期间继续把旧行发给界面，等新数据铺满（或拉完）再整体替换。
 */
type StaleSnapshot = { entries: unknown[]; totalCount: number; range?: string };
const staleSnapshots = new Map<string, StaleSnapshot>();

function rememberStale<T>(job: Job<T>) {
  if (job.entries.length === 0) return;
  if (!staleSnapshots.has(job.key) && staleSnapshots.size >= MAX_CACHED_JOBS) {
    const oldest = staleSnapshots.keys().next();
    if (!oldest.done) staleSnapshots.delete(oldest.value);
  }
  staleSnapshots.set(job.key, { entries: job.entries, totalCount: job.totalCount, range: job.range });
}

/** 新数据还没铺满旧行数时用旧行展示：行数不缩水，滚动位置就不会被浏览器夹到底部。 */
function visibleRows<T>(job: Job<T>): { entries: T[]; totalCount: number } {
  const stale = staleSnapshots.get(job.key);
  if (!stale) return { entries: job.entries, totalCount: job.totalCount };
  if (job.done || job.entries.length >= stale.entries.length) {
    staleSnapshots.delete(job.key);
    return { entries: job.entries, totalCount: job.totalCount };
  }
  return { entries: stale.entries as T[], totalCount: stale.totalCount };
}

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
 * 某个 key 的整份明细是不是已经到齐、且覆盖当前窗口（渲染期只读）。
 *
 * 与 `ensureDetailAll` 的复用判断同一口径：没完成、已过期、窗口比缓存更宽都不算
 * 可用。组件靠它在渲染期决定数据口径，所以这里**不能**顺手删缓存或发请求 ——
 * 那会在 render 里改外部 store，触发重复渲染。
 */
export function isDetailAllReady(key: string, range?: string): boolean {
  const job = jobs.get(key);
  if (!job || !job.done || Date.now() - job.finishedAt > TTL_MS) return false;
  return detailRangeCovers(job.range, range);
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
  const visible = visibleRows(job);
  const snapshot: DetailAllSnapshot<T> = {
    entries: visible.entries,
    totalCount: visible.totalCount,
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
    staleSnapshots.delete(key);
    notifyCacheAvailabilityChanged();
    return null;
  }
  const visible = visibleRows(job);
  return {
    entries: visible.entries,
    totalCount: visible.totalCount,
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
  notifyCacheAvailabilityChanged();
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
    const visible = visibleRows(existing);
    return {
      entries: visible.entries,
      totalCount: visible.totalCount,
      loadedCount: Math.max(existing.loadedCount, existing.entries.length),
      done: existing.done,
      range: existing.range,
    };
  }
  if (existing) {
    // 范围变大 / 过期：这份数据不再够用，先停掉在途任务再重来。
    rememberStale(existing);
    existing.controller.abort();
    jobs.delete(options.key);
    notifyCacheAvailabilityChanged();
  }
  // 兜底行只在覆盖新窗口时可用；范围变大时旧行不够，还留着会让计数对不上。
  const stale = staleSnapshots.get(options.key);
  if (stale && !detailRangeCovers(stale.range, options.range)) staleSnapshots.delete(options.key);

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
        notifyCacheAvailabilityChanged();
        return;
      }
      job.entries = result.entries;
      job.totalCount = Number.isFinite(result.totalCount) ? result.totalCount : result.entries.length;
      job.loadedCount = job.entries.length;
      job.done = true;
      job.finishedAt = Date.now();
      emit(options.key, job);
      notifyCacheAvailabilityChanged();
      pruneCache();
    })
    .catch((error) => {
      if (isCurrent()) {
        jobs.delete(options.key);
        notifyCacheAvailabilityChanged();
      }
      if (isAbortError(error)) return;
      console.error("Load all transaction detail entries failed:", error);
    });

  const visible = visibleRows(job);
  return { entries: visible.entries, totalCount: visible.totalCount, loadedCount: 0, done: false, range: job.range };
}

/**
 * 丢掉已完成的缓存，但**不动在途任务**。
 *
 * 删行时用它：在途任务拉的是服务端最新数据（已删的行不会回来），让它跑完即可；
 * 而已经落地的整份结果会带着被删的行，必须作废，否则下次切「全部」又显示出来。
 */
/**
 * 只改行文本后，把当前页返回的行按 id 覆盖缓存中的对应行。
 *
 * 只换同 id 的行：不增删、不重排、不改 totalCount / done，也不通知订阅者 ——
 * 调用方（父层）已经用同一批行更新了表格，再 emit 只会多一次整表重建。
 * 行必须来自明细**列表**接口，与缓存里的行同构（含 runningBalance /
 * reconciledAt / reconciledBalance），整行替换才安全；不要用 `?id=` 的编辑
 * 回填结果调它（那条分支缺余额字段，还会覆盖基金关联行的金额与账户）。
 */
export function patchDetailAllRows<T extends { id: string }>(key: string, rows: T[]) {
  if (rows.length === 0) return;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const apply = (entries: T[]) => entries.map((entry) => byId.get(entry.id) ?? entry);
  const job = jobs.get(key) as Job<T> | undefined;
  if (job?.entries.length) job.entries = apply(job.entries);
  const stale = staleSnapshots.get(key);
  if (stale) stale.entries = apply(stale.entries as T[]);
}

/** 结构变化事件带来的行标识：用来修正兜底数据，避免删掉的行复活、新增的行被遮住。 */
export type CacheChangeOptions = {
  /** 本次事件涉及的行（新增 / 修改 / 删除都在内）。 */
  entryIds?: readonly string[];
  /** 本次事件删掉的行。 */
  deletedEntryIds?: readonly string[];
};

type EntryIdLike = { id?: unknown };

/**
 * 行集合变了之后修正「展示兜底」。
 *
 * 兜底行只适合「同一批行重拉一遍」（改金额 / 日期 / 账户，行数不变）：那时保留旧行
 * 能钉住滚动位置。但删除会让被删的行重新出现在表里，新增会让新行一直藏到整份拉完，
 * 所以这两类事件必须先把兜底数据改对：
 * - 删掉的行直接从兜底里剔除（行数仍然不变，滚动位置照样钉得住）；
 * - 事件里的 id 在兜底里根本不存在 = 新增行，整份兜底作废（宁可短暂缩水，也不能
 *   让刚记的一笔不出现）。
 *
 * 只做这两件事，不做重排：排序由表格自己做，兜底只要保证「行集合」大致正确。
 */
function reconcileStale(key: string, options?: CacheChangeOptions) {
  const stale = staleSnapshots.get(key);
  if (!stale) return;
  const deleted = new Set(options?.deletedEntryIds ?? []);
  if (deleted.size > 0) {
    const before = stale.entries.length;
    const kept = (stale.entries as EntryIdLike[]).filter((entry) => !deleted.has(String(entry?.id ?? "")));
    if (kept.length < before) {
      stale.entries = kept;
      stale.totalCount = Math.max(0, stale.totalCount - (before - kept.length));
    }
    if (kept.length === 0) {
      staleSnapshots.delete(key);
      return;
    }
  }
  const touched = options?.entryIds ?? [];
  if (touched.length === 0) return;
  const known = new Set((stale.entries as EntryIdLike[]).map((entry) => String(entry?.id ?? "")));
  if (touched.some((id) => !known.has(id))) staleSnapshots.delete(key);
}

export function dropDetailAllCache(keys?: readonly string[], options?: CacheChangeOptions) {
  // 不传 keys = 影响域未知的全局事件，按全部作废；传了就只动这些账户视图，
  // 别因为 A 账户记了一笔就把 B 账户几万行的整份缓存也丢掉。
  const affected = keys?.length ? new Set(keys) : null;
  let changed = false;
  [...jobs.entries()].forEach(([key, job]) => {
    if (affected && !affected.has(key)) return;
    if (!job.done) return;
    rememberStale(job);
    jobs.delete(key);
    changed = true;
  });
  // 任务可能上一轮就被删掉了，只剩兜底数据；这类残留同样要跟着行集变化修正。
  (affected ? [...affected] : [...staleSnapshots.keys()]).forEach((key) => reconcileStale(key, options));
  if (changed) notifyCacheAvailabilityChanged();
}

/** 大范围改写：中止受影响视图的在途任务并丢掉它们的缓存，其它视图照旧。 */
export function invalidateDetailAll(keys?: readonly string[], options?: CacheChangeOptions) {
  const affected = keys?.length ? new Set(keys) : null;
  const selected = [...jobs.entries()].filter(([key]) => !affected || affected.has(key));
  selected.forEach(([key, job]) => {
    rememberStale(job);
    job.controller.abort();
    jobs.delete(key);
  });
  (affected ? [...affected] : [...staleSnapshots.keys()]).forEach((key) => reconcileStale(key, options));
  if (selected.length === 0) return;
  notifyCacheAvailabilityChanged();
}
