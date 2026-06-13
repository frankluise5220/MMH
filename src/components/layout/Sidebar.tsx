import { prisma } from "@/lib/db/prisma";
import { SidebarClient } from "@/components/layout/SidebarClient";
import { AccountKind } from "@prisma/client";
import { Suspense } from "react";
import { computeInvestBalances } from "@/lib/invest-balance";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { getHouseholdScope } from "@/lib/server/household-scope";

async function getSidebarData() {
  await connection();
  const ctx = await getHouseholdScope();
  const { householdId, hidFilter, user } = ctx;

  const cookieStore = await cookies();
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as string;
  const isRedUp = colorScheme === "red_up_green_down";

  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { id: true, name: true } });

  const accounts = await prisma.account.findMany({
    where: { ...hidFilter, isActive: true },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ name: "asc" }],
  });

  const investBalByAccountId = await computeInvestBalances(ctx);

  const items = accounts.map((a) => {
    const instLabel = a.Institution?.name?.trim() || "";
    const prefix = instLabel ? `${instLabel}·` : "";
    const isInvest = a.kind === AccountKind.investment;
    const investDetail = isInvest ? investBalByAccountId.get(a.id) : null;
    const balance = isInvest
      ? (investDetail?.marketValue ?? 0)
      : Number(a.balance);
    return {
      id: a.id,
      name: a.name,
      label: `${prefix}${a.name}`,
      balance,
      kind: a.kind as string,
      institution: instLabel || undefined,
      investProductType: a.investProductType || undefined,
    };
  });

  return { items, household, isRedUp, user };
}

export async function Sidebar() {
  const { items, household, isRedUp, user } = await getSidebarData();

  return <Suspense fallback={<div className="w-72 bg-background border-r border-foreground/5 h-screen flex-shrink-0" />}>
    <SidebarClient items={items} household={household} isRedUp={isRedUp} user={user} />
  </Suspense>;
}
