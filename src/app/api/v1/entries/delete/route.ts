import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";

/**
 * 删除 / 恢复 交易记录
 *
 * 删除:
 *   POST { entryIds: string[] }
 *   entryIds 必须是 TxRecord.id
 *   普通交易软删除；贷款借入根记录会删除整个贷款项目及关联计划/流水/利率调整。
 *
 * 恢复（撤销软删除）:
 *   POST { action: "restore", transactionIds: string[] }
 *   transactionIds 必须是 TxRecord.id
 *
 * 返回 { ok: true, message } 或 { ok: false, error }
 */
export async function POST(req: Request) {
  try {
    const { householdId, user } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const action: string | undefined = body?.action;

    if (action === "restore") {
      const transactionIds: string[] | undefined = body?.transactionIds;
      if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
        return NextResponse.json({ ok: false, error: "缺少 transactionIds" }, { status: 400 });
      }
      const res = await prisma.txRecord.updateMany({
        where: { id: { in: transactionIds } },
        data: { deletedAt: null },
      });
      // 收集恢复记录涉及的账户，重算余额
      const restoredRecords = await prisma.txRecord.findMany({
        where: { id: { in: transactionIds } },
        select: { accountId: true, toAccountId: true, type: true, fundProductType: true, fundSubtype: true, fundCode: true, metalTypeId: true },
      });
      await syncFundTransactionsFromTxRecords(transactionIds).catch(logger.catchLog("同步基金业务单失败", "route.ts"));
      const accountsToRecalc = new Set<string>();
      const fundAccountsToRecalc = new Map<string, string[]>();
      const metalAccountsToRecalc = new Set<string>();
      let touchedInvestment = false;
      for (const r of restoredRecords) {
        if (r.accountId) accountsToRecalc.add(r.accountId);
        if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
        if (r.type === "investment" || r.fundProductType) touchedInvestment = true;
        const isRedeemLike = r.fundSubtype === "redeem" || r.fundSubtype === "switch_out";
        const investmentAccId = isRedeemLike ? r.accountId : r.toAccountId;
        if ((r.metalTypeId || r.fundProductType === "metal") && investmentAccId) {
          metalAccountsToRecalc.add(investmentAccId);
        } else if (r.fundCode && r.fundProductType && investmentAccId) {
          const codes = fundAccountsToRecalc.get(investmentAccId) ?? [];
          if (!codes.includes(r.fundCode)) codes.push(r.fundCode);
          fundAccountsToRecalc.set(investmentAccId, codes);
        }
      }
      for (const [acctId, codes] of fundAccountsToRecalc) {
        await recalcFundPositions(acctId, codes).catch(logger.catchLog("操作失败", "route.ts"));
      }
      for (const acctId of metalAccountsToRecalc) {
        await recalcPreciousMetalPositions(acctId).catch(logger.catchLog("操作失败", "route.ts"));
      }
      for (const acctId of accountsToRecalc) {
        await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
      }
      await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalc).catch(
        logger.catchLog("信用卡账单缓存失效失败", "route.ts"),
      );
      if (touchedInvestment) revalidateAfterInvestChange();
      else revalidateAfterTxChange();
      // Client-side will handle page refresh
      return NextResponse.json({ ok: true, count: res.count, message: `已恢复 ${res.count} 条记录` });
    }

    const entryIds: string[] = body?.entryIds;

    if (!entryIds || !Array.isArray(entryIds) || entryIds.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少 entryIds" }, { status: 400 });
    }

    let deletedCount = 0;
    const fundAccountsToRecalc = new Map<string, string[]>();
    const metalAccountsToRecalc = new Set<string>();
    const accountsToRecalcBalance = new Set<string>();
    const changedFundEntryIds: string[] = [];
    let touchedInvestment = false;

    for (const entryId of entryIds) {
      const txRecord = await prisma.txRecord.findUnique({
        where: { id: entryId },
      });

      if (!txRecord) continue;
      if (txRecord.deletedAt) continue;
      if (!isAdmin(user) && txRecord.householdId && txRecord.householdId !== householdId) continue;

      // 软删除 TxRecord
      await prisma.txRecord.update({
        where: { id: txRecord.id },
        data: { deletedAt: new Date() },
      });
      changedFundEntryIds.push(txRecord.id);
      deletedCount++;

      // 记录需要重新计算余额的账户（accountId 和 toAccountId 两侧）
      if (txRecord.accountId) accountsToRecalcBalance.add(txRecord.accountId);
      if (txRecord.toAccountId) accountsToRecalcBalance.add(txRecord.toAccountId);
      if (txRecord.type === "investment" || txRecord.fundProductType) touchedInvestment = true;

      if (txRecord.source === "debt_borrow_in" && txRecord.accountId) {
        const debtAccount = await prisma.account.findFirst({
          where: {
            id: txRecord.accountId,
            kind: AccountKind.loan,
            householdId,
          },
          select: { id: true },
        });
        if (debtAccount) {
          const repaymentPlans = await prisma.regularInvestPlan.findMany({
            where: {
              householdId,
              accountId: debtAccount.id,
              fundCode: "loan_repayment",
            },
            select: { id: true, cashAccountId: true },
          });
          const repaymentPlanIds = repaymentPlans.map((plan) => plan.id);
          const relatedRecords = await prisma.txRecord.findMany({
            where: {
              householdId,
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
              where: { id: { in: relatedRecordIds }, householdId },
            });
            deletedCount += Math.max(0, hardDeleted.count - 1);
          }
          await prisma.loanRateAdjustment.deleteMany({
            where: { householdId, accountId: debtAccount.id },
          });
          if (repaymentPlanIds.length > 0) {
            await prisma.regularInvestPlan.deleteMany({
              where: { id: { in: repaymentPlanIds }, householdId },
            });
          }
          await prisma.account.delete({ where: { id: debtAccount.id } });
          accountsToRecalcBalance.delete(debtAccount.id);
          continue;
        }
      }

      // 如果是基金交易，记录需要重新计算持仓的账户和基金代码
      // 买入类：accountId=资金账户, toAccountId=投资账户
      // 赎回类：accountId=投资账户, toAccountId=资金账户
      if (txRecord.metalTypeId || txRecord.fundProductType === "metal") {
        const isRedeemLike = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
        const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId;
        if (investmentAccId) metalAccountsToRecalc.add(investmentAccId);
      } else if (txRecord.fundCode && txRecord.fundProductType) {
        const isRedeemLike = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
        const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId;
        if (investmentAccId) {
          const codes = fundAccountsToRecalc.get(investmentAccId) ?? [];
          if (!codes.includes(txRecord.fundCode)) {
            codes.push(txRecord.fundCode);
            fundAccountsToRecalc.set(investmentAccId, codes);
          }
        }
      }
    }

    // 批量重新计算持仓
    if (changedFundEntryIds.length > 0) {
      await syncFundTransactionsFromTxRecords(changedFundEntryIds).catch(logger.catchLog("同步基金业务单失败", "route.ts"));
    }
    for (const [accountId, fundCodes] of fundAccountsToRecalc) {
      await recalcFundPositions(accountId, fundCodes).catch(logger.catchLog("操作失败", "route.ts"));
    }
    for (const accountId of metalAccountsToRecalc) {
      await recalcPreciousMetalPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    // 批量重新计算账户余额
    for (const accountId of accountsToRecalcBalance) {
      await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalcBalance).catch(
      logger.catchLog("信用卡账单缓存失效失败", "route.ts"),
    );

    if (touchedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();

    if (deletedCount === 0) {
      return NextResponse.json(
        { ok: false, error: `未找到匹配的记录 (IDs: ${entryIds.slice(0, 3).join(", ")}${entryIds.length > 3 ? "..." : ""})` },
        { status: 404 }
      );
    }

    // Client-side handles page refresh via router.refresh() + mmh:fund:refresh
    return NextResponse.json({
      ok: true,
      message: `已删除 ${deletedCount} 条记录`,
    });
  } catch (e) {
    console.error("[delete] Error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "删除失败" },
      { status: 500 }
    );
  }
}
