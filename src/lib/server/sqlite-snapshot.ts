import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { prisma } from "@/lib/db/prisma";
import { HOUSEHOLD_SCOPED_SETTING_NAMES } from "@/lib/server/system-setting";

type RestoreSqliteSnapshotProgress = {
  stage: "restoring" | "done";
  percent: number;
  label: string;
  detail?: string;
};

function snapshotError(message: string): never {
  throw new Error(message);
}

export function isSqliteFileDatabase(): boolean {
  const url = String(process.env.DATABASE_URL ?? "");
  return url.startsWith("file:") && url !== "file::memory:";
}

function sqliteDatabasePath(): string {
  const url = String(process.env.DATABASE_URL ?? "");
  const filePath = url.replace(/^file:/, "");
  if (!filePath) {
    snapshotError("当前数据库路径无法解析，无法执行整库备份");
  }
  return filePath;
}

function sidecarPaths(dbPath: string): string[] {
  return ["-journal", "-wal", "-shm"].map((suffix) => `${dbPath}${suffix}`);
}

export async function createSqliteSnapshotBuffer(): Promise<Buffer> {
  const dbPath = sqliteDatabasePath();
  const db = new Database(dbPath, { fileMustExist: true });
  const tmpPath = path.join(os.tmpdir(), `mmh-snapshot-${crypto.randomUUID()}.db`);
  try {
    await db.backup(tmpPath);
    const bytes = fs.readFileSync(tmpPath);
    return bytes;
  } finally {
    db.close();
    fs.rmSync(tmpPath, { force: true });
  }
}

function validateSqliteSnapshotFile(filePath: string): void {
  let db: Database | null = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma("integrity_check", { simple: true });
    if (typeof integrity !== "string" || integrity.toLowerCase() !== "ok") {
      snapshotError("备份数据库文件完整性校验失败，文件可能已损坏");
    }
    const householdTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = 'household'")
      .get();
    if (!householdTable) {
      snapshotError("备份数据库文件不是有效的 MMH 账簿数据");
    }
  } finally {
    db?.close();
  }
}

export async function restoreSqliteSnapshotBuffer(
  bytes: Buffer,
  onProgress?: (progress: RestoreSqliteSnapshotProgress) => void,
): Promise<{ transactionCount: number }> {
  const livePath = sqliteDatabasePath();
  const liveDir = path.dirname(livePath);
  fs.mkdirSync(liveDir, { recursive: true });

  const tmpPath = path.join(liveDir, `.mmh-restore-${crypto.randomUUID()}.db`);
  const preRestorePath = path.join(liveDir, `.mmh-pre-restore-${Date.now()}.db`);
  let swapped = false;

  fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
  onProgress?.({
    stage: "restoring",
    percent: 52,
    label: "校验备份",
    detail: "正在校验备份数据库文件完整性",
  });

  try {
    validateSqliteSnapshotFile(tmpPath);
    onProgress?.({
      stage: "restoring",
      percent: 60,
      label: "替换数据库",
      detail: "正在切换到备份时点的数据库文件",
    });

    await prisma.$disconnect();

    try {
      if (fs.existsSync(livePath)) {
        fs.copyFileSync(livePath, preRestorePath);
      }
      for (const sidecar of sidecarPaths(livePath)) {
        fs.rmSync(sidecar, { force: true });
      }
      fs.rmSync(livePath, { force: true });
      fs.renameSync(tmpPath, livePath);
      swapped = true;
    } finally {
      await prisma.$connect();
      fs.rmSync(tmpPath, { force: true });
    }
  } catch (error) {
    if (!swapped && fs.existsSync(preRestorePath) && !fs.existsSync(livePath)) {
      fs.copyFileSync(preRestorePath, livePath);
    }
    throw error;
  } finally {
    fs.rmSync(preRestorePath, { force: true });
  }

  onProgress?.({
    stage: "restoring",
    percent: 88,
    label: "读取恢复结果",
    detail: "正在确认恢复后的账簿数据",
  });

  let transactionCount = 0;
  try {
    transactionCount = await prisma.txRecord.count();
  } catch {
    transactionCount = 0;
  }

  onProgress?.({
    stage: "done",
    percent: 100,
    label: "恢复完成",
    detail: "整库数据已恢复到备份时点",
  });

  return { transactionCount };
}

function quoteSqliteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sqliteTableNames(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: unknown }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return rows.map((row) => String(row.name)).filter(Boolean);
}

async function sqliteColumnNames(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: unknown }>>(
    `PRAGMA table_info(${quoteSqliteIdentifier(table)})`,
  );
  return rows.map((row) => String(row.name)).filter(Boolean);
}

export type SnapshotHouseholdAlignment = {
  /** 真的改了 id 才为 true；同机恢复时是 false，成本为零。 */
  renamed: boolean;
  from: string | null;
  to: string;
  /** 参与改写的表数量。 */
  tables: number;
};

