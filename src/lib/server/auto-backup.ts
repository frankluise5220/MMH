import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  encryptBackupBytes,
  encryptBackupPayload,
} from "@/lib/server/backup";
import { encodeBackupPackage } from "@/lib/server/backup-package";
import {
  DEFAULT_REMOTE_BACKUP_SETTINGS,
  asBackupPathFailure,
  createBackupTarget,
  describeBackupTarget,
  normalizeRemoteBackupSettings,
  type BackupDestination,
  type BackupFileInfo,
  type BackupPathFailure,
  type BackupTarget,
  type DiskInfo,
  type RemoteBackupSettings,
} from "@/lib/server/backup-target";
import { createSqliteSnapshotBuffer, isSqliteFileDatabase } from "@/lib/server/sqlite-snapshot";
import { readJsonSystemSetting, writeJsonSystemSetting } from "@/lib/server/system-setting";

export { defaultAutoBackupDir, formatDiskBytes, getPathDiskInfo } from "@/lib/server/backup-target";
export type { BackupDestination, RemoteBackupSettings } from "@/lib/server/backup-target";

/**
 * Server-side automatic backup (NAS / Docker / desktop).
 *
 * Configuration and last-run status are stored in `SystemSetting` so every
 * deployment flavor (SQLite and Postgres) shares the same code path and no
 * schema migration is required. The scheduler lives in `instrumentation-node.ts`
 * and checks `runAutoBackupTick()` on the system-task interval.
 *
 * Packages use the configured passphrase when one is set. When it is empty,
 * automatic backups keep the legacy behavior of using the deployment-level
 * `backup_package_encryption_key`, so they can be restored without a passphrase
 * on the same deployment.
 */
const AUTO_BACKUP_CONFIG_KEY = "auto_backup_config";
const AUTO_BACKUP_STATUS_KEY = "auto_backup_status";

export type AutoBackupFrequencyType = "daily" | "weekly" | "interval";

export type AutoBackupConfig = {
  enabled: boolean;
  /** "daily" = every day at `time`; "weekly" = every `weekday` at `time`; "interval" = every `everyHours` hours */
  frequencyType: AutoBackupFrequencyType;
  /** "HH:mm" (24h), used by daily / weekly */
  time: string;
  /** 0 = Sunday .. 6 = Saturday, used by weekly */
  weekday: number;
  /** hours between runs (1..720), used by interval */
  everyHours: number;
  /** "system" = whole-database snapshot (SQLite only); "household" = one encrypted package per household */
  scope: "system" | "household";
  /** local directory on the server; empty string resolves to defaultAutoBackupDir() */
  path: string;
  /** where packages are written: a local directory, WebDAV or FTP */
  destination: BackupDestination;
  /** network target settings; ignored when destination = "local" */
  remote: RemoteBackupSettings;
  /** optional passphrase for portable encrypted backups; empty uses the system key */
  passphrase: string;
  /** how many most recent backup files to keep (1..100) */
  keepCount: number;
};

export type AutoBackupStatus = {
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastError: string | null;
  nextRunAt: string | null;
};

type AutoBackupRunResult = {
  scope: AutoBackupConfig["scope"];
  files: string[];
};

const DEFAULT_CONFIG: AutoBackupConfig = {
  enabled: false,
  frequencyType: "daily",
  time: "02:00",
  weekday: 1,
  everyHours: 24,
  scope: "system",
  path: "",
  destination: "local",
  remote: DEFAULT_REMOTE_BACKUP_SETTINGS,
  passphrase: "",
  keepCount: 7,
};
const WINDOWS_STARTUP_BACKUP_STALE_MS = 24 * 3600_000;

function configError(message: string): never {
  throw new Error(message);
}

function normalizeAutoBackupConfig(raw: unknown): AutoBackupConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const frequencyType = obj.frequencyType === "weekly" || obj.frequencyType === "interval" ? obj.frequencyType : "daily";
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(obj.time ?? "")) ? String(obj.time) : DEFAULT_CONFIG.time;
  let weekday = Number(obj.weekday ?? DEFAULT_CONFIG.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) weekday = DEFAULT_CONFIG.weekday;
  let everyHours = Number(obj.everyHours ?? DEFAULT_CONFIG.everyHours);
  if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 720) everyHours = DEFAULT_CONFIG.everyHours;
  let keepCount = Number(obj.keepCount ?? DEFAULT_CONFIG.keepCount);
  if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > 100) keepCount = DEFAULT_CONFIG.keepCount;
  const destination: BackupDestination =
    obj.destination === "webdav" || obj.destination === "ftp" || obj.destination === "smb" ? obj.destination : "local";
  return {
    enabled: obj.enabled === true,
    frequencyType,
    time,
    weekday,
    everyHours,
    scope: obj.scope === "system" ? "system" : "household",
    path: String(obj.path ?? "").trim(),
    destination,
    remote: normalizeRemoteBackupSettings(obj.remote),
    passphrase: String(obj.passphrase ?? "").trim(),
    keepCount,
  };
}

export type BackupPathProbeResult =
  | { ok: true; dir: string; disk: DiskInfo | null }
  | { ok: false; dir: string; error: string; code: string };

