"use client";

import { useMemo } from "react";

import { EntryConvertMenu, type ConvertSourceEntry } from "./BasicDetailSelection";

/**
 * 编辑窗标题栏里的「转换」入口。
 *
 * 各录入窗（记账 / 基金 / 理财 / 债券 / 存单 / 保险 / 股票 / 往来款）把「正在编辑的
 * 这条记录」的字段按 `EntryConvertHeaderSource` 交进来，由这里统一构造
 * `ConvertSourceEntry` 并渲染 `EntryConvertMenu` —— 菜单与派发逻辑与明细表头曾是同一份，
 * 现在只有这一处入口，各窗不再各写一套。
 *
 * `onBeforeConvert` 必须由调用方提供：先关掉自己并清空草稿，否则目标窗会与编辑窗
 * 抢同一份表单状态。
 */
export type EntryConvertHeaderSource = {
  /** 正在编辑的明细记录 id；新建态传 null 即可。 */
  entryId?: string | null;
  /** 原记录类型（transfer/expense/income/investment/…），只有 transfer 需要精确。 */
  type?: string | null;
  date?: string | null;
  amount?: number | string | null;
  bookAmount?: number | string | null;
  note?: string | null;
  accountId?: string | null;
  accountKind?: string | null;
  accountIsSettlementAccount?: boolean | null;
  toAccountId?: string | null;
  toAccountKind?: string | null;
  cashAccountId?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
  /**
   * 这条记录的钱是**流进来**的吗（赎回 / 卖出 / 取出 / 退保 / 收款 → true；
   * 买入 / 申购 / 缴费 → false）。各录入窗按自己当前页签给出，转换菜单据此
   * 只列同向目标（流入不出现「买入」，流出不出现「收入」）。
   * 不传时菜单退回老口径：type === "income" 才算流入。
   */
  inflow?: boolean | null;
  /** 有值表示该行已对账：转换按钮置灰。 */
  reconciledAt?: string | null;
};

function toAmount(value: number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function EntryConvertHeaderAction({
  source,
  onBeforeConvert,
}: {
  source: EntryConvertHeaderSource | null;
  onBeforeConvert: () => void;
}) {
  const entry = useMemo<ConvertSourceEntry | null>(() => {
    if (!source?.entryId) return null;
    const amount = toAmount(source.amount);
    return {
      id: source.entryId,
      type: source.type ?? null,
      date: source.date ?? null,
      amount,
      bookAmount: source.bookAmount == null ? amount : toAmount(source.bookAmount),
      note: source.note ?? null,
      accountId: source.accountId ?? null,
      accountKind: source.accountKind ?? null,
      accountIsSettlementAccount: source.accountIsSettlementAccount ?? null,
      toAccountId: source.toAccountId ?? null,
      toAccountKind: source.toAccountKind ?? null,
      cashAccountId: source.cashAccountId ?? null,
      fundCode: source.fundCode ?? null,
      fundName: source.fundName ?? null,
      inflow: source.inflow ?? null,
      reconciledAt: source.reconciledAt ?? null,
    };
  }, [source]);

  if (!entry) return null;

  return (
    <EntryConvertMenu
      entry={entry}
      cashAccountId={entry.cashAccountId ?? entry.accountId}
      onBeforeConvert={onBeforeConvert}
    />
  );
}
