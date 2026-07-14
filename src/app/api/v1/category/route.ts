import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

/**
 * GET /api/v1/category
 * 获取分类列表（树形结构支持）
 *
 * Query params:
 *   type? - 可选过滤: "expense" | "income" | "advance" | "transfer" | "investment"
 *
 * 返回: { ok: true, categories: [{ id, name, type, parentId, isSystem }] }
 */
export async function GET(req: Request) {
  try {
    let householdId = "";
    let hidFilter: { householdId: string };

    // Try cookie auth first, fall back to X-Api-Key
    try {
      const ctx = await getHouseholdScope();
      householdId = ctx.householdId;
      hidFilter = ctx.hidFilter;
    } catch {
      const ctx = await getApiHouseholdScope(req);
      householdId = ctx.householdId;
      hidFilter = ctx.hidFilter;
    }

    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);

    const url = new URL(req.url);
    const typeFilter = url.searchParams.get("type")?.trim();

    const where: Record<string, unknown> = { ...hidFilter };
    if (typeFilter && !["expense", "income", "advance", "transfer", "investment"].includes(typeFilter)) {
      return NextResponse.json({ ok: true, categories: [] });
    }
    if (typeFilter) {
      where.type = typeFilter;
    }

    const categories = await prisma.category.findMany({
      where,
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, type: true, parentId: true, isSystem: true },
    });

    return NextResponse.json({ ok: true, categories });
  } catch (e) {
    console.error("GET /api/v1/category error:", e);
    return NextResponse.json({ ok: false, error: "查询失败" }, { status: 500 });
  }
}

const CATEGORY_TYPES = ["expense", "income", "advance", "transfer", "investment"] as const;
const RESERVED_CATEGORY_NAMES = new Set(["支出", "收入", "代付", "转账", "投资"]);

async function findDuplicateCategoryName(
  householdId: string,
  name: string,
  exceptId?: string,
) {
  return prisma.category.findFirst({
    where: {
      householdId,
      name,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
}

function isDuplicateCategoryNameError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * POST /api/v1/category
 * 新增分类。
 *
 * Body: { name: string, type?: "expense" | "income" | "advance" | "transfer" | "investment", parentId?: string }
 * - parentId 存在时，分类类型继承上级分类。
 * - 分类名称在同一账簿内必须全局唯一，不区分收支类型或上级分类。
 * - "支出"、"收入"、"代付"、"转账"、"投资" 是分类类型根，不允许作为普通分类名称写入数据库。
 * - 系统内置的投资收益、投资亏损、还款、贷款等业务分类会显示在同一棵分类树中，供统计项挂接；这些系统分类不可改名、移动或删除。
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
      return NextResponse.json({ ok: false, error: "支出、收入、代付、转账、投资是分类根目录，不能作为普通分类名称" }, { status: 400 });
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

    const duplicate = await findDuplicateCategoryName(householdId, name);
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "分类名称已存在" }, { status: 409 });
    }

    const category = await prisma.category.create({
      data: { name, type, parentId, householdId, isSystem: false },
      select: { id: true, name: true, type: true, parentId: true, isSystem: true },
    });

    return NextResponse.json({ ok: true, category });
  } catch (e) {
    if (isDuplicateCategoryNameError(e)) {
      return NextResponse.json({ ok: false, error: "分类名称已存在" }, { status: 409 });
    }
    console.error("POST /api/v1/category error:", e);
    return NextResponse.json({ ok: false, error: "创建失败" }, { status: 500 });
  }
}

