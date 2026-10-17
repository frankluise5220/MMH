import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { HouseholdContext } from "@/lib/server/household-scope";

/**
 * 产品主数据（存款 / 理财 / 债券）的引用统计与级联清理。
 *
 * 背景：三张产品表的引用外键都是 `onDelete: SetNull`（见 prisma/schema.prisma）。
 * 也就是说**直接 delete 产品行不会报错**，而是把引用它的存单 / 持仓记录的产品外键
 * 悄悄置空——这正是「产品看着像被删掉了」这类事故的温床。所以删除产品前必须先统计
 * 引用，被引用时返回 409 让用户显式确认，确认后走 `softDeleteEntriesByIds`
 * （余额安全路径）而不是 `deleteMany`。
 *
 * 计划任务（存单粒度 `depm_<lotId>` / `depa_<lotId>` / `depi_<lotId>` / `bondm_<lotId>` / `bonda_<lotId>` / `bondi_<lotId>`）
 * 不随明细软删自动消失，需要按存单 id 显式清理，见 `planIdsForLots`。
 */
export type ProductFamily = "deposit" | "wealth" | "bond";

export type ProductRefSummary = {
  /** 引用该产品的明细记录数（TxRecord，未软删） */
  entryCount: number;
  /** 引用该产品的业务表行数（deposit_transactions / wealth_transactions / bond_transactions，未软删） */
  businessCount: number;
  /** 存单 / 持仓数（买入行） */
  lotCount: number;
  /** 关联的计划任务数（存单粒度的到期 / 付息计划） */
  planCount: number;
  /** 是否被引用（任一计数 > 0） */
  referenced: boolean;
};

function buildSummary(
  entryCount: number,
  businessCount: number,
  lotCount: number,
  planCount: number,
): ProductRefSummary {
  return {
    entryCount,
    businessCount,
    lotCount,
    planCount,
    referenced: entryCount > 0 || businessCount > 0 || planCount > 0,
  };
}

/** 存单粒度计划行的 id 规则：前缀 + 存单（buy 行）的 TxRecord id。 */
function planIdsForLots(lotIds: string[], prefixes: string[]): string[] {
  if (lotIds.length === 0 || prefixes.length === 0) return [];
  return lotIds.flatMap((lotId) => prefixes.map((prefix) => `${prefix}${lotId}`));
}

const PLAN_PREFIXES: Record<ProductFamily, string[]> = {
  deposit: ["depm_", "depa_", "depi_"],
  wealth: [],
  bond: ["bondm_", "bonda_", "bondi_"],
};

/**
 * 理财产品引用的资金明细（TxRecord）id 集合。
 *
 * **理财的业务真源是 `wealth_transactions`，不是 `TxRecord.wealthProductId`。**
 * 理财的买入/赎回/分红/核销写入路径只把产品外键写进业务行，从未回填到
 * `transactions` 这条资金腿（2026-10-17 实测：全库 `transactions."wealthProductId"`
 * 非空 0 条，而 `wealth_transactions` 有 131 条）。所以这里必须两条路都走：
 * 1. 直查 `TxRecord.wealthProductId`（兼容将来回填后的数据）；
 * 2. 按 `wealth_transactions.cashEntryId` 反查资金腿（当前唯一真实来源）。
 *
 * 少走第 2 条会导致两个后果：删除确认文案显示「0 条记录」，
 * 以及勾选「同时删除关联记录」后级联删除一条明细都不删，
 * 只把 `wealth_transactions.wealthProductId` 静默置空成孤儿行。
 */
async function collectWealthRefs(householdId: string, productId: string) {
  const businessRows = await prisma.wealthTransaction.findMany({
    where: { householdId, wealthProductId: productId, deletedAt: null },
    select: { cashEntryId: true, action: true },
  });
  const cashEntryIds = businessRows
    .map((row) => row.cashEntryId)
    .filter((id): id is string => Boolean(id));

  const [directEntries, linkedEntries] = await Promise.all([
    prisma.txRecord.findMany({
      where: { householdId, wealthProductId: productId, deletedAt: null },
      select: { id: true },
    }),
    cashEntryIds.length
      ? prisma.txRecord.findMany({
          where: { householdId, id: { in: cashEntryIds }, deletedAt: null },
          select: { id: true },
        })
      : Promise.resolve([] as { id: string }[]),
  ]);

  return {
    businessRows,
    entryIds: Array.from(new Set([...directEntries, ...linkedEntries].map((row) => row.id))),
  };
}

