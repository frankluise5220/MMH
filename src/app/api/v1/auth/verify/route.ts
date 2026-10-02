import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { verifySensitiveOperationPassword } from "@/lib/server/sensitive-operation-auth";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";
import {
  LEGACY_ACCESS_PASSWORD_KEY,
  readLegacyAccessPassword,
  verifyUserCredential,
} from "@/lib/server/verify-credential";
import { getUserSessionDays, issueSessionCookies } from "@/lib/server/session-issue";

const LEGACY_PASSWORD_KEY = LEGACY_ACCESS_PASSWORD_KEY;
// SQLite may need to load the bundled native driver on the first desktop login.
// Keep the timeout bounded, but do not turn a cold start into a false 503.
const AUTH_LOOKUP_TIMEOUT_MS = 10000;

class AuthLookupTimeoutError extends Error {
  constructor() {
    super("Authentication lookup timed out");
    this.name = "AuthLookupTimeoutError";
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new AuthLookupTimeoutError()), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
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
  authVersion: true,
  householdId: true,
  email: true,
  registrationPrincipalId: true,
  fnosUid: true,
  Household: { select: { id: true, name: true } },
} as const;

type LoginUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  passwordHash: string | null;
  authVersion: number;
  householdId: string | null;
  email: string | null;
  registrationPrincipalId: string | null;
  fnosUid: string | null;
  Household: { id: string; name: string } | null;
};

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

async function resolveLoginCandidates(username: string, householdId: string, userId: string): Promise<LoginUser[]> {
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: userSelect,
    });
    if (!user) return [];
    if (householdId && user.householdId !== householdId) return [];
    return [user];
  }

  if (username && householdId) {
    const normalized = username.trim().toLowerCase();
    const user = await prisma.user.findFirst({
      where: { OR: [{ name: username }, { email: normalized }], householdId },
      select: userSelect,
    });
    return user ? [user] : [];
  }

  if (username) {
    const normalized = username.trim().toLowerCase();
    return prisma.user.findMany({
      where: { OR: [{ name: username }, { email: normalized }] },
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

/**
 * Verifies `password` against every same-name candidate.
 *
 * The per-account order (local password → fnOS → MMH membership password →
 * legacy deployment password) lives in `verifyUserCredential`, shared with
 * sensitive operations and the ledger-switch path. This function only adds the
 * multi-candidate aggregation the login form needs, because one username may
 * exist in several ledgers.
 */
async function findPasswordMatches(users: LoginUser[], password: string) {
  // One legacy read for the whole candidate set, and only when some candidate
  // actually lacks a per-user hash.
  const legacyPassword = users.some((user) => !user.passwordHash)
    ? await withTimeout(readLegacyAccessPassword(), AUTH_LOOKUP_TIMEOUT_MS)
    : "";
  const matches: Array<{ user: LoginUser; migrateLegacyPassword: boolean }> = [];

  for (const user of users) {
    const verdict = await verifyUserCredential(user, password, { legacyPassword });
    // A legacy match is migrated to a real per-user hash on the spot, so the
    // deployment password stops working as soon as someone logs in with it.
    if (verdict.ok) matches.push({ user, migrateLegacyPassword: verdict.kind === "legacy" });
  }

  return matches;
}

/**
 * Resolves the local ledger users bound to an MMH membership account.
 *
 * MMH login is verified against the central registration service (email +
 * membership password); the returned principalId is then used to find the local
 * user(s) that carry that registrationPrincipalId. A single MMH principal may
 * be bound to several ledgers, in which case the caller asks the user to choose.
 */
async function resolveMmhLoginUsers(email: string, password: string) {
  const verification = await verifyEmailPrincipal({ email, password });
  if (!verification.ok) {
    return {
      users: [] as LoginUser[],
      error: verification,
    };
  }
  const principalId = verification.principalId;
  if (!principalId) {
    return {
      users: [] as LoginUser[],
      error: { ok: false as const, status: 502, code: "MMH_PRINCIPAL_MISSING", error: "The MMH account has no principal id." },
    };
  }
  const users = await withTimeout(
    prisma.user.findMany({
      where: { registrationPrincipalId: principalId },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    }),
    AUTH_LOOKUP_TIMEOUT_MS,
  );
  return { users, error: null };
}

/** Signs a verified login session and returns the response. */
async function issueSessionResponse(req: NextRequest, user: LoginUser) {
  const response = NextResponse.json({ ok: true, username: user.name, householdId: user.householdId });
  issueSessionCookies(
    response,
    {
      userId: user.id,
      name: user.name,
      householdId: user.householdId,
      authVersion: user.authVersion,
    },
    { sessionDays: await getUserSessionDays(user.id), req },
  );
  return response;
}

/**
 * Handles MMH membership login: email + membership password against the central
 * registration service. Returns the session response on success, or the error
 * (INVALID_CREDENTIALS / PASSWORD_NOT_SET / registration service errors) /
 * AMBIGUOUS_USER when several ledgers share the same MMH principal.
 */
async function handleMmhLogin(req: NextRequest, email: string, password: string, householdId: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "请输入 MMH 账户邮箱" }, { status: 401 });
  }

  let resolved: Awaited<ReturnType<typeof resolveMmhLoginUsers>>;
  try {
    resolved = await resolveMmhLoginUsers(normalizedEmail, password);
  } catch (error) {
    if (error instanceof AuthLookupTimeoutError) {
      return NextResponse.json({ ok: false, code: "AUTH_SERVICE_UNAVAILABLE", error: "认证服务暂时不可用，请稍后重试" }, { status: 503 });
    }
    logger.error("MMH 登录查询失败", "auth/verify", error);
    return NextResponse.json({ ok: false, code: "AUTH_DATABASE_ERROR", error: "认证数据库初始化失败，请查看应用日志" }, { status: 503 });
  }

  if (resolved.error) {
    const err = resolved.error;
    return NextResponse.json(
      { ok: false, code: err.code ?? "MMH_LOGIN_FAILED", error: err.error ?? "MMH 账户验证失败" },
      { status: err.status ?? 401 },
    );
  }

  const users = resolved.users;
  if (users.length === 0) {
    return NextResponse.json({ ok: false, code: "MMH_USER_NOT_BOUND", error: "该 MMH 账户未绑定任何账簿" }, { status: 404 });
  }

  if (users.length > 1 && !householdId) {
    return ambiguousUsernameResponse(users);
  }

  const user = householdId
    ? users.find((u) => u.householdId === householdId) ?? null
    : users[0];
  if (!user) {
    return NextResponse.json({ ok: false, code: "MMH_USER_NOT_BOUND", error: "该 MMH 账户未绑定该账簿" }, { status: 404 });
  }

  return issueSessionResponse(req, user);
}

