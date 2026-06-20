import { cookies } from "next/headers";
import { cache } from "react";
import { prisma } from "@/lib/db/prisma";
import { createDefaultCategoriesForHousehold } from "@/lib/default-categories";
import { createDefaultInstitutionsForHousehold } from "@/lib/default-institutions";
import { getCurrentUser, isAdmin, type CurrentUser } from "@/lib/server/auth";

export type HouseholdContext = {
  householdId: string;
  hidFilter: { householdId: string };
  user: CurrentUser | null;
};

export function belongsToHousehold(record: { householdId?: string | null } | null | undefined, ctx: HouseholdContext): boolean {
  return !!record && record.householdId === ctx.householdId;
}

export function assertBelongsToHousehold(record: { householdId?: string | null } | null | undefined, ctx: HouseholdContext, label = "记录") {
  if (!record) return { ok: false as const, error: `${label}不存在`, status: 404 };
  if (!belongsToHousehold(record, ctx)) return { ok: false as const, error: `${label}不属于当前账簿`, status: 403 };
  return { ok: true as const };
}

/**
 * 从 cookie 读取 householdId，结合当前用户身份验证权限：
 * - admin 用户：cookie 中的 householdId 只要存在即可，否则回退到 DB 第一个 household
 * - 普通用户：只允许访问自己 householdId 对应的账簿
 * 如果 DB 中没有任何 Household，自动创建默认账簿（含默认分组、账户、分类）。
 * 返回 HouseholdContext，householdId 始终为 string，hidFilter 始终非空。
 */
export async function getHouseholdScope(): Promise<HouseholdContext> {
  const user = await getCurrentUser();
  const cookieStore = await cookies();
  const raw = cookieStore.get("householdId")?.value;

  // admin 用户：cookie 中的 householdId 只要存在即可
  if (isAdmin(user)) {
    if (raw) {
      const h = await prisma.household.findUnique({ where: { id: raw }, select: { id: true } });
      if (h) return { householdId: h.id, hidFilter: { householdId: h.id }, user };
    }
    const first = await prisma.household.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
    if (first) return { householdId: first.id, hidFilter: { householdId: first.id }, user };
    return ensureHouseholdForUser(user);
  }

  // 普通用户：只能访问自己 householdId 对应的账簿
  if (user?.householdId) {
    // 如果 cookie 和用户的 householdId 一致，使用 cookie
    if (raw === user.householdId) {
      const h = await prisma.household.findUnique({ where: { id: raw }, select: { id: true } });
      if (h) return { householdId: h.id, hidFilter: { householdId: h.id }, user };
    }
    // 回退到用户的 householdId
    const h = await prisma.household.findUnique({ where: { id: user.householdId }, select: { id: true } });
    if (h) return { householdId: h.id, hidFilter: { householdId: h.id }, user };
  }

  // 普通用户未分配 householdId → 分配已有账簿
  return ensureHouseholdForUser(user);
}

async function ensureHouseholdForUser(user: CurrentUser | null): Promise<HouseholdContext> {
  // 普通用户未分配 householdId → 先查 DB 是否已有账簿，有则分配
  const existing = await prisma.household.findFirst({ select: { id: true }, orderBy: { createdAt: "asc" } });
  if (existing) {
    if (user && !user.householdId) {
      await prisma.user.update({ where: { id: user.id }, data: { householdId: existing.id } });
    }
    return { householdId: existing.id, hidFilter: { householdId: existing.id }, user };
  }

  // DB 完全空 → 创建初始账簿
  const household = await prisma.household.create({ data: { name: "默认" } });

  // 创建默认管理员用户
  await prisma.user.create({
    data: {
      name: "管理员",
      role: "admin",
      isSystem: false,
      householdId: household.id,
    },
  });

  const defaultGroups = [
    { name: "银行", sortOrder: 0 },
    { name: "信用卡", sortOrder: 1 },
    { name: "第三方支付", sortOrder: 2 },
    { name: "投资", sortOrder: 3 },
    { name: "现金", sortOrder: 4 },
  ];
  const groupRecords: { id: string; name: string }[] = [];
  for (const g of defaultGroups) {
    const created = await prisma.accountGroup.create({
      data: { ...g, householdId: household.id },
    });
    groupRecords.push(created);
  }
  const investGroupId = groupRecords.find(g => g.name === "投资")!.id;

  const defaultAccounts: { name: string; kind: string; groupId: string; investProductType?: string }[] = [
    { name: "现金钱包", kind: "cash", groupId: groupRecords.find(g => g.name === "现金")!.id },
    { name: "银行储蓄", kind: "bank_debit", groupId: groupRecords.find(g => g.name === "银行")!.id },
    { name: "投资账户", kind: "investment", groupId: investGroupId, investProductType: "fund" },
  ];
  for (const a of defaultAccounts) {
    await prisma.account.create({
      data: { name: a.name, kind: a.kind as any, groupId: a.groupId, investProductType: a.investProductType as any, householdId: household.id, isActive: true, currency: "CNY" },
    });
  }

  await createDefaultCategoriesForHousehold(prisma, household.id);
  await createDefaultInstitutionsForHousehold(prisma, household.id);

  if (user && !user.householdId) {
    await prisma.user.update({ where: { id: user.id }, data: { householdId: household.id } });
  }

  return { householdId: household.id, hidFilter: { householdId: household.id }, user };
}

/** 请求级缓存版本：同一 HTTP 请求内只执行一次，消除 page.tsx + Sidebar.tsx 重复调用 */
export const getCachedHouseholdScope = cache(getHouseholdScope);