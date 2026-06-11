/**
 * 命令别名库 — 统一查询模块
 *
 * 分类 (category) 说明：
 * - "fundSubtype":    买入→buy, 赎回→redeem, 现金红利→dividend_cash, ...
 * - "updateTarget":   资金账户→cashAccount, 消费账户→account, ...
 * - "transactionType": 支出→expense, 收入→income, ...
 *
 * 所有命令解析函数必须使用此模块查找别名，禁止硬编码映射。
 */
import { prisma } from "@/lib/db/prisma";

let cache: Map<string, Map<string, string>> | null = null;
let cacheTs = 0;
const CACHE_TTL = 60_000; // 1 minute

async function loadCache(): Promise<Map<string, Map<string, string>>> {
  const now = Date.now();
  if (cache && now - cacheTs < CACHE_TTL) return cache;

  const rows = await prisma.commandAlias.findMany({ orderBy: { key: "asc" } });
  cache = new Map();
  for (const r of rows) {
    if (!cache.has(r.category)) cache.set(r.category, new Map());
    cache.get(r.category)!.set(r.key, r.value);
  }
  cacheTs = now;
  return cache;
}

/** 通过别名查找规范值 (带缓存) */
export async function resolveAlias(category: string, key: string): Promise<string | null> {
  const c = await loadCache();
  return c.get(category)?.get(key) ?? null;
}

/** 反查：通过规范值查找所有别名 */
export async function resolveAliasReverse(category: string, value: string): Promise<string[]> {
  const c = await loadCache();
  const keys: string[] = [];
  for (const [k, v] of c.get(category) ?? []) {
    if (v === value) keys.push(k);
  }
  return keys;
}

/** 设置别名 */
export async function setAlias(category: string, key: string, value: string): Promise<void> {
  await prisma.commandAlias.upsert({
    where: { category_key: { category, key } },
    create: { category, key, value },
    update: { value },
  });
  cache = null; // invalidate
}

/** 删除别名 */
export async function deleteAlias(category: string, key: string): Promise<boolean> {
  try {
    await prisma.commandAlias.delete({ where: { category_key: { category, key } } });
    cache = null;
    return true;
  } catch {
    return false;
  }
}

/** 列出某分类所有别名 */
export async function listAliases(category?: string): Promise<Array<{ key: string; value: string; category: string }>> {
  const c = await loadCache();
  const result: Array<{ key: string; value: string; category: string }> = [];
  for (const [cat, map] of c) {
    if (category && cat !== category) continue;
    for (const [k, v] of map) {
      result.push({ category: cat, key: k, value: v });
    }
  }
  return result;
}
