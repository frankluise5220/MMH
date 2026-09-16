import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  applyBalanceReconcileEntry,
  effectiveAmountForAccount,
  getBalanceReconcileTarget,
} from "@/lib/balance-reconcile";
import { getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { formatDateLocal, toNumber } from "@/lib/date-utils";

export type ReorderDisplayEntry = {
  id: string;
  date: Date | string | number | null | undefined;
  postedAt?: Date | string | number | null | undefined;
  createdAt?: Date | string | number | null | undefined;
  dayOrder?: number | null | undefined;
  amount: unknown;
  type: string;
  accountId?: string | null;
  toAccountId?: string | null;
  debtPrincipalAmount?: unknown;
  fundSubtype?: string | null;
  source?: string | null;
  toNote?: string | null;
  fundArrivalDate?: Date | string | number | null | undefined;
  fundArrivalAmount?: unknown;
  runningBalance?: number | null;
};

export type LinkedWealthForReorder = {
  action?: string | null;
  arrivalDate?: Date | string | number | null;
  cashAccountId?: string | null;
  deletedAt?: Date | string | number | null;
};

export function entryReorderDayKey(entry: ReorderDisplayEntry, accountId?: string | null) {
  return formatDateLocal(getDetailEntryDisplayDate(entry, accountId));
}

export function isReorderBalanceAnchor(entry: { source?: string | null; toNote?: string | null }) {
  const source = String(entry.source ?? "");
  if (source !== BALANCE_RECONCILE_SOURCE && source !== BALANCE_INITIALIZATION_SOURCE) return false;
  return getBalanceReconcileTarget(entry) != null;
}

export function isWealthCashReceiptAction(action?: string | null) {
  return action === "redeem" || action === "dividend_cash";
}

export function rowWithLinkedWealthDisplayDate<T extends ReorderDisplayEntry>(
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
  if (getBalanceReconcileTarget(firstOfDay) != null) return toNumber(firstOfDay.runningBalance);
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
