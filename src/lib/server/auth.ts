import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";

const USERNAME_KEY = "mmh_username";
const VERIFIED_KEY = "mmh_access_password_verified";
const HOUSEHOLD_KEY = "householdId";

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

/**
 * Read the verified login cookies and resolve the current database user.
 *
 * If householdId is present, username is resolved inside that household.
 * Without householdId, username-only lookup is accepted only when it is unique
 * across the whole database; otherwise the session is treated as ambiguous.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const verified = cookieStore.get(VERIFIED_KEY)?.value === "ok";
  const username = cookieStore.get(USERNAME_KEY)?.value?.trim();
  const householdId = cookieStore.get(HOUSEHOLD_KEY)?.value?.trim();

  if (!verified) return null;

  if (username && householdId) {
    return prisma.user.findFirst({
      where: { name: username, householdId },
      select: currentUserSelect,
    });
  }

  if (!username && householdId) {
    const householdAdmin = await prisma.user.findFirst({
      where: { householdId, OR: [{ role: "admin" }, { isSystem: true }] },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    });
    if (householdAdmin) return householdAdmin;

    return prisma.user.findFirst({
      where: { householdId },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    });
  }

  if (!username) {
    const users = await prisma.user.findMany({
      select: currentUserSelect,
      take: 2,
      orderBy: { createdAt: "asc" },
    });
    return users.length === 1 ? users[0] : null;
  }

  const users = await prisma.user.findMany({
    where: { name: username },
    select: currentUserSelect,
    take: 2,
    orderBy: { createdAt: "asc" },
  });

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
