import {
  applyBalanceReconcileEntry,
  effectiveAmountForAccount,
  getBalanceAnchorTarget,
  isReconciledEntry,
} from "@/lib/balance-reconcile";
import { getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { toNumber, formatDateUtc } from "@/lib/date-utils";
import { isFundBuyRefundCashLeg } from "@/lib/transaction-semantics";

type ReorderDisplayEntry = {
  id: string;
  date: Date | string | number | null | undefined;
  postedAt?: Date | string | number | null | undefined;
  createdAt?: Date | string | number | null | undefined;
  dayOrder?: number | null | undefined;
  amount: unknown;
  type: string;
  accountId?: string | null;
  toAccountId?: string | null;
  principalAmount?: unknown;
  fundSubtype?: string | null;
  source?: string | null;
  toNote?: string | null;
  fundArrivalDate?: Date | string | number | null | undefined;
  fundArrivalAmount?: unknown;
  runningBalance?: number | null;
  /** 对账锁定：reconciledAt 非空 = 锁定；reconciledBalance 非空 = 余额锚点。 */
  reconciledAt?: Date | string | number | null | undefined;
  reconciledBalance?: unknown;
};

export type LinkedWealthForReorder = {
  action?: string | null;
  arrivalDate?: Date | string | number | null;
  cashAccountId?: string | null;
  deletedAt?: Date | string | number | null;
};

/**
 * 关联基金交易（fund_transactions）的行，用于回填明细的「生效日」字段。
 * `fundSubtype` / `arrivalDate` / `cashAccountId` 对应 FundTransaction 的
 * 子类型 / 到账日 / 资金账户。
 */
export type LinkedFundForReorder = {
  fundSubtype?: string | null;
  arrivalDate?: Date | string | number | null;
  cashAccountId?: string | null;
  deletedAt?: Date | string | number | null;
};

export function entryReorderDayKey(entry: ReorderDisplayEntry, accountId?: string | null) {
  return formatDateUtc(getDetailEntryDisplayDate(entry, accountId));
}

export function isReorderBalanceAnchor(entry: { source?: string | null; toNote?: string | null; reconciledBalance?: unknown; reconciledAt?: unknown }) {
  // 锚点（余额校准 / 期初余额 / 已对账锁定）都不能被拖动重排：它们钉住余额，
  // 挪位会让锚点前后段的分段口径整体漂移。
  return getBalanceAnchorTarget(entry) != null || isReconciledEntry(entry);
}

function isWealthCashReceiptAction(action?: string | null) {
  return action === "redeem" || action === "dividend_cash" || action === "switch_out";
}

function rowWithLinkedWealthDisplayDate<T extends ReorderDisplayEntry>(
  row: T,
  wealthRow?: LinkedWealthForReorder | null,
): T {
  if (!wealthRow || wealthRow.deletedAt || !isWealthCashReceiptAction(wealthRow.action)) return row;
  return {
    ...row,
    fundSubtype: wealthRow.action ?? row.fundSubtype,
    fundArrivalDate: wealthRow.arrivalDate ?? row.fundArrivalDate,
    toAccountId: wealthRow.cashAccountId ?? row.toAccountId,
  };
}

/**
 * 基金交易行的「生效日」回填。
 *
 * 基金独立交易的 TxRecord 会被有意清空 `fundSubtype` / `fundArrivalDate`
 * （业务事实只存在 fund_transactions，见 transactions/detail 的编辑分支），
 * 明细展示层因此要用 FundTransaction 覆盖这几列。排序 / 余额层必须用同一份
 * 兜底，否则赎回（资金回到现金账户）会退化成按 `date`（申请日）排序与计息，
 * 表现为「到账日 10-08 却排在 09-24」。
 *
 * 只有资金流入现金账户的行才用得到账日：redeem / dividend_cash，以及
 * 买入失败退款（buy_failed + regular_invest_refund）。
 */
export function rowWithLinkedFundDisplayDate<T extends ReorderDisplayEntry>(
  row: T,
  fundRow?: LinkedFundForReorder | null,
): T {
  if (!fundRow || fundRow.deletedAt) return row;
  // 买入退款资金腿：`date` 本身就是到账日、`amount` 就是退款金额，
  // 套用买入口径会把资金侧那笔收入改写成「又一笔申请日的买入」。部分退款时
  // 主业务行仍是 buy，也不该因此丢掉退款语义。
  if (isFundBuyRefundCashLeg(row)) return row;
  const subtype = String(fundRow.fundSubtype ?? "").trim();
  const isCashReceipt = subtype === "redeem" || subtype === "dividend_cash" || subtype === "switch_out";
  const isBuyFailedRefund = subtype === "buy_failed" && String(row.source ?? "") === "regular_invest_refund";
  if (!isCashReceipt && !isBuyFailedRefund) return row;
  return {
    ...row,
    fundSubtype: fundRow.fundSubtype ?? row.fundSubtype,
    fundArrivalDate: fundRow.arrivalDate ?? row.fundArrivalDate,
    toAccountId: fundRow.cashAccountId ?? row.toAccountId,
  };
}

/**
 * 同时投影基金与理财两侧的业务生效日字段。
 *
 * 基金优先：同一条 TxRecord 同时挂在两侧时，与 detail-page-query 的
 * fund_candidates > wealth_candidates 优先级保持一致。
 */
export function rowWithLinkedInvestmentDisplayDate<T extends ReorderDisplayEntry>(
  row: T,
  fundRow?: LinkedFundForReorder | null,
  wealthRow?: LinkedWealthForReorder | null,
): T {
  return rowWithLinkedFundDisplayDate(rowWithLinkedWealthDisplayDate(row, wealthRow), fundRow);
}

/** Inclusive UTC start / exclusive UTC end covering `dayKey` plus `padDays` on each side. */
export function sameDayUtcWindow(dayKey: string, padDays = 1) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!match) {
    return { start: new Date(0), endExclusive: new Date(0) };
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const start = new Date(Date.UTC(year, month, day - padDays));
  const endExclusive = new Date(Date.UTC(year, month, day + 1 + padDays));
  return { start, endExclusive };
}

