import { NextRequest, NextResponse } from "next/server";
import { FundCashFlowKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { ensureFundTransactionCashFlowLinks, findFundTransactionForEntryId } from "@/lib/fund/transactions";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { addWorkdaysUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

function cashFlowDateForKind(kind: FundCashFlowKind, applyDate?: Date, arrivalDate?: Date | null) {
  if (kind === FundCashFlowKind.buy_out || kind === FundCashFlowKind.switch_in) return applyDate;
  if (
    kind === FundCashFlowKind.redeem_in ||
    kind === FundCashFlowKind.refund_in ||
    kind === FundCashFlowKind.dividend_in ||
    kind === FundCashFlowKind.switch_out
  ) {
    return arrivalDate ?? undefined;
  }
  return undefined;
}

/**
 * 修改交易明细
 * PUT /api/v1/fund/entry
 * Body: { id, date?, fundConfirmDate?, fundArrivalDate?, ...其他字段 }
 * id 可以是 FundTransaction.id，也可以是关联资金 TxRecord.id；服务端会解析到基金业务交易。
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

    const entry = await findFundTransactionForEntryId(prisma, { id, householdId });

    if (!entry || entry.deletedAt) {
      return NextResponse.json({ ok: false, error: "基金交易记录不存在" }, { status: 404 });
    }

    const updateData: any = {};
    let nextApplyDate: Date | undefined;
    let nextArrivalDate: Date | null | undefined;

    // 如果修改了申请日期
    if (date) {
      nextApplyDate = new Date(date);
      updateData.applyDate = nextApplyDate;

      // 自动计算确认日期
      if (autoCalcConfirmDate !== false) {
        const confirmDays = await getFundConfirmDays(entry.fundAccountId, entry.fundCode);
        const dateStr = new Date(date).toISOString().slice(0, 10);
        const newConfirmDateStr = addWorkdaysUtc(dateStr, confirmDays);
        updateData.confirmDate = new Date(`${newConfirmDateStr}T00:00:00.000Z`);
      }
    }

    // 确认日期由前端传入
    if (fundConfirmDate && !date) {
      updateData.confirmDate = new Date(fundConfirmDate);
    }

    // 到账日期由前端传入（手工填写或由 arrivalDays 推算）
    if (fundArrivalDate) {
      nextArrivalDate = new Date(fundArrivalDate);
      updateData.arrivalDate = nextArrivalDate;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.fundTransaction.update({
        where: { id: entry.id },
        data: updateData,
      });

      const flows = await tx.fundTransactionCashFlow.findMany({
        where: { fundTransactionId: entry.id },
      });
      for (const flow of flows) {
        const flowDate = cashFlowDateForKind(flow.kind, nextApplyDate, nextArrivalDate);
        if (!flowDate) continue;
        await tx.fundTransactionCashFlow.update({
          where: { id: flow.id },
          data: { flowDate },
        });
        await tx.txRecord.update({
          where: { id: flow.txRecordId },
          data: { date: flowDate },
        }).catch(() => undefined);
      }

      await ensureFundTransactionCashFlowLinks(tx, [entry.id]);
      return row;
    });

    await recalcFundPositions(entry.fundAccountId, [entry.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));

    // 刷新涉及的账户余额
    const accountsToRecalc = new Set<string>();
    if (entry.fundAccountId) accountsToRecalc.add(entry.fundAccountId);
    if (entry.cashAccountId) accountsToRecalc.add(entry.cashAccountId);
    if (updated.fundAccountId) accountsToRecalc.add(updated.fundAccountId);
    if (updated.cashAccountId) accountsToRecalc.add(updated.cashAccountId);
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

    const entry = await findFundTransactionForEntryId(prisma, { id, householdId });

    if (!entry || entry.deletedAt) {
      return NextResponse.json({ ok: false, error: "基金交易记录不存在" }, { status: 404 });
    }

    const deletedAt = new Date();
    const flowRows = await prisma.fundTransactionCashFlow.findMany({
      where: { fundTransactionId: entry.id },
    });
    const cashEntryIds = Array.from(new Set([
      entry.cashEntryId,
      ...flowRows.map((flow) => flow.txRecordId),
    ].filter((value): value is string => Boolean(value))));

    await prisma.$transaction(async (tx) => {
      await tx.fundTransaction.update({
        where: { id: entry.id },
        data: { deletedAt },
      });
      if (cashEntryIds.length > 0) {
        await tx.txRecord.updateMany({
          where: { id: { in: cashEntryIds }, householdId },
          data: { deletedAt },
        });
      }
      await tx.entryBusinessLink.updateMany({
        where: { householdId, fundTransactionId: entry.id, deletedAt: null },
        data: { deletedAt },
      });
    });

    await recalcFundPositions(entry.fundAccountId, [entry.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));

    // 刷新涉及的账户余额
    const accountsToRecalc = new Set<string>();
    if (entry.fundAccountId) accountsToRecalc.add(entry.fundAccountId);
    if (entry.cashAccountId) accountsToRecalc.add(entry.cashAccountId);
    for (const flow of flowRows) {
      if (flow.accountId) accountsToRecalc.add(flow.accountId);
    }
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
