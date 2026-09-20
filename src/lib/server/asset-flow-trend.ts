/**
 * Month-end asset level snapshots for the fund flow statistics table
 * (资金统计表) on the /statistics page.
 *
 * For every requested month this module rebuilds the household's NET asset
 * value as of month end, in two valuation bases:
 *   - netAssetCost:        investments and FIXED ASSETS counted at cost basis
 *   - netAssetMarketValue: the same aggregate with fixed assets at their latest
 *                          dated valuation and investments at best-available
 *                          month-end market value (fund NAV history, stock
 *                          price cache, property valuations; wealth/metal fall
 *                          back to cost / last traded price when no historical
 *                          price exists)
 *
 * Net = assets − liabilities, aligned with the overview net-worth card:
 *   assets:     cash / bank_debit / ewallet / deposit (incl. legacy) / other /
 *               insurance CASH VALUE (premiums paid − refunds, balance-metric
 *               products only), loan+settlement receivables, investments
 *               (fund/money via the portfolio trend simulation, wealth
 *               principal with dated manual NAV, metal units + last traded
 *               price, stock positions + price cache + brokerage cash),
 *               fixed assets (existence window + valuation history)
 *   liabilities: credit-card debt (raw ledger walk) and loan/往来 payables
 *               (negative walked balances) — credit history is a raw-ledger
 *               approximation, the cycle cache is current-only.
 *
 * All amounts are converted into the household base currency using the
 * latest stored FX rates (same basis as the overview net worth), except the
 * fund portfolio trend which is aggregated raw (same basis as the existing
 * fund trend chart).
 */

