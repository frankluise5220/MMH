/**
 * Unified fund NAV query entry point.
 *
 * Two calling modes:
 * 1. Query latest NAV: omit dateStr → try up to three APIs by priority and return the latest available NAV
 * 2. Query a specific date: pass dateStr → only use APIs that support date filtering (baseUrl contains the {date} placeholder),
 *    skipping APIs without date filtering (e.g. eastmoney realtime estimate) to avoid returning a NAV for the wrong date
 *
 * @param fundCode Fund code
 * @param dateStr NAV date (YYYY-MM-DD); omit to query the latest
 * @param accountId Fund account ID (optional, used for the account-level default API)
 * @returns NAV info or null
 */
import { prisma } from "@/lib/db/prisma";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import {
  ensureDefaultFundQueryApisThrottled,
  repairDefaultFundQueryApisOnce,
} from "@/lib/fund/queryApiDefaults";
import { getOrCreateMasterKey, decrypt, isEncrypted } from "@/lib/auth/encrypt";
import {
  normalizeFundJsonParserConfig,
  parseFundJsonNav,
  parseNavDate,
  parseNavNumber,
  validateFundJsonParserConfig,
  type FundJsonParserConfig,
  type NavParseContext,
} from "@/lib/fund/json-parser";

type NavResult = {
  nav: number;
  cumNav?: number;
  name?: string;
  date: string;
} | null;

/** 按返回报文解析净值的函数；`ctx` 只给需要按目标日挑选的源用（区间型 JSON 源）。 */
type NavParser = (data: any, ctx: NavParseContext) => NavResult;

type FundQueryApiConfig = {
  id: string;
  code: string;
  /** 解析器标识；为空时沿用 `code`（兼容 `code` 就是解析器的存量数据）。 */
  parser: string | null;
  /** 仅 `parser = "json"` 的源使用：字段路径与鉴权方式。 */
  parserConfig: unknown;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  priority: number;
  isActive: boolean;
  householdId: string | null;
};

/** 配置驱动的 JSON 源的解析器标识。 */
export const CUSTOM_JSON_PARSER = "json";

type FundIdentityResult = {
  code: string;
  name: string;
  fullName?: string;
  source: string;
} | null;

/**
 * 取净值失败时的诊断信息。
 *
 * 以前所有失败都只回一句「未找到基金代码 X 的净值，请确认代码是否正确」，无法区分
 * 「一个源都没配」「配置的源都不支持指定日期」「源全部报错」——排查时只能猜。
 * 调用方传一个空对象进来，queryFundNav 会把它填成可读的失败路径。
 */
export type FundNavQueryAttempt = {
  code: string;
  host: string;
  outcome: "ok" | "http_error" | "network_error" | "parse_error" | "empty";
  status?: number;
  message?: string;
};

export type FundNavQueryDiagnostics = {
  reason?: "NO_QUERY_API" | "NO_MATCHING_API" | "ALL_FAILED";
  activeApis?: number;
  candidateApis?: string[];
  attempts?: FundNavQueryAttempt[];
  fallback?: "ok" | "empty" | "skipped";
};

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.split("/")[0] ?? url;
  }
}

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "http://fundf10.eastmoney.com/",
};

const MAX_FUND_QUERY_API_ATTEMPTS = 3;

/**
 * 不带日期取「最新净值」时，`{date}` 型源从业务今天起往前回退几天。
 *
 * 2026-11 天天基金的实时估值接口随估值频道一起下线后，`{date}` 型源成了取最新
 * 净值的唯一路径；但「今天」在 15:00 前、周末和节假日都还没有净值，把业务今天
 * 直接填进去会稳定拿到空列表（以前的实现干脆不替换占位符，URL 里留着 `{date}`
 * 字面量，必然失败）。6 天足够覆盖一个周末加一两天短假。
 */
const LATEST_NAV_LOOKBACK_DAYS = 6;

/**
 * 回退阶段的总请求预算。
 *
 * 每个日期一次 HTTP，最长 8s 超时：6 天 × N 个源全超时能把批量导入拖到几分钟。
 * 命中通常发生在第 1~3 天，所以给一个硬上限，用完就认定这些源都拿不到最新净值。
 */
