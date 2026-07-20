import { NextResponse } from "next/server";

import { computeOverviewSummary } from "@/lib/server/overview-summary";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/overview/summary
 *
 * Dashboard summary for daily accounts, credit cards, and compact investment overview.
 *
 * Response 200:
 * {
 *   ok: true,
 *   data: {
 *     netWorth: number,              // dailyNetWorth + investmentMarketValue
 *     dailyNetWorth: number,
 *     investmentMarketValue: number,
 *     investmentCost: number,
 *     investmentFloatingPnL: number,
 *     investmentFloatingPnLRate: number,
 *     topPositions: [{ accountId, name, marketValue, floatingPnL, floatingPnLRate }],
 *     monthIncome: number,
 *     monthExpense: number,
 *     dailyAssetDistribution: [{ kind, label, value, pct }],
 *     dailyAccountList: [{ id, name, kind, balance, groupName, institutionName }],
 *     debtAccountList: [{ id, name, kind, balance, groupName, institutionName }],
 *     creditAccountList: [{
 *       id, name, kind, balance, groupName, institutionName,
 *       creditLimit, availableLimit, billingDay, repaymentDay, creditBillMode,
 *       currentAmount, currentBill, paid, remain, dueDate
 *     }],
 *     creditUsedTotal: number,
 *     creditLimitTotal: number,
 *     creditAvailableTotal: number,
 *     creditCurrentAmountTotal: number,
 *     creditCurrentBillTotal: number
 *   }
 * }
 *
 * Backward-compatible aliases are also returned: netWorth, assetDistribution, accountList,
 * floatingPnL, totalCost, topPositions.
 *
 * Response 500: { ok: false, error: string }
 */
export async function GET() {
  try {
    const ctx = await getHouseholdScope();
    const data = await computeOverviewSummary(ctx);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "总览数据读取失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
