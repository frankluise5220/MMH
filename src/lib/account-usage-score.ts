/**
 * Account usage scoring for account pickers ("操作账户" ordering).
 *
 * Pure module: no React, no browser APIs, no "use client" — so the algorithm
 * stays importable from tsx verification scripts and reusable by any surface
 * that orders accounts by usage.
 *
 * Score design (2026-09-15):
 * - Primary signal: weighted operation count inside the last 5 days. Each
 *   calendar day of the window contributes `dailyCount × dayWeight` with
 *   weights [1, 0.8, 0.6, 0.4, 0.2] for today..4-days-ago, so accounts
 *   operated more often (and more recently) inside the window rank higher.
 * - Secondary signal: a linear recency bonus for the last used moment that
 *   fades over 30 days, so an account touched this week still floats above
 *   cold ones after the 5-day window has emptied.
 * - Tertiary signal: a small all-time count term as a stable tiebreaker.
 * Accounts without any recorded usage score 0 and keep their original order.
 *
 * The daily histogram (`daily`) is written by `recordRecentAccount` in
 * `src/lib/client/recentAccounts.ts`; stats written before that field existed
 * only carry `count` + `lastUsedAt` and fall back to a single weighted use
 * anchored at their last used moment.
 */

export const ACCOUNT_USAGE_RECENT_WINDOW_DAYS = 5;

/** Weight per day-ago inside the recent window (index 0 = today). */
export const ACCOUNT_USAGE_RECENT_WINDOW_DAY_WEIGHTS: readonly number[] = [1, 0.8, 0.6, 0.4, 0.2];

/** How many days of history the daily histogram keeps (bounded storage). */
export const ACCOUNT_USAGE_DAILY_HISTORY_DAYS = 30;

/** Max score contributed by the all-time count tiebreaker (min(count,100) × 0.1). */
const ALL_TIME_BONUS_MAX = 10;

/** Max score contributed by the last-used recency bonus (fades over 30 days). */
const RECENCY_BONUS_MAX = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AccountUsageStat = {
  count: number;
  lastUsedAt: number;
  /** Daily operation histogram keyed by local `YYYY-MM-DD`, pruned to ~30 days. */
  daily?: Record<string, number>;
};

export type AccountUsageMap = Record<string, AccountUsageStat>;

/** Local-timezone `YYYY-MM-DD` key used by the daily histogram. */
export function accountUsageDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Drops histogram entries older than the kept history window (string compare works on YYYY-MM-DD). */
export function pruneAccountUsageDaily(
  daily: Record<string, number> | undefined,
  now: number,
): Record<string, number> | undefined {
  if (!daily) return undefined;
  const cutoff = accountUsageDayKey(new Date(now - ACCOUNT_USAGE_DAILY_HISTORY_DAYS * DAY_MS));
  const next: Record<string, number> = {};
  for (const [key, value] of Object.entries(daily)) {
    if (key >= cutoff && Number.isFinite(value) && value > 0) next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Bumps today's counter on a stat's daily histogram and returns the updated stat (original untouched). */
export function incrementAccountUsageDaily(stat: AccountUsageStat, now: number): AccountUsageStat {
  const today = accountUsageDayKey(new Date(now));
  const daily = { ...(stat.daily ?? {}) };
  daily[today] = (daily[today] ?? 0) + 1;
  return { ...stat, daily: pruneAccountUsageDaily(daily, now) };
}

/** Weighted operation count inside the last 5 days for one stat. */
function recentWindowScore(stat: AccountUsageStat, now: number): number {
  if (stat.daily) {
    let score = 0;
    for (let daysAgo = 0; daysAgo < ACCOUNT_USAGE_RECENT_WINDOW_DAYS; daysAgo += 1) {
      const key = accountUsageDayKey(new Date(now - daysAgo * DAY_MS));
      const count = stat.daily[key] ?? 0;
      if (count > 0) score += count * (ACCOUNT_USAGE_RECENT_WINDOW_DAY_WEIGHTS[daysAgo] ?? 0);
    }
    return score;
  }
  // Legacy stats (no daily histogram): approximate the window with a single
  // weighted use anchored at the last used moment. Using the all-time count
  // here would let years-old heavy accounts dominate the window forever.
  const daysAgo = Math.floor((now - stat.lastUsedAt) / DAY_MS);
  if (!Number.isFinite(daysAgo) || daysAgo < 0 || daysAgo >= ACCOUNT_USAGE_RECENT_WINDOW_DAYS) return 0;
  return ACCOUNT_USAGE_RECENT_WINDOW_DAY_WEIGHTS[daysAgo] ?? 0;
}

/**
 * Single comparable score for one account's usage stat. Higher = rank earlier.
 * Scale: 1 operation today ≈ 100; recency bonus spans 0..50; all-time count
 * spans 0..10 — in-window activity always outweighs history of the same size.
 */
export function computeAccountUsageScore(
  stat: AccountUsageStat | undefined,
  now: number = Date.now(),
): number {
  if (!stat) return 0;
  const recent = recentWindowScore(stat, now) * 100;
  const daysSinceLast = stat.lastUsedAt > 0 ? Math.max(0, (now - stat.lastUsedAt) / DAY_MS) : Number.POSITIVE_INFINITY;
  const recencyBonus = daysSinceLast <= 30 ? ((30 - daysSinceLast) / 30) * RECENCY_BONUS_MAX : 0;
  const allTimeBonus = Math.min(Math.max(stat.count, 0), 100) * (ALL_TIME_BONUS_MAX / 100);
  return recent + recencyBonus + allTimeBonus;
}

/**
 * Stable usage-score ordering shared by every account picker.
 * Ties fall through to lastUsedAt / all-time count / original index, so the
 * result is deterministic for a given (items, usage, now) triple.
 */
export function sortAccountsByUsageScore<T extends { id?: string | null }>(
  items: T[],
  usage: AccountUsageMap,
  now: number = Date.now(),
): T[] {
  if (!items.length) return items;
  return items
    .map((item, index) => {
      const stat = item.id ? usage[item.id] : undefined;
      return {
        item,
        index,
        score: computeAccountUsageScore(stat, now),
        lastUsedAt: stat?.lastUsedAt ?? 0,
        count: stat?.count ?? 0,
      };
    })
    .sort((a, b) =>
      b.score - a.score
      || b.lastUsedAt - a.lastUsedAt
      || b.count - a.count
      || a.index - b.index,
    )
    .map((entry) => entry.item);
}
