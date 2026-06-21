import { TransactionType } from "@prisma/client";

type DetailEntryLike = {
  id: string;
  date: Date | string | number | null | undefined;
  createdAt: Date | string | number | null | undefined;
  type: string;
  toAccountId?: string | null | undefined;
  fundSubtype?: string | null | undefined;
  source?: string | null | undefined;
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

export function getDetailEntryDisplayDate(entry: DetailEntryLike, accountId?: string | null) {
  const isCashSide = !!accountId && entry.toAccountId === accountId;
  const isBuyFailedRefund = entry.fundSubtype === "buy_failed" && entry.source === "regular_invest_refund";
  const isCashInByInvest =
    entry.type === TransactionType.investment &&
    isCashSide &&
    (entry.fundSubtype === "redeem" ||
      entry.fundSubtype === "switch_out" ||
      entry.fundSubtype === "dividend_cash" ||
      isBuyFailedRefund);

  return (
    toValidDate(
      isCashInByInvest ? (entry.fundArrivalDate ?? entry.fundConfirmDate ?? entry.date) : entry.date,
    ) ?? new Date(0)
  );
}

export function compareDetailEntriesDesc(a: DetailEntryLike, b: DetailEntryLike, accountId?: string | null) {
  const byDate = getDetailEntryDisplayDate(b, accountId).getTime() - getDetailEntryDisplayDate(a, accountId).getTime();
  if (byDate !== 0) return byDate;

  const byCreatedAt = (toValidDate(b.createdAt) ?? new Date(0)).getTime() - (toValidDate(a.createdAt) ?? new Date(0)).getTime();
  if (byCreatedAt !== 0) return byCreatedAt;

  return b.id.localeCompare(a.id, "en");
}

export function compareDetailEntriesAsc(a: DetailEntryLike, b: DetailEntryLike, accountId?: string | null) {
  return compareDetailEntriesDesc(b, a, accountId);
}
