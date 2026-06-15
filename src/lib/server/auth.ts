import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";

const USERNAME_KEY = "mmh_username";

export type CurrentUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  householdId: string | null;
};

/**
 * 从 cookie 读取 mmh_username，查 DB 得到当前登录用户。
 * 未登录时返回 null。
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const username = cookieStore.get(USERNAME_KEY)?.value;

  if (!username) return null;

  const user = await prisma.user.findFirst({
    where: { name: username },
    select: { id: true, name: true, role: true, isSystem: true, householdId: true },
  });

  return user;
}

/**
 * 判断用户是否为管理员（admin 角色 或 isSystem 标记）。
 * 管理员可以访问所有账簿数据。
 */
export function isAdmin(user: CurrentUser | null): boolean {
  if (!user) return false;
  return user.role === "admin" || user.isSystem === true;
}