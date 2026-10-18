import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  downgradeMultiCurrencyAccount,
  recomputeAggregateAccountBalance,
  upgradeAccountToMultiCurrency,
} from "@/lib/server/account-hierarchy";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/accounts/[id]/multi-currency
 *
 * 把账户升级为多币种父账户（2026-10-18 用户裁定）：
 * 父账户沿用原名、只参与统计、自身没有明细；原账户**原地**降级为默认币种子账户，
 * 账户名改为 `原名 · 币种`。不迁移任何流水（id 不变），所以明细/计划/报表/备份
 * 全部原样有效。
 */
export async function POST(_req: NextRequest, context: RouteContext) {
  try {
    const { householdId } = await getHouseholdScope();
    const { id } = await context.params;
    const accountId = String(id ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing account id" }, { status: 400 });
    }
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, householdId: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" }, { status: 404 });
    }
    if (account.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Account belongs to another household" }, { status: 403 });
    }

    const result = await upgradeAccountToMultiCurrency({ householdId, accountId });
    // 父账户余额 = 子户折合合计：升级后立刻算一次，避免统计口径停在 0。
    await recomputeAggregateAccountBalance(prisma, result.parentId).catch(() => null);
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, code: "UPGRADE_FAILED", error: message }, { status: 400 });
  }
}

/**
 * DELETE /api/v1/accounts/[id]/multi-currency
 *
 * 降级：只在还剩一个子账户时允许。子账户提升为根账户（保留当前名字），父行删除。
 */
export async function DELETE(_req: NextRequest, context: RouteContext) {
  try {
    const { householdId } = await getHouseholdScope();
    const { id } = await context.params;
    const parentId = String(id ?? "").trim();
    if (!parentId) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing account id" }, { status: 400 });
    }
    const parent = await prisma.account.findUnique({
      where: { id: parentId },
      select: { id: true, householdId: true, isAggregate: true },
    });
    if (!parent) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" }, { status: 404 });
    }
    if (parent.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Account belongs to another household" }, { status: 403 });
    }
    if (!parent.isAggregate) {
      return NextResponse.json({ ok: false, code: "NOT_MULTI_CURRENCY", error: "Account is not a multi-currency parent" }, { status: 400 });
    }
    const result = await downgradeMultiCurrencyAccount({ householdId, parentId });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, code: "DOWNGRADE_FAILED", error: message }, { status: 400 });
  }
}
