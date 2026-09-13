import { NextResponse } from "next/server";

import { autoProcessMaturedDeposits } from "@/lib/server/deposit-auto-maturity";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * POST /api/v1/deposit/auto-maturity
 *
 * Runs deposit maturity auto-processing for the current household:
 * matured lots are redeemed or renewed according to their stored maturity
 * action. Called from the app-open startup check (DailyTaskCheck) — the same
 * trigger model as scheduled-task auto-execution; no OS background task.
 */
export async function POST() {
  try {
    const { householdId } = await getHouseholdScope();
    const result = await autoProcessMaturedDeposits(householdId, new Date());
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "DEPOSIT_AUTO_MATURITY_FAILED", error: e instanceof Error ? e.message : "执行失败" },
      { status: 500 },
    );
  }
}
