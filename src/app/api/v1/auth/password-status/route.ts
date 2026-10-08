import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { readGatewayFnosIdentity } from "@/lib/server/gateway-identity";
import { cookies } from "next/headers";
import { hasEmailService } from "@/lib/mail/passwordReset";
import { createDefaultCategoriesForHousehold } from "@/lib/default-categories";
import { createDefaultInstitutionsForHousehold } from "@/lib/default-institutions";
import { getDefaultTradingCalendarForAccount } from "@/lib/fund/trading-calendar";

const LEGACY_PASSWORD_KEY = "access_password";
const STATUS_LOOKUP_TIMEOUT_MS = 5000;
const PASSWORD_SET_RATE_LIMIT = 10;
const PASSWORD_SET_WINDOW_MS = 60 * 60 * 1000;
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

declare global {
  var __passwordStatusAttempts: Map<string, number[]> | undefined;
}

const passwordSetAttempts = globalThis.__passwordStatusAttempts ??= new Map<string, number[]>();

function getClientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || null;
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim() || null;
  return null;
}

function isPasswordSetRateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - PASSWORD_SET_WINDOW_MS;
  const recent = (passwordSetAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  passwordSetAttempts.set(ip, recent);
  return recent.length >= PASSWORD_SET_RATE_LIMIT;
}

