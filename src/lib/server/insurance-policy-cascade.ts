import { prisma } from "@/lib/db/prisma";
import { softDeleteEntriesByIds } from "@/lib/server/entry-delete";
import type { HouseholdContext } from "@/lib/server/household-scope";

/**
 * 保险保单 / 保险产品库的级联删除（余额安全路径）。
 *
 * 为什么不能再用 `deleteMany` 直删：
 * - `InsuranceTransaction.insuranceProductId` 是 `onDelete: Cascade`，物理删保单会让缴费 /
 *   领取业务行被数据库直接抹掉，没人会去回补账户余额；
 * - `TxRecord.insuranceProductId` 是 `onDelete: SetNull`，物理删保单只是把资金腿的产品外键
 *   悄悄置空，明细里留下一笔「不属于任何产品」的流水；
 * - 直接 `txRecord.deleteMany` 更糟：绕过 `applyEntryChangesToAccountBalances`，账户余额
 *   永久停在「钱已经花掉」的状态（issue #25 遗留项）。
 *
 * 所以统一走 `softDeleteEntriesByIds`（与明细页删除、存款 / 理财 / 债券产品库级联同一条
 * 路径）：软删资金腿 + 业务行、回补账户余额、写撤销快照、摘掉计划任务里的已完成记录。
 * 保险视图的现金价值 / 已缴保费是实时聚合 `insuranceTransaction`（`deletedAt: null`），
 * 软删后自适应，不需要额外的持仓重算。
 *
 * 注意：`softDeleteEntriesByIds` 内部使用全局 `prisma`，必须在事务外调用；
 * 事务里只剩「删计划任务 + 删保单 / 产品主数据」这几步纯删除。
 */

/** 对账锁定的记录 softDelete 会跳过（`reconciledAt` 非空），删前先拦下，避免留下孤儿流水。 */
export async function countReconciledInsurancePolicyEntries(
  householdId: string,
  policyIds: string[],
): Promise<number> {
  if (policyIds.length === 0) return 0;
  return prisma.txRecord.count({
    where: {
      householdId,
      insuranceProductId: { in: policyIds },
      deletedAt: null,
      reconciledAt: { not: null },
    },
  });
}

/**
 * 软删某批保单下的全部缴费 / 领取记录，并回补账户余额。
 * 返回软删的资金腿条数与兜底软删的孤儿业务行条数。
 */
export async function cascadeDeleteInsurancePolicyEntries(
  ctx: HouseholdContext,
  policyIds: string[],
  label = "删除保险保单",
): Promise<{ deletedEntryCount: number; orphanBusinessCount: number }> {
  const ids = Array.from(new Set(policyIds.filter(Boolean)));
  if (ids.length === 0) return { deletedEntryCount: 0, orphanBusinessCount: 0 };

  const [directEntries, businessRows] = await Promise.all([
    prisma.txRecord.findMany({
      where: { householdId: ctx.householdId, insuranceProductId: { in: ids }, deletedAt: null },
      select: { id: true },
    }),
    prisma.insuranceTransaction.findMany({
      where: { householdId: ctx.householdId, insuranceProductId: { in: ids }, deletedAt: null },
      select: { cashEntryId: true },
    }),
  ]);

  // 资金腿有两条来源：TxRecord 上的产品外键（新数据都会回填），以及业务行的 cashEntryId
  // （产品外键缺失的历史数据）。两条都收，否则漏掉某一代记录。
  const entryIds = new Set<string>(directEntries.map((row) => row.id));
  for (const row of businessRows) {
    if (row.cashEntryId) entryIds.add(row.cashEntryId);
  }

  const result = await softDeleteEntriesByIds(ctx, [...entryIds], label, { linkedAction: "deleteBusiness" });

  // 没有资金腿的业务行（手工补录的领取、现金价值调整）既不在 TxRecord 里，也没有
  // cashEntryId 可反查，按产品维度再兜一次；否则保单删掉后它们会变成孤儿业务行。
  const orphanBusiness = await prisma.insuranceTransaction.updateMany({
    where: { householdId: ctx.householdId, insuranceProductId: { in: ids }, deletedAt: null },
    data: { deletedAt: new Date() },
  });

  return { deletedEntryCount: result.deletedCount, orphanBusinessCount: orphanBusiness.count };
}
