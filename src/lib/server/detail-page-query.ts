import { Prisma } from "@prisma/client";

import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  BALANCE_RECONCILE_TARGET_PREFIX,
} from "@/lib/balance-reconcile";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import { DETAIL_ALL_PAGE_SIZE } from "@/lib/detail-pagination-preference";
import { isLoanOrSettlementAccountKind } from "@/lib/liability";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import {
  DETAIL_FACET_COLUMNS,
  buildDetailDateRangeSql,
  buildDetailFilterSql,
  buildDetailOrderBySql,
  omitDetailDateFilter,
  type DetailDateRange,
  type DetailFilters,
  type DetailSortState,
} from "@/lib/server/detail-query-filters";

const FX_CONVERSION_SOURCE = "fx_conversion";

type DetailPageQueryArgs = {
  accountIds: string[];
  householdId: string;
  page: number;
  pageSize: number;
  /**
   * 从 `page` 起点**最多**取多少行（默认等于 `pageSize`）。
   * 只影响返回的行数，不影响页码 / 总数的口径：OFFSET 仍按 `pageSize` 算。
   * 首屏用它一次多取一屏半，交给客户端按视口行数切片（见
   * `DETAIL_PAGED_FIRST_FETCH_ROWS`），免得「自适应」落地前底部空一大片。
   */
  fetchRows?: number;
  sortAccountId?: string | null;
  includeRunningBalances?: boolean;
  /** 服务端筛选谓词（表头漏斗下推），作用在 `visible` 层。 */
  filters?: DetailFilters | null;
  /** 时间范围（工具栏双滑块）：数据范围限定，与 `filters.date` 独立。 */
  dateRange?: DetailDateRange | null;
  /** 服务端单列排序；仅多账户（无逐笔余额）视图生效。 */
  sort?: DetailSortState | null;
};

