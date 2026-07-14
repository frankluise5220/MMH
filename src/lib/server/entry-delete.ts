import { AccountKind, type TxRecord } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { isAdmin } from "@/lib/server/auth";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";

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
  const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId;
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

export async function softDeleteEntriesByIds(
  ctx: HouseholdContext,
  entryIds: string[],
  label?: string,
) {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) return { deletedCount: 0 };

  const undo = await prepareEntryUndo(prisma, ctx.householdId, ids);
  let deletedCount = 0;
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
    }

    changedFundEntryIds.push(txRecord.id);
    if (txRecord.type === "investment" || txRecord.fundProductType) touchedInvestment = true;
    collectInvestmentRecalcTargets(txRecord, {
      accountsToRecalcBalance,
      fundAccountsToRecalc,
      metalAccountsToRecalc,
    });

    if (txRecord.source === "debt_borrow_in" && txRecord.accountId) {
      const debtAccount = await prisma.account.findFirst({
        where: {
          id: txRecord.accountId,
          kind: AccountKind.loan,
          householdId: ctx.householdId,
        },
        select: { id: true },
      });
      if (debtAccount) {
        const repaymentPlans = await prisma.regularInvestPlan.findMany({
          where: {
            householdId: ctx.householdId,
            accountId: debtAccount.id,
            fundCode: "loan_repayment",
          },
          select: { id: true, cashAccountId: true },
        });
        const repaymentPlanIds = repaymentPlans.map((plan) => plan.id);
        const relatedRecords = await prisma.txRecord.findMany({
          where: {
            householdId: ctx.householdId,
            OR: [
              { accountId: debtAccount.id },
              { toAccountId: debtAccount.id },
              ...(repaymentPlanIds.length > 0 ? [{ regularInvestPlanId: { in: repaymentPlanIds } }] : []),
            ],
          },
          select: { id: true, accountId: true, toAccountId: true, type: true, fundProductType: true },
        });
        for (const record of relatedRecords) {
          if (record.accountId) accountsToRecalcBalance.add(record.accountId);
          if (record.toAccountId) accountsToRecalcBalance.add(record.toAccountId);
          if (record.type === "investment" || record.fundProductType) touchedInvestment = true;
        }
        for (const plan of repaymentPlans) {
          if (plan.cashAccountId) accountsToRecalcBalance.add(plan.cashAccountId);
        }
        if (relatedRecords.length > 0) {
          const relatedRecordIds = relatedRecords.map((record) => record.id);
          await prisma.entryTag.deleteMany({ where: { entryId: { in: relatedRecordIds } } });
          await prisma.attachment.deleteMany({ where: { entryId: { in: relatedRecordIds } } });
          const hardDeleted = await prisma.txRecord.deleteMany({
            where: { id: { in: relatedRecordIds }, householdId: ctx.householdId },
          });
          deletedCount += Math.max(0, hardDeleted.count - 1);
        }
        await prisma.loanRateAdjustment.deleteMany({
          where: { householdId: ctx.householdId, accountId: debtAccount.id },
        });
        if (repaymentPlanIds.length > 0) {
          await prisma.regularInvestPlan.deleteMany({
            where: { id: { in: repaymentPlanIds }, householdId: ctx.householdId },
          });
        }
        await prisma.account.delete({ where: { id: debtAccount.id } });
        accountsToRecalcBalance.delete(debtAccount.id);
        continue;
      }
    }
  }

  if (changedFundEntryIds.length > 0) {
    await syncFundTransactionsFromTxRecords(changedFundEntryIds).catch(logger.catchLog("同步基金业务单失败", "entry-delete.ts"));
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
  }

  return { deletedCount };
}