/**
 * 把刚换进来的快照文件「认领」到当前账簿 id。
 *
 * 快照是整库文件，里面带着导出方的 householdId。同机恢复时两者相同，直接返回，
 * 一个 UPDATE 都不发（所以仍是秒级）；跨机/跨账簿恢复时，把每一张带 householdId
 * 列的表整表改写成目标 id，再改 `Household` 行本身和 4 个 `<name>:<householdId>`
 * 形式的系统设置键。
 *
 * 只在「恢复后的库里恰好只有一个账簿」时动手：多账簿快照是整机搬迁语义，改 id 会把
 * 别的账簿一起并进来，必须原样保留。
 */
export async function alignRestoredSnapshotHousehold(
  toHouseholdId: string,
): Promise<SnapshotHouseholdAlignment> {
  const households = await prisma.$queryRawUnsafe<Array<{ id: unknown }>>('SELECT "id" FROM "Household"');
  if (households.length !== 1) {
    return { renamed: false, from: null, to: toHouseholdId, tables: 0 };
  }
  const from = String(households[0].id);
  if (from === toHouseholdId) {
    return { renamed: false, from, to: toHouseholdId, tables: 0 };
  }

  const tables: string[] = [];
  for (const table of await sqliteTableNames()) {
    if (table === "_prisma_migrations") continue;
    if ((await sqliteColumnNames(table)).includes("householdId")) tables.push(table);
  }

  await prisma.$transaction(
    async (tx) => {
      // 子表先改、父行后改，事务提交时才校验外键。
      await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
      for (const table of tables) {
        await tx.$executeRawUnsafe(
          `UPDATE ${quoteSqliteIdentifier(table)} SET "householdId" = ? WHERE "householdId" = ?`,
          toHouseholdId,
          from,
        );
      }
      await tx.$executeRawUnsafe('UPDATE "Household" SET "id" = ? WHERE "id" = ?', toHouseholdId, from);
      for (const name of HOUSEHOLD_SCOPED_SETTING_NAMES) {
        await tx.$executeRawUnsafe(
          'UPDATE "SystemSetting" SET "key" = ? WHERE "key" = ?',
          `${name}:${toHouseholdId}`,
          `${name}:${from}`,
        );
      }
    },
    { maxWait: 30_000, timeout: 600_000 },
  );

  return { renamed: true, from, to: toHouseholdId, tables: tables.length };
}

/** 恢复前抓下来的本机登录用户。整库替换会把它连同旧库一起丢掉。 */
export type SnapshotLoginUser = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  isSystem: boolean;
  passwordHash: string | null;
  authVersion: number;
  registrationPrincipalId: string | null;
  registrationEmail: string | null;
  fnosUid: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * 换文件之前先把当前登录用户读出来。
 *
 * 账簿恢复的语义是「成员整个来自备份，但你还用本机的账号登录」：快照里的 User 表属于
 * 导出方，换完之后本机用户就不存在了。把这一行留一份，恢复完再插回去，登录身份、
 * 密码哈希、authVersion 都不变 —— 已经签发的会话因此继续有效，不用重新登录。
 */
export async function captureSnapshotLoginUser(userId: string): Promise<SnapshotLoginUser | null> {
  const row = await prisma.user.findUnique({ where: { id: userId } });
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    isSystem: row.isSystem,
    passwordHash: row.passwordHash,
    authVersion: row.authVersion,
    registrationPrincipalId: row.registrationPrincipalId,
    registrationEmail: row.registrationEmail,
    fnosUid: row.fnosUid,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type SnapshotLoginUserState =
  /** 快照里本来就有同 id 的用户（同机恢复），无需处理。 */
  | "kept"
  | "restored"
  | "skipped";

/**
 * 把本机登录用户放回刚恢复的库。失败不打断恢复：账已经进去了，登录可以另行处理。
 */
export async function reinstateSnapshotLoginUser(
  user: SnapshotLoginUser,
  householdId: string,
): Promise<SnapshotLoginUserState> {
  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true } });
  if (existing) return "kept";

  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { id: true } });
  if (!household) return "skipped";

  try {
    await prisma.user.create({ data: { ...user, householdId } });
    return "restored";
  } catch {
    // `@@unique([householdId, fnosUid])`：快照里已经有同 fnOS UID 的成员。放弃这个可选
    // 绑定再插一次 —— 登录靠 id + 密码哈希，绑定丢了不影响本机账号还能用。
    try {
      await prisma.user.create({ data: { ...user, householdId, fnosUid: null } });
      return "restored";
    } catch (error) {
      console.warn("恢复整库快照：保留本机登录用户失败", error);
      return "skipped";
    }
  }
}