function recordPasswordSetAttempt(ip: string) {
  const now = Date.now();
  const windowStart = now - PASSWORD_SET_WINDOW_MS;
  const recent = (passwordSetAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  recent.push(now);
  passwordSetAttempts.set(ip, recent);
}

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

function degradedStatusResponse() {
  const response = NextResponse.json({
    ok: true,
    degraded: true,
    hasPassword: true,
    needsInitialLedgerSetup: false,
    fnosBound: false,
    fnosHouseholdIds: [],
    passwordResetEnabled: false,
    users: [],
  });
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function statusJson(body: unknown) {
  const response = NextResponse.json(body);
  for (const [key, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function selectLoginUsers(householdId?: string) {
  return prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      passwordHash: true,
      role: true,
      isSystem: true,
      registrationPrincipalId: true,
      householdId: true,
      Household: { select: { name: true } },
    },
    where: householdId
      ? {
          OR: [
            { isSystem: true },
            { householdId },
          ],
        }
      : undefined,
    orderBy: { name: "asc" },
  });
}

async function ensureInitialHousehold(adminName: string) {
  const ownerName = adminName.trim() || "admin";
  let household = await prisma.household.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
  let createdHousehold = false;

  if (!household) {
    household = await prisma.household.create({ data: { name: "默认" }, select: { id: true } });
    createdHousehold = true;
  }

  let defaultOwner = await prisma.accountGroup.findFirst({
    where: { householdId: household.id, name: ownerName },
    select: { id: true },
  });
  if (!defaultOwner) {
    const groupCount = await prisma.accountGroup.count({ where: { householdId: household.id } });
    defaultOwner = await prisma.accountGroup.create({
      data: { name: ownerName, householdId: household.id, sortOrder: groupCount },
      select: { id: true },
    });
  }

  const accountCount = await prisma.account.count({ where: { householdId: household.id } });
  if (accountCount === 0) {
    const defaultAccounts: { name: string; kind: string; investProductType?: string }[] = [
      { name: "现金钱包", kind: "cash" },
      { name: "银行储蓄", kind: "bank_debit" },
      { name: "投资账户", kind: "investment", investProductType: "fund" },
    ];
    for (const account of defaultAccounts) {
      await prisma.account.create({
        data: {
          name: account.name,
          kind: account.kind as any,
          groupId: defaultOwner.id,
          investProductType: account.investProductType as any,
          tradingCalendar: getDefaultTradingCalendarForAccount(account.kind, account.investProductType) as any,
          householdId: household.id,
          isActive: true,
          currency: "CNY",
        },
      });
    }
  }

  if (createdHousehold) {
    await createDefaultCategoriesForHousehold(prisma, household.id);
    await createDefaultInstitutionsForHousehold(prisma, household.id);
  }

  return household.id;
}

/**
 * GET /api/v1/auth/password-status
 * Checks whether any user has set a password (or the legacy SystemSetting password).
 * The returned user list is filtered by the current household:
 * - System users (isSystem=true) are not bound to a household and always shown.
 * - Regular users are shown only when they belong to the current householdId.
 * - If the household cookie is stale and filters all users out, the endpoint
 *   clears the stale cookie and falls back to the full login user list.
 *
 * Behind the fnOS gateway it also reports `fnosBound` plus `fnosHouseholdIds`:
 * the ledgers the forwarded gateway identity is bound in. The login page uses
 * them to open on a ledger that passwordless fnOS login can actually enter and
 * to warn when the selected ledger has no fnOS binding.
 */
export async function GET(req: NextRequest) {
  const cookieStore = await cookies();
  const householdId = cookieStore.get("householdId")?.value;
  // fnOS gateway identity, when present. It decides whether the login page may
  // open on the fnOS tab: that tab is the fastest way in, but only for a
  // gateway user that is actually bound to a ledger.
  const gatewayIdentity = readGatewayFnosIdentity(req.headers);
  const status = await withTimeout(Promise.all([
    prisma.household.count(),
    prisma.user.count(),
    prisma.user.findFirst({
      where: { passwordHash: { not: null } },
      select: { id: true },
    }),
    prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
      select: { value: true },
    }),
    selectLoginUsers(householdId),
    hasEmailService(householdId ?? undefined),
    // Every ledger user bound to this gateway identity, not just the first one:
    // the login page needs the whole set to tell whether the ledger currently
    // selected in the picker may be entered with fnOS passwordless login, and
    // to open on a ledger that this identity can actually get into.
    gatewayIdentity
      ? prisma.user.findMany({ where: { fnosUid: { in: gatewayIdentity.keys } }, select: { householdId: true } })
      : Promise.resolve([]),
  ]), STATUS_LOOKUP_TIMEOUT_MS);

  if (!status) {
    return degradedStatusResponse();
  }

  const [householdCount, userCount, userWithPassword, legacy, users, passwordResetEnabled, fnosBoundUsers] = status;
  const hasPassword = !!userWithPassword || (!!legacy && legacy.value.length > 0);
  const needsInitialLedgerSetup = householdCount === 0 && userCount === 0 && !hasPassword;
  // Whether the *current* fnOS gateway user owns a ledger user. Deliberately
  // independent of `hasPassword`: binding a local password must not demote the
  // fnOS passwordless login from its default position.
  const fnosBound = fnosBoundUsers.length > 0;
  // Ledgers this gateway identity may enter without a password. `null` means the
  // bound user sits in the system scope rather than in a ledger; the client maps
  // that to its own `__system__` scope id, so no literal is shared here.
  const fnosHouseholdIds = Array.from(new Set(fnosBoundUsers.map((user) => user.householdId)));
  let loginUsers = users;
  const shouldClearStaleHouseholdCookie = !!householdId && users.length === 0 && hasPassword && !needsInitialLedgerSetup;
  if (shouldClearStaleHouseholdCookie) {
    loginUsers = await selectLoginUsers();
  }

  const response = statusJson({
    ok: true,
    hasPassword,
    needsInitialLedgerSetup,
    fnosBound,
    fnosHouseholdIds,
    passwordResetEnabled,
    users: loginUsers.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      hasPassword: !!u.passwordHash,
      role: u.role,
      isSystem: u.isSystem,
      registrationPrincipalId: u.registrationPrincipalId,
      householdId: u.householdId,
      householdName: u.Household?.name ?? null,
    })),
  });
  if (shouldClearStaleHouseholdCookie) {
    response.cookies.set("householdId", "", { path: "/", maxAge: 0 });
  }
  return response;
}

