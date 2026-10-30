import { TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

type Options = {
  /** 只统计这些流水类型；缺省 = 全部类型 */
  types?: TransactionType[];
  /** 限定账户范围（双向匹配）；缺省/空 = 不限 */
  accountIds?: string[] | null;
};

/**
 * 本家庭「可选年份」列表：数据首年 → 当前年（保证包含当前年）。
 *
 * 收入支出报表 / 现金统计图表等基于 TxRecord 的报表共用这一个口径，
 * 避免各页面各自 aggregate min/max date 再手写同样的展开公式。
 * 注意：投资损益报表的「首年」口径不同（按基金确认日/股票成交日/
 * 资产业务首年，见 investment-profit-report.ts 的 findFirstDataYear*），
 * 属于业务语义差异，不在这里收敛。
 */
export async function loadHouseholdAvailableYears(
  hidFilter: { householdId: string },
  currentYear: number,
  options: Options = {},
): Promise<number[]> {
  const bounds = await prisma.txRecord.aggregate({
    where: {
      ...hidFilter,
      deletedAt: null,
      ...(options.types ? { type: { in: options.types } } : {}),
      ...(options.accountIds && options.accountIds.length > 0
        ? { OR: [{ accountId: { in: options.accountIds } }, { toAccountId: { in: options.accountIds } }] }
        : {}),
    },
    _min: { date: true },
    _max: { date: true },
  });
  const firstYear = bounds._min.date?.getUTCFullYear() ?? currentYear;
  const lastYear = Math.max(bounds._max.date?.getUTCFullYear() ?? firstYear, currentYear);
  return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
}
