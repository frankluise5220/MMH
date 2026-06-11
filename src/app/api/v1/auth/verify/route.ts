import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";

const VERIFIED_KEY = "wiseme_access_password_verified";
const USERNAME_KEY = "wiseme_username";
const LEGACY_PASSWORD_KEY = "access_password";

/**
 * POST /api/v1/auth/verify
 * 验证密码，支持两种模式：
 * 1. verifySystem=true: 验证数据库连接凭据（DATABASE_URL），用于新增/删除账簿等系统级操作
 * 2. 默认（bcrypt）: 验证指定用户的密码哈希，用于切换账簿时的管理员验证
 *
 * Body: { password: string, username?: string, householdId?: string, verifySystem?: boolean }
 * - householdId: 切换账簿时指定目标账簿ID，限定在目标账簿内查找用户，防止跨账簿用户混淆
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { password?: string; username?: string; householdId?: string; verifySystem?: boolean };
  const password = (body.password ?? "").trim();
  const username = (body.username ?? "").trim();
  const householdId = (body.householdId ?? "").trim();

  if (!password) {
    return NextResponse.json({ ok: false, error: "请输入密码" }, { status: 400 });
  }

  // 系统级验证：验证数据库连接凭据
  if (body.verifySystem) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return NextResponse.json({ ok: false, error: "系统配置错误" }, { status: 500 });
    }
    try {
      const url = new URL(dbUrl);
      const dbPass = decodeURIComponent(url.password);
      if (password !== dbPass) {
        return NextResponse.json({ ok: false, error: "数据库密码错误" }, { status: 401 });
      }
      return NextResponse.json({ ok: true, systemVerified: true });
    } catch {
      return NextResponse.json({ ok: false, error: "系统配置错误" }, { status: 500 });
    }
  }

  // 用户级验证：bcrypt 密码验证，限定在目标账簿内查找用户
  let user: { id: string; name: string; role: string; isSystem: boolean; passwordHash: string | null; householdId: string | null } | null = null;
  if (username && householdId) {
    // 切换账簿时：在目标账簿内按用户名查找
    user = await prisma.user.findFirst({ where: { name: username, householdId } });
  } else if (username) {
    // 未指定 householdId 时降级查找（保持兼容）
    user = await prisma.user.findFirst({ where: { name: username } });
  }

  // 如果未指定用户名或找不到用户，尝试查找 admin 用户作为默认（限定 householdId）
  if (!user && householdId) {
    user = await prisma.user.findFirst({ where: { role: "admin", householdId } });
  }
  if (!user) {
    user = await prisma.user.findFirst({ where: { name: "admin", isSystem: true } });
  }

  if (!user) {
    // 无任何用户时检查是否是全新系统
    const anyUser = await prisma.user.findFirst();
    if (!anyUser) {
      return NextResponse.json({ ok: false, error: "请先设置管理员密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 401 });
  }

  // 用户有密码哈希 → 直接验证
  if (user.passwordHash) {
    const match = await verifyPassword(password, user.passwordHash);
    if (!match) {
      return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
    }
  } else {
    // 用户无密码哈希 → 迁移桥接：检查旧 SystemSetting 密码
    const legacy = await prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
    });

    if (legacy && legacy.value.length > 0) {
      // 旧密码是明文存储的，直接比较
      if (password !== legacy.value) {
        return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
      }
      // 迁移：hash 密码 → 存到 user.passwordHash → 删除旧 SystemSetting
      const hashed = await hashPassword(password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: hashed },
      });
      await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("操作失败", "route.ts"));
    } else {
      // 无密码哈希也无旧密码 → 系统未设置密码，首次需要设置
      return NextResponse.json({ ok: false, error: "请先设置密码" }, { status: 400 });
    }
  }

  // 验证通过
  const effectiveUsername = username || user.name;
  const response = NextResponse.json({ ok: true, username: effectiveUsername });
  response.cookies.set(VERIFIED_KEY, "ok", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  response.cookies.set(USERNAME_KEY, effectiveUsername, {
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24,
  });
  return response;
}