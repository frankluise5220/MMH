import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";

export type MonthlySummaryRow = {
  month: string;
  income: number;
  expense: number;
  investPnL: number;
  netTotal: number;
  cumNet: number;
};

/**
 * 按月汇总收支数据，供概览页和统计页共用
 *
 * @param ctx 家庭上下文
 * @param year 年份
 * @param accountIds 可选：限定范围的账户ID列表（null = 全部非投资账户）
 */
export async function getMonthlySummary(
  ctx: HouseholdContext,
  year: number,
  accountIds?: string[] | null,
): Promise<MonthlySummaryRow[]> {
  const { hidFilter } = ctx;

  const allAccounts = await prisma.account.findMany({
    where: { ...hidFilter, isActive: true },
    select: { id: true, kind: true },
  });

  const nonInvestAccountIds = allAccounts.filter((a) => !isPureInvestmentAccount(a)).map(a => a.id);

  const accountFilter = accountIds
    ? { OR: [{ accountId: { in: accountIds } }, { toAccountId: { in: accountIds } }] }
    : {};

  const entries = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...hidFilter,
      date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
      ...accountFilter,
    },
    select: {
      date: true,
      type: true,
      amount: true,
      fundSubtype: true,
      realizedProfit: true,
      accountId: true,
      toAccountId: true,
    },
    orderBy: { date: "asc" },
  });

  const scopeAccountIds = accountIds ?? nonInvestAccountIds;

  const monthMap = new Map<string, { income: number; expense: number; investPnL: number }>();

  for (const e of entries) {
    const m = String(e.date.getUTCMonth() + 1).padStart(2, "0");
    if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
    const row = monthMap.get(m)!;
    const amount = toNumber(e.amount);

    const isToSelf = e.toAccountId && scopeAccountIds.includes(e.toAccountId);
    const isFromSelf = e.accountId && scopeAccountIds.includes(e.accountId);

    if (e.type === TransactionType.income) {
      row.income += isToSelf ? Math.abs(amount) : amount;
    } else if (e.type === TransactionType.expense) {
      row.expense += Math.abs(isFromSelf ? Math.abs(amount) : amount);
    } else if (e.type === TransactionType.transfer) {
      if (isToSelf && !isFromSelf) row.income += Math.abs(amount);
      else if (isFromSelf && !isToSelf) row.expense += Math.abs(amount);
    } else if (e.type === TransactionType.investment) {
      if (e.fundSubtype === "dividend_cash") row.investPnL += Math.abs(amount);
      if (e.realizedProfit != null) row.investPnL += toNumber(e.realizedProfit);
      if (e.fundSubtype === "buy" && amount < 0) row.expense += Math.abs(amount);
    }
  }

  const result: MonthlySummaryRow[] = [];
  let cumNet = 0;
  for (let i = 1; i <= 12; i++) {
    const m = String(i).padStart(2, "0");
    const row = monthMap.get(m);
    if (!row) continue;
    const netTotal = row.income - row.expense + row.investPnL;
    cumNet += netTotal;
    result.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
  }

  return result;
}
