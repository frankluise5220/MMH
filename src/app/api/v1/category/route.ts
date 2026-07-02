import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * GET /api/v1/category
 * 获取分类列表（树形结构支持）
 *
 * Query params:
 *   type? - 可选过滤: "expense" | "income" | "advance"
 *
 * 返回: { ok: true, categories: [{ id, name, type, parentId, sortOrder }] }
 */
export async function GET(req: Request) {
  try {
    let hidFilter: { householdId: string };

    // Try cookie auth first, fall back to X-Api-Key
    try {
      const ctx = await getHouseholdScope();
      hidFilter = ctx.hidFilter;
    } catch {
      const ctx = await getApiHouseholdScope(req);
      hidFilter = ctx.hidFilter;
    }

    const url = new URL(req.url);
    const typeFilter = url.searchParams.get("type")?.trim();

    const where: Record<string, unknown> = { ...hidFilter };
    if (typeFilter && !["expense", "income", "advance"].includes(typeFilter)) {
      return NextResponse.json({ ok: true, categories: [] });
    }
    if (typeFilter) {
      where.type = typeFilter;
    }

    const categories = await prisma.category.findMany({
      where,
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, type: true, parentId: true },
    });

    return NextResponse.json({ ok: true, categories });
  } catch (e) {
    console.error("GET /api/v1/category error:", e);
    return NextResponse.json({ ok: false, error: "查询失败" }, { status: 500 });
  }
}

const CATEGORY_TYPES = ["expense", "income", "advance"] as const;
const RESERVED_CATEGORY_NAMES = new Set(["支出", "收入", "代付", "投资"]);

/**
 * POST /api/v1/category
 * 新增分类。
 *
 * Body: { name: string, type?: "expense" | "income" | "advance", parentId?: string }
 * - parentId 存在时，分类类型继承上级分类。
 * - "支出"、"收入"、"代付"、"投资" 是分类类型根，不允许作为普通分类名称写入数据库。
 * - 投资不使用分类树，投资交易通过产品类型、基金代码、交易子类型等结构化字段区分。
 *
 * 返回: { ok: true, category: { id, name, type, parentId, isSystem } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    const requestedType = String(body.type ?? "expense").trim();
    const parentId = String(body.parentId ?? "").trim() || null;

    if (!name || name.length > 50) {
      return NextResponse.json({ ok: false, error: "分类名称不合法（1-50字）" }, { status: 400 });
    }
    if (RESERVED_CATEGORY_NAMES.has(name)) {
      return NextResponse.json({ ok: false, error: "支出、收入、代付、投资是分类根目录，不能作为普通分类名称" }, { status: 400 });
    }
    if (!CATEGORY_TYPES.includes(requestedType as typeof CATEGORY_TYPES[number])) {
      return NextResponse.json({ ok: false, error: "分类类型不正确" }, { status: 400 });
    }

    let type = requestedType;
    if (parentId) {
      const parent = await prisma.category.findFirst({
        where: { id: parentId, householdId },
        select: { type: true },
      });
      if (!parent) {
        return NextResponse.json({ ok: false, error: "上级分类不存在" }, { status: 404 });
      }
      type = parent.type;
    }

    const duplicate = await prisma.category.findFirst({
      where: { householdId, type, parentId, name },
      select: { id: true },
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "同级分类已存在" }, { status: 409 });
    }

    const category = await prisma.category.create({
      data: { name, type, parentId, householdId, isSystem: false },
      select: { id: true, name: true, type: true, parentId: true, isSystem: true },
    });

    return NextResponse.json({ ok: true, category });
  } catch (e) {
    console.error("POST /api/v1/category error:", e);
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }
}

/**
 * PUT /api/v1/category
 * 修改分类名称。
 *
 * Body: { id: string, name: string }
 * - 只修改名称，不改变分类类型和层级。
 * - 同步更新已记账记录中的 categoryName，避免旧流水继续显示旧名称。
 *
 * 返回: { ok: true, category: { id, name, type, parentId, isSystem } }
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const id = String(body.id ?? "").trim();
    const name = String(body.name ?? "").trim();

    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少分类 ID" }, { status: 400 });
    }
    if (!name || name.length > 50) {
      return NextResponse.json({ ok: false, error: "分类名称不合法（1-50字）" }, { status: 400 });
    }
    if (RESERVED_CATEGORY_NAMES.has(name)) {
      return NextResponse.json({ ok: false, error: "支出、收入、代付、投资是分类根目录，不能作为普通分类名称" }, { status: 400 });
    }

    const current = await prisma.category.findFirst({
      where: { id, householdId },
      select: { id: true, type: true, parentId: true },
    });
    if (!current) {
      return NextResponse.json({ ok: false, error: "分类不存在" }, { status: 404 });
    }

    const duplicate = await prisma.category.findFirst({
      where: {
        householdId,
        type: current.type,
        parentId: current.parentId,
        name,
        NOT: { id },
      },
      select: { id: true },
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "同级分类已存在" }, { status: 409 });
    }

    const category = await prisma.$transaction(async (tx) => {
      const updated = await tx.category.update({
        where: { id },
        data: { name },
        select: { id: true, name: true, type: true, parentId: true, isSystem: true },
      });
      await tx.txRecord.updateMany({
        where: { householdId, categoryId: id },
        data: { categoryName: name },
      });
      return updated;
    });

    return NextResponse.json({ ok: true, category });
  } catch (e) {
    console.error("PUT /api/v1/category error:", e);
    return NextResponse.json({ ok: false, error: "修改失败" }, { status: 500 });
  }
}