/**
 * Verifies that the configured destination can be reached and written to, and
 * returns the free space of a local disk when available. Used before saving the
 * config so a bad path / bad credentials are rejected at save time instead of
 * at 3am during a scheduled run.
 */
export async function probeBackupConfig(raw: unknown): Promise<BackupPathProbeResult> {
  const config = normalizeAutoBackupConfig(raw);
  const dir = describeBackupTarget(config);
  try {
    const target = createBackupTarget(config);
    await target.probe();
    return { ok: true, dir: target.location, disk: await target.disk() };
  } catch (error) {
    const failure = asBackupPathFailure(dir, error);
    return {
      ok: false,
      dir,
      error: failure.message,
      code: (failure as BackupPathFailure).code ?? "BACKUP_PATH_NOT_WRITABLE",
    };
  }
}

/** Backwards-compatible probe for a plain local directory. */
export async function probeBackupPath(target: string): Promise<BackupPathProbeResult> {
  return probeBackupConfig({ path: target });
}

export async function loadAutoBackupConfig(): Promise<AutoBackupConfig> {
  return normalizeAutoBackupConfig(await readJsonSystemSetting(AUTO_BACKUP_CONFIG_KEY, null));
}

export async function saveAutoBackupConfig(config: unknown): Promise<AutoBackupConfig> {
  const normalized = normalizeAutoBackupConfig(config);
  await writeJsonSystemSetting(AUTO_BACKUP_CONFIG_KEY, normalized);
  return normalized;
}

export async function loadAutoBackupStatus(): Promise<AutoBackupStatus> {
  const obj = await readJsonSystemSetting<Record<string, unknown>>(AUTO_BACKUP_STATUS_KEY, {});
  return {
    lastRunAt: typeof obj.lastRunAt === "string" ? obj.lastRunAt : null,
    lastRunOk: typeof obj.lastRunOk === "boolean" ? obj.lastRunOk : null,
    lastError: typeof obj.lastError === "string" ? obj.lastError : null,
    nextRunAt: typeof obj.nextRunAt === "string" ? obj.nextRunAt : null,
  };
}

