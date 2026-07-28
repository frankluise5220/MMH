import { Prisma, TransactionType } from "@prisma/client";

const MANUAL_CREATE_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function textOrNull(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text || null;
}

export async function findRecentTransactionDuplicate(
  tx: Prisma.TransactionClient,
  params: {
    householdId: string;
    type: TransactionType;
    date: Date;
    accountId: string;
    amount: number;
    toAccountId?: string | null;
    categoryId?: string | null;
    note?: string | null;
    source?: string | null;
    now?: Date;
  },
) {
  const source = textOrNull(params.source) ?? "manual";
  if (!source) return null;

  // Same-record identity follows business fields, not ingestion source.
  return tx.txRecord.findFirst({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      type: params.type,
      date: params.date,
      accountId: params.accountId,
      toAccountId: params.toAccountId ?? null,
      amount: params.amount,
      note: textOrNull(params.note),
      createdAt: {
        gte: new Date((params.now ?? new Date()).getTime() - MANUAL_CREATE_DEDUPE_WINDOW_MS),
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function findRecentManualTransactionDuplicate(
  tx: Prisma.TransactionClient,
  params: Parameters<typeof findRecentTransactionDuplicate>[1],
) {
  const source = textOrNull(params.source) ?? "manual";
  if (source !== "manual") return null;
  return findRecentTransactionDuplicate(tx, { ...params, source });
}