export async function summarizeProductRefs(
  householdId: string,
  family: ProductFamily,
  productId: string,
): Promise<ProductRefSummary> {
  if (family === "deposit") {
    const [entryCount, businessCount, lotRows] = await Promise.all([
      prisma.txRecord.count({ where: { householdId, depositProductId: productId, deletedAt: null } }),
      prisma.depositTransaction.count({ where: { householdId, depositProductId: productId, deletedAt: null } }),
      prisma.txRecord.findMany({
        where: { householdId, depositProductId: productId, deletedAt: null, fundSubtype: FundSubtype.buy },
        select: { id: true },
      }),
    ]);
    const planIds = planIdsForLots(lotRows.map((row) => row.id), PLAN_PREFIXES.deposit);
    const planCount = planIds.length
      ? await prisma.regularInvestPlan.count({ where: { householdId, id: { in: planIds } } })
      : 0;
    return buildSummary(entryCount, businessCount, lotRows.length, planCount);
  }

  if (family === "wealth") {
    const { businessRows, entryIds } = await collectWealthRefs(householdId, productId);
    // 理财没有存单概念，用「买入行数」等价表达持仓数（与存款/债券的 lotCount 语义对齐）。
    const lotCount = businessRows.filter((row) => row.action === FundSubtype.buy).length;
    return buildSummary(entryIds.length, businessRows.length, lotCount, 0);
  }

  const [entryCount, businessCount, lotRows] = await Promise.all([
    prisma.txRecord.count({ where: { householdId, bondProductId: productId, deletedAt: null } }),
    prisma.bondTransaction.count({ where: { householdId, bondProductId: productId, deletedAt: null } }),
    prisma.txRecord.findMany({
      where: { householdId, bondProductId: productId, deletedAt: null, fundSubtype: FundSubtype.buy },
      select: { id: true },
    }),
  ]);
  const planIds = planIdsForLots(lotRows.map((row) => row.id), PLAN_PREFIXES.bond);
  const planCount = planIds.length
    ? await prisma.regularInvestPlan.count({ where: { householdId, id: { in: planIds } } })
    : 0;
  return buildSummary(entryCount, businessCount, lotRows.length, planCount);
}

/**
 * 级联删除某产品下的全部关联记录（用户已显式确认 cascade 后调用）。
 *
 * - 明细走 `softDeleteEntriesByIds`（余额增量、撤销快照、业务表清理、付息配对腿都由它处理），
 *   与明细页删除同一条路径，因此不会造成余额错乱。
 * - 计划任务按存单 id 物理删除。
 * - 产品主数据行本身**不在这里删**，由调用方在级联成功后自行删除。
 */
export async function cascadeDeleteProductRecords(
  ctx: HouseholdContext,
  family: ProductFamily,
  productId: string,
): Promise<{ deletedEntryCount: number; deletedPlanCount: number }> {
  const { householdId } = ctx;

  // 理财必须走 `collectWealthRefs`（业务表 → cashEntryId 反查），
  // 只按 `TxRecord.wealthProductId` 查会拿到空集合，导致「确认级联」实际什么都没删。
  const entryIds =
    family === "wealth"
      ? (await collectWealthRefs(householdId, productId)).entryIds
      : (
          await prisma.txRecord.findMany({
            where:
              family === "deposit"
                ? { householdId, depositProductId: productId, deletedAt: null }
                : { householdId, bondProductId: productId, deletedAt: null },
            select: { id: true },
          })
        ).map((row) => row.id);

  let planIds: string[] = [];
  if (PLAN_PREFIXES[family].length > 0) {
    const lotRows = await prisma.txRecord.findMany({
      where: {
        householdId,
        deletedAt: null,
        fundSubtype: FundSubtype.buy,
        ...(family === "deposit" ? { depositProductId: productId } : { bondProductId: productId }),
      },
      select: { id: true },
    });
    planIds = planIdsForLots(lotRows.map((row) => row.id), PLAN_PREFIXES[family]);
  }

  let deletedEntryCount = 0;
  if (entryIds.length > 0) {
    const { softDeleteEntriesByIds } = await import("@/lib/server/entry-delete");
    const result = await softDeleteEntriesByIds(ctx, entryIds, "删除产品库关联记录", {
      linkedAction: "deleteBusiness",
    });
    deletedEntryCount = result.deletedCount;
  }

  let deletedPlanCount = 0;
  if (planIds.length > 0) {
    const removed = await prisma.regularInvestPlan.deleteMany({
      where: { householdId, id: { in: planIds } },
    });
    deletedPlanCount = removed.count;
  }

  return { deletedEntryCount, deletedPlanCount };
}
