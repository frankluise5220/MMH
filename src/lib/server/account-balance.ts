import { prisma } from "@/lib/db/prisma";
import { AccountKind, Prisma, TransactionType } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  applyBalanceReconcileEntry,
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  BALANCE_RECONCILE_TARGET_PREFIX,
  getBalanceReconcileTarget,
} from "@/lib/balance-reconcile";
import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { debtPrincipalForAccountSide } from "@/lib/debt";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import { logger } from "@/lib/logger";

const FX_CONVERSION_SOURCE = "fx_conversion";
const BALANCE_ENTRY_PAGE_SIZE = 5000;
const BALANCE_WINDOW_MAX_ROWS = 20000;
const BALANCE_WINDOW_DAYS = 31;
const BALANCE_ANCHOR_MAX_ROWS = 2000;

export const BALANCE_ENTRY_SELECT = {
  id: true,
  date: true,
  postedAt: true,
  createdAt: true,
  dayOrder: true,
  type: true,
  amount: true,
  accountId: true,
  toAccountId: true,
  toNote: true,
  source: true,
  debtPrincipalAmount: true,
  fundProductType: true,
  fundSubtype: true,
  fundConfirmDate: true,
  fundArrivalDate: true,
  fundArrivalAmount: true,
  depositSourceEntryId: true,
  deletedAt: true,
} as const;

export type BalanceEntryRow = Prisma.TxRecordGetPayload<{ select: typeof BALANCE_ENTRY_SELECT }>;
export type EntryBalanceChange = { entryId: string; previous?: BalanceEntryRow | null };

type AccountBalanceLike = {
  id: string;
  kind: AccountKind;
  investProductType?: string | null;
  billingDay?: number | null;
};

type AccountBalanceRecord = AccountBalanceLike & {
  householdId?: string;
  balance?: unknown;
  balanceRecomputedAt?: Date | null;
};

type BalanceDbClient = Prisma.TransactionClient | typeof prisma;

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromLocalKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDaysToLocalKey(key: string, days: number) {
  const date = dateFromLocalKey(key);
  date.setDate(date.getDate() + days);
  return localDateKey(date);
}

