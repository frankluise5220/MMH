import { prisma } from "@/lib/db/prisma";
import { fetchHistoricalNavList } from "@/lib/fund/navCache";
import { logger } from "@/lib/logger";

/**
 * 货币基金「每万份收益」的存取。
 *
 * 为什么单独一张表：货基按面值 1 元/份核算，净值恒为 1，真正的收益数据是每日万份收益。
 * 历史上它被写进 FundNavCache.nav，导致下游把它当净值乘份额（issue #26）。
 * 这里把语义固定下来：incomePer10k 的单位是「元/万份」，任何地方都不能拿它当净值。
 */

export type MoneyFundYieldRow = {
  date: string;
  incomePer10k: number;
};

function ymdToDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** 自然日平移（只做 UTC 日历运算，不涉及时区换算）。 */
export function shiftYmd(ymd: string, days: number): string {
  const date = ymdToDate(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 批量写入/更新万份收益（按 fundCode + 日期幂等）。 */
export async function upsertMoneyFundYields(
  fundCode: string,
  rows: readonly MoneyFundYieldRow[],
  source = "eastmoney_history",
): Promise<number> {
  const data = rows
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(row.incomePer10k))
    .map((row) => ({
      fundCode,
      yieldDate: ymdToDate(row.date),
      incomePer10k: row.incomePer10k,
      source,
    }));
  if (data.length === 0) return 0;
  await prisma.$transaction(
    data.map((row) =>
      prisma.moneyFundYield.upsert({
        where: { fundCode_yieldDate: { fundCode: row.fundCode, yieldDate: row.yieldDate } },
        create: row,
        update: { incomePer10k: row.incomePer10k, source: row.source },
      }),
    ),
  );
  return data.length;
}

/** 读取指定区间的万份收益（键为 YYYY-MM-DD）。 */
export async function loadMoneyFundYieldMap(
  fundCode: string,
  fromYmd: string,
  toYmd: string,
): Promise<Map<string, number>> {
  const rows = await prisma.moneyFundYield.findMany({
    where: { fundCode, yieldDate: { gte: ymdToDate(fromYmd), lte: ymdToDate(toYmd) } },
    select: { yieldDate: true, incomePer10k: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.yieldDate.toISOString().slice(0, 10), Number(row.incomePer10k));
  }
  return map;
}

/**
 * 保证区间内的万份收益可用：先读库，缺口回源一次并落库。
 *
 * 落库后同一区间不再重复请求外部接口，历史回补与离线重放都只依赖本地数据。
 */
export async function ensureMoneyFundYieldRange(
  fundCode: string,
  fromYmd: string,
  toYmd: string,
): Promise<Map<string, number>> {
  const cached = await loadMoneyFundYieldMap(fundCode, fromYmd, toYmd);
  const latestCached = [...cached.keys()].sort().pop();
  // 区间末尾附近已有数据就认为这段已同步；非交易日会让末尾空几天，留 4 天余量。
  if (latestCached && latestCached >= shiftYmd(toYmd, -4)) return cached;

  try {
    const rows = await fetchHistoricalNavList(fundCode, fromYmd, toYmd);
    const fetched: MoneyFundYieldRow[] = rows
      .filter((row) => row.date >= fromYmd && row.date <= toYmd && Number.isFinite(row.nav))
      .map((row) => ({ date: row.date, incomePer10k: row.nav }));
    const missing = fetched.filter((row) => !cached.has(row.date));
    if (missing.length > 0) await upsertMoneyFundYields(fundCode, missing);
    const merged = new Map(cached);
    for (const row of fetched) merged.set(row.date, row.incomePer10k);
    return merged;
  } catch (error) {
    logger.warn(`Money fund yield fetch failed: ${fundCode}`, "money-fund-yield", error);
    return cached;
  }
}

/** 最近一条万份收益（给资料页/持仓页展示用）。 */
export async function getLatestMoneyFundYield(
  fundCode: string,
): Promise<{ date: string; incomePer10k: number } | null> {
  const row = await prisma.moneyFundYield.findFirst({
    where: { fundCode },
    orderBy: { yieldDate: "desc" },
    select: { yieldDate: true, incomePer10k: true },
  });
  if (!row) return null;
  return { date: row.yieldDate.toISOString().slice(0, 10), incomePer10k: Number(row.incomePer10k) };
}
