/**
 * API: GET /api/v1/accounts/balances
 *
 * Returns display balances for a requested account id subset.
 * Used by SidebarClient / LiveAccountBalance for partial refresh so a
 * single fund/cash save does not recompute every household account.
 *
 * Query params:
 *   ids (required) - comma-separated account ID list
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { toNumber } from "@/lib/date-utils";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { getMaintainedAccountBalances } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import { isDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { normalizeCurrency } from "@/lib/currency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idsRaw = (url.searchParams.get("ids") ?? "").trim();
  if (!idsRaw) {
    return NextResponse.json({ ok: false, code: "MISSING_IDS", error: "缺少 ids 参数" }, { status: 400 });
  }

  const ids = Array.from(new Set(idsRaw.split(",").map((s) => s.trim()).filter(Boolean)));
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, code: "INVALID_IDS", error: "ids 参数无效" }, { status: 400 });
  }

  try {
    const ctx = await getHouseholdScope();
    const { householdId, hidFilter } = ctx;
    const baseCurrency = await getHouseholdBaseCurrency(householdId);

    const accounts = await prisma.account.findMany({
      where: {
        id: { in: ids },
        ...hidFilter,
      },
      select: {
        id: true,
        balance: true,
        kind: true,
        investProductType: true,
        billingDay: true,
        currency: true,
      },
    });

    const investAccounts = accounts.filter((account) => isPureInvestmentAccount(account));
    const insuranceIds = accounts
      .filter((account) => account.kind === AccountKind.insurance)
      .map((account) => account.id);
    const creditIds = accounts
      .filter((account) => account.kind === AccountKind.bank_credit)
      .map((account) => account.id);
    const hasDebtAccounts = accounts.some(
      (account) => account.kind === AccountKind.loan || account.kind === AccountKind.settlement,
    );
    const cashLikeAccounts = accounts
      .filter((account) => !isPureInvestmentAccount(account))
      .map((account) => ({
        id: account.id,
        kind: account.kind,
        investProductType: account.investProductType,
        billingDay: account.billingDay,
      }));

    const [investBalByAccountId, displayBalanceByAccountId, currentCreditCycles, insuranceDisplayBalanceByAccountId, debtDisplaySummary] = await Promise.all([
      investAccounts.length > 0
        ? computeInvestBalances(ctx, investAccounts.map((account) => account.id))
        : Promise.resolve(new Map<string, { marketValue: number }>()),
      cashLikeAccounts.length > 0
        ? getMaintainedAccountBalances(cashLikeAccounts, hidFilter)
        : Promise.resolve(new Map<string, number>()),
      creditIds.length > 0
        ? prisma.creditCardCycle.findMany({
            where: {
              accountId: { in: creditIds },
              isCurrentCycle: true,
            },
            select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
          })
        : Promise.resolve([] as Array<{
            accountId: string;
            effectiveBill: unknown;
            cumulativeRemain: unknown;
            cumulativeOverpaid: unknown;
          }>),
      insuranceIds.length > 0
        ? computeInsuranceAccountDisplayBalances(insuranceIds, hidFilter)
        : Promise.resolve(new Map<string, number>()),
      hasDebtAccounts ? computeDebtDisplaySummary(ctx) : Promise.resolve({ balanceByAccountId: new Map<string, number>() }),
    ]);
    const currentCreditBalanceByAccountId = new Map(
      currentCreditCycles.map((cycle) => [
        cycle.accountId,
        creditCardDisplayBalanceFromCurrentCycle(cycle),
      ]),
    );

    const enriched = accounts.map((a) => {
      const balance = isPureInvestmentAccount(a)
        ? investBalByAccountId.get(a.id)?.marketValue ?? 0
        : a.kind === AccountKind.insurance
          ? insuranceDisplayBalanceByAccountId.get(a.id) ?? 0
          : a.kind === AccountKind.bank_credit
            ? currentCreditBalanceByAccountId.get(a.id) ?? displayBalanceByAccountId.get(a.id) ?? toNumber(a.balance)
            : a.kind === AccountKind.loan || a.kind === AccountKind.settlement
              ? debtDisplaySummary.balanceByAccountId.get(a.id) ?? displayBalanceByAccountId.get(a.id) ?? toNumber(a.balance)
              : isDepositAccount(a)
                ? displayBalanceByAccountId.get(a.id) ?? toNumber(a.balance)
                : displayBalanceByAccountId.get(a.id) ?? toNumber(a.balance);
      return { ...a, balance };
    });

    const conversion = await convertCurrencyAmounts({
      householdId,
      toCurrency: baseCurrency,
      refreshMissing: false,
      amounts: enriched.map((account) => ({
        amount: Number(account.balance ?? 0),
        currency: account.currency,
      })),
    });
    const rateByCurrency = new Map(conversion.rates.map((rate) => [rate.fromCurrency, rate]));

    const data = enriched.map((a) => {
      const currency = normalizeCurrency(a.currency);
      const rate = rateByCurrency.get(currency);
      const convertedBalance = rate?.rate == null ? null : Number(a.balance ?? 0) * rate.rate;
      return {
        id: a.id,
        balance: Number(a.balance ?? 0),
        kind: a.kind,
        currency,
        convertedBalance,
        baseCurrency,
        fxRate: rate?.rate ?? null,
        fxRateDate: rate?.rateDate ?? null,
        fxRateMissing: rate?.missing ?? false,
      };
    });

    return NextResponse.json({ ok: true, baseCurrency, data });
  } catch (err) {
    console.error("GET /api/v1/accounts/balances error:", err);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "服务器错误" }, { status: 500 });
  }
}
