import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { createLedgerWithDefaults } from "@/lib/households/create-ledger";
import { optionalPrismaDeleteMany } from "@/lib/server/optional-prisma-delegate";
import { logger } from "@/lib/logger";

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
  const displayHouseholds = households.map((household) => ({
    ...household,
    name: getHouseholdDisplayName(household),
  }));
  const active = households.find(h => h.id === activeId) ?? households[0] ?? null;

  return NextResponse.json({
    ok: true,
    active: active ? { ...active, name: getHouseholdDisplayName(active) } : null,
    households: displayHouseholds,
    isAdmin: isAdmin(user),
    isSystem: user?.isSystem === true,
  });
}

/**
 * POST /api/v1/households
 * 创建新账簿（含默认所有人、账户、分类、管理员用户）
 *
 * Body: { name: string, adminName: string, adminPassword: string, adminEmail: string }
 * - adminName: 管理员用户名/默认家庭成员名，必须明确填写
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
  const adminName = String(body.adminName ?? "").trim();
  const adminPassword = String(body.adminPassword ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();

  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, error: "账簿名称不合法（1-50字）" }, { status: 400 });
  }
  if (!adminName || adminName.length > 50) {
    return NextResponse.json({ ok: false, error: "请填写管理员用户名（1-50字）" }, { status: 400 });
  }
  if (!adminPassword || adminPassword.length < 1) {
    return NextResponse.json({ ok: false, error: "请设置管理员密码" }, { status: 400 });
  }
  if (!adminEmail) {
    return NextResponse.json({ ok: false, error: "请输入邮箱" }, { status: 400 });
  }

  const { household } = await prisma.$transaction((tx) =>
    createLedgerWithDefaults(
      tx,
      { name, adminName, adminPassword, adminEmail },
      { currentUser: user },
    ),
  );

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

  try {
    await prisma.$transaction(async (tx) => {
      // 先查出该账簿下所有账户 ID（后续多处复用）
      const accounts = await tx.account.findMany({ where: { householdId: id }, select: { id: true } });
      const accountIds = accounts.map(a => a.id);

      // 删除该账簿下的定投计划（通过 accountId，RegularInvestPlan.accountId 必填）
      if (accountIds.length > 0) {
        await tx.regularInvestPlan.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      await tx.undoOperation.deleteMany({ where: { householdId: id } });
      // 删除该账簿下的基金查询API
      await tx.fundQueryApi.deleteMany({ where: { householdId: id } });
      await tx.entryBusinessLink.deleteMany({ where: { householdId: id } });
      await optionalPrismaDeleteMany(
        tx,
        "stockPriceCache",
        { where: { StockSecurity: { is: { householdId: id } } } },
        { tableNames: ["stock_price_cache", "stock_securities"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockTransaction",
        { where: { householdId: id } },
        { tableNames: ["stock_transactions"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockMarketFeeRule",
        { where: { householdId: id } },
        { tableNames: ["stock_market_fee_rules"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockHolding",
        { where: { householdId: id } },
        { tableNames: ["stock_holdings"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockSecurity",
        { where: { householdId: id } },
        { tableNames: ["stock_securities"] },
      );
      // 级联删除账户关联数据
      if (accountIds.length > 0) {
        // 删除持仓
        await tx.fundHolding.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.preciousMetalHolding.deleteMany({ where: { accountId: { in: accountIds } } });
        await optionalPrismaDeleteMany(
          tx,
          "stockFeeRule",
          { where: { accountId: { in: accountIds } } },
          { tableNames: ["stock_fee_rules"] },
        );
        // 删除确认天数、费率、账单覆盖、信用卡周期
        await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.fundFeeRate.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.billOverride.deleteMany({ where: { accountId: { in: accountIds } } });
        await tx.creditCardCycle.deleteMany({ where: { accountId: { in: accountIds } } });
        // 删除交易记录
        await tx.txRecord.deleteMany({
          where: {
            OR: [
              { accountId: { in: accountIds } },
              { toAccountId: { in: accountIds } },
            ],
          },
        });
        // 删除账户别名（通过 accountId）
        await tx.accountAlias.deleteMany({ where: { accountId: { in: accountIds } } });
      }
      // 交易记录删除后，EntryTag 会随记录级联清理，此时再删标签。
      await tx.tag.deleteMany({ where: { householdId: id } });
      // 删除该账簿下的账户
      await tx.account.deleteMany({ where: { householdId: id } });
      // 账户和交易删除后，才能删除仍被它们引用的账簿级资料
      await tx.importBatch.deleteMany({ where: { householdId: id } });
      await tx.institution.deleteMany({ where: { householdId: id } });
      // 删除该账簿下的账户所有人
      await tx.accountGroup.deleteMany({ where: { householdId: id } });
      // 删除该账簿下的分类
      await tx.category.deleteMany({ where: { householdId: id } });
      // 删除该账簿下的用户
      await tx.user.deleteMany({ where: { householdId: id } });
      // 最后删除账簿本身
      await tx.household.delete({ where: { id } });
    }, { maxWait: 10_000, timeout: 120_000 });
  } catch (error) {
    logger.error("删除账簿失败", "api/v1/households", error);
    return NextResponse.json({ ok: false, error: "删除账簿失败，请查看服务日志后重试" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
