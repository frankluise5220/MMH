import { prisma } from "@/lib/db/prisma";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import { DepreciationMethod, resolveAssetDepreciation } from "@/lib/fixed-asset-depreciation";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { runExclusive } from "@/lib/server/interest-accrual";
import { logger } from "@/lib/logger";

/**
 * 固定资产折旧台账的自动落账（2026-11-18 用户裁定）。
 *
 * 口径（与 src/lib/fixed-asset-depreciation.ts 同源，不要在这里另算）：
 * - 直线法按月计提：月折旧额 =（成本 − 残值）÷ 折旧月数，年折旧率 = 1 / 年限
 *   （10 年报废 → 每年 10%）。基数**不是**当期市值：按市值乘百分比是余额递减法，
 *   估值一变折旧额就变，账没法重放。
 * - 折旧是**账面价值减少**，不是现金损失：这里只写
 *   `property_asset_depreciations` 台账，不写 TxRecord、不改账户余额、不进收支报表。
 * - 从购入月补记：第 k 期落在「购入日 + k 个月」那个月的月初；只记满整月的期数，
 *   封顶折旧年限。已有期间不重算（基数变更属未来适用法，新期间按新基数继续）。
 * - 已售 / 已处置的资产不再新增期间；处置时由 properties 路由按台账累计定格。
 */

const MAX_ASSETS_PER_RUN = 500;

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 第 k 期所属月的月初（UTC 零点，date-only 契约）。 */
export function depreciationPeriodMonth(purchaseDate: Date, k: number): Date {
  return new Date(Date.UTC(purchaseDate.getUTCFullYear(), purchaseDate.getUTCMonth() + k, 1));
}

export type DepreciationSyncResult = {
  /** 本次新生成的期间数。 */
  created: number;
  /** 参与计算的资产数。 */
  assets: number;
};

type SyncParams = {
  householdId: string;
  /** 只补这一项（打开资产页/保存资产时用）；不传就是整个账簿。 */
  propertyAssetId?: string;
  /** 业务日期键；默认取账簿时区的今天。 */
  asOfDateKey?: string;
};

export async function syncPropertyAssetDepreciations(params: SyncParams): Promise<DepreciationSyncResult> {
  const key = params.propertyAssetId
    ? `property-depreciation:${params.householdId}:${params.propertyAssetId}`
    : `property-depreciation:${params.householdId}`;
  return runExclusive(
    key,
    () => syncInternal(params),
    () => ({ created: 0, assets: 0 }),
  );
}

async function syncInternal(params: SyncParams): Promise<DepreciationSyncResult> {
  const asOfDateKey = params.asOfDateKey ?? todayDateBusinessYmd(await getHouseholdTimeZone(params.householdId));
  const assets = await prisma.propertyAsset.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      status: "active",
      depreciationMethod: DepreciationMethod.straightLine,
      ...(params.propertyAssetId ? { id: params.propertyAssetId } : {}),
    },
    select: {
      id: true,
      cost: true,
      purchaseDate: true,
      status: true,
      depreciationMethod: true,
      usefulLifeMonths: true,
      salvageValue: true,
      accumulatedDepreciation: true,
    },
    take: MAX_ASSETS_PER_RUN,
  });

  let created = 0;
  for (const asset of assets) {
    try {
      created += await syncOneAsset(asset, params.householdId, asOfDateKey);
    } catch (error) {
      logger.error("property depreciation sync failed for asset", "property-depreciation", {
        householdId: params.householdId,
        propertyAssetId: asset.id,
        error,
      });
    }
  }
  return { created, assets: assets.length };
}

type AssetRow = {
  id: string;
  cost: unknown;
  purchaseDate: Date | null;
  status: string;
  depreciationMethod: string | null;
  usefulLifeMonths: number | null;
  salvageValue: unknown;
  accumulatedDepreciation: unknown;
};

