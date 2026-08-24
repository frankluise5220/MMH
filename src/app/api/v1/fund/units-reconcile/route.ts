/**
 * POST /api/v1/fund/units-reconcile
 *
 * Creates a fund-side units reconciliation transaction without a cash flow.
 * Body: { accountId, fundCode, date, actualUnits, fundName?, note? }
 * Success: { ok: true, data: { entryId?, currentUnits, actualUnits, deltaUnits, noChange } }
 */
import { NextRequest, NextResponse } from "next/server";
import { FundSubtype } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { createFundTransactionWithCashFlows } from "@/lib/fund/transactions";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import {
  ENTRY_ORIGIN_MANUAL,
  TRANSACTION_SOURCE_FUND_UNITS_RECONCILE,
} from "@/lib/transaction-semantics";
import { toNumber } from "@/lib/date-utils";

function parseBusinessDate(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUnits(value: unknown) {
  const numberValue = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

function usefulFundName(value: unknown, fundCode: string) {
  const name = typeof value === "string" ? value.trim() : "";
  return name && name !== fundCode ? name : null;
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
    const fundCode = typeof body.fundCode === "string" ? body.fundCode.trim() : "";
    const date = parseBusinessDate(body.date);
    const actualUnitsInput = parseUnits(body.actualUnits);
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

    if (!accountId) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_ID_REQUIRED", error: "accountId is required" }, { status: 400 });
    }
    if (!fundCode) {
      return NextResponse.json({ ok: false, code: "FUND_CODE_REQUIRED", error: "fundCode is required" }, { status: 400 });
    }
    if (!date) {
      return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
    if (actualUnitsInput == null) {
      return NextResponse.json({ ok: false, code: "INVALID_UNITS", error: "actualUnits must be a non-negative number" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, ...ctx.hidFilter },
      select: {
        id: true,
        kind: true,
        investProductType: true,
        fundUnitsDecimals: true,
      },
    });
    if (!account || account.kind !== "investment") {
      return NextResponse.json({ ok: false, code: "FUND_ACCOUNT_NOT_FOUND", error: "fund account not found" }, { status: 404 });
    }
    if (["wealth", "deposit", "metal", "stock", "property"].includes(account.investProductType ?? "")) {
      return NextResponse.json({ ok: false, code: "UNSUPPORTED_ACCOUNT_TYPE", error: "account does not support fund units reconciliation" }, { status: 400 });
    }

    const fundUnitsDecimals = normalizeFundUnitsDecimals(account.fundUnitsDecimals, 2);
    await recalcFundPositions(accountId, [fundCode]);

    const holding = await prisma.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode } },
      select: { units: true, fundName: true },
    });
    const currentUnits = roundFundUnits(toNumber(holding?.units ?? 0), fundUnitsDecimals);
    const actualUnits = roundFundUnits(actualUnitsInput, fundUnitsDecimals);
    const deltaUnits = roundFundUnits(actualUnits - currentUnits, fundUnitsDecimals);

    if (deltaUnits === 0) {
      return NextResponse.json({
        ok: true,
        data: {
          entryId: null,
          currentUnits,
          actualUnits,
          deltaUnits,
          noChange: true,
        },
      });
    }

    const latestNameRows = await Promise.all([
      prisma.fundNavCache.findFirst({
        where: { fundCode },
        orderBy: { navDate: "desc" },
        select: { name: true },
      }),
      prisma.fundTransaction.findFirst({
        where: { fundAccountId: accountId, fundCode, deletedAt: null },
        orderBy: [{ applyDate: "desc" }, { createdAt: "desc" }],
        select: { fundName: true },
      }),
    ]);
    const fundName =
      usefulFundName(body.fundName, fundCode) ??
      usefulFundName(holding?.fundName, fundCode) ??
      usefulFundName(latestNameRows[0]?.name, fundCode) ??
      usefulFundName(latestNameRows[1]?.fundName, fundCode);
    const isIncrease = deltaUnits > 0;
    const absoluteDelta = Math.abs(deltaUnits);

    const created = await prisma.$transaction((tx) =>
      createFundTransactionWithCashFlows(tx, {
        householdId: ctx.householdId,
        fundAccountId: accountId,
        cashAccountId: null,
        fundCode,
        fundName,
        fundProductType: account.investProductType === "money" ? "money" : "fund",
        fundSubtype: isIncrease ? FundSubtype.buy : FundSubtype.redeem,
        source: TRANSACTION_SOURCE_FUND_UNITS_RECONCILE,
        entryOrigin: ENTRY_ORIGIN_MANUAL,
        applyDate: date,
        confirmDate: date,
        arrivalDate: null,
        grossAmount: 0,
        arrivalAmount: isIncrease ? null : 0,
        fee: null,
        nav: null,
        units: absoluteDelta,
        realizedProfit: isIncrease ? null : 0,
        note,
        cashFlows: [],
      }),
    );

    await recalcFundPositions(accountId, [fundCode]);
    await recalcAndSaveAccountBalance(accountId);
    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      data: {
        entryId: created.fundTransaction.id,
        currentUnits,
        actualUnits,
        deltaUnits,
        noChange: false,
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: "FUND_UNITS_RECONCILE_FAILED",
      error: error instanceof Error ? error.message : "fund units reconciliation failed",
    }, { status: 500 });
  }
}
