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
    const [entryCount, businessCount] = await Promise.all([
      prisma.txRecord.count({ where: { householdId, wealthProductId: productId, deletedAt: null } }),
      prisma.wealthTransaction.count({ where: { householdId, wealthProductId: productId, deletedAt: null } }),
    ]);
    return buildSummary(entryCount, businessCount, 0, 0);
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

  const entryRows = await prisma.txRecord.findMany({
    where:
      family === "deposit"
        ? { householdId, depositProductId: productId, deletedAt: null }
        : family === "wealth"
          ? { householdId, wealthProductId: productId, deletedAt: null }
          : { householdId, bondProductId: productId, deletedAt: null },
    select: { id: true },
  });
  const entryIds = entryRows.map((row) => row.id);

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