const LATEST_NAV_MAX_DATED_REQUESTS = 8;

/**
 * 单次净值请求的超时。
 *
 * 这些接口是第三方站点，没有超时的 `fetch` 会一直挂在 socket 上（undici 默认
 * headersTimeout 300s）：批量导入时一行一次、一次最多试 3 个接口，任何一家抽风
 * 都会让「预览」几分钟出不来。宁可放弃这一行（净值留空让用户补），也不要拖住整批。
 */
const NAV_FETCH_TIMEOUT_MS = 8_000;

/** 一条源实际使用的解析器标识：新数据看 `parser`，存量数据回退到 `code`。 */
function parserCodeOf(api: Pick<FundQueryApiConfig, "code" | "parser">): string {
  return (api.parser ?? api.code ?? "").trim();
}

/** 只有 `parser = "json"` 的源才有配置；其余返回 null，走代码里的内置解析器。 */
function jsonConfigOf(
  api: Pick<FundQueryApiConfig, "code" | "parser" | "parserConfig">,
): FundJsonParserConfig | null {
  if (parserCodeOf(api) !== CUSTOM_JSON_PARSER) return null;
  return normalizeFundJsonParserConfig(api.parserConfig);
}

/**
 * 库里的 key 是密文（新写入的）或明文（2026-11 之前写入的），取数时才解密。
 * 解密失败按「没配 key」处理：源可能因此返回 401，但那比抛错让整批导入失败好。
 */
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

function buildRequestHeaders(
  config: FundJsonParserConfig | null,
  apiKey: string,
): Record<string, string> {
  const result: Record<string, string> = { ...headers };
  if (config && config.authIn === "header" && config.authName && apiKey) {
    result[config.authName] = `${config.authPrefix}${apiKey}`;
  }
  return result;
}

/** key 走 URL 参数时用；地址不是合法 URL 就原样返回，不因为鉴权把请求搞坏。 */
function appendQueryParam(url: string, name: string, value: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set(name, value);
    return parsed.toString();
  } catch {
    return url;
  }
}

type SourceFetchResult = {
  result: NavResult;
  /** 原始报文前若干字符，仅「测试连接」回显用。 */
  raw?: string;
};

const RAW_PREVIEW_LIMIT = 4_000;

