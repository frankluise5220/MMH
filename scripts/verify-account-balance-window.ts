import assert from "node:assert/strict";

type Row = Record<string, unknown>;
type LinkRow = Row & { cashEntryId?: string | null };

/** 只覆盖本脚本用到的 Prisma where 形状：字段值、in/notIn、日期区间、AND/OR。 */
function matchesValue(value: unknown, condition: unknown, links?: LinkRow[]): boolean {
  if (condition === null || condition === undefined) return value === condition;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;
  const c = condition as Record<string, unknown>;
  if ("in" in c) return (c.in as unknown[]).includes(value);
  if ("notIn" in c) return !(c.notIn as unknown[]).includes(value);
  if ("gt" in c || "gte" in c || "lte" in c || "lt" in c) {
    if (!(value instanceof Date)) return false;
    const t = value.getTime();
    if ("gt" in c && !(t > (c.gt as Date).getTime())) return false;
    if ("gte" in c && !(t >= (c.gte as Date).getTime())) return false;
    if ("lte" in c && !(t <= (c.lte as Date).getTime())) return false;
    if ("lt" in c && !(t < (c.lt as Date).getTime())) return false;
    return true;
  }
  if ("is" in c) return matchesWhere(value as Row, c.is, links);
  if ("not" in c) return value !== c.not;
  return false;
}

function matchesWhere(row: Row, where: unknown, links?: LinkRow[]): boolean {
  if (!where || typeof where !== "object") return true;
  for (const [key, condition] of Object.entries(where as Record<string, unknown>)) {
    if (condition === undefined) continue;
    if (key === "AND") {
      if (!(condition as unknown[]).every((item) => matchesWhere(row, item, links))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(condition as unknown[]).some((item) => matchesWhere(row, item, links))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matchesWhere(row, condition, links)) return false;
      continue;
    }
    // 投资收款腿：资金侧交易日（到账日）落在窗口必须能被粗筛取到。
    if (key === "EntryBusinessLinkCash") {
      const some = (condition as { some?: unknown }).some;
      const cashLinks = (links ?? []).filter((link) => link.cashEntryId === row.id);
      if (!cashLinks.some((link) => matchesWhere(link, some, links))) return false;
      continue;
    }
    if (!matchesValue(row[key], condition, links)) return false;
  }
  return true;
}

const account = {
  id: "account-1",
  kind: "cash",
  investProductType: null,
  billingDay: null,
};
const hid = { householdId: "household-1" };

/* ---------- 用例 1：超限窗口折叠 ---------- */

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
  principalAmount: null,
  fundProductType: null,
  fundSubtype: null,
  fundConfirmDate: null,
  fundArrivalDate: null,
  fundArrivalAmount: null,
  depositSourceEntryId: null,
  deletedAt: null,
};

let findManyCalls = 0;
const oversizedDb = {
  txRecord: {
    count: async () => 0,
    findMany: async () => {
      findManyCalls += 1;
      return findManyCalls === 2 ? [ordinaryRow] : [];
    },
  },
};

/* ---------- 用例 2：赎回现金腿跨 31 天窗口 ---------- */

const CASH = "account-1";
const FUND = "fund-account";

// 09-24 申请、10-08 到账：TxRecord 上只有申请日，到账日只在 fund_transactions。
const redeemCashLeg = {
  id: "tx-redeem",
  householdId: "household-1",
  date: new Date(2026, 8, 24),
  postedAt: null,
  createdAt: new Date(2026, 9, 16, 13, 33),
  dayOrder: 0,
  type: "investment",
  amount: 14476.83,
  accountId: FUND,
  toAccountId: CASH,
  toNote: null,
  source: "manual",
  principalAmount: null,
  fundProductType: null,
  fundSubtype: null,
  fundConfirmDate: null,
  fundArrivalDate: null,
  fundArrivalAmount: null,
  depositSourceEntryId: null,
  reconciledAt: null,
  reconciledBalance: null,
  deletedAt: null,
};

const links = [
  {
    id: "link-1",
    householdId: "household-1",
    cashEntryId: "tx-redeem",
    businessEntryId: null,
    deletedAt: null,
    FundTransaction: {
      fundSubtype: "redeem",
      arrivalDate: new Date(2026, 9, 8),
      cashAccountId: CASH,
      deletedAt: null,
    },
    WealthTransaction: null,
  },
];

const rows: Row[] = [redeemCashLeg];

const redeemDb = {
  txRecord: {
    aggregate: async () => ({ _min: { date: redeemCashLeg.date, postedAt: null, fundArrivalDate: null } }),
    count: async ({ where }: { where?: unknown }) =>
      rows.filter((row) => matchesWhere(row, where, links as never)).length,
    findMany: async ({ where, skip, take }: { where?: unknown; skip?: number; take?: number }) => {
      const filtered = rows.filter((row) => matchesWhere(row, where, links as never));
      const start = skip ?? 0;
      return filtered.slice(start, start + (take ?? filtered.length));
    },
  },
  entryBusinessLink: {
    findMany: async () => links,
  },
};

async function main() {
  process.env.DATABASE_URL ??= "postgresql://mmh:mmh@127.0.0.1:5432/mmh_test";
  const { foldOversizedBalanceWindow, foldAccountBalanceBatched } = await import("../src/lib/server/account-balance");

  const oversized = await foldOversizedBalanceWindow(
    oversizedDb as never,
    account as never,
    hid,
    "2026-01-01",
    "2026-01-31",
    new Set(),
    5,
  );
  assert.equal(oversized, 17.34);

  // 锚点 2026-08-25 起算：窗口 (08-24, 09-24] 取到该行但到账日 10-08 不在窗口内，
  // 窗口 (09-24, 10-25] 必须按到账日把它取回来，否则这 14476.83 永久漏算。
  const crossWindow = await foldAccountBalanceBatched(account as never, hid, {
    client: redeemDb as never,
    fromKeyExclusive: "2026-08-24",
    startingBalance: 7455.27,
  });
  assert.equal(Number(crossWindow.toFixed(2)), 21932.1);

  console.log("account balance window regressions passed");
}

void main();
