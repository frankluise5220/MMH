import { prisma } from "@/lib/db/prisma";
import { queryFundNav } from "@/lib/fund/queryApi";

const NAV_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "http://fundf10.eastmoney.com/",
};

export interface NavListItem {
  date: string;
  nav: number;
  cumNav: number;
  sgzt: string;
  shzt: string;
}

/**
 * 批量查询基金历史净值（一次性获取整个时间段的数据）
 * 返回按日期降序排列的净值列表，包含申购/赎回状态
 * 东方财富API单页最多返回20条，设更大也只返回20
 */
export async function fetchHistoricalNavList(
  fundCode: string,
  startDate: string,
  endDate: string
): Promise<NavListItem[]> {
  const allItems: NavListItem[] = [];
  let pageIndex = 1;
  const pageSize = 20;

  while (true) {
    const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=${pageSize}&startDate=${startDate}&endDate=${endDate}`;
    try {
      const res = await fetch(url, { headers: NAV_HEADERS, cache: "no-store" });
      if (!res.ok) break;
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { break; }

      const list: { FSRQ: string; DWJZ: string; LJJZ: string; SGZT: string; SHZT: string }[] = data?.Data?.LSJZList ?? [];
      if (list.length === 0) break;
      for (const item of list) {
        allItems.push({
          date: item.FSRQ,
          nav: parseFloat(item.DWJZ),
          cumNav: parseFloat(item.LJJZ),
          sgzt: item.SGZT ?? "",
          shzt: item.SHZT ?? "",
        });
      }
      if (list.length < pageSize) break;
      pageIndex++;
    } catch {
      break;
    }
  }
  return allItems;
}

/**
 * 从预加载的净值列表中找到目标日期的净值（精确匹配）
 */
export function findNavExact(
  navList: NavListItem[],
  targetDate: string
): NavListItem | null {
  const exact = navList.find(item => item.date === targetDate);
  if (exact && exact.nav > 0) return exact;
  return null;
}

/**
 * 从预加载的净值列表中找到目标日期或之前最近的交易日净值（回退查找）
 */
export function findNavFallback(
  navList: NavListItem[],
  targetDate: string
): NavListItem | null {
  const targetTime = new Date(targetDate + "T00:00:00Z").getTime();
  const nowDate = new Date().toISOString().slice(0, 10);
  const nowTime = new Date(nowDate + "T00:00:00Z").getTime();
  // Don't fallback for today or future dates — the nav hasn't been published yet
  const recentThreshold = nowTime - 2 * 86400000; // 2 calendar days ago
  const isRecent = targetTime > recentThreshold;

  const sorted = [...navList].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  for (const item of sorted) {
    const itemTime = new Date(item.date + "T00:00:00Z").getTime();
    if (itemTime <= targetTime) {
      // For recent dates, only use exact match (don't use stale fallback)
      if (isRecent && itemTime < targetTime) continue;
      return item;
    }
  }
  // No fallback for recent dates
  if (isRecent) return null;
  return sorted[0] ?? null;
}

/**
 * 将历史净值列表批量写入缓存表（含申购状态）
 */
export async function preloadNavListToCache(
  fundCode: string,
  navList: NavListItem[]
): Promise<number> {
  let written = 0;
  // Check if any entry has 限制 status and fetch purchase limit if so
  const hasRestriction = navList.some(n => n.sgzt?.includes("限制"));
  let purchaseLimit: number | null = null;
  if (hasRestriction) {
    purchaseLimit = await fetchPurchaseLimit(fundCode);
  }
  for (const navItem of navList) {
    try {
      const limit = (navItem.sgzt?.includes("限制")) ? purchaseLimit : undefined;
      await setFundNav(fundCode, utcDate(navItem.date), navItem.nav, navItem.cumNav, undefined, navItem.sgzt, limit ?? undefined);
      written++;
    } catch {
      // 单条写入失败不影响整体
    }
  }
  return written;
}

/**
 * UTC日期转换（避免时区问题）
 */
function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * 查询基金净值（智能获取）
 * 流程：先查询缓存 → 不存在则调用API → 写入缓存 → 返回结果
 *
 * 调用方式：
 * - navDate 必须用 utcDate() 构造，确保时区为 T00:00:00Z
 *   正确：utcDate("2026-05-25") → 2026-05-25T00:00:00.000Z
 *   错误：new Date("2026-05-25") → 某些环境下可能偏移为 T16:00:00Z
 *
 * 返回值说明：
 * - dateMatch=true：净值日期与请求日期一致，可安全用于份额计算
 * - dateMatch=false：净值日期与请求日期不一致（如请求历史日期但API返回最近可用净值）
 *   actualDate 字段包含实际净值日期，可用于更新确认日期
 * - null：缓存和API均无数据
 *
 * @param fundCode 基金代码
 * @param navDate 净值日期（必须用 utcDate 构造的 Date 对象，确保 T00:00:00Z）
 * @returns 净值信息（nav、cumNav、name、dateMatch、actualDate）或 null
 */
export async function getFundNav(
  fundCode: string,
  navDate: Date
): Promise<{ nav: number; cumNav: number | null; name: string | null; dateMatch: boolean; actualDate?: string } | null> {
  // 1. 先查询缓存表
  const cached = await getFundNavFromCacheOnly(fundCode, navDate);

  if (cached) return { ...cached, dateMatch: true }; // 缓存数据日期一定匹配

  // 2. 缓存未命中，从外部 API 获取（按配置的优先级尝试）
  const dateStr = navDate.toISOString().slice(0, 10);
  const apiData = await queryFundNav(fundCode, dateStr);

  if (!apiData) return null;

  // 3. 校验净值日期是否与请求日期一致
  const dateMatch = !apiData.date || apiData.date === dateStr;

  // 4. 只有日期一致时才写入缓存
  if (dateMatch) {
    try {
      await prisma.fundNavCache.upsert({
        where: {
          fundCode_navDate: {
            fundCode,
            navDate,
          },
        },
        create: {
          fundCode,
          navDate,
          nav: apiData.nav,
          cumNav: apiData.cumNav,
          name: apiData.name,
        },
        update: {
          nav: apiData.nav,
          cumNav: apiData.cumNav,
          name: apiData.name,
        },
      });
    } catch {
      // 写入失败不影响返回结果
    }
  }

  // 5. 返回结果（包含日期匹配信息和实际净值日期）
  return {
    nav: apiData.nav,
    cumNav: apiData.cumNav ?? null,
    name: apiData.name ?? null,
    dateMatch,
    actualDate: apiData.date,
  };
}

/**
 * 仅从基金净值缓存库查询指定日期净值，不访问外部 API，不写入缓存。
 *
 * @param fundCode 基金代码
 * @param navDate 净值日期（必须用 utcDate 构造，确保 T00:00:00Z）
 * @returns 净值信息（nav、cumNav、name、sgzt）或 null（缓存不存在）
 */
export interface NavCacheEntry {
  nav: number;
  cumNav: number | null;
  name: string | null;
  sgzt: string | null;
  purchaseLimit: number | null;
}

export async function getFundNavFromCacheOnly(
  fundCode: string,
  navDate: Date
): Promise<NavCacheEntry | null> {
  const record = await prisma.fundNavCache.findUnique({
    where: { fundCode_navDate: { fundCode, navDate } },
  });
  if (!record) return null;
  return {
    nav: Number(record.nav),
    cumNav: record.cumNav ? Number(record.cumNav) : null,
    name: record.name,
    sgzt: record.sgzt ?? null,
    purchaseLimit: record.purchaseLimit ?? null,
  };
}

/**
 * 从天天基金详情页抓取基金单日申购限额
 * 只有 sgzt 包含"限制"时才调用
 */
const PURCHASE_LIMIT_CACHE = new Map<string, number | null>();

export async function fetchPurchaseLimit(fundCode: string): Promise<number | null> {
  if (PURCHASE_LIMIT_CACHE.has(fundCode)) return PURCHASE_LIMIT_CACHE.get(fundCode) ?? null;
  try {
    const res = await fetch(`http://fundf10.eastmoney.com/jjjz_${fundCode}.html`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      cache: "no-store",
    });
    const html = await res.text();
    const m = html.match(/单日累计购买上限(\d+)元/);
    const limit = m ? parseInt(m[1], 10) : null;
    PURCHASE_LIMIT_CACHE.set(fundCode, limit);
    return limit;
  } catch {
    PURCHASE_LIMIT_CACHE.set(fundCode, null);
    return null;
  }
}

