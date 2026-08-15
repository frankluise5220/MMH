import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { verifyPassword } from "@/lib/auth/password";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/factory-reset
 *
 * 系统初始化：删除所有数据，包括账簿本身，恢复到第一次安装完成的状态。
 * 初始化后需要重新创建账簿和管理员。
 *
 * 安全要求（见 AGENTS.md）：
 * - 仅系统管理员（isSystem=true）可执行；
 * - 必须提交当前登录管理员的密码，服务端校验通过后才执行；
 *   不使用部署级系统密码做身份验证。
 * Body: { password: string }
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  }
  if (!currentUser.isSystem) {
    return NextResponse.json({ ok: false, error: "仅系统管理员可执行此操作" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = (body?.password ?? "").trim();
  if (!password) {
    return NextResponse.json({ ok: false, error: "请输入当前用户密码" }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  if (!dbUser?.passwordHash) {
    return NextResponse.json({ ok: false, error: "当前用户尚未设置密码" }, { status: 400 });
  }
  const matched = await verifyPassword(password, dbUser.passwordHash);
  if (!matched) {
    return NextResponse.json({ ok: false, error: "当前用户密码错误" }, { status: 401 });
  }

  const { householdId } = await getHouseholdScope();

  await prisma.$transaction(async (tx) => {
    // 先查出该账簿下所有账户 ID
    const accounts = await tx.account.findMany({ where: { householdId }, select: { id: true } });
    const accountIds = accounts.map(a => a.id);

    // 删除定投计划
    if (accountIds.length > 0) {
      await tx.regularInvestPlan.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    // 删除标签
    await tx.tag.deleteMany({ where: { householdId } });
    // 删除机构
    await tx.institution.deleteMany({ where: { householdId } });
    // 删除导入批次
    await tx.importBatch.deleteMany({ where: { householdId } });
    // 删除基金查询API
    await tx.fundQueryApi.deleteMany({ where: { householdId } });
    // 级联删除账户关联数据
    if (accountIds.length > 0) {
      await tx.fundHolding.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.preciousMetalHolding.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.billOverride.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.txRecord.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.accountAlias.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    // 删除账户
    await tx.account.deleteMany({ where: { householdId } });
    // 删除账户所有人
    await tx.accountGroup.deleteMany({ where: { householdId } });
    // 删除分类
    await tx.category.deleteMany({ where: { householdId } });
    // 删除账簿
    await tx.household.deleteMany({ where: { id: householdId } });
    // 删除用户（包括系统管理员）
    await tx.user.deleteMany();

    // 清理全局数据
    await tx.entryTag.deleteMany();
    await tx.undoOperation.deleteMany();
    await tx.distillLog.deleteMany();
    await tx.commandTestResult.deleteMany();
    await tx.fundNavCache.deleteMany();
    await tx.systemSetting.deleteMany();
    await tx.accessKey.deleteMany();
    await tx.aiChannel.deleteMany();
    await tx.commandAlias.deleteMany();
    await tx.passwordResetToken.deleteMany();
  });

  return NextResponse.json({ ok: true });
}
