import { getNativeSqliteClient, type NativeSqliteClient, type NativeSqliteStatement } from "@/lib/db/sqlite-adapter";

/**
 * SQLite 上的「原生批量写入」。
 *
 * 为什么需要它：恢复一个 5.6 万条交易的账簿时，`createMany` 要花 62 秒（本地 NVMe 实测），
 * 换成 better-sqlite3 的预编译语句后同样的数据只要 1 秒级。瓶颈不在 SQLite，而在 Prisma
 * 客户端：每一行都要走一遍 query graph 的构建与序列化，低功耗 NAS 上单行能到 1ms，
 * 10 万条就是一分半到十几分钟。
 *
 * 安全前提：
 * - 只在恢复事务**内部**调用。恢复是单个 Prisma 交互事务，adapter 已经在同一条
 *   better-sqlite3 连接上 `BEGIN`，这里同步执行的语句天然属于该事务，不需要也不允许再开事务。
 * - 列类型按 `PRAGMA table_info` 的实际声明推导，值按 Prisma adapter 的规则转换
 *   （DateTime → ISO8601 带 +00:00、Decimal → number、Boolean → 0/1），保证与 Prisma
 *   自己写出来的字节完全一致。
 * - 包里的旧字段（当前库里已不存在的列）会被跳过，这比 Prisma 抛 "Unknown argument" 更宽容。
 */

type ColumnKind = "datetime" | "number" | "boolean" | "text" | "blob";

type TableColumn = {
  name: string;
  kind: ColumnKind;
  notNull: boolean;
  hasDefault: boolean;
};

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type ClientCache = {
  columns: Map<string, TableColumn[]>;
  statements: Map<string, NativeSqliteStatement>;
};

// 缓存按连接存：快照恢复会 disconnect / connect，旧连接上的预编译语句随之失效。
const clientCaches = new WeakMap<NativeSqliteClient, ClientCache>();

function cacheFor(client: NativeSqliteClient): ClientCache {
  let cache = clientCaches.get(client);
  if (!cache) {
    cache = { columns: new Map(), statements: new Map() };
    clientCaches.set(client, cache);
  }
  return cache;
}

function classifyDeclaredType(declared: string): ColumnKind {
  const type = declared.toUpperCase();
  if (type.includes("DATE") || type.includes("TIME")) return "datetime";
  if (type.includes("BOOL")) return "boolean";
  if (type.includes("BLOB")) return "blob";
  if (type.includes("INT") || type.includes("DEC") || type.includes("NUM") || type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
    return "number";
  }
  return "text";
}

function tableColumns(client: NativeSqliteClient, table: string): TableColumn[] {
  const cache = cacheFor(client);
  const cached = cache.columns.get(table);
  if (cached) return cached;
  const rows = client.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as TableInfoRow[];
  const columns = rows.map((row) => ({
    name: row.name,
    kind: classifyDeclaredType(String(row.type ?? "")),
    notNull: Number(row.notnull) === 1,
    hasDefault: row.dflt_value != null,
  }));
  cache.columns.set(table, columns);
  return columns;
}

function toIsoDateTimeString(value: Date) {
  // 与 @prisma/adapter-better-sqlite3 的 mapArg 保持完全一致（不是 toISOString() 的 Z 结尾）。
  return value.toISOString().replace("Z", "+00:00");
}

function toStoredValue(column: TableColumn, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  switch (column.kind) {
    case "datetime": {
      if (value instanceof Date) return toIsoDateTimeString(value);
      const text = String(value).trim();
      if (text === "") return null;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? null : toIsoDateTimeString(parsed);
    }
    case "boolean": {
      if (typeof value === "boolean") return value ? 1 : 0;
      if (typeof value === "number") return value === 0 ? 0 : 1;
      return value === "0" || value === "false" ? 0 : 1;
    }
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "boolean") return value ? 1 : 0;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "blob": {
      if (Buffer.isBuffer(value)) return value;
      return Buffer.from(String(value), "base64");
    }
    default: {
      if (typeof value === "string") return value;
      if (value instanceof Date) return toIsoDateTimeString(value);
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }
  }
}

/**
 * 拿不到原生连接（不是 SQLite 部署，或者 Prisma 还没 connect）时返回 null，
 * 调用方退回 Prisma 的 `createMany`。
 */
export function createSqliteBulkInserter(table: string) {
  return (rows: Record<string, unknown>[]): boolean => {
    if (rows.length === 0) return true;
    const client = getNativeSqliteClient();
    if (!client || !client.open) return false;

    const columns = tableColumns(client, table);
    if (columns.length === 0) return false;

    // 列集合取所有行键的并集，且只保留当前库里真实存在的列。
    const present = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) present.add(key);
    }
    const usable = columns.filter((column) => present.has(column.name));
    if (usable.length === 0) return false;

    // 包里缺了这个列、而库里的列既非空又没有默认值 —— 原生路径写不进去，交回 Prisma 报错。
    const insertable = new Set(usable.map((column) => column.name));
    for (const column of columns) {
      if (insertable.has(column.name)) continue;
      if (column.notNull && !column.hasDefault) return false;
    }

    const cache = cacheFor(client);
    const key = `${table}|${usable.map((column) => column.name).join(",")}`;
    let statement = cache.statements.get(key);
    if (!statement) {
      const quotedTable = `"${table.replace(/"/g, '""')}"`;
      const columnList = usable.map((column) => `"${column.name.replace(/"/g, '""')}"`).join(", ");
      const placeholders = usable.map(() => "?").join(", ");
      statement = client.prepare(`INSERT INTO ${quotedTable} (${columnList}) VALUES (${placeholders})`);
      cache.statements.set(key, statement);
    }

    // 恢复是先清空再写入，父行可能排在后面的批次里。SQLite 在 RELEASE SAVEPOINT 时会立刻
    // 校验延迟外键，导致「父行还没插进来」的批次误报 FOREIGN KEY constraint failed。
    // 把外键检查推迟到整个事务 COMMIT（与 Prisma 自己写时的行为一致），真有问题仍会在提交时暴露。
    client.prepare("PRAGMA defer_foreign_keys = ON").run();

    // 用 SAVEPOINT 隔离：某一行写不进去时只回滚这一批，调用方可以安全地退回 createMany，
    // 不会留下半批数据导致主键冲突。
    client.prepare("SAVEPOINT mmh_bulk_insert").run();
    try {
      for (const row of rows) {
        const values = usable.map((column) => toStoredValue(column, row[column.name]));
        statement.run(...(values as never[]));
      }
      client.prepare("RELEASE mmh_bulk_insert").run();
    } catch (error) {
      client.prepare("ROLLBACK TO mmh_bulk_insert").run();
      client.prepare("RELEASE mmh_bulk_insert").run();
      throw error;
    }
    return true;
  };
}
