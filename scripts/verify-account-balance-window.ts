import assert from "node:assert/strict";

const account = {
  id: "account-1",
  kind: "cash",
  investProductType: null,
  billingDay: null,
};

const ordinaryRow = {
  id: "tx-1",
  date: new Date(2026, 0, 15),
  postedAt: null,
  createdAt: new Date(2026, 0, 15, 12),
  dayOrder: 0,
  type: "expense",
  amount: 12.34,
  accountId: "account-1",
  toAccountId: null,
  toNote: null,
  source: null,
  debtPrincipalAmount: null,
  fundProductType: null,
  fundSubtype: null,
  fundConfirmDate: null,
  fundArrivalDate: null,
  fundArrivalAmount: null,
  depositSourceEntryId: null,
  deletedAt: null,
};

let findManyCalls = 0;
const db = {
  txRecord: {
    count: async () => 0,
    findMany: async () => {
      findManyCalls += 1;
      return findManyCalls === 2 ? [ordinaryRow] : [];
    },
  },
};

async function main() {
  process.env.DATABASE_URL ??= "postgresql://mmh:mmh@127.0.0.1:5432/mmh_test";
  const { foldOversizedBalanceWindow } = await import("../src/lib/server/account-balance");
  const balance = await foldOversizedBalanceWindow(
    db as never,
    account as never,
    { householdId: "household-1" },
    "2026-01-01",
    "2026-01-31",
    new Set(),
    5,
  );

  assert.equal(balance, 17.34);
  console.log("account balance oversized-window regression passed");
}

void main();
