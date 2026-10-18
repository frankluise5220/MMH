import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  recomputeAggregateAccountBalance,
  resolveCurrencyChildAccount,
  upgradeAccountToMultiCurrency,
} from "@/lib/server/account-hierarchy";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/accounts/[id]/currency-child
 * Body: { currency: "USD" }
 *
 * 「转到外币」时的自动分户（2026-10-18 用户裁定）：转账目标账户币种与转出方
 * 不一致、且目标账户是资金类账户时，前端先问一句「是否创建子账户」，确认后调这里。
 *
 * - 目标账户还不是多币种父账户 → 先升级（父沿用原名、原账户原地降级为默认币种子户，
 *   不迁移任何流水）；
 * - 再按请求币种取/建子账户（`(parentId, currency)` 唯一，天然幂等）；
 * - 返回子账户 id，前端把 `toAccountId` 换成它，转账就变成同币种标准转账。
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const { householdId } = await getHouseholdScope();
    const { id } = await context.params;
    const accountId = String(id ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing account id" }, { status: 400 });
    }
    const body = (await req.json().catch(() => null)) as { currency?: string } | null;
    const currency = normalizeCurrency(body?.currency);

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, householdId: true, parentId: true, isAggregate: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Account not found" }, { status: 404 });
    }
    if (account.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Account belongs to another household" }, { status: 403 });
    }

    let parentId = account.isAggregate ? account.id : account.parentId ?? "";
    let upgraded = false;
    if (!parentId) {
      const upgrade = await upgradeAccountToMultiCurrency({ householdId, accountId });
      parentId = upgrade.parentId;
      upgraded = true;
    }
    const parent = await prisma.account.findFirst({
      where: { id: parentId, householdId },
      select: { id: true, name: true },
    });
    if (!parent) {
      return NextResponse.json({ ok: false, code: "PARENT_NOT_FOUND", error: "Parent account not found" }, { status: 404 });
    }

    const child = await resolveCurrencyChildAccount(prisma, { householdId, parentId: parent.id, currency });
    // 父账户余额 = 子户折合合计，新建子户后立刻刷新，避免统计口径滞后。
    await recomputeAggregateAccountBalance(prisma, parent.id).catch(() => null);
    revalidateAfterSettingsChange();

    return NextResponse.json({
      ok: true,
      upgraded,
      parentId: parent.id,
      parentName: parent.name,
      accountId: child.account.id,
      accountName: child.account.name,
      currency,
      created: child.created,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, code: "CURRENCY_CHILD_FAILED", error: message }, { status: 400 });
  }
}
