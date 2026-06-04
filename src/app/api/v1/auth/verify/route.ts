import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const VERIFIED_KEY = "wiseme_access_password_verified";
const USERNAME_KEY = "wiseme_username";
const LEGACY_PASSWORD_KEY = "access_password";

/**
 * POST /api/v1/auth/verify
 * 验证用户密码，支持旧 SystemSetting 密码自动迁移
 * Body: { password: string, username?: string }
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { password?: string; username?: string };
  const password = (body.password ?? "").trim();
  const username = (body.username ?? "").trim();

  if (!password) {
    return NextResponse.json({ ok: false, error: "请输入密码" }, { status: 400 });
  }

  // 查找用户
  let user = username
    ? await prisma.user.findFirst({ where: { name: username } })
    : null;

  // 如果未指定用户名或找不到用户，尝试查找 admin 用户作为默认
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
      await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(() => {});
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