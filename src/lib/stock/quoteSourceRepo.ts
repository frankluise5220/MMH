import { decrypt, getOrCreateMasterKey, isEncrypted } from "@/lib/auth/encrypt";
import { prisma } from "@/lib/db/prisma";
import {
  EASTMONEY_KLINE_PARSER,
  STOCK_JSON_PARSER,
  TENCENT_KLINE_PARSER,
  buildQuoteRequestUrls,
  isKnownStockQuoteParser,
  normalizeStockQuoteJsonConfig,
  parseQuoteRows,
  parserCodeOf,
  type QuoteFetchResult,
  type QuoteTarget,
  type StockQuoteApiConfig,
} from "@/lib/stock/quoteSource";

/**
 * 内置的股票行情源。
 *
 * 与 `FundQueryApi` 的默认源一样由查询侧自愈补齐：新装库、恢复备份、或用户从没打开过
 * 设置页时这张表是空的，取价会直接返回 null。默认源落库（builtin=true）而不是写死在
 * 代码里，是为了让用户能看到、能停用、能调优先级。
 */
export const DEFAULT_STOCK_QUOTE_APIS = [
  {
    code: EASTMONEY_KLINE_PARSER,
    name: "东方财富 · K线",
    // 东财 K 线三个市场同一套报文（secid 前缀不同，由 {secid} 占位符承载），
    // 所以内置源不限制市场，A 股 / 港股 / 美股共用。
    market: "*",
    parser: EASTMONEY_KLINE_PARSER,
    // 不带 beg 时服务端返回 end 之前最近的 N 条；带 beg 才有区间。
    // 单日查询由调用方把 dateStart 往前推若干天，所以这里可以安全地同时给 beg/end。
    baseUrl:
      "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}" +
      "&fields1=f1,f2,f3,f4,f5,f6" +
      "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
      "&klt=101&fqt=1&beg={dateStartCompact}&end={dateCompact}&lmt=100000",
    priority: 1,
    builtin: true,
  },
  {
    code: TENCENT_KLINE_PARSER,
    name: "腾讯行情 · 前复权日线",
    market: "*",
    parser: TENCENT_KLINE_PARSER,
    baseUrl:
      "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get" +
      "?param={exchangeLower}{code},day,{dateStart},{date},640,qfq",
    priority: 2,
    builtin: true,
  },
] as const;

const ENSURE_RETRY_MS = 60_000;
let lastEnsuredAt = 0;
let ensureInFlight: Promise<void> | null = null;

export async function ensureDefaultStockQuoteApis(): Promise<void> {
  await prisma.$transaction(
    DEFAULT_STOCK_QUOTE_APIS.map((api) =>
      prisma.stockQuoteApi.upsert({
        where: { code: api.code },
        create: { ...api },
        // 老库里的内置源是 market="CN"（当时只支持 A 股），升级后必须放开到 "*"，
        // 否则港股 / 美股取价会因为市场过滤一条源都匹配不到。其余字段仍然是 update: {}
        // 的语义（用户改过的地址、优先级、启停都不动）。
        update: { market: api.market },
      }),
    ),
  );
}

/** 查询侧使用的节流版本：一个进程最多每分钟补一次默认源。 */
export async function ensureDefaultStockQuoteApisThrottled(): Promise<void> {
  if (ensureInFlight) return ensureInFlight;
  if (Date.now() - lastEnsuredAt < ENSURE_RETRY_MS) return;

  ensureInFlight = (async () => {
    try {
      await ensureDefaultStockQuoteApis();
      lastEnsuredAt = Date.now();
    } catch {
      lastEnsuredAt = 0;
    } finally {
      ensureInFlight = null;
    }
  })();
  return ensureInFlight;
}

/** 恢复备份后必须清掉节流时间戳，否则内置源要等到下次进程重启才被补回。 */
export function resetStockQuoteApiEnsureThrottle(): void {
  lastEnsuredAt = 0;
}

