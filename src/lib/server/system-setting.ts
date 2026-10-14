import type { Prisma, PrismaClient } from "@prisma/client";
import { EMAIL_IMPORT_KEYWORD_SETTING_NAME } from "@/lib/mail/email-import-settings";

/**
 * SystemSetting is a flat key/value table with no householdId column, so
 * household-scoped settings must encode the ledger in the key itself. Every
 * read/write goes through this module so the `<name>:<householdId>` convention
 * is applied in exactly one place and cannot be silently forgotten.
 *
 * The Prisma client is imported lazily on purpose: importing it eagerly throws
 * when `DATABASE_URL` is unset, which would break server components (they import
 * this module transitively) during build.
 */
export type SystemSettingDb = Prisma.TransactionClient | PrismaClient;

export const CATEGORY_HIERARCHY_SETTING_NAME = "category_hierarchy_normalized";
export const DELETED_DEFAULT_CATEGORY_SETTING_NAME = "category_deleted_default_templates";

/**
 * Every household-scoped setting name. Adding one here is what makes it travel
 * with household backups and get remapped on restore — a setting that is only
 * given a householdId at the call site would silently stay behind.
 */
export const HOUSEHOLD_SCOPED_SETTING_NAMES = [
  CATEGORY_HIERARCHY_SETTING_NAME,
  DELETED_DEFAULT_CATEGORY_SETTING_NAME,
  EMAIL_IMPORT_KEYWORD_SETTING_NAME,
] as const;

export type SystemSettingOptions = {
  /** When set, the key becomes `<name>:<householdId>`. Omit for global settings. */
  householdId?: string | null;
  /** Pass a transaction client to keep the write inside the caller's transaction. */
  db?: SystemSettingDb;
};

let defaultClientPromise: Promise<PrismaClient> | null = null;

function defaultDb(): Promise<PrismaClient> {
  defaultClientPromise ??= import("@/lib/db/prisma").then((mod) => mod.prisma);
  return defaultClientPromise;
}

export function systemSettingKey(name: string, householdId?: string | null) {
  return householdId ? `${name}:${householdId}` : name;
}

export async function getSystemSetting(name: string, options: SystemSettingOptions = {}): Promise<string | null> {
  const key = systemSettingKey(name, options.householdId);
  const db = options.db ?? (await defaultDb());
  const row = await db.systemSetting.findUnique({ where: { key }, select: { value: true } });
  return row?.value ?? null;
}

export async function getSystemSettings(
  names: string[],
  options: SystemSettingOptions = {},
): Promise<Record<string, string | null>> {
  const db = options.db ?? (await defaultDb());
  const keyFor = (name: string) => systemSettingKey(name, options.householdId);
  const rows = await db.systemSetting.findMany({
    where: { key: { in: names.map(keyFor) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const values: Record<string, string | null> = {};
  for (const name of names) values[name] = byKey.get(keyFor(name)) ?? null;
  return values;
}

export async function setSystemSetting(name: string, value: string, options: SystemSettingOptions = {}): Promise<void> {
  const key = systemSettingKey(name, options.householdId);
  const db = options.db ?? (await defaultDb());
  await db.systemSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/**
 * Writes `value` only when the setting is missing and returns the stored value.
 * Concurrent first-writers cannot overwrite each other, so this is the safe way
 * to generate a one-off value (installation id, master keys, ...).
 */
export async function ensureSystemSetting(
  name: string,
  value: string,
  options: SystemSettingOptions = {},
): Promise<string> {
  const key = systemSettingKey(name, options.householdId);
  const db = options.db ?? (await defaultDb());
  await db.systemSetting.upsert({
    where: { key },
    create: { key, value },
    update: {},
  });
  return (await getSystemSetting(name, options)) ?? value;
}

/** No-op when the setting does not exist, so callers do not need try/catch. */
export async function deleteSystemSetting(name: string, options: SystemSettingOptions = {}): Promise<void> {
  const key = systemSettingKey(name, options.householdId);
  const db = options.db ?? (await defaultDb());
  await db.systemSetting.deleteMany({ where: { key } });
}

export function parseJsonSetting<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readJsonSystemSetting<T>(
  name: string,
  fallback: T,
  options: SystemSettingOptions = {},
): Promise<T> {
  const parsed = parseJsonSetting<T>(await getSystemSetting(name, options));
  return parsed ?? fallback;
}

export async function writeJsonSystemSetting<T>(
  name: string,
  value: T,
  options: SystemSettingOptions = {},
): Promise<void> {
  await setSystemSetting(name, JSON.stringify(value), options);
}
