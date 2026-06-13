import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { OverviewDashboard } from "@/components/OverviewDashboard";
import { cookies } from "next/headers";
import { toNumber } from "@/lib/date-utils";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  cash: "现金",
  bank_debit: "借记卡",
  bank_credit: "信用卡",
  investment: "投资",
  ewallet: "电子钱包",
  loan: "贷款",
  other: "其他",
};

const KIND_ORDER: AccountKind[] = [
  AccountKind.bank_debit,
  AccountKind.investment,
  AccountKind.ewallet,
  AccountKind.cash,
  AccountKind.bank_credit,
  AccountKind.loan,
  AccountKind.other,
];

export default async function OverviewPage() {
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";

  const now = new Date();
  const thisYear = now.getFullYear();

  const accounts = await prisma.account.findMany({
    where: { isActive: true, ...hidFilter },
    select: { id: true, name: true, kind: true, balance: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const investBalances = await computeInvestBalances(ctx);

  // ── 本月收支 ──
  const monthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));

  const investAccountIds = accounts.filter(a => a.kind === AccountKind.investment).map(a => a.id);
  const nonInvestAccountIds = accounts.filter(a => a.kind !== AccountKind.investment).map(a => a.id);
  const scopeIds = nonInvestAccountIds;

  let monthIncome = 0;
  let monthExpense = 0;

  if (scopeIds.length > 0) {
    const monthEntries = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...hidFilter,
        date: { gte: monthStart, lt: monthEnd },
        OR: [
          { accountId: { in: scopeIds } },
          { toAccountId: { in: scopeIds } },
        ],
      },
      select: { type: true, amount: true, accountId: true, toAccountId: true, fundSubtype: true, realizedProfit: true },
    });

    for (const e of monthEntries) {
      const amount = toNumber(e.amount);
      const isToSelf = scopeIds.includes(e.toAccountId ?? "");
      const isFromSelf = scopeIds.includes(e.accountId);
      if (e.type === TransactionType.income) {
        if (isToSelf) monthIncome += Math.abs(amount);
      } else if (e.type === TransactionType.expense) {
        if (isFromSelf) monthExpense += Math.abs(amount);
      } else if (e.type === TransactionType.transfer) {
        if (isToSelf && !isFromSelf) monthIncome += Math.abs(amount);
        else if (isFromSelf && !isToSelf) monthExpense += Math.abs(amount);
      }
    }
  }

  // ── 账户余额列表 ──
  const accountList = accounts.map(a => {
    if (a.kind === AccountKind.investment) {
      const detail = investBalances.get(a.id);
      return { id: a.id, name: a.name, kind: a.kind, balance: detail?.marketValue ?? 0 };
    }
    return { id: a.id, name: a.name, kind: a.kind, balance: Number(a.balance) };
  });

  // ── 投资持仓摘要（取前5大持仓）──
  const topPositions: { fundCode: string; name: string; marketValue: number; floatingPnL: number; floatingPnLRate: number }[] = [];
  for (const invId of investAccountIds) {
    const { positions } = await computePositionDisplay(ctx, invId);
    for (const p of positions) {
      topPositions.push({
        fundCode: p.fundCode,
        name: p.name,
        marketValue: p.marketValue,
        floatingPnL: p.floatingPnL,
        floatingPnLRate: p.floatingPnLRate,
      });
    }
  }
  topPositions.sort((a, b) => b.marketValue - a.marketValue);
  const top5Positions = topPositions.slice(0, 5);

  // 净资产：非投资账户用 balance，投资账户用 marketValue
  let netWorth = 0;
  let floatingPnL = 0;
  let totalCost = 0;

  const kindTotals = new Map<string, number>();
  for (const k of KIND_ORDER) kindTotals.set(k, 0);

  for (const a of accounts) {
    if (a.kind === AccountKind.investment) {
      const detail = investBalances.get(a.id);
      const mv = detail?.marketValue ?? 0;
      netWorth += mv;
      kindTotals.set(a.kind, (kindTotals.get(a.kind) ?? 0) + mv);
      floatingPnL += detail?.floatingPnL ?? 0;
      totalCost += detail?.totalCost ?? 0;
    } else {
      const bal = Number(a.balance);
      netWorth += bal;
      kindTotals.set(a.kind, (kindTotals.get(a.kind) ?? 0) + bal);
    }
  }

  const totalAssetAbs = Array.from(kindTotals.values())
    .filter((v, i) => KIND_ORDER[i] !== AccountKind.bank_credit && KIND_ORDER[i] !== AccountKind.loan)
    .reduce((s, v) => s + Math.abs(v), 0);

  const assetDistribution = KIND_ORDER
    .filter(k => kindTotals.get(k) !== 0)
    .map(k => ({
      kind: k,
      label: KIND_LABEL[k] ?? k,
      value: kindTotals.get(k) ?? 0,
      pct: totalAssetAbs > 0 ? (Math.abs(kindTotals.get(k) ?? 0) / totalAssetAbs) * 100 : 0,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return (
    <OverviewDashboard
      netWorth={netWorth}
      floatingPnL={floatingPnL}
      totalCost={totalCost}
      assetDistribution={assetDistribution}
      monthIncome={monthIncome}
      monthExpense={monthExpense}
      accountList={accountList}
      topPositions={top5Positions}
      isRedUp={isRedUp}
    />
  );
}