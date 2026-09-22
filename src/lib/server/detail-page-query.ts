import { Prisma } from "@prisma/client";

import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  BALANCE_RECONCILE_TARGET_PREFIX,
} from "@/lib/balance-reconcile";
import { prisma } from "@/lib/db/prisma";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";

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
}) {
  const { accountIds, householdId, sortAccountId } = args;
  const sortAccountIdValue = sortAccountId ?? null;
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
    t."debtPrincipalAmount",
    t."fundSubtype",
    t."fundArrivalDate",
    t."fundArrivalAmount"
  `;
  const scopedSource = Prisma.sql`
    FROM "transactions" t
    WHERE t."deletedAt" IS NULL
      AND t."householdId" = ${householdId}
      AND ${accountScope}
  `;
  const scopedCtes = sortAccountIdValue
    ? Prisma.sql`
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
        "wealth_ranked" AS (
          SELECT
            wc.*,
            ROW_NUMBER() OVER (
              PARTITION BY wc."entryId"
              ORDER BY wc."priority" ASC, wc."linkId" ASC
            ) AS "rank"
          FROM "wealth_candidates" wc
        ),
        "scoped" AS (
          SELECT
            s.*,
            r."wealthAction",
            r."wealthArrivalDate",
            r."wealthCashAccountId"
          FROM "scoped_base" s
          LEFT JOIN "wealth_ranked" r
            ON r."entryId" = s."id"
            AND r."rank" = 1
        )
      `
    : Prisma.sql`
        "scoped" AS (
          SELECT
            ${scopedColumns},
            NULL AS "wealthAction",
            NULL AS "wealthArrivalDate",
            NULL AS "wealthCashAccountId"
          ${scopedSource}
        )
      `;

  return Prisma.sql`
    WITH ${scopedCtes},
    "classified" AS (
      SELECT
        s.*,
        CASE
          WHEN s."type" IN ('expense', 'income')
            THEN COALESCE(s."postedAt", s."date")
          WHEN CAST(${sortAccountIdValue} AS TEXT) IS NOT NULL
            AND s."type" = 'investment'
            AND COALESCE(s."wealthCashAccountId", s."toAccountId") = CAST(${sortAccountIdValue} AS TEXT)
            AND (
              COALESCE(s."wealthAction", s."fundSubtype") IN ('redeem', 'dividend_cash')
              OR (s."fundSubtype" = 'buy_failed' AND s."source" = 'regular_invest_refund')
            )
            THEN COALESCE(s."wealthArrivalDate", s."fundArrivalDate", s."date")
          ELSE s."date"
        END AS "displayAt",
        CASE
          WHEN s."source" IN (${BALANCE_RECONCILE_SOURCE}, ${BALANCE_INITIALIZATION_SOURCE})
            AND TRIM(COALESCE(s."toNote", '')) LIKE ${`${BALANCE_RECONCILE_TARGET_PREFIX}%`}
            THEN 1
          ELSE 0
        END AS "isAnchor"
      FROM "scoped" s
    ),
    "displayed" AS (
      SELECT
        c.*,
        CASE
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
          WHEN c."isAnchor" = 1 THEN 0
          WHEN c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
            AND c."debtPrincipalAmount" IS NOT NULL
            AND (
              COALESCE(c."source", '') = ''
              OR c."source" IN ('debt_repay_out', 'debt_prepay_out', 'debt_lend_out', 'scheduled_task')
            )
            THEN c."debtPrincipalAmount"
          WHEN c."toAccountId" = CAST(${sortAccountIdValue} AS TEXT)
            THEN ABS(COALESCE(c."fundArrivalAmount", c."amount"))
          ELSE c."amount"
        END AS "effectiveAmount"
      FROM "classified" c
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

async function countEntries(accountIds: string[], householdId: string) {
  return prisma.txRecord.count({
    where: {
      ...txRecordAccountScopeWhere(accountIds),
      deletedAt: null,
      householdId,
    },
  });
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

  const totalCount = await countEntries(accountIds, args.householdId);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(1, Math.floor(args.page) || 1), totalPages);
  const offset = (page - 1) * pageSize;
  const limit = offset + pageSize;
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    sortAccountId: args.sortAccountId,
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

export async function locateDetailPage(args: {
  accountIds: string[];
  householdId: string;
  dateYmd: string;
  pageSize: number;
  sortAccountId?: string | null;
}) {
  const accountIds = normalizedAccountIds(args.accountIds);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalCount = accountIds.length > 0 ? await countEntries(accountIds, args.householdId) : 0;
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
  const totalCount = accountIds.length > 0 ? await countEntries(accountIds, args.householdId) : 0;
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
