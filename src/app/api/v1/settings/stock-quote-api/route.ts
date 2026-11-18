import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getOrCreateMasterKey, encrypt, decrypt, isEncrypted } from "@/lib/auth/encrypt";
import {
  STOCK_JSON_PARSER,
  isKnownStockQuoteParser,
  validateStockQuoteJsonConfig,
} from "@/lib/stock/quoteSource";
import { ensureDefaultStockQuoteApis } from "@/lib/stock/quoteSourceRepo";

/** key 存库前加密（复用 AI 渠道那套 master key）；存量明文行原样保留。 */
async function encodeApiKey(raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (isEncrypted(value)) return value;
  return encrypt(value, await getOrCreateMasterKey());
}

async function decodeApiKey(stored: string | null): Promise<string | null> {
  const value = (stored ?? "").trim();
  if (!value) return null;
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value, await getOrCreateMasterKey());
  } catch {
    return null;
  }
}

function jsonForDb(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

/** 内置两条已占用 `eastmoney_kline` / `tencent_kline`，用户自建同解析器的源不能撞唯一键。 */
async function allocateCode(requested: string): Promise<string> {
  const base = requested.trim();
  if (base) {
    const taken = await prisma.stockQuoteApi.findUnique({ where: { code: base }, select: { id: true } });
    if (!taken) return base;
  }
  return `custom_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    await ensureDefaultStockQuoteApis();

    const apis = await prisma.stockQuoteApi.findMany({
      where: { OR: [{ householdId }, { householdId: null }] },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });

    const withKeys = await Promise.all(
      apis.map(async (api) => ({ ...api, apiKey: await decodeApiKey(api.apiKey) })),
    );

    return NextResponse.json({ ok: true, apis: withKeys });
  } catch {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: "服务器错误" }, { status: 500 });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  code: z.string().min(1).max(40).optional(),
  /** 当前只有 A 股实现；"*" 表示不限制市场。 */
  market: z.enum(["CN", "*"]).default("CN"),
  parser: z.string().min(1).max(40).optional(),
  parserConfig: z.unknown().optional(),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段（name/baseUrl）" },
      { status: 400 },
    );
  }

  const { name, market, baseUrl, apiKey, priority, isActive } = parse.data;
  const requestedCode = (parse.data.code ?? "").trim();
  const parser = (parse.data.parser ?? requestedCode).trim() || STOCK_JSON_PARSER;
  const parserConfig = parse.data.parserConfig ?? null;

  if (!isKnownStockQuoteParser(parser)) {
    return NextResponse.json(
      { ok: false, code: "UNKNOWN_PARSER", error: `未知的解析器：${parser}` },
      { status: 400 },
    );
  }
  if (!baseUrl.includes("{code}") && !baseUrl.includes("{secid}")) {
    return NextResponse.json(
      { ok: false, code: "MISSING_PLACEHOLDER", error: "地址里必须包含 {code} 或 {secid} 占位符" },
      { status: 400 },
    );
  }
  if (parser === STOCK_JSON_PARSER) {
    const errors = validateStockQuoteJsonConfig(parserConfig);
    if (errors.length > 0) {
      return NextResponse.json(
        { ok: false, code: "INVALID_PARSER_CONFIG", error: `解析配置不完整：${errors.join("；")}`, errors },
        { status: 400 },
      );
    }
  }

  const api = await prisma.stockQuoteApi.create({
    data: {
      name,
      code: await allocateCode(requestedCode),
      market,
      parser,
      parserConfig: parser === STOCK_JSON_PARSER ? jsonForDb(parserConfig) : undefined,
      baseUrl,
      apiKey: await encodeApiKey(apiKey),
      priority,
      isActive,
      householdId,
    },
  });

  return NextResponse.json({
    ok: true,
    api: { ...api, apiKey: api.apiKey ? await decodeApiKey(api.apiKey) : null },
  });
}

export async function PUT(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const { id, name, baseUrl, apiKey, priority, isActive, parser, parserConfig, market } = body;

  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.stockQuoteApi.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "API 不存在" }, { status: 404 });
  }
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (apiKey !== undefined) data.apiKey = await encodeApiKey(apiKey);
  if (priority !== undefined) data.priority = priority;
  if (isActive !== undefined) data.isActive = isActive;
  if (market !== undefined) {
    if (market !== "CN" && market !== "*") {
      return NextResponse.json({ ok: false, code: "INVALID_MARKET", error: "暂只支持 CN" }, { status: 400 });
    }
    data.market = market;
  }

  const effectiveParser =
    parser !== undefined ? String(parser).trim() || null : (existing.parser ?? existing.code);
  if (parser !== undefined) {
    if (!isKnownStockQuoteParser(String(effectiveParser))) {
      return NextResponse.json(
        { ok: false, code: "UNKNOWN_PARSER", error: `未知的解析器：${String(effectiveParser)}` },
        { status: 400 },
      );
    }
    data.parser = effectiveParser;
  }
  if (parserConfig !== undefined) {
    if (effectiveParser === STOCK_JSON_PARSER) {
      const errors = validateStockQuoteJsonConfig(parserConfig);
      if (errors.length > 0) {
        return NextResponse.json(
          { ok: false, code: "INVALID_PARSER_CONFIG", error: `解析配置不完整：${errors.join("；")}`, errors },
          { status: 400 },
        );
      }
    }
    data.parserConfig = parserConfig == null ? Prisma.DbNull : jsonForDb(parserConfig);
  }

  await prisma.stockQuoteApi.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}

const ReorderSchema = z.object({
  priorities: z
    .array(z.object({ id: z.string().min(1), priority: z.number().int().min(1) }))
    .min(1),
});

export async function PATCH(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const parse = ReorderSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, code: "MISSING_REORDER_DATA", error: "缺少排序数据" },
      { status: 400 },
    );
  }

  const ids = parse.data.priorities.map((item) => item.id);
  const existing = await prisma.stockQuoteApi.findMany({
    where: { id: { in: ids } },
    select: { id: true, householdId: true },
  });
  if (existing.length !== ids.length) {
    return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "部分 API 不存在" }, { status: 404 });
  }
  if (existing.some((api) => api.householdId !== householdId && api.householdId !== null)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  await prisma.$transaction(
    parse.data.priorities.map((item) =>
      prisma.stockQuoteApi.update({ where: { id: item.id }, data: { priority: item.priority } }),
    ),
  );

  const apis = await prisma.stockQuoteApi.findMany({
    where: { OR: [{ householdId }, { householdId: null }] },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ ok: true, apis });
}

export async function DELETE(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.stockQuoteApi.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "API 不存在" }, { status: 404 });
  }
  // 内置源是全局默认（householdId === null），下次 GET 会重新补齐，且取价链路依赖它们。
  if (existing.householdId === null) {
    return NextResponse.json(
      { ok: false, code: "BUILTIN_API_NOT_DELETABLE", error: "系统内置 API 不可删除" },
      { status: 403 },
    );
  }
  if (existing.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  await prisma.stockQuoteApi.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
