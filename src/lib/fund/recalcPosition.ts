import { prisma } from "@/lib/db/prisma";
import { getLatestFundNavMap } from "@/lib/fund/navCache";
import { getFundProfileNameMap } from "@/lib/fund/fundProfile";
import { FundCashFlowKind, FundSubtype, type Prisma } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { allocateBuyFailedRefunds, getEffectiveBuyUnits } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { MONEY_FUND_NAV } from "@/lib/fund/moneyFund";
import { isFundUnitsReconcileEntry, TRANSACTION_SOURCE_MONEY_INCOME } from "@/lib/transaction-semantics";

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "toNumber" in Object.getPrototypeOf(v as object)) return toNumber(v as { toNumber: () => number });
  return Number(v);
}

type Lot = { units: number; costPerUnit: number };

// Calculation input intentionally excludes display metadata such as fundName.
export type FundPositionEntryLike = {
  id: string;
  fundCode: string | null;
  amount: number;
  fee: number;
  arrivalAmount: number | null;
  units: number | null;
  subtype: string | null;
  source: string | null;
  isPending: boolean;
  confirmDate: string | null;
  arrivalDate: string | null;
  /**
   * 生效日（申请日）。只用来兜底：历史「钱包支出自动赎回」的业务行没有 confirmDate，
   * 少了这个兜底，entryCalcDate 会返回空串，赎回被排到所有买入之前而减不掉份额。
   */
  date?: string | null;
  netBuyAmount?: number | null;
  pendingBuyAmount?: number | null;
  effectiveUnits?: number | null;
  unitsProfitStartDate?: string | null;
  realizedProfit?: number | null;
};

/**
 * 一笔基金交易的「入账日」：确认日 → 到账日 → 申请日（买入类没有申请日兜底）。
 *
 * 导出是为了让明细页的「剩余份额」列（`loadFundTransactionEntryLike`）按同一个顺序回放份额；
 * 两处口径一旦分叉，明细最后一行的份额就和持仓页对不上。
 */
export function fundEntryCalcDateKey(e: {
  subtype?: string | null;
  amount?: number | null;
  confirmDate?: string | null;
  arrivalDate?: string | null;
  date?: string | null;
}): string {
  const subtype = e.subtype ?? ((e.amount ?? 0) < 0 ? "buy" : "redeem");
  return subtype === "buy" || subtype === "dividend_reinvest"
    ? (e.confirmDate ?? e.arrivalDate ?? "")
    : (e.confirmDate ?? e.arrivalDate ?? e.date ?? "");
}

function entryCalcDate(e: FundPositionEntryLike): string {
  return fundEntryCalcDateKey(e);
}

type FundHoldingCalc = { units: number; cost: number; pendingCost: number; historicalProfit: number };

function emptyHolding(): FundHoldingCalc {
  return { units: 0, cost: 0, pendingCost: 0, historicalProfit: 0 };
}

type FundPositionCalcResult = {
  holdings: Map<string, FundHoldingCalc>;
  realizedProfitByEntryId: Map<string, number>;
};

function buyCostBasis(amount: number): number {
  const a = Math.abs(toNum(amount));
  return a > 0 ? a : 0;
}

/**
 * 货币基金每日万份收益结转（红利再投）。
 *
 * 和开放式基金不一样：净值恒为 1 元，收益每天按万份收益折成份额真实入账，
 * 这天的钱已经到手了，属于「已实现收益」而不是浮盈。所以结转必须同时抬成本
 * （份额 × 1 元面值），否则收益会留在浮盈里，等到赎回那天再被算一次。
 */
function isMoneyIncomeEntry(e: FundPositionEntryLike): boolean {
  return e.source === TRANSACTION_SOURCE_MONEY_INCOME;
}

function buyEntryCostBasis(e: FundPositionEntryLike, amount: number): number {
  // 结转流水的现金成本是 0，但份额是按 1 元/份面值入账的，成本基础必须同步。
  if (isMoneyIncomeEntry(e)) return Math.abs(toNum(e.units ?? 0));
  return e.netBuyAmount != null ? Math.max(0, toNum(e.netBuyAmount)) : buyCostBasis(amount);
}