async function fetchUrl(
  api: FundQueryApiConfig,
  url: string,
  parser: NavParser,
  ctx: NavParseContext,
  onOutcome?: (outcome: { outcome: FundNavQueryAttempt["outcome"]; status?: number; message?: string }) => void,
): Promise<SourceFetchResult> {
  const config = jsonConfigOf(api);

  let requestUrl = url;
  let requestHeaders: Record<string, string> = { ...headers };
  if (config) {
    const apiKey = await resolveApiKey(api.apiKey);
    if (apiKey && config.authIn === "header" && config.authName) {
      requestHeaders = buildRequestHeaders(config, apiKey);
    } else if (apiKey && config.authIn === "query" && config.authName) {
      requestUrl = appendQueryParam(requestUrl, config.authName, apiKey);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAV_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(requestUrl, {
      headers: requestHeaders,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      onOutcome?.({ outcome: "http_error", status: res.status });
      return { result: null };
    }
    const text = await res.text();
    const raw = text.slice(0, RAW_PREVIEW_LIMIT);
    let data: any;
    try { data = JSON.parse(text); } catch {
      // Tiantian Fund returns data in JS format
      const m = text.match(/\{.+\}/);
      if (!m) {
        onOutcome?.({ outcome: "parse_error", message: "no json payload in response" });
        return { result: null, raw };
      }
      try { data = JSON.parse(m[0]); } catch {
        onOutcome?.({ outcome: "parse_error", message: "invalid json payload" });
        return { result: null, raw };
      }
    }
    const result = parser(data, ctx);
    onOutcome?.({ outcome: result ? "ok" : "empty" });
    return { result, raw };
  } catch (error) {
    onOutcome?.({
      outcome: "network_error",
      message: error instanceof Error ? error.message : String(error),
    });
    return { result: null };
  } finally {
    clearTimeout(timer);
  }
}

// eastmoney parser — latest NAV (Tiantian Fund)
function parseEastmoney(data: any): NavResult {
  if (!data?.dwjz) return null;
  return {
    date: data.jzrq as string,
    nav: parseFloat(data.dwjz),
    cumNav: parseFloat(data.dwjz),
    name: data.name as string,
  };
}

/**
 * eastmoney_history parser — historical NAVs (Eastmoney)
 * Supports parsing multiple records to find the NAV closest to a target date.
 */
function parseEastmoneyHistoryList(data: any): { FSRQ: string; DWJZ: string; LJJZ: string }[] {
  return data?.Data?.LSJZList ?? [];
}

function parseEastmoneyHistory(data: any): NavResult {
  const list = parseEastmoneyHistoryList(data);
  if (list.length > 0) {
    return {
      date: list[0]!.FSRQ,
      nav: parseFloat(list[0]!.DWJZ),
      cumNav: parseFloat(list[0]!.LJJZ),
    };
  }
  return null;
}

// danjuan parser — Danjuan Fund
function parseDanjuan(data: any): NavResult {
  if (!data?.data?.nav) return null;
  return {
    date: data.data.nav_date || "",
    nav: parseFloat(data.data.nav),
    cumNav: data.data.cum_nav ? parseFloat(data.data.cum_nav) : undefined,
    name: data.data.fund_name,
  };
}

function findValueByKeys(data: unknown, keys: string[], depth = 0): unknown {
  if (depth > 8 || data == null || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findValueByKeys(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const record = data as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") {
      return record[key];
    }
  }
  for (const value of Object.values(record)) {
    const found = findValueByKeys(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Alipay/Ant Fortune field names vary across API versions, so only read explicit NAV
// fields here instead of broadly guessing numbers.
function parseAlipay(data: any): NavResult {
  const nav = parseNavNumber(findValueByKeys(data, [
    "nav",
    "netValue",
    "unitNetValue",
    "fundNetValue",
    "dailyNetValue",
    "dwjz",
  ]));
  if (!nav) return null;

  const cumNav = parseNavNumber(findValueByKeys(data, [
    "cumNav",
    "totalNetValue",
    "accumulatedNetValue",
    "accumulativeNetValue",
    "ljjz",
  ]));
  const date = parseNavDate(findValueByKeys(data, [
    "date",
    "navDate",
    "netValueDate",
    "statisticDate",
    "jzrq",
  ]));
  if (!date) return null;
  const name = normalizeFundName(findValueByKeys(data, [
    "name",
    "fundName",
    "fundShortName",
    "shortName",
  ]));

  return {
    date,
    nav,
    cumNav,
    name: name ?? undefined,
  };
}

function normalizeFundName(name: unknown): string | null {
  const value = String(name ?? "").trim();
  if (!value || value.length < 2) return null;
  if (/基金历史净值|基金档案|天天基金|基金吧|搜索结果/.test(value)) return null;
  return value;
}

export async function queryFundIdentity(fundCode: string): Promise<FundIdentityResult> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  try {
    const url = `http://fundf10.eastmoney.com/jjjz_${code}.html`;
    const res = await fetch(url, {
      headers: { ...headers, Referer: url },
      cache: "no-store",
    });
    if (res.ok) {
      const html = await res.text();
      const patterns = [
        /<title[^>]*>\s*([^<]*?)\s*[\uFF08(]\s*(\d{6})\s*[\uFF09)]/i,
        /<meta\s+name=["']keywords["']\s+content=["']([^,"']+),\s*(\d{6})[,"]/i,
        /<meta\s+name=["']description["']\s+content=["'][^"']*?提供([^("']+)[（(](\d{6})[）)]/i,
      ];
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match || match[2] !== code) continue;
        const name = normalizeFundName(match[1]);
        if (name) return { code, name, source: "eastmoney-f10" };
      }
    }
  } catch {
    // Try the next source.
  }

  try {
    const url = `https://danjuanfunds.com/djapi/fund/${code}`;
    const res = await fetch(url, {
      headers: {
        ...headers,
        Referer: `https://danjuanfunds.com/fund/${code}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const data: any = await res.json();
      const fdCode = String(data?.data?.fd_code ?? data?.fd_code ?? "").trim();
      if (fdCode === code) {
        const name = normalizeFundName(data?.data?.fd_name ?? data?.fd_name);
        if (name) {
          const fullName = normalizeFundName(data?.data?.fd_full_name ?? data?.fd_full_name) ?? undefined;
          return { code, name, fullName, source: "danjuan" };
        }
      }
    }
  } catch {
    // No identity result.
  }

  return null;
}

const PARSERS: Record<string, NavParser> = {
  eastmoney: parseEastmoney,
  eastmoney_history: parseEastmoneyHistory,
  danjuan: parseDanjuan,
  alipay: parseAlipay,
};

/**
 * 一条源最终用哪个解析器。
 *
 * `json` 是配置驱动的那一类：拿库里的 `parserConfig` 现编一个解析器，配置缺字段
 * 时返回 null（宁可这条源不参与取数，也不要每条净值都解析失败刷一堆诊断）。
 * 其余按标识查表；查不到（例如存量数据里手填的 `sina`）也返回 null。
 */
function resolveParser(
  api: Pick<FundQueryApiConfig, "code" | "parser" | "parserConfig">,
): NavParser | null {
  const code = parserCodeOf(api);
  if (code === CUSTOM_JSON_PARSER) {
    const config = jsonConfigOf(api);
    if (!config || validateFundJsonParserConfig(config).length > 0) return null;
    return (data, ctx) => {
      const value = parseFundJsonNav(data, config, ctx);
      if (!value) return null;
      return {
        date: value.date,
        nav: value.nav,
        cumNav: value.cumNav,
        name: normalizeFundName(value.name) ?? undefined,
      };
    };
  }
  return PARSERS[code] ?? null;
}

/**
 * 这条源能不能按指定日期取净值。
 *
 * 地址里有 `{date}` 直接算支持；`series` 模式的 JSON 源一次拿一段序列、自己从中
 * 挑目标日，地址里没有占位符也算支持。其余（只能取最新净值的源）在「按确认日取
 * 净值」时必须跳过，否则会把今天的净值记到历史确认日上。
 */
function apiSupportsDate(api: FundQueryApiConfig): boolean {
  if (api.baseUrl.includes("{date}")) return true;
  return jsonConfigOf(api)?.dateMode === "series";
}

/**
 * 占位符替换。`{code}` 会被拼上配置里的后缀（同花顺一类的 `thscode` 要求
 * `000001.SZ` 这种带市场后缀的写法），内置源没有配置，行为与以前一致。
 */
function buildRequestUrl(api: FundQueryApiConfig, fundCode: string, dateStr?: string): string {
  const config = jsonConfigOf(api);
  const code = `${fundCode}${config?.codeSuffix ?? ""}`;
  let url = api.baseUrl.replaceAll("{code}", code);
  if (dateStr) url = url.replaceAll("{date}", dateStr);
  return url;
}

type FundProfileResult = {
  code: string;
  name?: string;
  fundCompany?: string;
  custodian?: string;
  manager?: string;
  source: string;
} | null;

/**
 * Extract a labeled field from the fund overview page.
 * Provider link identifiers are not regulator-issued fund company codes, so
 * the parser returns display text only and ignores those identifiers.
 */
function extractLabeledField(html: string, label: string): { text: string } | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<th[^>]*>\\s*${escaped}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i");
  const m = html.match(re);
  if (!m) return null;
  const cell = m[1] ?? "";
  const text = cell.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  if (!text) return null;
  return { text };
}

/**
 * Fetch a fund profile from the Tiantian Fund overview page.
 * This is fund-level metadata, independent of the holding account.
 */
export async function queryFundProfile(fundCode: string): Promise<FundProfileResult> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  try {
    const url = `http://fundf10.eastmoney.com/jbgk_${code}.html`;
    const res = await fetch(url, {
      headers: { ...headers, Referer: url },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const html = await res.text();

    const fundCompany = extractLabeledField(html, "\u57FA\u91D1\u7BA1\u7406\u4EBA");
    const custodian = extractLabeledField(html, "\u57FA\u91D1\u6258\u7BA1\u4EBA");
    const manager = extractLabeledField(html, "\u57FA\u91D1\u7ECF\u7406\u4EBA");

    const titleMatch = html.match(/<title[^>]*>\s*([^<]*?)\s*[\uFF08(]\s*(\d{6})\s*[\uFF09)]/i);
    const name = titleMatch && titleMatch[2] === code ? normalizeFundName(titleMatch[1]) : undefined;

    if (!fundCompany && !custodian && !manager && !name) return null;

    return {
      code,
      name: name ?? undefined,
      fundCompany: fundCompany?.text,
      custodian: custodian?.text,
      manager: manager?.text,
      source: "eastmoney-f10",
    };
  } catch {
    return null;
  }
}
/**
 * Get all active query APIs (sorted by priority).
 */
async function getActiveApis(householdId?: string | null): Promise<FundQueryApiConfig[]> {
  return prisma.fundQueryApi.findMany({
    where: {
      isActive: true,
      ...(householdId
        ? { OR: [{ householdId }, { householdId: null }] }
        : {}),
    },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" },
    ],
  });
}

function moveApiToFront(apis: FundQueryApiConfig[], predicate: (api: FundQueryApiConfig) => boolean) {
  const selected = apis.find(predicate);
  if (!selected) return apis;
  return [selected, ...apis.filter((api) => api.id !== selected.id)];
}

function isAlipayInstitutionText(text: string) {
  return /支付宝|蚂蚁|Ant\s*Fortune|Alipay/i.test(text);
}

/**
 * Query historical NAVs (wider date range).
 * When an exact-date query fails, try querying NAVs around the target date and return the one closest to it.
 *
 * @param fundCode Fund code
 * @param targetDate Target date (YYYY-MM-DD)
 * @param rangeDays How many days to extend the range backward; defaults to 90 (covers a quarter)
 * @returns NAV info (including the actual NAV date) or null
 */
async function queryHistoricalNav(
  fundCode: string,
  targetDate: string,
  rangeDays: number = 90
): Promise<NavResult> {
  // Calculate the query range: from rangeDays before the target date to the target date
  const target = new Date(targetDate + "T00:00:00Z");
  const startDate = new Date(target.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const endDate = target;

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Query the eastmoney_history API (wider date range)
  const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=50&startDate=${startStr}&endDate=${endStr}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAV_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, cache: "no-store", signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return null; }

    const list = parseEastmoneyHistoryList(data);
    if (list.length === 0) return null;

    // Sort by date descending (newest first)
    const sortedList = list.sort((a, b) => new Date(b.FSRQ).getTime() - new Date(a.FSRQ).getTime());

    // Find the NAV on or before the target date (the confirmation date should not be later than the target date)
    const targetTime = target.getTime();
    for (const item of sortedList) {
      const itemDate = new Date(item.FSRQ + "T00:00:00Z");
      // Pick the NAV of the nearest trading day on or before the target date
      if (itemDate.getTime() <= targetTime) {
        return {
          date: item.FSRQ,
          nav: parseFloat(item.DWJZ),
          cumNav: parseFloat(item.LJJZ),
        };
      }
    }

    // If no NAV exists before the target date, return the closest one (the newest)
    const closest = sortedList[0];
    if (closest) {
      return {
        date: closest.FSRQ,
        nav: parseFloat(closest.DWJZ),
        cumNav: parseFloat(closest.LJJZ),
      };
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unified fund NAV query.
 * Prefers the account-configured default API; otherwise tries all active APIs by priority.
 */
export async function queryFundNav(
  fundCode: string,
  dateStr?: string,
  accountId?: string,
  diagnostics?: FundNavQueryDiagnostics,
): Promise<NavResult> {
  const attempts: FundNavQueryAttempt[] = [];
  if (diagnostics) {
    diagnostics.attempts = attempts;
    diagnostics.reason = undefined;
    diagnostics.fallback = undefined;
  }
  let account:
    | {
        defaultFundQueryApiId: string | null;
        householdId: string | null;
        Institution: { name: string; shortName: string | null; type: string | null } | null;
      }
    | null = null;
  if (accountId) {
    account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        defaultFundQueryApiId: true,
        householdId: true,
        Institution: { select: { name: true, shortName: true, type: true } },
      },
    });
  }

  // 老库里已经下线的默认源（天天基金实时估值）在进程首次查询时就地停用：
  // 留着它只会一直显示「已启用」，无日期取数时白跑一次必然失败的请求并占掉一个候选名额。
  await repairDefaultFundQueryApisOnce();

  // Get the list of active APIs
  let activeApis = await getActiveApis(account?.householdId);
  if (activeApis.length === 0) {
    // FundQueryApi 是全局表：新装库、恢复备份（backup 里没有全局源时会整表清空）、
    // 或用户从没打开过「设置 → 基金净值源」时它是空的。以前这种情况直接返回 null，
    // 一次外部请求都不发，净值缓存表永远为空，界面只会报「未找到基金代码 X 的净值」。
    await ensureDefaultFundQueryApisThrottled();
    activeApis = await getActiveApis(account?.householdId);
  }
  if (activeApis.length === 0) {
    if (diagnostics) diagnostics.reason = "NO_QUERY_API";
    return null;
  }
  if (diagnostics) diagnostics.activeApis = activeApis.length;

  // Priority: account default API > account institution scenario > global priority order
  let orderedApis = activeApis;
  if (account?.defaultFundQueryApiId) {
    orderedApis = moveApiToFront(orderedApis, (api) => api.id === account!.defaultFundQueryApiId);
  } else if (account?.Institution) {
    const institutionText = `${account.Institution.name} ${account.Institution.shortName ?? ""}`;
    if (isAlipayInstitutionText(institutionText)) {
      orderedApis = moveApiToFront(orderedApis, (api) => /alipay|支付宝|蚂蚁/i.test(`${api.code} ${api.name}`));
    }
  }

  // Try at most three valid APIs after account and institution priority rules are applied.
  const candidates = orderedApis
    .map((api) => ({ api, parser: resolveParser(api) }))
    .filter(
      (item): item is { api: FundQueryApiConfig; parser: NavParser } =>
        Boolean(item.parser) && (!dateStr || apiSupportsDate(item.api)),
    )
    .slice(0, MAX_FUND_QUERY_API_ATTEMPTS);
  const candidateApis = candidates.map((item) => item.api);

  if (diagnostics) {
    diagnostics.candidateApis = candidateApis.map((api) => `${api.code}@${urlHost(api.baseUrl)}`);
    if (candidateApis.length === 0) diagnostics.reason = "NO_MATCHING_API";
  }

  // 分两类：只能取最新净值的源（实时估值，地址里没有 `{date}`），和能按日期取数的源。
  const latestOnly = candidates.filter((item) => !apiSupportsDate(item.api));
  const datedOnly = candidates.filter((item) => apiSupportsDate(item.api));

  const requestCandidate = async (
    item: (typeof candidates)[number],
    requestDate?: string,
  ): Promise<{ result: NavResult; outcome: FundNavQueryAttempt["outcome"] }> => {
    const url = buildRequestUrl(item.api, fundCode, requestDate);
    let outcome: FundNavQueryAttempt["outcome"] = "empty";
    const { result } = await fetchUrl(item.api, url, item.parser, { targetDate: requestDate }, (info) => {
      outcome = info.outcome;
      attempts.push({ code: item.api.code, host: urlHost(url), ...info });
    });
    return { result, outcome };
  };

  // 实时估值这类「只能取最新净值」的源按地址原样试一次。
  for (const item of latestOnly) {
    const { result } = await requestCandidate(item);
    if (result) {
      if (diagnostics) diagnostics.reason = undefined;
      return result;
    }
  }

  if (dateStr) {
    for (const item of datedOnly) {
      const { result } = await requestCandidate(item, dateStr);
      if (result) {
        if (diagnostics) diagnostics.reason = undefined;
        return result;
      }
    }
  } else if (datedOnly.length > 0) {
    // 取「最新净值」= 业务今天起往前第一个有净值的交易日。
    // 以前这里把日期留空，`{date}` 不被替换，URL 里带着字面量发出去，这类源必然失败；
    // 实时估值接口下线后，它成了唯一可能命中的路径，必须真的按日期去查。
    const anchor = todayDateBusinessYmd();
    let budget = LATEST_NAV_MAX_DATED_REQUESTS;
    let anyRequest = false;
    for (const item of datedOnly) {
      for (let offset = 0; offset <= LATEST_NAV_LOOKBACK_DAYS && budget > 0; offset += 1) {
        budget -= 1;
        anyRequest = true;
        const { result, outcome } = await requestCandidate(item, shiftYmd(anchor, -offset));
        if (result) {
          if (diagnostics) {
            diagnostics.reason = undefined;
            diagnostics.fallback = "ok";
          }
          return result;
        }
        // 域名不通：同一条源换个日期也修不好网络，别让剩下的每一天都白等一次超时。
        if (outcome === "network_error") break;
      }
      if (budget <= 0) break;
    }
    if (diagnostics && anyRequest) diagnostics.fallback = "empty";
  }

  // 精准日查不到就一定要走区间兜底。
  //
  // 以前这里是 `candidateApis.length < MAX_FUND_QUERY_API_ATTEMPTS`（候选源不足 3 条才兜底），
  // 逻辑正好反了：用户把源配满 3 条，反而失去兜底 —— 而节假日、19:00 前这些
  // 「当天还没净值」的日期，区间兜底是唯一能拿到最近一个交易日净值的路径。
  if (dateStr) {
    const historicalResult = await queryHistoricalNav(fundCode, dateStr);
    if (diagnostics) diagnostics.fallback = historicalResult ? "ok" : "empty";
    if (historicalResult) return historicalResult;
  } else if (diagnostics && diagnostics.fallback === undefined) {
    diagnostics.fallback = "skipped";
  }

  if (diagnostics && diagnostics.reason === undefined) diagnostics.reason = "ALL_FAILED";

  return null;
}

export type FundApiProbeResult = {
  ok: boolean;
  code: string;
  fundCode: string;
  /** 实际请求的地址（占位符已替换），失败时也让用户看到到底请求了哪里 */
  url?: string;
  /** `{date}` 被替换成的日期（地址不含 `{date}` 时为空） */
  queriedDate?: string;
  nav?: number;
  cumNav?: number | null;
  navDate?: string;
  /** 失败原因码，前端据此选文案 */
  reason?:
    | "UNKNOWN_PARSER"
    | "MISSING_PLACEHOLDER"
    | "INVALID_FUND_CODE"
    | "INVALID_URL"
    | "CONFIG_INVALID"
    | "REQUEST_FAILED"
    | "NO_DATA";
  outcome?: FundNavQueryAttempt["outcome"];
  status?: number;
  message?: string;
  /** 解析配置本身的问题（`parser = "json"` 时）；有值时不必发请求。 */
  configErrors?: string[];
  /**
   * 原始报文的前若干字符。
   *
   * 自定义 JSON 源要用户自己填字段路径，不给看返回长什么样是配不出来的 ——
   * 失败时同样回显，「返回 200 但取不到值」才有可查的线索。
   */
  rawPreview?: string;
};

/** 探测默认用的基金代码：华夏成长，长期存续，任何源都该有这个代码。 */
const PROBE_FUND_CODE = "000001";
/** 含 `{date}` 的地址最多往前回退几天（够覆盖周末与短假）。 */
const PROBE_DATE_LOOKBACK_DAYS = 6;

function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 试算一条净值源：用真实基金代码发一次真实请求，回答「地址对不对 / 解析器认不认 / 拿到哪天多少净值」。
 *
 * 设置页新增源之前必须过这一关：解析器决定怎么拆返回内容，识别不出的源会被
 * `queryFundNav` 的候选源过滤掉，永远不参与取数，而界面上仍然显示「已启用」。
 * 自定义 JSON 源还需要看到原始报文才能填对字段路径，所以一并回显。
 */
export async function probeFundQueryApi(options: {
  code: string;
  /** 解析器标识；省略时沿用 `code`（兼容 `code` 就是解析器的存量数据）。 */
  parser?: string;
  parserConfig?: unknown;
  baseUrl: string;
  /** 用户刚输入的明文 key；库里存的密文也接受，取数时会先解密。 */
  apiKey?: string;
  fundCode?: string;
  /** 探测基准日（业务日期 YYYY-MM-DD，由调用方按账本时区算好）；支持按日期查询的源从这天起往前找最近一个有净值的交易日 */
  date: string;
}): Promise<FundApiProbeResult> {
  const code = options.code.trim();
  const baseUrl = options.baseUrl.trim();
  const fundCode = options.fundCode?.trim() || PROBE_FUND_CODE;
  const base: FundApiProbeResult = { ok: false, code, fundCode };
  const api: FundQueryApiConfig = {
    id: "probe",
    code,
    parser: (options.parser ?? code).trim() || null,
    parserConfig: options.parserConfig ?? null,
    name: "",
    baseUrl,
    apiKey: options.apiKey ?? null,
    priority: 0,
    isActive: true,
    householdId: null,
  };

  const parser = resolveParser(api);
  if (!parser) {
    const configErrors =
      parserCodeOf(api) === CUSTOM_JSON_PARSER ? validateFundJsonParserConfig(api.parserConfig) : [];
    if (configErrors.length > 0) {
      return {
        ...base,
        reason: "CONFIG_INVALID",
        configErrors,
        message: `解析配置不完整：${configErrors.join("；")}`,
      };
    }
    return {
      ...base,
      reason: "UNKNOWN_PARSER",
      message: `未知的解析器：${parserCodeOf(api)}（可用：${[CUSTOM_JSON_PARSER, ...Object.keys(PARSERS)].join(" / ")}）`,
    };
  }
  if (!/^\d{6}$/.test(fundCode)) {
    return { ...base, reason: "INVALID_FUND_CODE", message: "基金代码必须是 6 位数字" };
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ...base, reason: "INVALID_URL", message: "请求地址只支持 http/https" };
    }
  } catch {
    return { ...base, reason: "INVALID_URL", message: "请求地址不是合法 URL" };
  }
  if (!baseUrl.includes("{code}")) {
    return { ...base, reason: "MISSING_PLACEHOLDER", message: "请求地址里缺少 {code} 占位符" };
  }

  const needsDate = apiSupportsDate(api);
  const anchor = options.date.trim();
  const dates = needsDate
    ? Array.from({ length: PROBE_DATE_LOOKBACK_DAYS + 1 }, (_, index) => shiftYmd(anchor, -index))
    : [anchor];

  let last = {
    url: "",
    outcome: "empty" as FundNavQueryAttempt["outcome"],
    status: undefined as number | undefined,
    message: undefined as string | undefined,
    raw: undefined as string | undefined,
  };
  for (const dateStr of dates) {
    const url = buildRequestUrl(api, fundCode, dateStr);
    last = { url, outcome: "empty", status: undefined, message: undefined, raw: undefined };
    const { result, raw } = await fetchUrl(api, url, parser, { targetDate: dateStr }, (outcome) => {
      last = {
        url,
        outcome: outcome.outcome,
        status: outcome.status,
        message: outcome.message,
        raw: last.raw,
      };
    });
    if (result) {
      return {
        ...base,
        ok: true,
        url,
        queriedDate: needsDate ? dateStr : undefined,
        nav: result.nav,
        cumNav: result.cumNav ?? null,
        navDate: result.date,
        rawPreview: raw,
      };
    }
    if (raw) last = { ...last, raw };
  }

  // 把底层错误换成用户能自己动手排查的说法：域名不通 / HTTP 状态 / 返回不是净值。
  const host = last.url ? urlHost(last.url) : baseUrl;
  const message =
    last.outcome === "network_error"
      ? `无法连接 ${host}（域名解析或网络不通，原始错误：${last.message ?? "unknown"}）`
      : last.outcome === "http_error"
        ? `HTTP ${last.status ?? "?"}`
        : last.outcome === "parse_error"
          ? `返回内容不是可解析的净值数据（${last.message ?? "unknown"}）`
          : last.message;

  return {
    ...base,
    ...last,
    rawPreview: last.raw,
    message,
    reason: last.outcome === "empty" ? "NO_DATA" : "REQUEST_FAILED",
  };
}
