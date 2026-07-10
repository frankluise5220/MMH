import { NextResponse } from "next/server";
import { AccountKind, FundProductType, FundSubtype, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { addWorkdaysUtc, toNumber } from "@/lib/date-utils";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getFundNav } from "@/lib/fund/navCache";
import { calculateConfirmedBuyUnits, allocateBuyFailedRefunds } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { logger } from "@/lib/logger";

/**
 * POST /api/v1/fund/refresh-pending
 *
 * Scans the active household for fund buy rows whose confirmation date has arrived
 * but NAV or confirmed units are still missing. It fills NAV, fee, and units using
 * the canonical buy-refund rule: gross buy amount - linked refund amount - fee.
 * Response shape: { ok: true, checked, filled, navFilled, skippedFuture, skippedNoNav, failed }.
 */
function utcDate(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function isFundLikeProduct(value: unknown) {
  return value == null || value === FundProductType.fund || value === FundProductType.money;
}

export async function POST() {
  try {
    const { householdId } = await getHouseholdScope();
    const todayStr = ymd(new Date());

    const candidateRows = await prisma.txRecord.findMany({
      where: {
        householdId,
        deletedAt: null,
        type: TransactionType.investment,
        fundCode: { not: null },
        OR: [
          { fundProductType: null },
          { fundProductType: { in: [FundProductType.fund, FundProductType.money] } },
        ],
        AND: [
          {
            OR: [
              { fundSubtype: FundSubtype.buy },
              { fundSubtype: null, amount: { lt: 0 } },
            ],
          },
          {
            OR: [
              { fundNav: null },
              { fundUnits: null },
              { fundUnits: { lte: 0 } },
            ],
          },
        ],
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });

    if (candidateRows.length === 0) {
      return NextResponse.json({ ok: true, checked: 0, filled: 0, navFilled: 0, skippedFuture: 0, skippedNoNav: 0, failed: 0 });
    }

    const fundAccountIds = Array.from(new Set(candidateRows.map((row) => row.toAccountId ?? row.accountId).filter(Boolean) as string[]));
    const accounts = await prisma.account.findMany({
      where: { id: { in: fundAccountIds }, householdId, kind: AccountKind.investment },
      select: { id: true, investProductType: true, fundUnitsDecimals: true },
    });
    const accountById = new Map(accounts.filter((account) => isFundLikeProduct(account.investProductType)).map((account) => [account.id, account]));

    const matchRows = await prisma.txRecord.findMany({
      where: {
        householdId,
        deletedAt: null,
        fundCode: { not: null },
        OR: [
          { toAccountId: { in: fundAccountIds } },
          { accountId: { in: fundAccountIds } },
        ],
      },
      select: {
        id: true,
        date: true,
        createdAt: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
        accountId: true,
        toAccountId: true,
        fundCode: true,
        fundSubtype: true,
        source: true,
        amount: true,
        fundSourceEntryId: true,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    });
    const { refundAmountByBuyId } = allocateBuyFailedRefunds(matchRows.map((entry) => ({
      id: entry.id,
      date: entry.date,
      createdAt: entry.createdAt,
      fundConfirmDate: entry.fundConfirmDate,
      fundArrivalDate: entry.fundArrivalDate,
      accountId: entry.accountId,
      toAccountId: entry.toAccountId,
      fundCode: entry.fundCode,
      fundSubtype: entry.fundSubtype,
      source: entry.source,
      amount: toNumber(entry.amount),
      fundSourceEntryId: entry.fundSourceEntryId,
    })));

    let filled = 0;
    let navFilled = 0;
    let skippedFuture = 0;
    let skippedNoNav = 0;
    let failed = 0;
    const changedEntryIds: string[] = [];
    const recalcByAccount = new Map<string, Set<string>>();

    for (const row of candidateRows) {
      const fundAccountId = row.toAccountId ?? row.accountId;
      if (!fundAccountId || !row.fundCode) continue;
      const account = accountById.get(fundAccountId);
      if (!account) continue;

      try {
        const applyDate = ymd(row.date);
        const confirmDateStr = row.fundConfirmDate
          ? ymd(row.fundConfirmDate)
          : addWorkdaysUtc(applyDate, await getFundConfirmDays(fundAccountId, row.fundCode));
        if (confirmDateStr > todayStr) {
          skippedFuture++;
          continue;
        }

        const confirmDate = utcDate(confirmDateStr);
        const navData = await getFundNav(row.fundCode, confirmDate, fundAccountId);
        if (!navData || !navData.dateMatch || !(navData.nav > 0)) {
          skippedNoNav++;
          continue;
        }

        const grossAmount = Math.abs(toNumber(row.amount));
        const refundAmount = refundAmountByBuyId.get(row.id) ?? 0;
        const confirmedAmount = Math.max(0, grossAmount - refundAmount);
        const fee = row.fundFee != null
          ? Math.max(0, toNumber(row.fundFee))
          : Math.max(0, confirmedAmount * ((await getFundFeeRateByDate(fundAccountId, row.fundCode, confirmDate, "buy")) / 100));
        const fundUnitsDecimals = normalizeFundUnitsDecimals(account.fundUnitsDecimals);
        const units = calculateConfirmedBuyUnits({
          grossAmount,
          refundAmount,
          fee,
          nav: navData.nav,
          roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
        });

        if (units == null || !Number.isFinite(units) || units <= 0) {
          skippedNoNav++;
          continue;
        }

        await prisma.txRecord.update({
          where: { id: row.id },
          data: {
            fundConfirmDate: confirmDate,
            fundNav: navData.nav,
            fundUnits: units,
            fundFee: fee,
            fundSubtype: row.fundSubtype ?? FundSubtype.buy,
            ...(navData.name ? { fundName: navData.name } : {}),
          },
        });
        changedEntryIds.push(row.id);
        filled++;
        navFilled++;
        if (!recalcByAccount.has(fundAccountId)) recalcByAccount.set(fundAccountId, new Set());
        recalcByAccount.get(fundAccountId)?.add(row.fundCode);
      } catch (error) {
        failed++;
        logger.warn(error instanceof Error ? error.message : String(error), "fund/refresh-pending");
      }
    }

    if (changedEntryIds.length > 0) {
      await syncFundTransactionsFromTxRecords(changedEntryIds);
      for (const [accountId, codes] of recalcByAccount) {
        await recalcFundPositions(accountId, Array.from(codes)).catch(logger.catchLog("recalc", "fund/refresh-pending"));
        await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("balance", "fund/refresh-pending"));
      }
      revalidateAfterInvestChange();
    }

    return NextResponse.json({
      ok: true,
      checked: candidateRows.length,
      filled,
      navFilled,
      skippedFuture,
      skippedNoNav,
      failed,
      entryIds: changedEntryIds,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "刷新未确认基金记录失败" }, { status: 500 });
  }
}
