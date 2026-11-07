/**
 * GET /api/v1/accounts/credit-card-defaults?institutionId=...&groupId=...
 *
 * Returns `{ ok: true, data: { billingDay, repaymentDay, repaymentOffsetDays, creditLimit, creditBillMode, billingDayTxPeriod } | null }`.
 * Values come from the most complete active credit card in the current household,
 * institution and owner group (different owners never share credit-card defaults).
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getCreditCardInstitutionDefaults } from "@/lib/server/credit-card-institution-settings";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const institutionId = params.get("institutionId")?.trim() ?? "";
  const groupId = params.get("groupId")?.trim() || null;
  if (!institutionId) {
    return NextResponse.json({ ok: false, code: "MISSING_INSTITUTION_ID", error: "缺少机构 ID" }, { status: 400 });
  }
  const { householdId } = await getHouseholdScope();
  const data = await getCreditCardInstitutionDefaults(prisma, householdId, institutionId, { groupId });
  return NextResponse.json({ ok: true, data });
}
