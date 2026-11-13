import { formatDateInTimeZone, parseDateInputToUtc } from "@/lib/date-utils";

/**
 * 贵金属行情（东财 push2 行情源）。
 *
 * 设计取舍：
 * - 报价一律换到「人民币 / 克」，再按持仓的计量单位（克 / 盎司 / 千克）折算，
 *   与 InvestmentFormModal 里用户手填的「单价」口径一致 —— 单价永远按计量单位计价。
 * - 上金所（SGE）只有黄金 / 白银 / 铂金有人民币现货报价；钯金国内无现货，
 *   退回 NYMEX 美元/盎司报价，再用美元人民币汇率折算，避免这条链路直接空着。
 * - 不认识的品种（用户自建品种）返回 null：宁可不改价，也不要瞎猜一个当天价格。
 */

const TROY_OUNCE_GRAMS = 31.1034768;

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://quote.eastmoney.com/",
};

// 与股票行情同一套超时口径：外部接口卡住不能把整页请求拖死。
const QUOTE_FETCH_TIMEOUT_MS = Number(process.env.METAL_QUOTE_FETCH_TIMEOUT_MS ?? 10_000);
// 同一个报价 60 秒内不重复打接口（连点刷新、多账户同时刷新都不会放大请求）。
const QUOTE_CACHE_TTL_MS = 60_000;

type QuoteUnit = "CNY_PER_GRAM" | "CNY_PER_KG" | "USD_PER_OZ";

type MetalQuoteSource = {
  secid: string;
  quoteUnit: QuoteUnit;
  label: string;
};

const METAL_QUOTE_SOURCES: Record<string, MetalQuoteSource> = {
  XAU: { secid: "118.AU9999", quoteUnit: "CNY_PER_GRAM", label: "上海黄金交易所 黄金9999" },
  XAG: { secid: "118.AG9999", quoteUnit: "CNY_PER_KG", label: "上海黄金交易所 白银9999" },
  XPT: { secid: "118.PT9995", quoteUnit: "CNY_PER_GRAM", label: "上海黄金交易所 铂金9995" },
  XPD: { secid: "102.PA00Y", quoteUnit: "USD_PER_OZ", label: "纽约商品交易所 钯金" },
};

// 美元人民币（离岸）—— 只给美元报价的品种折算用。
const USD_CNY_SECID = "133.USDCNH";

type CachedQuote = { price: number; priceDate: string; fetchedAt: number };

const quoteCache = new Map<string, CachedQuote>();

async function fetchJson(url: string) {
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/**
 * 拉一个东财 secid 的最新价。f43 是整数、f59 是小数位；f86 是行情时间戳（秒）。
 */
async function queryEastmoneyQuote(secid: string, timeZone: string): Promise<CachedQuote | null> {
  const cached = quoteCache.get(secid);
  if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
    return { price: cached.price, priceDate: cached.priceDate, fetchedAt: cached.fetchedAt };
  }

  const params = `secid=${encodeURIComponent(secid)}&fields=f43,f57,f58,f59,f86`;
  const data: any = (await fetchJson(`https://push2.eastmoney.com/api/qt/stock/get?${params}`))
    ?? (await fetchJson(`http://push2.eastmoney.com/api/qt/stock/get?${params}`));
  const item = data?.data;
  if (!item) return null;

  const raw = Number(item.f43);
  const decimals = Number(item.f59);
  if (!Number.isFinite(raw) || !Number.isFinite(decimals)) return null;
  const price = raw / Math.pow(10, Math.max(0, Math.min(8, decimals)));
  if (!(price > 0)) return null;

  // 行情时间戳缺省（部分外盘接口不给）时用业务日兜底，别让整条刷新失败。
  const stamp = Number(item.f86);
  const quoteDate = Number.isFinite(stamp) && stamp > 0
    ? formatDateInTimeZone(new Date(stamp * 1000), timeZone)
    : formatDateInTimeZone(new Date(), timeZone);

  const quote = { price, priceDate: quoteDate, fetchedAt: Date.now() };
  quoteCache.set(secid, quote);
  return quote;
}

