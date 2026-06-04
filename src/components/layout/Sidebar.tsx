import { prisma } from "@/lib/db/prisma";
import { SidebarClient } from "@/components/layout/SidebarClient";
import { toNumber } from "@/lib/date-utils";
import { AccountKind } from "@prisma/client";
import { Suspense } from "react";
import { computeInvestBalances } from "@/lib/invest-balance";
import { connection } from "next/server";
import { cookies } from "next/headers";

async function getSidebarData() {
  await connection();
  const cookieStore = await cookies();
  const householdId = cookieStore.get("householdId")?.value;

  const household = householdId
    ? await prisma.household.findUnique({ where: { id: householdId }, select: { id: true, name: true } })
    : await prisma.household.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });

  const hidFilter = household ? { householdId: household.id } : {};

  const [accounts, byAccountId, byAccountName] = await Promise.all([
    prisma.account.findMany({
      where: hidFilter,
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { account: { kind: { not: AccountKind.investment }, ...hidFilter } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.txRecord.groupBy({
      by: ["accountName"],
      where: { account: { kind: { not: AccountKind.investment }, ...hidFilter } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const investBalByAccountId = await computeInvestBalances();

  const statsById = new Map<string, { balance: number; count: number }>();
  for (const row of byAccountId) {
    if (!row.accountId) continue;
    statsById.set(row.accountId, {
      balance: toNumber(row._sum.amount),
      count: row._count._all,
    });
  }

  const statsByName = new Map<string, { balance: number; count: number }>();
  for (const row of byAccountName) {
    const name = row.accountName?.trim();
    if (!name) continue;
    statsByName.set(name, {
      balance: toNumber(row._sum.amount),
      count: row._count._all,
    });
  }

  const knownNames = new Set(accounts.map((a) => a.name));

  const items = [
    ...accounts.map((a) => {
      const stats = statsById.get(a.id) ?? statsByName.get(a.name) ?? { balance: 0, count: 0 };
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
        count: stats.count,
        kind: a.kind as string,
        institution: instLabel || undefined,
        investProductType: a.investProductType || undefined,
      };
    }),
    ...[...statsByName.entries()]
      .filter(([name]) => !knownNames.has(name))
      .map(([name, stats]) => ({
        id: null,
        name,
        label: name,
        balance: stats.balance,
        count: stats.count,
        kind: "other",
      })),
  ].sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));

  return { items, household };
}

export async function Sidebar() {
  const { items, household } = await getSidebarData();

  return <Suspense fallback={<div className="w-72 bg-slate-50 border-r border-slate-200 h-screen flex-shrink-0" />}>
    <SidebarClient items={items} household={household} />
  </Suspense>;
}
