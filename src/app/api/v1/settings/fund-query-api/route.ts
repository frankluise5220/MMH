import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

const DEFAULT_FUND_QUERY_APIS = [
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
    baseUrl: "http://api.fund.eastmoney.com/f10/lsjz?fundCode={code}&pageIndex=1&pageSize=5&startDate={date}&endDate={date}",
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
];

// #region debug-point A:fund-query-api-route
function reportDebug(hypothesisId: string, msg: string, data?: Record<string, unknown>) {
  void fetch("http://192.168.2.199:7778/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "fund-users-balance", runId: "pre-fix", hypothesisId, location: "api/v1/settings/fund-query-api/route.ts", msg: `[DEBUG] ${msg}`, data, ts: Date.now() }),
  }).catch(() => {});
}
// #endregion

async function ensureDefaultFundQueryApis() {
  await prisma.$transaction(
    DEFAULT_FUND_QUERY_APIS.map((api) =>
      prisma.fundQueryApi.upsert({
        where: { code: api.code },
        create: api,
        update: {
          name: api.name,
          baseUrl: api.baseUrl,
          priority: api.priority,
          isActive: api.isActive,
        },
      }),
    ),
  );
}

// GET: 获取当前账簿内的 FundQueryApi 列表
export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    // #region debug-point A:fund-query-api-scope
    reportDebug("A", "fund query api get entered", { householdId });
    // #endregion
    let apis = await prisma.fundQueryApi.findMany({
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

    if (apis.length === 0) {
      // #region debug-point A:fund-query-api-empty
      reportDebug("A", "fund query api empty before default seed", { householdId });
      // #endregion
      await ensureDefaultFundQueryApis();
      apis = await prisma.fundQueryApi.findMany({
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
    }

    // #region debug-point A:fund-query-api-result
    reportDebug("A", "fund query api get completed", {
      householdId,
      count: apis.length,
      ids: apis.slice(0, 5).map((item) => item.id),
      codes: apis.slice(0, 5).map((item) => item.code),
    });
    // #endregion
    return NextResponse.json({ ok: true, apis });
  } catch (error) {
    // #region debug-point A:fund-query-api-error
    reportDebug("A", "fund query api get threw", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? "").slice(0, 1200) : "",
    });
    // #endregion
    return NextResponse.json({ ok: false, error: "服务器错误" }, { status: 500 });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  code: z.string().min(1).max(40),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

// POST: 在当前账簿内创建新的 FundQueryApi
export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "缺少必填字段（name/code/baseUrl）" }, { status: 400 });
  }

  const { name, code, baseUrl, apiKey, priority, isActive } = parse.data;

  const api = await prisma.fundQueryApi.create({
    data: { name, code, baseUrl, apiKey: apiKey || null, priority, isActive, householdId },
  });

  return NextResponse.json({ ok: true, api });
}

// PUT: 更新当前账簿内的单个 FundQueryApi 的字段
export async function PUT(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => ({}));
  const { id, name, baseUrl, apiKey, priority, isActive } = body;

  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "API 不存在" }, { status: 404 });

  // 越权检查：API 不属于当前账簿
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (apiKey !== undefined) data.apiKey = apiKey || null;
  if (priority !== undefined) data.priority = priority;
  if (isActive !== undefined) data.isActive = isActive;

  await prisma.fundQueryApi.update({ where: { id }, data });

  // 如果 API 被停用，清除当前账簿内所有账户中引用它的默认 API
  if (isActive === false) {
    await prisma.account.updateMany({
      where: { defaultFundQueryApiId: id, householdId },
      data: { defaultFundQueryApiId: null },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE: 删除当前账簿内的 FundQueryApi
export async function DELETE(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "API 不存在" }, { status: 404 });

  // 越权检查：API 不属于当前账簿
  if (existing.householdId !== householdId && existing.householdId !== null) {
    return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403 });
  }

  // 删除前清除当前账簿内所有引用此 API 的账户默认设置
  await prisma.account.updateMany({
    where: existing.householdId
      ? { defaultFundQueryApiId: id, householdId }
      : { defaultFundQueryApiId: id },
    data: { defaultFundQueryApiId: null },
  });

  await prisma.fundQueryApi.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
