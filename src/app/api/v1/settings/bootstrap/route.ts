import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadCommonData } from "@/lib/server/cached-data";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { getHouseholdBaseCurrency } from "@/lib/server/fx-rates";

export const runtime = "nodejs";

function normalizeReturnedAccountKind<T extends { kind: AccountKind; investProductType?: string | null }>(account: T): T {
  if (account.kind === AccountKind.investment && account.investProductType === "deposit") {
    return { ...account, kind: AccountKind.deposit };
  }
  return account;
}

function withAccountDisplayFields<T extends {
  id: string;
  name: string;
  kind: AccountKind;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
}>(account: T) {
  const normalized = normalizeReturnedAccountKind(account);
  const display = buildAccountDisplayOption(normalized);
  return {
    ...normalized,
    label: display.selectorLabel || display.label,
    selectorLabel: display.selectorLabel,
    selectorCoreLabel: display.selectorCoreLabel,
    fullLabel: display.fullLabel,
    hoverTitle: display.hoverTitle,
    displaySubLabel: display.subLabel,
  };
}

/**
 * GET /api/v1/settings/bootstrap
 * 读取设置区常用基础资料，供系统设置页共享缓存使用。
 *
 * 返回: { ok, baseCurrency, accounts, groups, institutions, counterparties, users, categories, tags }
 */
export async function GET() {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);
    const [{ accounts, groups, institutions, counterparties, categories, tags }, users, baseCurrency] = await Promise.all([
      loadCommonData(hidFilter),
      prisma.user.findMany({
        where: hidFilter,
        orderBy: { name: "asc" },
        // 只返回展示字段，绝不外泄 passwordHash
        select: { id: true, name: true, email: true, role: true, isSystem: true, householdId: true, createdAt: true },
      }),
      getHouseholdBaseCurrency(householdId),
    ]);

    return NextResponse.json({
      ok: true,
      baseCurrency,
      accounts: accounts.map(withAccountDisplayFields),
      groups,
      institutions,
      counterparties,
      users,
      categories,
      tags,
    });
  } catch (error) {
    console.error("GET /api/v1/settings/bootstrap error:", error);
    return NextResponse.json({ ok: false, error: "查询失败" }, { status: 500 });
  }
}