/**
 * Prisma where fragment: any of date / postedAt / fundArrivalDate falling in the
 * padded window around the displayed local day. Callers still filter in memory
 * with getDetailEntryDisplayDate so timezone / wealth arrivalDate stay exact.
 */
export function buildReorderDateWindowWhere(dayKey: string, padDays = 1) {
  const { start, endExclusive } = sameDayUtcWindow(dayKey, padDays);
  const range = { gte: start, lt: endExclusive };
  return {
    OR: [
      { date: { ...range } },
      { postedAt: { ...range } },
      { fundArrivalDate: { ...range } },
    ],
  };
}

export function reorderRowsWithinDay<T extends { id: string }>(
  sameDayRows: T[],
  entryId: string,
  target?: { targetEntryId: string; targetPosition?: "before" | "after" | "" },
  direction?: "up" | "down" | "",
): { changed: false; rows: T[] } | { changed: true; rows: T[] } | { error: "ENTRY_NOT_IN_DAY_LIST" | "REORDER_WITHIN_DAY_ONLY" | "TARGET_ENTRY_NOT_FOUND" } {
  const currentIndex = sameDayRows.findIndex((row) => row.id === entryId);
  if (currentIndex < 0) return { error: "ENTRY_NOT_IN_DAY_LIST" };

  const reorderedRows = [...sameDayRows];
  const targetEntryId = String(target?.targetEntryId ?? "").trim();
  if (targetEntryId) {
    const targetIndex = sameDayRows.findIndex((row) => row.id === targetEntryId);
    if (targetIndex < 0) return { error: "REORDER_WITHIN_DAY_ONLY" };
    if (targetIndex === currentIndex) return { changed: false, rows: sameDayRows };
    const position = target?.targetPosition || (currentIndex < targetIndex ? "after" : "before");
    const [moving] = reorderedRows.splice(currentIndex, 1);
    const targetIndexAfterRemoval = reorderedRows.findIndex((row) => row.id === targetEntryId);
    if (targetIndexAfterRemoval < 0) return { error: "TARGET_ENTRY_NOT_FOUND" };
    reorderedRows.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
  } else {
    const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    const neighbor = sameDayRows[nextIndex];
    if (!neighbor) return { changed: false, rows: sameDayRows };
    [reorderedRows[currentIndex], reorderedRows[nextIndex]] = [reorderedRows[nextIndex], reorderedRows[currentIndex]];
  }
  return { changed: true, rows: reorderedRows };
}

