import { prisma } from "@/lib/db/prisma";

/**
 * 内置的基金净值查询源。
 *
 * `FundQueryApi` 是全局表（`householdId` 为 null 的行对所有账本可见），但历史实现
 * 只在「设置 → 基金净值源」的 GET 里懒创建。结果：新装库、恢复备份后全局表被清、
 * 或全新账本只要用户没打开过那个设置页，整表就是空的 —— `queryFundNav` 拿不到任何
 * 数据源会直接返回 null，净值缓存表永远不会写入，界面只能提示「未找到基金代码 X 的
 * 净值」。查询侧必须也能自愈，所以默认源抽到这里，两个入口共用。
 */
export const DEFAULT_FUND_QUERY_APIS = [
  {
    code: "eastmoney",
    name: "天天基金",
    baseUrl: "http://fundgz.1234567.com.cn/js/{code}.js",
    priority: 1,
    isActive: true,
  },
  {
    code: "eastmoney_history",
    name: "东方财富历史净值",
    baseUrl:
      "http://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=5&startDate={date}&endDate={date}",
    priority: 2,
    isActive: true,
  },
  {
    code: "danjuan",
    name: "蛋卷基金",
    baseUrl: "https://danjuanfunds.com/djapi/fund/{code}",
    priority: 3,
    isActive: false,
  },
  {
    code: "alipay",
    name: "支付宝基金",
    baseUrl: "https://fundmobapi.alipay.com/fund/v1/fund/detail?fundCode={code}",
    priority: 5,
    isActive: false,
  },
] as const;

/** 旧版本写进库里的、已经失效的默认地址（升级时原地修回）。 */
export const BROKEN_DEFAULT_BASE_URLS: Record<string, string[]> = {
  alipay: ["https://fundapi.eastmoney.com/fundapi/{code}/nav"],
};

export async function ensureDefaultFundQueryApis(): Promise<void> {
  await prisma.$transaction(
    DEFAULT_FUND_QUERY_APIS.map((api) =>
      prisma.fundQueryApi.upsert({
        where: { code: api.code },
        create: { ...api },
        update: {},
      }),
    ),
  );
}

export async function repairBrokenDefaultFundQueryApis(): Promise<void> {
  const updates = DEFAULT_FUND_QUERY_APIS.flatMap((api) =>
    (BROKEN_DEFAULT_BASE_URLS[api.code] ?? []).map((baseUrl) =>
      prisma.fundQueryApi.updateMany({
        where: { code: api.code, baseUrl },
        data: { baseUrl: api.baseUrl },
      }),
    ),
  );
  if (updates.length > 0) await prisma.$transaction(updates);
}

const ENSURE_RETRY_MS = 60_000;
let lastEnsuredAt = 0;
let ensureInFlight: Promise<void> | null = null;

/**
 * 查询侧使用的节流版本：只有 `getActiveApis()` 返回空时才会走到这里，
 * 一个进程最多每分钟补一次默认源，避免批量导入时每行都开一次 upsert 事务。
 */
export async function ensureDefaultFundQueryApisThrottled(): Promise<void> {
  if (ensureInFlight) return ensureInFlight;
  if (Date.now() - lastEnsuredAt < ENSURE_RETRY_MS) return;

  ensureInFlight = (async () => {
    try {
      await ensureDefaultFundQueryApis();
      await repairBrokenDefaultFundQueryApis();
      lastEnsuredAt = Date.now();
    } catch {
      // 并发插入撞唯一键或数据库暂时不可用都不应让净值查询直接报错，
      // 失败后清零时间戳，下一次查询再试。
      lastEnsuredAt = 0;
    } finally {
      ensureInFlight = null;
    }
  })();

  return ensureInFlight;
}
