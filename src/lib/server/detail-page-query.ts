import { AccountKind, Prisma } from "@prisma/client";

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

/**
 * 单账户明细的余额口径开关。
 *
 * 贷款 / 往来款按本金折叠；存款账户按存单本金折叠。两者都必须与
 * `account-balance.ts` 的账户余额同口径，否则「页头余额」与「明细首行余额」会分叉。
 */
async function loadAccountBalanceModes(accountId: string | null | undefined) {
  const row = accountId
    ? await prisma.account.findUnique({
      where: { id: accountId },
      select: { kind: true, investProductType: true },
    })
    : null;
  return {
    liabilityAccountMode: isLoanOrSettlementAccountKind(row?.kind),
    depositAccountMode: row?.kind === AccountKind.deposit || row?.investProductType === "deposit",
  };
}

/** CTE 名是标识符：`Prisma.sql` 会把字符串插值成 `$1`，必须用 raw 拼。 */
function cteRef(name: string) {
  return Prisma.raw(`"${name}"`);
}

/**
 * 「锚点目标值 + 本行对余额的贡献」这两列。
 *
 * 显示集合与折叠集合各要一份，两份的列名与 CASE 必须逐字相同（否则余额会随展示
 * 条件分叉），所以抽成模板，只换 CTE 名与来源。
 */
function buildDisplayedCte(name: string, source: string, effectiveAmountCase: Prisma.Sql) {
  return Prisma.sql`
    ${cteRef(name)} AS (
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
      FROM ${cteRef(source)} c
    )`;
}

function buildOrderedCte(name: string, source: string) {
  return Prisma.sql`
    ${cteRef(name)} AS (
      SELECT
        d.*,
        DATE(d."displayAt") AS "dayKey"
      FROM ${cteRef(source)} d
    )`;
}

function buildRankedCte(name: string, source: string) {
  return Prisma.sql`
    ${cteRef(name)} AS (
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
      FROM ${cteRef(source)} o
    )`;
}

