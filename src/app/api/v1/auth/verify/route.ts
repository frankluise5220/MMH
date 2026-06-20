import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";
import { getHouseholdDisplayName } from "@/lib/household-display";

const VERIFIED_KEY = "mmh_access_password_verified";
const USERNAME_KEY = "mmh_username";
const HOUSEHOLD_KEY = "householdId";
const LEGACY_PASSWORD_KEY = "access_password";
const SESSION_DAYS_KEY = "mmh_session_days";

const userSelect = {
  id: true,
  name: true,
  role: true,
  isSystem: true,
  passwordHash: true,
  householdId: true,
  Household: { select: { id: true, name: true } },
} as const;

type LoginUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  passwordHash: string | null;
  householdId: string | null;
  Household: { id: string; name: string } | null;
};

function resolveSessionMaxAge(req: NextRequest) {
  const raw = req.cookies.get(SESSION_DAYS_KEY)?.value ?? "30";
  const days = Number(raw);
  const normalizedDays = Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 365) : 30;
  return normalizedDays * 24 * 60 * 60;
}

function ambiguousUsernameResponse(users: LoginUser[]) {
  return NextResponse.json(
    {
      ok: false,
      code: "AMBIGUOUS_USER",
      error: "该用户名存在于多个账簿，请先选择账簿后再登录",
      households: users.map((user) => ({
        id: user.householdId,
        name: getHouseholdDisplayName({ id: user.householdId, name: user.Household?.name }, "未命名账簿"),
      })).filter((household) => Boolean(household.id)),
    },
    { status: 409 },
  );
}

async function resolveLoginUser(username: string, householdId: string) {
  if (username && householdId) {
    return prisma.user.findFirst({
      where: { name: username, householdId },
      select: userSelect,
    });
  }

  if (username) {
    const users = await prisma.user.findMany({
      where: { name: username },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    });

    if (users.length > 1) {
      return ambiguousUsernameResponse(users);
    }

    return users[0] ?? null;
  }

  if (householdId) {
    return prisma.user.findFirst({
      where: { role: "admin", householdId },
      select: userSelect,
    });
  }

  return prisma.user.findFirst({
    where: { name: "admin", isSystem: true },
    select: userSelect,
  });
}

/**
 * POST /api/v1/auth/verify
 * Verify a password for login or privileged system actions.
 *
 * Body: { password: string, username?: string, householdId?: string, verifySystem?: boolean }
 * - verifySystem=true verifies the DATABASE_URL password and does not create a user session.
 * - username + householdId verifies that exact user inside the target household.
 * - username only verifies only when that username is unique across the whole database.
 *   If the same username exists in multiple households, the API returns
 *   { ok:false, code:"AMBIGUOUS_USER", error, households } and does not pick one silently.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { password?: string; username?: string; householdId?: string; verifySystem?: boolean };
  const password = (body.password ?? "").trim();
  const username = (body.username ?? "").trim();
  const householdId = (body.householdId ?? "").trim();

  if (!password) {
    return NextResponse.json({ ok: false, error: "请输入密码" }, { status: 400 });
  }

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

  const resolved = await resolveLoginUser(username, householdId);
  if (resolved instanceof NextResponse) {
    return resolved;
  }

  const user = resolved;
  if (!user) {
    const anyUser = await prisma.user.findFirst({ select: { id: true } });
    if (!anyUser) {
      return NextResponse.json({ ok: false, error: "请先设置管理员密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 401 });
  }

  if (user.passwordHash) {
    const match = await verifyPassword(password, user.passwordHash);
    if (!match) {
      return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
    }
  } else {
    const legacy = await prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
    });

    if (legacy && legacy.value.length > 0) {
      if (password !== legacy.value) {
        return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
      }

      const hashed = await hashPassword(password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: hashed },
      });
      await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("删除旧密码失败", "route.ts"));
    } else {
      return NextResponse.json({ ok: false, error: "请先设置密码" }, { status: 400 });
    }
  }

  const response = NextResponse.json({ ok: true, username: user.name, householdId: user.householdId });
  const maxAge = resolveSessionMaxAge(req);
  response.cookies.set(VERIFIED_KEY, "ok", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  response.cookies.set(USERNAME_KEY, user.name, {
    sameSite: "lax",
    path: "/",
    maxAge,
  });
  if (user.householdId) {
    response.cookies.set(HOUSEHOLD_KEY, user.householdId, {
      sameSite: "lax",
      path: "/",
      maxAge,
    });
  }
  return response;
}
