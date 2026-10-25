import { prisma } from "@/lib/db/prisma";
import { AccountKind, FundSubtype, Prisma, TransactionType } from "@prisma/client";
import { toNumber, todayDateBusinessYmd } from "@/lib/date-utils";
import { resolveHouseholdTimeZone } from "@/lib/server/business-time-zone";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  applyBalanceAnchorEntry,
  applyBalanceReconcileEntry,
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  BALANCE_RECONCILE_TARGET_PREFIX,
  getBalanceAnchorTarget,
} from "@/lib/balance-reconcile";
import { isLoanOrSettlementAccountKind } from "@/lib/liability";
import { liabilityPrincipalForAccountSide } from "@/lib/liability";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import { logger } from "@/lib/logger";
import { rowWithLinkedInvestmentDisplayDate } from "@/lib/entry-reorder";
import { depositRedemptionPrincipal } from "@/lib/server/deposit-lot-balance";
import { loadEntryLinkedInvestmentDisplay } from "@/lib/server/entry-business-display";
import {
  recomputeAggregateAccountBalance,
  refreshParentAggregateBalance,
} from "@/lib/server/account-hierarchy";

const FX_CONVERSION_SOURCE = "fx_conversion";
const BALANCE_ENTRY_PAGE_SIZE = 5000;
const BALANCE_WINDOW_MAX_ROWS = 20000;
const BALANCE_WINDOW_DAYS = 31;
const BALANCE_ANCHOR_MAX_ROWS = 2000;
/**
 * 资金侧交易日 = 到账日的投资动作。这些行的到账日只存在业务表
 * （`fund_transactions` / `wealth_transactions`），TxRecord 上没有。
 */
const INVESTMENT_CASH_IN_SUBTYPES = [FundSubtype.redeem, FundSubtype.dividend_cash, FundSubtype.switch_out];

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
  principalAmount: true,
  fundProductType: true,
  fundSubtype: true,
  fundConfirmDate: true,
  fundArrivalDate: true,
  fundArrivalAmount: true,
  depositInterest: true,
  depositSourceEntryId: true,
  deletedAt: true,
  // 对账锁定锚点：reconciledBalance 非空的行在余额折叠里等价「余额校准」。
  reconciledAt: true,
  reconciledBalance: true,
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

