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

/** 列出 [fromYmd, toYmd] 的连续自然日（含两端）。 */
export function listYmdRange(fromYmd: string, toYmd: string): string[] {
  const days: string[] = [];
  let cursor = fromYmd;
  while (cursor <= toYmd) {
    days.push(cursor);
    cursor = shiftYmd(cursor, 1);
  }
  return days;
}

/** 把升序日期切成连续段，回源时按段请求，避免为一天的洞重拉整段历史。 */
function groupConsecutiveYmd(dates: readonly string[]): Array<{ from: string; to: string }> {
  const groups: Array<{ from: string; to: string }> = [];
  for (const date of dates) {
    const last = groups[groups.length - 1];
    if (last && shiftYmd(last.to, 1) === date) {
      last.to = date;
      continue;
    }
    groups.push({ from: date, to: date });
  }
  return groups;
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

/** `ensureMoneyFundYieldRange` 的结果，缺口语义见该函数的注释。 */
export type MoneyFundYieldRange = {
  /** 区间内可用的万份收益（键 YYYY-MM-DD）。 */
  yields: Map<string, number>;
  /** 区间内最终仍然没有万份收益的日期（升序）。 */
  missingDates: string[];
  /**
   * true = 有缺口且回源失败，缺的原因未知（网络/接口异常）。
   * 调用方绝不能把这种缺口当成「当天没有收益」跳过，否则游标越过缺口后那段收益
   * 永远算不回来。false = 缺口已被数据源确认（区间拉取成功但确实没有该日）。
   */
  unresolved: boolean;
};

/**
 * 保证区间内的万份收益可用：先读库，只对**逐日**真正缺失的日期回源。
 *
 * 旧实现只比对区间两头，中间有洞也会短路；而缺口一旦被重算跳过去（游标推进到
 * 批次末尾），之后连「重算收益结转」都补不回来，等于永久少结几天份额。
 * 现在改成逐日列缺口、按连续段回源（段前后各扩 2 天，照顾非交易日合并披露），
 * 并把回源失败与「数据源本来没有」区分开。
 */
export async function ensureMoneyFundYieldRange(
  fundCode: string,
  fromYmd: string,
  toYmd: string,
): Promise<MoneyFundYieldRange> {
  const merged = await loadMoneyFundYieldMap(fundCode, fromYmd, toYmd);
  const allDays = listYmdRange(fromYmd, toYmd);
  let missingDates = allDays.filter((day) => !merged.has(day));
  if (missingDates.length === 0) {
    return { yields: merged, missingDates, unresolved: false };
  }

  let fetchFailed = false;
  for (const gap of groupConsecutiveYmd(missingDates)) {
    // 段前后各扩 2 天：货基偶尔把周末/节假日的收益并到相邻日披露，只按缺口窗口
    // 请求会反复取不到，扩两天让接口能带回上下文。
    const requestFrom = shiftYmd(gap.from, -2);
    const requestTo = shiftYmd(gap.to, 2);
    try {
      const rows = await fetchHistoricalNavList(fundCode, requestFrom, requestTo);
      const fetched: MoneyFundYieldRow[] = rows
        .filter((row) => row.date >= fromYmd && row.date <= toYmd && Number.isFinite(row.nav))
        .map((row) => ({ date: row.date, incomePer10k: row.nav }));
      // 只补本地没有的日期：手工录入（source=manual）的值不能被接口回源覆盖。
      const toWrite = fetched.filter((row) => !merged.has(row.date));
      if (toWrite.length > 0) await upsertMoneyFundYields(fundCode, toWrite);
      for (const row of fetched) merged.set(row.date, row.incomePer10k);
    } catch (error) {
      fetchFailed = true;
      logger.warn(`Money fund yield fetch failed: ${fundCode} ${requestFrom}~${requestTo}`, "money-fund-yield", error);
    }
  }

  missingDates = allDays.filter((day) => !merged.has(day));
  if (missingDates.length > 0 && !fetchFailed) {
    // 区间拉取成功仍然没有的日期＝数据源没披露（东财 lsjz 覆盖成立以来的每个自然日），
    // 可以安全跳过；但不能静默，日志留痕方便事后核对。
    logger.info(
      `Money fund yield has ${missingDates.length} day(s) without data: ${fundCode} ${missingDates[0]}~${missingDates[missingDates.length - 1]}`,
      "money-fund-yield",
    );
  }
  return { yields: merged, missingDates, unresolved: fetchFailed && missingDates.length > 0 };
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
