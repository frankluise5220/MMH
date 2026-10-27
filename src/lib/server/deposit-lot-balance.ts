import { prisma } from "@/lib/db/prisma";
import { formatDateUtc } from "@/lib/date-utils";

export function depositCalendarDate(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return formatDateUtc(value);
}

export function isDepositRedemptionDateAllowed(
  redemptionDate: Date,
  latestInterestDate: Date | null,
): boolean {
  const redemptionKey = depositCalendarDate(redemptionDate);
  const latestInterestKey = depositCalendarDate(latestInterestDate);
  return !redemptionKey || !latestInterestKey || redemptionKey >= latestInterestKey;
}

type DepositLotBalance = {
  originalPrincipal: number;
  redeemedPrincipal: number;
  remainingPrincipal: number;
  settled: boolean;
};

export async function loadLatestDepositInterestDate(params: {
  householdId: string;
  lotId: string;
  client?: any;
}): Promise<Date | null> {
  const client = params.client ?? prisma;
  const lot = await client.txRecord.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
    },
    select: {
      toAccountId: true,
      fundName: true,
      fundCode: true,
      date: true,
      fundArrivalDate: true,
    },
  });
  if (!lot) return null;

  const latest = await client.txRecord.aggregate({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      depositSourceEntryId: params.lotId,
      source: "deposit",
      type: "income",
    },
    _max: { date: true },
  });
  const lotName = (lot.fundName ?? lot.fundCode ?? "").trim();
  let legacyDate: Date | null = null;
  if (lot.toAccountId && lotName) {
    const legacyRows = await client.txRecord.findMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        source: "deposit",
        type: "income",
        accountId: lot.toAccountId,
        date: {
          gte: lot.date,
          ...(lot.fundArrivalDate ? { lte: lot.fundArrivalDate } : {}),
        },
        depositSourceEntryId: null,
        note: { contains: lotName },
      },
      select: { date: true },
      orderBy: { date: "desc" },
      take: 1,
    });
    legacyDate = legacyRows[0]?.date ?? null;
  }
  if (!latest._max.date) return legacyDate;
  if (!legacyDate) return latest._max.date;
  return depositCalendarDate(latest._max.date)! >= depositCalendarDate(legacyDate)!
    ? latest._max.date
    : legacyDate;
}

type DepositAmountRow = {
  fundArrivalAmount?: unknown;
  amount?: unknown;
  depositInterest?: unknown;
};

function numericValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function depositLotOriginalPrincipal(lot: DepositAmountRow): number {
  return Math.max(0, Math.abs(numericValue(lot.fundArrivalAmount ?? lot.amount)));
}

export function depositRedemptionPrincipal(entry: DepositAmountRow): number {
  const arrivalAmount = Math.abs(numericValue(entry.fundArrivalAmount ?? entry.amount));
  const interest = Math.max(0, numericValue(entry.depositInterest));
  return Math.max(0, arrivalAmount - interest);
}

const DEPOSIT_LOT_DIVIDEND_SUBTYPES = new Set(["dividend_cash", "dividend_reinvest"]);
const DEPOSIT_LOT_REDEMPTION_SUBTYPES = new Set(["redeem", "switch_out"]);

function depositLotName(entry: { fundName?: string | null; fundCode?: string | null }) {
  // 兜底名必须与「取回行」用同一份原始字符串：两边都为空时 key 相同，不能带任何
  // 本地化占位文案，否则同一张存单的存入行和取回行会算出两个不同的 key。
  return (entry.fundName ?? entry.fundCode ?? "").trim();
}

function depositLotBucketKey(
  depositAccountId: string,
  entry: { fundName?: string | null; fundCode?: string | null; fundArrivalDate?: Date | null },
  dateKey: (value: Date) => string | null,
) {
  const maturityKey = entry.fundArrivalDate ? dateKey(entry.fundArrivalDate) ?? "" : "";
  return `${depositAccountId}\u001f${depositLotName(entry)}\u001f${maturityKey}`;
}

export type DepositCashValueEntry = {
  id: string;
  date: Date;
  deletedAt?: Date | null;
  fundSubtype?: string | null;
  fundName?: string | null;
  fundCode?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  amount?: unknown;
  fundArrivalAmount?: unknown;
  depositInterest?: unknown;
  fundArrivalDate?: Date | null;
  depositSourceEntryId?: string | null;
};

export type DepositCashValueLot = {
  lotId: string;
  depositAccountId: string;
  remainingPrincipal: number;
};

/**
 * 存款账户余额的**唯一口径**：余额就是存单的现金价值，即该账户下未结清存单的
 * 剩余本金合计。
 *
 * 与存款视图「持有/失效」列表（`buildDepositLots`）共用同一套算法，避免两处各自
 * 演化出「表里有存单余额对不上」「没有存单却有余额」：
 * - 日期边界一致：只统计生效日（存入日）≤ asOfKey 的行，未来的取回不会提前把
 *   今天的本金扣掉；
 * - 取回匹配一致：优先按 `depositSourceEntryId` 关联到存单，缺失关联的旧数据按
 *   「存款账户 + 产品名 + 到期日」兜底扣减；
 * - 利息/取息行既不开存单也不关存单，只作为现金流存在。
 *
 * 存款账户上的普通收支（转账、利息收入等）**不参与**这里的余额 —— 那些钱没有
 * 对应的存单，混进来就会出现「没有存单却有余额」。
 */
