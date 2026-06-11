import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";

const LEGACY_PASSWORD_KEY = "access_password";

/**
 * GET /api/v1/auth/password-status
 * 检查系统是否有任何用户设置了密码（或旧 SystemSetting 密码）
 */
export async function GET() {
  const userWithPassword = await prisma.user.findFirst({
    where: { passwordHash: { not: null } },
  });
  const legacy = await prisma.systemSetting.findUnique({
    where: { key: LEGACY_PASSWORD_KEY },
  });
  const hasPassword = !!userWithPassword || (!!legacy && legacy.value.length > 0);
  const users = await prisma.user.findMany({
    select: { id: true, name: true, passwordHash: true, role: true, isSystem: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({
    ok: true,
    hasPassword,
    users: users.map(u => ({ ...u, hasPassword: !!u.passwordHash, passwordHash: undefined })),
  });
}

/**
 * POST /api/v1/auth/password-status
 * 为用户设置或修改密码，首次设置时创建 admin 用户
 * Body: { userId?: string, username?: string, password: string, currentPassword?: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { userId?: string; username?: string; password?: string; currentPassword?: string };
  const newPassword = (body.password ?? "").trim();
  const userId = body.userId?.trim();
  const username = (body.username ?? "").trim();

  // 查找目标用户
  let user = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : username
      ? await prisma.user.findFirst({ where: { name: username } })
      : null;

  // 如果没找到且指定了 username，创建新用户
  // 非 admin/system 用户需要分配 householdId
  if (!user && username) {
    const isSystemUser = username === "admin";
    let householdId: string | null = null;

    if (!isSystemUser) {
      const { hidFilter } = await getHouseholdScope();
      householdId = hidFilter.householdId;
    }

    user = await prisma.user.create({
      data: { name: username, role: isSystemUser ? "admin" : "user", isSystem: isSystemUser, householdId },
    });
  }

  if (!user) {
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 404 });
  }

  // 如果用户已有密码哈希，需要验证当前密码
  if (user.passwordHash) {
    const currentPassword = (body.currentPassword ?? "").trim();
    if (!currentPassword) {
      return NextResponse.json({ ok: false, error: "请输入当前密码" }, { status: 401 });
    }
    const match = await verifyPassword(currentPassword, user.passwordHash);
    if (!match) {
      return NextResponse.json({ ok: false, error: "当前密码错误" }, { status: 401 });
    }
  } else {
    // 迁移桥接：如果存在旧 SystemSetting 密码，需要先验证旧密码
    const legacy = await prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
    });
    if (legacy && legacy.value.length > 0) {
      const currentPassword = (body.currentPassword ?? "").trim();
      if (currentPassword !== legacy.value) {
        return NextResponse.json({ ok: false, error: "当前密码错误" }, { status: 401 });
      }
      // 删除旧密码（迁移完成）
      await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("操作失败", "route.ts"));
    }
  }

  if (newPassword) {
    const hashed = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashed },
    });
  } else {
    // 清除密码（不建议但允许）
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null },
    });
  }

  return NextResponse.json({ ok: true });
}