import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  getBalanceReconcileTarget,
} from "@/lib/balance-reconcile";

type DetailEntryLike = {
  id: string;
  date: Date | string | number | null | undefined;
  postedAt?: Date | string | number | null | undefined;
  createdAt?: Date | string | number | null | undefined;
  dayOrder?: number | null | undefined;
  type: string;
  toAccountId?: string | null | undefined;
  fundSubtype?: string | null | undefined;
  source?: string | null | undefined;
  fundProductType?: string | null | undefined;
  toNote?: string | null | undefined;
  fundConfirmDate?: Date | string | number | null | undefined;
  fundArrivalDate?: Date | string | number | null | undefined;
};

function toValidDate(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isBalanceAnchor(entry: DetailEntryLike) {
  const source = String(entry.source ?? "");
  if (source !== BALANCE_RECONCILE_SOURCE && source !== BALANCE_INITIALIZATION_SOURCE) return false;
  return getBalanceReconcileTarget(entry) != null;
}

/**
 * 投资业务行的「资金腿」：钱进入收款账户（当前明细账户）的到账日。
 *
 * 只有资金流入收款账户的行才用到账日：赎回 / 现金分红，以及买入失败退款
 * （buy_failed + regular_invest_refund）。`toAccountId` 由展示层用关联业务的
 * `cashAccountId` 回填（见 `rowWithLinkedFundDisplayDate`）。
 */
function investmentCashInDate(entry: DetailEntryLike, accountId?: string | null) {
  if (entry.type !== "investment" || !accountId || entry.toAccountId !== accountId) return null;
  const subtype = String(entry.fundSubtype ?? "");
  const isCashReceipt = subtype === "redeem" || subtype === "dividend_cash" || subtype === "switch_out";
  const isBuyFailedRefund = subtype === "buy_failed" && String(entry.source ?? "") === "regular_invest_refund";
  if (!isCashReceipt && !isBuyFailedRefund) return null;
  return toValidDate(entry.fundArrivalDate) ?? toValidDate(entry.date) ?? new Date(0);
}

export function getDetailEntryDisplayDate(entry: DetailEntryLike, accountId?: string | null) {
  if (entry.type === "expense" || entry.type === "income") {
    return toValidDate(entry.postedAt) ?? toValidDate(entry.date) ?? new Date(0);
  }

  const cashInDate = investmentCashInDate(entry, accountId);
  if (cashInDate) return cashInDate;

  // 存款买入行的业务生效日是到期/入账日 fundArrivalDate，而不是
  // 创建交易时记录的 date。账户余额、未来流水过滤和明细排序必须使用同一口径。
  const isDepositBuyIntoAccount =
    entry.type === "investment" &&
    accountId &&
    entry.toAccountId === accountId &&
    entry.fundProductType === "deposit" &&
    entry.fundSubtype === "buy";
  if (isDepositBuyIntoAccount) {
    return toValidDate(entry.fundArrivalDate) ?? toValidDate(entry.date) ?? new Date(0);
  }

  return toValidDate(entry.date) ?? new Date(0);
}

/**
 * 明细「日期」列显示的日期：这一侧的「交易日期」。
 *
 * 投资动作的业务事实分属两侧，交易日期也随侧而变：
 * - 投资账户侧：交易日期就是交易日（申请日 / `date`），到账日只是资金回笼时间；
 * - 资金侧（收款账户）：钱在到账日才真正进出账户，所以入账日期才是这一侧的交易日期。
 *
 * 因此赎回 / 现金分红 / 买入失败退款行在**收款账户**明细里显示到账日，
 * 在投资账户侧显示交易日。其余行仍显示原始 `date`（`expense` / `income` 的
 * 入账日另有「入账日期」列，不在本函数职责内）。
 */
export function getDetailEntryTradeDate(entry: DetailEntryLike, accountId?: string | null) {
  const cashInDate = investmentCashInDate(entry, accountId);
  if (cashInDate) return cashInDate;
  return toValidDate(entry.date) ?? new Date(0);
}

export function compareDetailEntriesDesc(a: DetailEntryLike, b: DetailEntryLike, accountId?: string | null) {
  return compareDetailEntriesDescBy(a, b, (entry) => getDetailEntryDisplayDate(entry, accountId));
}

/**
 * 同 compareDetailEntriesDesc，但生效日由调用方逐行解析。
 *
 * 多账户（全部收支记录）明细里每一行的「资金账户」不同，无法用同一个
 * accountId 判定它是不是这笔钱的收款方，必须逐行解析（见 flowAccountIdOf）。
 */
export function compareDetailEntriesDescBy(
  a: DetailEntryLike,
  b: DetailEntryLike,
  displayDateOf: (entry: DetailEntryLike) => Date,
) {
  const aDate = displayDateOf(a);
  const bDate = displayDateOf(b);
  const aDay = localDateKey(aDate);
  const bDay = localDateKey(bDate);
  const byDay = bDay.localeCompare(aDay, "en");
  if (byDay !== 0) return byDay;

  const aAnchor = isBalanceAnchor(a);
  const bAnchor = isBalanceAnchor(b);
  if (aAnchor !== bAnchor) return aAnchor ? -1 : 1;

  const byDayOrder = (b.dayOrder ?? 0) - (a.dayOrder ?? 0);
  if (byDayOrder !== 0) return byDayOrder;

  const byDate = bDate.getTime() - aDate.getTime();
  if (byDate !== 0) return byDate;

  const byCreatedAt = (toValidDate(b.createdAt) ?? new Date(0)).getTime() - (toValidDate(a.createdAt) ?? new Date(0)).getTime();
  if (byCreatedAt !== 0) return byCreatedAt;

  return b.id.localeCompare(a.id, "en");
}

export function compareDetailEntriesAsc(a: DetailEntryLike, b: DetailEntryLike, accountId?: string | null) {
  return compareDetailEntriesDesc(b, a, accountId);
}

/**
 * Locate the 1-based page (of `pageSize`) that contains the first entry whose
 * display day (YYYY-MM-DD) is on or before `dateYmd`, given entries sorted desc
 * (the same order used by compareDetailEntriesDesc). Returns the zero-based
 * index of that entry too, plus totalPages for clamping.
 */
export function locateDetailEntryPageDesc(
  entries: readonly DetailEntryLike[],
  dateYmd: string,
  pageSize: number,
  accountId?: string | null,
) {
  const safePageSize = Math.max(1, Math.floor(pageSize) || 1);
  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return { page: 1, index: 0, totalPages };
  }
  let index = -1;
  for (let i = 0; i < total; i += 1) {
    const entry = entries[i];
    if (!entry) continue;
    const dayKey = localDateKey(getDetailEntryDisplayDate(entry, accountId));
    if (dayKey <= dateYmd) {
      index = i;
      break;
    }
  }
  // No entry on or before the target date: land on the oldest page.
  if (index < 0) {
    return { page: totalPages, index: Math.max(0, total - 1), totalPages };
  }
  return { page: Math.floor(index / safePageSize) + 1, index, totalPages };
}