export async function getActiveStockQuoteApis(
  market: string,
  householdId?: string | null,
): Promise<StockQuoteApiConfig[]> {
  const where = {
    isActive: true,
    market: { in: [market, "*"] },
    ...(householdId
      ? { OR: [{ householdId }, { householdId: null }] }
      : { householdId: null }),
  };

  let rows = await prisma.stockQuoteApi.findMany({
    where,
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  if (rows.length === 0) {
    await ensureDefaultStockQuoteApisThrottled();
    rows = await prisma.stockQuoteApi.findMany({
      where,
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  }

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    market: row.market,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    parser: row.parser,
    parserConfig: row.parserConfig,
    priority: row.priority,
    isActive: row.isActive,
    builtin: row.builtin,
    householdId: row.householdId,
  }));
}

const STOCK_QUOTE_FETCH_TIMEOUT_MS = Number(
  process.env.STOCK_QUOTE_API_FETCH_TIMEOUT_MS ?? 10_000,
);

/** 测试连接回显报文时的截断长度；解析始终基于完整 text。 */
const QUOTE_RAW_PREVIEW_LIMIT = 4_000;

async function resolveApiKey(raw: string | null | undefined): Promise<string> {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value, await getOrCreateMasterKey());
  } catch {
    return "";
  }
}

function applyAuth(
  config: ReturnType<typeof normalizeStockQuoteJsonConfig>,
  apiKey: string,
  url: string,
  headers: Record<string, string>,
): { url: string; headers: Record<string, string> } {
  if (!config || !apiKey || config.authIn === "none" || !config.authName) {
    return { url, headers };
  }
  if (config.authIn === "header") {
    return { url, headers: { ...headers, [config.authName]: `${config.authPrefix}${apiKey}` } };
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(config.authName, apiKey);
    return { url: parsed.toString(), headers };
  } catch {
    return { url, headers };
  }
}

/** 请求一条源并解析。返回的 rows 已按日期升序，可能跨多个交易日。 */
export async function fetchQuoteRows(
  api: StockQuoteApiConfig,
  target: QuoteTarget,
): Promise<QuoteFetchResult> {
  const parser = parserCodeOf(api);
  if (!isKnownStockQuoteParser(parser)) {
    return { ok: false, outcome: "parse_error", message: `未知的解析器：${parser}` };
  }

  const jsonConfig =
    parser === STOCK_JSON_PARSER ? normalizeStockQuoteJsonConfig(api.parserConfig) : null;
  if (parser === STOCK_JSON_PARSER && !jsonConfig) {
    return { ok: false, outcome: "parse_error", message: "解析配置不是合法的 JSON 对象" };
  }

  const urls = buildQuoteRequestUrls(api, target);
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  };
  if (parser === EASTMONEY_KLINE_PARSER) headers.Referer = "https://quote.eastmoney.com/";
  const apiKey = await resolveApiKey(api.apiKey);

  // 美股代码里没有交易所信息，同一模板会展开成多个候选地址（东财 105/106/107，
  // 腾讯 .OQ/.N/.A），按顺序试，第一个取到收盘价的胜出。
  let lastFailure: QuoteFetchResult = { ok: false, outcome: "empty" };
  for (const url of urls) {
    const request = applyAuth(jsonConfig, apiKey, url, headers);
    try {
      const response = await fetch(request.url, {
        headers: request.headers,
        cache: "no-store",
        signal: AbortSignal.timeout(STOCK_QUOTE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        lastFailure = { ok: false, outcome: "http_error", status: response.status };
        continue;
      }
      const text = await response.text();
      // 只给测试连接回显用；解析始终基于完整报文，避免长报文被截断后 JSON.parse 失败。
      const raw = text.slice(0, QUOTE_RAW_PREVIEW_LIMIT);

      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        // 部分接口把 JSON 包在 JS 片段里（jsonp / var x = {...}）。
        const match = text.match(/\{[\s\S]+\}/);
        if (!match) {
          lastFailure = { ok: false, outcome: "parse_error", message: "返回内容不是 JSON", raw };
          continue;
        }
        try {
          data = JSON.parse(match[0]);
        } catch {
          lastFailure = { ok: false, outcome: "parse_error", message: "返回内容不是合法 JSON", raw };
          continue;
        }
      }

      const rows = parseQuoteRows(data, parser, target, jsonConfig);
      if (!rows) {
        lastFailure = { ok: false, outcome: "empty", raw };
        continue;
      }
      return { ok: true, rows, raw };
    } catch (error) {
      lastFailure = {
        ok: false,
        outcome: "network_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return lastFailure;
}