/**
 * POST /api/v1/auth/password-status
 * Sets or changes a user's password; creates the admin user on first setup.
 * Body: { userId?: string, username?: string, password: string, currentPassword?: string }
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (ip && isPasswordSetRateLimited(ip)) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }
  recordPasswordSetAttempt(ip ?? "unknown");

  const body = await req.json() as { userId?: string; username?: string; password?: string; currentPassword?: string };
  const newPassword = (body.password ?? "").trim();
  const userId = body.userId?.trim();
  const username = (body.username ?? "").trim();

  // Find the target user
  let user = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : username
      ? await prisma.user.findFirst({ where: { name: username } })
      : null;

  // If not found and username is specified, creation is only allowed when the deployment has no users yet (global first setup) or under an admin session
  if (!user && username) {
    const anyExistingUser = await prisma.user.findFirst({ select: { id: true } });
    if (anyExistingUser) {
      const currentUser = await getCurrentUser();
      if (!currentUser || !isAdmin(currentUser)) {
        return NextResponse.json({ ok: false, code: "USER_CREATION_FORBIDDEN", error: "用户不存在，且当前无权创建用户" }, { status: 403 });
      }
    }
    const existingUser = await prisma.user.findFirst({ select: { id: true } });
    const isFirstUser = !existingUser;
    let householdId: string | null = null;

    const householdCount = isFirstUser ? await prisma.household.count() : 0;
    if (isFirstUser && householdCount === 0) {
      return NextResponse.json({ ok: false, code: "LEDGER_NOT_CREATED", error: "请先创建第一个账簿" }, { status: 400 });
    }

    if (isFirstUser) {
      householdId = await ensureInitialHousehold(username);
    } else if (username !== "admin") {
      const { hidFilter } = await getHouseholdScope();
      householdId = hidFilter.householdId;
    }

    user = await prisma.user.create({
      data: { name: username, role: isFirstUser ? "admin" : "user", isSystem: false, householdId },
    });
  }

  if (!user) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 404 });
  }

  // If the user already has a password hash, verify the current password
  if (user.passwordHash) {
    const currentPassword = (body.currentPassword ?? "").trim();
    if (!currentPassword) {
      return NextResponse.json({ ok: false, code: "CURRENT_PASSWORD_REQUIRED", error: "请输入当前密码" }, { status: 401 });
    }
    const match = await verifyPassword(currentPassword, user.passwordHash);
    if (!match) {
      return NextResponse.json({ ok: false, code: "INVALID_CURRENT_PASSWORD", error: "当前密码错误" }, { status: 401 });
    }
  } else {
    // Migration bridge: if a legacy SystemSetting password exists, verify the legacy password first
    const legacy = await prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
    });
    if (legacy && legacy.value.length > 0) {
      const currentPassword = (body.currentPassword ?? "").trim();
      if (currentPassword !== legacy.value) {
        return NextResponse.json({ ok: false, code: "INVALID_CURRENT_PASSWORD", error: "当前密码错误" }, { status: 401 });
      }
      // Delete the legacy password (migration complete)
      await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (user.passwordHash == null) {
      // Accounts with no password and no legacy password: only allowed during first setup
      // (no user has set a password yet) or under a logged-in session (e.g. a new ledger
      // admin setting their own password through the create-ledger session).
      const anyUserWithPassword = await prisma.user.findFirst({
        where: { passwordHash: { not: null } },
        select: { id: true },
      });
      if (anyUserWithPassword) {
        const currentUser = await getCurrentUser();
        const isSetupOwner = currentUser && (currentUser.id === user.id || isAdmin(currentUser));
        if (!isSetupOwner) {
          return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "当前账户尚未设置密码，请登录后再设置" }, { status: 403 });
        }
      }
    }
  }

  if (newPassword) {
    const hashed = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashed, authVersion: { increment: 1 } },
    });
  } else {
    // Clear the password (not recommended but allowed)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: null, authVersion: { increment: 1 } },
    });
  }

  return NextResponse.json({ ok: true });
}
