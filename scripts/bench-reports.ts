/**
 * 报表 / 明细页 / 净资产 的性能基线 —— `npm run bench:reports`。
 *
 * 为什么需要这个脚本：仓库里有 30 多条 `check:*`（口径正确性守卫），但没有任何一条
 * 能回答「报表现在到底几秒、慢在哪」。所有关于索引、SQL 下推、缓存的讨论都只能靠
 * 猜。本脚本给出可复现的数字，作为优化前后对比的基线。
 *
 * 测什么（每项：冷跑 1 次 + 热跑 N 次，取最快 / 中位）：
 *   1. 明细页 · 单账户（带逐笔余额）—— `queryDetailPage`，整本账跑窗口函数
 *   2. 明细页 · 全部账户（无逐笔余额）—— 同上，多账户分支
 *   3. 净资产 · `computeAccountDisplayBalances`（页头数字 / 总览的同一入口）
 *   4. 总览 · `computeOverviewSummary`
 *   5. 收支报表 · 分类树归一化 —— 每个报表请求都会跑一次
 *   6. 收支报表 · 主流水查询（**只含 SQL + 传输，不含 JS 汇总**）
 *   7. 收支报表 · 同样口径走 SQL 聚合（「分类 × 日」）—— 第 2 档下推的收益上界参考
 *
 * 测不到什么：`getIncomeExpenseReport()` 本身需要 `cookies()`，脚本里没有请求上下文，
 * 所以第 6 项只跑它的第一路查询。JS 侧 `reduce` 的开销用「6 次查询耗时 vs 总行数」
 * 自己估；真正的端到端计时要用 dev server + 浏览器。
 *
 * 环境变量：
 *   BENCH_HOUSEHOLD_ID   指定账簿（默认第一个）
 *   BENCH_START/END      期间 YYYY-MM-DD（默认业务今年的 1 月 1 日 → 今天）
 *   BENCH_RUNS           热跑次数（默认 3）
 *   BENCH_ACCOUNT_ID     明细页用例固定用这个账户（默认取流水最多的非信用卡账户）
 *   BENCH_SKIP_INDEX     设 1 跳过索引诊断
 *
 * 只读：不写任何业务表。唯一例外是第 5 项调用的 `normalizeDefaultCategoryHierarchyForHousehold`，
 * 它在版本标记已就位时是一次 `SystemSetting` 读取，与真实请求路径一致（可重复执行）。
 */

import fs from "node:fs";
import path from "node:path";

const TX_TYPES = ["income", "expense"] as const;

