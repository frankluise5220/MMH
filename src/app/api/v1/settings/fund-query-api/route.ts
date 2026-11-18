import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getOrCreateMasterKey, encrypt, decrypt, isEncrypted } from "@/lib/auth/encrypt";
import { CUSTOM_JSON_PARSER } from "@/lib/fund/queryApi";
import { validateFundJsonParserConfig } from "@/lib/fund/json-parser";
import {
  ensureDefaultFundQueryApis,
  repairBrokenDefaultFundQueryApis,
} from "@/lib/fund/queryApiDefaults";

/**
 * key 存库前加密（复用 AI 渠道那套 master key）。存量明文行原样保留，
 * 取数侧 `resolveApiKey` 两种都认。
 */
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

/** JSON 列只接受可序列化值，顺带把 undefined / 函数这类脏值挡掉。 */
function jsonForDb(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

/**
 * 自建源的 `code` 只是行标识，解析器看 `parser` 列。
 * 内置的四个源已经占用了 `eastmoney` 这类 code，用户再建一条同解析器的源不能撞唯一键，
 * 因此这里给自建源发一个 `custom_*`；用户真没被占用时仍保留他填的值。
 */
async function allocateCode(requested: string): Promise<string> {
  const base = requested.trim();
  if (base) {
    const taken = await prisma.fundQueryApi.findUnique({ where: { code: base }, select: { id: true } });
    if (!taken) return base;
  }
  return `custom_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

// GET: list FundQueryApi entries within the current household
export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    await ensureDefaultFundQueryApis();
    await repairBrokenDefaultFundQueryApis();

    const apis = await prisma.fundQueryApi.findMany({
      where: {
        OR: [
          { householdId },
          { householdId: null },
        ],
      },
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" },
      ],
    });

    // 库里是密文；设置页要能回填成可编辑的 key，这里解密后再返回（与 AI 渠道一致）。
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
  /** 行标识；自建源可以不填，服务端会发一个 `custom_*`。 */
  code: z.string().min(1).max(40).optional(),
  /** 解析器标识；不填时沿用 `code`。 */
  parser: z.string().min(1).max(40).optional(),
  /** 仅 `parser = "json"` 使用。 */
  parserConfig: z.unknown().optional(),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

// POST: create a new FundQueryApi within the current household
export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段（name/baseUrl）" }, { status: 400 });
  }

  const { name, baseUrl, apiKey, priority, isActive } = parse.data;
  const requestedCode = (parse.data.code ?? "").trim();
  const parser = (parse.data.parser ?? requestedCode).trim() || CUSTOM_JSON_PARSER;
  const parserConfig = parse.data.parserConfig ?? null;

  // 配置缺字段的自定义源存进来也永远解析不出净值，不如当场拒绝（测试连接已先过一遍）。
  if (parser === CUSTOM_JSON_PARSER) {
    const errors = validateFundJsonParserConfig(parserConfig);
    if (errors.length > 0) {
      return NextResponse.json(
        { ok: false, code: "INVALID_PARSER_CONFIG", error: `解析配置不完整：${errors.join("；")}`, errors },
        { status: 400 },
      );
    }
  }

  const api = await prisma.fundQueryApi.create({
    data: {
      name,
      code: await allocateCode(requestedCode),
      parser,
      parserConfig: parser === CUSTOM_JSON_PARSER ? jsonForDb(parserConfig) : undefined,
      baseUrl,
      apiKey: await encodeApiKey(apiKey),
      priority,
      isActive,
      householdId,
    },
  });

  return NextResponse.json({ ok: true, api: { ...api, apiKey: api.apiKey ? await decodeApiKey(api.apiKey) : null } });
}

// PUT: update fields of a single FundQueryApi within the current household
export async function PUT(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const { id, name, baseUrl, apiKey, priority, isActive, parser, parserConfig } = body;

  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "API 不存在" }, { status: 404 });

  // Authorization check: the API does not belong to the current household
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (apiKey !== undefined) data.apiKey = await encodeApiKey(apiKey);
  if (priority !== undefined) data.priority = priority;
  if (isActive !== undefined) data.isActive = isActive;

  const effectiveParser =
    parser !== undefined ? String(parser).trim() || null : (existing.parser ?? existing.code);
  if (parser !== undefined) data.parser = effectiveParser;
  if (parserConfig !== undefined) {
    if (effectiveParser === CUSTOM_JSON_PARSER) {
      const errors = validateFundJsonParserConfig(parserConfig);
      if (errors.length > 0) {
        return NextResponse.json(
          { ok: false, code: "INVALID_PARSER_CONFIG", error: `解析配置不完整：${errors.join("；")}`, errors },
          { status: 400 },
        );
      }
    }
    data.parserConfig = parserConfig == null ? Prisma.DbNull : jsonForDb(parserConfig);
  }

  await prisma.fundQueryApi.update({ where: { id }, data });

  // If the API is deactivated, clear it from all accounts in the current household that reference it as the default
  if (isActive === false) {
    await prisma.account.updateMany({
      where: { defaultFundQueryApiId: id, householdId },
      data: { defaultFundQueryApiId: null },
    });
  }

  return NextResponse.json({ ok: true });
}

const ReorderSchema = z.object({
  priorities: z.array(z.object({
    id: z.string().min(1),
    priority: z.number().int().min(1),
  })).min(1),
});

// PATCH: batch update priorities of FundQueryApi entries visible to the current household, for drag-and-drop ordering
export async function PATCH(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const parse = ReorderSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_REORDER_DATA", error: "缺少排序数据" }, { status: 400 });
  }

  const ids = parse.data.priorities.map((item) => item.id);
  const existing = await prisma.fundQueryApi.findMany({
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
      prisma.fundQueryApi.update({
        where: { id: item.id },
        data: { priority: item.priority },
      }),
    ),
  );

  const apis = await prisma.fundQueryApi.findMany({
    where: {
      OR: [
        { householdId },
        { householdId: null },
      ],
    },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" },
    ],
  });

  return NextResponse.json({ ok: true, apis });
}

// DELETE: delete a FundQueryApi within the current household
export async function DELETE(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, code: "API_NOT_FOUND", error: "API 不存在" }, { status: 404 });

  // Built-in APIs are global seeded defaults (householdId === null). They are
  // re-seeded on the next GET anyway, and the query pipeline depends on them,
  // so they can never be deleted.
  if (existing.householdId === null) {
    return NextResponse.json({ ok: false, code: "BUILTIN_API_NOT_DELETABLE", error: "系统内置 API 不可删除" }, { status: 403 });
  }

  // Authorization check: the API does not belong to the current household
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  // Clear this API from the default settings of all accounts that reference it before deleting
  await prisma.account.updateMany({
    where: existing.householdId
      ? { defaultFundQueryApiId: id, householdId }
      : { defaultFundQueryApiId: id },
    data: { defaultFundQueryApiId: null },
  });

  await prisma.fundQueryApi.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
