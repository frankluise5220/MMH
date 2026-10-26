import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/** better-sqlite3 语句的最小子集（只用到恢复批量写入需要的那几个方法）。 */
export type NativeSqliteStatement = {
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => unknown;
};

/** better-sqlite3 连接的最小子集。 */
export type NativeSqliteClient = {
  open: boolean;
  prepare: (sql: string) => NativeSqliteStatement;
};

/**
 * 底层 better-sqlite3 连接。恢复时要绕开 Prisma 的逐行开销直接批量写入，
 * 必须复用这同一条连接 —— 另开连接会在 Prisma 事务持写锁时死锁。
 */
let connectedClient: NativeSqliteClient | null = null;

export function getNativeSqliteClient(): NativeSqliteClient | null {
  return connectedClient;
}

/** Compensate for Prisma 7.8 discarding a late-started transaction via rollback() alone. */
export class PrismaBetterSqlite3WithSafeRollback extends PrismaBetterSqlite3 {
  override async connect() {
    const adapter = await super.connect();
    connectedClient = (adapter as unknown as { client?: NativeSqliteClient }).client ?? null;
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args) => {
      const transaction = await startTransaction(...args);
      if (transaction.options.usePhantomQuery) return transaction;

      const executeRaw = transaction.executeRaw.bind(transaction);
      const rollback = transaction.rollback.bind(transaction);
      let closed = false;
      transaction.executeRaw = async (query) => {
        const result = await executeRaw(query);
        if (query.sql === "COMMIT" || query.sql === "ROLLBACK") closed = true;
        return result;
      };
      transaction.rollback = async () => {
        try {
          // Normal closure sends SQL first. Startup timeout skips that SQL; the
          // adapter's rollback only unlocks its mutex, leaving SQLite in BEGIN.
          if (!closed) await transaction.executeRaw({ sql: "ROLLBACK", args: [], argTypes: [] });
        } finally {
          await rollback();
        }
      };
      return transaction;
    };
    return adapter;
  }
}
