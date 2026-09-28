import { NextResponse } from "next/server";

import { loadDepositLotOptions } from "@/lib/server/deposit-lot-options";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * GET /api/v1/deposit/lots
 * Query: accountIds (optional comma-separated IDs), includeClosed (optional "1"), excludeEntryId (optional entry ID).
 * Response: { ok: true, lots } or { ok: false, code, error }.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    const url = new URL(req.url);
    const accountIds = (url.searchParams.get("accountIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const lots = await loadDepositLotOptions({
      householdId: ctx.householdId,
      accountIds,
      includeClosed: url.searchParams.get("includeClosed") === "1",
      excludeEntryId: url.searchParams.get("excludeEntryId"),
    });
    return NextResponse.json({ ok: true, lots });
  } catch (error) {
    console.error("[deposit/lots] Failed to load deposit lots", error);
    return NextResponse.json(
      { ok: false, code: "DEPOSIT_LOTS_FETCH_FAILED", error: "Failed to load deposit lots" },
      { status: 500 },
    );
  }
}
