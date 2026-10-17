import { getDetailEntryDisplayDate } from "@/lib/detail-entry-order";

/**
 * 报表口径的「业务生效日」。
 *
 * 报表的期间归期必须和明细排序 / 账户余额用同一个解析器
 * （`detail-entry-order.ts` 的 `getDetailEntryDisplayDate`），否则同一笔赎回会
 * 在明细里算到 10-08、在报表里算到 09-24（用户报告 2026-10-16）。
 *
 * 资金流入腿（赎回 / 转换转出 / 现金分红 / 买入失败退款）用**资金账户侧的到账日**：
 * 该行的 `toAccountId` 就是收款账户，报表里没有「当前视图账户」这个语境，所以按行
 * 取 `toAccountId ?? accountId` 当「这一侧的账户」。金属赎回是单行双边
 * （投资账户 → 资金账户），到账日存在 `fundArrivalDate`，因此同样命中。
 *
 * expense / income 用 `postedAt`（入账日），其余行用 `date`。
 */
export type ReportEntryDateInput = {
  id: string;
  date: Date | string | number | null | undefined;
  postedAt?: Date | string | number | null | undefined;
  createdAt?: Date | string | number | null | undefined;
  dayOrder?: number | null | undefined;
  type: string;
  accountId?: string | null | undefined;
  toAccountId?: string | null | undefined;
  fundSubtype?: string | null | undefined;
  source?: string | null | undefined;
  fundProductType?: string | null | undefined;
  toNote?: string | null | undefined;
  fundConfirmDate?: Date | string | number | null | undefined;
  fundArrivalDate?: Date | string | number | null | undefined;
};

export function getReportEntryDate(entry: ReportEntryDateInput): Date {
  return getDetailEntryDisplayDate(entry, entry.toAccountId ?? entry.accountId ?? "");
}

/** `getReportEntryDate` 的本地日期键（YYYY-MM-DD），用于按日/按月分组和期间过滤。 */
export function getReportEntryDateKey(entry: ReportEntryDateInput): string {
  return localDateKey(getReportEntryDate(entry));
}

export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isReportEntryDateWithin(
  entry: ReportEntryDateInput,
  start: Date,
  endExclusive: Date,
): boolean {
  const time = getReportEntryDate(entry).getTime();
  return time >= start.getTime() && time < endExclusive.getTime();
}