function pendingBuyAmount(e: FundPositionEntryLike, amount: number): number {
  return e.pendingBuyAmount != null ? Math.max(0, toNum(e.pendingBuyAmount)) : buyEntryCostBasis(e, amount);
}

function redeemProceeds(e: FundPositionEntryLike, amount: number): number {
  return Math.max(0, Math.abs(toNum(e.arrivalAmount ?? amount)));
}

function isIncreaseSubtype(subtype: string | null | undefined) {
  return subtype === "buy" || subtype === "switch_in";
}

function isDecreaseSubtype(subtype: string | null | undefined) {
  return subtype === "redeem" || subtype === "switch_out";
}

function calcByMovingAvg(entries: FundPositionEntryLike[], fundUnitsDecimals: number): FundPositionCalcResult {
  const map = new Map<string, FundHoldingCalc>();
  const realizedProfitByEntryId = new Map<string, number>();

  const sorted = [...entries].sort((a, b) => entryCalcDate(a).localeCompare(entryCalcDate(b)));

  for (const e of sorted) {
    if (!e.fundCode) continue;
    const code = e.fundCode;
    const amount = toNum(e.amount);
    const subtype = e.subtype ?? (amount < 0 ? "buy" : "redeem");

    if (subtype === "buy_failed") {
      // Failed subscriptions are cash-flow history only. They never become fund
      // holdings, so they should not inflate pending fund cost.
      continue;
    }

    const rec = map.get(code) ?? emptyHolding();

    if (isFundUnitsReconcileEntry(e)) {
      const u = Math.max(0, e.units ?? 0);
      if (u > 0 && isIncreaseSubtype(subtype)) {
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
      } else if (u > 0 && isDecreaseSubtype(subtype)) {
        const reducingUnits = Math.min(rec.units, u);
        const avgCost = rec.units > 0 ? rec.cost / rec.units : 0;
        rec.cost -= avgCost * reducingUnits;
        rec.units = roundFundUnits(rec.units - reducingUnits, fundUnitsDecimals);
        realizedProfitByEntryId.set(e.id, 0);
      }
      rec.cost = Math.max(0, rec.cost);
      rec.units = Math.max(0, roundFundUnits(rec.units, fundUnitsDecimals));
      map.set(code, rec);
      continue;
    }

    if (subtype === "buy") {
      const u = e.units ?? 0;
      if (isMoneyIncomeEntry(e) && u !== 0) {
        // 货基收益结转：份额与成本按 1 元面值同步走，收益当天就是已实现的真金白银。
        rec.cost += u;
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
        rec.historicalProfit += u;
        realizedProfitByEntryId.set(e.id, u);
      } else if (u < 0) {
        // 非结转的负份额行（历史脏数据）：只减份额、加成本会把均价打负。
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
      } else if (u === 0) {
        rec.pendingCost += pendingBuyAmount(e, amount);
      } else {
        rec.cost += buyEntryCostBasis(e, amount);
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
      }
    } else if (subtype === "dividend_cash") {
      rec.historicalProfit += e.realizedProfit != null ? toNum(e.realizedProfit) : Math.abs(amount);
    } else if (subtype === "redeem" || subtype === "switch_out") {
      if (e.units != null && e.units > 0) {
        const avgCost = rec.units > 0 ? rec.cost / rec.units : 0;
        const costReduced = avgCost * e.units;
        const proceeds = redeemProceeds(e, amount);
        const realizedProfit = proceeds - costReduced;
        rec.cost -= costReduced;
        rec.units = roundFundUnits(rec.units - e.units, fundUnitsDecimals);
        rec.historicalProfit += realizedProfit;
        realizedProfitByEntryId.set(e.id, realizedProfit);
      }
    }

    rec.cost = Math.max(0, rec.cost);
    rec.units = Math.max(0, roundFundUnits(rec.units, fundUnitsDecimals));
    map.set(code, rec);
  }

  for (const rec of map.values()) {
    rec.pendingCost = Math.max(0, rec.pendingCost);
  }
  return { holdings: map, realizedProfitByEntryId };
}

