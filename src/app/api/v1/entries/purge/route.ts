import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  const { hidFilter } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const days = typeof body?.days === "number" ? body.days : 30;

  if (days < 1 || days > 365) {
    return NextResponse.json(
      { ok: false, error: "天数必须在 1-365 之间" },
      { status: 400, headers: corsHeaders() }
    );
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);

  const result = await prisma.$transaction(async (tx) => {
    const toDelete = await tx.txRecord.findMany({
      where: {
        deletedAt: { not: null, lte: cutoff },
        ...hidFilter,
      },
      select: { id: true, accountId: true, toAccountId: true, fundCode: true, fundSubtype: true, fundProductType: true },
    });

    const txIds = toDelete.map(t => t.id);

    if (txIds.length === 0) {
      return { permanentlyDeleted: 0, fundAccountsToRecalc: new Map<string, string[]>() };
    }

    // 收集需要重新计算持仓的基金账户
    // 买入类：accountId=资金账户, toAccountId=投资账户
    // 赎回类：accountId=投资账户, toAccountId=资金账户
    const fundAccountsToRecalc = new Map<string, string[]>();
    for (const tx of toDelete) {
      if (tx.fundCode && tx.fundProductType) {
        const isRedeemLike = tx.fundSubtype === "redeem" || tx.fundSubtype === "switch_out";
        const investmentAccId = isRedeemLike ? tx.accountId : tx.toAccountId;
        if (investmentAccId) {
          const codes = fundAccountsToRecalc.get(investmentAccId) ?? [];
          if (!codes.includes(tx.fundCode)) {
            codes.push(tx.fundCode);
            fundAccountsToRecalc.set(investmentAccId, codes);
          }
        }
      }
    }

    await tx.entryTag.deleteMany({
      where: { entryId: { in: txIds } },
    });

    await tx.attachment.deleteMany({
      where: { entryId: { in: txIds } },
    });

    const deleted = await tx.txRecord.deleteMany({
      where: { id: { in: txIds } },
    });

    return { permanentlyDeleted: deleted.count, fundAccountsToRecalc };
  });

  // 重新汇总持仓（事务外）
  for (const [accountId, fundCodes] of result.fundAccountsToRecalc) {
    await recalcFundPositions(accountId, fundCodes).catch(logger.catchLog("操作失败", "route.ts"));
  }

  if (result.permanentlyDeleted > 0) {
    revalidateAfterInvestChange();
  }

  return NextResponse.json({
    ok: true,
    permanentlyDeleted: result.permanentlyDeleted,
    message: `已彻底删除 ${result.permanentlyDeleted} 条超过 ${days} 天的回收站记录`,
  }, { headers: corsHeaders() });
}