import { type TxRecord } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { isAdmin } from "@/lib/server/auth";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { listEntryBusinessDeleteImpacts, upsertLegacyCombinedEntryBusinessLink } from "@/lib/server/entry-business-link";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";

export type EntryDeleteLinkedAction = "deleteBusiness" | "keepBusiness";

type EntryDeleteOptions = {
  linkedAction?: EntryDeleteLinkedAction;
};

function collectInvestmentRecalcTargets(
  txRecord: Pick<TxRecord, "accountId" | "toAccountId" | "type" | "fundProductType" | "fundSubtype" | "fundCode" | "metalTypeId">,
  targets: {
    accountsToRecalcBalance: Set<string>;
    fundAccountsToRecalc: Map<string, string[]>;
    metalAccountsToRecalc: Set<string>;
  },
) {
  if (txRecord.accountId) targets.accountsToRecalcBalance.add(txRecord.accountId);
  if (txRecord.toAccountId) targets.accountsToRecalcBalance.add(txRecord.toAccountId);

  const isRedeemLike = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
  const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId ?? txRecord.accountId;
  if ((txRecord.metalTypeId || txRecord.fundProductType === "metal") && investmentAccId) {
    targets.metalAccountsToRecalc.add(investmentAccId);
    return;
  }
  if (txRecord.fundCode && txRecord.fundProductType && investmentAccId) {
    const codes = targets.fundAccountsToRecalc.get(investmentAccId) ?? [];
    if (!codes.includes(txRecord.fundCode)) codes.push(txRecord.fundCode);
    targets.fundAccountsToRecalc.set(investmentAccId, codes);
  }
}

function businessAccountSnapshotOf(txRecord: TxRecord) {
  const isReceiptLike =
    txRecord.fundSubtype === "redeem" ||
    txRecord.fundSubtype === "switch_out" ||
    txRecord.fundSubtype === "dividend_cash" ||
    txRecord.source === "regular_invest_refund";
  const id = isReceiptLike ? txRecord.accountId : txRecord.toAccountId ?? txRecord.accountId;
  const name = isReceiptLike ? txRecord.accountName : txRecord.toAccountName ?? txRecord.accountName;
  return { id, name };
}

type InvestmentRecalcTargets = {
  accountsToRecalcBalance: Set<string>;
  fundAccountsToRecalc: Map<string, string[]>;
  metalAccountsToRecalc: Set<string>;
};

type IndependentBusinessDeleteResult = {
  deletedCount: number;
  deletedEntryIds: string[];
  removedEntryIds: string[];
  touchedInvestment: boolean;
};

export type EntryDeleteResult = {
  deletedCount: number;
  keptBusinessCount: number;
  deletedEntryIds: string[];
  removedEntryIds: string[];
  accountIds: string[];
};

function addOptionalAccountId(targets: InvestmentRecalcTargets, accountId: string | null | undefined) {
  if (accountId) targets.accountsToRecalcBalance.add(accountId);
}

function addFundRecalcTarget(targets: InvestmentRecalcTargets, accountId: string, fundCode: string) {
  const codes = targets.fundAccountsToRecalc.get(accountId) ?? [];
  if (!codes.includes(fundCode)) codes.push(fundCode);
  targets.fundAccountsToRecalc.set(accountId, codes);
}

