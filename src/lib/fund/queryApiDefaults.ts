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
    code: "eastmoney_history",
    name: "东方财富历史净值",
    baseUrl:
      "http://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=5&startDate={date}&endDate={date}",
    priority: 1,
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

/**
 * 已经整体下线、不该再参与取数的默认源（`code → 旧地址清单`）。
 *
 * 「天天基金」的实时估值 `fundgz.1234567.com.cn/js/{code}.js` 与估值频道一起下架了：
 * 地址本身还解析得到（HTTP 200），返回的却是那页固定的「页面未找到」HTML，
 * `api.fund.eastmoney.com/FundGuZhi/GetFundGZDetail` 也回 `ErrCode 4`，
 * `pingzhongdata/{code}.js` 里连 `gztime/gszzl` 字段都消失了。
 *
 * 所以新装库不再创建这条源；老库里地址仍是旧值的行被自动停用（用户自己改过地址的
 * 不动，改过就说明他知道自己在配什么）。停用而不是删除：留着让用户在设置页里看得见
 * 「这条是干什么的、为什么停了」，想换成别的地址也能直接改。
 *
 * 实时估值下线后，「最新净值」完全由 `{date}` 型源（`eastmoney_history`）承担：
 * 生产入口 `refreshLatestFundNav` 会先按交易日历算到「19:00 前算上一交易日」再查，
 * 查不到时 `queryFundNav` 还会用区间兜底取最近一个交易日的净值，不再依赖任何实时接口。
 */
export const RETIRED_DEFAULT_FUND_QUERY_APIS: Record<string, string[]> = {
  eastmoney: [
    "http://fundgz.1234567.com.cn/js/{code}.js",
    "https://fundgz.1234567.com.cn/js/{code}.js",
  ],
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
  const retirements = Object.entries(RETIRED_DEFAULT_FUND_QUERY_APIS).flatMap(([code, baseUrls]) =>
    baseUrls.map((baseUrl) =>
      prisma.fundQueryApi.updateMany({
        where: { code, baseUrl },
        data: { isActive: false },
      }),
    ),
  );
  const operations = [...updates, ...retirements];
  if (operations.length > 0) await prisma.$transaction(operations);
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

const REPAIR_RETRY_MS = 60_000;
let repairDone = false;
let repairInFlight: Promise<void> | null = null;
let repairRetryAfter = 0;

/**
 * 每次进程启动后的第一次净值查询，把「已下线 / 地址已失效的默认源」就地修一遍。
 *
 * `repairBrokenDefaultFundQueryApis` 原本只有两个入口：打开「设置 → 基金净值源」
 * 页面，或者 `FundQueryApi` 整表为空时的自愈。老库里四条源都在、用户也不会天天
 * 去点那个设置页，于是天天基金那条已经下线的实时估值源会一直显示「已启用」，
 * 无日期取数时还会白跑一次必然失败的请求，占掉一个候选名额。
 * 这里补上查询侧的入口：进程内只做一次，并发合并，失败后隔一分钟再试（失败通常
 * 意味着数据库暂时不可用，本来也取不到净值，但不能因此永久放弃修复）。
 */
export async function repairDefaultFundQueryApisOnce(): Promise<void> {
  if (repairDone) return;
  if (repairInFlight) return repairInFlight;
  if (Date.now() < repairRetryAfter) return;

  repairInFlight = (async () => {
    try {
      await repairBrokenDefaultFundQueryApis();
      repairDone = true;
    } catch {
      repairRetryAfter = Date.now() + REPAIR_RETRY_MS;
    } finally {
      repairInFlight = null;
    }
  })();

  return repairInFlight;
}

/**
 * 让下一次净值查询重新做一遍默认源修复。
 *
 * 恢复备份后必须调用：备份是按行原样导出的（含 `isActive`），从升级前的备份恢复会把
 * 那条已下线的实时估值源又写成 active，而 `repairDone` 是进程级的，不清就等于它要
 * 复活到下次进程重启。
 *
 * 正好有一次修复在飞时不打断它（它会覆盖本次重置），代价是这一次恢复后的死源要等到
 * 下次进程启动才被清掉——窗口只有进程首查的几百毫秒，比在这里维护一个 pending 状态
 * 更划算。
 */
export function resetDefaultFundQueryApiRepair(): void {
  if (repairInFlight) return;
  repairDone = false;
  repairRetryAfter = 0;
}
