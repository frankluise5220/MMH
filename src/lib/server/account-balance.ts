import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";

type AccountBalanceLike = {
  id: string;
  kind: AccountKind;
  billingDay?: number | null;
};

export async function computeAccountDisplayBalances(
  accounts: AccountBalanceLike[],
  hidFilter?: { householdId?: string },
) {
  const accountIds = accounts.map((account) => account.id).filter(Boolean);
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;

  const txWhere = {
    deletedAt: null,
    ...(hidFilter ?? {}),
  };

  const [fromAgg, toRecords] = await Promise.all([
    prisma.txRecord.groupBy({
      by: ["accountId"],
      where: {
        ...txWhere,
        accountId: { in: accountIds },
      },
      _sum: { amount: true },
    }),
    prisma.txRecord.findMany({
      where: {
        ...txWhere,
        toAccountId: { in: accountIds },
      },
      select: { toAccountId: true, amount: true },
    }),
  ]);

  const fromById = new Map<string, number>();
  for (const row of fromAgg) {
    fromById.set(row.accountId, toNumber(row._sum.amount));
  }

  const toById = new Map<string, number>();
  for (const row of toRecords) {
    const key = row.toAccountId ?? "";
    if (!key) continue;
    toById.set(key, (toById.get(key) ?? 0) + Math.abs(toNumber(row.amount)));
  }

  for (const account of accounts) {
    const txSum = (fromById.get(account.id) ?? 0) + (toById.get(account.id) ?? 0);
    const isBill =
      (account.kind === AccountKind.bank_credit || account.kind === AccountKind.loan) &&
      !!account.billingDay;
    result.set(account.id, isBill ? 0 : txSum);
  }

  return result;
}

/**
 * Recalculate an account's display balance and persist it to Account.balance.
 * For incoming-side records, the receiver always treats the flow as positive.
 */
export async function recalcAndSaveAccountBalance(accountId: string) {
  const acc = await prisma.account.findUnique({
    where: { id: accountId },
    select: { kind: true, billingDay: true },
  });
  if (!acc) return;

  const balanceMap = await computeAccountDisplayBalances([
    { id: accountId, kind: acc.kind, billingDay: acc.billingDay },
  ]);
  const newBalance = String(balanceMap.get(accountId) ?? 0);

  await prisma.account
    .update({ where: { id: accountId }, data: { balance: newBalance } })
    .catch(() => {});
}
