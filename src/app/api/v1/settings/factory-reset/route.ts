import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { verifyPassword } from "@/lib/auth/password";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/factory-reset
 *
 * System initialization: deletes all data, including the household itself,
 * restoring the system to the state right after first install.
 * After initialization, a new household and admin user must be created.
 *
 * Security requirements (see AGENTS.md):
 * - Only the system admin (isSystem=true) may execute this;
 * - The current signed-in admin's own password must be submitted and verified
 *   server-side before execution; deployment-level system passwords are not
 *   used for identity verification.
 * Body: { password: string }
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!currentUser.isSystem) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "仅系统管理员可执行此操作" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = (body?.password ?? "").trim();
  if (!password) {
    return NextResponse.json({ ok: false, code: "PASSWORD_REQUIRED", error: "请输入当前用户密码" }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  if (!dbUser?.passwordHash) {
    return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "当前用户尚未设置密码" }, { status: 400 });
  }
  const matched = await verifyPassword(password, dbUser.passwordHash);
  if (!matched) {
    return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "当前用户密码错误" }, { status: 401 });
  }

  const { householdId } = await getHouseholdScope();

  await prisma.$transaction(async (tx) => {
    // First find all account IDs under this household
    const accounts = await tx.account.findMany({ where: { householdId }, select: { id: true } });
    const accountIds = accounts.map(a => a.id);

    // Delete regular investment plans
    if (accountIds.length > 0) {
      await tx.regularInvestPlan.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    // Delete tags
    await tx.tag.deleteMany({ where: { householdId } });
    // Delete institutions
    await tx.institution.deleteMany({ where: { householdId } });
    // Delete import batches
    await tx.importBatch.deleteMany({ where: { householdId } });
    // Delete fund query APIs
    await tx.fundQueryApi.deleteMany({ where: { householdId } });
    // Cascade-delete account-related data
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
    // Delete accounts
    await tx.account.deleteMany({ where: { householdId } });
    // Delete account groups (owners)
    await tx.accountGroup.deleteMany({ where: { householdId } });
    // Delete categories
    await tx.category.deleteMany({ where: { householdId } });
    // Delete households
    await tx.household.deleteMany({ where: { id: householdId } });
    // Delete users (including system admins)
    await tx.user.deleteMany();

    // Clean up global data
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
