import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import {
  HOUSEHOLD_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
} from "@/lib/server/session-cookies";

export type CurrentUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  householdId: string | null;
};

const currentUserSelect = {
  id: true,
  name: true,
  role: true,
  isSystem: true,
  householdId: true,
} as const;

const USER_LOOKUP_TIMEOUT_MS = 5000;

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

/**
 * Read the verified login cookies and resolve the current database user.
 *
 * If householdId is present, username is resolved inside that household.
 * Without householdId, username-only lookup is accepted only when it is unique
 * across the whole database; otherwise the session is treated as ambiguous.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const verified = cookieStore.get(VERIFIED_COOKIE)?.value === "ok";
  const username = cookieStore.get(USERNAME_COOKIE)?.value?.trim();
  const householdId = cookieStore.get(HOUSEHOLD_COOKIE)?.value?.trim();

  if (!verified) return null;

  if (username && householdId) {
    return await withTimeout(prisma.user.findFirst({
      where: { name: username, householdId },
      select: currentUserSelect,
    }), USER_LOOKUP_TIMEOUT_MS);
  }

  if (!username && householdId) {
    const householdAdmin = await withTimeout(prisma.user.findFirst({
      where: { householdId, OR: [{ role: "admin" }, { isSystem: true }] },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    }), USER_LOOKUP_TIMEOUT_MS);
    if (householdAdmin) return householdAdmin;

    return await withTimeout(prisma.user.findFirst({
      where: { householdId },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    }), USER_LOOKUP_TIMEOUT_MS);
  }

  if (!username) {
    const users = await withTimeout(prisma.user.findMany({
      select: currentUserSelect,
      take: 2,
      orderBy: { createdAt: "asc" },
    }), USER_LOOKUP_TIMEOUT_MS);
    if (!users) return null;
    return users.length === 1 ? users[0] : null;
  }

  const users = await withTimeout(prisma.user.findMany({
    where: { name: username },
    select: currentUserSelect,
    take: 2,
    orderBy: { createdAt: "asc" },
  }), USER_LOOKUP_TIMEOUT_MS);
  if (!users) return null;

  return users.length === 1 ? users[0] : null;
}

/**
 * 判断用户是否为管理员（admin 角色或 isSystem 标记）。
 * 管理员可以访问所有账簿数据。
 */
export function isAdmin(user: CurrentUser | null): boolean {
  if (!user) return false;
  return user.role === "admin" || user.isSystem === true;
}
