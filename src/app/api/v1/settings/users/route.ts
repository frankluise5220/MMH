import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

function requireAdmin(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user) return { ok: false as const, error: "未登录", status: 401 };
  if (!isAdmin(user)) return { ok: false as const, error: "需要管理员权限", status: 403 };
  return { ok: true as const };
}

/** GET /api/v1/settings/users — 返回当前账簿内的所有用户 */
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    const auth = requireAdmin(currentUser);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: cors() });

    const { householdId, user } = await getHouseholdScope();
    const orFilters: Array<Record<string, unknown>> = [
      { householdId },
      { isSystem: true },
    ];
    if (isAdmin(user)) {
      orFilters.push({ householdId: null });
    }
    const where = { OR: orFilters };

    let users: Array<{
      id: string;
      name: string;
      email: string | null;
      role: string;
      isSystem: boolean;
      passwordHash: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    try {
      users = await prisma.user.findMany({
        where,
        orderBy: { name: "asc" },
        select: { id: true, name: true, email: true, role: true, isSystem: true, passwordHash: true, createdAt: true, updatedAt: true },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const looksLikeMissingEmailColumn = msg.toLowerCase().includes("email") && (msg.toLowerCase().includes("does not exist") || msg.toLowerCase().includes("unknown column") || msg.toLowerCase().includes("column"));
      if (looksLikeMissingEmailColumn) {
        const fallback = await prisma.user.findMany({
          where,
          orderBy: { name: "asc" },
          select: { id: true, name: true, role: true, isSystem: true, passwordHash: true, createdAt: true, updatedAt: true },
        });
        users = fallback.map((u) => ({ ...u, email: null }));
      } else {
        throw error;
      }
    }

    if (users.length === 0) {
      const householdCount = await prisma.household.count();
      if (householdCount <= 1) {
        const legacyUsers = await prisma.user.findMany({
          where: {
            householdId: null,
            isSystem: false,
          },
          select: { id: true },
        });
        if (legacyUsers.length > 0) {
          await prisma.user.updateMany({
            where: {
              id: { in: legacyUsers.map((item) => item.id) },
              householdId: null,
            },
            data: { householdId },
          });
          users = await prisma.user.findMany({
            where,
            orderBy: { name: "asc" },
            select: { id: true, name: true, email: true, role: true, isSystem: true, passwordHash: true, createdAt: true, updatedAt: true },
          });
        }
      }
    }

    return NextResponse.json({
      ok: true,
      users: users.map(u => ({ ...u, hasPassword: !!u.passwordHash, passwordHash: undefined })),
    }, { headers: cors() });
  } catch {
    return NextResponse.json({ ok: false, error: "服务器错误" }, { status: 500, headers: cors() });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  role: z.enum(["admin", "user"]).default("user"),
  password: z.string().optional(),
});

/** POST /api/v1/settings/users — 在当前账簿内创建用户 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const auth = requireAdmin(currentUser);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: cors() });

  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "缺少必填字段（name）" }, { status: 400, headers: cors() });
  }

  const { name, role, password, email } = parse.data;

  // 检查当前账簿内同名用户是否已存在
  const existing = await prisma.user.findFirst({ where: { name, householdId } });
  if (existing) {
    return NextResponse.json({ ok: false, error: "用户名已存在" }, { status: 409, headers: cors() });
  }

  const data: { name: string; role: string; householdId: string; email?: string; passwordHash?: string } = { name, role, householdId };
  if (email != null) data.email = email.trim() ? email.trim() : undefined;
  if (password && password.trim()) {
    data.passwordHash = await hashPassword(password.trim());
  }

  const user = await prisma.user.create({
    data,
    select: { id: true, name: true, email: true, role: true, isSystem: true, createdAt: true, updatedAt: true },
  });

  return NextResponse.json({ ok: true, user }, { headers: cors() });
}

const UpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  role: z.enum(["admin", "user"]).optional(),
  password: z.string().optional(),
});

/** PUT /api/v1/settings/users — 更新当前账簿内的用户 */
export async function PUT(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const auth = requireAdmin(currentUser);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: cors() });

  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = UpdateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, error: "缺少必填字段（id）" }, { status: 400, headers: cors() });
  }

  const { id, name, role, password, email } = parse.data;

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 404, headers: cors() });
  }

  // 越权检查：用户不属于当前账簿
  if (existing.householdId !== householdId && !existing.isSystem) {
    return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403, headers: cors() });
  }

  // 最后一个管理员不可降级为 user
  if (role === "user" && existing.role === "admin" && !existing.isSystem) {
    const adminCount = await prisma.user.count({ where: { householdId, role: "admin" } });
    if (adminCount <= 1) {
      return NextResponse.json({ ok: false, error: "不能将最后一个管理员降级为普通用户" }, { status: 409, headers: cors() });
    }
  }

  const data: { name?: string; email?: string | null; role?: string; passwordHash?: string | null } = {};
  if (name) data.name = name;
  if (email != null) data.email = email.trim() ? email.trim() : null;
  if (role) data.role = role;
  if (password && password.trim()) {
    data.passwordHash = await hashPassword(password.trim());
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: false, error: "没有需要更新的字段" }, { status: 400, headers: cors() });
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, name: true, email: true, role: true, isSystem: true, createdAt: true, updatedAt: true },
  });

  return NextResponse.json({ ok: true, user }, { headers: cors() });
}

/** DELETE /api/v1/settings/users?id=xxx — 删除当前账簿内的用户 */
export async function DELETE(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const auth = requireAdmin(currentUser);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status, headers: cors() });

  const { householdId } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400, headers: cors() });
  }

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 404, headers: cors() });
  }

  // 越权检查：用户不属于当前账簿
  if (existing.householdId !== householdId && !existing.isSystem) {
    return NextResponse.json({ ok: false, error: "越权操作" }, { status: 403, headers: cors() });
  }

  // 系统用户不可删除
  if (existing.isSystem) {
    return NextResponse.json({ ok: false, error: "系统用户不可删除" }, { status: 403, headers: cors() });
  }

  // 不能删除当前账簿内的最后一个管理员
  const adminCount = await prisma.user.count({ where: { householdId, role: "admin" } });
  if (existing.role === "admin" && adminCount <= 1) {
    return NextResponse.json({ ok: false, error: "不能删除最后一个管理员" }, { status: 409, headers: cors() });
  }

  await prisma.user.delete({ where: { id } });

  return NextResponse.json({ ok: true }, { headers: cors() });
}
