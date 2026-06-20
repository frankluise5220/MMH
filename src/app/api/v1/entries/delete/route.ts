import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";

/**
 * 删除 / 恢复 交易记录
 *
 * 删除（软删除）:
 *   POST { entryIds: string[] }
 *   entryIds 必须是 TxRecord.id
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
        select: { accountId: true, toAccountId: true },
      });
      const accountsToRecalc = new Set<string>();
      for (const r of restoredRecords) {
        if (r.accountId) accountsToRecalc.add(r.accountId);
        if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
      }
      for (const acctId of accountsToRecalc) {
        await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
      }
      // Client-side will handle page refresh
      return NextResponse.json({ ok: true, count: res.count, message: `已恢复 ${res.count} 条记录` });
    }

    const entryIds: string[] = body?.entryIds;

    if (!entryIds || !Array.isArray(entryIds) || entryIds.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少 entryIds" }, { status: 400 });
    }

    let deletedCount = 0;
    const fundAccountsToRecalc = new Map<string, string[]>();
    const accountsToRecalcBalance = new Set<string>();

    for (const entryId of entryIds) {
      const txRecord = await prisma.txRecord.findUnique({
        where: { id: entryId },
      });

      if (!txRecord) continue;
      if (!isAdmin(user) && txRecord.householdId && txRecord.householdId !== householdId) continue;

      // 软删除 TxRecord
      await prisma.txRecord.update({
        where: { id: txRecord.id },
        data: { deletedAt: new Date() },
      });
      deletedCount++;

      // 记录需要重新计算余额的账户（accountId 和 toAccountId 两侧）
      if (txRecord.accountId) accountsToRecalcBalance.add(txRecord.accountId);
      if (txRecord.toAccountId) accountsToRecalcBalance.add(txRecord.toAccountId);

      // 如果是基金交易，记录需要重新计算持仓的账户和基金代码
      // 买入类：accountId=资金账户, toAccountId=投资账户
      // 赎回类：accountId=投资账户, toAccountId=资金账户
      if (txRecord.fundCode && txRecord.fundProductType) {
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
    for (const [accountId, fundCodes] of fundAccountsToRecalc) {
      await recalcFundPositions(accountId, fundCodes).catch(logger.catchLog("操作失败", "route.ts"));
    }

    // 批量重新计算账户余额
    for (const accountId of accountsToRecalcBalance) {
      await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }

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