import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

/**
 * 修改交易明细
 * PUT /api/v1/fund/entry
 * Body: { id, date?, fundConfirmDate?, fundArrivalDate?, ...其他字段 }
 *
 * 特殊逻辑：
 * - 如果修改了申请日期(date)，自动重新计算确认日期(fundConfirmDate)和入账日期(fundArrivalDate)
 * - 如果修改了确认日期(fundConfirmDate)，自动重新计算入账日期(fundArrivalDate)
 * - 如果直接指定了入账日期(fundArrivalDate)，不做自动计算
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json();
    const { id, date, fundConfirmDate, fundArrivalDate, autoCalcConfirmDate } = body;

    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }

    const entry = await prisma.txRecord.findUnique({
      where: { id },
      include: { toAccount: true },
    });

    if (!entry) {
      return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });
    }

    if (entry.householdId && entry.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "记录不属于当前账簿" }, { status: 403 });
    }

    const updateData: any = {};

    // 如果修改了申请日期
    if (date) {
      updateData.date = new Date(date);

      // 自动计算确认日期
      if (autoCalcConfirmDate !== false) {
        const confirmDays = entry.fundCode && entry.toAccountId
          ? await getFundConfirmDays(entry.toAccountId, entry.fundCode)
          : 1;
        const dateStr = new Date(date).toISOString().slice(0, 10);
        const newConfirmDateStr = addWorkdaysUtc(dateStr, confirmDays);
        updateData.fundConfirmDate = new Date(`${newConfirmDateStr}T00:00:00.000Z`);
      }
    }

    // 确认日期由前端传入
    if (fundConfirmDate && !date) {
      updateData.fundConfirmDate = new Date(fundConfirmDate);
    }

    // 到账日期由前端传入（手工填写或由 arrivalDays 推算）
    if (fundArrivalDate) {
      updateData.fundArrivalDate = new Date(fundArrivalDate);
    }

    // 更新记录
    const updated = await prisma.txRecord.update({
      where: { id },
      data: updateData,
    });

    // 重新计算持仓 — 区分买入/赎回确定投资账户ID
    // 买入类：accountId=资金账户, toAccountId=投资账户
    // 赠回类：accountId=投资账户, toAccountId=资金账户
    const isRedeemLike = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
    const investmentAccId = isRedeemLike ? entry.accountId : entry.toAccountId;
    if (investmentAccId && entry.fundCode) {
      await recalcFundPositions(investmentAccId, [entry.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));
    }

    // 刷新涉及的账户余额
    const accountsToRecalc = new Set<string>();
    if (entry.accountId) accountsToRecalc.add(entry.accountId);
    if (entry.toAccountId) accountsToRecalc.add(entry.toAccountId);
    if (updated.accountId) accountsToRecalc.add(updated.accountId);
    if (updated.toAccountId) accountsToRecalc.add(updated.toAccountId);
    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    revalidateAfterInvestChange();

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, entry: updated });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "修改失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }

    const entry = await prisma.txRecord.findUnique({
      where: { id },
    });

    if (!entry) {
      return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });
    }

    if (entry.householdId && entry.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "记录不属于当前账簿" }, { status: 403 });
    }

    // 区分买入/赎回确定投资账户ID
    const isRedeemLike = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
    const investmentAccId = isRedeemLike ? entry.accountId : entry.toAccountId;
    const fundCode = entry.fundCode;

    // 软删除 TxRecord
    await prisma.txRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    if (investmentAccId && fundCode) {
      await recalcFundPositions(investmentAccId, [fundCode]).catch(logger.catchLog("操作失败", "route.ts"));
    }

    // 刷新涉及的账户余额
    const accountsToRecalc = new Set<string>();
    if (entry.accountId) accountsToRecalc.add(entry.accountId);
    if (entry.toAccountId) accountsToRecalc.add(entry.toAccountId);
    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    revalidateAfterInvestChange();

    // Client-side handles page refresh
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}
