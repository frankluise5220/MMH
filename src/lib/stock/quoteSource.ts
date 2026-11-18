import { parseNavDate, parseNavNumber, readJsonPath } from "@/lib/fund/json-parser";
import { inferStockExchangeFromCode } from "@/lib/stock/market";

/**
 * 股票收盘价的可配置数据源：请求地址模板 + 报文解析。
 *
 * 此前行情源写死在 `stock/queryApi.ts` 里（东财主源 + 腾讯兜底），用户既看不到也加不了
 * 第三条通道。这里把「怎么请求、怎么解析」变成数据，与基金侧 `FundQueryApi` 同构。
 *
 * 支持的源限定为「GET + 返回 JSON + 静态 key」这一族，与基金侧一致。
 */

export const EASTMONEY_KLINE_PARSER = "eastmoney_kline";
export const TENCENT_KLINE_PARSER = "tencent_kline";
export const STOCK_JSON_PARSER = "json";

export type StockQuoteApiConfig = {
  id: string;
  code: string;
  name: string;
  market: string;
  baseUrl: string;
  apiKey: string | null;
  parser: string | null;
  parserConfig: unknown;
  priority: number;
  isActive: boolean;
  builtin: boolean;
  householdId: string | null;
};

export type StockQuoteAuthIn = "none" | "header" | "query";

export type StockQuoteJsonConfig = {
  authIn: StockQuoteAuthIn;
  authName: string;
  authPrefix: string;
  codeSuffix: string;
  pricePath: string;
  datePath: string;
  namePath: string;
  seriesPath: string;
  seriesPricePath: string;
  seriesDatePath: string;
};

const EMPTY_JSON_CONFIG: StockQuoteJsonConfig = {
  authIn: "none",
  authName: "",
  authPrefix: "",
  codeSuffix: "",
  pricePath: "",
  datePath: "",
  namePath: "",
  seriesPath: "",
  seriesPricePath: "close",
  seriesDatePath: "date",
};