import { AccountKind, FundSubtype, StockTransactionAction, TransactionType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { applyBalanceReconcileEntry, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { getDetailEntryDisplayDate, compareDetailEntriesAsc } from "@/lib/detail-entry-order";
import { debtPrincipalForAccountSide } from "@/lib/debt";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import { isLegacyDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { isInsuranceBalanceMetric } from "@/lib/insurance/display";
import { insuranceCashValueDelta } from "@/lib/insurance/transaction";
import {
  isWealthHoldingCleared,
  resetWealthHoldingBucket,
} from "@/lib/invest-balance";
import { loadFundPortfolioTrendData, type FundTrendPoint } from "@/lib/server/fund-portfolio-trend";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { normalizeCurrency } from "@/lib/currency";

export type AssetFlowMonthEndLevel = {
  netAssetCost: number;
  netAssetMarketValue: number;
  /** Insurance cash value included in both net totals. */
  insurance: number;
  /** Fixed-asset cost included in netAssetCost. */
  propertyCost: number;
  /** Fixed-asset market value included in netAssetMarketValue. */
  propertyMarket: number;
  /** 往来款 (settlement) net: receivables positive, payables negative. Loans are not included. */
  settlement: number;
};

export type AssetFlowMonthEndLevels = Map<string, AssetFlowMonthEndLevel>;

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthEndDayKey(month: string) {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

function currentMonth() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Last value in an ascending day-key series on or before `dayKey`. */
function lastValueOnOrBefore(
  series: Array<{ dayKey: string; value: number }>,
  dayKey: string,
  includeZero = false,
): number | null {
  let found: number | null = null;
  for (const point of series) {
    if (point.dayKey > dayKey) break;
    if (point.value > 0 || (includeZero && point.value >= 0)) found = point.value;
  }
  return found;
}

type Boundary = { month: string; dayKey: string };

/**
 * Snapshot helper for ascending-dated event walks: closes every boundary
 * strictly earlier than the current event's day key, so snapshots always
 * reflect "all events with display date <= boundary day".
 */
function makeBoundaryWalker(boundaries: Boundary[]) {
  let boundaryIndex = 0;
  return {
    flushBefore(dayKey: string, capture: (boundaryIndex: number) => void) {
      while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]!.dayKey < dayKey) {
        capture(boundaryIndex);
        boundaryIndex += 1;
      }
    },
    flushRest(capture: (boundaryIndex: number) => void) {
      while (boundaryIndex < boundaries.length) {
        capture(boundaryIndex);
        boundaryIndex += 1;
      }
    },
  };
}

export async function loadAssetMonthEndLevels(
  ctx: HouseholdContext,
  options: {
    /** Display months YYYY-MM (any order). Months in the future are dropped. */
    months?: string[];
    /** Optional pre-loaded fund portfolio trend points (from the page RSC prefetch). */
    fundPoints?: FundTrendPoint[];
  } = {},
): Promise<AssetFlowMonthEndLevels> {
  const nowMonth = currentMonth();
  const seen = new Set<string>();
  const months: string[] = [];
  for (const raw of options.months ?? []) {
    if (!/^\d{4}-\d{2}$/.test(raw)) continue;
    if (raw > nowMonth || seen.has(raw)) continue;
    seen.add(raw);
    months.push(raw);
  }
  months.sort();
  const result: AssetFlowMonthEndLevels = new Map();
  if (months.length === 0) return result;

  const boundaries: Boundary[] = months.map((month) => ({ month, dayKey: monthEndDayKey(month) }));

  // ── Accounts ──────────────────────────────────────────────────────────────
  const accounts = await prisma.account.findMany({
    where: { ...ctx.hidFilter, isActive: true, isPlaceholder: { not: true } },
    select: { id: true, kind: true, currency: true, investProductType: true },
  });

  const plainAccounts = accounts.filter((account) =>
    account.kind === AccountKind.cash ||
    account.kind === AccountKind.bank_debit ||
    account.kind === AccountKind.ewallet ||
    account.kind === AccountKind.other,
  );
  // Credit-card debt is reconstructed from billing cycles (cumulativeRemain
  // per statement month) — the app-native ledger that also feeds the overview.
  // The raw TxRecord walk is unreliable for consolidated-billing groups where
  // member cards share one storage account.
  const creditAccounts = accounts.filter((account) => account.kind === AccountKind.bank_credit);
  const depositAccounts = accounts.filter((account) =>
    account.kind === AccountKind.deposit || isLegacyDepositAccount(account),
  );
  const debtishAccounts = accounts.filter((account) =>
    account.kind === AccountKind.loan || account.kind === AccountKind.settlement,
  );
  const insuranceAccounts = accounts.filter((account) => account.kind === AccountKind.insurance);
  const stockAccounts = accounts.filter(
    (account) => isPureInvestmentAccount(account) && account.investProductType === "stock",
  );
  const wealthAccounts = accounts.filter(
    (account) => isPureInvestmentAccount(account) && (account.investProductType === "wealth" || account.investProductType === "bond"),
  );
  const metalAccounts = accounts.filter(
    (account) => isPureInvestmentAccount(account) && account.investProductType === "metal",
  );
  const propertyAccounts = accounts.filter(
    (account) => isPureInvestmentAccount(account) && account.investProductType === "property",
  );
  // fund/money accounts are covered by the fund portfolio trend simulation.

  const txWalkAccounts = [...plainAccounts, ...depositAccounts, ...debtishAccounts, ...stockAccounts];
  const currencyByAccountId = new Map(accounts.map((account) => [account.id, normalizeCurrency(account.currency)]));

  // ── FX rates (latest stored rates, same basis as overview net worth) ──────
  const baseCurrency = await getHouseholdBaseCurrency(ctx.householdId);
  const currencySet = new Set(accounts.map((account) => normalizeCurrency(account.currency)));
  const { rates } = await convertCurrencyAmounts({
    householdId: ctx.householdId,
    amounts: Array.from(currencySet).map((currency) => ({ amount: 0, currency })),
    toCurrency: baseCurrency,
  });
  const rateByCurrency = new Map(rates.map((rate) => [rate.fromCurrency, rate.rate]));
  const convert = (accountId: string, amount: number) => {
    const currency = currencyByAccountId.get(accountId) ?? baseCurrency;
    if (currency === baseCurrency) return amount;
    const rate = rateByCurrency.get(currency);
    return rate == null ? 0 : amount * rate;
  };

  // ── 1. TxRecord balance replay ────────────────────────────────────────────
  // Covers cash-like accounts, the TxRecord layer of deposit accounts, the
  // receivable/payable principal of loan+settlement accounts, and the brokerage
  // cash of stock accounts (computeInvestBalances folds stock cash into both
  // the cost and market-value totals, so the table does the same).
  const txSnapshots = new Map<string, number[]>();
  if (txWalkAccounts.length > 0) {
    const walkIds = txWalkAccounts.map((account) => account.id);
    const txRows = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...ctx.hidFilter,
        ...txRecordAccountScopeWhere(walkIds),
      },
      select: {
        id: true,
        date: true,
        postedAt: true,
        createdAt: true,
        dayOrder: true,
        type: true,
        amount: true,
        accountId: true,
        toAccountId: true,
        toNote: true,
        source: true,
        debtPrincipalAmount: true,
        fundSubtype: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
        fundProductType: true,
      },
    });

    const txByAccountId = new Map<string, typeof txRows>();
    for (const account of txWalkAccounts) txByAccountId.set(account.id, []);
    for (const entry of txRows) {
      if (entry.accountId && txByAccountId.has(entry.accountId)) {
        txByAccountId.get(entry.accountId)!.push(entry);
      }
      if (entry.source !== "fx_conversion" && entry.toAccountId && txByAccountId.has(entry.toAccountId)) {
        txByAccountId.get(entry.toAccountId)!.push(entry);
      }
    }

    const debtishKinds = new Set<string>([AccountKind.loan, AccountKind.settlement]);
    for (const account of txWalkAccounts) {
      const isDebtish = debtishKinds.has(account.kind);
      const isDepositKind = account.kind === AccountKind.deposit || isLegacyDepositAccount(account);
      const rows = (txByAccountId.get(account.id) ?? [])
        .slice()
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));

      const snapshots = new Array<number>(boundaries.length).fill(0);
      const walker = makeBoundaryWalker(boundaries);
      let balance = 0;
      for (const entry of rows) {
        const dayKey = localDateKey(getDetailEntryDisplayDate(entry, account.id));
        walker.flushBefore(dayKey, (index) => { snapshots[index] = balance; });
        if (isDebtish) {
          if (getBalanceReconcileTarget(entry) != null) {
            balance = applyBalanceReconcileEntry(balance, entry, account.id);
            continue;
          }
          if (entry.type !== TransactionType.transfer) continue;
          balance += debtPrincipalForAccountSide(entry, account.id);
          continue;
        }
        // Deposit accounts: the lots walk below already counts deposit-product
        // entries; only non-deposit rows belong to this balance layer.
        if (isDepositKind && entry.type === TransactionType.investment && entry.fundProductType === "deposit") {
          continue;
        }
        balance = applyBalanceReconcileEntry(balance, entry, account.id);
      }
      walker.flushRest((index) => { snapshots[index] = balance; });
      txSnapshots.set(account.id, snapshots);
    }
  }

  // ── 2. Deposit lots walk (outstanding arrival principal per month) ────────
  const depositLotSnapshots = new Map<string, number[]>();
  if (depositAccounts.length > 0) {
    const depositIds = depositAccounts.map((account) => account.id);
    const depositEntries = await prisma.depositTransaction.findMany({
      where: { deletedAt: null, ...ctx.hidFilter, accountId: { in: depositIds } },
      select: {
        id: true,
        accountId: true,
        tradeDate: true,
        principalAmount: true,
        arrivalAmount: true,
        action: true,
        sourceDepositTransactionId: true,
      },
      orderBy: [{ tradeDate: "asc" }, { id: "asc" }],
    });

    const entriesByAccount = new Map<string, typeof depositEntries>();
    for (const account of depositAccounts) entriesByAccount.set(account.id, []);
    for (const entry of depositEntries) {
      const list = entriesByAccount.get(entry.accountId);
      if (list) list.push(entry);
    }

    for (const account of depositAccounts) {
      const snapshots = new Array<number>(boundaries.length).fill(0);
      const walker = makeBoundaryWalker(boundaries);
      const remainingByLotId = new Map<string, number>();
      let remaining = 0;
      for (const entry of entriesByAccount.get(account.id) ?? []) {
        walker.flushBefore(localDateKey(entry.tradeDate), (index) => { snapshots[index] = remaining; });
        const isRedeem = entry.action === "redeem" || entry.action === "switch_out";
        const isDividend = entry.action === "dividend_cash" || entry.action === "dividend_reinvest";
        if (isDividend) continue;
        if (!isRedeem) {
          const amount = Math.abs(toNumber(entry.arrivalAmount ?? entry.principalAmount));
          remainingByLotId.set(entry.id, amount);
          remaining += amount;
          continue;
        }
        if (entry.sourceDepositTransactionId) {
          const lot = remainingByLotId.get(entry.sourceDepositTransactionId);
          if (lot != null) {
            remainingByLotId.delete(entry.sourceDepositTransactionId);
            remaining -= lot;
          }
        }
      }
      walker.flushRest((index) => { snapshots[index] = remaining; });
      depositLotSnapshots.set(account.id, snapshots);
    }
  }

  // ── 3. Fund/money accounts: reuse the portfolio trend simulation ──────────
  const fundPoints = options.fundPoints
    ?? (await loadFundPortfolioTrendData(ctx, { includeBenchmark: false })).points;
  const fundCostByMonth = new Map<string, number>();
  const fundMarketByMonth = new Map<string, number>();
  for (const point of fundPoints) {
    fundCostByMonth.set(point.month, point.cost);
    fundMarketByMonth.set(point.month, point.marketValue);
  }

  // ── 4. Wealth accounts: principal buckets per month ───────────────────────
  const wealthSnapshots = new Map<string, { cost: number[]; market: number[] }>();
  if (wealthAccounts.length > 0) {
    const wealthIds = wealthAccounts.map((account) => account.id);
    const rows = await prisma.wealthTransaction.findMany({
      where: { accountId: { in: wealthIds }, deletedAt: null },
      select: {
        accountId: true,
        id: true,
        wealthProductId: true,
        productName: true,
        action: true,
        tradeDate: true,
        createdAt: true,
        grossAmount: true,
        units: true,
      },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    });

    // Manual NAV (unit value) per wealth product, dated by manualNavDate.
    // Mirrors computeInvestBalances: market value = units × manualNav while a
    // unit position exists. For history the NAV applies only from its date on
    // (products without a date use it for all boundaries).
    const navRows = await prisma.wealthProduct.findMany({
      where: { householdId: ctx.householdId, manualNav: { not: null } },
      select: { id: true, name: true, manualNav: true, manualNavDate: true },
    });
    const manualNavByKey = new Map<string, { nav: number; dayKey: string | null }>();
    for (const product of navRows) {
      const nav = toNumber(product.manualNav);
      if (!Number.isFinite(nav) || nav <= 0) continue;
      const entry = {
        nav,
        dayKey: product.manualNavDate ? localDateKey(product.manualNavDate) : null,
      };
      manualNavByKey.set(product.id, entry);
      manualNavByKey.set(product.name, entry);
    }

    const rowsByAccount = new Map<string, typeof rows>();
    for (const account of wealthAccounts) rowsByAccount.set(account.id, []);
    for (const row of rows) {
      const list = rowsByAccount.get(row.accountId);
      if (list) list.push(row);
    }

    for (const account of wealthAccounts) {
      const buckets = new Map<string, { principal: number; units: number; cycleHasUnits: boolean }>();
      const costSnapshots = new Array<number>(boundaries.length).fill(0);
      const marketSnapshots = new Array<number>(boundaries.length).fill(0);
      const walker = makeBoundaryWalker(boundaries);

      const computeTotals = (boundaryDayKey: string) => {
        let cost = 0;
        let market = 0;
        for (const [key, bucket] of buckets.entries()) {
          const principal = isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)
            ? 0
            : Math.max(0, Number(bucket.principal.toFixed(2)));
          cost += principal;
          const navInfo = manualNavByKey.get(key);
          market += navInfo && bucket.cycleHasUnits && bucket.units > 0
            && (navInfo.dayKey == null || boundaryDayKey >= navInfo.dayKey)
            ? bucket.units * navInfo.nav
            : principal;
        }
        return { cost, market };
      };

      for (const row of (rowsByAccount.get(account.id) ?? []).slice()) {
        walker.flushBefore(localDateKey(row.tradeDate), (index) => {
          const totals = computeTotals(boundaries[index]!.dayKey);
          costSnapshots[index] = totals.cost;
          marketSnapshots[index] = totals.market;
        });
        const gross = Math.abs(toNumber(row.grossAmount));
        if (row.action === FundSubtype.dividend_cash) continue;
        const key = row.wealthProductId ?? row.productName ?? `wealth:${row.id}`;
        const bucket = buckets.get(key) ?? { principal: 0, units: 0, cycleHasUnits: false };
        if (row.action === FundSubtype.redeem || row.action === FundSubtype.switch_out) {
          bucket.principal -= gross;
          if (row.units != null) {
            bucket.cycleHasUnits = true;
            bucket.units -= Math.abs(toNumber(row.units));
          }
          if (isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)) {
            resetWealthHoldingBucket(bucket);
          }
        } else {
          if (row.units != null) {
            bucket.cycleHasUnits = true;
            bucket.units += Math.abs(toNumber(row.units));
          }
          bucket.principal += gross;
        }
        buckets.set(key, bucket);
      }
      walker.flushRest((index) => {
        const totals = computeTotals(boundaries[index]!.dayKey);
        costSnapshots[index] = totals.cost;
        marketSnapshots[index] = totals.market;
      });
      wealthSnapshots.set(account.id, { cost: costSnapshots, market: marketSnapshots });
    }
  }

  // ── 5. Precious metal accounts: unit buckets + last traded price ──────────
  const metalSnapshots = new Map<string, { cost: number[]; market: number[] }>();
  if (metalAccounts.length > 0) {
    const metalIds = metalAccounts.map((account) => account.id);
    const rows = await prisma.preciousMetalTransaction.findMany({
      where: { accountId: { in: metalIds }, deletedAt: null },
      select: {
        accountId: true,
        metalTypeId: true,
        metalUnitId: true,
        action: true,
        tradeDate: true,
        createdAt: true,
        amount: true,
        quantity: true,
        unitPrice: true,
      },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    });

    const rowsByAccount = new Map<string, typeof rows>();
    for (const account of metalAccounts) rowsByAccount.set(account.id, []);
    for (const row of rows) {
      const list = rowsByAccount.get(row.accountId);
      if (list) list.push(row);
    }

    for (const account of metalAccounts) {
      type MetalBucket = { quantity: number; cost: number };
      const buckets = new Map<string, MetalBucket>();
      const priceSeries = new Map<string, Array<{ dayKey: string; value: number }>>();
      const costSnapshots = new Array<number>(boundaries.length).fill(0);
      const marketSnapshots = new Array<number>(boundaries.length).fill(0);
      const walker = makeBoundaryWalker(boundaries);

      const computeTotals = (boundaryDayKey: string) => {
        let cost = 0;
        let market = 0;
        for (const [key, bucket] of buckets.entries()) {
          cost += bucket.cost;
          const avgCost = bucket.quantity > 0 ? bucket.cost / bucket.quantity : 0;
          const price = lastValueOnOrBefore(priceSeries.get(key) ?? [], boundaryDayKey) ?? avgCost;
          market += bucket.quantity * (price > 0 ? price : avgCost);
        }
        return { cost, market };
      };

      for (const row of rowsByAccount.get(account.id) ?? []) {
        const dayKey = localDateKey(row.tradeDate);
        walker.flushBefore(dayKey, (index) => {
          const totals = computeTotals(boundaries[index]!.dayKey);
          costSnapshots[index] = totals.cost;
          marketSnapshots[index] = totals.market;
        });

        const key = `${row.metalTypeId}|${row.metalUnitId}`;
        const quantity = Math.abs(toNumber(row.quantity));
        const unitPrice = toNumber(row.unitPrice);
        if (unitPrice > 0) {
          const series = priceSeries.get(key) ?? [];
          series.push({ dayKey, value: unitPrice });
          priceSeries.set(key, series);
        }
        const isBuy = row.action === FundSubtype.buy || row.action === FundSubtype.regular_invest || row.action === FundSubtype.switch_in;
        const isSell = row.action === FundSubtype.redeem || row.action === FundSubtype.switch_out;
        const bucket = buckets.get(key) ?? { quantity: 0, cost: 0 };
        buckets.set(key, bucket);
        if (isBuy) {
          bucket.quantity += quantity;
          bucket.cost += Math.abs(toNumber(row.amount));
        } else if (isSell && quantity > 0) {
          const avgCost = bucket.quantity > 0 ? bucket.cost / bucket.quantity : 0;
          const reducing = Math.min(quantity, bucket.quantity);
          bucket.quantity -= reducing;
          bucket.cost = Math.max(0, bucket.cost - avgCost * reducing);
        }
        if (bucket.quantity <= 0.000001 && bucket.cost <= 0.01) {
          buckets.delete(key);
        }
      }
      walker.flushRest((index) => {
        const totals = computeTotals(boundaries[index]!.dayKey);
        costSnapshots[index] = totals.cost;
        marketSnapshots[index] = totals.market;
      });
      metalSnapshots.set(account.id, { cost: costSnapshots, market: marketSnapshots });
    }
  }

  // ── 6. Stock accounts: position walk + price cache ────────────────────────
  const stockSnapshots = new Map<string, { cost: number[]; market: number[] }>();
  if (stockAccounts.length > 0) {
    const stockIds = stockAccounts.map((account) => account.id);
    const rows = await prisma.stockTransaction.findMany({
      where: {
        householdId: ctx.householdId,
        stockAccountId: { in: stockIds },
        deletedAt: null,
        securityId: { not: null },
      },
      select: {
        stockAccountId: true,
        securityId: true,
        market: true,
        stockCode: true,
        action: true,
        tradeDate: true,
        createdAt: true,
        quantity: true,
        grossAmount: true,
        fee: true,
        commission: true,
        stampTax: true,
        transferFee: true,
        exchangeFee: true,
        regulatoryFee: true,
        otherFee: true,
      },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });

    // Month-end close prices: last cached price on or before each boundary.
    const lastMonth = months[months.length - 1]!;
    const maxBoundaryDate = new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0));
    const priceRows = await prisma.stockPriceCache.findMany({
      where: { priceDate: { lte: maxBoundaryDate } },
      select: { market: true, stockCode: true, priceDate: true, closePrice: true },
      orderBy: { priceDate: "asc" },
    });
    const priceSeriesByCode = new Map<string, Array<{ dayKey: string; value: number }>>();
    for (const row of priceRows) {
      const key = `${row.market}|${row.stockCode}`;
      const series = priceSeriesByCode.get(key) ?? [];
      series.push({ dayKey: localDateKey(row.priceDate), value: toNumber(row.closePrice) });
      priceSeriesByCode.set(key, series);
    }

    const rowsByAccount = new Map<string, typeof rows>();
    for (const account of stockAccounts) rowsByAccount.set(account.id, []);
    for (const row of rows) {
      const list = rowsByAccount.get(row.stockAccountId);
      if (list) list.push(row);
    }

    for (const account of stockAccounts) {
      type StockBucket = { quantity: number; cost: number; market: string; stockCode: string };
      const buckets = new Map<string, StockBucket>();
      const costSnapshots = new Array<number>(boundaries.length).fill(0);
      const marketSnapshots = new Array<number>(boundaries.length).fill(0);
      const walker = makeBoundaryWalker(boundaries);

      const computeTotals = (boundaryDayKey: string) => {
        let cost = 0;
        let market = 0;
        for (const bucket of buckets.values()) {
          cost += bucket.cost;
          const avgCost = bucket.quantity > 0 ? bucket.cost / bucket.quantity : 0;
          const price = lastValueOnOrBefore(priceSeriesByCode.get(`${bucket.market}|${bucket.stockCode}`) ?? [], boundaryDayKey);
          market += bucket.quantity * (price ?? avgCost);
        }
        return { cost, market };
      };

      for (const row of rowsByAccount.get(account.id) ?? []) {
        walker.flushBefore(localDateKey(row.tradeDate), (index) => {
          const totals = computeTotals(boundaries[index]!.dayKey);
          costSnapshots[index] = totals.cost;
          marketSnapshots[index] = totals.market;
        });

        const key = row.securityId!;
        const bucket = buckets.get(key) ?? {
          quantity: 0,
          cost: 0,
          market: row.market,
          stockCode: row.stockCode,
        };
        buckets.set(key, bucket);
        const quantity = Math.abs(toNumber(row.quantity));
        const feeTotal = toNumber(row.fee) + toNumber(row.commission) + toNumber(row.stampTax)
          + toNumber(row.transferFee) + toNumber(row.exchangeFee) + toNumber(row.regulatoryFee)
          + toNumber(row.otherFee);
        const gross = Math.abs(toNumber(row.grossAmount));
        switch (row.action) {
          case StockTransactionAction.buy: {
            bucket.quantity += quantity;
            bucket.cost += gross + feeTotal;
            break;
          }
          case StockTransactionAction.sell: {
            const avgCost = bucket.quantity > 0 ? bucket.cost / bucket.quantity : 0;
            const reducing = Math.min(quantity, bucket.quantity);
            bucket.quantity -= reducing;
            bucket.cost = Math.max(0, bucket.cost - avgCost * reducing);
            break;
          }
          case StockTransactionAction.bonus_share:
          case StockTransactionAction.split_share: {
            bucket.quantity += quantity;
            break;
          }
          case StockTransactionAction.merge_share: {
            const reducing = Math.min(quantity, bucket.quantity);
            bucket.quantity -= reducing;
            break;
          }
          case StockTransactionAction.fee_adjustment:
          case StockTransactionAction.tax_adjustment: {
            bucket.cost = Math.max(0, bucket.cost + gross);
            break;
          }
          default:
            // dividend rows settle as cash via TxRecords; skip here
            break;
        }
        if (bucket.quantity <= 0.000001 && bucket.cost <= 0.01) {
          buckets.delete(key);
        }
      }
      walker.flushRest((index) => {
        const totals = computeTotals(boundaries[index]!.dayKey);
        costSnapshots[index] = totals.cost;
        marketSnapshots[index] = totals.market;
      });
      stockSnapshots.set(account.id, { cost: costSnapshots, market: marketSnapshots });
    }
  }

  // ── 7. Fixed assets: existence window + valuation history ────────────────
  const propertySnapshots = new Map<string, { cost: number[]; market: number[] }>();
  if (propertyAccounts.length > 0) {
    const propertyIds = propertyAccounts.map((account) => account.id);
    const assets = await prisma.propertyAsset.findMany({
      where: { accountId: { in: propertyIds }, deletedAt: null },
      select: {
        id: true,
        accountId: true,
        cost: true,
        marketValue: true,
        purchaseDate: true,
        createdAt: true,
        status: true,
        latestValuationDate: true,
        updatedAt: true,
      },
    });
    const assetIds = assets.map((asset) => asset.id);
    const valuations = assetIds.length > 0
      ? await prisma.propertyValuation.findMany({
          where: { propertyAssetId: { in: assetIds } },
          select: { propertyAssetId: true, valuationDate: true, marketValue: true },
          orderBy: { valuationDate: "asc" },
        })
      : [];

    const valuationsByAsset = new Map<string, Array<{ dayKey: string; value: number }>>();
    for (const row of valuations) {
      const series = valuationsByAsset.get(row.propertyAssetId) ?? [];
      series.push({ dayKey: localDateKey(row.valuationDate), value: toNumber(row.marketValue) });
      valuationsByAsset.set(row.propertyAssetId, series);
    }
    // The asset's current marketValue is the authoritative present value and
    // may be newer than the last PropertyValuation row (direct value edits).
    // Anchor it as a terminal point at latestValuationDate (falling back to
    // updatedAt) so the series converges with the live overview numbers.
    for (const asset of assets) {
      const currentMv = toNumber(asset.marketValue);
      if (currentMv <= 0) continue;
      const anchorDate = asset.latestValuationDate ?? asset.updatedAt;
      if (!anchorDate) continue;
      const series = valuationsByAsset.get(asset.id) ?? [];
      series.push({ dayKey: localDateKey(anchorDate), value: currentMv });
      // Stable sort: on a tie with a valuation row the appended terminal value
      // (pushed last) wins in lastValueOnOrBefore.
      series.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
      valuationsByAsset.set(asset.id, series);
    }

    for (const account of propertyAccounts) {
      const costSnapshots = new Array<number>(boundaries.length).fill(0);
      const marketSnapshots = new Array<number>(boundaries.length).fill(0);
      for (let index = 0; index < boundaries.length; index += 1) {
        const boundaryKey = boundaries[index]!.dayKey;
        let cost = 0;
        let market = 0;
        for (const asset of assets) {
          if (asset.accountId !== account.id) continue;
          const startKey = localDateKey(asset.purchaseDate ?? asset.createdAt);
          if (startKey > boundaryKey) continue;
          if (asset.status === "sold" || asset.status === "disposed") {
            const endKey = localDateKey(asset.latestValuationDate ?? asset.updatedAt);
            if (boundaryKey >= endKey) continue;
          }
          cost += toNumber(asset.cost);
          const value = lastValueOnOrBefore(valuationsByAsset.get(asset.id) ?? [], boundaryKey);
          market += value ?? toNumber(asset.cost);
        }
        costSnapshots[index] = cost;
        marketSnapshots[index] = market;
      }
      propertySnapshots.set(account.id, { cost: costSnapshots, market: marketSnapshots });
    }
  }

  // ── 8. Insurance cash value (premiums paid minus refunds, balance-metric
  // products only — the same rule as computeInsuranceAccountDisplayBalances).
  const insuranceSnapshots = new Map<string, number[]>();
  if (insuranceAccounts.length > 0) {
    const insuranceIds = insuranceAccounts.map((account) => account.id);
    const products = await prisma.insuranceProduct.findMany({
      where: { ...ctx.hidFilter, accountId: { in: insuranceIds } },
      select: { id: true, accountId: true, productType: true, accountingType: true, cashValueEnabled: true },
    });
    const balanceProducts = products.filter((product) =>
      isInsuranceBalanceMetric(product.productType, product.accountingType, product.cashValueEnabled),
    );
    if (balanceProducts.length > 0) {
      const accountByProductId = new Map(balanceProducts.map((product) => [product.id, product.accountId]));
      const entries = await prisma.insuranceTransaction.findMany({
        where: {
          ...ctx.hidFilter,
          deletedAt: null,
          insuranceProductId: { in: balanceProducts.map((product) => product.id) },
        },
        select: {
          accountId: true,
          insuranceProductId: true,
          tradeDate: true,
          action: true,
          amount: true,
        },
        orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
      });

      const entriesByAccount = new Map<string, typeof entries>();
      for (const account of insuranceAccounts) entriesByAccount.set(account.id, []);
      for (const entry of entries) {
        const accountId = accountByProductId.get(entry.insuranceProductId);
        if (!accountId) continue;
        const list = entriesByAccount.get(accountId);
        if (list) list.push({ ...entry, accountId });
      }

      const todayKey = localDateKey(new Date());
      for (const account of insuranceAccounts) {
        const snapshots = new Array<number>(boundaries.length).fill(0);
        const walker = makeBoundaryWalker(boundaries);
        let cashValue = 0;
        for (const entry of entriesByAccount.get(account.id) ?? []) {
          const dayKey = localDateKey(entry.tradeDate);
          if (dayKey > todayKey) continue;
          walker.flushBefore(dayKey, (index) => { snapshots[index] = cashValue; });
          cashValue += insuranceCashValueDelta(entry);
        }
        walker.flushRest((index) => { snapshots[index] = cashValue; });
        insuranceSnapshots.set(account.id, snapshots);
      }
    }
  }

  // ── 9. Credit-card debt from billing cycles ───────────────────────────────
  // Month-end debt = the running cumulativeRemain (minus overpaid) of the last
  // bill period that closed on or before the month end. Member cards of
  // consolidated-billing groups have no cycles of their own; their storage
  // account carries the group's cycles, so per-account summation is correct.
  const creditDebtSeries = new Map<string, Array<{ dayKey: string; value: number }>>();
  if (creditAccounts.length > 0) {
    const cycleRows = await prisma.creditCardCycle.findMany({
      where: { accountId: { in: creditAccounts.map((account) => account.id) } },
      select: {
        accountId: true,
        periodEnd: true,
        cumulativeRemain: true,
        cumulativeOverpaid: true,
      },
      orderBy: { periodEnd: "asc" },
    });
    for (const row of cycleRows) {
      const debt = Math.max(0, toNumber(row.cumulativeRemain) - toNumber(row.cumulativeOverpaid));
      const series = creditDebtSeries.get(row.accountId) ?? [];
      series.push({ dayKey: localDateKey(row.periodEnd), value: debt });
      creditDebtSeries.set(row.accountId, series);
    }
  }

  // ── 10. Assemble month-end totals (net of liabilities) ────────────────────
  for (let index = 0; index < boundaries.length; index += 1) {
    // Net base: every balance-kind account contributes its raw walked balance
    // (loan/往来 payables arrive negative and subtract; receivables and
    // overpayments add). Credit-card debt comes from the billing cycles and
    // subtracts. Same netting direction as the overview net-worth card.
    let netBase = 0;
    for (const account of plainAccounts) {
      netBase += convert(account.id, txSnapshots.get(account.id)?.[index] ?? 0);
    }
    for (const account of creditAccounts) {
      const series = creditDebtSeries.get(account.id);
      // includeZero: a repaid-to-zero balance is a valid state and must not
      // fall back to the last outstanding debt.
      const debt = series ? (lastValueOnOrBefore(series, boundaries[index]!.dayKey, true) ?? 0) : 0;
      netBase -= convert(account.id, debt);
    }
    for (const account of depositAccounts) {
      const layer = txSnapshots.get(account.id)?.[index] ?? 0;
      const lots = depositLotSnapshots.get(account.id)?.[index] ?? 0;
      netBase += convert(account.id, layer + lots);
    }
    let settlement = 0;
    for (const account of debtishAccounts) {
      const value = convert(account.id, txSnapshots.get(account.id)?.[index] ?? 0);
      netBase += value;
      if (account.kind === AccountKind.settlement) settlement += value;
    }
    let insurance = 0;
    for (const account of insuranceAccounts) {
      const value = convert(account.id, insuranceSnapshots.get(account.id)?.[index] ?? 0);
      insurance += value;
      netBase += value;
    }
    let stockCash = 0;
    for (const account of stockAccounts) {
      stockCash += convert(account.id, txSnapshots.get(account.id)?.[index] ?? 0);
    }

    let wealthCost = 0;
    let wealthMarket = 0;
    for (const account of wealthAccounts) {
      const snapshots = wealthSnapshots.get(account.id);
      if (!snapshots) continue;
      wealthCost += convert(account.id, snapshots.cost[index] ?? 0);
      wealthMarket += convert(account.id, snapshots.market[index] ?? 0);
    }

    let metalCost = 0;
    let metalMarket = 0;
    for (const account of metalAccounts) {
      const snapshots = metalSnapshots.get(account.id);
      if (!snapshots) continue;
      metalCost += convert(account.id, snapshots.cost[index] ?? 0);
      metalMarket += convert(account.id, snapshots.market[index] ?? 0);
    }

    let stockCost = 0;
    let stockMarket = 0;
    for (const account of stockAccounts) {
      const snapshots = stockSnapshots.get(account.id);
      if (!snapshots) continue;
      stockCost += convert(account.id, snapshots.cost[index] ?? 0);
      stockMarket += convert(account.id, snapshots.market[index] ?? 0);
    }

    let propertyCost = 0;
    let propertyMarket = 0;
    for (const account of propertyAccounts) {
      const snapshots = propertySnapshots.get(account.id);
      if (!snapshots) continue;
      propertyCost += convert(account.id, snapshots.cost[index] ?? 0);
      propertyMarket += convert(account.id, snapshots.market[index] ?? 0);
    }

    const month = boundaries[index]!.month;
    const fundCost = fundCostByMonth.get(month) ?? 0;
    const fundMarket = fundMarketByMonth.get(month) ?? 0;

    result.set(month, {
      netAssetCost: round2(netBase
        + fundCost + wealthCost + metalCost + stockCost + stockCash + propertyCost),
      netAssetMarketValue: round2(netBase
        + fundMarket + wealthMarket + metalMarket + stockMarket + stockCash + propertyMarket),
      insurance: round2(insurance),
      propertyCost: round2(propertyCost),
      propertyMarket: round2(propertyMarket),
      settlement: round2(settlement),
    });
  }

  return result;
}
