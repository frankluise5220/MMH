import type { Prisma } from "@prisma/client";

import { selectConsistentPersistedCycles, type BillingDayTxPeriod } from "@/lib/credit/billing";

/**
 * 账单期（`CreditCardCycle.periodStart / periodEnd`）的**唯一读取入口**。
 *
 * 账单期只有一张来源表 `CreditCardCycle`，但它同时是账单日规则计算结果的缓存：
 * 手工改期与对账单导入会按提交值直接落库并打锁。一旦某一期的结束日写进邻月，
 * 直接读表就会得到「某一期覆盖两个月、下一期重复上一期」的错误账单期（用户报告
 * 的问题：账单日设为 31 后 2017-06 = 05.01~05.31、2017-07 = 06.01~07.31）。
 *
 * 因此任何需要账单期的调用方都必须经过这里：`loadConsistentCreditCycles` 读表后
 * 交给 `selectConsistentPersistedCycles` 丢掉不自洽的行，调用方再按账单日规则补齐。
 * 不要在别处直接 `creditCardCycle.findMany({ select: { periodStart, periodEnd } })`。
 *
 * 三处例外，都在写入路径上自洽，不经过本入口：
 * - `backup.ts`：备份导出/恢复必须原样搬运；
 * - `credit-bill-page-data.ts`：重算并把结果回写（用 `partitionCreditCycles` 复用
 *   同一套判定，但需要看到全部行，包括要被修正的坏行）；
 * - `/api/v1/bill/cycle`：手工改期需要看到全部行才能顺推并回写。
 */
type CreditCycleReader = {
  creditCardCycle: {
    findMany: (args: {
      where?: Prisma.CreditCardCycleWhereInput;
      select?: Prisma.CreditCardCycleSelect;
      orderBy?: Prisma.CreditCardCycleOrderByWithRelationInput | Prisma.CreditCardCycleOrderByWithRelationInput[];
    }) => Promise<unknown[]>;
  };
};

/** 已读出的行按同一套口径分流（供需要全量行、自己回写的调用方使用）。 */
export function partitionCreditCycles<
  T extends { statementMonth: string; periodStart: Date | string; periodEnd: Date | string },
>(rows: readonly T[], billingDayTxPeriod?: BillingDayTxPeriod | null) {
  return selectConsistentPersistedCycles(rows, billingDayTxPeriod);
}

export async function loadConsistentCreditCycles<
  T extends { statementMonth: string; periodStart: Date; periodEnd: Date },
>(
  reader: CreditCycleReader,
  params: {
    where: Prisma.CreditCardCycleWhereInput;
    select: Prisma.CreditCardCycleSelect;
    orderBy?: Prisma.CreditCardCycleOrderByWithRelationInput | Prisma.CreditCardCycleOrderByWithRelationInput[];
    billingDayTxPeriod?: BillingDayTxPeriod | null;
  },
): Promise<{ cycles: T[]; rejected: T[] }> {
  const rows = (await reader.creditCardCycle.findMany({
    where: params.where,
    select: params.select,
    ...(params.orderBy ? { orderBy: params.orderBy } : {}),
  })) as T[];
  const { accepted, rejected } = selectConsistentPersistedCycles(rows, params.billingDayTxPeriod);
  return { cycles: accepted, rejected };
}
