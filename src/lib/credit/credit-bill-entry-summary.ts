export type CreditBillEntrySummaryRow = {
  updatedAt: Date | null;
  deletedAt: Date | null;
  accountId: string | null;
  toAccountId: string | null;
  type: string;
  amount: number | { toNumber(): number };
  date: Date;
};

export function summarizeCreditBillEntryRows<T extends CreditBillEntrySummaryRow>(
  rows: readonly T[],
  accountIds: ReadonlySet<string>,
) {
  const activeRows: T[] = [];
  let latestAnyUpdatedAt: Date | null = null;
  let lastRepay: { date: Date; toAccountId: string | null } | null = null;
  for (const row of rows) {
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : null;
    if (updatedAt && (!latestAnyUpdatedAt || updatedAt > latestAnyUpdatedAt)) {
      latestAnyUpdatedAt = updatedAt;
    }
    if (!row.deletedAt) activeRows.push(row);
    const amount = typeof row.amount === "number" ? row.amount : row.amount.toNumber();
    if (
      row.accountId && accountIds.has(row.accountId) &&
      row.type === "transfer" && amount > 0 &&
      row.date instanceof Date && (!lastRepay || row.date > lastRepay.date)
    ) {
      lastRepay = { date: row.date, toAccountId: row.toAccountId ?? null };
    }
  }
  return {
    activeRows,
    latestAnyUpdatedAt,
    activeCount: activeRows.length,
    lastRepayCounterpartyAccountId: lastRepay?.toAccountId ?? null,
  };
}
