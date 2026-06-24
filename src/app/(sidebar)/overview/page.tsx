import { OverviewDashboard } from "@/components/OverviewDashboard";
import { cookies } from "next/headers";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeOverviewSummary } from "@/lib/server/overview-summary";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const ctx = await getHouseholdScope();
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";

  // 总览计算统一走共享函数（src/lib/server/overview-summary.ts），
  // 与 GET /api/v1/overview/summary 共用同一数据源，保证金额一致。
  const summary = await computeOverviewSummary(ctx, creditCardLabelMode);

  return (
    <OverviewDashboard
      netWorth={summary.netWorth}
      accountTypeTotals={summary.accountTypeTotals}
      assetDistribution={summary.dailyAssetDistribution}
      monthIncome={summary.monthIncome}
      monthExpense={summary.monthExpense}
      accountList={summary.dailyAccountList}
      creditAccountList={summary.creditAccountList}
      debtAccountList={summary.debtAccountList}
      topPositions={summary.topPositions}
      investmentMarketValue={summary.investmentMarketValue}
      investmentCost={summary.investmentCost}
      investmentFloatingPnL={summary.investmentFloatingPnL}
      investmentFloatingPnLRate={summary.investmentFloatingPnLRate}
      isRedUp={isRedUp}
    />
  );
}
