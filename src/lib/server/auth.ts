import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";

const USERNAME_KEY = "mmh_username";
const VERIFIED_KEY = "mmh_access_password_verified";

export type CurrentUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  householdId: string | null;
};

/**
 * 从 cookie 读取已验证登录态和 mmh_username，查 DB 得到当前登录用户。
 * 未登录或未完成密码验证时返回 null。
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const verified = cookieStore.get(VERIFIED_KEY)?.value === "ok";
  const username = cookieStore.get(USERNAME_KEY)?.value?.trim();

  if (!verified || !username) return null;

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