import { Suspense } from "react";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind } from "@prisma/client";

import { SidebarClient } from "@/components/layout/SidebarClient";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { prisma } from "@/lib/db/prisma";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { getCachedHouseholdScope } from "@/lib/server/household-scope";

async function getSidebarData() {
  await connection();
  const ctx = await getCachedHouseholdScope();
  const { householdId, hidFilter, user } = ctx;

  const cookieStore = await cookies();
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as string;
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const isRedUp = colorScheme === "red_up_green_down";

  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { id: true, name: true },
  });

  const accounts = await prisma.account.findMany({
    where: { isPlaceholder: { not: true }, ...hidFilter, isActive: true },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ name: "asc" }],
  });

  const investBalByAccountId = await computeInvestBalances(ctx);
  const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    accounts
      .filter((account) => account.kind !== AccountKind.investment)
      .map((account) => ({ id: account.id, kind: account.kind, billingDay: account.billingDay })),
    hidFilter,
  );

  const items = accounts.map((account) => {
    const isInvest = account.kind === AccountKind.investment;
    const investDetail = isInvest ? investBalByAccountId.get(account.id) : null;
    const balance = isInvest ? (investDetail?.marketValue ?? 0) : (cashDisplayBalanceByAccountId.get(account.id) ?? Number(account.balance));
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelMode);

    return {
      id: account.id,
      name: account.name,
      label: display.label,
      balance,
      kind: account.kind as string,
      groupName: account.AccountGroup?.name?.trim() || "未设置所有人",
      institution: display.institutionName || undefined,
      investProductType: account.investProductType || undefined,
    };
  });

  return { items, household, isRedUp, user };
}

export async function Sidebar() {
  const { items, household, isRedUp, user } = await getSidebarData();

  return (
    <Suspense fallback={<div className="h-screen w-72 flex-shrink-0 border-r border-foreground/5 bg-background" />}>
      <SidebarClient items={items} household={household} isRedUp={isRedUp} user={user} />
    </Suspense>
  );
}
