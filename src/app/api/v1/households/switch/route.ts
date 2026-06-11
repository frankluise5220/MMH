import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

/**
 * POST /api/v1/households/switch
 * 切换当前活跃账簿（设置 householdId cookie）
 *
 * Body: { householdId: string, username?: string, password?: string }
 * 当前系统管理员可切换到任意账簿；普通用户切换到其他账簿时，必须提供目标账簿管理员用户名和密码。
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const householdId = String(body.householdId ?? "").trim();
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!householdId) {
    return NextResponse.json({ ok: false, error: "缺少 householdId" }, { status: 400 });
  }

  const exists = await prisma.household.findUnique({ where: { id: householdId } });
  if (!exists) {
    return NextResponse.json({ ok: false, error: "账簿不存在" }, { status: 404 });
  }

  // 权限验证：当前管理员可直接切换；普通用户切换到非当前账簿时，必须验证目标账簿管理员凭证。
  if (!isAdmin(user) && user.householdId !== householdId) {
    if (!username || !password) {
      return NextResponse.json({ ok: false, error: "请先输入目标账簿管理员用户名和密码" }, { status: 403 });
    }
    const namedTargetUser = await prisma.user.findFirst({
      where: { name: username, householdId, role: "admin" },
      select: { passwordHash: true },
    });
    const targetUser = namedTargetUser ?? await prisma.user.findFirst({
      where: { householdId, role: "admin" },
      select: { passwordHash: true },
    });
    if (!targetUser?.passwordHash) {
      return NextResponse.json({ ok: false, error: "目标账簿管理员不存在或未设置密码" }, { status: 401 });
    }
    const matched = await verifyPassword(password, targetUser.passwordHash);
    if (!matched) {
      return NextResponse.json({ ok: false, error: "目标账簿管理员密码错误" }, { status: 401 });
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("householdId", householdId, {
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
  });
  return res;
}