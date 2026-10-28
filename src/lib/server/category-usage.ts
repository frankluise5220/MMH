import { prisma } from "@/lib/db/prisma";

/**
 * 分类下拉「快捷选择」的数据口径。
 *
 * - recent：最近入账用过的分类（按入账日期倒序）；
 * - frequent：入账次数最多的分类（按次数倒序）。
 *
 * 两条列表都返回足够长的候选 id，由调用方按当前可见分类（支出 / 收入 / 代付，
 * 以及存款账户白名单过滤）裁剪后再去重：这样切换记账类型不需要重新请求，
 * 也不会出现「第一排全被过滤掉、只剩空行」的情况。
 */
export type CategoryUsageStats = {
  recent: string[];
  frequent: string[];
};

const RECENT_CANDIDATES = 30;
const FREQUENT_CANDIDATES = 30;

type CategoryUsageRow = {
  id: string;
  count: number;
  lastUsedAt: number;
};

export async function loadCategoryUsageStats(hidFilter: { householdId: string }): Promise<CategoryUsageStats> {
  const rows = await prisma.txRecord.groupBy({
    by: ["categoryId"],
    where: { ...hidFilter, categoryId: { not: null }, deletedAt: null },
    _count: { _all: true },
    _max: { date: true },
  });

  const stats: CategoryUsageRow[] = [];
  for (const row of rows) {
    if (!row.categoryId) continue;
    stats.push({
      id: row.categoryId,
      count: row._count._all,
      lastUsedAt: row._max.date ? row._max.date.getTime() : 0,
    });
  }

  const recent = [...stats]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, RECENT_CANDIDATES)
    .map((row) => row.id);

  const frequent = [...stats]
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.id.localeCompare(b.id))
    .slice(0, FREQUENT_CANDIDATES)
    .map((row) => row.id);

  return { recent, frequent };
}
