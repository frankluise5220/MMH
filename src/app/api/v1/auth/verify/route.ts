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
const AUTH_LOOKUP_TIMEOUT_MS = 1500;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

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

function householdChoicesForUsers(users: LoginUser[]) {
  const seen = new Set<string>();
  return users
    .map((user) => ({
      id: user.householdId,
      name: getHouseholdDisplayName({ id: user.householdId, name: user.Household?.name }, "未命名账簿"),
    }))
    .filter((household): household is { id: string; name: string } => {
      if (!household.id || seen.has(household.id)) return false;
      seen.add(household.id);
      return true;
    });
}

function ambiguousUsernameResponse(users: LoginUser[]) {
  return NextResponse.json(
    {
      ok: false,
      code: "AMBIGUOUS_USER",
      error: "该用户名和密码匹配多个账簿，请选择要进入的账簿",
      households: householdChoicesForUsers(users),
    },
    { status: 409 },
  );
}

async function resolveLoginCandidates(username: string, householdId: string): Promise<LoginUser[]> {
  if (username && householdId) {
    const user = await prisma.user.findFirst({
      where: { name: username, householdId },
      select: userSelect,
    });
    return user ? [user] : [];
  }

  if (username) {
    return prisma.user.findMany({
      where: { name: username },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    });
  }

  if (householdId) {
    const user = await prisma.user.findFirst({
      where: { role: "admin", householdId },
      select: userSelect,
    });
    return user ? [user] : [];
  }

  const user = await prisma.user.findFirst({
    where: { name: "admin", isSystem: true },
    select: userSelect,
  });
  return user ? [user] : [];
}

async function findPasswordMatches(users: LoginUser[], password: string) {
  const legacySetting = users.some((user) => !user.passwordHash)
    ? await withTimeout(prisma.systemSetting.findUnique({ where: { key: LEGACY_PASSWORD_KEY } }), AUTH_LOOKUP_TIMEOUT_MS)
    : null;
  const legacyPassword = legacySetting?.value ?? "";
  const matches: Array<{ user: LoginUser; migrateLegacyPassword: boolean }> = [];

  for (const user of users) {
    if (user.passwordHash) {
      const match = await verifyPassword(password, user.passwordHash);
      if (match) matches.push({ user, migrateLegacyPassword: false });
      continue;
    }
    if (legacyPassword.length > 0 && password === legacyPassword) {
      matches.push({ user, migrateLegacyPassword: true });
    }
  }

  return matches;
}

/**
 * POST /api/v1/auth/verify
 * Verify a password for login or privileged system actions.
 *
 * Body: { password: string, username?: string, householdId?: string, verifySystem?: boolean }
 * - verifySystem=true verifies the DATABASE_URL password and does not create a user session.
 * - username + householdId verifies that exact user inside the target household.
 * - username only verifies all same-name users first. If exactly one household's
 *   password matches, that user logs in directly. If multiple households match
 *   the same username/password, the API returns
 *   { ok:false, code:"AMBIGUOUS_USER", error, households }.
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

  const candidates = await withTimeout(resolveLoginCandidates(username, householdId), AUTH_LOOKUP_TIMEOUT_MS);
  if (!candidates) {
    return NextResponse.json({ ok: false, error: "认证服务暂时不可用，请稍后重试" }, { status: 503 });
  }

  if (candidates.length === 0) {
    const anyUser = await prisma.user.findFirst({ select: { id: true } });
    if (!anyUser) {
      return NextResponse.json({ ok: false, error: "请先设置管理员密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "用户不存在" }, { status: 401 });
  }

  const matches = await findPasswordMatches(candidates, password);
  if (matches.length === 0) {
    if (candidates.some((user) => !user.passwordHash)) {
      const hasAnyPassword = candidates.some((user) => user.passwordHash);
      if (!hasAnyPassword) return NextResponse.json({ ok: false, error: "请先设置密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "密码错误" }, { status: 401 });
  }
  if (matches.length > 1 && !householdId) {
    return ambiguousUsernameResponse(matches.map((match) => match.user));
  }

  const { user, migrateLegacyPassword } = matches[0];
  if (migrateLegacyPassword) {
    const hashed = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashed },
    });
    await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("删除旧密码失败", "route.ts"));
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
