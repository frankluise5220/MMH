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

/**
 * 一张存单的分桶键候选，**按身份精度从高到低**：
 *   产品 id → 产品代码 → 产品名 → 空串
 *
 * 为什么不是单键：
 * - 身份精度：实测开发库 50 行存款的 `fundName`、`fundCode` 全是 null，键里的名称段
 *   一直是空串，同一存款账户 + 同一到期日的两张不同产品存单会落进同一个 bucket，
 *   取回时被扣到错误的存单上。`depositProductId`（多数行有值）才能真正区分它们。
 * - 兼容：存入行和取回行的字段并不总是齐平（一侧有 id、另一侧只有名字），单键会让
 *   同一张存单的两侧算出不同 key，剩余本金扣不掉、余额虚高。所以注册时把每个候选
 *   都挂一份，查找时按精度逐个试，先命中先用。
 *
 * 名称只作为最后的兜底，永远排在 id 和代码之后 —— 名称会随改名变化，id 和代码不会。
 */
function depositLotBucketKeys(
  depositAccountId: string,
  entry: {
    depositProductId?: string | null;
    fundName?: string | null;
    fundCode?: string | null;
    fundArrivalDate?: Date | null;
  },
  dateKey: (value: Date) => string | null,
): string[] {
  const maturityKey = entry.fundArrivalDate ? dateKey(entry.fundArrivalDate) ?? "" : "";
  const identities = [entry.depositProductId, entry.fundCode, entry.fundName, ""]
    .map((value) => (value ?? "").trim())
    .filter((value, index, all) => all.indexOf(value) === index);
  return identities.map((identity) => `${depositAccountId}\u001f${identity}\u001f${maturityKey}`);
}

export type DepositCashValueEntry = {
  id: string;
  date: Date;
  deletedAt?: Date | null;
  fundSubtype?: string | null;
  fundName?: string | null;
  fundCode?: string | null;
  /** 存单所属存款产品 id：分桶的首选身份。名称和代码在实测数据里都是 null，只有它能稳定区分同账户同到期日的不同产品存单。 */
  depositProductId?: string | null;
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
  /** 扣减到这张存单上的取回 / 转出行 id（存单故事的组成部分）。 */
  redemptionEntryIds: string[];
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
 *   「存款账户 + 产品 id / 代码（名称仅作最后兜底）+ 到期日」分桶扣减；
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
      redemptionEntryIds: [],
    };
    lots.push(lot);
    // 每个身份的键都挂一份，让对侧行无论缺 id、缺代码还是缺名字都能命中同一张存单。
    for (const key of depositLotBucketKeys(lot.depositAccountId, entry, dateKey)) {
      const bucket = lotBuckets.get(key);
      if (bucket) bucket.push(lot);
      else lotBuckets.set(key, [lot]);
    }
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
    // 没有显式关联的老数据：按身份精度从高到低找第一个非空桶，命中即用。
    let bucket: DepositCashValueLot[] = linked ? [linked] : [];
    if (!linked) {
      for (const key of depositLotBucketKeys(entry.accountId, entry, dateKey)) {
        const found = lotBuckets.get(key);
        if (found && found.length > 0) {
          bucket = found;
          break;
        }
      }
    }
    for (const lot of bucket) {
      if (lot.remainingPrincipal <= 0) continue;
      lot.remainingPrincipal = Math.max(
        0,
        Number((lot.remainingPrincipal - amount).toFixed(2)),
      );
      lot.redemptionEntryIds.push(entry.id);
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
