import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";

// GET: 获取所有 FundQueryApi 列表
export async function GET() {
  const apis = await prisma.fundQueryApi.findMany({
    orderBy: { priority: "asc" },
  });
  return NextResponse.json({ ok: true, apis });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  code: z.string().min(1).max(40),
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

// POST: 创建新的 FundQueryApi
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "缺少必填字段（name/code/baseUrl）" }, { status: 400 });
  }

  const { name, code, baseUrl, apiKey, priority, isActive } = parse.data;

  const api = await prisma.fundQueryApi.create({
    data: { name, code, baseUrl, apiKey: apiKey || null, priority, isActive },
  });

  return NextResponse.json({ ok: true, api });
}

// PUT: 更新单个 FundQueryApi 的字段
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, name, baseUrl, apiKey, priority, isActive } = body;

  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "API 不存在" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (apiKey !== undefined) data.apiKey = apiKey || null;
  if (priority !== undefined) data.priority = priority;
  if (isActive !== undefined) data.isActive = isActive;

  await prisma.fundQueryApi.update({ where: { id }, data });

  // 如果 API 被停用，清除所有账户中引用它的默认 API
  if (isActive === false) {
    await prisma.account.updateMany({
      where: { defaultFundQueryApiId: id },
      data: { defaultFundQueryApiId: null },
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE: 删除 FundQueryApi
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });

  const existing = await prisma.fundQueryApi.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, error: "API 不存在" }, { status: 404 });

  // 删除前清除所有引用此 API 的账户默认设置
  await prisma.account.updateMany({
    where: { defaultFundQueryApiId: id },
    data: { defaultFundQueryApiId: null },
  });

  await prisma.fundQueryApi.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}