/**
 * PUT /api/v1/category
 * 修改分类名称或移动分类层级。
 *
 * Body: { id: string, name?: string, parentId?: string | null }
 * - name 存在时修改分类名称。
 * - parentId 存在时移动整个分类节点；子分类会随该节点整体移动。
 * - parentId 为空/null 表示移动到当前类型根目录下。
 * - 不允许跨分类类型移动，不允许移动到自身或自己的后代下。
 * - 分类名称在同一账簿内必须全局唯一，不区分收支类型或上级分类。
 * - 系统内置分类不允许改名或移动，但允许在其下新增用户子分类。
 * - 修改名称时同步更新已记账记录中的 categoryName，避免旧流水继续显示旧名称。
 *
 * 返回: { ok: true, category: { id, name, type, parentId, isSystem } }
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const id = String(body.id ?? "").trim();
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasParentId = Object.prototype.hasOwnProperty.call(body, "parentId");
    const requestedName = hasName ? String(body.name ?? "").trim() : "";
    const requestedParentId = hasParentId ? String(body.parentId ?? "").trim() || null : undefined;

    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少分类 ID" }, { status: 400 });
    }
    if (!hasName && !hasParentId) {
      return NextResponse.json({ ok: false, error: "缺少修改内容" }, { status: 400 });
    }
    if (hasName && (!requestedName || requestedName.length > 50)) {
      return NextResponse.json({ ok: false, error: "分类名称不合法（1-50字）" }, { status: 400 });
    }
    if (hasName && RESERVED_CATEGORY_NAMES.has(requestedName)) {
      return NextResponse.json({ ok: false, error: "支出、收入、代付、转账、投资是分类根目录，不能作为普通分类名称" }, { status: 400 });
    }

    const current = await prisma.category.findFirst({
      where: { id, householdId },
      select: { id: true, name: true, type: true, parentId: true, isSystem: true },
    });
    if (!current) {
      return NextResponse.json({ ok: false, error: "分类不存在" }, { status: 404 });
    }
    const name = hasName ? requestedName : current.name;
    const parentId = hasParentId ? requestedParentId : current.parentId;
    const nameChanged = hasName && name !== current.name;
    const parentChanged = hasParentId && parentId !== current.parentId;

    if (current.isSystem && (nameChanged || parentChanged)) {
      return NextResponse.json({ ok: false, error: "系统内置类别，无法修改" }, { status: 409 });
    }

    if (parentId === id) {
      return NextResponse.json({ ok: false, error: "不能移动到自身下面" }, { status: 400 });
    }

    if (parentId) {
      const parent = await prisma.category.findFirst({
        where: { id: parentId, householdId },
        select: { id: true, type: true, parentId: true },
      });
      if (!parent) {
        return NextResponse.json({ ok: false, error: "上级分类不存在" }, { status: 404 });
      }
      if (parent.type !== current.type) {
        return NextResponse.json({ ok: false, error: "不能跨收支类型移动分类" }, { status: 400 });
      }

      let cursor: string | null = parent.parentId;
      while (cursor) {
        if (cursor === id) {
          return NextResponse.json({ ok: false, error: "不能移动到自己的子分类下面" }, { status: 400 });
        }
        const ancestor = await prisma.category.findFirst({
          where: { id: cursor, householdId },
          select: { parentId: true },
        });
        cursor = ancestor?.parentId ?? null;
      }
    }

    const duplicate = await findDuplicateCategoryName(householdId, name, id);
    if (duplicate) {
      return NextResponse.json({ ok: false, error: "分类名称已存在" }, { status: 409 });
    }

    const category = await prisma.$transaction(async (tx) => {
      const updated = await tx.category.update({
        where: { id },
        data: {
          ...(hasName && name !== current.name ? { name } : {}),
          ...(hasParentId && parentId !== current.parentId ? { parentId } : {}),
        },
        select: { id: true, name: true, type: true, parentId: true, isSystem: true },
      });
      if (hasName && name !== current.name) {
        await tx.txRecord.updateMany({
          where: { householdId, categoryId: id },
          data: { categoryName: name },
        });
      }
      return updated;
    });

    return NextResponse.json({ ok: true, category });
  } catch (e) {
    if (isDuplicateCategoryNameError(e)) {
      return NextResponse.json({ ok: false, error: "分类名称已存在" }, { status: 409 });
    }
    console.error("PUT /api/v1/category error:", e);
    return NextResponse.json({ ok: false, error: "修改失败" }, { status: 500 });
  }
}