export function computeDepositCashValueByAccount(params: {
  entries: readonly DepositCashValueEntry[];
  /** 业务日 YYYY-MM-DD，含当天。 */
  asOfKey: string;
  /** 参与统计的存款账户；缺省表示不限制账户。 */
  accountIds?: Iterable<string>;
  dateKey?: (value: Date) => string | null;
}): { byAccountId: Map<string, number>; lots: DepositCashValueLot[] } {
  const dateKey = params.dateKey ?? depositCalendarDate;
  const scope = params.accountIds ? new Set(params.accountIds) : null;
  const inScope = (accountId: string | null | undefined): accountId is string =>
    !!accountId && (!scope || scope.has(accountId));

  const live = params.entries
    .filter((entry) => !entry.deletedAt)
    .filter((entry) => {
      const key = dateKey(entry.date);
      return key != null && key <= params.asOfKey;
    })
    .sort((left, right) => {
      const leftKey = dateKey(left.date) ?? "";
      const rightKey = dateKey(right.date) ?? "";
      return leftKey.localeCompare(rightKey) || left.id.localeCompare(right.id);
    });

  const lots: DepositCashValueLot[] = [];
  const lotBuckets = new Map<string, DepositCashValueLot[]>();

  for (const entry of live) {
    const subtype = entry.fundSubtype ?? "";
    if (DEPOSIT_LOT_DIVIDEND_SUBTYPES.has(subtype)) continue;
    if (DEPOSIT_LOT_REDEMPTION_SUBTYPES.has(subtype)) continue;
    if (!inScope(entry.toAccountId)) continue;
    const lot: DepositCashValueLot = {
      lotId: entry.id,
      depositAccountId: entry.toAccountId,
      remainingPrincipal: depositLotOriginalPrincipal(entry),
    };
    lots.push(lot);
    const key = depositLotBucketKey(lot.depositAccountId, entry, dateKey);
    const bucket = lotBuckets.get(key);
    if (bucket) bucket.push(lot);
    else lotBuckets.set(key, [lot]);
  }

  // 第二遍扣减：取回可能早于存入行的展示排序（提前取回时按到期日排序会把存入行
  // 排到后面），所以必须先建完所有存单再扣。
  for (const entry of live) {
    if (!DEPOSIT_LOT_REDEMPTION_SUBTYPES.has(entry.fundSubtype ?? "")) continue;
    if (!inScope(entry.accountId)) continue;
    const amount = depositRedemptionPrincipal(entry);
    if (amount <= 0) continue;
    const linked = entry.depositSourceEntryId
      ? lots.find((lot) => lot.lotId === entry.depositSourceEntryId)
      : undefined;
    const bucket = linked
      ? [linked]
      : lotBuckets.get(depositLotBucketKey(entry.accountId, entry, dateKey)) ?? [];
    for (const lot of bucket) {
      if (lot.remainingPrincipal <= 0) continue;
      lot.remainingPrincipal = Math.max(
        0,
        Number((lot.remainingPrincipal - amount).toFixed(2)),
      );
      break;
    }
  }

  const byAccountId = new Map<string, number>();
  for (const accountId of scope ?? []) byAccountId.set(accountId, 0);
  for (const lot of lots) {
    const current = byAccountId.get(lot.depositAccountId) ?? 0;
    byAccountId.set(
      lot.depositAccountId,
      Number((current + lot.remainingPrincipal).toFixed(2)),
    );
  }
  return { byAccountId, lots };
}

export async function loadDepositLotBalance(params: {
  householdId: string;
  lotId: string;
  excludeEntryId?: string | null;
  client?: any;
}): Promise<DepositLotBalance | null> {
  const client = params.client ?? prisma;
  const lot = await client.txRecord.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
    },
    select: { amount: true, fundArrivalAmount: true },
  });
  if (!lot) return null;

  const redemptions = await client.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      depositSourceEntryId: params.lotId,
      fundSubtype: { in: ["redeem", "switch_out"] },
      ...(params.excludeEntryId ? { id: { not: params.excludeEntryId } } : {}),
    },
    select: { amount: true, fundArrivalAmount: true, depositInterest: true },
  });
  const originalPrincipal = depositLotOriginalPrincipal(lot);
  const redeemedPrincipal = redemptions.reduce(
    (total, entry) => total + depositRedemptionPrincipal(entry),
    0,
  );
  const remainingPrincipal = Math.max(0, Number((originalPrincipal - redeemedPrincipal).toFixed(2)));
  return {
    originalPrincipal,
    redeemedPrincipal: Number(redeemedPrincipal.toFixed(2)),
    remainingPrincipal,
    settled: remainingPrincipal <= 0.0001,
  };
}