function endOfLocalDayKey(key: string) {
  const date = dateFromLocalKey(key);
  date.setHours(23, 59, 59, 999);
  return date;
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function isBalanceAnchorEntry(entry: Pick<BalanceEntryRow, "source" | "toNote">) {
  return (
    (entry.source === BALANCE_RECONCILE_SOURCE || entry.source === BALANCE_INITIALIZATION_SOURCE) &&
    getBalanceReconcileTarget(entry) != null
  );
}

function isDepositAccountLike(account: AccountBalanceLike) {
  return account.kind === AccountKind.deposit || account.investProductType === "deposit";
}

function isDepositDividendEntry(entry: Pick<BalanceEntryRow, "fundSubtype">) {
  return entry.fundSubtype === "dividend_cash" || entry.fundSubtype === "dividend_reinvest";
}

function isDepositRedemptionEntry(entry: Pick<BalanceEntryRow, "fundSubtype">) {
  return entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
}

function isDepositPrincipalEntry(
  entry: Pick<BalanceEntryRow, "type" | "fundProductType" | "fundSubtype">,
) {
  return (
    entry.type === TransactionType.investment &&
    entry.fundProductType === "deposit" &&
    !isDepositDividendEntry(entry)
  );
}

function isLiveBalanceEntry(
  entry: BalanceEntryRow | null | undefined,
): entry is BalanceEntryRow {
  return !!entry && !entry.deletedAt;
}

function foldBalanceEntry(
  runningBalance: number,
  entry: BalanceEntryRow,
  account: AccountBalanceLike,
) {
  if (account.kind === AccountKind.bank_credit) return 0;
  // Deposit principal is maintained from deposit lots and redemptions, not
  // by folding the investment cash-flow rows a second time.
  if (isDepositAccountLike(account) && isDepositPrincipalEntry(entry)) {
    return runningBalance;
  }
  if (isLoanOrSettlementAccountKind(account.kind)) {
    if (getBalanceReconcileTarget(entry) != null) {
      return applyBalanceReconcileEntry(runningBalance, entry, account.id);
    }
    if (entry.type !== TransactionType.transfer) return runningBalance;
    return runningBalance + debtPrincipalForAccountSide(entry, account.id);
  }
  return applyBalanceReconcileEntry(runningBalance, entry, account.id);
}

function balanceEntryDelta(entry: BalanceEntryRow, account: AccountBalanceLike) {
  if (isBalanceAnchorEntry(entry)) return null;
  if (isLoanOrSettlementAccountKind(account.kind)) {
    if (entry.type !== TransactionType.transfer) return 0;
    return debtPrincipalForAccountSide(entry, account.id);
  }
  return applyBalanceReconcileEntry(0, entry, account.id);
}

async function computeDepositPrincipalBalanceAsOf(
  accountId: string,
  asOfKey: string,
  householdId: string,
) {
  const asOf = endOfLocalDayKey(asOfKey);
  const rows = await prisma.$queryRaw<Array<{ principal: unknown }>>(Prisma.sql`
    SELECT COALESCE(
      SUM(ABS(COALESCE(b."fundArrivalAmount", b."amount"))),
      0
    ) AS "principal"
    FROM "transactions" b
    WHERE b."deletedAt" IS NULL
      AND b."householdId" = ${householdId}
      AND b."type" = ${TransactionType.investment}
      AND b."fundProductType" = 'deposit'
      AND b."toAccountId" = ${accountId}
      AND b."fundSubtype" NOT IN ('redeem', 'switch_out', 'dividend_cash', 'dividend_reinvest')
      AND b."date" <= ${asOf}
      AND NOT EXISTS (
        SELECT 1
        FROM "transactions" r
        WHERE r."deletedAt" IS NULL
          AND r."householdId" = ${householdId}
          AND r."type" = ${TransactionType.investment}
          AND r."fundProductType" = 'deposit'
          AND r."accountId" = ${accountId}
          AND r."depositSourceEntryId" = b."id"
          AND r."fundSubtype" IN ('redeem', 'switch_out')
          AND r."date" <= ${asOf}
      )
  `);
  return toNumber(rows[0]?.principal);
}

type DepositPrincipalChangeRow = {
  change: EntryBalanceChange;
  current: BalanceEntryRow | null;
};

function depositPrincipalBalanceFromRows(
  lots: Map<string, BalanceEntryRow>,
  redemptions: Map<string, BalanceEntryRow>,
  accountId: string,
  asOfKey: string,
) {
  const asOf = endOfLocalDayKey(asOfKey);
  const closedLotIds = new Set<string>();
  for (const redemption of redemptions.values()) {
    if (!isLiveBalanceEntry(redemption) || !isDepositRedemptionEntry(redemption)) continue;
    if (!redemption.depositSourceEntryId || redemption.date > asOf) continue;
    closedLotIds.add(redemption.depositSourceEntryId);
  }

  let principal = 0;
  for (const lot of lots.values()) {
    if (!isLiveBalanceEntry(lot) || !isDepositPrincipalEntry(lot)) continue;
    if (isDepositRedemptionEntry(lot)) continue;
    if (lot.toAccountId !== accountId || lot.date > asOf) continue;
    if (closedLotIds.has(lot.id)) continue;
    principal += Math.abs(toNumber(lot.fundArrivalAmount ?? lot.amount));
  }
  return roundMoney(principal);
}

async function computeDepositPrincipalChangeDelta(
  rows: DepositPrincipalChangeRow[],
  accountId: string,
  householdId: string,
  asOfKey: string,
) {
  const lotIds = new Set<string>();
  for (const { change, current } of rows) {
    for (const entry of [change.previous ?? null, current]) {
      if (!entry || !isDepositPrincipalEntry(entry)) continue;
      if (isDepositRedemptionEntry(entry)) {
        if (entry.accountId === accountId && entry.depositSourceEntryId) {
          lotIds.add(entry.depositSourceEntryId);
        }
      } else if (entry.toAccountId === accountId) {
        lotIds.add(entry.id);
      }
    }
  }
  if (lotIds.size === 0) return 0;

  const ids = Array.from(lotIds);
  const lots = await prisma.txRecord.findMany({
    where: {
      id: { in: ids },
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
    },
    select: BALANCE_ENTRY_SELECT,
  });
  const redemptions = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundProductType: "deposit",
      accountId,
      depositSourceEntryId: { in: ids },
      fundSubtype: { in: ["redeem", "switch_out"] },
    },
    select: BALANCE_ENTRY_SELECT,
  });

  const afterLots = new Map(lots.map((entry) => [entry.id, entry]));
  const afterRedemptions = new Map(redemptions.map((entry) => [entry.id, entry]));
  for (const { current } of rows) {
    if (!current) continue;
    if (isDepositPrincipalEntry(current) && !isDepositRedemptionEntry(current)) {
      afterLots.set(current.id, current);
    } else {
      afterLots.delete(current.id);
    }
    if (isDepositRedemptionEntry(current)) {
      afterRedemptions.set(current.id, current);
    } else {
      afterRedemptions.delete(current.id);
    }
  }

  const beforeLots = new Map(afterLots);
  const beforeRedemptions = new Map(afterRedemptions);
  for (const { change } of rows) {
    const previous = change.previous ?? null;
    if (previous && isDepositPrincipalEntry(previous) && !isDepositRedemptionEntry(previous)) {
      beforeLots.set(previous.id, previous);
    } else {
      beforeLots.delete(change.entryId);
    }
    if (previous && isDepositRedemptionEntry(previous)) {
      beforeRedemptions.set(previous.id, previous);
    } else {
      beforeRedemptions.delete(change.entryId);
    }
  }

  const after = depositPrincipalBalanceFromRows(afterLots, afterRedemptions, accountId, asOfKey);
  const before = depositPrincipalBalanceFromRows(beforeLots, beforeRedemptions, accountId, asOfKey);
  return roundMoney(after - before);
}

function entryTouchesAccount(entry: Pick<BalanceEntryRow, "accountId" | "toAccountId" | "source">, accountId: string) {
  if (entry.accountId === accountId) return true;
  return entry.toAccountId === accountId && entry.source !== FX_CONVERSION_SOURCE;
}

