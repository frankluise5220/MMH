import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export async function invalidateCreditCardCycleCacheForAccountIds(
  accountIds: Iterable<string | null | undefined>,
) {
  const ids = Array.from(new Set(Array.from(accountIds).filter((id): id is string => !!id)));
  if (ids.length === 0) return 0;

  const billAccounts = await prisma.account.findMany({
    where: {
      id: { in: ids },
      kind: { in: [AccountKind.bank_credit, AccountKind.loan] },
      billingDay: { not: null },
    },
    select: { id: true },
  });
  if (billAccounts.length === 0) return 0;

  const result = await prisma.creditCardCycle.deleteMany({
    where: { accountId: { in: billAccounts.map((account) => account.id) } },
  });
  return result.count;
}
