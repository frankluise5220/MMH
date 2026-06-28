import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { compareDetailEntriesAsc } from "@/lib/detail-entry-order";

type AccountBalanceLike = {
  id: string;
  kind: AccountKind;
  investProductType?: string | null;
  billingDay?: number | null;
};

export async function computeAccountDisplayBalances(
  accounts: AccountBalanceLike[],
  hidFilter?: { householdId?: string },
) {
  const accountIds = accounts.map((account) => account.id).filter(Boolean);
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;
  const depositAccountIds = accounts
    .filter((account) => account.kind === AccountKind.deposit || account.investProductType === "deposit")
    .map((account) => account.id);
  const depositAccountIdSet = new Set(depositAccountIds);

  const txWhere = {
    deletedAt: null,
    ...(hidFilter ?? {}),
  };

  if (depositAccountIds.length > 0) {
    const depositEntries = await prisma.txRecord.findMany({
      where: {
        ...txWhere,
        fundProductType: "deposit",
        OR: [
          { accountId: { in: depositAccountIds } },
          { toAccountId: { in: depositAccountIds } },
        ],
      },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        amount: true,
        fundArrivalAmount: true,
        fundSubtype: true,
        depositSourceEntryId: true,
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });

    const remainingByLotId = new Map<string, { depositAccountId: string; amount: number }>();
    for (const entry of depositEntries) {
      const isRedeem = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
      const depositAccountId = isRedeem ? entry.accountId : entry.toAccountId;
      if (!depositAccountId || !depositAccountIdSet.has(depositAccountId)) continue;

      if (!isRedeem) {
        remainingByLotId.set(entry.id, {
          depositAccountId,
          amount: Math.abs(toNumber(entry.fundArrivalAmount ?? entry.amount)),
        });
        continue;
      }

      if (entry.depositSourceEntryId) {
        const lot = remainingByLotId.get(entry.depositSourceEntryId);
        if (lot) lot.amount = 0;
      }
    }

    for (const id of depositAccountIds) result.set(id, 0);
    for (const lot of remainingByLotId.values()) {
      result.set(lot.depositAccountId, (result.get(lot.depositAccountId) ?? 0) + lot.amount);
    }
  }

  const nonDepositAccounts = accounts.filter(
    (account) => account.kind !== AccountKind.deposit && account.investProductType !== "deposit",
  );
  const nonDepositAccountIds = nonDepositAccounts.map((account) => account.id);

  if (nonDepositAccountIds.length > 0) {
    const txRows = await prisma.txRecord.findMany({
      where: {
        ...txWhere,
        OR: [
          { accountId: { in: nonDepositAccountIds } },
          { toAccountId: { in: nonDepositAccountIds } },
        ],
      },
      select: {
        id: true,
        date: true,
        createdAt: true,
        type: true,
        amount: true,
        accountId: true,
        toAccountId: true,
        source: true,
        fundSubtype: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
      },
    });

    const txByAccountId = new Map<string, typeof txRows>();
    for (const accountId of nonDepositAccountIds) {
      txByAccountId.set(accountId, []);
    }
    for (const entry of txRows) {
      if (entry.accountId && txByAccountId.has(entry.accountId)) {
        txByAccountId.get(entry.accountId)?.push(entry);
      }
      if (entry.toAccountId && txByAccountId.has(entry.toAccountId)) {
        txByAccountId.get(entry.toAccountId)?.push(entry);
      }
    }

    for (const account of nonDepositAccounts) {
      const isBill =
        (account.kind === AccountKind.bank_credit || account.kind === AccountKind.loan) &&
        !!account.billingDay;
      if (isBill) {
        result.set(account.id, 0);
        continue;
      }

      const rows = txByAccountId.get(account.id) ?? [];
      const orderedRows = [...rows].sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = 0;
      for (const entry of orderedRows) {
        runningBalance += entry.toAccountId === account.id
          ? Math.abs(toNumber(entry.amount))
          : toNumber(entry.amount);
      }
      result.set(account.id, runningBalance);
    }
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
    select: { kind: true, investProductType: true, billingDay: true },
  });
  if (!acc) return;

  const balanceMap = await computeAccountDisplayBalances([
    { id: accountId, kind: acc.kind, investProductType: acc.investProductType, billingDay: acc.billingDay },
  ]);
  const newBalance = String(balanceMap.get(accountId) ?? 0);

  await prisma.account
    .update({ where: { id: accountId }, data: { balance: newBalance } })
    .catch(() => {});
}