function pickString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeStockQuoteJsonConfig(raw: unknown): StockQuoteJsonConfig | null {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { ...EMPTY_JSON_CONFIG };
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (value == null) return { ...EMPTY_JSON_CONFIG };
  if (typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const authInRaw = pickString(record.authIn).toLowerCase();
  const authIn: StockQuoteAuthIn =
    authInRaw === "header" || authInRaw === "query" ? authInRaw : "none";

  return {
    authIn,
    authName: pickString(record.authName),
    authPrefix: typeof record.authPrefix === "string" ? record.authPrefix : "",
    codeSuffix: pickString(record.codeSuffix),
    pricePath: pickString(record.pricePath),
    datePath: pickString(record.datePath),
    namePath: pickString(record.namePath),
    seriesPath: pickString(record.seriesPath),
    seriesPricePath: pickString(record.seriesPricePath) || EMPTY_JSON_CONFIG.seriesPricePath,
    seriesDatePath: pickString(record.seriesDatePath) || EMPTY_JSON_CONFIG.seriesDatePath,
  };
}

/** 返回空数组表示这份配置拿去解析不会因为缺字段白白失败。 */
export function validateStockQuoteJsonConfig(raw: unknown): string[] {
  const config = normalizeStockQuoteJsonConfig(raw);
  if (!config) return ["解析配置不是合法的 JSON 对象"];

  const errors: string[] = [];
  if (config.authIn !== "none" && !config.authName) {
    errors.push("选择了需要鉴权，但没填鉴权参数名（如 X-api-key）");
  }
  if (config.seriesPath) {
    if (!config.seriesPricePath) errors.push("区间模式缺少收盘价字段名");
    if (!config.seriesDatePath) errors.push("区间模式缺少日期字段名");
  } else {
    if (!config.pricePath) errors.push("缺少收盘价路径（pricePath）");
    if (!config.datePath) errors.push("缺少日期路径（datePath）；没有日期的收盘价不能入账");
  }
  return errors;
}

export function parserCodeOf(api: StockQuoteApiConfig): string {
  return (api.parser ?? api.code ?? "").trim();
}

export function stockQuoteJsonConfigOf(api: StockQuoteApiConfig): StockQuoteJsonConfig | null {
  return parserCodeOf(api) === STOCK_JSON_PARSER
    ? normalizeStockQuoteJsonConfig(api.parserConfig)
    : null;
}

export function isKnownStockQuoteParser(parser: string): boolean {
  return (
    parser === EASTMONEY_KLINE_PARSER ||
    parser === TENCENT_KLINE_PARSER ||
    parser === STOCK_JSON_PARSER
  );
}

export type QuoteTarget = {
  stockCode: string;
  /** SH / SZ / BJ；为空时按代码推断。 */
  exchange: string | null;
  /** 区间起始日（单日查询时由调用方往前推若干天，覆盖节假日）。 */
  dateStart: string;
  /** 目标日；区间查询时为结束日。 */
  date: string;
};

export type QuoteRow = { priceDate: string; closePrice: number };

export type QuoteFetchResult =
  | { ok: true; rows: QuoteRow[]; raw?: string }
  | {
      ok: false;
      outcome: "http_error" | "parse_error" | "empty" | "network_error";
      status?: number;
      message?: string;
      raw?: string;
    };

/**
 * 占位符替换。比基金侧多三个：股票接口普遍要求带市场信息，且格式各不相同。
 *
 * - `{code}` 600519 / `{exchange}` SH / `{exchangeLower}` sh / `{secid}` 1.600519
 * - `{date}` 2026-11-18 / `{dateCompact}` 20261118
 * - `{dateStart}` / `{dateStartCompact}` 区间起始日
 */
export function buildQuoteRequestUrl(api: StockQuoteApiConfig, target: QuoteTarget): string {
  const config = stockQuoteJsonConfigOf(api);
  const stockCode = `${target.stockCode}${config?.codeSuffix ?? ""}`;
  const exchange = (
    target.exchange ?? inferStockExchangeFromCode("CN", target.stockCode) ?? ""
  ).toUpperCase();
  const secid = exchange === "SH" ? `1.${target.stockCode}` : `0.${target.stockCode}`;

  return api.baseUrl
    .replaceAll("{code}", stockCode)
    .replaceAll("{exchangeLower}", exchange.toLowerCase())
    .replaceAll("{exchange}", exchange)
    .replaceAll("{secid}", secid)
    .replaceAll("{dateStartCompact}", target.dateStart.replaceAll("-", ""))
    .replaceAll("{dateStart}", target.dateStart)
    .replaceAll("{dateCompact}", target.date.replaceAll("-", ""))
    .replaceAll("{date}", target.date);
}

function parseDelimitedRow(row: unknown): QuoteRow | null {
  const parts = String(row ?? "").split(",");
  const priceDate = parseNavDate(parts[0]);
  const closePrice = parseNavNumber(parts[2]);
  return priceDate && closePrice != null ? { priceDate, closePrice } : null;
}

function parseArrayRow(row: unknown): QuoteRow | null {
  if (!Array.isArray(row) || row.length < 3) return null;
  const priceDate = parseNavDate(row[0]);
  const closePrice = parseNavNumber(row[2]);
  return priceDate && closePrice != null ? { priceDate, closePrice } : null;
}

function collect(
  list: unknown,
  mapper: (row: unknown) => QuoteRow | null,
): QuoteRow[] | null {
  if (!Array.isArray(list)) return null;
  const rows = list.map(mapper).filter((row): row is QuoteRow => row != null);
  return rows.length > 0 ? rows : null;
}

export function tencentSymbol(target: QuoteTarget): string {
  const exchange = (
    target.exchange ?? inferStockExchangeFromCode("CN", target.stockCode) ?? ""
  ).toUpperCase();
  if (exchange === "SH") return `sh${target.stockCode}`;
  if (exchange === "SZ") return `sz${target.stockCode}`;
  if (exchange === "BJ") return `bj${target.stockCode}`;
  if (/^[69]/.test(target.stockCode)) return `sh${target.stockCode}`;
  if (/^[023]/.test(target.stockCode)) return `sz${target.stockCode}`;
  if (/^(4|8|92)/.test(target.stockCode)) return `bj${target.stockCode}`;
  return `sz${target.stockCode}`;
}

export function parseQuoteRows(
  data: unknown,
  parser: string,
  target: QuoteTarget,
  jsonConfig: StockQuoteJsonConfig | null,
): QuoteRow[] | null {
  if (parser === EASTMONEY_KLINE_PARSER) {
    const klines = (data as { data?: { klines?: unknown } } | null)?.data?.klines;
    return collect(klines, parseDelimitedRow);
  }

  if (parser === TENCENT_KLINE_PARSER) {
    const node = (data as { data?: Record<string, unknown> } | null)?.data?.[tencentSymbol(target)];
    if (!node || typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    // fqkline 复权日线在 `qfqday`，部分日期区间 / 不复权查询返回 `day`。
    return collect(record.qfqday, parseArrayRow) ?? collect(record.day, parseArrayRow);
  }

  if (parser === STOCK_JSON_PARSER && jsonConfig) {
    if (jsonConfig.seriesPath) {
      return collect(readJsonPath(data, jsonConfig.seriesPath), (item) => {
        const priceDate = parseNavDate(readJsonPath(item, jsonConfig.seriesDatePath));
        const closePrice = parseNavNumber(readJsonPath(item, jsonConfig.seriesPricePath));
        return priceDate && closePrice != null ? { priceDate, closePrice } : null;
      });
    }
    const priceDate = parseNavDate(readJsonPath(data, jsonConfig.datePath));
    const closePrice = parseNavNumber(readJsonPath(data, jsonConfig.pricePath));
    return priceDate && closePrice != null ? [{ priceDate, closePrice }] : null;
  }

  return null;
}

/** 把 `20261118` / `2026-11-18` / ISO 时间串统一成 `YYYY-MM-DD`。 */
export function toYmd(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function shiftYmd(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** 按日期升序，同一天只留一条。 */
export function sortQuoteRows(rows: QuoteRow[]): QuoteRow[] {
  const byDate = new Map<string, QuoteRow>();
  for (const row of rows) byDate.set(row.priceDate, row);
  return [...byDate.values()].sort((a, b) => a.priceDate.localeCompare(b.priceDate));
}

/** 取目标日及之前最近一个交易日的收盘价。 */
export function pickCloseOnOrBefore(rows: QuoteRow[], targetDate: string): QuoteRow | null {
  const sorted = sortQuoteRows(rows).filter((row) => row.priceDate <= targetDate);
  return sorted.length > 0 ? sorted[sorted.length - 1]! : null;
}

/** 取 [startDate, endDate] 区间内的全部收盘价。 */
export function pickCloseRange(rows: QuoteRow[], startDate: string, endDate: string): QuoteRow[] {
  return sortQuoteRows(rows).filter(
    (row) => row.priceDate >= startDate && row.priceDate <= endDate,
  );
}