/** 品种代码 / 名称 → 内置报价品种（XAU/XAG/XPT/XPD）。 */
export function resolveMetalQuoteCode(metalCode?: string | null, metalName?: string | null): string | null {
  const code = String(metalCode ?? "").trim().toUpperCase();
  if (code && METAL_QUOTE_SOURCES[code]) return code;
  // 用户自建的品种常把代码写成中文（黄金 / 白银9999 / 铂金）或字母简称（AU、AG）。
  const tokens = [metalCode, metalName].map((value) => String(value ?? "").trim().toUpperCase()).filter(Boolean);
  for (const token of tokens) {
    if (METAL_QUOTE_SOURCES[token]) return token;
    if (/^(XAU|AU|GOLD)/.test(token)) return "XAU";
    if (/^(XAG|AG|SILVER)/.test(token)) return "XAG";
    if (/^(XPT|PT|PLATINUM)/.test(token)) return "XPT";
    if (/^(XPD|PD|PALLADIUM)/.test(token)) return "XPD";
    // 铂 / 钯 必须先判，否则「铂金」会被「金」吃掉。
    if (/铂|白金/.test(token)) return "XPT";
    if (/钯/.test(token)) return "XPD";
    if (/银/.test(token)) return "XAG";
    if (/金/.test(token)) return "XAU";
  }
  return null;
}

/** 计量单位 → 每克倍数。不认识的单位返回 null（不猜）。 */
export function metalUnitGramFactor(unitCode?: string | null): number | null {
  const code = String(unitCode ?? "").trim().toUpperCase();
  if (["G", "GR", "GRAM", "克", "公克"].includes(code)) return 1;
  if (["OZ", "OZT", "OUNCE", "盎司", "金衡盎司"].includes(code)) return TROY_OUNCE_GRAMS;
  if (["KG", "KGS", "KILOGRAM", "千克", "公斤"].includes(code)) return 1000;
  return null;
}

export type MetalUnitPriceQuote = {
  /** 按持仓计量单位计价的人民币单价 */
  price: number;
  /** 行情归属交易日 YYYY-MM-DD（业务时区） */
  priceDate: string;
  /** 数据源标识，写入 PreciousMetalHolding.priceSource */
  source: string;
  /** 人类可读的行情名，用于刷新结果提示 */
  quoteLabel: string;
};

/**
 * 查一个贵金属品种按指定计量单位的最新行情单价。
 * 拿不到（品种不认识 / 单位不认识 / 接口失败）返回 null，调用方按「未刷新」处理。
 */
export async function queryMetalLatestUnitPrice(params: {
  metalCode?: string | null;
  metalName?: string | null;
  unitCode?: string | null;
  timeZone: string;
}): Promise<MetalUnitPriceQuote | null> {
  const quoteCode = resolveMetalQuoteCode(params.metalCode, params.metalName);
  if (!quoteCode) return null;
  const source = METAL_QUOTE_SOURCES[quoteCode];
  const unitFactor = metalUnitGramFactor(params.unitCode);
  if (!unitFactor || !Number.isFinite(unitFactor)) return null;

  const quote = await queryEastmoneyQuote(source.secid, params.timeZone);
  if (!quote) return null;

  let cnyPerGram: number;
  if (source.quoteUnit === "CNY_PER_GRAM") {
    cnyPerGram = quote.price;
  } else if (source.quoteUnit === "CNY_PER_KG") {
    cnyPerGram = quote.price / 1000;
  } else {
    const fx = await queryEastmoneyQuote(USD_CNY_SECID, params.timeZone);
    if (!fx) return null;
    cnyPerGram = (quote.price * fx.price) / TROY_OUNCE_GRAMS;
  }

  const price = cnyPerGram * unitFactor;
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price: Math.round(price * 1e6) / 1e6,
    priceDate: quote.priceDate,
    source: `eastmoney:${source.secid}`,
    quoteLabel: source.label,
  };
}

/** 行情日期字符串 → 存库用的 UTC 零点 Date。行情日期非法时返回 null。 */
export function metalPriceDateToUtc(priceDate: string): Date | null {
  return parseDateInputToUtc(priceDate);
}

/** 测试 / 手动清缓存用。 */
export function clearMetalQuoteCache() {
  quoteCache.clear();
}
