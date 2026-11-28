/**
 * 投资收益报表的进程内结果缓存。
 *
 * 为什么要单独一个模块：`loadInvestmentProfitReport` 一次要 1.5s 左右（概览页 1.9s 里
 * 1.5s 是它），而概览 / 报表 / 每日盈亏三个入口拿的是同一份结果。用户在页面之间来回切换
 * 时每次都重算是纯浪费。
 *
 * 为什么不直接用 `unstable_cache`：函数入参是 `HouseholdContext`（带 Prisma 查询条件对象），
 * 不能当序列化 key，而且结果里有 Date 对象。这里用「原样缓存 + 调用约定」：
 *  - key 由调用方拼成纯字符串（household + 查询参数 + 语言）；
 *  - 缓存的是 Promise（并发同参请求合并成一次计算）；
 *  - 任何写入流水 / 投资的 revalidate 都调 `invalidateInvestmentReportCache()` 清空，
 *    所以「记完一笔回概览看不到变化」不会发生；
 *  - TTL 兜底（净值同步、系统任务这类不经过 revalidate 的写入最多滞后一个 TTL）。
 */
type CacheEntry = { at: number; promise: Promise<unknown> };

const CACHE_TTL_MS = 3 * 60_000;
const CACHE_LIMIT = 12;
const cache = new Map<string, CacheEntry>();

export function readInvestmentReportCache<T>(key: string): Promise<T> | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.promise as Promise<T>;
}

export function writeInvestmentReportCache(key: string, promise: Promise<unknown>) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  // 失败的结果不留在缓存里，否则一次瞬时 DB 错误会连续 TTL 内都返回失败。
  const guarded = promise.catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { at: Date.now(), promise: guarded });
}

export function invalidateInvestmentReportCache() {
  cache.clear();
}
