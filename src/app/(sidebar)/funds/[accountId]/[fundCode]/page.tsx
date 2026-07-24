import { AccountKind, TransactionType } from "@prisma/client";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { MobileFundDetail } from "@/components/mobile/MobileFundDetail";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { computePositionDisplay } from "@/lib/invest-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

export default async function FundDetailPage({ params }: { params: Promise<{ accountId: string; fundCode: string }> }) {
  const { accountId, fundCode } = await params;
  const ctx = await getHouseholdScope();
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const account = await prisma.account.findFirst({
    where: { id: accountId, kind: AccountKind.investment, isPlaceholder: { not: true }, ...ctx.hidFilter },
    include: { Institution: { select: { name: true } } },
  });
  if (!account) notFound();

  const [positionDisplay, entries] = await Promise.all([
    computePositionDisplay(ctx, account.id),
    prisma.txRecord.findMany({
      where: {
        ...ctx.hidFilter,
        deletedAt: null,
        type: TransactionType.investment,
        fundCode,
        OR: [{ accountId: account.id }, { toAccountId: account.id }],
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 100,
      select: { id: true, date: true, fundSubtype: true, amount: true, fundUnits: true, note: true },
    }),
  ]);
  const position = positionDisplay.positions.find((item) => item.fundCode === fundCode)
    ?? positionDisplay.clearedPositions.find((item) => item.fundCode === fundCode);
  if (!position) notFound();

  const cost = "cost" in position ? toNumber(position.cost) : toNumber(position.totalBuyAmount) - toNumber(position.totalRedeemAmount);
  const marketValue = "marketValue" in position ? toNumber(position.marketValue) : 0;
  const floatingPnL = "floatingPnL" in position ? toNumber(position.floatingPnL) : toNumber(position.historicalProfit);
  const floatingPnLRate = "floatingPnLRate" in position ? toNumber(position.floatingPnLRate) : 0;

  return (
    <>
      <div className="h-full md:hidden">
        <MobileFundDetail
          accountLabel={account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name}
          fundCode={fundCode}
          fundName={position.name || fundCode}
          cost={cost}
          marketValue={marketValue}
          floatingPnL={floatingPnL}
          floatingPnLRate={floatingPnLRate}
          entries={entries.map((entry) => ({ id: entry.id, date: entry.date.toISOString().slice(0, 10), subtype: entry.fundSubtype ?? "", amount: Math.abs(toNumber(entry.amount)), units: entry.fundUnits == null ? null : Math.abs(toNumber(entry.fundUnits)), note: entry.note ?? "" }))}
          isRedUp={isRedUp}
        />
      </div>
      <div className="hidden h-full items-center justify-center md:flex"><div className="text-sm text-slate-500">请使用桌面投资工作台查看完整基金明细。</div></div>
    </>
  );
}
