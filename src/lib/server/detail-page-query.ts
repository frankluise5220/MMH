import { Prisma } from "@prisma/client";

import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  BALANCE_RECONCILE_TARGET_PREFIX,
} from "@/lib/balance-reconcile";
import { formatDateLocal } from "@/lib/date-utils";
import { isLoanOrSettlementAccountKind } from "@/lib/liability";
import { prisma } from "@/lib/db/prisma";

const FX_CONVERSION_SOURCE = "fx_conversion";

export type DetailPageQueryArgs = {
  accountIds: string[];
  householdId: string;
  page: number;
  pageSize: number;
  sortAccountId?: string | null;
  includeRunningBalances?: boolean;
};

export type DetailPageQueryResult = {
  totalCount: number;
  page: number;
  pageIds: string[];
  runningBalanceById: Record<string, number>;
};

function normalizedAccountIds(accountIds: string[]) {
  return Array.from(new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

function accountScopeSql(accountIds: string[]) {
  const ids = Prisma.join(accountIds);
  return Prisma.sql`
    (
      t."accountId" IN (${ids})
      OR (
        t."toAccountId" IN (${ids})
        AND (t."source" IS NULL OR t."source" <> ${FX_CONVERSION_SOURCE})
      )
    )
  `;
}

function buildOrderingCtesSql(args: {
  accountIds: string[];
  householdId: string;
  sortAccountId?: string | null;
  /** 排序账户是贷款 / 往来款时，余额折叠走本金口径（见 liabilityPrincipalForAccountSide）。 */
  liabilityAccountMode?: boolean;
}) {
  const { accountIds, householdId, sortAccountId, liabilityAccountMode = false } = args;
  const sortAccountIdValue = sortAccountId ?? null;
  // 账户余额口径（account-balance.ts 的 isOnOrBeforeToday）以「今天」为截止，
  // 明细「余额」列必须用同一个截止日，否则未来日期的流水会把列表顶部的余额
  // 推到账户余额之外（例：借记卡页头 -89,161.66，列表首行却是 -49,161.66）。
  const todayKey = formatDateLocal(new Date());
  const accountScope = accountScopeSql(accountIds);
  const scopedColumns = Prisma.sql`
    t."id",
    t."date",
    t."postedAt",
    t."createdAt",
    t."dayOrder",
    t."type",
    t."amount",
    t."accountId",
    t."toAccountId",
    t."toNote",
    t."source",
    t."principalAmount",
    t."fundProductType",
    t."fundSubtype",
    t."fundArrivalDate",
    t."fundArrivalAmount",
    t."reconciledBalance"
  `;
  const scopedSource = Prisma.sql`
    FROM "transactions" t
    WHERE t."deletedAt" IS NULL
      AND t."householdId" = ${householdId}
      AND ${accountScope}
  `;
  // 明细排序用的「生效日」。基金独立交易的 TxRecord 被有意清空了
  // fundSubtype / fundArrivalDate（业务事实只存在 fund_transactions，见
  // transactions/detail 的 isFundLikeIndependentEdit 分支），而展示层一直用
  // FundTransaction 覆盖这几列。排序层此前没有这份兜底，于是「到账日 10-08」的
  // 赎回行会退化成按 date（申请日）排序。这里把基金和理财两类业务行都 JOIN 进来，
  // 与展示层口径对齐。多账户（sortAccountId 为空）时按视图账户集合匹配资金账户。
  // 注意：只能用 CAST(... AS ...)，不能写 PG 专有的双冒号 —— fnOS / 群晖 包跑的是
  // SQLite（DATABASE_URL=file:.../mmh.db），双冒号会让整条 SQL 语法报错
  // （unrecognized token ":"），整页 500。
  const scopedCtes = Prisma.sql`
        "scoped_base" AS (
          SELECT ${scopedColumns}
          ${scopedSource}
        ),
        "wealth_candidates" AS (
          SELECT
            s."id" AS "entryId",
            w."action" AS "wealthAction",
            w."arrivalDate" AS "wealthArrivalDate",
            w."cashAccountId" AS "wealthCashAccountId",
            0 AS "priority",
            l."id" AS "linkId"
          FROM "scoped_base" s
          INNER JOIN "entry_business_links" l
            ON l."cashEntryId" = s."id"
            AND l."deletedAt" IS NULL
            AND l."wealthTransactionId" IS NOT NULL
          INNER JOIN "wealth_transactions" w
            ON w."id" = l."wealthTransactionId"
            AND w."deletedAt" IS NULL
            AND w."householdId" = ${householdId}
          WHERE s."type" = 'investment'
          UNION ALL
          SELECT
            s."id" AS "entryId",
            w."action" AS "wealthAction",
            w."arrivalDate" AS "wealthArrivalDate",
            w."cashAccountId" AS "wealthCashAccountId",
            1 AS "priority",
            l."id" AS "linkId"
          FROM "scoped_base" s
          INNER JOIN "entry_business_links" l
            ON l."businessEntryId" = s."id"
            AND l."deletedAt" IS NULL
            AND l."wealthTransactionId" IS NOT NULL
          INNER JOIN "wealth_transactions" w
            ON w."id" = l."wealthTransactionId"
            AND w."deletedAt" IS NULL
            AND w."householdId" = ${householdId}
          WHERE s."type" = 'investment'
        ),
        "fund_candidates" AS (
          SELECT
            s."id" AS "entryId",
            f."fundSubtype" AS "fundSubtype",
            f."arrivalDate" AS "fundArrivalDate",
            f."cashAccountId" AS "fundCashAccountId",
            0 AS "priority",
            l."id" AS "linkId"
          FROM "scoped_base" s
          INNER JOIN "entry_business_links" l
            ON l."cashEntryId" = s."id"
            AND l."deletedAt" IS NULL
            AND l."fundTransactionId" IS NOT NULL
          INNER JOIN "fund_transactions" f
            ON f."id" = l."fundTransactionId"
            AND f."deletedAt" IS NULL
            AND f."householdId" = ${householdId}
          WHERE s."type" = 'investment'
          UNION ALL
          SELECT
            s."id" AS "entryId",
            f."fundSubtype" AS "fundSubtype",
            f."arrivalDate" AS "fundArrivalDate",
            f."cashAccountId" AS "fundCashAccountId",
            1 AS "priority",
            l."id" AS "linkId"
          FROM "scoped_base" s
          INNER JOIN "entry_business_links" l
            ON l."businessEntryId" = s."id"
            AND l."deletedAt" IS NULL
            AND l."fundTransactionId" IS NOT NULL
          INNER JOIN "fund_transactions" f
            ON f."id" = l."fundTransactionId"
            AND f."deletedAt" IS NULL
            AND f."householdId" = ${householdId}
          WHERE s."type" = 'investment'
        ),
        "wealth_ranked" AS (
          SELECT
            wc.*,
            ROW_NUMBER() OVER (
              PARTITION BY wc."entryId"
              ORDER BY wc."priority" ASC, wc."linkId" ASC
            ) AS "rank"
          FROM "wealth_candidates" wc
        ),
        "fund_ranked" AS (
          SELECT
            fc.*,
            ROW_NUMBER() OVER (
              PARTITION BY fc."entryId"
              ORDER BY fc."priority" ASC, fc."linkId" ASC
            ) AS "rank"
          FROM "fund_candidates" fc
        ),
        "scoped" AS (
          SELECT
            s.*,
            r."wealthAction",
            r."wealthArrivalDate",
            r."wealthCashAccountId",
            fr."fundSubtype" AS "linkedFundSubtype",
            fr."fundArrivalDate" AS "linkedFundArrivalDate",
            fr."fundCashAccountId" AS "linkedFundCashAccountId"
          FROM "scoped_base" s
          LEFT JOIN "wealth_ranked" r
            ON r."entryId" = s."id"
            AND r."rank" = 1
          LEFT JOIN "fund_ranked" fr
            ON fr."entryId" = s."id"
            AND fr."rank" = 1
        )
      `;

  // 资金账户一侧的匹配口径：
  // - 单账户明细（sortAccountId 有值）：这笔钱的收款账户必须就是当前账户；
  // - 多账户明细（全部收支记录，sortAccountId 为空）：收款账户在视图账户集合内即可。
  const accountIdListSql = accountIds.length > 0 ? Prisma.join(accountIds) : Prisma.sql`NULL`;
  const cashSideMatchSql = sortAccountIdValue
    ? Prisma.sql`= CAST(${sortAccountIdValue} AS TEXT)`
    : Prisma.sql`IN (${accountIdListSql})`;
  const linkedBusinessSubtypeSql = Prisma.sql`COALESCE(s."linkedFundSubtype", s."wealthAction", s."fundSubtype")`;
  const linkedBusinessArrivalSql = Prisma.sql`COALESCE(s."linkedFundArrivalDate", s."wealthArrivalDate", s."fundArrivalDate")`;
  const linkedBusinessCashAccountSql = Prisma.sql`COALESCE(s."linkedFundCashAccountId", s."wealthCashAccountId", s."toAccountId")`;
  // "classified" 之后的 CTE 里行别名是 c，同一份口径再写一遍。
  const classifiedSubtypeSql = Prisma.sql`COALESCE(c."linkedFundSubtype", c."wealthAction", c."fundSubtype")`;
  const classifiedCashAccountSql = Prisma.sql`COALESCE(c."linkedFundCashAccountId", c."wealthCashAccountId", c."toAccountId")`;

  // 每笔流水对「余额」列的贡献。必须与 account-balance.ts 的 foldBalanceEntry 逐条对齐，
  // 否则明细余额列会与账户余额不一致。
  const effectiveAmountCase = liabilityAccountMode
    ? Prisma.sql`
          WHEN c."isAnchor" = 1 THEN 0
          WHEN CAST(DATE(
            CASE
              WHEN c."type" = 'investment'
                AND c."fundProductType" = 'deposit'
                AND c."fundSubtype" = 'buy'
                AND c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
                THEN COALESCE(c."fundArrivalDate", c."displayAt")
              ELSE c."displayAt"
            END
          ) AS TEXT) > ${todayKey} THEN 0
          -- 贷款 / 往来款：只有 transfer 腿参与，且本金带 source 决定的正负号。
          -- Mirrors liabilityPrincipalForAccountSide in src/lib/liability.ts.
          WHEN c."type" <> 'transfer' THEN 0
          WHEN c."source" IN ('liability_borrow_in', 'liability_financed_purchase') THEN -COALESCE(c."principalAmount", ABS(c."amount"))
          WHEN c."source" IN ('liability_repay_out', 'liability_prepay_out') THEN COALESCE(c."principalAmount", ABS(c."amount"))
          WHEN c."source" = 'liability_lend_out' THEN COALESCE(c."principalAmount", ABS(c."amount"))
          WHEN c."source" = 'liability_collect_in' THEN -COALESCE(c."principalAmount", ABS(c."amount"))
          WHEN c."source" = 'scheduled_task' THEN COALESCE(c."principalAmount", ABS(c."amount"))
          WHEN c."source" = 'reimbursement' THEN -COALESCE(c."principalAmount", ABS(c."amount"))
          WHEN c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT) THEN COALESCE(c."principalAmount", ABS(c."amount"))
          ELSE c."amount"`
    : Prisma.sql`
          WHEN c."isAnchor" = 1 THEN 0
          -- 入账日在今天之后的流水尚未发生：仍会列在明细里，但不改变余额。
          -- 用与 locateDetailPage 相同的 CAST(... AS TEXT) 字符串比较，避免
          -- CURRENT_DATE 的会话时区与 JS 本地日期不一致。
          WHEN CAST(DATE(
            CASE
              WHEN c."type" = 'investment'
                AND c."fundProductType" = 'deposit'
                AND c."fundSubtype" = 'buy'
                AND c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
                THEN COALESCE(c."fundArrivalDate", c."displayAt")
              ELSE c."displayAt"
            END
          ) AS TEXT) > ${todayKey} THEN 0
          WHEN c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
            AND c."principalAmount" IS NOT NULL
            AND (
              COALESCE(c."source", '') = ''
              OR c."source" IN ('liability_repay_out', 'liability_prepay_out', 'liability_lend_out', 'scheduled_task')
            )
            THEN c."principalAmount"
          WHEN c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
            THEN ABS(COALESCE(c."fundArrivalAmount", c."amount"))
          ELSE c."amount"`;

  return Prisma.sql`
    WITH ${scopedCtes},
    "classified" AS (
      SELECT
        s.*,
        CASE
          WHEN s."type" IN ('expense', 'income')
            THEN COALESCE(s."postedAt", s."date")
          WHEN s."type" = 'investment'
            AND ${linkedBusinessCashAccountSql} ${cashSideMatchSql}
            AND (
              ${linkedBusinessSubtypeSql} IN ('redeem', 'dividend_cash', 'switch_out')
              OR (${linkedBusinessSubtypeSql} = 'buy_failed' AND s."source" = 'regular_invest_refund')
            )
            THEN COALESCE(${linkedBusinessArrivalSql}, s."date")
          WHEN s."type" = 'investment'
            AND s."fundProductType" = 'deposit'
            AND s."fundSubtype" = 'buy'
            AND s."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
            THEN COALESCE(s."fundArrivalDate", s."date")
          ELSE s."date"
        END AS "displayAt",
        CASE
          -- 锚点两类：① 已「对账」锁定的行（reconciledBalance 非空）；
          -- ② 余额校准 / 期初余额行（备注前缀带目标值）。两者语义相同。
          WHEN s."reconciledBalance" IS NOT NULL
            THEN 1
          WHEN s."source" IN (${BALANCE_RECONCILE_SOURCE}, ${BALANCE_INITIALIZATION_SOURCE})
            AND TRIM(COALESCE(s."toNote", '')) LIKE ${`${BALANCE_RECONCILE_TARGET_PREFIX}%`}
            THEN 1
          ELSE 0
        END AS "isAnchor"
      FROM "scoped" s
    ),
    "visible" AS (
      SELECT c.*
      FROM "classified" c
      WHERE CAST(DATE(c."displayAt") AS TEXT) <= ${todayKey}
        -- 投资资金到账腿（赎回 / 现金分红 / 买入退回）即使到账日在今天之后也要列出来：
        -- 金额和到账日都已确认，用户要在资金侧按到账日看到这一行。它的余额贡献仍是 0
        -- （见 effectiveAmountCase 里 displayAt > today 的分支），所以列表顶部余额不会
        -- 被推到页头余额之外。不满足该条件的未来行（预约交易、存款到期计划等）照旧隐藏。
        OR (
          c."type" = 'investment'
          AND ${classifiedCashAccountSql} ${cashSideMatchSql}
          AND (
            ${classifiedSubtypeSql} IN ('redeem', 'dividend_cash', 'switch_out')
            OR c."source" = 'regular_invest_refund'
          )
        )
    ),
    "displayed" AS (
      SELECT
        c.*,
        CASE
          -- 已「对账」锁定行的目标余额直接读列；余额校准 / 期初余额行仍从备注前缀取。
          WHEN c."reconciledBalance" IS NOT NULL
            THEN CAST(c."reconciledBalance" AS DECIMAL)
          WHEN c."isAnchor" = 1
            THEN CAST(
              SUBSTR(
                TRIM(COALESCE(c."toNote", '')),
                ${BALANCE_RECONCILE_TARGET_PREFIX.length + 1}
              ) AS DECIMAL
            )
          ELSE NULL
        END AS "anchorTarget",
        CASE
          ${effectiveAmountCase}
        END AS "effectiveAmount"
      FROM "visible" c
    ),
    "ordered" AS (
      SELECT
        d.*,
        DATE(d."displayAt") AS "dayKey"
      FROM "displayed" d
    ),
    "ranked" AS (
      SELECT
        o.*,
        ROW_NUMBER() OVER (
          ORDER BY
            o."dayKey" DESC,
            o."isAnchor" DESC,
            COALESCE(o."dayOrder", 0) DESC,
            o."displayAt" DESC,
            o."createdAt" DESC,
            o."id" DESC
        ) AS "rowNumber"
      FROM "ordered" o
    )
  `;
}

async function countEntries(accountIds: string[], householdId: string, sortAccountId?: string | null) {
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId,
    sortAccountId,
  });
  const rows = await prisma.$queryRaw<Array<{ count: unknown }>>(Prisma.sql`
    ${orderingCtes}
    SELECT COUNT(*) AS "count"
    FROM "ranked" r
  `);
  const count = Number(rows[0]?.count ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

export async function queryDetailPage(args: DetailPageQueryArgs): Promise<DetailPageQueryResult> {
  const accountIds = normalizedAccountIds(args.accountIds);
  if (accountIds.length === 0) {
    return {
      totalCount: 0,
      page: 1,
      pageIds: [],
      runningBalanceById: {},
    };
  }

  const totalCount = await countEntries(accountIds, args.householdId, args.sortAccountId);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(1, Math.floor(args.page) || 1), totalPages);
  const offset = (page - 1) * pageSize;
  const limit = offset + pageSize;
  // 只有「单账户 + 逐笔余额」这一条路径需要知道账户类别：贷款 / 往来款的余额
  // 按本金口径折叠，与 account-balance.ts 的 foldBalanceEntry 保持一致。
  const liabilityAccountMode = args.includeRunningBalances && args.sortAccountId
    ? isLoanOrSettlementAccountKind(
      (await prisma.account.findUnique({ where: { id: args.sortAccountId }, select: { kind: true } }))?.kind,
    )
    : false;
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    sortAccountId: args.sortAccountId,
    liabilityAccountMode,
  });

  if (!args.includeRunningBalances || !args.sortAccountId) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      ${orderingCtes}
      SELECT r."id" AS "id"
      FROM "ranked" r
      WHERE r."rowNumber" > ${offset}
        AND r."rowNumber" <= ${limit}
      ORDER BY r."rowNumber" ASC
    `);
    return {
      totalCount,
      page,
      pageIds: rows.map((row) => String(row.id)),
      runningBalanceById: {},
    };
  }

  const rows = await prisma.$queryRaw<Array<{ id: string; runningBalance: unknown }>>(Prisma.sql`
    ${orderingCtes},
    "grouped" AS (
      SELECT
        r.*,
        SUM(r."isAnchor") OVER (
          ORDER BY r."rowNumber" DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "anchorGroup"
      FROM "ranked" r
    ),
    "balanced" AS (
      SELECT
        g.*,
        SUM(
          CASE WHEN g."isAnchor" = 1 THEN 0 ELSE g."effectiveAmount" END
        ) OVER (
          PARTITION BY g."anchorGroup"
          ORDER BY g."rowNumber" DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "groupBalance",
        MAX(
          CASE WHEN g."isAnchor" = 1 THEN g."anchorTarget" ELSE NULL END
        ) OVER (
          PARTITION BY g."anchorGroup"
        ) AS "anchorBalance"
      FROM "grouped" g
    )
    SELECT
      b."id" AS "id",
      (COALESCE(b."anchorBalance", 0) + b."groupBalance") AS "runningBalance"
    FROM "balanced" b
    WHERE b."rowNumber" > ${offset}
      AND b."rowNumber" <= ${limit}
    ORDER BY b."rowNumber" ASC
  `);

  const runningBalanceById: Record<string, number> = {};
  for (const row of rows) {
    const value = Number(row.runningBalance);
    if (Number.isFinite(value)) runningBalanceById[String(row.id)] = value;
  }

  return {
    totalCount,
    page,
    pageIds: rows.map((row) => String(row.id)),
    runningBalanceById,
  };
}

/**
 * 计算指定流水在某个账户明细口径下的「本行事后余额」（runningBalance）。
 *
 * 与 `queryDetailPage` 的逐笔余额路径共用同一套 CTE / 折叠口径（含锚点分组），
 * 只是不按分页切片——「对账」锁定记录时用它把余额钉进 `reconciledBalance`，
 * 保证写进库的值与列表上显示的值逐分一致（否则会出现「对账后余额跳一下」）。
 *
 * 口径必须按**单账户**调用（`accountIds=[该账户]` + `sortAccountId=该账户`）：
 * 多账户视图（全部现金 / 合并信用卡账单）没有唯一的「本行余额」。
 */
export async function queryDetailRunningBalancesForEntries(args: {
  accountIds: string[];
  householdId: string;
  entryIds: string[];
  sortAccountId?: string | null;
}): Promise<Record<string, number>> {
  const accountIds = normalizedAccountIds(args.accountIds);
  const entryIds = Array.from(new Set(args.entryIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (accountIds.length === 0 || entryIds.length === 0) return {};

  const liabilityAccountMode = args.sortAccountId
    ? isLoanOrSettlementAccountKind(
      (await prisma.account.findUnique({ where: { id: args.sortAccountId }, select: { kind: true } }))?.kind,
    )
    : false;
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    sortAccountId: args.sortAccountId,
    liabilityAccountMode,
  });

  const rows = await prisma.$queryRaw<Array<{ id: string; runningBalance: unknown }>>(Prisma.sql`
    ${orderingCtes},
    "grouped" AS (
      SELECT
        r.*,
        SUM(r."isAnchor") OVER (
          ORDER BY r."rowNumber" DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "anchorGroup"
      FROM "ranked" r
    ),
    "balanced" AS (
      SELECT
        g.*,
        SUM(
          CASE WHEN g."isAnchor" = 1 THEN 0 ELSE g."effectiveAmount" END
        ) OVER (
          PARTITION BY g."anchorGroup"
          ORDER BY g."rowNumber" DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "groupBalance",
        MAX(
          CASE WHEN g."isAnchor" = 1 THEN g."anchorTarget" ELSE NULL END
        ) OVER (
          PARTITION BY g."anchorGroup"
        ) AS "anchorBalance"
      FROM "grouped" g
    )
    SELECT
      b."id" AS "id",
      (COALESCE(b."anchorBalance", 0) + b."groupBalance") AS "runningBalance"
    FROM "balanced" b
    WHERE b."id" IN (${Prisma.join(entryIds)})
  `);

  const runningBalanceById: Record<string, number> = {};
  for (const row of rows) {
    const value = Number(row.runningBalance);
    if (Number.isFinite(value)) runningBalanceById[String(row.id)] = value;
  }
  return runningBalanceById;
}

export async function locateDetailPage(args: {
  accountIds: string[];
  householdId: string;
  dateYmd: string;
  pageSize: number;
  sortAccountId?: string | null;
}) {
  const accountIds = normalizedAccountIds(args.accountIds);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalCount = accountIds.length > 0 ? await countEntries(accountIds, args.householdId, args.sortAccountId) : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.dateYmd)) {
    return { totalCount, page: 1, index: 0 };
  }
  if (accountIds.length === 0) {
    return { totalCount, page: 1, index: 0 };
  }

  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    sortAccountId: args.sortAccountId,
  });
  const rows = await prisma.$queryRaw<Array<{ count: unknown }>>(Prisma.sql`
    ${orderingCtes}
    SELECT COUNT(*) AS "count"
    FROM "ordered" o
    WHERE CAST(o."dayKey" AS TEXT) > ${args.dateYmd}
  `);
  const beforeCount = Number(rows[0]?.count ?? 0);
  if (!Number.isFinite(beforeCount) || beforeCount >= totalCount) {
    return {
      totalCount,
      page: totalPages,
      index: Math.max(0, totalCount - 1),
    };
  }

  const index = Math.max(0, Math.floor(beforeCount));
  return {
    totalCount,
    page: Math.floor(index / pageSize) + 1,
    index,
  };
}

export async function locateDetailEntryPage(args: {
  accountIds: string[];
  householdId: string;
  entryId: string;
  pageSize: number;
  sortAccountId?: string | null;
}) {
  const accountIds = normalizedAccountIds(args.accountIds);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalCount = accountIds.length > 0 ? await countEntries(accountIds, args.householdId, args.sortAccountId) : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const entryId = String(args.entryId ?? "").trim();
  if (!entryId || accountIds.length === 0) {
    return { totalCount, page: 1, index: -1 };
  }

  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    sortAccountId: args.sortAccountId,
  });
  const rows = await prisma.$queryRaw<Array<{ rowNumber: unknown }>>(Prisma.sql`
    ${orderingCtes}
    SELECT r."rowNumber" AS "rowNumber"
    FROM "ranked" r
    WHERE r."id" = ${entryId}
    LIMIT 1
  `);
  const rowNumber = Number(rows[0]?.rowNumber);
  if (!Number.isFinite(rowNumber) || rowNumber < 1) {
    return { totalCount, page: 1, index: -1 };
  }

  const index = Math.floor(rowNumber) - 1;
  return {
    totalCount,
    page: Math.min(totalPages, Math.floor(index / pageSize) + 1),
    index,
  };
}
