import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/factory-reset
 *
 * 系统初始化：删除所有数据，包括账簿本身，恢复到第一次安装完成的状态。
 * 初始化后需要重新创建账簿和管理员。
 * 仅管理员可操作。
 */
export async function POST(_req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();

  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, error: "仅管理员可执行此操作" }, { status: 403 });
  }

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
      await tx.fundSnapshot.deleteMany({ where: { accountId: { in: accountIds } } });
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
