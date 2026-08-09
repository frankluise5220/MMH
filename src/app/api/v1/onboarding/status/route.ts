/**
 * API: GET /api/v1/onboarding/status
 *
 * Returns first-use setup progress for the current ledger.
 *
 * Response:
 * {
 *   ok: true,
 *   data: {
 *     householdId: string;
 *     householdName: string;
 *     defaultOwnerName: string | null;
 *     familyMemberCount: number;
 *     accountCount: number;
 *     cashLikeAccountCount: number;
 *     cashAccountCount: number;
 *     debitAccountCount: number;
 *     creditAccountCount: number;
 *     investmentAccountCount: number;
 *     insuranceAccountCount: number;
 *     settlementAccountCount: number;
 *     initializationEntryCount: number;
 *     transactionCount: number;      // non-initialization, non-deleted entries
 *     fundHoldingCount: number;
 *     regularInvestPlanCount: number;
 *     shouldShowGuide: boolean;
 *   }
 * }
 *
 * Error response: { ok: false, error }
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { BALANCE_INITIALIZATION_SOURCE } from "@/lib/balance-reconcile";

const CASH_LIKE_KINDS = ["cash", "bank_debit", "ewallet"] as const;

export async function GET() {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
    const [household, defaultOwner, familyMemberCount, accounts] = await Promise.all([
      prisma.household.findUnique({ where: { id: householdId }, select: { name: true } }),
      prisma.accountGroup.findFirst({
        where: { householdId },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { name: true },
      }),
      prisma.institution.count({ where: { ...hidFilter, type: "family_member" } }),
      prisma.account.findMany({
        where: {
          ...hidFilter,
          isActive: true,
          isPlaceholder: false,
        },
        select: {
          id: true,
          kind: true,
          investProductType: true,
        },
      }),
    ]);
    const investmentAccountIds = accounts
      .filter((account) => account.kind === "investment")
      .map((account) => account.id);

    const [
      initializationEntryCount,
      transactionCount,
      regularInvestPlanCount,
    ] = await prisma.$transaction([
      prisma.txRecord.count({
        where: {
          ...hidFilter,
          deletedAt: null,
          source: BALANCE_INITIALIZATION_SOURCE,
        },
      }),
      prisma.txRecord.count({
        where: {
          ...hidFilter,
          deletedAt: null,
          OR: [
            { source: null },
            { source: { not: BALANCE_INITIALIZATION_SOURCE } },
          ],
        },
      }),
      prisma.regularInvestPlan.count({
        where: { householdId },
      }),
    ]);
    const fundHoldingCount = investmentAccountIds.length > 0
      ? await prisma.fundHolding.count({
          where: {
            accountId: { in: investmentAccountIds },
            units: { gt: 0 },
          },
        })
      : 0;

    const hasAnyUserData =
      initializationEntryCount > 0 ||
      transactionCount > 0 ||
      fundHoldingCount > 0 ||
      regularInvestPlanCount > 0;

    return NextResponse.json({
      ok: true,
      data: {
        householdId,
        householdName: household?.name ?? "",
        defaultOwnerName: defaultOwner?.name ?? null,
        familyMemberCount,
        accountCount: accounts.length,
        cashLikeAccountCount: accounts.filter((account) => CASH_LIKE_KINDS.includes(account.kind as typeof CASH_LIKE_KINDS[number])).length,
        cashAccountCount: accounts.filter((account) => account.kind === "cash").length,
        debitAccountCount: accounts.filter((account) => account.kind === "bank_debit").length,
        creditAccountCount: accounts.filter((account) => account.kind === "bank_credit").length,
        investmentAccountCount: investmentAccountIds.length,
        insuranceAccountCount: accounts.filter((account) => account.kind === "insurance").length,
        settlementAccountCount: accounts.filter((account) => account.kind === "loan").length,
        initializationEntryCount,
        transactionCount,
        fundHoldingCount,
        regularInvestPlanCount,
        shouldShowGuide: !hasAnyUserData,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "无法获取首次使用状态" },
      { status: 500 },
    );
  }
}
