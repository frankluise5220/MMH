import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { applyBalanceReconcileEntry } from "@/lib/balance-reconcile";

type AccountBalanceLike = {
  id: string;
  kind: AccountKind;
  investProductType?: string | null;
  billingDay?: number | null;
};

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function computeAccountDisplayBalances(
  accounts: AccountBalanceLike[],
  hidFilter?: { householdId?: string },
) {
  const accountIds = accounts.map((account) => account.id).filter(Boolean);
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;
  const todayKey = localDateKey(new Date());
  const isOnOrBeforeToday = (date: Date) => localDateKey(date) <= todayKey;
  const depositAccountIds = accounts
    .filter((account) => account.kind === AccountKind.deposit || account.investProductType === "deposit")
    .map((account) => account.id);
  const depositAccountIdSet = new Set(depositAccountIds);

  const txWhere = {
    deletedAt: null,
    ...(hidFilter ?? {}),
  };

  if (depositAccountIds.length > 0) {
    const depositEntries = await prisma.depositTransaction.findMany({
      where: {
        deletedAt: null,
        ...(hidFilter ?? {}),
        accountId: { in: depositAccountIds },
      },
      select: {
        id: true,
        accountId: true,
        tradeDate: true,
        principalAmount: true,
        arrivalAmount: true,
        action: true,
        sourceDepositTransactionId: true,
      },
      orderBy: [{ tradeDate: "asc" }, { id: "asc" }],
    });

    const remainingByLotId = new Map<string, { depositAccountId: string; amount: number }>();
    for (const entry of depositEntries) {
      if (!isOnOrBeforeToday(entry.tradeDate)) continue;
      const isRedeem = entry.action === "redeem" || entry.action === "switch_out";
      const depositAccountId = entry.accountId;
      if (!depositAccountId || !depositAccountIdSet.has(depositAccountId)) continue;

      if (!isRedeem) {
        remainingByLotId.set(entry.id, {
          depositAccountId,
          amount: Math.abs(toNumber(entry.arrivalAmount ?? entry.principalAmount)),
        });
        continue;
      }

      if (entry.sourceDepositTransactionId) {
        const lot = remainingByLotId.get(entry.sourceDepositTransactionId);
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
        dayOrder: true,
        type: true,
        amount: true,
        accountId: true,
        toAccountId: true,
        toNote: true,
        source: true,
        debtPrincipalAmount: true,
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
      const isCreditBill = account.kind === AccountKind.bank_credit && !!account.billingDay;
      if (isCreditBill) {
        result.set(account.id, 0);
        continue;
      }

      const rows = txByAccountId.get(account.id) ?? [];
      const orderedRows = rows
        .filter((entry) => isOnOrBeforeToday(getDetailEntryDisplayDate(entry, account.id)))
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = 0;
      for (const entry of orderedRows) {
        if (account.kind === AccountKind.loan && entry.type !== TransactionType.transfer) continue;
        runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
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
