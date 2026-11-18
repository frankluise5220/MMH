import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import { inferStockExchangeFromCode, normalizeStockCode, normalizeStockMarket } from "@/lib/stock/market";
import {
  STOCK_JSON_PARSER,
  isKnownStockQuoteParser,
  pickCloseOnOrBefore,
  shiftYmd,
  sortQuoteRows,
  toYmd,
  validateStockQuoteJsonConfig,
  type StockQuoteApiConfig,
} from "@/lib/stock/quoteSource";
import { fetchQuoteRows } from "@/lib/stock/quoteSourceRepo";

/**
 * 测试一条股票行情源。
 *
 * 与基金侧不同的是这里必须带 `stockCode`：基金源可以拿默认基金反复试，股票源
 * 的 URL 依赖市场前缀（`sh` / `sz` / `{secid}`），用错市场会直接取不到。
 * 返回值同时给出解析结果和前若干条候选，让用户拿真实行情核对。
 */

const TestSchema = z.object({
  parser: z.string().min(1).max(40).optional(),
  code: z.string().max(40).optional(),
  parserConfig: z.unknown().optional(),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  market: z.string().max(8).default("CN"),
  stockCode: z.string().min(1).max(20),
  date: z.string().max(20).optional(),
});

/** 单日查询的窗口，与 queryApi 里的取值保持一致。 */
const LOOKBACK_DAYS = 10;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parse = TestSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, outcome: "invalid_request", message: "缺少 baseUrl 或 stockCode" },
      { status: 400 },
    );
  }

  const data = parse.data;
  const parser = (data.parser ?? data.code ?? "").trim();
  if (!isKnownStockQuoteParser(parser)) {
    return NextResponse.json(
      { ok: false, outcome: "unknown_parser", message: `未知的解析器：${parser || "(空)"}` },
      { status: 400 },
    );
  }

  const baseUrl = data.baseUrl.trim();
  if (!baseUrl.includes("{code}") && !baseUrl.includes("{secid}")) {
    return NextResponse.json(
      { ok: false, outcome: "missing_placeholder", message: "地址里必须包含 {code} 或 {secid}" },
      { status: 400 },
    );
  }

  if (parser === STOCK_JSON_PARSER) {
    const errors = validateStockQuoteJsonConfig(data.parserConfig);
    if (errors.length > 0) {
      return NextResponse.json(
        { ok: false, outcome: "invalid_parser_config", message: errors.join("；"), errors },
        { status: 400 },
      );
    }
  }

  // 测试必须指定具体市场：同一段地址在港股/美股下会展开成不同的 secid / 代码后缀。
  const market = normalizeStockMarket(data.market || "CN");
  if (!["CN", "HK", "US"].includes(market)) {
    return NextResponse.json(
      { ok: false, outcome: "unsupported_market", message: "测试时请选择具体市场（CN / HK / US）" },
      { status: 400 },
    );
  }

  const stockCode = normalizeStockCode(data.stockCode);
  if (!stockCode) {
    return NextResponse.json(
      { ok: false, outcome: "invalid_stock_code", message: "股票代码不合法" },
      { status: 400 },
    );
  }

  const targetDate = toYmd(data.date) ?? todayDateBusinessYmd();
  const api: StockQuoteApiConfig = {
    id: "probe",
    code: parser,
    name: "probe",
    market,
    baseUrl,
    apiKey: data.apiKey?.trim() || null,
    parser,
    parserConfig: data.parserConfig ?? null,
    priority: 0,
    isActive: true,
    builtin: false,
    householdId: null,
  };

  const result = await fetchQuoteRows(api, {
    stockCode,
    market,
    exchange: inferStockExchangeFromCode(market, stockCode),
    dateStart: shiftYmd(targetDate, -LOOKBACK_DAYS),
    date: targetDate,
  });

  if (!result.ok) {
    return NextResponse.json({
      ok: false,
      outcome: result.outcome,
      status: result.status ?? null,
      message: result.message ?? null,
      stockCode,
      date: targetDate,
      raw: result.raw ?? null,
    });
  }

  const picked = pickCloseOnOrBefore(result.rows, targetDate);
  const candidates = sortQuoteRows(result.rows).slice(-5);

  if (!picked) {
    return NextResponse.json({
      ok: false,
      outcome: "empty",
      message: `接口有返回，但 ${targetDate} 及之前没有可用收盘价`,
      stockCode,
      date: targetDate,
      candidates,
      raw: result.raw ?? null,
    });
  }

  return NextResponse.json({
    ok: true,
    outcome: "ok",
    stockCode,
    date: targetDate,
    priceDate: picked.priceDate,
    closePrice: picked.closePrice,
    candidates,
    raw: result.raw ?? null,
  });
}
