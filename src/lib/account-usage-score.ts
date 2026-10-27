/**
 * Account usage scoring for account pickers ("操作账户" ordering).
 *
 * Pure module: no React, no browser APIs, no "use client" — so the algorithm
 * stays importable from tsx verification scripts and reusable by any surface
 * that orders accounts by usage.
 *
 * Score design (2026-10-27, second revision — "缓慢上升"):
 *
 *   score = habit(count) + ramp(count) × (recent(30d decayed) + recency(lastUsed))
 *
 * - habit (0..300): log-saturated all-time operation count. It never decays,
 *   so a heavily used account keeps a high floor even after weeks without use.
 *   This is what stops "one use = instant #1": an idle account is no longer
 *   worth ~0, so the gaps between neighbours cannot be erased by a single tap.
 * - ramp (0..1): `log1p(count) / log1p(10)`. Before an account has been used
 *   ~10 times, its recent activity — including the "just used" bonus — only
 *   counts proportionally. A rarely used account therefore cannot leap to the
 *   top on its first use; it has to accumulate a few days of use and climbs
 *   one neighbour at a time.
 * - recent (0..~300): decayed operation count over the last 30 days, each
 *   calendar day contributing `dailyCount × 0.5^(daysAgo / 7)`, compressed by
 *   `log1p` so 1 operation and 10 operations differ by ~2.4× instead of 10×.
 * - recency (0..20): linear fade of the last used moment over 30 days, a small
 *   nudge inside the same ramp (kept for legacy stats and near-tie stability).
 *
 * Accounts without any recorded usage score 0 and keep their original order.
 *
 * The daily histogram (`daily`) is written by `recordRecentAccounts` in
 * `src/lib/client/recentAccounts.ts`（只在新增/编辑/删除成功后调用）；stats written before that field existed
 * only carry `count` + `lastUsedAt` and fall back to a single weighted use
 * anchored at their last used moment.
 */

const ACCOUNT_USAGE_RECENT_WINDOW_DAYS = 30;

/** 权重半衰期：今天的一次操作，7 天后还剩一半分值，30 天后约剩 5%。 */
const ACCOUNT_USAGE_DECAY_HALF_LIFE_DAYS = 7;

/** How many days of history the daily histogram keeps (bounded storage). */
const ACCOUNT_USAGE_DAILY_HISTORY_DAYS = 45;

/** 长期习惯分上限：全时次数达到 HABIT_SCORE_KNEE 即拿满，之后不再增长。 */
const HABIT_SCORE_MAX = 300;

/** 全时次数拐点：200 次使用 = 满分习惯分。 */
const HABIT_SCORE_KNEE = 200;

/** 近期分权重（乘在 log1p(衰减计数) 上）。 */
const RECENT_SCORE_WEIGHT = 90;

/** 起步阻尼拐点：全时使用 10 次之前，近期分只按 log 比例计入。 */
const RECENT_RAMP_KNEE = 10;

/** 最近使用加成上限（30 天线性淡出，同样受起步阻尼约束）。 */
const RECENCY_BONUS_MAX = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export type AccountUsageStat = {
  count: number;
  lastUsedAt: number;
  /** Daily operation histogram keyed by local `YYYY-MM-DD`, pruned to ~45 days. */
  daily?: Record<string, number>;
};

export type AccountUsageMap = Record<string, AccountUsageStat>;

/** Local-timezone `YYYY-MM-DD` key used by the daily histogram. */
function accountUsageDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Drops histogram entries older than the kept history window (string compare works on YYYY-MM-DD). */
function pruneAccountUsageDaily(
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

/** Decayed operation count inside the last 30 days for one stat. */
function recentWindowScore(stat: AccountUsageStat, now: number): number {
  if (stat.daily) {
    let score = 0;
    for (let daysAgo = 0; daysAgo < ACCOUNT_USAGE_RECENT_WINDOW_DAYS; daysAgo += 1) {
      const key = accountUsageDayKey(new Date(now - daysAgo * DAY_MS));
      const count = stat.daily[key] ?? 0;
      if (count > 0) score += count * accountUsageDayWeight(daysAgo);
    }
    return score;
  }
  // Legacy stats (no daily histogram): approximate the window with a single
  // weighted use anchored at the last used moment. Using the all-time count
  // here would let years-old heavy accounts dominate the window forever.
  const daysAgo = Math.floor((now - stat.lastUsedAt) / DAY_MS);
  if (!Number.isFinite(daysAgo) || daysAgo < 0 || daysAgo >= ACCOUNT_USAGE_RECENT_WINDOW_DAYS) return 0;
  return accountUsageDayWeight(daysAgo);
}

/** 第 daysAgo 天的权重（0 = 今天）。 */
function accountUsageDayWeight(daysAgo: number): number {
  return Math.pow(0.5, daysAgo / ACCOUNT_USAGE_DECAY_HALF_LIFE_DAYS);
}

/** 长期习惯分：全时次数对数饱和到 0..HABIT_SCORE_MAX，不随时间衰减。 */
function habitScore(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(1, Math.log1p(count) / Math.log1p(HABIT_SCORE_KNEE)) * HABIT_SCORE_MAX;
}

/** 起步阻尼：使用 RECENT_RAMP_KNEE 次之前，近期分只按 log 比例计入。 */
function recentRamp(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(1, Math.log1p(count) / Math.log1p(RECENT_RAMP_KNEE));
}

/**
 * Single comparable score for one account's usage stat. Higher = rank earlier.
 *
 * Reference points (see the module header): 一个长期每天使用 200+ 次的账户
 * ≈ 300 + (216 + 20) ≈ 536；一个刚被用了一次的新账户 ≈ 39 + 0.29 × 82 ≈ 63,
 * 排在所有用过 2 次以上的账户之后 —— 这就是"不会从第 10 位跳到第 1 位"。
 * 持续使用 10 次左右之后起步阻尼解除，短期内的高频使用才会真正把位置往前推。
 */
export function accountUsageScore(
  stat: AccountUsageStat | undefined,
  now: number = Date.now(),
): number {
  if (!stat) return 0;
  const count = Math.max(stat.count, 0);
  const recent = RECENT_SCORE_WEIGHT * Math.log1p(recentWindowScore(stat, now));
  const daysSinceLast = stat.lastUsedAt > 0 ? Math.max(0, (now - stat.lastUsedAt) / DAY_MS) : Number.POSITIVE_INFINITY;
  const recency = daysSinceLast <= 30 ? ((30 - daysSinceLast) / 30) * RECENCY_BONUS_MAX : 0;
  return habitScore(count) + recentRamp(count) * (recent + recency);
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
        score: accountUsageScore(stat, now),
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