function entryAffectsBalance(
  entry: BalanceEntryRow,
  accountId: string,
  anchor: BalanceEntryRow | null,
  todayKey: string,
) {
  if (!entryTouchesAccount(entry, accountId)) return false;
  const entryDay = localDateKey(getDetailEntryDisplayDate(entry, accountId));
  if (entryDay > todayKey) return false;
  if (anchor && compareDetailEntriesAsc(anchor, entry, accountId) >= 0) return false;
  return true;
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
    // TxRecord is the source of truth for deposit principal. The
    // DepositTransaction table is a projection and does not participate here.
    const depositEntries = await prisma.txRecord.findMany({
      where: {
        ...txWhere,
        type: TransactionType.investment,
        fundProductType: "deposit",
        OR: [
          { accountId: { in: depositAccountIds } },
          { toAccountId: { in: depositAccountIds } },
        ],
      },
      select: {
        id: true,
        date: true,
        createdAt: true,
        accountId: true,
        toAccountId: true,
        amount: true,
        fundArrivalAmount: true,
        fundSubtype: true,
        depositSourceEntryId: true,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });

    const remainingByLotId = new Map<string, { depositAccountId: string; amount: number }>();
    for (const entry of depositEntries) {
      if (!isOnOrBeforeToday(entry.date)) continue;
      // Interest payout / reinvest rows are cash flows, not principal lots:
      // they must neither open a lot nor close the source one.
      const isRedeem = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
      const isDividend = entry.fundSubtype === "dividend_cash" || entry.fundSubtype === "dividend_reinvest";
      if (isDividend) continue;
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

    // Deposit accounts may also carry ordinary income/expense and transfers.
    // Deposit principal was handled above from TxRecord lots, so only
    // non-deposit TxRecords are layered on top here to avoid double counting.
    const depositTxRows = await prisma.txRecord.findMany({
      where: {
        ...txWhere,
        ...txRecordAccountScopeWhere(depositAccountIds),
        NOT: {
          type: TransactionType.investment,
          fundProductType: "deposit",
        },
      },
      select: {
        id: true,
        date: true,
        postedAt: true,
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

    const depositTxByAccountId = new Map<string, typeof depositTxRows>();
    for (const accountId of depositAccountIds) {
      depositTxByAccountId.set(accountId, []);
    }
    for (const entry of depositTxRows) {
      if (entry.accountId && depositTxByAccountId.has(entry.accountId)) {
        depositTxByAccountId.get(entry.accountId)?.push(entry);
      }
      if (entry.source !== FX_CONVERSION_SOURCE && entry.toAccountId && depositTxByAccountId.has(entry.toAccountId)) {
        depositTxByAccountId.get(entry.toAccountId)?.push(entry);
      }
    }

    for (const account of accounts) {
      if (!depositAccountIdSet.has(account.id)) continue;
      const rows = depositTxByAccountId.get(account.id) ?? [];
      const orderedRows = rows
        .filter((entry) => isOnOrBeforeToday(getDetailEntryDisplayDate(entry, account.id)))
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = result.get(account.id) ?? 0;
      for (const entry of orderedRows) {
        runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
      }
      result.set(account.id, runningBalance);
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
        ...txRecordAccountScopeWhere(nonDepositAccountIds),
      },
      select: {
        id: true,
        date: true,
        postedAt: true,
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
      if (entry.source !== FX_CONVERSION_SOURCE && entry.toAccountId && txByAccountId.has(entry.toAccountId)) {
        txByAccountId.get(entry.toAccountId)?.push(entry);
      }
    }

    for (const account of nonDepositAccounts) {
      if (account.kind === AccountKind.bank_credit) {
        // Credit-card balances always come from the CreditCardCycle cache
        // (billing.ts). Fold to 0 here even when billingDay is unset, so a
        // card without a billing day is never treated as a plain account
        // whose balance accumulates transaction flows.
        result.set(account.id, 0);
        continue;
      }

      const rows = txByAccountId.get(account.id) ?? [];
      const orderedRows = rows
        .filter((entry) => isOnOrBeforeToday(getDetailEntryDisplayDate(entry, account.id)))
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = 0;
      for (const entry of orderedRows) {
        if (isLoanOrSettlementAccountKind(account.kind)) {
          if (getBalanceReconcileTarget(entry) != null) {
            runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
            continue;
          }
          if (entry.type !== TransactionType.transfer) continue;
          runningBalance += debtPrincipalForAccountSide(entry, account.id);
          continue;
        }
        runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
      }
      result.set(account.id, runningBalance);
    }
  }

  return result;
}

export async function computeLoanPrincipalBalancesAsOf(
  accounts: AccountBalanceLike[],
  hidFilter: { householdId?: string } | undefined,
  asOfDate: Date,
  options?: {
    excludeEntryId?: string | null;
    // 传入事务 client 时，余额计算能看到同一事务里尚未提交的借还款流水
    client?: Prisma.TransactionClient | typeof prisma;
  },
) {
  const db = options?.client ?? prisma;
  const accountIds = accounts
    .filter((account) => isLoanOrSettlementAccountKind(account.kind))
    .map((account) => account.id)
    .filter(Boolean);
  const result = new Map<string, number>();
  for (const accountId of accountIds) {
    result.set(accountId, 0);
  }
  if (accountIds.length === 0 || !Number.isFinite(asOfDate.getTime())) return result;

  const asOfDateKey = asOfDate.toISOString().slice(0, 10);
  const txRows = await db.txRecord.findMany({
    where: {
      deletedAt: null,
      ...(hidFilter ?? {}),
      ...txRecordAccountScopeWhere(accountIds),
      ...(options?.excludeEntryId ? { id: { not: options.excludeEntryId } } : {}),
    },
    select: {
      id: true,
      date: true,
      postedAt: true,
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
  for (const accountId of accountIds) {
    txByAccountId.set(accountId, []);
  }
  for (const entry of txRows) {
    if (entry.accountId && txByAccountId.has(entry.accountId)) {
      txByAccountId.get(entry.accountId)?.push(entry);
    }
    if (entry.source !== FX_CONVERSION_SOURCE && entry.toAccountId && txByAccountId.has(entry.toAccountId)) {
      txByAccountId.get(entry.toAccountId)?.push(entry);
    }
  }

  for (const accountId of accountIds) {
    const orderedRows = (txByAccountId.get(accountId) ?? [])
      .filter((entry) => getDetailEntryDisplayDate(entry, accountId).toISOString().slice(0, 10) <= asOfDateKey)
      .sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    let runningBalance = 0;
    for (const entry of orderedRows) {
      const reconcileTarget = getBalanceReconcileTarget(entry);
      if (reconcileTarget != null) {
        runningBalance = reconcileTarget;
        continue;
      }
      if (entry.type !== TransactionType.transfer) continue;
      runningBalance += debtPrincipalForAccountSide(entry, accountId);
    }
    result.set(accountId, runningBalance);
  }

  return result;
}

async function findFirstBalanceEntryKey(
  db: BalanceDbClient,
  accountId: string,
  hidFilter?: { householdId?: string },
) {
  const aggregate = await db.txRecord.aggregate({
    where: {
      deletedAt: null,
      ...(hidFilter ?? {}),
      ...txRecordAccountScopeWhere([accountId]),
    },
    _min: {
      date: true,
      postedAt: true,
      fundArrivalDate: true,
    },
  });
  const dates = [
    aggregate._min.date,
    aggregate._min.postedAt,
    aggregate._min.fundArrivalDate,
  ].filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()));
  if (dates.length === 0) return null;
  return dates.reduce((min, date) => {
    const key = localDateKey(date);
    return key < min ? key : min;
  }, localDateKey(dates[0]));
}

async function findBalanceWindowRows(
  db: BalanceDbClient,
  accountId: string,
  hidFilter: { householdId?: string } | undefined,
  startKeyExclusive: string,
  endKeyInclusive: string,
  excludeEntryIds: Set<string>,
) {
  const where = buildBalanceWindowWhere(accountId, hidFilter, startKeyExclusive, endKeyInclusive);
  const filteredWhere =
    excludeEntryIds.size > 0
      ? { AND: [where, { id: { notIn: Array.from(excludeEntryIds) } }] }
      : where;

  const count = await db.txRecord.count({ where: filteredWhere });
  if (count === 0) return { rows: [] as BalanceEntryRow[], tooMany: false, count };
  if (count > BALANCE_WINDOW_MAX_ROWS) {
    // Do not page an over-limit window into Node memory. The caller narrows the
    // window first and falls back to the bounded day fold only when needed.
    return { rows: [] as BalanceEntryRow[], tooMany: true, count };
  }

  const rows: BalanceEntryRow[] = [];
  for (let skip = 0; skip < count; skip += BALANCE_ENTRY_PAGE_SIZE) {
    const page = await db.txRecord.findMany({
      where: filteredWhere,
      select: BALANCE_ENTRY_SELECT,
      orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip,
      take: BALANCE_ENTRY_PAGE_SIZE,
    });
    rows.push(...page);
  }

  return {
    rows,
    tooMany: false,
    count,
  };
}

function buildBalanceWindowWhere(
  accountId: string,
  hidFilter: { householdId?: string } | undefined,
  startKeyExclusive: string,
  endKeyInclusive: string,
) {
  const lowerBound = dateFromLocalKey(startKeyExclusive);
  const upperBound = dateFromLocalKey(addDaysToLocalKey(endKeyInclusive, 2));
  return {
    deletedAt: null,
    ...(hidFilter ?? {}),
    AND: [
      txRecordAccountScopeWhere([accountId]),
      {
        OR: [
          { date: { gt: lowerBound, lte: upperBound } },
          { postedAt: { gt: lowerBound, lte: upperBound } },
          { fundArrivalDate: { gt: lowerBound, lte: upperBound } },
        ],
      },
    ],
  } satisfies Prisma.TxRecordWhereInput;
}

function balanceAnchorMatchWhere() {
  return {
    source: { in: [BALANCE_RECONCILE_SOURCE, BALANCE_INITIALIZATION_SOURCE] },
    toNote: { startsWith: BALANCE_RECONCILE_TARGET_PREFIX },
  } satisfies Prisma.TxRecordWhereInput;
}

function findBalanceAnchorSegmentIndex(
  anchors: BalanceEntryRow[],
  row: BalanceEntryRow,
  accountId: string,
) {
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareDetailEntriesAsc(anchors[middle], row, accountId) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Exported for regression coverage. Production callers should use
 * `foldAccountBalanceBatched`.
 */
export async function foldOversizedBalanceWindow(
  db: BalanceDbClient,
  account: AccountBalanceLike,
  hidFilter: { householdId?: string } | undefined,
  startKeyExclusive: string,
  endKeyInclusive: string,
  excludeEntryIds: Set<string>,
  startingBalance: number,
) {
  const windowWhere = buildBalanceWindowWhere(
    account.id,
    hidFilter,
    startKeyExclusive,
    endKeyInclusive,
  );
  const excludedWhere =
    excludeEntryIds.size > 0
      ? { AND: [windowWhere, { id: { notIn: Array.from(excludeEntryIds) } }] }
      : windowWhere;
  const anchorMatch = balanceAnchorMatchWhere();

  const anchorWhere = { AND: [excludedWhere, anchorMatch] };
  const anchorCount = await db.txRecord.count({ where: anchorWhere });
  if (anchorCount > BALANCE_ANCHOR_MAX_ROWS) {
    throw new Error(
      `account balance window has ${anchorCount} anchor rows; refusing to fold ` +
        `${account.id} ${startKeyExclusive}..${endKeyInclusive}`,
    );
  }
  const anchors = await db.txRecord.findMany({
    where: anchorWhere,
    select: BALANCE_ENTRY_SELECT,
    orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const orderedAnchors = anchors
    .filter((row) => getBalanceReconcileTarget(row) != null)
    .filter((row) => {
      const day = localDateKey(getDetailEntryDisplayDate(row, account.id));
      return day > startKeyExclusive && day <= endKeyInclusive;
    })
    .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));

  // The normal path sorts the whole window and folds in comparator order.
  // Keep that semantics without loading the window: accumulate ordinary rows
  // into the segment after the last preceding anchor, then apply each segment
  // after its anchor resets the running balance.
  const segmentDeltas = new Array<number>(orderedAnchors.length + 1).fill(0);
  let cursorId: string | null = null;
  while (true) {
    const page = await db.txRecord.findMany({
      where: cursorId
        ? { AND: [excludedWhere, { id: { gt: cursorId } }] }
        : excludedWhere,
      select: BALANCE_ENTRY_SELECT,
      orderBy: { id: "asc" },
      take: BALANCE_ENTRY_PAGE_SIZE,
    });
    if (page.length === 0) break;
    for (const row of page) {
      if (isBalanceAnchorEntry(row)) continue;
      const day = localDateKey(getDetailEntryDisplayDate(row, account.id));
      if (day <= startKeyExclusive || day > endKeyInclusive) continue;
      const segmentIndex = findBalanceAnchorSegmentIndex(orderedAnchors, row, account.id);
      segmentDeltas[segmentIndex] += foldBalanceEntry(0, row, account);
    }
    cursorId = page.at(-1)?.id ?? null;
    if (!cursorId || page.length < BALANCE_ENTRY_PAGE_SIZE) break;
  }

  let runningBalance = startingBalance + segmentDeltas[0];
  for (let index = 0; index < orderedAnchors.length; index += 1) {
    runningBalance = foldBalanceEntry(runningBalance, orderedAnchors[index], account);
    runningBalance += segmentDeltas[index + 1];
  }

  return runningBalance;
}

type BalanceFoldRangeResult = {
  balance: number;
  asOfKey: string;
  done: boolean;
};

async function foldAccountBalanceRange(
  account: AccountBalanceLike,
  hidFilter: { householdId?: string } | undefined,
  options?: {
    client?: BalanceDbClient;
    fromKeyExclusive?: string;
    toKeyInclusive?: string;
    startingBalance?: number;
    excludeEntryIds?: Iterable<string>;
    maxWindows?: number;
  },
): Promise<BalanceFoldRangeResult> {
  const todayKey = localDateKey(new Date());
  const targetKey = options?.toKeyInclusive && options.toKeyInclusive < todayKey
    ? options.toKeyInclusive
    : todayKey;
  if (account.kind === AccountKind.bank_credit) {
    return {
      balance: 0,
      asOfKey: targetKey,
      done: true,
    };
  }
  const db = options?.client ?? prisma;
  const excludeEntryIds = new Set(options?.excludeEntryIds ?? []);
  const maxWindows = Number.isFinite(options?.maxWindows)
    ? Math.max(1, Math.floor(options?.maxWindows ?? 1))
    : Number.POSITIVE_INFINITY;
  let cursor: string;
  if (options?.fromKeyExclusive) {
    cursor = options.fromKeyExclusive;
  } else {
    const firstKey = await findFirstBalanceEntryKey(db, account.id, hidFilter);
    if (!firstKey) {
      return {
        balance: options?.startingBalance ?? 0,
        asOfKey: targetKey,
        done: true,
      };
    }
    cursor = addDaysToLocalKey(firstKey, -1);
  }

  let runningBalance = options?.startingBalance ?? 0;
  if (cursor >= targetKey) {
    return {
      balance: runningBalance,
      asOfKey: cursor,
      done: true,
    };
  }

  let windowDays = BALANCE_WINDOW_DAYS;
  let processedWindows = 0;
  while (cursor < targetKey) {
    const windowEnd = addDaysToLocalKey(cursor, windowDays) < targetKey
      ? addDaysToLocalKey(cursor, windowDays)
      : targetKey;
    const { rows, tooMany } = await findBalanceWindowRows(
      db,
      account.id,
      hidFilter,
      cursor,
      windowEnd,
      excludeEntryIds,
    );
    if (tooMany && windowDays > 1) {
      windowDays = Math.max(1, Math.floor(windowDays / 2));
      continue;
    }
    if (tooMany) {
      runningBalance = await foldOversizedBalanceWindow(
        db,
        account,
        hidFilter,
        cursor,
        windowEnd,
        excludeEntryIds,
        runningBalance,
      );
      cursor = windowEnd;
      windowDays = BALANCE_WINDOW_DAYS;
      processedWindows += 1;
      if (processedWindows >= maxWindows && cursor < targetKey) {
        return { balance: runningBalance, asOfKey: cursor, done: false };
      }
      continue;
    }

    rows.sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
    for (const row of rows) {
      const day = localDateKey(getDetailEntryDisplayDate(row, account.id));
      if (day <= cursor || day > windowEnd) continue;
      runningBalance = foldBalanceEntry(runningBalance, row, account);
    }
    cursor = windowEnd;
    windowDays = BALANCE_WINDOW_DAYS;
    processedWindows += 1;
    if (processedWindows >= maxWindows && cursor < targetKey) {
      return { balance: runningBalance, asOfKey: cursor, done: false };
    }
  }

  return {
    balance: runningBalance,
    asOfKey: cursor,
    done: true,
  };
}

export async function foldAccountBalanceBatched(
  account: AccountBalanceLike,
  hidFilter: { householdId?: string } | undefined,
  options?: {
    client?: BalanceDbClient;
    fromKeyExclusive?: string;
    startingBalance?: number;
    excludeEntryIds?: Iterable<string>;
  },
) {
  const result = await foldAccountBalanceRange(account, hidFilter, options);
  return result.balance;
}

export async function loadLastBalanceAnchor(
  accountId: string,
  todayKey = localDateKey(new Date()),
  hidFilter?: { householdId?: string },
) {
  const where = {
    deletedAt: null,
    ...(hidFilter ?? {}),
    AND: [txRecordAccountScopeWhere([accountId]), balanceAnchorMatchWhere()],
  } satisfies Prisma.TxRecordWhereInput;
  let lastAnchor: BalanceEntryRow | null = null;
  let cursorId: string | null = null;
  while (true) {
    const page = await prisma.txRecord.findMany({
      where: cursorId ? { AND: [where, { id: { gt: cursorId } }] } : where,
      select: BALANCE_ENTRY_SELECT,
      orderBy: { id: "asc" },
      take: BALANCE_ENTRY_PAGE_SIZE,
    });
    if (page.length === 0) break;
    for (const row of page) {
      if (getBalanceReconcileTarget(row) == null) continue;
      if (localDateKey(getDetailEntryDisplayDate(row, accountId)) > todayKey) continue;
      if (!lastAnchor || compareDetailEntriesAsc(lastAnchor, row, accountId) < 0) {
        lastAnchor = row;
      }
    }
    cursorId = page.at(-1)?.id ?? null;
    if (!cursorId || page.length < BALANCE_ENTRY_PAGE_SIZE) break;
  }
  return lastAnchor;
}

export async function advanceStoredBalanceToToday(
  account: AccountBalanceLike,
  storedBalance: number,
  asOf: Date | null | undefined,
  hidFilter?: { householdId?: string },
  options?: {
    excludeEntryIds?: Iterable<string>;
  },
) {
  if (!asOf) {
    // Missing timestamps are upgraded accounts. Treat the persisted balance as
    // the current baseline in request paths; the system task bootstraps the
    // timestamp with a full fold outside the user request.
    return storedBalance;
  }
  const todayKey = localDateKey(new Date());
  const asOfKey = localDateKey(asOf);
  if (asOfKey >= todayKey) return storedBalance;
  return foldAccountBalanceBatched(account, hidFilter, {
    fromKeyExclusive: asOfKey,
    startingBalance: storedBalance,
    excludeEntryIds: options?.excludeEntryIds,
  });
}

async function writeAccountBalance(
  accountId: string,
  balance: number,
  asOf: Date,
  expectedAsOf: Date | null | undefined,
) {
  const updated = await prisma.account.updateMany({
    where: {
      id: accountId,
      balanceRecomputedAt: expectedAsOf ?? null,
    },
    data: {
      balance: roundMoney(balance).toFixed(2),
      balanceRecomputedAt: asOf,
    },
  });
  return updated.count > 0;
}

async function advanceAccountBalanceStep(accountId: string, maxWindows = 1) {
  const acc = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      householdId: true,
      kind: true,
      investProductType: true,
      billingDay: true,
      balance: true,
      balanceRecomputedAt: true,
    },
  });
  if (!acc) return false;

  const todayKey = localDateKey(new Date());
  const todayEnd = endOfLocalDayKey(todayKey);
  const account = {
    id: acc.id,
    kind: acc.kind,
    investProductType: acc.investProductType,
    billingDay: acc.billingDay,
  };

  if (acc.kind === AccountKind.bank_credit) {
    if (acc.balanceRecomputedAt && localDateKey(acc.balanceRecomputedAt) >= todayKey) return false;
    return writeAccountBalance(accountId, 0, todayEnd, acc.balanceRecomputedAt).catch(() => false);
  }

  if (!acc.balanceRecomputedAt) {
    // Accounts upgraded from a release before balanceRecomputedAt already have
    // a maintained Account.balance. Adopt it as the baseline instead of
    // starting a full ledger scan from the system task. The explicit
    // recalculate/reconcile actions remain available when a full rebuild is
    // requested.
    return writeAccountBalance(accountId, toNumber(acc.balance), todayEnd, null).catch(() => false);
  }

  const asOfKey = localDateKey(acc.balanceRecomputedAt);
  if (asOfKey >= todayKey) return false;

  const hidFilter = { householdId: acc.householdId };
  if (isDepositAccountLike(account)) {
    const anchor = await loadLastBalanceAnchor(accountId, todayKey, hidFilter);
    const anchorDay = anchor ? localDateKey(getDetailEntryDisplayDate(anchor, accountId)) : null;
    if (anchor && anchorDay && anchorDay > asOfKey) {
      const ordinary = await foldAccountBalanceRange(account, hidFilter, {
        fromKeyExclusive: anchorDay,
        toKeyInclusive: todayKey,
        startingBalance: 0,
        maxWindows,
      });
      const principalAtAnchor = await computeDepositPrincipalBalanceAsOf(
        accountId,
        anchorDay,
        acc.householdId,
      );
      const principalAtEnd = await computeDepositPrincipalBalanceAsOf(
        accountId,
        ordinary.asOfKey,
        acc.householdId,
      );
      const nextBalance =
        (getBalanceReconcileTarget(anchor) ?? 0) +
        ordinary.balance +
        principalAtEnd -
        principalAtAnchor;
      return writeAccountBalance(
        accountId,
        nextBalance,
        endOfLocalDayKey(ordinary.asOfKey),
        acc.balanceRecomputedAt,
      ).catch(() => false);
    }

    const ordinary = await foldAccountBalanceRange(account, hidFilter, {
      fromKeyExclusive: asOfKey,
      toKeyInclusive: todayKey,
      startingBalance: toNumber(acc.balance),
      maxWindows,
    });
    const principalAtStart = await computeDepositPrincipalBalanceAsOf(
      accountId,
      asOfKey,
      acc.householdId,
    );
    const principalAtEnd = await computeDepositPrincipalBalanceAsOf(
      accountId,
      ordinary.asOfKey,
      acc.householdId,
    );
    return writeAccountBalance(
      accountId,
      ordinary.balance + principalAtEnd - principalAtStart,
      endOfLocalDayKey(ordinary.asOfKey),
      acc.balanceRecomputedAt,
    ).catch(() => false);
  }

  const ordinary = await foldAccountBalanceRange(account, hidFilter, {
    fromKeyExclusive: asOfKey,
    toKeyInclusive: todayKey,
    startingBalance: toNumber(acc.balance),
    maxWindows,
  });
  return writeAccountBalance(
    accountId,
    ordinary.balance,
    endOfLocalDayKey(ordinary.asOfKey),
    acc.balanceRecomputedAt,
  ).catch(() => false);
}

/**
 * Recalculate an account's display balance and persist it to Account.balance.
 * For incoming-side records, the receiver always treats the flow as positive.
 */
export async function recalcAndSaveAccountBalance(accountId: string) {
  const acc = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      householdId: true,
      kind: true,
      investProductType: true,
      billingDay: true,
      balance: true,
      balanceRecomputedAt: true,
    },
  });
  if (!acc) return false;
  const todayKey = localDateKey(new Date());
  const asOf = endOfLocalDayKey(todayKey);

  // Credit-bill accounts (bank_credit) always fold to a display balance of 0
  // — computeAccountDisplayBalances discards the folded sum for them because
  // the shown balance is derived from the CreditCardCycle cache. This applies
  // even when billingDay is unset: a card without a billing day must not be
  // treated as a plain account. Skip the full transaction-history scan
  // entirely so saving entries on a credit card does not pull its ledger.
  if (acc.kind === AccountKind.bank_credit) {
    return writeAccountBalance(accountId, 0, asOf, acc.balanceRecomputedAt).catch(() => false);
  }

  const account = {
    id: accountId,
    kind: acc.kind,
    investProductType: acc.investProductType,
    billingDay: acc.billingDay,
  };
  let newBalance = 0;
  if (isDepositAccountLike(account)) {
    const principalToday = await computeDepositPrincipalBalanceAsOf(
      accountId,
      todayKey,
      acc.householdId,
    );
    const anchor = await loadLastBalanceAnchor(accountId, todayKey, { householdId: acc.householdId });
    if (anchor) {
      const anchorDay = localDateKey(getDetailEntryDisplayDate(anchor, accountId));
      const anchorTarget = getBalanceReconcileTarget(anchor) ?? 0;
      const ordinaryAfterAnchor = await foldAccountBalanceBatched(
        account,
        { householdId: acc.householdId },
        {
          fromKeyExclusive: anchorDay,
          startingBalance: 0,
        },
      );
      const principalAtAnchor = await computeDepositPrincipalBalanceAsOf(
        accountId,
        anchorDay,
        acc.householdId,
      );
      newBalance = anchorTarget + ordinaryAfterAnchor + principalToday - principalAtAnchor;
    } else {
      const ordinaryBalance = await foldAccountBalanceBatched(
        account,
        { householdId: acc.householdId },
        { startingBalance: 0 },
      );
      newBalance = principalToday + ordinaryBalance;
    }
  } else {
    const anchor = await loadLastBalanceAnchor(accountId, todayKey, { householdId: acc.householdId });
    const anchorDay = anchor ? localDateKey(getDetailEntryDisplayDate(anchor, accountId)) : null;
    newBalance = await foldAccountBalanceBatched(account, { householdId: acc.householdId }, {
      fromKeyExclusive: anchorDay ? addDaysToLocalKey(anchorDay, -1) : undefined,
      startingBalance: 0,
    });
  }

  return writeAccountBalance(accountId, newBalance, asOf, acc.balanceRecomputedAt).catch(() => false);
}

