import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { hashPassword } from "@/lib/auth/password";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }

  // 始终返回全部账簿（用于切换列表），isAdmin/isSystem 仍基于当前用户权限
  const households = await prisma.household.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const { householdId: activeId } = await getHouseholdScope();

  return NextResponse.json({
    ok: true,
    active: households.find(h => h.id === activeId) ?? households[0] ?? null,
    households,
    isAdmin: isAdmin(user),
    isSystem: user?.isSystem === true,
  });
}

/**
 * POST /api/v1/households
 * 创建新账簿（含默认账户组、账户、分类、管理员用户）
 *
 * Body: { name: string, adminName?: string, adminPassword?: string, adminEmail?: string }
 * - adminName: 管理员用户名，默认使用账簿名称
 * - adminPassword: 管理员密码（创建时立即哈希存储，不再延迟设置）
 * - adminEmail: 管理员邮箱（用于密码找回）
 * 非 admin 用户创建新账簿后，自动将用户关联到新账簿
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim();
  const adminName = String(body.adminName ?? name).trim();
  const adminPassword = String(body.adminPassword ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();

  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, error: "账簿名称不合法（1-50字）" }, { status: 400 });
  }
  if (!adminName || adminName.length > 50) {
    return NextResponse.json({ ok: false, error: "管理员用户名不合法（1-50字）" }, { status: 400 });
  }
  if (!adminPassword || adminPassword.length < 1) {
    return NextResponse.json({ ok: false, error: "请设置管理员密码" }, { status: 400 });
  }
  if (!adminEmail) {
    return NextResponse.json({ ok: false, error: "请输入邮箱" }, { status: 400 });
  }

  const household = await prisma.household.create({
    data: { name },
  });

  // 创建默认账户组
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
  const bankGroupId = groupRecords.find(g => g.name === "银行")!.id;
  const investGroupId = groupRecords.find(g => g.name === "投资")!.id;

  // 创建默认账户
  const defaultAccounts: { name: string; kind: string; groupId: string; investProductType?: string }[] = [
    { name: "现金钱包", kind: "cash", groupId: groupRecords.find(g => g.name === "现金")!.id },
    { name: "银行储蓄", kind: "bank_debit", groupId: bankGroupId },
    { name: "投资账户", kind: "investment", groupId: investGroupId, investProductType: "fund" },
  ];
  for (const a of defaultAccounts) {
    await prisma.account.create({
      data: { name: a.name, kind: a.kind as any, groupId: a.groupId, investProductType: a.investProductType as any, householdId: household.id, isActive: true, currency: "CNY" },
    });
  }

  // 创建默认分类模板
  const defaultCategories = [
    { type: "expense", name: "餐饮", parentId: null },
    { type: "expense", name: "交通", parentId: null },
    { type: "expense", name: "购物", parentId: null },
    { type: "expense", name: "居住", parentId: null },
    { type: "expense", name: "医疗", parentId: null },
    { type: "expense", name: "教育", parentId: null },
    { type: "expense", name: "娱乐", parentId: null },
    { type: "expense", name: "通讯", parentId: null },
    { type: "expense", name: "其他支出", parentId: null },
    { type: "income", name: "工资", parentId: null },
    { type: "income", name: "奖金", parentId: null },
    { type: "income", name: "投资收益", parentId: null },
    { type: "income", name: "其他收入", parentId: null },
  ];
  for (const cat of defaultCategories) {
    await prisma.category.create({
      data: { ...cat, householdId: household.id },
    });
  }

  // 为新账簿创建管理员用户（创建时即设置密码哈希）
  // 处理同名用户冲突：追加数字后缀
  let finalAdminName = adminName;
  const existingUser = await prisma.user.findFirst({ where: { name: finalAdminName } });
  if (existingUser) {
    let suffix = 1;
    while (await prisma.user.findFirst({ where: { name: `${adminName}_${suffix}` } })) {
      suffix++;
    }
    finalAdminName = `${adminName}_${suffix}`;
  }
  const passwordHash = await hashPassword(adminPassword);
  await prisma.user.create({
    data: {
      name: finalAdminName,
      role: "admin",
      isSystem: false,
      passwordHash,
      email: adminEmail,
      householdId: household.id,
    },
  });

  // 非 admin 用户创建新账簿 → 自动将用户的 householdId 更新为新账簿
  if (user && !isAdmin(user)) {
    await prisma.user.update({ where: { id: user.id }, data: { householdId: household.id } });
  }

  return NextResponse.json({ ok: true, household });
}

/**
 * PUT /api/v1/households
 * 管理员重命名账簿
 *
 * Body: { id: string, name: string }
 */