/**
 * POST /api/v1/auth/verify
 * Verify a password for login or privileged system actions.
 *
 * Body: { password: string, userId?: string, username?: string, householdId?: string, verifySystem?: boolean }
 * - verifySystem=true verifies that the current session user is an admin and that
 *   `password` matches that user's own password. It is used for sensitive
 *   operations such as system initialization and deleting ledgers, and does not
 *   create a user session. Deployment-level database/system passwords are not
 *   accepted for this verification.
 * - userId verifies that exact user. This is preferred for Web login when
 *   multiple ledgers contain same-name users such as admin.
 * - username + householdId verifies that exact user inside the target household.
 * - username only verifies all same-name users first. If exactly one household's
 *   password matches, that user logs in directly. If multiple households match
 *   the same username/password, the API returns
 *   { ok:false, code:"AMBIGUOUS_USER", error, households }.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { password?: string; userId?: string; username?: string; householdId?: string; verifySystem?: boolean; authMode?: string };
  const password = (body.password ?? "").trim();
  const userId = (body.userId ?? "").trim();
  const username = (body.username ?? "").trim();
  const householdId = (body.householdId ?? "").trim();
  const authMode = (body.authMode ?? "local").trim().toLowerCase();

  if (!password) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "请输入密码" }, { status: 400 });
  }

  if (body.verifySystem) {
    try {
      const currentUser = await getCurrentUser();
      if (!currentUser || !isAdmin(currentUser)) {
        return NextResponse.json(
          { ok: false, code: currentUser ? "FORBIDDEN" : "UNAUTHORIZED", error: currentUser ? "Administrator access is required." : "Sign in required." },
          { status: currentUser ? 403 : 401 },
        );
      }
      const verified = await verifySensitiveOperationPassword(password);
      if (!verified.ok) {
        return NextResponse.json({ ok: false, code: verified.code ?? "AUTH_VERIFICATION_FAILED", error: verified.error }, { status: verified.status });
      }
      return NextResponse.json({ ok: true, systemVerified: true });
    } catch {
      return NextResponse.json({ ok: false, code: "SYSTEM_CONFIG_ERROR", error: "系统配置错误" }, { status: 500 });
    }
  }

  // MMH membership login: verify the email + membership password against the
  // central registration service, then map the principalId to local user(s).
  if (authMode === "mmh") {
    return handleMmhLogin(req, username, password, householdId);
  }

  let candidates: LoginUser[];
  try {
    candidates = await withTimeout(resolveLoginCandidates(username, householdId, userId), AUTH_LOOKUP_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof AuthLookupTimeoutError) {
      return NextResponse.json({ ok: false, code: "AUTH_SERVICE_UNAVAILABLE", error: "认证服务暂时不可用，请稍后重试" }, { status: 503 });
    }
    logger.error("认证用户查询失败", "auth/verify", error);
    return NextResponse.json({ ok: false, code: "AUTH_DATABASE_ERROR", error: "认证数据库初始化失败，请查看应用日志" }, { status: 503 });
  }

  if (candidates.length === 0) {
    const anyUser = await prisma.user.findFirst({ select: { id: true } });
    if (!anyUser) {
      return NextResponse.json({ ok: false, code: "ADMIN_PASSWORD_NOT_SET", error: "请先设置管理员密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 401 });
  }

  const matches = await findPasswordMatches(candidates, password);
  if (matches.length === 0) {
    // A ledger where nobody has a password yet is "not set up", not "wrong
    // password". Keep that distinction, and call out a fnOS binding separately
    // because its fix is different: the password has to be created from inside
    // the ledger (the gateway exposes no password API to verify against).
    if (candidates.some((user) => !user.passwordHash)) {
      const hasAnyPassword = candidates.some((user) => user.passwordHash);
      if (!hasAnyPassword) {
        return NextResponse.json(
          candidates.some((user) => user.fnosUid)
            ? { ok: false, code: "LOCAL_PASSWORD_REQUIRED", error: "该飞牛账户尚未建立本地密码，请先使用飞牛账户登录，再在用户设置中设置本地密码。" }
            : { ok: false, code: "PASSWORD_NOT_SET", error: "请先设置密码" },
          { status: 400 },
        );
      }
    }
    return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "密码错误" }, { status: 401 });
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

  return issueSessionResponse(req, user);
}
