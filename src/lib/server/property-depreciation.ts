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

  // 只看自动计提的行：手工登记（折损 / 减值）混在同一张表里，混进来会污染
  // 「上一期累计」并把手工金额当成自动基数，等于把折损算两遍。
  const existing = await prisma.propertyAssetDepreciation.findMany({
    where: { propertyAssetId: asset.id, method: DepreciationMethod.straightLine },
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

/** 手工登记的折损 / 减值在台账里的 `method` 值（与自动计提区分）。 */
export const MANUAL_DEPRECIATION_METHOD = "manual";

/**
 * 自动计提的累计折旧（不含手工登记的折损/减值）。可传入事务 client。
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
      method: DepreciationMethod.straightLine,
      ...(asOfPeriodMonth ? { periodMonth: { lte: asOfPeriodMonth } } : {}),
    },
    _sum: { amount: true },
  });
  return round2(Number(aggregate._sum.amount ?? 0));
}

/** 手工登记的折损合计（同步落在 PropertyAsset.accumulatedDepreciation 上）。 */
export async function recordedManualDepreciationTotal(
  propertyAssetId: string,
  client: Pick<typeof prisma, "propertyAssetDepreciation"> = prisma,
): Promise<number> {
  const aggregate = await client.propertyAssetDepreciation.aggregate({
    where: { propertyAssetId, method: MANUAL_DEPRECIATION_METHOD },
    _sum: { amount: true },
  });
  return round2(Number(aggregate._sum.amount ?? 0));
}

/** 资产页展示用：台账期间的最近几笔（自动 + 手工）。 */
export async function loadDepreciationLedger(propertyAssetId: string, take = 24) {
  return prisma.propertyAssetDepreciation.findMany({
    where: { propertyAssetId },
    orderBy: [{ periodMonth: "desc" }, { createdAt: "desc" }],
    take,
    select: { id: true, periodMonth: true, amount: true, accumulatedAfter: true, method: true, note: true },
  });
}

/** 手工折旧台账的错误：路由直接按 status 映射 4xx，不要把用户输入问题报成 500。 */
export class ManualDepreciationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ManualDepreciationError";
  }
}

/**
 * 手工登记的「所属月」：存该月**最后一天**（UTC 零点）。
 *
 * 自动计提落在月初，手工记录落在月末，这样同一月既有自动计提又有手工折损时
 * 不会撞 @@unique(propertyAssetId, periodMonth)；展示一律按 YYYY-MM。
 */
export function manualDepreciationPeriodMonth(dateKey: string): Date {
  const raw = String(dateKey ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const date = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ManualDepreciationError("折损日期无效");
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

/**
 * 登记一笔手工折损 / 减值（2026-11-18 用户裁定：手工也要能记明细）。
 *
 * 同一个月再登记时累加到那条记录上（一个月一条，避免同月多条把展示搞乱），
 * 说明文字用「；」串起来。登记后把手工合计写回 `accumulatedDepreciation`：
 * - `none` 模式 → 它就是累计折旧（`resolveAssetDepreciation` 直接读它）；
 * - `straight_line` 模式 → 它是「额外折损」，叠加在自动计提之上。
 * 合计封顶成本，不允许把净值折成负数。
 */
export async function addManualDepreciation(params: {
  householdId: string;
  propertyAssetId: string;
  periodDateKey: string;
  amount: number;
  note?: string | null;
}) {
  const periodMonth = manualDepreciationPeriodMonth(params.periodDateKey);
  const requested = round2(Math.max(0, Number(params.amount) || 0));
  if (requested <= 0) throw new ManualDepreciationError("折损金额必须大于 0");

  return prisma.$transaction(async (tx) => {
    const asset = await tx.propertyAsset.findFirst({
      where: { id: params.propertyAssetId, householdId: params.householdId, deletedAt: null },
      select: { id: true, cost: true, salvageValue: true, usefulLifeMonths: true, status: true },
    });
    if (!asset) throw new ManualDepreciationError("资产不存在或不属于当前账簿", 404);
    if (asset.status !== "active") {
      throw new ManualDepreciationError("已售出 / 已处置的资产不能再登记折损（折旧已在结算时定格）", 409);
    }

    const cost = round2(Math.max(0, Number(asset.cost ?? 0)));
    const previous = await recordedManualDepreciationTotal(asset.id, tx);
    const capacity = round2(Math.max(0, cost - previous));
    if (capacity <= 0) throw new ManualDepreciationError("累计折损已达成本，不能再登记");
    const applied = round2(Math.min(requested, capacity));
    const settled = round2(previous + applied);
    const note = String(params.note ?? "").trim() || null;

    const existing = await tx.propertyAssetDepreciation.findFirst({
      where: { propertyAssetId: asset.id, periodMonth, method: MANUAL_DEPRECIATION_METHOD },
      select: { id: true, amount: true, note: true },
    });
    const record = existing
      ? await tx.propertyAssetDepreciation.update({
          where: { id: existing.id },
          data: {
            amount: round2(Number(existing.amount) + applied),
            accumulatedAfter: settled,
            note: [existing.note, note].filter(Boolean).join("；") || null,
            basisCost: cost,
            basisSalvage: round2(Math.max(0, Number(asset.salvageValue ?? 0))),
            basisMonths: Math.max(0, Math.round(Number(asset.usefulLifeMonths ?? 0))),
          },
          select: { id: true, periodMonth: true, amount: true, accumulatedAfter: true, method: true, note: true },
        })
      : await tx.propertyAssetDepreciation.create({
          data: {
            householdId: params.householdId,
            propertyAssetId: asset.id,
            periodMonth,
            amount: applied,
            accumulatedAfter: settled,
            basisCost: cost,
            basisSalvage: round2(Math.max(0, Number(asset.salvageValue ?? 0))),
            basisMonths: Math.max(0, Math.round(Number(asset.usefulLifeMonths ?? 0))),
            method: MANUAL_DEPRECIATION_METHOD,
            note,
          },
          select: { id: true, periodMonth: true, amount: true, accumulatedAfter: true, method: true, note: true },
        });

    await tx.propertyAsset.update({
      where: { id: asset.id },
      data: { accumulatedDepreciation: String(settled) },
    });

    return { record, settled, applied, capped: applied < requested };
  });
}

/** 删除一条手工折损记录并重算资产上的累计折旧；自动计提的行不允许删。 */
export async function deleteManualDepreciation(params: {
  householdId: string;
  propertyAssetId: string;
  id: string;
}) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.propertyAssetDepreciation.findFirst({
      where: { id: params.id, propertyAssetId: params.propertyAssetId, householdId: params.householdId },
      select: { id: true, method: true },
    });
    if (!row) throw new ManualDepreciationError("折损记录不存在", 404);
    if (row.method !== MANUAL_DEPRECIATION_METHOD) {
      throw new ManualDepreciationError("自动计提的折旧记录由系统维护，不能删除", 409);
    }
    const asset = await tx.propertyAsset.findFirst({
      where: { id: params.propertyAssetId, householdId: params.householdId, deletedAt: null },
      select: { id: true, status: true },
    });
    if (!asset) throw new ManualDepreciationError("资产不存在或不属于当前账簿", 404);
    if (asset.status !== "active") {
      throw new ManualDepreciationError("已售出 / 已处置的资产不能改折损记录", 409);
    }
    await tx.propertyAssetDepreciation.delete({ where: { id: row.id } });
    const remaining = await recordedManualDepreciationTotal(asset.id, tx);
    await tx.propertyAsset.update({
      where: { id: asset.id },
      data: { accumulatedDepreciation: String(remaining) },
    });
    return { settled: remaining };
  });
}
