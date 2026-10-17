import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { isWealthHoldingCleared, resetWealthHoldingBucket } from "@/lib/invest-balance";
import { depositLotOriginalPrincipal, depositRedemptionPrincipal } from "@/lib/server/deposit-lot-balance";
import { projectBondLots, type BondLotRow } from "@/lib/server/bond-shell-data";

/**
 * 产品库列表的「当前持仓笔数」口径（2026-10-17 用户裁定）。
 *
 * 产品库弹窗每行末尾原来显示「N 条记录」（该产品下全部未软删业务记录，含已赎回的
 * 历史记录），用户要求改成**当前持仓**：已全部赎回 / 结清的产品显示 0。
 *
 * 四个家族的真源不同，不能一刀切：
 * - **理财**：没有存单概念，视图里一个产品（在同一理财账户下）聚合为一行持仓
 *   → 按 `(accountId, wealthProductId)` 分桶累计本金/份额，桶未清仓记 1，清仓记 0。
 *   与 `computeInvestBalances` 的 bucket 逻辑同源（`isWealthHoldingCleared`）。
 * - **存款**：存单 = `TxRecord` 买入行，赎回/核销用 `depositSourceEntryId` 指回
 *   → 剩余本金 > 0 的存单数（口径同 `loadDepositLotBalance().settled`）。
 * - **债券**：存单 = `BondTransaction` 买入行，子行用 `sourceBondTransactionId` 指回
 *   → 复用 `projectBondLots()` 的 `status === "open"`，不另写一套判定。
 * - **保险**：持仓 = 保单数，在 `insurance-products` 路由里直接按 master 关联保单计。
 *
 * 返回值都是 `productId -> 持仓笔数`，没有持仓的产品不放进 Map（调用方 `?? 0`）。
 */

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 理财：未清仓的持仓桶数（同一产品在多个理财账户下持仓会分别计 1）。 */
export async function loadWealthHoldingCounts(
  householdId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = productIds.filter(Boolean);
  if (ids.length === 0) return counts;

  const rows = await prisma.wealthTransaction.findMany({
    where: { householdId, deletedAt: null, wealthProductId: { in: ids } },
    select: {
      id: true,
      accountId: true,
      wealthProductId: true,
      action: true,
      grossAmount: true,
      units: true,
      tradeDate: true,
      createdAt: true,
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });

  type Bucket = { productId: string; principal: number; units: number; cycleHasUnits: boolean };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const productId = row.wealthProductId;
    if (!productId) continue;
    const key = `${row.accountId}:${productId}`;
    const bucket = buckets.get(key) ?? { productId, principal: 0, units: 0, cycleHasUnits: false };
    const gross = Math.abs(numeric(row.grossAmount));
    const units = row.units == null ? null : Math.abs(numeric(row.units));

    if (row.action === FundSubtype.dividend_cash) {
      // 分红不进本金，也不影响清仓判定。
      buckets.set(key, bucket);
      continue;
    }

    if (row.action === FundSubtype.redeem || row.action === FundSubtype.switch_out) {
      bucket.principal -= gross;
      if (units != null) {
        bucket.cycleHasUnits = true;
        bucket.units -= units;
      }
      if (isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)) {
        resetWealthHoldingBucket(bucket);
      }
    } else {
      if (units != null) {
        bucket.cycleHasUnits = true;
        bucket.units += units;
      }
      bucket.principal += gross;
    }
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    if (isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)) continue;
    counts.set(bucket.productId, (counts.get(bucket.productId) ?? 0) + 1);
  }
  return counts;
}

/** 存款：剩余本金 > 0 的存单数。 */
export async function loadDepositHoldingCounts(
  householdId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = productIds.filter(Boolean);
  if (ids.length === 0) return counts;

  const lots = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: FundSubtype.buy,
      depositProductId: { in: ids },
    },
    select: { id: true, depositProductId: true, amount: true, fundArrivalAmount: true },
  });
  if (lots.length === 0) return counts;

  const redemptions = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      depositSourceEntryId: { in: lots.map((lot) => lot.id) },
      fundSubtype: { in: [FundSubtype.redeem, FundSubtype.switch_out] },
    },
    select: { depositSourceEntryId: true, amount: true, fundArrivalAmount: true, depositInterest: true },
  });
  const redeemedByLotId = new Map<string, number>();
  for (const row of redemptions) {
    if (!row.depositSourceEntryId) continue;
    redeemedByLotId.set(
      row.depositSourceEntryId,
      (redeemedByLotId.get(row.depositSourceEntryId) ?? 0) + depositRedemptionPrincipal(row),
    );
  }

  for (const lot of lots) {
    const productId = lot.depositProductId;
    if (!productId) continue;
    const remaining = depositLotOriginalPrincipal(lot) - (redeemedByLotId.get(lot.id) ?? 0);
    if (remaining <= 0.0001) continue;
    counts.set(productId, (counts.get(productId) ?? 0) + 1);
  }
  return counts;
}

/** 债券：`status === "open"` 的存单数（复用视图投影，不另写判定）。 */
export async function loadBondHoldingCounts(
  householdId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = productIds.filter(Boolean);
  if (ids.length === 0) return counts;

  const rows = await prisma.bondTransaction.findMany({
    where: { householdId, deletedAt: null, bondProductId: { in: ids } },
    include: {
      BondProduct: {
        select: {
          name: true,
          annualRate: true,
          termDays: true,
          maturityDate: true,
          payoutFrequency: true,
          firstPayoutDate: true,
          interestCalcBasis: true,
        },
      },
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });

  for (const lot of projectBondLots(rows as unknown as BondLotRow[])) {
    if (lot.status !== "open" || !lot.bondProductId) continue;
    counts.set(lot.bondProductId, (counts.get(lot.bondProductId) ?? 0) + 1);
  }
  return counts;
}
