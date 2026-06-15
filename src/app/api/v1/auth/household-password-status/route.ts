import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser } from "@/lib/server/auth";

/**
 * GET /api/v1/auth/household-password-status
 * 查询当前账簿的管理员用户是否已设置密码
 *
 * 返回 { ok, hasPassword, adminUser }
 * - hasPassword: 当前账簿至少有一个管理员设置了密码
 * - adminUser: 当前账簿的第一个管理员用户信息（用于引导设置密码）
 *
 * 注意：如果用户未登录（无 mmh_username cookie），
 * 说明用户正在登录页面，此时不触发账簿级密码引导（登录页有自己的设置流程）。
 */
export async function GET() {
  // 用户未登录时，不触发账簿级密码引导（登录页有自己的设置流程）
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: true, hasPassword: true, adminUser: null });
  }

  const { householdId } = await getHouseholdScope();

  const adminUsers = await prisma.user.findMany({
    where: {
      householdId, role: "admin",
    },
    select: { id: true, name: true, passwordHash: true },
    orderBy: { createdAt: "asc" },
  });

  // 也检查 isSystem 系统管理员（householdId=null），他们属于所有账簿
  const systemAdmins = await prisma.user.findMany({
    where: { isSystem: true, role: "admin" },
    select: { id: true, name: true, passwordHash: true },
    orderBy: { createdAt: "asc" },
  });

  const allAdmins = [...adminUsers, ...systemAdmins];
  const hasPassword = allAdmins.some(u => !!u.passwordHash);
  const adminUser = allAdmins.length > 0
    ? { id: allAdmins[0].id, name: allAdmins[0].name }
    : null;

  return NextResponse.json({ ok: true, hasPassword, adminUser });
}