export async function applyEntryChangesToAccountBalances(changes: EntryBalanceChange[]) {
  if (changes.length === 0) return;
  const currentRows = await Promise.all(
    changes.map(async (change) => ({
      change,
      current: await prisma.txRecord.findUnique({
        where: { id: change.entryId },
        select: BALANCE_ENTRY_SELECT,
      }),
    })),
  );
  const accountIds = new Set<string>();
  for (const { change, current } of currentRows) {
    for (const entry of [change.previous ?? null, current]) {
      if (!entry) continue;
      if (entry.accountId) accountIds.add(entry.accountId);
      if (entry.toAccountId && entry.source !== FX_CONVERSION_SOURCE) accountIds.add(entry.toAccountId);
    }
  }
  if (accountIds.size === 0) return;

  const accounts = await prisma.account.findMany({
    where: { id: { in: Array.from(accountIds) } },
    select: {
      id: true,
      householdId: true,
      kind: true,
      investProductType: true,
      billingDay: true,
      balance: true,
      balanceRecomputedAt: true,
    },
  });
  const todayKey = localDateKey(new Date());
  const asOf = endOfLocalDayKey(todayKey);
  const changedEntryIds = changes.map((change) => change.entryId);

  for (const account of accounts) {
    const accountLike = {
      id: account.id,
      kind: account.kind,
      investProductType: account.investProductType,
      billingDay: account.billingDay,
    };
    if (account.kind === AccountKind.bank_credit) {
      await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }

    const anchor = await loadLastBalanceAnchor(account.id, todayKey, { householdId: account.householdId });
    let previousDelta = 0;
    let currentDelta = 0;
    let requiresFullFold = false;
    for (const { change, current } of currentRows) {
      const previous = change.previous ?? null;
      const previousActive = previous && !previous.deletedAt && entryAffectsBalance(previous, account.id, anchor, todayKey);
      const currentActive = current && !current.deletedAt && entryAffectsBalance(current, account.id, anchor, todayKey);
      if (previousActive) {
        if (isDepositAccountLike(accountLike) && isDepositPrincipalEntry(previous)) {
          continue;
        }
        const delta = balanceEntryDelta(previous, accountLike);
        if (delta == null) requiresFullFold = true;
        else previousDelta += delta;
      }
      if (currentActive) {
        if (isDepositAccountLike(accountLike) && isDepositPrincipalEntry(current)) {
          continue;
        }
        const delta = balanceEntryDelta(current, accountLike);
        if (delta == null) requiresFullFold = true;
        else currentDelta += delta;
      }
    }
    if (requiresFullFold) {
      await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }

    if (!account.balanceRecomputedAt) {
      // Preserve the legacy persisted balance as the upgrade baseline. The
      // background bootstrap will replace it with a fully verified fold.
      const depositDelta = isDepositAccountLike(accountLike)
        ? await computeDepositPrincipalChangeDelta(currentRows, account.id, account.householdId, todayKey)
        : 0;
      const updated = await prisma.account.updateMany({
        where: { id: account.id, balanceRecomputedAt: null },
        data: {
          balance: roundMoney(
            toNumber(account.balance) + currentDelta - previousDelta + depositDelta,
          ).toFixed(2),
        },
      }).catch(() => ({ count: 0 }));
      if (updated.count === 0) await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }

    const asOfKey = localDateKey(account.balanceRecomputedAt);
    if (isDepositAccountLike(accountLike) && asOfKey < todayKey) {
      // Deposit catch-up is a bounded database aggregate plus windowed fold.
      // It runs only when the cached balance has not yet been advanced to
      // today, not on the normal add/edit path.
      await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }
    let previousIncludedDelta = 0;
    for (const { change, current } of currentRows) {
      const previous = change.previous ?? null;
      if (!previous || previous.deletedAt) continue;
      if (!entryAffectsBalance(previous, account.id, anchor, todayKey)) continue;
      if (isDepositAccountLike(accountLike) && isDepositPrincipalEntry(previous)) continue;
      const previousDay = localDateKey(getDetailEntryDisplayDate(previous, account.id));
      if (previousDay > asOfKey) continue;
      const delta = balanceEntryDelta(previous, accountLike);
      if (delta != null) previousIncludedDelta += delta;
    }
    const depositDelta = isDepositAccountLike(accountLike)
      ? await computeDepositPrincipalChangeDelta(currentRows, account.id, account.householdId, todayKey)
      : 0;
    const delta = currentDelta - previousIncludedDelta + depositDelta;
    if (Math.abs(delta) < 0.005 && asOfKey >= todayKey) continue;

    const baseBalance = await advanceStoredBalanceToToday(
      accountLike,
      toNumber(account.balance),
      account.balanceRecomputedAt,
      { householdId: account.householdId },
      { excludeEntryIds: changedEntryIds },
    );
    const saved = await writeAccountBalance(
      account.id,
      baseBalance + delta,
      asOf,
      account.balanceRecomputedAt,
    ).catch(() => false);
    if (!saved) await recalcAndSaveAccountBalance(account.id).catch(() => {});
  }
}