async function syncOneAsset(asset: AssetRow, householdId: string, asOfDateKey: string): Promise<number> {
  if (!asset.purchaseDate) return 0;
  const dep = resolveAssetDepreciation(asset, asOfDateKey);
  if (dep.method !== DepreciationMethod.straightLine || dep.usefulLifeMonths <= 0) return 0;
  const base = dep.depreciableBase;
  if (base <= 0) return 0;
  const monthly = base / dep.usefulLifeMonths;
  if (monthly <= 0) return 0;

  const targetPeriods = Math.min(dep.monthsUsed, dep.usefulLifeMonths);
  if (targetPeriods <= 0) return 0;

  const existing = await prisma.propertyAssetDepreciation.findMany({
    where: { propertyAssetId: asset.id },
    select: { periodMonth: true, accumulatedAfter: true },
    orderBy: { periodMonth: "asc" },
  });
  const existingMonths = new Map(existing.map((row) => [row.periodMonth.getTime(), row.accumulatedAfter]));
  let accumulated = existing.length > 0
    ? Number(existing[existing.length - 1].accumulatedAfter)
    : 0;

  const rows: {
    householdId: string;
    propertyAssetId: string;
    periodMonth: Date;
    amount: number;
    accumulatedAfter: number;
    basisCost: number;
    basisSalvage: number;
    basisMonths: number;
    method: string;
  }[] = [];

  for (let k = 1; k <= targetPeriods; k += 1) {
    const periodMonth = depreciationPeriodMonth(asset.purchaseDate, k);
    const hit = existingMonths.get(periodMonth.getTime());
    if (hit != null) {
      accumulated = Number(hit);
      continue;
    }
    const remaining = round2(base - accumulated);
    if (remaining <= 0) break;
    const amount = round2(Math.min(monthly, remaining));
    if (amount <= 0) break;
    accumulated = round2(accumulated + amount);
    rows.push({
      householdId,
      propertyAssetId: asset.id,
      periodMonth,
      amount,
      accumulatedAfter: accumulated,
      basisCost: round2(Math.max(0, Number(asset.cost ?? 0))),
      basisSalvage: dep.salvageValue,
      basisMonths: dep.usefulLifeMonths,
      method: DepreciationMethod.straightLine,
    });
  }

  if (rows.length === 0) return 0;
  try {
    await prisma.propertyAssetDepreciation.createMany({ data: rows });
    return rows.length;
  } catch (error) {
    // 唯一键冲突（并发或历史重复）时不阻断：逐条补，能插的插进去。
    let inserted = 0;
    for (const row of rows) {
      try {
        await prisma.propertyAssetDepreciation.create({ data: row });
        inserted += 1;
      } catch {
        // 该期间已存在，跳过。
      }
    }
    if (inserted === 0) {
      logger.warn("property depreciation insert skipped", "property-depreciation", {
        propertyAssetId: asset.id,
        error,
      });
    }
    return inserted;
  }
}

/**
 * 台账累计折旧（不含手填的额外折损/减值）。可传入事务 client。
 *
 * `asOfPeriodMonth` 用于**处置 / 售出结算**：台账总是补到当前月，但结算日可能填在
 * 过去的月份（补记历史处置），不截断就会多算后面几期，账面净值偏低、损益虚高。
 * 传 `null` 表示「按 0 期」（购入未满一个月），不传表示全部期间。
 */
export async function recordedDepreciationTotal(
  propertyAssetId: string,
  client: Pick<typeof prisma, "propertyAssetDepreciation"> = prisma,
  asOfPeriodMonth?: Date | null,
): Promise<number> {
  if (asOfPeriodMonth === null) return 0;
  const aggregate = await client.propertyAssetDepreciation.aggregate({
    where: {
      propertyAssetId,
      ...(asOfPeriodMonth ? { periodMonth: { lte: asOfPeriodMonth } } : {}),
    },
    _sum: { amount: true },
  });
  return round2(Number(aggregate._sum.amount ?? 0));
}

/** 资产页展示用：台账期间的最近几笔。 */
export async function loadDepreciationLedger(propertyAssetId: string, take = 24) {
  return prisma.propertyAssetDepreciation.findMany({
    where: { propertyAssetId },
    orderBy: { periodMonth: "desc" },
    take,
    select: { id: true, periodMonth: true, amount: true, accumulatedAfter: true },
  });
}