type DetailPageQueryResult = {
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
  /** 账簿业务时区，决定 `visible` 过滤的「今天」。 */
  timeZone: string;
  sortAccountId?: string | null;
  /** 排序账户是贷款 / 往来款时，余额折叠走本金口径（见 liabilityPrincipalForAccountSide）。 */
  liabilityAccountMode?: boolean;
  /** 服务端筛选谓词，注入 `visible` 层，保证计数与分页同口径。 */
  filters?: DetailFilters | null;
  /**
   * 时间范围（工具栏双滑块）：先把数据集裁到区间，与 `filters.date` 无关。
   * 注入同一层 `visible`，计数 / 分页 / 漏斗计数一次口径。
   */
  dateRange?: DetailDateRange | null;
}) {
  const { accountIds, householdId, timeZone, sortAccountId, liabilityAccountMode = false, filters, dateRange } = args;
  const sortAccountIdValue = sortAccountId ?? null;
  // 账户余额口径（account-balance.ts 的 isOnOrBeforeToday）以「今天」为截止，
  // 明细「余额」列必须用同一个截止日，否则未来日期的流水会把列表顶部的余额
  // 推到账户余额之外（例：借记卡页头 -89,161.66，列表首行却是 -49,161.66）。
  // 显式业务时区，不用进程时区：容器未设置 TZ 时进程时区是 UTC，
  // 北京时间 00:00–08:00 会把「今天」算成昨天，导致当天刚记的流水被
  // `visible` 过滤掉（页面上看不到、数据库里有）。
  const todayKey = todayDateBusinessYmd(timeZone);
  const accountScope = accountScopeSql(accountIds);
  const scopedColumns = Prisma.sql`
    t."id",
    t."date",
    t."postedAt",
    t."createdAt",
    t."updatedAt",
    t."dayOrder",
    t."type",
    t."amount",
    t."accountId",
    t."accountName",
    t."toAccountId",
    t."categoryName",
    t."note",
    t."currency",
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
  // 业务关联分支（理财 / 基金）的驱动方向：从 `entry_business_links` 出发，
  // 再用流水主键回查 `transactions`。
  //
  // 反过来写（从已物化的 `scoped_base` 出发 JOIN 链表）会让 PG 把上万个 investment
  // 流水当成 Nested Loop 的内表反复扫描：4.4 万行口径下实测 `Rows Removed by Join
  // Filter: 1,149,318`，单这一层 7.3s，整个分页请求 14.5s。反转后同一个请求 0.63s
  // （每一行关联都变成一次主键/索引查找），排序、筛选口径完全不变。
  //
  // `accountScope` 里的别名就是 t，可直接复用，保证账户范围与 `scoped_base` 一致。
  const linkedInvestmentScopeSql = Prisma.sql`
            t."deletedAt" IS NULL
            AND t."householdId" = ${householdId}
            AND t."type" = 'investment'
            AND ${accountScope}
  `;

  const scopedCtes = Prisma.sql`
        "scoped_base" AS (
          SELECT ${scopedColumns}
          ${scopedSource}
        ),
        "wealth_candidates" AS (
          SELECT
            t."id" AS "entryId",
            w."action" AS "wealthAction",
            w."arrivalDate" AS "wealthArrivalDate",
            w."cashAccountId" AS "wealthCashAccountId",
            0 AS "priority",
            l."id" AS "linkId"
          FROM "entry_business_links" l
          INNER JOIN "transactions" t
            ON t."id" = l."cashEntryId"
            AND ${linkedInvestmentScopeSql}
          INNER JOIN "wealth_transactions" w
            ON w."id" = l."wealthTransactionId"
            AND w."deletedAt" IS NULL
            AND w."householdId" = ${householdId}
          WHERE l."deletedAt" IS NULL
            AND l."wealthTransactionId" IS NOT NULL
          UNION ALL
          SELECT
            t."id" AS "entryId",
            w."action" AS "wealthAction",
            w."arrivalDate" AS "wealthArrivalDate",
            w."cashAccountId" AS "wealthCashAccountId",
            1 AS "priority",
            l."id" AS "linkId"
          FROM "entry_business_links" l
          INNER JOIN "transactions" t
            ON t."id" = l."businessEntryId"
            AND ${linkedInvestmentScopeSql}
          INNER JOIN "wealth_transactions" w
            ON w."id" = l."wealthTransactionId"
            AND w."deletedAt" IS NULL
            AND w."householdId" = ${householdId}
          WHERE l."deletedAt" IS NULL
            AND l."wealthTransactionId" IS NOT NULL
        ),
        "fund_candidates" AS (
          SELECT
            t."id" AS "entryId",
            f."fundSubtype" AS "fundSubtype",
            f."arrivalDate" AS "fundArrivalDate",
            f."cashAccountId" AS "fundCashAccountId",
            0 AS "priority",
            l."id" AS "linkId"
          FROM "entry_business_links" l
          INNER JOIN "transactions" t
            ON t."id" = l."cashEntryId"
            AND ${linkedInvestmentScopeSql}
          INNER JOIN "fund_transactions" f
            ON f."id" = l."fundTransactionId"
            AND f."deletedAt" IS NULL
            AND f."householdId" = ${householdId}
          WHERE l."deletedAt" IS NULL
            AND l."fundTransactionId" IS NOT NULL
          UNION ALL
          SELECT
            t."id" AS "entryId",
            f."fundSubtype" AS "fundSubtype",
            f."arrivalDate" AS "fundArrivalDate",
            f."cashAccountId" AS "fundCashAccountId",
            1 AS "priority",
            l."id" AS "linkId"
          FROM "entry_business_links" l
          INNER JOIN "transactions" t
            ON t."id" = l."businessEntryId"
            AND ${linkedInvestmentScopeSql}
          INNER JOIN "fund_transactions" f
            ON f."id" = l."fundTransactionId"
            AND f."deletedAt" IS NULL
            AND f."householdId" = ${householdId}
          WHERE l."deletedAt" IS NULL
            AND l."fundTransactionId" IS NOT NULL
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

  // 表头漏斗 / 列排序下推（百万行不可能把全量拉到浏览器过滤）。
  // 谓词作用在 `visible`，且必须包在原有的 (A OR B) 外面，否则 `AND` 会抢走 OR 的结合。
  const filterSql = buildDetailFilterSql(filters);
  // 时间范围先裁数据集，再叠列筛选（两者是 AND，语义上「范围内挑值」）。
  const dateRangeSql = buildDetailDateRangeSql(dateRange);

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
      WHERE (
        CAST(DATE(c."displayAt") AS TEXT) <= ${todayKey}
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
      )
      ${filterSql}
      ${dateRangeSql}
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

async function countEntries(
  accountIds: string[],
  householdId: string,
  timeZone: string,
  sortAccountId?: string | null,
  filters?: DetailFilters | null,
  dateRange?: DetailDateRange | null,
) {
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId,
    timeZone,
    sortAccountId,
    filters,
    dateRange,
  });
  // 数行只依赖 `visible`：`displayed` 只是多算两列、`ordered` / `ranked` 不增删行。
  // 引用 `ranked` 会让数据库把 4 万行的 ROW_NUMBER 窗口排序也算一遍，而 PG 12+ /
  // SQLite 对未被引用的 CTE 是惰性的，所以这里直接数 `visible` 就跳过了编号，
  // 「全部收支」的分页请求能省掉一半的全量排序。
  const countSql = Prisma.sql`
    ${orderingCtes}
    SELECT COUNT(*) AS "count"
    FROM "visible" r
  `;
  const rows = await prisma.$queryRaw<Array<{ count: unknown }>>(countSql);
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

  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  // 首屏可以多取几行（`fetchRows`），页码语义仍按 pageSize：OFFSET 一律是
  // (page - 1) * pageSize，多取的部分正好是这一页之后的连续行，客户端按视口
  // 行数切片即可，不会把下一页的行错认成这一页。
  const fetchRows = Math.max(
    1,
    Math.min(
      Math.floor(Number(args.fetchRows ?? pageSize)) || pageSize,
      Math.max(pageSize, DETAIL_ALL_PAGE_SIZE),
    ),
  );
  const requestedPage = Math.max(1, Math.floor(args.page) || 1);
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
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    liabilityAccountMode,
    filters: args.filters,
    dateRange: args.dateRange,
  });

  if (!args.includeRunningBalances || !args.sortAccountId) {
    // 不需要逐笔余额（「全部收支」等）时不必给全部行编号：直接按同一套排序键
    // `LIMIT/OFFSET` 取当前页，语义与 `rowNumber > offset AND <= offset + pageSize`
    // 完全一致，但省掉一次 4 万行的 ROW_NUMBER 物化。`ranked` 因此不被引用，
    // 数据库（PG 12+ / SQLite）不会执行它。
    // 服务端单列排序（表头点击）只在这一条路径生效：它没有逐笔余额，
    // 排序键可以自由替换；单账户带余额的路径必须按时间顺序折叠，忽略 sort。
    const orderBySql = buildDetailOrderBySql(args.sort) ?? Prisma.sql`
        o."dayKey" DESC,
        o."isAnchor" DESC,
        COALESCE(o."dayOrder", 0) DESC,
        o."displayAt" DESC,
        o."createdAt" DESC,
        o."id" DESC`;
    // 一次扫描同时拿「总数」和「当前页」：COUNT(*) OVER () 跟着这 200 行走，
    // 省掉一次完整 CTE。百万行时那一趟单独就是 10 秒量级，翻页感受差别很大。
    // 页码越界（前端带着过期页码）时窗口取不到行，再回退一次计数并夹到最后一页。
    const buildPageSql = (pageOffset: number) => Prisma.sql`
      ${orderingCtes}
      SELECT o."id" AS "id", COUNT(*) OVER () AS "totalCount"
      FROM "ordered" o
      ORDER BY ${orderBySql}
      LIMIT ${fetchRows} OFFSET ${pageOffset}
    `;
    const requestedOffset = (requestedPage - 1) * pageSize;
    let rows = await prisma.$queryRaw<Array<{ id: string; totalCount: unknown }>>(buildPageSql(requestedOffset));
    let totalCount = rows.length > 0 ? Number(rows[0].totalCount ?? 0) : 0;
    let page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / pageSize)));
    if (rows.length === 0) {
      totalCount = await countEntries(
        accountIds,
        args.householdId,
        await getHouseholdTimeZone(args.householdId),
        args.sortAccountId,
        args.filters,
        args.dateRange,
      );
      page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / pageSize)));
      const retryOffset = (page - 1) * pageSize;
      if (retryOffset !== requestedOffset) {
        rows = await prisma.$queryRaw<Array<{ id: string; totalCount: unknown }>>(buildPageSql(retryOffset));
      }
    }
    return {
      totalCount,
      page,
      pageIds: rows.map((row) => String(row.id)),
      runningBalanceById: {},
    };
  }

  // 单账户逐笔余额路径必须对全部行编号，没法用窗口顺带取总数，先单独计数。
  const totalCount = await countEntries(
    accountIds,
    args.householdId,
    await getHouseholdTimeZone(args.householdId),
    args.sortAccountId,
    args.filters,
    args.dateRange,
  );
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  const limit = offset + fetchRows;
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
    timeZone: await getHouseholdTimeZone(args.householdId),
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
  filters?: DetailFilters | null;
  dateRange?: DetailDateRange | null;
}) {
  const accountIds = normalizedAccountIds(args.accountIds);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalCount = accountIds.length > 0
    ? await countEntries(accountIds, args.householdId, await getHouseholdTimeZone(args.householdId), args.sortAccountId, args.filters, args.dateRange)
    : 0;
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
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    filters: args.filters,
    dateRange: args.dateRange,
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
  filters?: DetailFilters | null;
  dateRange?: DetailDateRange | null;
}) {
  const accountIds = normalizedAccountIds(args.accountIds);
  const pageSize = Math.max(1, Math.floor(args.pageSize) || 1);
  const totalCount = accountIds.length > 0
    ? await countEntries(accountIds, args.householdId, await getHouseholdTimeZone(args.householdId), args.sortAccountId, args.filters, args.dateRange)
    : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const entryId = String(args.entryId ?? "").trim();
  if (!entryId || accountIds.length === 0) {
    return { totalCount, page: 1, index: -1 };
  }

  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    filters: args.filters,
    dateRange: args.dateRange,
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

/** 表头漏斗的单个候选值。 */
type DetailFacetOption = { value: string; count: number };

/** 表头漏斗 + 时间筛选器的时间轴两端（`YYYY-MM-DD`，按业务时区取日历日）。 */
type DetailFacetsResult = {
  facets: Record<string, DetailFacetOption[]>;
  dateBounds: { min: string; max: string } | null;
};

/**
 * 只要时间轴两端（`YYYY-MM-DD`，按业务时区取日历日）。
 *
 * 双滑块的可拖范围与「当前页有多少行」无关：分页模式下前端只有几十行，自己
 * 推导会把范围压成几天；也不能受时间范围 / 日期列筛选影响，否则拖一次就缩到
 * 刚选的区间、再也拖不回去。只算 min/max，比拉整份 facets（6 次 GROUP BY）便宜。
 */
export async function queryDetailDateBounds(args: {
  accountIds: string[];
  householdId: string;
}): Promise<{ min: string; max: string } | null> {
  const accountIds = normalizedAccountIds(args.accountIds);
  if (accountIds.length === 0) return null;
  const timeZone = await getHouseholdTimeZone(args.householdId);
  const ctes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone,
    filters: null,
    dateRange: null,
  });
  // 只读到 `classified`（`displayAt` 已经算完的那一层），不碰 `visible/displayed/
  // ordered/ranked`：未引用的 CTE 不会被物化，省掉全量逐笔余额的窗口计算 —— 那
  // 一趟在 4 万多行上要好几秒，而时间轴只需要最早/最晚一天。
  //
  // 代价：`visible` 额外放行的「投资资金到账腿（到账日在今天之后）」不计入 max，
  // 所以滑块右端可能比实际最后一行早几天。用户点「全部时间」时范围是空的，数据
  // 一条不少，只是刻度略窄 —— 比让弹层等 8 秒好。
  const todayKey = todayDateBusinessYmd(timeZone);
  const rows = await prisma.$queryRaw<Array<{ min: unknown; max: unknown }>>(Prisma.sql`
    ${ctes}
    SELECT
      MIN(CAST(DATE(c."displayAt") AS TEXT)) AS "min",
      MAX(CAST(DATE(c."displayAt") AS TEXT)) AS "max"
    FROM "classified" c
    WHERE CAST(DATE(c."displayAt") AS TEXT) <= ${todayKey}
  `);
  const min = rows[0]?.min ? String(rows[0].min) : "";
  const max = rows[0]?.max ? String(rows[0].max) : "";
  return min && max ? { min, max } : null;
}

