import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { softDeleteEntriesByIds } from "@/lib/server/entry-delete";

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
    const ctx = await getHouseholdScope();
    const { householdId } = ctx;
    const body = await req.json().catch(() => null);
    const action: string | undefined = body?.action;

    if (action === "restore") {
      const transactionIds: string[] | undefined = body?.transactionIds;
      if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
        return NextResponse.json({ ok: false, error: "缺少 transactionIds" }, { status: 400 });
      }
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
    const { deletedCount } = await softDeleteEntriesByIds(ctx, entryIds);

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