export async function saveAutoBackupStatus(status: AutoBackupStatus): Promise<void> {
  await writeJsonSystemSetting(AUTO_BACKUP_STATUS_KEY, status);
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Computes the next scheduled run strictly after `now`. `lastRunAt` is only
 * relevant for the interval frequency (next = lastRun + everyHours).
 */
export function computeNextRunAt(config: AutoBackupConfig, now: Date, lastRunAt: Date | null = null): Date {
  if (config.frequencyType === "interval") {
    const base = lastRunAt && lastRunAt.getTime() > 0 ? lastRunAt : now;
    return new Date(base.getTime() + config.everyHours * 3600_000);
  }

  const [hour, minute] = config.time.split(":").map(Number);
  if (config.frequencyType === "weekly") {
    const candidate = startOfDay(now);
    candidate.setHours(hour, minute, 0, 0);
    const daysAhead = (config.weekday - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + daysAhead);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 7);
    }
    return candidate;
  }

  const candidate = startOfDay(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function isAutoBackupDue(config: AutoBackupConfig, status: AutoBackupStatus, now: Date): boolean {
  if (!config.enabled) return false;
  if (!status.nextRunAt) return false;
  const nextRunAt = new Date(status.nextRunAt).getTime();
  if (!Number.isFinite(nextRunAt)) return false;
  return nextRunAt <= now.getTime();
}

function backupFileName(name: string, exportedAt: Date): string {
  return buildBackupFileName(name, exportedAt, "mmh-backup");
}

const BACKUP_FILE_RE = /\.(?:mmh-backup|mmhbackup)$/i;

async function listBackupFiles(target: BackupTarget): Promise<BackupFileInfo[]> {
  try {
    const files = await target.list();
    return files
      .filter((file) => BACKUP_FILE_RE.test(file.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

async function cleanupOldBackups(target: BackupTarget, keepCount: number): Promise<void> {
  const backups = await listBackupFiles(target);
  for (const stale of backups.slice(keepCount)) {
    try {
      await target.remove(stale.name);
      logger.info(`auto backup pruned stale file: ${stale.name}`, "auto-backup");
    } catch {
      // Best-effort cleanup; a locked file must not break the backup run.
    }
  }
}

async function getLatestAutoBackupFileMtime(target: BackupTarget): Promise<Date | null> {
  const backups = await listBackupFiles(target);
  const latest = backups.reduce((max, file) => (Number.isFinite(file.mtimeMs) ? Math.max(max, file.mtimeMs) : max), 0);
  return latest > 0 ? new Date(latest) : null;
}

async function isAutoBackupFileStale(
  target: BackupTarget,
  now: Date,
  staleMs = WINDOWS_STARTUP_BACKUP_STALE_MS,
): Promise<boolean> {
  const latest = await getLatestAutoBackupFileMtime(target);
  if (!latest) return true;
  return now.getTime() - latest.getTime() >= staleMs;
}

/**
 * Runs one automatic backup now: resolves the target directory, writes
 * encrypted packages (whole-db snapshot for scope=system on SQLite, otherwise
 * one package per household), then prunes files beyond keepCount.
 *
 * Pass `{ force: true }` to run even when the config is disabled (used by the
 * "run now" action).
 */
export async function runAutoBackupNow(
  config?: AutoBackupConfig,
  options: { force?: boolean } = {},
): Promise<AutoBackupRunResult> {
  const resolved = config ?? (await loadAutoBackupConfig());
  if (!resolved.enabled && !options.force) {
    return { scope: resolved.scope, files: [] };
  }

  const target = createBackupTarget(resolved);
  const exportedAt = new Date();
  const files: string[] = [];

  if (resolved.scope === "system") {
    if (!isSqliteFileDatabase()) {
      configError("current database does not support whole-db snapshot backup; use per-household scope instead");
    }
    const snapshot = await createSqliteSnapshotBuffer();
    const firstHousehold = await prisma.household.findFirst({ orderBy: { createdAt: "asc" } });
    const packageObject = await encryptBackupBytes(
      snapshot,
      {
        householdId: firstHousehold?.id ?? "system",
        householdName: firstHousehold?.name ?? "system",
        backupScope: "system",
      },
      exportedAt,
      { passphrase: resolved.passphrase, useSystemKeyWhenNoPassphrase: true },
    );
    const fileName = backupFileName("system", exportedAt);
    await target.write(fileName, encodeBackupPackage(packageObject));
    files.push(fileName);
  } else {
    const households = await prisma.household.findMany({ orderBy: { createdAt: "asc" } });
    if (households.length === 0) {
      configError("no household found; automatic backup has nothing to back up");
    }
    for (const household of households) {
      const payload = await buildHouseholdBackupPayload(household.id, null, { backupScope: "household" });
      const packageObject = await encryptBackupPayload(payload, {
        passphrase: resolved.passphrase,
        useSystemKeyWhenNoPassphrase: true,
      });
      const fileName = backupFileName(household.name, exportedAt);
      await target.write(fileName, encodeBackupPackage(packageObject));
      files.push(fileName);
    }
  }

  await cleanupOldBackups(target, resolved.keepCount);
  return { scope: resolved.scope, files };
}

/**
 * Scheduler entry called from the system-task tick. Returns the run result
 * when a run happened, or null when disabled / not due. Never throws.
 */
export async function runAutoBackupTick(): Promise<AutoBackupRunResult | null> {
  let config: AutoBackupConfig | null = null;
  try {
    config = await loadAutoBackupConfig();
    if (!config.enabled) return null;
    const status = await loadAutoBackupStatus();
    const now = new Date();
    if (!isAutoBackupDue(config, status, now)) return null;

    const result = await runAutoBackupNow(config);
    await saveAutoBackupStatus({
      lastRunAt: now.toISOString(),
      lastRunOk: true,
      lastError: null,
      nextRunAt: computeNextRunAt(config, now, now).toISOString(),
    });
    logger.info(`auto backup completed: ${result.files.join(", ")}`, "auto-backup");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`auto backup failed: ${message}`, "auto-backup");
    try {
      const now = new Date();
      const fallbackConfig = config ?? (await loadAutoBackupConfig());
      await saveAutoBackupStatus({
        lastRunAt: now.toISOString(),
        lastRunOk: false,
        lastError: message,
        nextRunAt: fallbackConfig.enabled ? computeNextRunAt(fallbackConfig, now, now).toISOString() : null,
      });
    } catch {
      // Never let status persistence failures escape the tick.
    }
    return null;
  }
}

/**
 * Windows desktop does not keep the server alive after the app is closed, so
 * a scheduled backup may be missed. On startup, catch up in the background when
 * automatic backup is enabled and the newest backup file is at least 24h old.
 */
export async function runWindowsStartupAutoBackupIfStale(): Promise<AutoBackupRunResult | null> {
  if (String(process.env.MMH_DEPLOY_TARGET ?? "").trim().toLowerCase() !== "windows") return null;

  let config: AutoBackupConfig | null = null;
  const now = new Date();
  try {
    config = await loadAutoBackupConfig();
    if (!config.enabled) return null;

    const target = createBackupTarget(config);
    if (!(await isAutoBackupFileStale(target, now))) return null;

    const result = await runAutoBackupNow(config, { force: true });
    await saveAutoBackupStatus({
      lastRunAt: now.toISOString(),
      lastRunOk: true,
      lastError: null,
      nextRunAt: computeNextRunAt(config, now, now).toISOString(),
    });
    logger.info(`windows startup auto backup completed: ${result.files.join(", ")}`, "auto-backup");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`windows startup auto backup failed: ${message}`, "auto-backup");
    try {
      const fallbackConfig = config ?? (await loadAutoBackupConfig());
      await saveAutoBackupStatus({
        lastRunAt: now.toISOString(),
        lastRunOk: false,
        lastError: message,
        nextRunAt: fallbackConfig.enabled ? computeNextRunAt(fallbackConfig, now, now).toISOString() : null,
      });
    } catch {
      // Keep startup non-blocking even if status persistence fails.
    }
    return null;
  }
}
