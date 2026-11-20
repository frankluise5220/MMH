import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3WithSafeRollback } from "./sqlite-adapter";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

/**
 * 池上限。NAS 机器上 pg 的 max_connections 通常只有 100，不能开太大；
 * 但 4 太小：手动备份/系统备份会在一个 `Promise.all` 里发起 80+ 条查询，
 * 4 个连接瞬间被占满，同期的页面请求全部排在队尾并撞 `connectionTimeoutMillis`
 * （2026-11-20 生产现象：每 6 小时自动备份时全站 500 约 5 分钟）。
 * 提到 8 让备份与页面各有一半可用的连接，配合 backup.ts 里的大表串行化。
 */
function defaultPgPoolMax() {
  return 8;
}

export function getConfiguredPgPoolMax() {
  const configured = Number(process.env.PG_POOL_MAX);
  return Number.isInteger(configured) && configured > 0 ? configured : defaultPgPoolMax();
}

/**
 * Default options for interactive transactions ($transaction(async (tx) => ...)).
 *
 * Prisma's built-in defaults are `maxWait: 2000` / `timeout: 5000`. Those are far
 * too tight for low-power NAS deployments (e.g. Synology DS with a Celeron J1900
 * and a slow disk): creating a ledger runs ~500 sequential statements inside one
 * transaction (default categories + ~176 default institutions, each doing a
 * conflict check + insert), which takes 4-6s there and randomly tripped
 * `P2028: A query cannot be executed on an expired transaction` — surfacing to
 * users as "ledger creation failed" with no useful detail.
 *
 * Raising the default here fixes every interactive transaction at once instead of
 * sprinkling per-call options across ~140 call sites. Override per deployment with
 * `PRISMA_TX_TIMEOUT_MS` / `PRISMA_TX_MAX_WAIT_MS` if needed.
 */
export function getConfiguredTransactionOptions() {
  const timeout = Number(process.env.PRISMA_TX_TIMEOUT_MS);
  const maxWait = Number(process.env.PRISMA_TX_MAX_WAIT_MS);
  return {
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
    maxWait: Number.isFinite(maxWait) && maxWait > 0 ? maxWait : 10_000,
  };
}

/**
 * 把几条查询排成一条串行链，避免它们在同一个 `Promise.all` 里同时抢连接。
 *
 * 只给备份导出里「单表就能读几十 MB」的查询用（`transactions`、`entryBusinessLinks`、
 * `attachments`、`entryTags`、`importBatches`）。链是进程级的，一旦有慢查询排进去，
 * 后续 `runSerialized` 调用都要等它，所以**不要**在请求路径上使用。
 */
let serializedTail: Promise<unknown> = Promise.resolve();

export function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = serializedTail.then(task, task);
  serializedTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 查询事件开关（只给 scripts/bench-reports.ts 这类性能排查用）：打开后每个 SQL 都
 * 发一个 `query` 事件，脚本可以拿到「一条请求发了几条 SQL、SQL 总共花了多久」，
 * 用来区分「数据库慢」和「JS 汇总慢」。用 emit:'event' 而不是 'query'，避免把每条
 * SQL 都打到 stdout。生产环境不要开。
 */
const queryLogEnabled = process.env.MMH_PRISMA_QUERY_LOG === "1";

function logConfig(): Array<Prisma.LogLevel | Prisma.LogDefinition> {
  return queryLogEnabled ? [{ emit: "event", level: "query" }, { emit: "stdout", level: "error" }] : ["error"];
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  if (connectionString === ":memory:" || connectionString.startsWith("file:")) {
    const adapter = new PrismaBetterSqlite3WithSafeRollback({
      url: connectionString,
    });
    return new PrismaClient({
      log: logConfig(),
      adapter,
      transactionOptions: getConfiguredTransactionOptions(),
    });
  }

  const pool = globalForPrisma.prismaPool ?? new Pool({
    connectionString,
    max: getConfiguredPgPoolMax(),
    // 5s 只够「池里有空连接」的场景；备份那几十条并发查询排队时，5s 会让备份自己
    // 和同期页面请求一起失败（报错文案是 pg-pool 的 connection timeout，看起来像数据库挂了）。
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 10_000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_INITIAL_DELAY_MS ?? 10_000),
  });
  // 空闲连接被服务端/中间设备掐断时 pg 会在这里抛错；没有监听器会变成
  // unhandled 'error' 事件直接带走进程，日志里也看不到原因。
  pool.on("error", (error) => {
    console.error("[prisma] pg pool idle client error:", error instanceof Error ? error.message : String(error));
  });
  globalForPrisma.prismaPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    log: logConfig(),
    adapter,
    transactionOptions: getConfiguredTransactionOptions(),
  });
}

// In dev mode, webpack hot-reloading re-evaluates this module each time.
// With binary engine (PRISMA_CLIENT_ENGINE_TYPE="binary"), each PrismaClient
// spawns a separate query-engine child process. Without caching on globalThis,
// every hot reload creates a new PrismaClient -> a new node process, leading
// to hundreds of zombie processes that never get cleaned up.
// By caching on globalThis, we reuse the same PrismaClient across hot reloads.
export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