export async function getMaintainedAccountBalances(
  accounts: AccountBalanceLike[],
  hidFilter?: { householdId?: string },
) {
  const result = new Map<string, number>();
  if (accounts.length === 0) return result;
  const rows = await prisma.account.findMany({
    where: {
      id: { in: accounts.map((account) => account.id) },
      ...(hidFilter ?? {}),
    },
    select: {
      id: true,
      kind: true,
      balance: true,
    },
  });
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const account of accounts) {
    const row = rowById.get(account.id);
    result.set(
      account.id,
      row?.kind === AccountKind.bank_credit ? 0 : toNumber(row?.balance),
    );
  }

  return result;
}

/**
 * Upgrade-path bootstrap and stale-cache maintenance for account balances.
 * Keep this off request paths and process a small batch per system-task tick.
 * Legacy rows adopt their existing balance as the baseline; stale rows advance
 * by at most `maxWindowsPerAccount` bounded windows before the next tick.
 */
export async function bootstrapPendingAccountBalances(
  limit = 1,
  maxWindowsPerAccount = 1,
) {
  const todayKey = localDateKey(new Date());
  const startOfToday = dateFromLocalKey(todayKey);
  const accounts = await prisma.account.findMany({
    where: {
      OR: [
        { balanceRecomputedAt: null },
        { balanceRecomputedAt: { lt: startOfToday } },
      ],
    },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: Math.max(1, Math.floor(limit)),
  });
  let bootstrapped = 0;
  for (const account of accounts) {
    try {
      if (await advanceAccountBalanceStep(account.id, maxWindowsPerAccount)) {
        bootstrapped++;
      } else {
        logger.warn(`account balance maintenance did not persist ${account.id}`, "account-balance");
      }
    } catch (error) {
      logger.error(`account balance maintenance failed for ${account.id}`, "account-balance", error);
    }
  }
  return bootstrapped;
}
