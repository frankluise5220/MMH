import assert from "node:assert/strict";
import { TransactionType } from "@prisma/client";
import { summarizeCreditBillEntryRows } from "../src/lib/credit/credit-bill-entry-summary";

const count = 50_123;
const rows = Array.from({ length: count }, (_, index) => ({
  id: `entry-${index}`,
  date: new Date(Date.UTC(2026, 0, 1) + index * 1000),
  updatedAt: index === count - 1
    ? new Date(Date.UTC(2026, 2, 1))
    : new Date(Date.UTC(2026, 0, 1) + index * 1000),
  deletedAt: index === count - 1 ? new Date(Date.UTC(2026, 2, 1)) : null,
  type: index === count - 2 ? TransactionType.transfer : TransactionType.expense,
  amount: index === count - 2 ? 100 : 1,
  accountId: "card-1",
  toAccountId: index === count - 2 ? "cash-1" : null,
}));

const result = summarizeCreditBillEntryRows(rows, new Set(["card-1"]));

assert.equal(result.activeCount, count - 1, "rows above the former 50,000 threshold remain available");
assert.equal(result.activeRows.length, count - 1, "soft-deleted entries are excluded from active calculations");
assert.equal(
  result.latestAnyUpdatedAt?.getTime(),
  Date.UTC(2026, 2, 1),
  "soft-deleted entries still advance the stale-cache watermark",
);
assert.equal(result.lastRepayCounterpartyAccountId, "cash-1", "latest repayment counterparty is folded during the scan");

console.log(`PASS  ${count.toLocaleString()} synthetic rows retained without a total-row cap`);
