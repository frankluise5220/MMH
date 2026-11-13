/**
 * Shared soft-delete restore path.
 *
 * Both the Web UI (`POST /api/v1/entries/delete {action:"restore"}`) and the
 * built-in AI assistant dispatch here, so a restored row always gets the same
 * installment-plan, business-record, position, balance and cache treatment.
 * Never restore with a bare `updateMany({data:{deletedAt:null}})`.
 */
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { logger } from "@/lib/logger";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import {
  restoreBusinessRecordsForCashEntryIds,
  type RestoredBusinessFundTarget,
} from "@/lib/server/entry-business-link";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { restoreMetalExtractPropertyTransactions } from "@/lib/property/transactions";

export async function restoreDeletedEntries(ctx: HouseholdContext, transactionIds: string[]) {
  const { householdId } = ctx;
  const requestedRecords = await prisma.txRecord.findMany({
    where: { id: { in: transactionIds }, OR: [{ householdId }, { householdId: null }] },
    select: { creditCardInstallmentPlanId: true },
  });
  const res = await prisma.txRecord.updateMany({
    where: { id: { in: transactionIds } },
    data: { deletedAt: null },
  });
  const restoredInstallmentPlans = await prisma.creditCardInstallmentPlan.findMany({
    where: {
      householdId,
      OR: [
        { sourceEntryId: { in: transactionIds } },
        {
          id: {
            in: requestedRecords
              .map((record) => record.creditCardInstallmentPlanId)
              .filter((id): id is string => !!id),
          },
        },
      ],
    },
    select: { id: true },
  });
  if (restoredInstallmentPlans.length > 0) {
    const planIds = restoredInstallmentPlans.map((plan) => plan.id);
    await prisma.$transaction([
      prisma.creditCardInstallmentPlan.updateMany({
        where: { id: { in: planIds }, householdId },
        data: { status: "active" },
      }),
      prisma.txRecord.updateMany({
        where: { creditCardInstallmentPlanId: { in: planIds }, householdId },
        data: { deletedAt: null },
      }),
    ]);
  }
  // Collect accounts involved in the restored records and recalculate balances
  const restoredRecords = await prisma.txRecord.findMany({
    where: { id: { in: transactionIds } },
    select: { accountId: true, toAccountId: true, type: true, fundProductType: true, fundSubtype: true, fundCode: true, metalTypeId: true },
  });
  // 整笔恢复：删除是整笔删（同业务单的资金腿 + 业务单本身），恢复也必须整笔回来，
  // 否则投资侧派生行会永远回不来。业务单按 link 反查，不依赖资金腿上的 fundCode。
  const restoredBusiness = await restoreBusinessRecordsForCashEntryIds(ctx, transactionIds).catch((error) => {
    logger.catchLog("恢复整笔业务明细失败", "entry-restore.ts")(error);
    return { restoredCount: 0, fundTargets: [] as RestoredBusinessFundTarget[] };
  });
  // 提取实物的固定资产交易只靠 cashEntryId 挂在明细上（没有 EntryBusinessLink），删除时被连带软删、
  // 资产被重算成已删除；这里要把它一起复活，否则撤销删除后收藏品资产永远回不来。
  const restoredMetalAssets = await restoreMetalExtractPropertyTransactions(prisma, {
    householdId,
    cashEntryIds: transactionIds,
  }).catch((error) => {
    logger.catchLog("恢复提取实物固定资产交易失败", "entry-restore.ts")(error);
    return { restoredCount: 0, propertyAssetIds: [] as string[] };
  });
  await syncFundTransactionsFromTxRecords(transactionIds).catch(logger.catchLog("同步基金业务单失败", "entry-restore.ts"));
  for (const id of transactionIds) {
    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id }).catch(
      logger.catchLog("同步独立业务单失败", "entry-restore.ts"),
    );
  }
  const accountsToRecalc = new Set<string>();
  const fundAccountsToRecalc = new Map<string, string[]>();
  const metalAccountsToRecalc = new Set<string>();
  let touchedInvestment = false;
  for (const r of restoredRecords) {
    if (r.accountId) accountsToRecalc.add(r.accountId);
    if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
    if (r.type === "investment" || r.fundProductType) touchedInvestment = true;
    const isRedeemLike = r.fundSubtype === "redeem" || r.fundSubtype === "switch_out";
    const investmentAccId = isRedeemLike ? r.accountId : r.toAccountId ?? r.accountId;
    if ((r.metalTypeId || r.fundProductType === "metal") && investmentAccId) {
      metalAccountsToRecalc.add(investmentAccId);
    } else if (r.fundCode && r.fundProductType && investmentAccId) {
      const codes = fundAccountsToRecalc.get(investmentAccId) ?? [];
      if (!codes.includes(r.fundCode)) codes.push(r.fundCode);
      fundAccountsToRecalc.set(investmentAccId, codes);
    }
  }
  for (const target of restoredBusiness.fundTargets) {
    const codes = fundAccountsToRecalc.get(target.fundAccountId) ?? [];
    if (!codes.includes(target.fundCode)) codes.push(target.fundCode);
    fundAccountsToRecalc.set(target.fundAccountId, codes);
  }
  for (const [acctId, codes] of fundAccountsToRecalc) {
    await recalcFundPositions(acctId, codes).catch(logger.catchLog("操作失败", "entry-restore.ts"));
  }
  for (const acctId of metalAccountsToRecalc) {
    await recalcPreciousMetalPositions(acctId).catch(logger.catchLog("操作失败", "entry-restore.ts"));
  }
  for (const acctId of accountsToRecalc) {
    await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "entry-restore.ts"));
  }
  await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalc).catch(
    logger.catchLog("信用卡账单缓存失效失败", "entry-restore.ts"),
  );
  // 资金腿本身没有 fundCode / fundProductType，只看腿判断不出投资侧是否变化；
  // 整笔恢复带回业务单时也要失效投资侧缓存，否则页面仍读旧缓存。
  if (
    touchedInvestment
    || restoredBusiness.restoredCount > 0
    || restoredBusiness.fundTargets.length > 0
    || restoredMetalAssets.restoredCount > 0
  ) {
    revalidateAfterInvestChange();
  } else {
    revalidateAfterTxChange();
  }
  return { count: res.count, accountIds: Array.from(accountsToRecalc) };
}