async function softDeleteIndependentBusinessRecordsByIds(
  ctx: HouseholdContext,
  entryIds: string[],
  targets: InvestmentRecalcTargets,
): Promise<IndependentBusinessDeleteResult> {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  const result: IndependentBusinessDeleteResult = {
    deletedCount: 0,
    deletedEntryIds: [],
    removedEntryIds: [],
    touchedInvestment: false,
  };
  if (ids.length === 0) return result;

  const deletedAt = new Date();
  const pushRemovedIds = (businessId: string, cashEntryId?: string | null) => {
    result.deletedEntryIds.push(businessId);
    result.removedEntryIds.push(businessId);
    if (cashEntryId) result.removedEntryIds.push(cashEntryId);
  };

  const fundRows = await prisma.fundTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, fundAccountId: true, cashAccountId: true, fundCode: true },
  });
  for (const row of fundRows) {
    const updated = await prisma.fundTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.fundAccountId);
    addOptionalAccountId(targets, row.cashAccountId);
    addFundRecalcTarget(targets, row.fundAccountId, row.fundCode);
  }

  const insuranceRows = await prisma.insuranceTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of insuranceRows) {
    const updated = await prisma.insuranceTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
  }

  const wealthRows = await prisma.wealthTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of wealthRows) {
    const updated = await prisma.wealthTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
  }

  const depositRows = await prisma.depositTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of depositRows) {
    const updated = await prisma.depositTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
  }

  const metalRows = await prisma.preciousMetalTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [{ id: { in: ids } }, { cashEntryId: { in: ids } }],
    },
    select: { id: true, cashEntryId: true, accountId: true, cashAccountId: true },
  });
  for (const row of metalRows) {
    const updated = await prisma.preciousMetalTransaction.updateMany({
      where: { id: row.id, householdId: ctx.householdId, deletedAt: null },
      data: { deletedAt },
    });
    if (updated.count === 0) continue;
    result.deletedCount += updated.count;
    result.touchedInvestment = true;
    pushRemovedIds(row.id, row.cashEntryId);
    addOptionalAccountId(targets, row.accountId);
    addOptionalAccountId(targets, row.cashAccountId);
    targets.metalAccountsToRecalc.add(row.accountId);
  }

  const independentBusinessIds = result.deletedEntryIds;
  const removedCashEntryIds = result.removedEntryIds.filter((id) => !independentBusinessIds.includes(id));
  if (independentBusinessIds.length > 0 || removedCashEntryIds.length > 0) {
    await prisma.entryBusinessLink.updateMany({
      where: {
        householdId: ctx.householdId,
        deletedAt: null,
        OR: [
          { cashEntryId: { in: removedCashEntryIds } },
          { businessEntryId: { in: independentBusinessIds } },
          { fundTransactionId: { in: independentBusinessIds } },
          { insuranceTransactionId: { in: independentBusinessIds } },
          { wealthTransactionId: { in: independentBusinessIds } },
          { depositTransactionId: { in: independentBusinessIds } },
          { preciousMetalTransactionId: { in: independentBusinessIds } },
        ],
      },
      data: { deletedAt },
    });
  }

  result.deletedEntryIds = Array.from(new Set(result.deletedEntryIds));
  result.removedEntryIds = Array.from(new Set(result.removedEntryIds));
  return result;
}

async function detachLegacyCombinedBusinessEntry(txRecord: TxRecord) {
  const businessAccount = businessAccountSnapshotOf(txRecord);
  if (!businessAccount.id) return false;

  await prisma.txRecord.update({
    where: { id: txRecord.id },
    data: {
      accountId: businessAccount.id,
      accountName: businessAccount.name || txRecord.accountName,
      toAccountId: null,
      toAccountName: null,
    },
  });
  await prisma.$executeRaw`
    UPDATE "entry_business_links"
    SET
      "cashEntryId" = NULL,
      "note" = 'Cash side detached; business detail kept',
      "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify({ cashDetached: true })}::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "cashEntryId" = ${txRecord.id}
      AND "businessEntryId" = ${txRecord.id}
      AND "deletedAt" IS NULL
  `;
  return true;
}

async function detachCashSideBusinessLinks(txRecord: TxRecord) {
  const result = await prisma.$executeRaw`
    UPDATE "entry_business_links"
    SET
      "cashEntryId" = NULL,
      "note" = 'Cash side detached; business detail kept',
      "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify({ cashDetached: true, detachedCashEntryId: txRecord.id })}::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "cashEntryId" = ${txRecord.id}
      AND ("businessEntryId" IS DISTINCT FROM ${txRecord.id})
      AND "deletedAt" IS NULL
  `;
  return Number(result) > 0;
}

