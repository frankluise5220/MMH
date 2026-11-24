import "server-only";

import { cache } from "react";
import { Prisma, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { compareDetailEntriesDesc } from "@/lib/detail-entry-order";
import { entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";

/**
 * 信用卡账单视图的**唯一**流水读取通道。
 *
 * 账单首屏原先各自裸查 `prisma.txRecord`：月份列表、当期明细、还款汇总、
 * 周期失效判定、`page.tsx` 的 all 模式，共 6~7 次命中同一批卡流水，彼此不共享
 * 任何缓存。这里收敛成「两段、共两次」读取：
 *
 * 1. **轻量全量**（`rows` / `activeRows`）：只取派生所需的标量列，不带任何关联。
 *    月份列表、当期筛选、还款汇总、周期失效判定、stale 判定、计数全部在内存里
 *    从这一份派生 —— 同一次渲染只读一次库。
 * 2. **精装子集**（`loadDetailRows` / `loadCycleDetailRows`）：标签 / 附件 / 业务
 *    关联 / 账户这些 5 组 `include` 只对**真正要展示的行**取（单月通常几十行，
 *    all 模式才是全量）。同一批 id 只补一次，结果在通道内复用。
 *
 * 其余约定：
 * - 用 React `cache()` 做请求内去重 —— `page.tsx` 与 `buildCreditBillPageData`
 *   在同一次渲染里拿到的是同一个对象，不会各查一遍；
 * - **故意不过滤 `deletedAt`**：周期缓存的 stale 判定依赖「含软删行的最新
 *   updatedAt」（删掉一笔流水后周期必须重算），明细 / 月份 / 计数用 `activeRows`；
 * - 不放进 `unstable_cache`：整卡行数大，跨请求缓存既超 Next 数据缓存条目上限，
 *   又需要完整的 tag 失效链，收益不抵风险。
 */
export const CREDIT_BILL_DETAIL_TAKE = 500;

/** 安全阀：单卡账单全量行的硬上限，防止异常账簿把内存打爆。 */
export const CREDIT_BILL_ENTRY_ROW_LIMIT = 50000;

/** 精装明细按 id 批量取的块大小（避免单个 `IN (...)` 撞绑定参数上限）。 */
const DETAIL_FETCH_CHUNK = 1000;

/** 账单明细口径的交易类型（与 `/api/v1/bill/details` 的历史口径一致）。 */
export const CREDIT_BILL_DETAIL_TYPES = [
  TransactionType.expense,
  TransactionType.income,
  TransactionType.transfer,
  TransactionType.investment,
] as const;

/**
 * 第一段：轻量列。除派生必需的日期 / 类型 / 金额 / 账户外，还包含
 * `compareDetailEntriesDesc` 依赖的排序字段（`dayOrder` / 基金与业务标记 /
 * `reconciledBalance` / 业务日期），否则内存排序会与精装行的表格排序不一致。
 */
const creditBillEntrySelectArgs = Prisma.validator<Prisma.TxRecordDefaultArgs>()({
  select: {
    id: true,
    date: true,
    postedAt: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    type: true,
    amount: true,
    accountId: true,
    toAccountId: true,
    categoryName: true,
    dayOrder: true,
    fundSubtype: true,
    fundProductType: true,
    source: true,
    toNote: true,
    reconciledBalance: true,
    fundConfirmDate: true,
    fundArrivalDate: true,
  },
});

export type CreditBillEntryRow = Prisma.TxRecordGetPayload<typeof creditBillEntrySelectArgs>;

/** 第二段：明细表真正渲染需要的关联（标签 / 附件 / 业务关联 / 两侧账户）。 */
const creditBillDetailArgs = Prisma.validator<Prisma.TxRecordDefaultArgs>()({
  include: {
    EntryTag: { include: { Tag: true } },
    Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
    ...entryBusinessLinkSummaryInclude,
    account: {
      include: {
        Institution: { select: { name: true, shortName: true } },
        AccountGroup: { select: { name: true } },
      },
    },
    toAccount: {
      include: {
        Institution: { select: { name: true, shortName: true } },
        AccountGroup: { select: { name: true } },
      },
    },
  },
});

export const creditBillEntryInclude = creditBillDetailArgs.include;

export type CreditBillDetailRow = Prisma.TxRecordGetPayload<typeof creditBillDetailArgs>;

/** 一期账单的筛选口径（生效日区间 + 类型 + 排序方向账户 + 行数上限）。 */
export type CreditBillCycleQuery = {
  start?: Date | null;
  end?: Date | null;
  /** 排序方向判定用的账户（`compareDetailEntriesDesc` 的第三参）。 */
  sortAccountId?: string | null;
  /** 只保留这些类型；不传 = 不限（all 模式）。 */
  types?: readonly (TransactionType | string)[];
  take?: number;
};

export type CreditBillEntryChannel = {
  /** 含软删行的全部流水（已按 `date desc, createdAt desc` 排序）。 */
  rows: CreditBillEntryRow[];
  /** 未删除行：明细、月份、计数用这一份。 */
  activeRows: CreditBillEntryRow[];
  /** 含软删行的最新 `updatedAt`：周期缓存 stale 判定的唯一依据。 */
  latestAnyUpdatedAt: Date | null;
  /** 未删除行数。 */
  activeCount: number;
  /** id → 轻量行。 */
  byId: Map<string, CreditBillEntryRow>;
  /**
   * 精装指定 id 的明细行（标签 / 附件 / 业务关联 / 账户）。
   * 只补齐缺失的 id，一次 SQL；返回顺序与入参一致。
   */
  loadDetailRows(ids: readonly string[]): Promise<CreditBillDetailRow[]>;
  /** 一期账单的明细行：筛选 → 生效日排序 → 截断 → 精装（只精装最后要展示的行）。 */
  loadCycleDetailRows(query?: CreditBillCycleQuery): Promise<CreditBillDetailRow[]>;
};

export const EMPTY_CREDIT_BILL_ENTRY_CHANNEL: CreditBillEntryChannel = {
  rows: [],
  activeRows: [],
  latestAnyUpdatedAt: null,
  activeCount: 0,
  byId: new Map(),
  loadDetailRows: async () => [],
  loadCycleDetailRows: async () => [],
};

/**
 * React `cache()` 的 key 是**参数相等性**，数组每次都是新引用，必须序列化成
 * 稳定的字符串（排序后 join），否则同一次渲染里两次调用会被当成两个 key。
 */
export function creditBillScopeKey(accountIds: readonly string[]): string {
  return [...new Set(accountIds)].sort().join(",");
}

function buildChannel(householdId: string, rows: CreditBillEntryRow[]): CreditBillEntryChannel {
  const activeRows: CreditBillEntryRow[] = [];
  const byId = new Map<string, CreditBillEntryRow>();
  let latestAnyUpdatedAt: Date | null = null;
  for (const row of rows) {
    byId.set(row.id, row);
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : null;
    if (updatedAt && (!latestAnyUpdatedAt || updatedAt > latestAnyUpdatedAt)) {
      latestAnyUpdatedAt = updatedAt;
    }
    if (!row.deletedAt) activeRows.push(row);
  }

  const detailById = new Map<string, CreditBillDetailRow>();
  // 串行化：并发请求不同批次时后一批会等前一批落库再补，避免同一批 id 查两遍。
  let queue: Promise<void> = Promise.resolve();

  const loadDetailRows = (ids: readonly string[]): Promise<CreditBillDetailRow[]> => {
    const unique = [...new Set(ids)];
    const run = queue.then(async () => {
      const missing = unique.filter((id) => !detailById.has(id));
      // 分块：all 模式可能一次要几万个 id，单个 `IN (...)` 会撞上 PostgreSQL 的
      // 绑定参数上限。
      for (let index = 0; index < missing.length; index += DETAIL_FETCH_CHUNK) {
        const chunk = missing.slice(index, index + DETAIL_FETCH_CHUNK);
        const fetched = await prisma.txRecord.findMany({
          where: { id: { in: chunk }, householdId },
          include: creditBillEntryInclude,
        });
        for (const row of fetched) detailById.set(row.id, row);
      }
    });
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() =>
      unique
        .map((id) => detailById.get(id))
        .filter((row): row is CreditBillDetailRow => !!row),
    );
  };

  return {
    rows,
    activeRows,
    latestAnyUpdatedAt,
    activeCount: activeRows.length,
    byId,
    loadDetailRows,
    loadCycleDetailRows: async (query = {}) => {
      const picked = selectCreditBillCycleRows(activeRows, query);
      return loadDetailRows(picked.map((row) => row.id));
    },
  };
}

/**
 * 读取一张卡（含副卡组）的全部账单流水（轻量列）。同一次请求内对同一
 * `householdId + accountIdsKey` 只执行一次 SQL。
 */
export const loadCreditBillEntryChannel = cache(
  async (householdId: string, accountIdsKey: string): Promise<CreditBillEntryChannel> => {
    const accountIds = accountIdsKey.split(",").filter(Boolean);
    if (!householdId || accountIds.length === 0) return EMPTY_CREDIT_BILL_ENTRY_CHANNEL;

    const rows = await prisma.txRecord.findMany({
      where: {
        householdId,
        ...txRecordAccountScopeWhere(accountIds),
      },
      ...creditBillEntrySelectArgs,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: CREDIT_BILL_ENTRY_ROW_LIMIT,
    });

    return buildChannel(householdId, rows);
  },
);

/**
 * 行的「生效日」：支出 / 收入的记账日优先（`postedAt`），缺失时回退交易日期；
 * 转账 / 投资等其他类型直接取交易日期。与 `creditBillDateRangeWhere` 同一口径。
 */
export function creditBillEntryEffectiveDate(row: {
  type: TransactionType | string;
  date: Date;
  postedAt?: Date | null;
}): Date | null {
  if (row.type === TransactionType.expense || row.type === TransactionType.income) {
    const postedAt = row.postedAt instanceof Date ? row.postedAt : null;
    if (postedAt) return postedAt;
  }
  return row.date instanceof Date ? row.date : null;
}

/**
 * 从通道里筛出一期账单的行（不排序、不截断）：
 * 未删除 + 类型命中 + 生效日落在一期内。
 *
 * 三分支（支出/收入按 postedAt、支出/收入无 postedAt 按 date、其他类型按 date）
 * 是 Prisma 无法用单个 COALESCE 排序造成的，这里在内存里按同一口径合并。
 */
export function filterCreditBillCycleRows(
  rows: readonly CreditBillEntryRow[],
  options: CreditBillCycleQuery = {},
): CreditBillEntryRow[] {
  const { start = null, end = null, types } = options;
  const startMs = start ? start.getTime() : null;
  const endExclusiveMs = end ? end.getTime() : null;
  const typeSet = types ? new Set<string>(types as readonly string[]) : null;

  const picked: CreditBillEntryRow[] = [];
  for (const row of rows) {
    if (row.deletedAt) continue;
    if (typeSet && !typeSet.has(row.type)) continue;
    const effective = creditBillEntryEffectiveDate(row);
    if (!effective) continue;
    const ms = effective.getTime();
    if (startMs !== null && ms < startMs) continue;
    if (endExclusiveMs !== null && ms >= endExclusiveMs) continue;
    picked.push(row);
  }
  return picked;
}

/** 上面 + 生效日排序 + `take` 行封顶（账单明细表口径，轻量行）。 */
export function selectCreditBillCycleRows(
  rows: readonly CreditBillEntryRow[],
  options: CreditBillCycleQuery = {},
): CreditBillEntryRow[] {
  const { sortAccountId = null, take = CREDIT_BILL_DETAIL_TAKE } = options;
  const takeLimit = take > 0 ? take : CREDIT_BILL_DETAIL_TAKE;
  return filterCreditBillCycleRows(rows, options)
    .sort((a, b) => compareDetailEntriesDesc(a, b, sortAccountId))
    .slice(0, takeLimit);
}