/**
 * 表头漏斗候选值（服务端 distinct）。
 *
 * 必须走服务端：AdvancedDataTable 原本从内存 `rows` 去重生成候选值，百万行下
 * 前端只有当前一页，漏斗就只剩这几十个值可选（正是「切到全部没反应」的成因）。
 *
 * 每个候选列一条 `GROUP BY` 聚合，互不联动（联动需要 N×M 次聚合，百万行不可接受）；
 * 单个候选值上限 200，够用且能兜住「备注」这类高基数列。
 *
 * 顺带取一次 `displayAt` 的最小/最大值：表头时间筛选器的双滑块要用全量时间轴，
 * 前端在服务端分页下只有当前一页，自己算会把可拖范围压成一页的跨度。
 */
export async function queryDetailFacets(args: {
  accountIds: string[];
  householdId: string;
  sortAccountId?: string | null;
  filters?: DetailFilters | null;
  /** 时间范围：漏斗计数落在范围内（范围内还有哪些分类可选）。 */
  dateRange?: DetailDateRange | null;
}): Promise<DetailFacetsResult> {
  const accountIds = normalizedAccountIds(args.accountIds);
  if (accountIds.length === 0) return { facets: {}, dateBounds: null };
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    filters: args.filters,
    dateRange: args.dateRange,
  });
  const result: Record<string, DetailFacetOption[]> = {};
  for (const column of DETAIL_FACET_COLUMNS) {
    const rows = await prisma.$queryRaw<Array<{ value: unknown; count: unknown }>>(Prisma.sql`
      ${orderingCtes}
      SELECT ${column.expression} AS "value", COUNT(*) AS "count"
      FROM "visible" c
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 200
    `);
    result[column.key] = rows
      .map((row) => ({ value: String(row.value ?? ""), count: Number(row.count ?? 0) }))
      .filter((option) => option.value !== "" && Number.isFinite(option.count));
  }
  // 时间轴的边界要按「去掉日期筛选、也不套时间范围」的全量算：否则用户拖一次
  // 区间，滑轨就收缩到刚选的范围，再也拖不回更早的日期（典型表现是「怎么拉都
  // 只有最近三个月」）。范围本身更不能进边界 —— 它就是从这根滑轨上取的值。
  const boundsCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    filters: omitDetailDateFilter(args.filters),
  });
  const boundsRows = await prisma.$queryRaw<Array<{ min: unknown; max: unknown }>>(Prisma.sql`
    ${boundsCtes}
    SELECT
      MIN(CAST(DATE(c."displayAt") AS TEXT)) AS "min",
      MAX(CAST(DATE(c."displayAt") AS TEXT)) AS "max"
    FROM "visible" c
  `);
  const min = boundsRows[0]?.min ? String(boundsRows[0].min) : "";
  const max = boundsRows[0]?.max ? String(boundsRows[0].max) : "";
  return {
    facets: result,
    // 只有一天的数据也返回，滑块会被禁用，但 chip 仍能显示这一天。
    dateBounds: min && max ? { min, max } : null,
  };
}