function calcByFifo(entries: FundPositionEntryLike[], fundUnitsDecimals: number, lifo = false): FundPositionCalcResult {
  const lots = new Map<string, Lot[]>();
  const result = new Map<string, FundHoldingCalc>();
  const realizedProfitByEntryId = new Map<string, number>();

  const sorted = [...entries].sort((a, b) => entryCalcDate(a).localeCompare(entryCalcDate(b)));

  for (const e of sorted) {
    if (!e.fundCode) continue;
    const code = e.fundCode;
    const amount = toNum(e.amount);
    const subtype = e.subtype ?? (amount < 0 ? "buy" : "redeem");

    if (subtype === "buy_failed") {
      // Failed subscriptions are cash-flow history only. They never become fund
      // holdings, so they should not inflate pending fund cost.
      continue;
    }

    if (!lots.has(code)) lots.set(code, []);
    const codeLots = lots.get(code)!;
    const rec = result.get(code) ?? emptyHolding();

    if (isFundUnitsReconcileEntry(e)) {
      const u = Math.max(0, e.units ?? 0);
      if (u > 0 && isIncreaseSubtype(subtype)) {
        codeLots.push({ units: u, costPerUnit: 0 });
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
      } else if (u > 0 && isDecreaseSubtype(subtype)) {
        const reducingUnits = Math.min(rec.units, u);
        const actualQueue = lifo ? [...codeLots].reverse() : codeLots;
        let remaining = reducingUnits;
        let costReduced = 0;
        for (const lot of actualQueue) {
          if (remaining <= 0) break;
          const take = Math.min(lot.units, remaining);
          costReduced += take * lot.costPerUnit;
          lot.units = Math.max(0, roundFundUnits(lot.units - take, fundUnitsDecimals));
          remaining -= take;
        }
        lots.set(code, codeLots.filter((lot) => lot.units > 0));
        rec.units = Math.max(0, roundFundUnits(rec.units - reducingUnits, fundUnitsDecimals));
        rec.cost = Math.max(0, rec.cost - costReduced);
        realizedProfitByEntryId.set(e.id, 0);
      }
      result.set(code, rec);
      continue;
    }

    if (subtype === "buy") {
      const u = e.units ?? 0;
      if (isMoneyIncomeEntry(e) && u !== 0) {
        // 货基收益结转按 1 元面值入批次：收益已在当天实现，赎回时只需取回成本。
        if (u > 0) {
          codeLots.push({ units: u, costPerUnit: MONEY_FUND_NAV });
          rec.cost += u;
        } else {
          // 负收益日按批次成本扣回份额（货基批次单价恒为 1）。
          let remaining = -u;
          const queue = lifo ? [...codeLots].reverse() : codeLots;
          let costReduced = 0;
          for (const lot of queue) {
            if (remaining <= 0) break;
            const take = Math.min(lot.units, remaining);
            costReduced += take * lot.costPerUnit;
            lot.units = Math.max(0, roundFundUnits(lot.units - take, fundUnitsDecimals));
            remaining -= take;
          }
          lots.set(code, codeLots.filter((lot) => lot.units > 0));
          rec.cost = Math.max(0, rec.cost - costReduced);
        }
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
        rec.historicalProfit += u;
        realizedProfitByEntryId.set(e.id, u);
      } else if (u < 0) {
        // 非结转的负份额行（历史脏数据）：按先进先出扣减批次数量，成本不动。
        let remaining = -u;
        for (const lot of codeLots) {
          if (remaining <= 0) break;
          const take = Math.min(lot.units, remaining);
          lot.units = Math.max(0, roundFundUnits(lot.units - take, fundUnitsDecimals));
          remaining -= take;
        }
        lots.set(code, codeLots.filter((lot) => lot.units > 0));
        rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals);
      } else if (u === 0) { rec.pendingCost += pendingBuyAmount(e, amount); }
      else { codeLots.push({ units: u, costPerUnit: buyEntryCostBasis(e, amount) / u }); rec.units = roundFundUnits(rec.units + u, fundUnitsDecimals); rec.cost += buyEntryCostBasis(e, amount); }
    } else if (subtype === "dividend_cash") {
      rec.historicalProfit += e.realizedProfit != null ? toNum(e.realizedProfit) : Math.abs(amount);
    } else if (subtype === "redeem" || subtype === "switch_out") {
      // 赎回必须只吃「当前剩余批次」：批次表和成本扣减同源，才不会分叉。
      // 历史实现每次从 sorted 里重扫全部买入行重建 lot 队列，已赎回吃掉的份额会被
      // 重新算一遍——多次赎回后成本扣减对不上批次，持仓成本虚高（519066 实测
      // 43943.21，正确值 28515.63）。
      const queue = lifo ? [...codeLots].reverse() : codeLots;
      let remaining = e.units ?? 0;
      let costReduced = 0;
      for (const lot of queue) {
        if (remaining <= 0) break;
        const take = Math.min(lot.units, remaining);
        costReduced += take * lot.costPerUnit;
        lot.units = Math.max(0, roundFundUnits(lot.units - take, fundUnitsDecimals));
        remaining -= take;
      }
      lots.set(code, codeLots.filter((lot) => lot.units > 0));
      rec.units = Math.max(0, roundFundUnits(rec.units - ((e.units ?? 0) - remaining), fundUnitsDecimals));
      rec.cost = Math.max(0, rec.cost - costReduced);
      const proceeds = redeemProceeds(e, amount);
      const realizedProfit = proceeds - costReduced;
      rec.historicalProfit += realizedProfit;
      realizedProfitByEntryId.set(e.id, realizedProfit);
    }

    // 成本不变式：持仓成本永远等于剩余批次成本之和（含 0 成本的分红再投批次）。
    // 有了它，任何分支都不需要自己维护 rec.cost，也就不会再次出现「成本与批次脱节」。
    rec.cost = Math.max(0, codeLots.reduce((sum, lot) => sum + lot.units * lot.costPerUnit, 0));

    result.set(code, rec);
  }
  return { holdings: result, realizedProfitByEntryId };
}