async function detachBusinessSideBusinessLinks(txRecord: TxRecord) {
  const result = await prisma.$executeRaw`
    UPDATE "entry_business_links"
    SET
      "businessEntryId" = NULL,
      "fundTransactionId" = NULL,
      "insuranceTransactionId" = NULL,
      "wealthTransactionId" = NULL,
      "depositTransactionId" = NULL,
      "preciousMetalTransactionId" = NULL,
      "note" = 'Business side detached; cash detail kept',
      "metadata" = COALESCE("metadata", '{}'::jsonb) || ${JSON.stringify({ businessDetached: true, detachedBusinessEntryId: txRecord.id })}::jsonb,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "businessEntryId" = ${txRecord.id}
      AND ("cashEntryId" IS DISTINCT FROM ${txRecord.id})
      AND "deletedAt" IS NULL
  `;
  return Number(result) > 0;
}

export async function softDeleteEntriesByIds(
  ctx: HouseholdContext,
  entryIds: string[],
  label?: string,
  options: EntryDeleteOptions = {},
): Promise<EntryDeleteResult> {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) {
    return { deletedCount: 0, keptBusinessCount: 0, deletedEntryIds: [], removedEntryIds: [], accountIds: [] };
  }

  const undo = await prepareEntryUndo(prisma, ctx.householdId, ids);
  let deletedCount = 0;
  let keptBusinessCount = 0;
  const deletedEntryIds: string[] = [];
  const removedEntryIds: string[] = [];
  const fundAccountsToRecalc = new Map<string, string[]>();
  const metalAccountsToRecalc = new Set<string>();
  const accountsToRecalcBalance = new Set<string>();
  const changedFundEntryIds: string[] = [];
  const processedInstallmentPlanIds = new Set<string>();
  let touchedInvestment = false;

  for (const entryId of ids) {
    const txRecord = await prisma.txRecord.findUnique({ where: { id: entryId } });
    if (!txRecord) continue;
    if (txRecord.deletedAt) continue;
    if (!isAdmin(ctx.user) && txRecord.householdId && txRecord.householdId !== ctx.householdId) continue;
    await upsertLegacyCombinedEntryBusinessLink(prisma, txRecord).catch(
      logger.catchLog("同步交易业务关联失败", "entry-delete.ts"),
    );
    const keepBusinessImpacts = options.linkedAction === "keepBusiness"
      ? await listEntryBusinessDeleteImpacts(ctx, [txRecord.id]).catch(() => [])
      : [];
    const hasLegacyCombinedBusiness = keepBusinessImpacts.some((impact) => impact.legacyCombinedRecord);
    if (hasLegacyCombinedBusiness) {
      if (await detachLegacyCombinedBusinessEntry(txRecord)) {
        keptBusinessCount++;
        removedEntryIds.push(txRecord.id);
        changedFundEntryIds.push(txRecord.id);
        if (txRecord.type === "investment" || txRecord.fundProductType) touchedInvestment = true;
        collectInvestmentRecalcTargets(txRecord, {
          accountsToRecalcBalance,
          fundAccountsToRecalc,
          metalAccountsToRecalc,
        });
        const businessAccount = businessAccountSnapshotOf(txRecord);
        if (businessAccount.id) accountsToRecalcBalance.add(businessAccount.id);
        continue;
      }
    }
    if (options.linkedAction === "keepBusiness" && keepBusinessImpacts.length > 0) {
      const selectedAsBusiness = keepBusinessImpacts.some((impact) => impact.selectedSide === "business");
      if (selectedAsBusiness) await detachBusinessSideBusinessLinks(txRecord);
      else await detachCashSideBusinessLinks(txRecord);
    }

    const installmentPlan = await prisma.creditCardInstallmentPlan.findFirst({
      where: {
        householdId: ctx.householdId,
        OR: [
          { sourceEntryId: txRecord.id },
          ...(txRecord.creditCardInstallmentPlanId ? [{ id: txRecord.creditCardInstallmentPlanId }] : []),
        ],
      },
      select: { id: true, accountId: true },
    });

    let deletedWithInstallmentPlan = false;
    if (installmentPlan && !processedInstallmentPlanIds.has(installmentPlan.id)) {
      processedInstallmentPlanIds.add(installmentPlan.id);
      const deletedAt = new Date();
      const relatedRecords = await prisma.txRecord.findMany({
        where: {
          householdId: ctx.householdId,
          creditCardInstallmentPlanId: installmentPlan.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      const related = await prisma.txRecord.updateMany({
        where: {
          householdId: ctx.householdId,
          creditCardInstallmentPlanId: installmentPlan.id,
          deletedAt: null,
        },
        data: { deletedAt },
      });
      await prisma.creditCardInstallmentPlan.update({
        where: { id: installmentPlan.id },
        data: { status: "cancelled" },
      });
      for (const record of relatedRecords) {
        deletedEntryIds.push(record.id);
        removedEntryIds.push(record.id);
      }
      accountsToRecalcBalance.add(installmentPlan.accountId);
      deletedCount += related.count;
      deletedWithInstallmentPlan = txRecord.creditCardInstallmentPlanId === installmentPlan.id;
    }

    if (!deletedWithInstallmentPlan) {
      await prisma.txRecord.update({
        where: { id: txRecord.id },
        data: { deletedAt: new Date() },
      });
      deletedCount++;
      deletedEntryIds.push(txRecord.id);
      removedEntryIds.push(txRecord.id);
    }

    changedFundEntryIds.push(txRecord.id);
    if (txRecord.type === "investment" || txRecord.fundProductType) touchedInvestment = true;
    collectInvestmentRecalcTargets(txRecord, {
      accountsToRecalcBalance,
      fundAccountsToRecalc,
      metalAccountsToRecalc,
    });

  }

  if (options.linkedAction !== "keepBusiness") {
    const independentDelete = await softDeleteIndependentBusinessRecordsByIds(ctx, ids, {
      accountsToRecalcBalance,
      fundAccountsToRecalc,
      metalAccountsToRecalc,
    });
    deletedCount += independentDelete.deletedCount;
    deletedEntryIds.push(...independentDelete.deletedEntryIds);
    removedEntryIds.push(...independentDelete.removedEntryIds);
    if (independentDelete.touchedInvestment) touchedInvestment = true;
  }

  if (changedFundEntryIds.length > 0) {
    await syncFundTransactionsFromTxRecords(changedFundEntryIds).catch(logger.catchLog("同步基金业务单失败", "entry-delete.ts"));
    for (const id of changedFundEntryIds) {
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id }).catch(
        logger.catchLog("同步独立业务单失败", "entry-delete.ts"),
      );
    }
  }
  for (const [accountId, fundCodes] of fundAccountsToRecalc) {
    await recalcFundPositions(accountId, fundCodes).catch(logger.catchLog("操作失败", "entry-delete.ts"));
  }
  for (const accountId of metalAccountsToRecalc) {
    await recalcPreciousMetalPositions(accountId).catch(logger.catchLog("操作失败", "entry-delete.ts"));
  }
  for (const accountId of accountsToRecalcBalance) {
    await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "entry-delete.ts"));
  }
  await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalcBalance).catch(
    logger.catchLog("信用卡账单缓存失效失败", "entry-delete.ts"),
  );

  if (deletedCount > 0) {
    await saveEntryUndo(
      prisma,
      ctx,
      undo,
      deletedCount > 1 ? "batch_delete" : "delete",
      label ?? (deletedCount > 1 ? `批量删除 ${deletedCount} 条明细` : "删除明细"),
    );
    if (touchedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();
  } else if (keptBusinessCount > 0) {
    await saveEntryUndo(
      prisma,
      ctx,
      undo,
      keptBusinessCount > 1 ? "batch_delete" : "delete",
      label ?? (keptBusinessCount > 1 ? `移除 ${keptBusinessCount} 条资金流水并保留业务明细` : "移除资金流水并保留业务明细"),
    );
    if (touchedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();
  }

  return {
    deletedCount,
    keptBusinessCount,
    deletedEntryIds: Array.from(new Set(deletedEntryIds)),
    removedEntryIds: Array.from(new Set(removedEntryIds)),
    accountIds: Array.from(accountsToRecalcBalance),
  };
}
