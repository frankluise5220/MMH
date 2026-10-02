import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3WithSafeRollback } from "./sqlite-adapter";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

function defaultPgPoolMax() {
  return process.env.NODE_ENV === "production" ? 4 : 8;
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
      log: ["error"],
      adapter,
      transactionOptions: getConfiguredTransactionOptions(),
    });
  }

  const pool = globalForPrisma.prismaPool ?? new Pool({
    connectionString,
    max: getConfiguredPgPoolMax(),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 5_000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_INITIAL_DELAY_MS ?? 10_000),
  });
  globalForPrisma.prismaPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    log: ["error"],
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
