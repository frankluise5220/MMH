import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * GET /api/v1/category
 * 获取分类列表（树形结构支持）
 *
 * Query params:
 *   type? - 可选过滤: "expense" | "income" | "investment"
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
    if (typeFilter && ["expense", "income", "investment"].includes(typeFilter)) {
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