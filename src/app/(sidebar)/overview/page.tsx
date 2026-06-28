import { cookies } from "next/headers";

import { OverviewDashboard } from "@/components/OverviewDashboard";
import { normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeOverviewSummary } from "@/lib/server/overview-summary";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const ctx = await getHouseholdScope();
  const cookieStore = await cookies();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const summary = await computeOverviewSummary(ctx, creditCardLabelTemplate);

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
