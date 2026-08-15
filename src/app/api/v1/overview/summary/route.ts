import { NextRequest, NextResponse } from "next/server";

import { computeOverviewSummary } from "@/lib/server/overview-summary";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { DISPLAY_LANGUAGE_COOKIE } from "@/lib/server/i18n";

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
 *     netWorth: number,              // dailyNetWorth + investmentMarketValue + insuranceAsset
 *     dailyNetWorth: number,
 *     investmentMarketValue: number,
 *     investmentCost: number,
 *     investmentFloatingPnL: number,
 *     investmentFloatingPnLRate: number,
 *     investmentAccountCount: number,
 *     insuranceAsset: number,
 *     insuranceAccountCount: number,
 *     topPositions: [{ accountId, name, marketValue, floatingPnL, floatingPnLRate }],
 *     monthIncome: number,
 *     monthExpense: number,
 *     dailyAssetDistribution: [{ kind, label, value, pct }],
 *     dailyAccountList: [{ id, name, kind, balance, groupName, institutionName }],
 *     debtAccountList: [{ id, name, kind, balance, groupName, institutionName }],
 *     creditAccountList: [{          // consolidated credit cards are returned once per bill storage group
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
 * Response 500: { ok: false, code: string, error: string }
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const raw = req.cookies.get(DISPLAY_LANGUAGE_COOKIE)?.value;
    const language = raw === "en-US" || raw === "ja-JP" ? raw : "zh-CN";
    const data = await computeOverviewSummary(ctx, undefined, language);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read overview summary";
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: message }, { status: 500 });
  }
}