/**
 * 更新基金净值（缓存表）
 * 强制同步净值到 FundNavCache 表
 *
 * @param fundCode 基金代码
 * @param navDate 净值日期（必须用 utcDate 构造，确保 T00:00:00Z）
 * @param nav 单位净值
 * @param cumNav 累计净值（可选）
 * @param name 基金名称（可选）
 * @param sgzt 申购状态（可选，如"开放申购"、"暂停申购"、"限制大额申购"）
 */
export async function setFundNav(
  fundCode: string,
  navDate: Date,
  nav: number,
  cumNav?: number | null,
  name?: string | null,
  sgzt?: string | null,
  purchaseLimit?: number | null
): Promise<void> {
  await prisma.fundNavCache.upsert({
    where: { fundCode_navDate: { fundCode, navDate } },
    create: { fundCode, navDate, nav, cumNav, name, sgzt, purchaseLimit },
    update: { nav, cumNav, name, sgzt, purchaseLimit },
  });
}

/**
 * 批量更新净值（用于事务内）
 *
 * @param tx Prisma事务客户端
 * @param fundCode 基金代码
 * @param navDate 净值日期（必须用 utcDate 构造，确保 T00:00:00Z）
 * @param nav 单位净值
 * @param cumNav 累计净值（可选）
 * @param name 基金名称（可选）
 * @param sgzt 申购状态（可选）
 */