// ── 日历日键（沿用的历史函数名，口径是 UTC，不是进程本地时区） ──
// 存储契约：DB 的「日历日」字段一律是 UTC 零点。所以日期键必须用 UTC getter，
// 区间边界必须用 Date.UTC 构造。曾用本地 getter/`setHours`：容器 TZ=UTC 时
// `endOfLocalDayKey` 会落到北京时间次日 07:59:59，余额窗口整体偏移一天。
function localDateKey(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromLocalKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysToLocalKey(key: string, days: number) {
  const date = dateFromLocalKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return localDateKey(date);
}

function endOfLocalDayKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function isBalanceAnchorEntry(entry: Pick<BalanceEntryRow, "source" | "toNote" | "reconciledBalance">) {
  return getBalanceAnchorTarget(entry) != null;
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
  if (isDepositAccountLike(account) && isBalanceAnchorEntry(entry)) return runningBalance;
  // Deposit principal is maintained from deposit lots and redemptions, not
  // by folding the investment cash-flow rows a second time.
  if (isDepositAccountLike(account) && isDepositPrincipalEntry(entry)) {
    return runningBalance;
  }
  if (isLoanOrSettlementAccountKind(account.kind)) {
    if (isBalanceAnchorEntry(entry)) {
      return applyBalanceReconcileEntry(runningBalance, entry, account.id);
    }
    if (entry.type !== TransactionType.transfer) return runningBalance;
    return runningBalance + liabilityPrincipalForAccountSide(entry, account.id);
  }
  return applyBalanceAnchorEntry(runningBalance, entry, account.id);
}

function balanceEntryDelta(entry: BalanceEntryRow, account: AccountBalanceLike) {
  if (isBalanceAnchorEntry(entry)) return null;
  if (isLoanOrSettlementAccountKind(account.kind)) {
    if (entry.type !== TransactionType.transfer) return 0;
    return liabilityPrincipalForAccountSide(entry, account.id);
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
      SUM(
        GREATEST(
          ABS(COALESCE(b."fundArrivalAmount", b."amount"))
          - COALESCE((
            SELECT SUM(
              ABS(COALESCE(r."fundArrivalAmount", r."amount"))
              - GREATEST(COALESCE(r."depositInterest", 0), 0)
            )
            FROM "transactions" r
            WHERE r."deletedAt" IS NULL
              AND r."householdId" = ${householdId}
              AND r."type" = ${TransactionType.investment}
              AND r."fundProductType" = 'deposit'
              AND r."accountId" = ${accountId}
              AND r."depositSourceEntryId" = b."id"
              AND r."fundSubtype" IN ('redeem', 'switch_out')
              AND r."date" <= ${asOf}
          ), 0),
          0
        )
      ),
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
  `);
  return Math.max(0, toNumber(rows[0]?.principal));
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
  const redeemedByLotId = new Map<string, number>();
  for (const redemption of redemptions.values()) {
    if (!isLiveBalanceEntry(redemption) || !isDepositRedemptionEntry(redemption)) continue;
    if (!redemption.depositSourceEntryId || redemption.date > asOf) continue;
    const current = redeemedByLotId.get(redemption.depositSourceEntryId) ?? 0;
    redeemedByLotId.set(redemption.depositSourceEntryId, current + depositRedemptionPrincipal(redemption));
  }

  let principal = 0;
  for (const lot of lots.values()) {
    if (!isLiveBalanceEntry(lot) || !isDepositPrincipalEntry(lot)) continue;
    if (isDepositRedemptionEntry(lot)) continue;
    if (lot.toAccountId !== accountId || lot.date > asOf) continue;
    principal += Math.max(
      0,
      Math.abs(toNumber(lot.fundArrivalAmount ?? lot.amount))
        - (redeemedByLotId.get(lot.id) ?? 0),
    );
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

/**
 * 余额的「生效日」必须与明细排序 / 展示用同一份数据。
 *
 * 基金 / 理财独立交易的 TxRecord 上没有 fundSubtype / fundArrivalDate（业务事实
 * 只存在 fund_transactions / wealth_transactions，见 transactions/detail 的
 * isFundLikeIndependentEdit 分支），而 `getDetailEntryDisplayDate` 判定「赎回资金
 * 何时进/出现金账户」依赖这两列。缺这份回填时，赎回资金会在申请日（date）就改变
 * 现金账户余额，与明细里按到账日排序的行互相矛盾
 * （2026-10-16 用户报告：招行账户 10-08 到账的赎回排在 09-24）。
 */
async function decorateBalanceRowsWithInvestmentDisplay(
  db: BalanceDbClient,
  hidFilter: { householdId?: string } | undefined,
  rows: BalanceEntryRow[],
): Promise<BalanceEntryRow[]> {
  if (rows.length === 0 || !hidFilter?.householdId) return rows;
  const links = await loadEntryLinkedInvestmentDisplay(
    rows.filter((row) => row.type === TransactionType.investment).map((row) => row.id),
    hidFilter.householdId,
    db,
  );
  if (links.fund.size === 0 && links.wealth.size === 0) return rows;
  return rows.map((row) =>
    rowWithLinkedInvestmentDisplayDate(
      row,
      links.fund.get(row.id) ?? null,
      links.wealth.get(row.id) ?? null,
    ),
  );
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
  // 「今天」按账簿设置的业务时区算，容器 TZ 只是兜底。
  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(hidFilter?.householdId));
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
        depositInterest: true,
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
        if (lot) {
          lot.amount = Math.max(0, lot.amount - depositRedemptionPrincipal(entry));
        }
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
        principalAmount: true,
        fundSubtype: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
        reconciledBalance: true,
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
        if (isBalanceAnchorEntry(entry)) continue;
        runningBalance = applyBalanceAnchorEntry(runningBalance, entry, account.id);
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
      select: BALANCE_ENTRY_SELECT,
    });

    // 生效日回填：赎回资金按到账日影响现金账户余额（与明细排序同一口径）。
    const displayRows = await decorateBalanceRowsWithInvestmentDisplay(prisma, hidFilter, txRows);
    const displayRowById = new Map(displayRows.map((row) => [row.id, row]));

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
        .map((entry) => displayRowById.get(entry.id) ?? entry)
        .filter((entry) => isOnOrBeforeToday(getDetailEntryDisplayDate(entry, account.id)))
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = 0;
      for (const entry of orderedRows) {
        if (isLoanOrSettlementAccountKind(account.kind)) {
          if (isBalanceAnchorEntry(entry)) {
            runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
            continue;
          }
          if (entry.type !== TransactionType.transfer) continue;
          runningBalance += liabilityPrincipalForAccountSide(entry, account.id);
          continue;
        }
        runningBalance = applyBalanceAnchorEntry(runningBalance, entry, account.id);
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
      principalAmount: true,
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
      const reconcileTarget = getBalanceAnchorTarget(entry);
      if (reconcileTarget != null) {
        runningBalance = reconcileTarget;
        continue;
      }
      if (entry.type !== TransactionType.transfer) continue;
      runningBalance += liabilityPrincipalForAccountSide(entry, accountId);
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
  const range = { gt: lowerBound, lte: upperBound };
  return {
    deletedAt: null,
    ...(hidFilter ?? {}),
    AND: [
      txRecordAccountScopeWhere([accountId]),
      {
        OR: [
          { date: range },
          { postedAt: range },
          { fundArrivalDate: range },
          // 赎回 / 现金分红 / 转出的资金侧交易日是到账日，而到账日只存在
          // 业务表，TxRecord 上没有。窗口必须按到账日切：否则申请日在窗口 A、
          // 到账日在窗口 B 的行，会在 A 被精筛丢弃、在 B 又被日期粗筛排除，
          // 永远不计入余额（2026-10-18 用户报告：09-24 申请、10-08 到账的
          // 14476.83 赎回被漏，账户余额少这笔）。
          {
            EntryBusinessLinkCash: {
              some: {
                deletedAt: null,
                OR: [
                  {
                    FundTransaction: {
                      is: {
                        cashAccountId: accountId,
                        deletedAt: null,
                        fundSubtype: { in: INVESTMENT_CASH_IN_SUBTYPES },
                        arrivalDate: range,
                      },
                    },
                  },
                  {
                    WealthTransaction: {
                      is: {
                        cashAccountId: accountId,
                        deletedAt: null,
                        action: { in: INVESTMENT_CASH_IN_SUBTYPES },
                        arrivalDate: range,
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  } satisfies Prisma.TxRecordWhereInput;
}

function balanceAnchorMatchWhere() {
  // 两类锚点：①「余额校准 / 期初余额」行（备注前缀带目标值）；
  // ② 已「对账」锁定的行（reconciledBalance 非空）。两者在余额折叠里语义相同。
  return {
    OR: [
      {
        source: { in: [BALANCE_RECONCILE_SOURCE, BALANCE_INITIALIZATION_SOURCE] },
        toNote: { startsWith: BALANCE_RECONCILE_TARGET_PREFIX },
      },
      { reconciledBalance: { not: null } },
    ],
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
  const orderedAnchors = (await decorateBalanceRowsWithInvestmentDisplay(db, hidFilter, anchors))
    .filter((row) => getBalanceAnchorTarget(row) != null)
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
    for (const row of await decorateBalanceRowsWithInvestmentDisplay(db, hidFilter, page)) {
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
  // 「今天」按账簿设置的业务时区算，容器 TZ 只是兜底。
  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(hidFilter?.householdId));
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

    const displayRows = await decorateBalanceRowsWithInvestmentDisplay(db, hidFilter, rows);
    displayRows.sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
    for (const row of displayRows) {
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
  todayKey?: string,
  hidFilter?: { householdId?: string },
) {
  const effectiveTodayKey = todayKey ?? (await resolveHouseholdTimeZone(hidFilter?.householdId));
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
      if (getBalanceAnchorTarget(row) == null) continue;
      if (localDateKey(getDetailEntryDisplayDate(row, accountId)) > effectiveTodayKey) continue;
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
  // 「今天」按业务时区算：容器未设置 TZ 时进程时区是 UTC，会比北京时间晚 8 小时。
  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(hidFilter?.householdId));
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

  // 「今天」按业务时区算：容器未设置 TZ 时进程时区是 UTC，会比北京时间晚 8 小时。
  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(acc.householdId));
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

  if (isDepositAccountLike(account)) {
    if (acc.balanceRecomputedAt && localDateKey(acc.balanceRecomputedAt) >= todayKey) return false;
    return recalcAndSaveAccountBalance(accountId).catch(() => false);
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
        (getBalanceAnchorTarget(anchor) ?? 0) +
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
      isAggregate: true,
      parentId: true,
    },
  });
  if (!acc) return false;
  // 多币种父账户没有自己的明细（2026-10-18）：余额 = 子户按本位币折算合计。
  // 走下面的记录重算会把它冲成 0，所以这里直接交给聚合重算。
  if (acc.isAggregate) {
    await recomputeAggregateAccountBalance(prisma, accountId).catch(() => null);
    return true;
  }
  // 「今天」按业务时区算：容器未设置 TZ 时进程时区是 UTC，会比北京时间晚 8 小时。
  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(acc.householdId));
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
    const depositBalances = await computeAccountDisplayBalances(
      [account],
      { householdId: acc.householdId },
    );
    newBalance = depositBalances.get(accountId) ?? 0;
  } else {
    const anchor = await loadLastBalanceAnchor(accountId, todayKey, { householdId: acc.householdId });
    const anchorDay = anchor ? localDateKey(getDetailEntryDisplayDate(anchor, accountId)) : null;
    newBalance = await foldAccountBalanceBatched(account, { householdId: acc.householdId }, {
      fromKeyExclusive: anchorDay ? addDaysToLocalKey(anchorDay, -1) : undefined,
      startingBalance: 0,
    });
  }

  const saved = await writeAccountBalance(accountId, newBalance, asOf, acc.balanceRecomputedAt).catch(() => false);
  // 子户余额变了，父账户的折合余额必须跟着刷，否则统计口径停在旧值。
  if (acc.parentId) {
    await refreshParentAggregateBalance(prisma, [accountId]).catch(() => {});
  }
  return saved;
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
      isAggregate: true,
    },
  });
  // 「今天」按业务时区算：容器未设置 TZ 时进程时区是 UTC，会比北京时间晚 8 小时。
  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(accounts[0]?.householdId));
  const asOf = endOfLocalDayKey(todayKey);
  const changedEntryIds = changes.map((change) => change.entryId);

  // 生效日回填（与 computeAccountDisplayBalances / 明细排序同一口径）：基金独立
  // 交易行的到账日只存在 fund_transactions，缺这份回填时赎回会在申请日就改动
  // 现金账户余额，与明细里按到账日排序的行矛盾。
  const householdIds = Array.from(new Set(accounts.map((account) => account.householdId)));
  const entryDisplayLinks = householdIds.length === 1
    ? await loadEntryLinkedInvestmentDisplay(
      changes.flatMap((change) => [change.entryId, change.previous?.id ?? null]),
      householdIds[0],
    )
    : { fund: new Map(), wealth: new Map() };
  const displayBalanceEntry = (entry: BalanceEntryRow | null | undefined) =>
    entry
      ? rowWithLinkedInvestmentDisplayDate(
        entry,
        entryDisplayLinks.fund.get(entry.id) ?? null,
        entryDisplayLinks.wealth.get(entry.id) ?? null,
      )
      : null;

  for (const account of accounts) {
    // 多币种父账户没有明细，增量口径对它没有意义（余额来自子户折算）。
    if (account.isAggregate) continue;
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

    const isDeposit = isDepositAccountLike(accountLike);
    if (isDeposit && !account.balanceRecomputedAt) {
      await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }

    const anchor = isDeposit
      ? null
      : await loadLastBalanceAnchor(account.id, todayKey, { householdId: account.householdId });
    let previousDelta = 0;
    let currentDelta = 0;
    let requiresFullFold = false;
    for (const { change, current } of currentRows) {
      const previous = displayBalanceEntry(change.previous ?? null);
      const currentDisplay = displayBalanceEntry(current);
      const previousActive = previous && !previous.deletedAt && entryAffectsBalance(previous, account.id, anchor, todayKey);
      const currentActive = currentDisplay && !currentDisplay.deletedAt && entryAffectsBalance(currentDisplay, account.id, anchor, todayKey);
      if (previousActive && previous) {
        if (isDeposit && isDepositPrincipalEntry(previous)) {
          continue;
        }
        const delta = balanceEntryDelta(previous, accountLike);
        if (delta == null) requiresFullFold = true;
        else previousDelta += delta;
      }
      if (currentActive && currentDisplay) {
        if (isDeposit && isDepositPrincipalEntry(currentDisplay)) {
          continue;
        }
        const delta = balanceEntryDelta(currentDisplay, accountLike);
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
      const updated = await prisma.account.updateMany({
        where: { id: account.id, balanceRecomputedAt: null },
        data: {
          balance: roundMoney(toNumber(account.balance) + currentDelta - previousDelta).toFixed(2),
        },
      }).catch(() => ({ count: 0 }));
      if (updated.count === 0) await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }

    const asOfKey = localDateKey(account.balanceRecomputedAt);
    if (isDeposit && asOfKey < todayKey) {
      // Rebuild stale deposit balances from certificates and ordinary flows.
      await recalcAndSaveAccountBalance(account.id).catch(() => {});
      continue;
    }
    let previousIncludedDelta = 0;
    for (const { change } of currentRows) {
      const previous = displayBalanceEntry(change.previous ?? null);
      if (!previous || previous.deletedAt) continue;
      if (!entryAffectsBalance(previous, account.id, anchor, todayKey)) continue;
      if (isDeposit && isDepositPrincipalEntry(previous)) continue;
      const previousDay = localDateKey(getDetailEntryDisplayDate(previous, account.id));
      if (previousDay > asOfKey) continue;
      const delta = balanceEntryDelta(previous, accountLike);
      if (delta != null) previousIncludedDelta += delta;
    }
    const depositDelta = isDeposit
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

  // 子户余额变动后把父账户的折合余额同步一遍（没有父账户时是一次空查询）。
  await refreshParentAggregateBalance(prisma, accounts.map((account) => account.id)).catch(() => {});
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

  const depositAccounts = accounts.filter((account) => isDepositAccountLike(account));
  if (depositAccounts.length > 0) {
    const depositBalances = await computeAccountDisplayBalances(depositAccounts, hidFilter);
    for (const [id, balance] of depositBalances) {
      result.set(id, balance);
    }
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
  // 跨账簿的后台补偿任务，没有单一「今天」可用：这里用「24 小时内算过就不动」
  // 的窗口挑候选，不受账簿时区影响；真正的余额推进在 advanceAccountBalanceStep
  // 里按 account.householdId 的时区算。
  const staleBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const accounts = await prisma.account.findMany({
    where: {
      OR: [
        { balanceRecomputedAt: null },
        { balanceRecomputedAt: { lt: staleBefore } },
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