/** tsx 不会自动加载 .env.local，而 Prisma 只认 process.env 里的 DATABASE_URL。 */
function loadEnvFiles() {
  for (const name of [".env.local", ".env"]) {
    const file = path.resolve(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      if (process.env[match[1]] != null) continue;
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

/** 中文字符占两列，表格对齐要靠显示宽度而不是字符数。 */
function textWidth(text: string) {
  let width = 0;
  for (const ch of text) {
    width += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  }
  return width;
}

function padEndWidth(text: string, width: number) {
  const w = textWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

function padStartWidth(text: string, width: number) {
  const w = textWidth(text);
  return w >= width ? text : " ".repeat(width - w) + text;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

type CaseResult = {
  label: string;
  cold: number;
  best: number;
  mid: number;
  rows?: number;
  /** 热跑中最后一次的 SQL 条数与 SQL 耗时，用来区分「库慢」和「JS 慢」。 */
  queries?: number;
  sqlMs?: number;
  note?: string;
  failed?: string;
};

/** 由 `MMH_PRISMA_QUERY_LOG=1` 打开的 query 事件累计器。 */
const queryMeter = { count: 0, ms: 0, active: false };

function attachQueryMeter(client: { $on?: (event: "query", cb: (payload: { duration: number }) => void) => void }) {
  try {
    client.$on?.("query", (payload) => {
      if (!queryMeter.active) return;
      queryMeter.count += 1;
      queryMeter.ms += Number(payload.duration) || 0;
    });
    return true;
  } catch {
    return false;
  }
}

const CASE_COLUMNS = { label: 38, ms: 12, rows: 8, queries: 8, sql: 11, note: 30 };

async function runCase(
  label: string,
  run: () => Promise<unknown>,
  runs: number,
  note?: string,
): Promise<CaseResult> {
  const countRows = (value: unknown): number | undefined => {
    if (Array.isArray(value)) return value.length;
    if (value instanceof Map) return value.size;
    return undefined;
  };
  const empty = { label, cold: 0, best: 0, mid: 0, note };

  const startCold = performance.now();
  let coldValue: unknown;
  queryMeter.count = 0;
  queryMeter.ms = 0;
  try {
    coldValue = await run();
  } catch (error) {
    return { ...empty, failed: error instanceof Error ? error.message : String(error) };
  }
  const cold = performance.now() - startCold;

  const samples: number[] = [];
  let rows = countRows(coldValue);
  let queries = 0;
  let sqlMs = 0;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    queryMeter.count = 0;
    queryMeter.ms = 0;
    try {
      const value = await run();
      samples.push(performance.now() - started);
      if (rows === undefined) rows = countRows(value);
      queries = queryMeter.count;
      sqlMs = queryMeter.ms;
    } catch (error) {
      return { ...empty, cold, best: cold, mid: cold, failed: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    label,
    cold,
    best: samples.length > 0 ? Math.min(...samples) : cold,
    mid: samples.length > 0 ? median(samples) : cold,
    rows,
    queries: queryMeter.active ? queries : undefined,
    sqlMs: queryMeter.active ? sqlMs : undefined,
    note,
  };
}

function formatMs(value: number) {
  return `${value.toFixed(1)}ms`;
}

function printTable(results: CaseResult[]) {
  const header = [
    padEndWidth("用例", CASE_COLUMNS.label),
    padStartWidth("冷跑", CASE_COLUMNS.ms),
    padStartWidth("最快", CASE_COLUMNS.ms),
    padStartWidth("中位", CASE_COLUMNS.ms),
    padStartWidth("SQL条数", CASE_COLUMNS.queries),
    padStartWidth("SQL耗时", CASE_COLUMNS.sql),
    padStartWidth("行数", CASE_COLUMNS.rows),
    "  备注",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(textWidth(header)));
  const blank = (width: number) => padStartWidth("-", width);
  for (const result of results) {
    if (result.failed) {
      console.log(
        [
          padEndWidth(result.label, CASE_COLUMNS.label),
          blank(CASE_COLUMNS.ms),
          blank(CASE_COLUMNS.ms),
          blank(CASE_COLUMNS.ms),
          blank(CASE_COLUMNS.queries),
          blank(CASE_COLUMNS.sql),
          blank(CASE_COLUMNS.rows),
          `  失败: ${result.failed}`,
        ].join("  "),
      );
      continue;
    }
    console.log(
      [
        padEndWidth(result.label, CASE_COLUMNS.label),
        padStartWidth(formatMs(result.cold), CASE_COLUMNS.ms),
        padStartWidth(formatMs(result.best), CASE_COLUMNS.ms),
        padStartWidth(formatMs(result.mid), CASE_COLUMNS.ms),
        padStartWidth(result.queries == null ? "-" : String(result.queries), CASE_COLUMNS.queries),
        padStartWidth(result.sqlMs == null ? "-" : formatMs(result.sqlMs), CASE_COLUMNS.sql),
        padStartWidth(result.rows == null ? "-" : String(result.rows), CASE_COLUMNS.rows),
        `  ${result.note ?? ""}`.trimEnd(),
      ].join("  "),
    );
  }
}

/* ── 索引诊断（PG）：报表慢一半以上是缺索引，先把事实摆出来 ── */

const EXPECTED_INDEXES: Array<{ name: string; columns: string[] }> = [
  { name: "transactions(householdId, date)", columns: ["householdid", "date"] },
  { name: "transactions(householdId, type, date)", columns: ["householdid", "type", "date"] },
  { name: "transactions(householdId, categoryId, date)", columns: ["householdid", "categoryid", "date"] },
  { name: "transactions(fundArrivalDate)", columns: ["fundarrivaldate"] },
];

type PrismaLike = (typeof import("../src/lib/db/prisma"))["prisma"];

/**
 * 统计信息过期会让执行计划失真，基准数字就不可信（本机实测 pg_stat 里 transactions
 * 记着 9 行，实际 6 万行）。测之前先 ANALYZE 一次，除非 BENCH_SKIP_ANALYZE=1。
 */
async function refreshStatistics(prisma: PrismaLike, provider: "postgres" | "sqlite"): Promise<void> {
  if (provider === "sqlite" || process.env.BENCH_SKIP_ANALYZE === "1") return;
  try {
    const before = await prisma.$queryRaw<Array<{ n_live_tup: bigint | number | null }>>`
      SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'transactions'
    `;
    await prisma.$executeRawUnsafe('ANALYZE "transactions"');
    const after = await prisma.$queryRaw<Array<{ n_live_tup: bigint | number | null }>>`
      SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'transactions'
    `;
    console.log(
      `统计信息：ANALYZE transactions 前 n_live_tup=${before[0]?.n_live_tup ?? "?"}，后 n_live_tup=${after[0]?.n_live_tup ?? "?"}`,
    );
  } catch (error) {
    console.log(`统计信息刷新失败（不影响后续测量）: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function printIndexDiagnostics(prisma: PrismaLike, provider: "postgres" | "sqlite"): Promise<void> {
  if (provider === "sqlite") {
    console.log("索引诊断：SQLite 包跳过（用 PRAGMA index_list 自查，或直接看 prisma/schema.native.prisma）");
    return;
  }
  try {
    console.log("索引诊断（表 transactions）");
    console.log("-".repeat(60));
    const table = await prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT relname, seq_scan, idx_scan, n_live_tup, n_dead_tup, pg_size_pretty(pg_total_relation_size(relid)) AS total_size
      FROM pg_stat_user_tables
      WHERE relname = 'transactions'
    `;
    for (const row of table) {
      console.log(
        `  行数 ${row.n_live_tup ?? "?"}（死行 ${row.n_dead_tup ?? "?"}），顺序扫描 ${row.seq_scan ?? "?"} 次 / 索引扫描 ${row.idx_scan ?? "?"} 次，体积 ${row.total_size ?? "?"}`,
      );
    }

    const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'transactions' ORDER BY indexname
    `;
    console.log(`  现有 ${indexes.length} 个索引：`);
    for (const index of indexes) {
      console.log(`    ${index.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON /, "").replace(/ USING btree/, "")}`);
    }

    const missing = EXPECTED_INDEXES.filter((expected) => {
      const wanted = expected.columns.join(",");
      return !indexes.some((index) => {
        const columnsPart = /\(([^)]*)\)/.exec(index.indexdef)?.[1] ?? "";
        const columns = columnsPart.split(",").map((column) => column.trim().replace(/"/g, "").toLowerCase());
        return columns.join(",") === wanted;
      });
    });
    if (missing.length === 0) {
      console.log("  建议索引：已全部就位");
    } else {
      console.log("  建议索引（缺）：");
      for (const expected of missing) {
        console.log(`    ${expected.name}`);
      }
    }
    console.log("");
  } catch (error) {
    console.log(`索引诊断失败（不影响耗时数据）: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function main() {
  loadEnvFiles();
  if (!process.env.DATABASE_URL) {
    throw new Error("缺少 DATABASE_URL（.env.local / 环境变量）");
  }
  const provider: "postgres" | "sqlite" = process.env.DATABASE_URL.startsWith("file:") ? "sqlite" : "postgres";
  const runs = Math.max(1, Number(process.env.BENCH_RUNS ?? "3") || 3);

  // 必须在 import 之前设置：PrismaClient 在模块加载时按这个开关决定是否发 query 事件。
  process.env.MMH_PRISMA_QUERY_LOG = "1";

  const { prisma } = await import("../src/lib/db/prisma");
  queryMeter.active = attachQueryMeter(prisma as unknown as { $on?: (event: "query", cb: (payload: { duration: number }) => void) => void });
  const { Prisma } = await import("@prisma/client");
  const { queryDetailPage } = await import("../src/lib/server/detail-page-query");
  const { computeAccountDisplayBalances } = await import("../src/lib/server/account-balance");
  const { computeOverviewSummary } = await import("../src/lib/server/overview-summary");
  const { normalizeDefaultCategoryHierarchyForHousehold } = await import("../src/lib/default-categories");
  const { loadFundStatisticSourceEntries, loadWealthStatisticSourceEntries } = await import(
    "../src/lib/server/investment-statistic-sources"
  );
  const { loadHouseholdAvailableYears } = await import("../src/lib/server/available-years");
  const { getHouseholdTimeZone } = await import("../src/lib/server/household-preferences");
  const { parseDateInputToUtc, todayDateBusinessYmd } = await import("../src/lib/date-utils");

  /* ── 账簿 / 期间 ── */
  const householdIdEnv = (process.env.BENCH_HOUSEHOLD_ID ?? "").trim();
  const household = householdIdEnv
    ? await prisma.household.findUnique({ where: { id: householdIdEnv }, select: { id: true, name: true } })
    : await prisma.household.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
  if (!household) throw new Error("库里没有账簿，先跑一次初始化");

  const householdId = household.id;
  const timeZone = await getHouseholdTimeZone(householdId);
  const todayYmd = todayDateBusinessYmd(timeZone);
  const startYmd = (process.env.BENCH_START ?? "").trim() || `${todayYmd.slice(0, 4)}-01-01`;
  const endYmd = (process.env.BENCH_END ?? "").trim() || todayYmd;
  const from = parseDateInputToUtc(startYmd);
  const to = parseDateInputToUtc(endYmd);
  if (!from || !to) throw new Error(`期间格式不对：${startYmd} / ${endYmd}`);
  // 报表的 6 路数据源用的是「半开区间」endExclusive，与 `lte to` 差一天。
  const endExclusive = new Date(to.getTime() + 86_400_000);

  const accounts = await prisma.account.findMany({
    where: { householdId },
    select: { id: true, kind: true, investProductType: true, billingDay: true },
  });
  const accountIds = accounts.map((account) => account.id);

  const txTotal = await prisma.txRecord.count({ where: { householdId } });
  const txRange = await prisma.txRecord.count({ where: { householdId, deletedAt: null, date: { gte: from, lte: to } } });

  console.log("");
  console.log(`账簿：${household.name ?? householdId}（${householdId}）`);
  console.log(`数据库：${provider}，时区 ${timeZone}，期间 ${startYmd} → ${endYmd}，热跑 ${runs} 次`);
  console.log(`规模：transactions ${txTotal} 行（期内 ${txRange} 行），账户 ${accounts.length} 个`);
  console.log(`SQL 计量：${queryMeter.active ? "query 事件已接入" : "不可用（$on 未生效，SQL条数/SQL耗时列将显示 -）"}`);
  await refreshStatistics(prisma, provider);
  console.log("");

  /* ── 明细页用例的账户选择 ── */
  let detailAccountId = (process.env.BENCH_ACCOUNT_ID ?? "").trim();
  if (!detailAccountId) {
    const grouped = await prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { householdId, deletedAt: null },
      _count: { _all: true },
      orderBy: { _count: { accountId: "desc" } },
      take: 20,
    });
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const picked = grouped.find((row) => {
      const account = row.accountId ? byId.get(row.accountId) : undefined;
      return account && account.kind !== "bank_credit";
    });
    detailAccountId = picked?.accountId ?? accountIds[0] ?? "";
  }

  const ctx = { householdId, hidFilter: { householdId }, user: null };
  const results: CaseResult[] = [];

  if (detailAccountId) {
    results.push(
      await runCase(
        "明细页 · 单账户（带逐笔余额）",
        () => queryDetailPage({ accountIds: [detailAccountId], householdId, page: 1, pageSize: 100, includeRunningBalances: true }),
        runs,
        "整本账窗口函数",
      ),
    );
  }
  results.push(
    await runCase(
      "明细页 · 全部账户（无逐笔余额）",
      () => queryDetailPage({ accountIds, householdId, page: 1, pageSize: 100, includeRunningBalances: false }),
      runs,
      `${accountIds.length} 个账户`,
    ),
  );
  results.push(
    await runCase("净资产 · computeAccountDisplayBalances", () => computeAccountDisplayBalances(accounts, { householdId }), runs, "页头数字"),
  );
  results.push(await runCase("总览 · computeOverviewSummary", () => computeOverviewSummary(ctx), runs, "首页"));
  results.push(
    await runCase(
      "收支报表 · 分类树归一化（每请求）",
      () => normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId),
      runs,
      "版本标记命中即返回",
    ),
  );
  results.push(
    await runCase(
      "报表页头 · loadHouseholdAvailableYears",
      () => loadHouseholdAvailableYears({ householdId }, Number(todayYmd.slice(0, 4))),
      runs,
      "reports/page.tsx 每次都跑",
    ),
  );
  results.push(
    await runCase(
      "收支报表 · 基金统计源",
      () => loadFundStatisticSourceEntries(ctx, { start: from, endExclusive }),
      runs,
      "6 路数据源之一",
    ),
  );
  results.push(
    await runCase(
      "基金统计源 · 窄字段对照（下界）",
      () =>
        prisma.fundTransaction.findMany({
          where: { householdId, deletedAt: null, applyDate: { lt: endExclusive } },
          select: {
            id: true,
            applyDate: true,
            cashEntryId: true,
            fundSubtype: true,
            Account: { select: { name: true } },
            CashAccount: { select: { name: true } },
            cashFlows: { select: { id: true, kind: true, amount: true, flowDate: true, txRecordId: true, accountId: true, createdAt: true } },
            EntryBusinessLink: { where: { deletedAt: null }, select: { cashEntryId: true } },
          },
          orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: 50000,
        }),
      runs,
      "只换 select 不换逻辑",
    ),
  );
  results.push(
    await runCase(
      "收支报表 · 理财统计源",
      () => loadWealthStatisticSourceEntries(ctx, { start: from, endExclusive }),
      runs,
      "6 路数据源之一",
    ),
  );
  results.push(
    await runCase(
      "收支报表 · 主流水查询（不含 JS 汇总）",
      () =>
        prisma.txRecord.findMany({
          where: { householdId, deletedAt: null, date: { gte: from, lte: to }, type: { in: [...TX_TYPES] } },
          select: { id: true, date: true, type: true, amount: true, categoryId: true, accountId: true, toAccountId: true, source: true },
        }),
      runs,
      "全量拉到 Node",
    ),
  );
  results.push(
    await runCase(
      "收支报表 · SQL 聚合对照（分类×日）",
      () =>
        prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
          SELECT "date" AS "day", "categoryId" AS "categoryId", COUNT(*) AS "count", SUM("amount") AS "sum"
          FROM "transactions"
          WHERE "householdId" = ${householdId}
            AND "deletedAt" IS NULL
            AND "date" >= ${from} AND "date" <= ${to}
            AND "type" IN ('income', 'expense')
          GROUP BY "date", "categoryId"
        `),
      runs,
      "第 2 档下推的上界",
    ),
  );

  console.log("耗时（连接与查询计划已预热，冷跑=进程内第一次）");
  console.log("");
  printTable(results);
  console.log("");
  console.log(`明细页账户：${detailAccountId || "(无)"}`);

  if (process.env.BENCH_SKIP_INDEX === "1") {
    console.log("索引诊断：已按 BENCH_SKIP_INDEX=1 跳过\n");
  } else {
    await printIndexDiagnostics(prisma, provider);
  }

  const failed = results.filter((result) => result.failed);
  await prisma.$disconnect();
  if (failed.length > 0) {
    console.error(`有 ${failed.length} 个用例失败，上面的数字不完整。`);
    process.exitCode = 1;
    return;
  }
  console.log(`基准时间 ${new Date().toISOString()}（改完索引/SQL 后重跑本命令对比）`);
  console.log("");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