function buildOrderingCtesSql(args: {
  accountIds: string[];
  householdId: string;
  /** 账簿业务时区，决定 `visible` 过滤的「今天」。 */
  timeZone: string;
  sortAccountId?: string | null;
  /** 排序账户是贷款 / 往来款时，余额折叠走本金口径（见 liabilityPrincipalForAccountSide）。 */
  liabilityAccountMode?: boolean;
  /**
   * 排序账户是存款账户时，余额列按存单本金折叠（与 `computeDepositCashValueByAccount`
   * 同口径），而不是把存入/取回的现金流逐笔累加 —— 后者方向是反的。
   */
  depositAccountMode?: boolean;
  /** 服务端筛选谓词，注入 `visible` 层，保证计数与分页同口径。 */
  filters?: DetailFilters | null;
  /**
   * 时间范围（工具栏双滑块）：先把数据集裁到区间，与 `filters.date` 无关。
   * 注入同一层 `visible`，计数 / 分页 / 漏斗计数一次口径。
   */
  dateRange?: DetailDateRange | null;
}) {
  const {
    accountIds,
    householdId,
    timeZone,
    sortAccountId,
    liabilityAccountMode = false,
    depositAccountMode = false,
    filters,
    dateRange,
  } = args;
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
    t."depositInterest",
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
  //
  // 存款账户单独一套：余额 = 未结清存单的剩余本金合计（`computeDepositCashValueByAccount`）。
  // 这里**不能**沿用现金流方向 —— 存单取回行的 `amount` 是正数（钱从存款账户流出），
  // 按 `ELSE c."amount"` 折叠会把它当成增加项，200,000 + 300,000 + 220,400 + 329,700
  // 直接叠出 1,050,100 的假余额（2026-10-27 用户报障）。
  const depositAmountCase = Prisma.sql`
          WHEN c."isAnchor" = 1 THEN 0
          WHEN CAST(DATE(c."displayAt") AS TEXT) > ${todayKey} THEN 0
          -- 存入行：本金增加。
          WHEN c."type" = 'investment'
            AND c."fundProductType" = 'deposit'
            AND c."fundSubtype" = 'buy'
            THEN ABS(COALESCE(c."fundArrivalAmount", c."amount"))
          -- 取回行：只扣本金，已付利息不算本金减少。
          WHEN c."type" = 'investment'
            AND c."fundProductType" = 'deposit'
            AND c."fundSubtype" IN ('redeem', 'switch_out')
            THEN -(
              ABS(COALESCE(c."fundArrivalAmount", c."amount"))
              - COALESCE(c."depositInterest", 0)
            )
          -- 付息行既不开存单也不关存单；非存单款项同样不进余额（页头已剔除）。
          ELSE 0`;
  const effectiveAmountCase = depositAccountMode
    ? depositAmountCase
    : liabilityAccountMode
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
  // 没有任何显示条件时，显示集合就是折叠集合：`paged` 退化成一次投影，省掉第二遍
  // 全量 ROW_NUMBER（这是不带范围时唯一的新增成本）。
  const hasDisplayPredicate = Object.values(filters ?? {}).some(
    (values) => Array.isArray(values) && values.length > 0,
  ) || !!(dateRange?.from || dateRange?.to);

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
          -- 存款存入行按**存入日**展示，不按到期日：到期日是存单的期限终点，拿它
          -- 当生效日会让「已存入但未到期」的存单被判成未来行、整行被 visible 滤掉
          -- （2026-10-27 用户报障：4 月存入的两张存单在明细里根本不出现，明细余额
          -- 也就永远缺这笔本金）。到期日只用于存单列表的到期排序与提醒。
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
    -- ① 余额折叠集合：账户全量流水，只受「今天」截断。
    --    时间范围 / 列筛选**一律不进这里** —— 余额是账户的状态量（截至本笔的账户
    --    余额），不是区间的统计量；把窗口条件带进来会让同一笔流水在不同范围下算出
    --    不同的余额（用户报告：时间轴取值范围不同，同一时间段的余额不一致）。
    "ledger_visible" AS (
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
    ),
    -- ② 显示集合：折叠集合 ∩ 时间范围 ∩ 列筛选。只决定「列出哪些行 / 共几条 / 分几页」，
    --    不参与余额折叠。
    "visible" AS (
      SELECT c.*
      FROM "ledger_visible" c
      WHERE 1=1
      ${filterSql}
      ${dateRangeSql}
    ),
    ${buildDisplayedCte("displayed", "visible", effectiveAmountCase)},
    ${buildOrderedCte("ordered", "displayed")},
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
    ),
    -- ③ 折叠链（只在要余额时被引用，其余路径数据库不会执行它）：
    --    ledger_displayed → ledger_ordered → ledger_ranked → ledger_grouped → ledger_balanced，
    --    与原来的 displayed / ordered / ranked / grouped / balanced 逐字同口径。
    ${buildDisplayedCte("ledger_displayed", "ledger_visible", effectiveAmountCase)},
    ${buildOrderedCte("ledger_ordered", "ledger_displayed")},
    ${buildRankedCte("ledger_ranked", "ledger_ordered")},
    "ledger_grouped" AS (
      SELECT
        r.*,
        SUM(r."isAnchor") OVER (
          ORDER BY r."rowNumber" DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS "anchorGroup"
      FROM "ledger_ranked" r
    ),
    "ledger_balanced" AS (
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
      FROM "ledger_grouped" g
    ),
    -- ④ 显示行的页码：显示集合是折叠集合的子序列，所以**直接在折叠编号上套显示
    --    条件**重排一次即可 —— 既不用拿 6 个排序键把窗口内的行再排一遍，也不用
    --    JOIN 回 visible 再扫一遍 ledger（实测那会多花约三成时间）。
    --    别名必须是 c：filterSql / dateRangeSql 里的谓词就是按这个别名写的。
    "paged" AS (
      SELECT
        c."id" AS "id",
        ${hasDisplayPredicate
    ? Prisma.sql`ROW_NUMBER() OVER (ORDER BY c."rowNumber" ASC)`
    : Prisma.sql`c."rowNumber"`} AS "rowNumber"
      FROM "ledger_ranked" c
      ${hasDisplayPredicate ? Prisma.sql`WHERE 1=1 ${filterSql} ${dateRangeSql}` : Prisma.empty}
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
  // 按本金口径折叠、存款账户按存单本金折叠，都与 account-balance.ts 的
  // foldBalanceEntry / computeDepositCashValueByAccount 保持一致。
  const { liabilityAccountMode, depositAccountMode } =
    args.includeRunningBalances && args.sortAccountId
      ? await loadAccountBalanceModes(args.sortAccountId)
      : { liabilityAccountMode: false, depositAccountMode: false };
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    liabilityAccountMode,
    depositAccountMode,
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

  // 单账户逐笔余额路径必须对全部行编号，所以没法用 `COUNT(*) OVER ()` 顺带取总数
  // （窗口在 WHERE 之后算，取到的永远是这一页的行数）。但**也不必单独计数**：
  // 折叠链里已经有一份全量编号的 `paged`，它的 `MAX("rowNumber")` 就是显示集合的
  // 总行数。以前这里先发一条只数 `visible` 的查询，等于把候选表关联 +
  // 分类 CASE 再算一遍（实测 1493 行的账户约 120-250ms，占整次明细查询的四成）。
  // 现在总数随这一页一起回来，两条 CTE 只算一次。
  const pageOffset = (requestedPage - 1) * pageSize;
  const limit = pageOffset + fetchRows;
  // 余额取折叠集合（全量账本）算出的值，页码取显示集合的编号：范围 / 筛选只影响
  // 「列出哪些行」，不影响「每行余额是多少」。
  const rows = await prisma.$queryRaw<Array<{ id: string; runningBalance: unknown; totalCount: unknown }>>(Prisma.sql`
    ${orderingCtes}
    SELECT
      p."id" AS "id",
      (COALESCE(lb."anchorBalance", 0) + lb."groupBalance") AS "runningBalance",
      (SELECT MAX(p2."rowNumber") FROM "paged" p2) AS "totalCount"
    FROM "paged" p
    INNER JOIN "ledger_balanced" lb ON lb."id" = p."id"
    WHERE p."rowNumber" > ${pageOffset}
      AND p."rowNumber" <= ${limit}
    ORDER BY p."rowNumber" ASC
  `);

  // 页码越界（URL 里带着过期的 detailPage）时窗口取不到行，才回退到单独计数并夹到
  // 最后一页重取 —— 正常翻页一次都不会走到这里。
  let totalCount = rows.length > 0 ? Math.max(0, Math.floor(Number(rows[0].totalCount) || 0)) : 0;
  let page = Math.min(requestedPage, Math.max(1, Math.ceil(totalCount / pageSize)));
  let pageRows = rows;
  if (pageRows.length === 0) {
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
    if (retryOffset !== pageOffset) {
      pageRows = await prisma.$queryRaw<Array<{ id: string; runningBalance: unknown; totalCount: unknown }>>(Prisma.sql`
        ${orderingCtes}
        SELECT
          p."id" AS "id",
          (COALESCE(lb."anchorBalance", 0) + lb."groupBalance") AS "runningBalance",
          (SELECT MAX(p2."rowNumber") FROM "paged" p2) AS "totalCount"
        FROM "paged" p
        INNER JOIN "ledger_balanced" lb ON lb."id" = p."id"
        WHERE p."rowNumber" > ${retryOffset}
          AND p."rowNumber" <= ${retryOffset + fetchRows}
        ORDER BY p."rowNumber" ASC
      `);
    }
  }

  const runningBalanceById: Record<string, number> = {};
  for (const row of pageRows) {
    const value = Number(row.runningBalance);
    if (Number.isFinite(value)) runningBalanceById[String(row.id)] = value;
  }

  return {
    totalCount,
    page,
    pageIds: pageRows.map((row) => String(row.id)),
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

  const { liabilityAccountMode, depositAccountMode } =
    await loadAccountBalanceModes(args.sortAccountId);
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    liabilityAccountMode,
    depositAccountMode,
  });

  // 与列表同一条折叠链（`ledger_balanced`）：本函数不带筛选 / 范围，显示集合本来就
  // 等于折叠集合，直接用折叠链省掉一次全量编号。
  const rows = await prisma.$queryRaw<Array<{ id: string; runningBalance: unknown }>>(Prisma.sql`
    ${orderingCtes}
    SELECT
      b."id" AS "id",
      (COALESCE(b."anchorBalance", 0) + b."groupBalance") AS "runningBalance"
    FROM "ledger_balanced" b
    WHERE b."id" IN (${Prisma.join(entryIds)})
  `);

  const runningBalanceById: Record<string, number> = {};
  for (const row of rows) {
    const value = Number(row.runningBalance);
    if (Number.isFinite(value)) runningBalanceById[String(row.id)] = value;
  }
  return runningBalanceById;
}

