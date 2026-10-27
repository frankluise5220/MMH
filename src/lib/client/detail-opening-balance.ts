/**
 * 明细「时间窗口」的期初余额 —— 窗口化取数时，本地折叠缺的那个起点。
 *
 * 余额必须在**全量账本**上折叠（它是账户的状态量，不是区间的统计量），但列表只拉
 * 窗口内的行 —— 这是省流量省时间的前提。差的那一段用一个数字补回来：服务端按
 * **与列表同一条折叠链**（`ledger_balanced`）算出「截至窗口起点前一天的账户余额」，
 * 客户端拿它当本地折叠的起点，于是「期初余额 + 窗口内折叠」与「服务端整表折叠」
 * 逐分一致，而网络上只多了一个数字。
 *
 * 模块级缓存：同一个（账户, 窗口起点）只问一次。拖滑轨多数时候只改右端或整体平移，
 * 起点不变就不会有任何请求；数据真的变了（记一笔 / 删一笔 / 对账）由调用方
 * `invalidateOpeningBalance()` 清掉。
 */

const cache = new Map<string, number>();
const inflight = new Map<string, Promise<number>>();

function cacheKeyOf(accountId: string, fromYmd: string) {
  return `${accountId}|${fromYmd}`;
}

/** 已经有值就同步返回（首帧就能用上，不必先错一帧）。 */
export function peekDetailOpeningBalance(accountId: string, fromYmd: string): number | null {
  const value = cache.get(cacheKeyOf(accountId, fromYmd));
  return typeof value === "number" ? value : null;
}

export function loadDetailOpeningBalance(
  accountId: string,
  fromYmd: string,
  signal?: AbortSignal,
): Promise<number> {
  const key = cacheKeyOf(accountId, fromYmd);
  const cached = cache.get(key);
  if (typeof cached === "number") return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;

  const request = (async () => {
    const params = new URLSearchParams({ accountId, openingBalanceBefore: fromYmd });
    const response = await fetch(`/api/v1/transactions/detail?${params.toString()}`, { signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? "期初余额读取失败");
    const value = Number(payload?.data?.openingBalance);
    const openingBalance = Number.isFinite(value) ? value : 0;
    cache.set(key, openingBalance);
    return openingBalance;
  })();
  inflight.set(
    key,
    request.finally(() => {
      inflight.delete(key);
    }),
  );
  return request;
}

/** 流水 / 余额变了：期初余额会变，缓存必须失效（在途请求不受影响）。 */
export function invalidateDetailOpeningBalance() {
  cache.clear();
}