export function calculateFundPositionsFromEntries(
  entries: FundPositionEntryLike[],
  fundUnitsDecimals: number,
  costBasisMethod: string | null | undefined = "moving_avg",
): FundPositionCalcResult {
  if (costBasisMethod === "fifo") return calcByFifo(entries, fundUnitsDecimals, false);
  if (costBasisMethod === "lifo") return calcByFifo(entries, fundUnitsDecimals, true);
  return calcByMovingAvg(entries, fundUnitsDecimals);
}

export async function recalcFundPositions(
  accountId: string,
  fundCodes?: string[],
  client: Prisma.TransactionClient = prisma,
) {
  const account = await client.account.findUnique({ where: { id: accountId } });
  if (!account) return;
  if (account.kind !== "investment") return;
  const fundUnitsDecimals = normalizeFundUnitsDecimals(account.fundUnitsDecimals);

  const fundTransactions = await client.fundTransaction.findMany({
    where: {
      fundAccountId: accountId,
      deletedAt: null,
      ...(fundCodes ? { fundCode: { in: fundCodes } } : {}),
    },
    include: { cashFlows: true },
    orderBy: [{ confirmDate: "asc" }, { applyDate: "asc" }, { createdAt: "asc" }],
  });

  const rawEntries: any[] = fundTransactions.flatMap((entry) => {
        const cashReceipt = entry.fundSubtype === FundSubtype.redeem ||
          entry.fundSubtype === FundSubtype.switch_out ||
          entry.fundSubtype === FundSubtype.dividend_cash;
        const amount = entry.fundSubtype === FundSubtype.buy || entry.fundSubtype === FundSubtype.switch_in
          ? -Math.abs(toNum(entry.grossAmount))
          : Math.abs(toNum(entry.arrivalAmount ?? entry.grossAmount));
        const main = {
          id: entry.cashEntryId ?? entry.id,
          fundTransactionId: entry.id,
          cashEntryId: entry.cashEntryId,
          fundCode: entry.fundCode,
          fundName: entry.fundName,
          toAccountName: null,
          amount,
          fundFee: entry.fee,
          fundArrivalAmount: entry.arrivalAmount,
          fundUnits: entry.units,
          fundSubtype: entry.fundSubtype,
          fundConfirmDate: entry.confirmDate,
          fundArrivalDate: entry.arrivalDate,
          source: entry.source,
          date: entry.applyDate,
          createdAt: entry.createdAt,
          accountId: cashReceipt ? entry.fundAccountId : entry.cashAccountId,
          toAccountId: cashReceipt ? entry.cashAccountId : entry.fundAccountId,
          fundSourceEntryId: null,
          realizedProfit: entry.realizedProfit,
        };
        const refundRows = entry.cashFlows
          .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
          .map((flow) => ({
            id: flow.txRecordId,
            fundCode: entry.fundCode,
            fundName: entry.fundName,
            toAccountName: null,
            amount: Math.abs(toNum(flow.amount)),
            fundFee: null,
            fundArrivalAmount: flow.amount,
            fundUnits: null,
            fundSubtype: FundSubtype.buy_failed,
            fundConfirmDate: entry.applyDate,
            fundArrivalDate: flow.flowDate,
            source: "regular_invest_refund",
            date: flow.flowDate,
            createdAt: flow.createdAt,
            accountId: entry.fundAccountId,
            toAccountId: flow.accountId ?? entry.cashAccountId,
            fundSourceEntryId: entry.cashEntryId ?? entry.id,
            realizedProfit: null,
          }));
        return [main, ...refundRows];
      });

  const { refundAmountByBuyId } = allocateBuyFailedRefunds(rawEntries.map(e => ({
    id: e.id,
    date: e.date,
    createdAt: e.createdAt,
    fundConfirmDate: e.fundConfirmDate,
    fundArrivalDate: e.fundArrivalDate,
    accountId: e.accountId,
    toAccountId: e.toAccountId,
    fundCode: e.fundCode,
    fundSubtype: e.fundSubtype,
    source: e.source,
    amount: toNum(e.amount),
    fundSourceEntryId: e.fundSourceEntryId,
  })));

  const entries: FundPositionEntryLike[] = rawEntries
    .filter(e => !fundCodes || (e.fundCode && fundCodes.includes(e.fundCode)))
    .map(e => {
      const amount = toNum(e.amount);
      const storedUnits = e.fundUnits != null ? roundFundUnits(toNum(e.fundUnits), fundUnitsDecimals) : null;
      const grossAfterRefund = e.fundSubtype === "buy"
        ? Math.max(0, Math.abs(amount) - (refundAmountByBuyId.get(e.id) ?? 0))
        : null;
      const netBuyAmount = e.fundSubtype === "buy"
        ? grossAfterRefund
        : null;
      // 货基收益结转允许负份额（某日万份收益为负），clamp 到 0 会把「减少」变成「在途成本」。
      const effectiveUnits = e.fundSubtype === "buy" && storedUnits != null
        ? (e.source === TRANSACTION_SOURCE_MONEY_INCOME
          ? roundFundUnits(storedUnits, fundUnitsDecimals)
          : roundFundUnits(getEffectiveBuyUnits(storedUnits), fundUnitsDecimals))
        : storedUnits;
      return {
        id: e.id,
        fundCode: e.fundCode,
        amount,
        fee: toNum(e.fundFee ?? 0),
        arrivalAmount: e.fundArrivalAmount != null ? toNum(e.fundArrivalAmount) : null,
        units: effectiveUnits,
        subtype: e.fundSubtype ?? null,
        source: e.source ?? null,
        isPending: e.fundSubtype === "buy_failed" || (e.fundConfirmDate == null && e.fundSubtype === "buy"),
        confirmDate: e.fundConfirmDate ? e.fundConfirmDate.toISOString().slice(0, 10) : null,
        arrivalDate: e.fundArrivalDate ? e.fundArrivalDate.toISOString().slice(0, 10) : null,
        date: e.date ? new Date(e.date).toISOString().slice(0, 10) : null,
        netBuyAmount,
        effectiveUnits,
        realizedProfit: e.realizedProfit != null ? toNum(e.realizedProfit) : null,
      };
    });

  const codesToCalc = fundCodes ?? [...new Set(entries.map(e => e.fundCode).filter(Boolean))] as string[];

  const calcResult = calculateFundPositionsFromEntries(entries, fundUnitsDecimals, account.costBasisMethod);
  const symbolMap = calcResult.holdings;

  for (const e of rawEntries) {
    if (e.fundSubtype !== "redeem") continue;
    if (fundCodes && e.fundCode && !fundCodes.includes(e.fundCode)) continue;
    const realizedProfit = calcResult.realizedProfitByEntryId.get(e.id) ?? null;
    if (e.fundTransactionId) {
      await client.fundTransaction.update({ where: { id: e.fundTransactionId }, data: { realizedProfit } });
    }
    const cashEntryId = e.cashEntryId ?? (e.fundTransactionId && e.id !== e.fundTransactionId ? e.id : null);
    if (cashEntryId) {
      await client.txRecord.update({ where: { id: cashEntryId }, data: { realizedProfit } });
    }
  }

  // 最新净值只经 navCache 的共享入口取（每基金一条），不再整表拉下来自己挑。
  const latestNavByCode = await getLatestFundNavMap(codesToCalc);
  const navCacheMap = new Map<string, number>();
  for (const [code, row] of latestNavByCode) navCacheMap.set(code, toNum(row.nav));
  // 名字只从 FundProfile 读（净值缓存只回答净值）。
  const profileNameMap = await getFundProfileNameMap(codesToCalc);

  const entryNameMap = new Map<string, string>();
  // Fund names are display-only; fundCode is the calculation key.
  for (const e of [...rawEntries].reverse()) {
    const code = (e.fundCode ?? "").trim();
    const name = (e.fundName ?? "").trim();
    if (code && name && name !== code && !entryNameMap.has(code)) entryNameMap.set(code, name);
  }

  // 货基按面值 1 元/份核算：净值缓存里该代码下的数字是「每万份收益」，不能写进持仓，
  // 否则下游用 units × nav 估值会把货基市值算成份额的十分之一。
  const isMoneyFundAccount = account.investProductType === "money";

  for (const code of codesToCalc) {
    const rec = symbolMap.get(code);
    if (!rec) { await client.fundHolding.deleteMany({ where: { accountId, fundCode: code } }); continue; }

    const roundedUnits = roundFundUnits(rec.units, fundUnitsDecimals);
    const avgCost = roundedUnits > 0 ? rec.cost / roundedUnits : 0;
    const latestNavFromHolding = await client.fundHolding.findFirst({
      where: { accountId, fundCode: code, nav: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { nav: true },
    });
    const navFromCache = navCacheMap.get(code);
    const navFromHolding = latestNavFromHolding?.nav != null ? toNum(latestNavFromHolding.nav) : null;
    const navToUse = isMoneyFundAccount ? MONEY_FUND_NAV : navFromCache ?? navFromHolding;

    const existing = await client.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode: code } },
    });
    const existingName = (existing?.fundName ?? "").trim();
    const fundName = profileNameMap.get(code) ?? (existingName && existingName !== code ? existingName : undefined) ?? entryNameMap.get(code) ?? null;

    const holdingData = {
      fundName,
      units: roundedUnits,
      avgCost,
      cost: rec.cost + rec.pendingCost,
      nav: navToUse ?? undefined,
      pendingCost: rec.pendingCost,
      historicalProfit: rec.historicalProfit,
    };

    if (existing) {
      await client.fundHolding.update({ where: { accountId_fundCode: { accountId, fundCode: code } }, data: holdingData });
    } else {
      await client.fundHolding.create({ data: { accountId, fundCode: code, ...holdingData } });
    }
  }
}