/**
 * 「截至某一天收盘」的账户余额 —— 明细按时间窗口展示时的**期初余额**。
 *
 * 客户端只拉窗口内的行，本地折叠就缺一个起点；这个起点必须由**列表同一条折叠链**
 * 给出（`ledger_balanced` 上 `dayKey < beforeYmd` 的最新一行的事后余额），否则
 * 「期初余额 + 窗口内本地折叠」会与「服务端整表折叠」各算一套、逐分对不上。
 *
 * 只返回一个数字，不拉任何流水行：窗口化取数省下的流量不会因为补余额又吐回去。
 */
export async function queryDetailOpeningBalanceBefore(args: {
  accountIds: string[];
  householdId: string;
  sortAccountId: string;
  beforeYmd: string;
}): Promise<number> {
  const accountIds = normalizedAccountIds(args.accountIds);
  const beforeYmd = String(args.beforeYmd ?? "").trim();
  if (accountIds.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(beforeYmd)) return 0;

  const { liabilityAccountMode, depositAccountMode } =
    await loadAccountBalanceModes(args.sortAccountId);
  const orderingCtes = buildOrderingCtesSql({
    accountIds,
    householdId: args.householdId,
    timeZone: await getHouseholdTimeZone(args.householdId),
    sortAccountId: args.sortAccountId,
    liabilityAccountMode,
    depositAccountMode,
  });
  // rowNumber 越小越新：窗口之前最新的那一行，它的事后余额就是窗口的期初余额。
  const rows = await prisma.$queryRaw<Array<{ runningBalance: unknown }>>(Prisma.sql`
    ${orderingCtes}
    SELECT
      (COALESCE(lb."anchorBalance", 0) + lb."groupBalance") AS "runningBalance"
    FROM "ledger_balanced" lb
    WHERE CAST(lb."dayKey" AS TEXT) < ${beforeYmd}
    ORDER BY lb."rowNumber" ASC
    LIMIT 1
  `);
  const value = Number(rows[0]?.runningBalance);
  return Number.isFinite(value) ? value : 0;
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