export async function setFundNavInTx(
  tx: any,
  fundCode: string,
  navDate: Date,
  nav: number,
  cumNav?: number | null,
  name?: string | null,
  sgzt?: string | null
): Promise<void> {
  await tx.fundNavCache.upsert({
    where: {
      fundCode_navDate: {
        fundCode,
        navDate,
      },
    },
    create: {
      fundCode,
      navDate,
      nav,
      cumNav,
      name,
      sgzt,
    },
    update: {
      nav,
      cumNav,
      name,
      sgzt,
    },
  });
}

/**
 * 查询基金最新净值
 * 从 FundNavCache 表查询最新的净值记录
 *
 * @param fundCode 基金代码
 * @returns 最新净值信息或 null
 */
export async function getLatestFundNav(
  fundCode: string
): Promise<{ id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null } | null> {
  const record = await prisma.fundNavCache.findFirst({
    where: { fundCode },
    orderBy: { navDate: "desc" },
  });

  if (!record) return null;

  return {
    id: record.id,
    nav: Number(record.nav),
    cumNav: record.cumNav ? Number(record.cumNav) : null,
    navDate: record.navDate,
    name: record.name,
  };
}

/**
 * Refresh the latest available NAV for a fund and persist it through FundNavCache.
 *
 * This is intended for mobile/background daily sync. It deliberately asks the
 * configured fund API for the latest available trading-day NAV without using
 * the phone's local date as business truth. The API result's own date is used
 * as the cache key.
 */
export async function refreshLatestFundNav(
  fundCode: string,
): Promise<{ id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null } | null> {
  const apiData = await queryFundNav(fundCode);
  if (!apiData?.date || !Number.isFinite(apiData.nav)) return getLatestFundNav(fundCode);

  const navDate = utcDate(apiData.date);
  await setFundNav(
    fundCode,
    navDate,
    apiData.nav,
    apiData.cumNav ?? null,
    apiData.name ?? null,
  );

  return getLatestFundNav(fundCode);
}