export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, error: "仅管理员可修改账簿" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  const name = String(body.name ?? "").trim();

  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
  }
  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, error: "账簿名称不合法（1-50字）" }, { status: 400 });
  }

  const existing = await prisma.household.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "账簿不存在" }, { status: 404 });
  }

  await prisma.household.update({ where: { id }, data: { name } });
  return NextResponse.json({ ok: true, household: { id, name } });
}

/**
 * DELETE /api/v1/households
 * 系统管理员删除账簿（最后一个账簿不可删除）
 *
 * Body: { id: string }
 * 权限：仅 isSystem 用户可删除
 * 约束：至少保留一个账簿
 */
export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();

  // 仅系统管理员可删除账簿
  if (!user || user.isSystem !== true) {
    return NextResponse.json({ ok: false, error: "仅系统管理员可删除账簿" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();

  if (!id) {
    return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
  }

  // 检查账簿是否存在
  const existing = await prisma.household.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, error: "账簿不存在" }, { status: 404 });
  }

  // 最后一个账簿不可删除
  const count = await prisma.household.count();
  if (count <= 1) {
    return NextResponse.json({ ok: false, error: "最后一个账簿不可删除，请至少保留一个账簿" }, { status: 400 });
  }

  // 级联删除：Household 删除后，关联的 Account, AccountGroup, Category, User 等也会被删除
  // 注意：Prisma schema 中 Household 的关联关系使用了 onDelete: Cascade（通过 @relation 隐式）
  // 但需要显式处理：先删除关联数据，再删除 household
  await prisma.$transaction(async (tx) => {
    // 先查出该账簿下所有账户 ID（后续多处复用）
    const accounts = await tx.account.findMany({ where: { householdId: id }, select: { id: true } });
    const accountIds = accounts.map(a => a.id);

    // 删除该账簿下的定投计划（通过 accountId，RegularInvestPlan.accountId 必填）
    if (accountIds.length > 0) {
      await tx.regularInvestPlan.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    // 删除该账簿下的标签
    await tx.tag.deleteMany({ where: { householdId: id } });
    // 删除该账簿下的机构
    await tx.institution.deleteMany({ where: { householdId: id } });
    // 删除该账簿下的导入批次
    await tx.importBatch.deleteMany({ where: { householdId: id } });
    // 删除该账簿下的基金查询API
    await tx.fundQueryApi.deleteMany({ where: { householdId: id } });
    // 级联删除账户关联数据
    if (accountIds.length > 0) {
      // 先删除持仓快照（依赖 fundHolding）
      await tx.fundSnapshot.deleteMany({ where: { accountId: { in: accountIds } } });
      // 删除持仓
      await tx.fundHolding.deleteMany({ where: { accountId: { in: accountIds } } });
      // 删除确认天数、费率、账单覆盖、信用卡周期
      await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.billOverride.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: { in: accountIds } } });
      // 删除交易记录
      await tx.txRecord.deleteMany({ where: { accountId: { in: accountIds } } });
      // 删除账户别名（通过 accountId）
      await tx.accountAlias.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    // 删除该账簿下的账户
    await tx.account.deleteMany({ where: { householdId: id } });
    // 删除该账簿下的账户组
    await tx.accountGroup.deleteMany({ where: { householdId: id } });
    // 删除该账簿下的分类
    await tx.category.deleteMany({ where: { householdId: id } });
    // 删除该账簿下的用户
    await tx.user.deleteMany({ where: { householdId: id } });
    // 最后删除账簿本身
    await tx.household.delete({ where: { id } });
  });

  return NextResponse.json({ ok: true });
}