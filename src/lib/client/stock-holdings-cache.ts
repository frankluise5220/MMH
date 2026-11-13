/**
 * 持仓下拉（卖出 / 分红 / 股本变动 / 股息税）的会话级缓存。
 *
 * 这几个页签每次打开弹窗、切页签、改交易日都会重新请求 `/api/v1/stocks/holdings`
 * （卖出/分红那支要按交易日回放该账户的全部交易行），请求没回来之前下拉框只有
 * 「加载中」一个占位，用户会觉得每次打开都要干等。这里按「账户 + 口径 + 交易日」
 * 记住上一份结果：打开时先把它直接填进下拉（立刻可选），请求照常发、回来再静默校准。
 *
 * 只在记账成功（持仓已变）时作废对应账户的缓存，避免用户看到卖出后仍是旧数量。
 */
export type StockHoldingRow = {
  id: string;
  accountId: string;
  securityId: string;
  market: string;
  stockCode: string;
  stockName?: string | null;
  quantity: number;
};

/** 保鲜期只决定「能不能拿来先显示」，数据正确性靠每次打开都发的请求校准。 */
const TTL_MS = 60_000;

const cache = new Map<string, { rows: StockHoldingRow[]; at: number }>();

export function stockHoldingsCacheKey(
  accountId: string,
  params: { tradeDate?: string; includeZero?: boolean },
) {
  return `${accountId}|${params.includeZero ? "all" : "date"}|${params.tradeDate ?? ""}`;
}

export function readStockHoldingsCache(key: string) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.rows;
}

export function writeStockHoldingsCache(key: string, rows: StockHoldingRow[]) {
  cache.set(key, { rows, at: Date.now() });
}

/** 记账成功：该账户持仓已变，作废它的缓存（不传账户则全清）。 */
export function invalidateStockHoldingsCache(accountId?: string) {
  if (!accountId) {
    cache.clear();
    return;
  }
  const prefix = `${accountId}|`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
