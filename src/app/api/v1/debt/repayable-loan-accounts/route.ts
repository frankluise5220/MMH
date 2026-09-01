/**
 * GET /api/v1/debt/repayable-loan-accounts
 *
 * Returns institution loan accounts that still have payable principal on the
 * requested repayment date.
 *
 * Query params:
 * - date (required): YYYY-MM-DD repayment date.
 * - excludeEntryId (optional): repayment entry excluded while editing, so the
 *   original payment does not hide the loan account from the dropdown.
 *
 * Response:
 * - { ok: true, data: [{ accountId, balance }] }
 *   balance uses the debt account display sign; negative means payable debt.
 */
import { AccountKind } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { parseDateInputToUtc } from "@/lib/date-utils";
import { ACTIVE_DEBT_EPSILON } from "@/lib/server/debt-view-data";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeLoanPrincipalBalancesAsOf } from "@/lib/server/account-balance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const dateText = (url.searchParams.get("date") ?? "").trim();
  const excludeEntryId = (url.searchParams.get("excludeEntryId") ?? "").trim();
  const asOfDate = parseDateInputToUtc(dateText);
  if (!asOfDate) {
    return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "Invalid repayment date" }, { status: 400 });
  }

  try {
    const { hidFilter } = await getHouseholdScope();
    const accounts = await prisma.account.findMany({
      where: {
        ...hidFilter,
        kind: AccountKind.loan,
        isActive: true,
        isPlaceholder: { not: true },
        counterpartyId: null,
        institutionId: { not: null },
      },
      select: {
        id: true,
        kind: true,
        investProductType: true,
        billingDay: true,
      },
    });
    const balanceByAccountId = await computeLoanPrincipalBalancesAsOf(accounts, hidFilter, asOfDate, {
      excludeEntryId: excludeEntryId || null,
    });
    const data = accounts
      .map((account) => ({ accountId: account.id, balance: balanceByAccountId.get(account.id) ?? 0 }))
      .filter((row) => row.balance < -ACTIVE_DEBT_EPSILON)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("GET /api/v1/debt/repayable-loan-accounts error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Internal server error" }, { status: 500 });
  }
}