export function normalizeSameDayOrders<T extends { id: string }>(reorderedRows: T[], step = 1000) {
  const normalizedOrders = new Map<string, number>();
  for (let index = 0; index < reorderedRows.length; index += 1) {
    normalizedOrders.set(reorderedRows[index].id, (reorderedRows.length - index) * step);
  }
  return normalizedOrders;
}

/**
 * Start-of-day running balance implied by an already-loaded newest-first list.
 * Prefers the latest earlier-day row; if the target day is the oldest loaded
 * day, subtracts the earliest same-day row's amount from its runningBalance.
 * Call this on the list *before* splicing so RBs still match that order.
 */
export function startOfDayRunningBalanceSeed<T extends ReorderDisplayEntry>(
  entries: T[],
  accountId: string,
  dayKey: string,
): number | null {
  const dayOf = (entry: T) => entryReorderDayKey(entry, accountId);
  for (const entry of entries) {
    const day = dayOf(entry);
    if (day >= dayKey) continue;
    if (entry.runningBalance == null) continue;
    return toNumber(entry.runningBalance);
  }
  const sameDay = entries.filter((entry) => dayOf(entry) === dayKey);
  const firstOfDay = sameDay[sameDay.length - 1];
  if (!firstOfDay || firstOfDay.runningBalance == null) return null;
  if (getBalanceAnchorTarget(firstOfDay) != null) return toNumber(firstOfDay.runningBalance);
  return toNumber(firstOfDay.runningBalance) - effectiveAmountForAccount(firstOfDay, accountId);
}

/**
 * After a same-day reorder, recompute running balances for that day and every
 * later day in the already-loaded list. Does not scan earlier history.
 * `entries` is newest-first; same-day relative order is the new order.
 * Pass `seed` computed from the pre-reorder list when RBs on `entries` no
 * longer match that array (the usual optimistic-update case).
 */
export function rebaseRunningBalancesAfterSameDayReorder<T extends ReorderDisplayEntry>(
  entries: T[],
  accountId: string,
  dayKey: string,
  seed?: number | null,
): T[] {
  if (entries.length === 0) return entries;
  const dayOf = (entry: T) => entryReorderDayKey(entry, accountId);
  const sameDay = entries.filter((entry) => dayOf(entry) === dayKey);
  if (sameDay.length === 0) return entries;

  const resolvedSeed = seed ?? startOfDayRunningBalanceSeed(entries, accountId, dayKey);
  if (resolvedSeed == null) return entries;

  const runningBalanceById = new Map<string, number>();
  let runningBalance = resolvedSeed;
  for (const entry of [...entries].reverse()) {
    if (dayOf(entry) < dayKey) continue;
    runningBalance = applyBalanceReconcileEntry(runningBalance, entry, accountId);
    runningBalanceById.set(entry.id, runningBalance);
  }
  let changed = false;
  const next = entries.map((entry) => {
    const runningBalance = runningBalanceById.get(entry.id);
    if (runningBalance == null) return entry;
    if (entry.runningBalance != null && Math.abs(toNumber(entry.runningBalance) - runningBalance) < 0.005) return entry;
    changed = true;
    return { ...entry, runningBalance };
  });
  return changed ? next : entries;
}
