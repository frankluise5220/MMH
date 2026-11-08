import { unstable_cache } from "next/cache";
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
 *
 * 候选池按分类类型（支出 / 收入 / 代付 / 投资 / 转账 …）**分别**保留上限条数：
 * 若按全账簿混排取全局前 30，记账量大的支出会把收入挤出去，
 * 收入页签的「最近使用 / 常用分类」就会整排消失。
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

async function _loadCategoryUsageStats(hidFilter: { householdId: string }): Promise<CategoryUsageStats> {
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
  if (stats.length === 0) return { recent: [], frequent: [] };

  const categories = await prisma.category.findMany({
    where: { id: { in: stats.map((row) => row.id) } },
    select: { id: true, type: true },
  });
  const typeById = new Map(categories.map((category) => [category.id, category.type]));

  // 先按分类类型分桶，再在桶内排序截断：支出量再大也只占自己那一桶。
  const buckets = new Map<string, CategoryUsageRow[]>();
  for (const row of stats) {
    const type = typeById.get(row.id) ?? "";
    const bucket = buckets.get(type);
    if (bucket) bucket.push(row);
    else buckets.set(type, [row]);
  }

  const recent: string[] = [];
  const frequent: string[] = [];
  for (const bucket of buckets.values()) {
    recent.push(
      ...bucket
        .slice()
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.count - a.count || a.id.localeCompare(b.id))
        .slice(0, RECENT_CANDIDATES)
        .map((row) => row.id),
    );
    frequent.push(
      ...bucket
        .slice()
        .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.id.localeCompare(b.id))
        .slice(0, FREQUENT_CANDIDATES)
        .map((row) => row.id),
    );
  }

  return { recent, frequent };
}

/** Cross-request cache; invalidated after transaction or category changes. */
export const loadCategoryUsageStats = unstable_cache(
  _loadCategoryUsageStats,
  ["category-usage", "2026-11-08-v2"],
  {
    revalidate: false,
    tags: ["category-usage"],
  },
);
