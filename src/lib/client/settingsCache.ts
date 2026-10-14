"use client";

import { normalizeEmailImportKeyword } from "@/lib/mail/email-import-settings";

export type SettingsAccountGroup = { id: string; name: string; sortOrder?: number };
export type SettingsInstitution = { id: string; name: string; shortName?: string | null; type?: string | null };
export type SettingsCounterparty = { id: string; name: string; shortName?: string | null; type?: string | null; isReimbursable?: boolean | null };
export type SettingsUser = { id: string; name: string };
export type SettingsCategory = { id: string; name: string; type: string; parentId?: string | null; sortOrder?: number; isSystem?: boolean };
export type SettingsAccountData = {
  baseCurrency?: string;
  accounts: unknown[];
  groups: SettingsAccountGroup[];
  institutions: SettingsInstitution[];
  counterparties?: SettingsCounterparty[];
  users?: SettingsUser[];
};
export type SettingsTag = { id: string; name: string; color: string | null };
export type SettingsBootstrapData = SettingsAccountData & {
  users: SettingsUser[];
  categories: SettingsCategory[];
  tags: SettingsTag[];
};
export type SettingsDataScope = "accounts" | "categories" | "tags" | "all";
export type SettingsDataChangedDetail = {
  scope: SettingsDataScope;
  reason?: string;
};
export type SettingsDataChangeOptions = {
  scope?: SettingsDataScope;
  reason?: string;
  prefetch?: boolean;
  invalidate?: boolean;
};

const ACCOUNT_DATA_KEY = "accounts-basic";
const BOOTSTRAP_KEY = "settings-bootstrap";
const CATEGORIES_KEY = "categories";
const TAGS_KEY = "tags";
// Email accounts carry IMAP credentials, so this key is memory-only and is
// never written to localStorage.
const EMAIL_ACCOUNTS_KEY = "email-accounts";
const EMAIL_IMPORT_KEYWORD_KEY = "email-import-keyword";
const TTL_MS = 60_000;
const HOUSEHOLD_COOKIE = "householdId";
const PERSIST_PREFIX = "mmh:settings:accounts-basic:";
const PERSIST_VERSION = 1;
export const SETTINGS_DATA_CHANGED_EVENT = "mmh:settings:data-changed";

type CacheEntry<T> = {
  value?: T;
  promise?: Promise<T>;
  updatedAt: number;
};

type PersistedAccountEnvelope = {
  v: number;
  householdId: string;
  updatedAt: number;
  value: SettingsAccountData;
};

const cache = new Map<string, CacheEntry<unknown>>();
let hydratedHouseholdId: string | null = null;

function isFresh(entry: CacheEntry<unknown> | undefined) {
  return Boolean(entry?.value) && Date.now() - entry!.updatedAt < TTL_MS;
}

function readHouseholdId() {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(new RegExp(`(?:^|; )${HOUSEHOLD_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function persistStorageKey(householdId: string) {
  return `${PERSIST_PREFIX}${householdId}`;
}

function readPersistedAccountData(householdId: string): { value: SettingsAccountData; updatedAt: number } | null {
  if (typeof window === "undefined" || !householdId) return null;
  try {
    const raw = window.localStorage.getItem(persistStorageKey(householdId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedAccountEnvelope;
    if (parsed?.v !== PERSIST_VERSION) return null;
    if (parsed.householdId !== householdId) return null;
    if (!parsed.value || !Array.isArray(parsed.value.accounts) || !Array.isArray(parsed.value.groups)) return null;
    return { value: parsed.value, updatedAt: Number(parsed.updatedAt) || 0 };
  } catch {
    return null;
  }
}

function writePersistedAccountData(value: SettingsAccountData, updatedAt = Date.now()) {
  if (typeof window === "undefined") return;
  const householdId = readHouseholdId();
  if (!householdId) return;
  try {
    const envelope: PersistedAccountEnvelope = { v: PERSIST_VERSION, householdId, updatedAt, value };
    window.localStorage.setItem(persistStorageKey(householdId), JSON.stringify(envelope));
  } catch {
    // Quota / private mode: memory cache still works.
  }
}

function clearPersistedAccountData() {
  if (typeof window === "undefined") return;
  const householdId = readHouseholdId();
  if (!householdId) return;
  try {
    window.localStorage.removeItem(persistStorageKey(householdId));
  } catch {
    // ignore
  }
}

function hydrateAccountCacheFromPersist() {
  if (typeof window === "undefined") return;
  const householdId = readHouseholdId();
  if (hydratedHouseholdId === householdId) return;
  if (hydratedHouseholdId && hydratedHouseholdId !== householdId) {
    cache.delete(ACCOUNT_DATA_KEY);
    cache.delete(BOOTSTRAP_KEY);
    cache.delete(CATEGORIES_KEY);
    cache.delete(TAGS_KEY);
    cache.delete(EMAIL_ACCOUNTS_KEY);
    cache.delete(EMAIL_IMPORT_KEYWORD_KEY);
  }
  hydratedHouseholdId = householdId;
  const existing = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  if (existing?.value) return;
  const persisted = readPersistedAccountData(householdId);
  if (!persisted) return;
  cache.set(ACCOUNT_DATA_KEY, { value: persisted.value, updatedAt: persisted.updatedAt });
}

export function getCachedSettingsAccountData() {
  hydrateAccountCacheFromPersist();
  const entry = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  return entry?.value ?? null;
}

function setCacheValue<T>(key: string, value: T) {
  cache.set(key, { value, updatedAt: Date.now() });
}

function setAccountDataCache(value: SettingsAccountData, updatedAt = Date.now()) {
  cache.set(ACCOUNT_DATA_KEY, { value, updatedAt });
  writePersistedAccountData(value, updatedAt);
}

function seedBootstrapCaches(value: SettingsBootstrapData) {
  setCacheValue(BOOTSTRAP_KEY, value);
  setAccountDataCache({
    baseCurrency: value.baseCurrency,
    accounts: value.accounts,
    groups: value.groups,
    institutions: value.institutions,
    counterparties: value.counterparties,
    users: value.users,
  });
  setCacheValue(CATEGORIES_KEY, value.categories);
  setCacheValue(TAGS_KEY, value.tags);
}

function getSharedSettingsBootstrap(options?: { force?: boolean }) {
  if (options?.force) return null;
  const entry = cache.get(BOOTSTRAP_KEY) as CacheEntry<SettingsBootstrapData> | undefined;
  // Page-specific settings fetches must not wait for the broader bootstrap request.
  if (entry?.value) return entry.value;
  return null;
}

export async function fetchSettingsBootstrap(options?: { force?: boolean }) {
  const entry = cache.get(BOOTSTRAP_KEY) as CacheEntry<SettingsBootstrapData> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetch("/api/v1/settings/bootstrap", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取设置基础资料失败");
      const value: SettingsBootstrapData = {
        baseCurrency: data.baseCurrency || "CNY",
        accounts: data.accounts || [],
        groups: data.groups || [],
        institutions: data.institutions || [],
        counterparties: data.counterparties || [],
        users: data.users || [],
        categories: data.categories || [],
        tags: data.tags || [],
      };
      seedBootstrapCaches(value);
      // Mailboxes and the mail import keyword are system settings too: warm them
      // alongside the bootstrap so the mail import dialog opens from cache.
      warmEmailSettings();
      return value;
    })
    .catch((error) => {
      const prev = cache.get(BOOTSTRAP_KEY) as CacheEntry<SettingsBootstrapData> | undefined;
      if (prev?.value) seedBootstrapCaches(prev.value);
      else cache.delete(BOOTSTRAP_KEY);
      throw error;
    });

  cache.set(BOOTSTRAP_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function warmSettingsBootstrap(options?: { force?: boolean }) {
  void fetchSettingsBootstrap(options).catch(() => null);
  warmEmailSettings();
}

function scopeTouchesAccounts(scope: SettingsDataScope) {
  return scope === "accounts" || scope === "all";
}

function scopeTouchesCategories(scope: SettingsDataScope) {
  return scope === "categories" || scope === "all";
}

function scopeTouchesTags(scope: SettingsDataScope) {
  return scope === "tags" || scope === "all";
}

export function invalidateSettingsData(scope: SettingsDataScope = "all") {
  if (scopeTouchesAccounts(scope)) {
    cache.delete(ACCOUNT_DATA_KEY);
    clearPersistedAccountData();
  }
  if (scopeTouchesCategories(scope)) cache.delete(CATEGORIES_KEY);
  if (scopeTouchesTags(scope)) cache.delete(TAGS_KEY);
  cache.delete(BOOTSTRAP_KEY);
}

async function prefetchSettingsData(scope: SettingsDataScope) {
  if (scope === "all") {
    await fetchSettingsBootstrap({ force: true });
    return;
  }
  if (scope === "accounts") await fetchSettingsAccountData({ force: true });
  if (scope === "categories") await fetchSettingsCategories({ force: true });
  if (scope === "tags") await fetchSettingsTags({ force: true });
}

export async function notifySettingsDataChanged(options?: SettingsDataChangeOptions) {
  const scope = options?.scope ?? "all";
  if (options?.invalidate !== false) invalidateSettingsData(scope);
  const detail: SettingsDataChangedDetail = { scope, reason: options?.reason };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SETTINGS_DATA_CHANGED_EVENT, { detail }));
  }
  if (options?.prefetch) await prefetchSettingsData(scope);
}

function startAccountDataFetch(entry?: CacheEntry<SettingsAccountData>) {
  const promise = fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取账户资料失败");
      const value: SettingsAccountData = {
        baseCurrency: data.baseCurrency || "CNY",
        accounts: data.accounts || [],
        groups: data.groups || [],
        institutions: data.institutions || [],
        counterparties: data.counterparties || [],
        users: data.users || [],
      };
      setAccountDataCache(value);
      return value;
    })
    .catch((error) => {
      const prev = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
      if (prev?.value) cache.set(ACCOUNT_DATA_KEY, { value: prev.value, updatedAt: prev.updatedAt, promise: undefined });
      else cache.delete(ACCOUNT_DATA_KEY);
      throw error;
    });

  cache.set(ACCOUNT_DATA_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export async function fetchSettingsAccountData(options?: { force?: boolean }) {
  hydrateAccountCacheFromPersist();
  const bootstrap = await getSharedSettingsBootstrap(options);
  if (bootstrap) {
    return {
      accounts: bootstrap.accounts,
      baseCurrency: bootstrap.baseCurrency,
      groups: bootstrap.groups,
      institutions: bootstrap.institutions,
      counterparties: bootstrap.counterparties,
      users: bootstrap.users,
    };
  }
  const entry = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  if (!options?.force) {
    if (isFresh(entry) && entry?.value) return entry.value;
    if (entry?.promise) return entry.value ?? entry.promise;
    if (entry?.value) {
      void startAccountDataFetch(entry).catch(() => null);
      return entry.value;
    }
  }

  return startAccountDataFetch(entry);
}

export function getCachedSettingsCategories() {
  const entry = cache.get(CATEGORIES_KEY) as CacheEntry<SettingsCategory[]> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

export async function fetchSettingsCategories(options?: { force?: boolean }) {
  const bootstrap = await getSharedSettingsBootstrap(options);
  if (bootstrap) return bootstrap.categories;
  const entry = cache.get(CATEGORIES_KEY) as CacheEntry<SettingsCategory[]> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetchSettingsBootstrap(options)
    .then((data) => {
      const value = data.categories || [];
      setCacheValue(CATEGORIES_KEY, value);
      return value as SettingsCategory[];
    })
    .catch((error) => {
      const prev = cache.get(CATEGORIES_KEY) as CacheEntry<SettingsCategory[]> | undefined;
      if (prev?.value) setCacheValue(CATEGORIES_KEY, prev.value);
      else cache.delete(CATEGORIES_KEY);
      throw error;
    });

  cache.set(CATEGORIES_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function setSettingsCategories(next: SettingsCategory[]) {
  setCacheValue(CATEGORIES_KEY, next);
  cache.delete(BOOTSTRAP_KEY);
}

export function getCachedSettingsTags() {
  const entry = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

export async function fetchSettingsTags(options?: { force?: boolean }) {
  const bootstrap = await getSharedSettingsBootstrap(options);
  if (bootstrap) return bootstrap.tags;
  const entry = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetchSettingsBootstrap(options)
    .then((data) => {
      const value = data.tags || [];
      cache.set(TAGS_KEY, { value, updatedAt: Date.now() });
      return value as SettingsTag[];
    })
    .catch((error) => {
      const prev = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
      if (prev?.value) cache.set(TAGS_KEY, { value: prev.value, updatedAt: prev.updatedAt });
      else cache.delete(TAGS_KEY);
      throw error;
    });

  cache.set(TAGS_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function setSettingsTags(next: SettingsTag[]) {
  cache.set(TAGS_KEY, { value: next, updatedAt: Date.now() });
  cache.delete(BOOTSTRAP_KEY);
}

export type EmailAccountRow = Record<string, unknown>;

export function getCachedEmailAccounts<T = EmailAccountRow>() {
  const entry = cache.get(EMAIL_ACCOUNTS_KEY) as CacheEntry<unknown[]> | undefined;
  return (entry?.value as T[] | undefined) ?? null;
}

function startEmailAccountsFetch(entry?: CacheEntry<unknown[]>) {
  const promise = fetch("/api/v1/settings/email-accounts", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取邮箱账户失败");
      const value: unknown[] = Array.isArray(data.accounts) ? data.accounts : [];
      setCacheValue(EMAIL_ACCOUNTS_KEY, value);
      return value;
    })
    .catch((error) => {
      const prev = cache.get(EMAIL_ACCOUNTS_KEY) as CacheEntry<unknown[]> | undefined;
      if (prev?.value) cache.set(EMAIL_ACCOUNTS_KEY, { value: prev.value, updatedAt: prev.updatedAt });
      else cache.delete(EMAIL_ACCOUNTS_KEY);
      throw error;
    });

  cache.set(EMAIL_ACCOUNTS_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

/**
 * Email accounts are reused across repeated opens of the mail import dialog.
 * The list is tiny and only changes through explicit writes, so the entry is
 * never dropped on a timer: it lives until a write invalidates it or the
 * household switches.
 */
export async function fetchEmailAccounts<T = EmailAccountRow>(options?: { force?: boolean }): Promise<T[]> {
  const entry = cache.get(EMAIL_ACCOUNTS_KEY) as CacheEntry<unknown[]> | undefined;
  if (!options?.force) {
    if (entry?.value) return entry.value as T[];
    if (entry?.promise) return entry.promise as unknown as Promise<T[]>;
  }
  return startEmailAccountsFetch(entry) as Promise<T[]>;
}

export function invalidateEmailAccounts() {
  cache.delete(EMAIL_ACCOUNTS_KEY);
}

export function getCachedEmailImportKeyword() {
  const entry = cache.get(EMAIL_IMPORT_KEYWORD_KEY) as CacheEntry<string> | undefined;
  return entry?.value ?? null;
}

function startEmailImportKeywordFetch(entry?: CacheEntry<string>) {
  const promise = fetch("/api/v1/settings/email-import", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取邮件导入关键词失败");
      const value = normalizeEmailImportKeyword(data?.data?.keyword, { fallbackToDefault: true });
      setCacheValue(EMAIL_IMPORT_KEYWORD_KEY, value);
      return value;
    })
    .catch((error) => {
      const prev = cache.get(EMAIL_IMPORT_KEYWORD_KEY) as CacheEntry<string> | undefined;
      if (prev?.value) cache.set(EMAIL_IMPORT_KEYWORD_KEY, { value: prev.value, updatedAt: prev.updatedAt });
      else cache.delete(EMAIL_IMPORT_KEYWORD_KEY);
      throw error;
    });

  cache.set(EMAIL_IMPORT_KEYWORD_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export async function fetchEmailImportKeyword(options?: { force?: boolean }): Promise<string> {
  const entry = cache.get(EMAIL_IMPORT_KEYWORD_KEY) as CacheEntry<string> | undefined;
  if (!options?.force) {
    if (entry?.value) return entry.value;
    if (entry?.promise) return entry.promise;
  }
  return startEmailImportKeywordFetch(entry);
}

/**
 * Preloads the mail settings together with the other system settings so the
 * mail import dialog usually opens without any request of its own.
 */
export function warmEmailSettings() {
  if (typeof window === "undefined") return;
  if (!cache.get(EMAIL_ACCOUNTS_KEY)?.value) void fetchEmailAccounts().catch(() => null);
  if (!cache.get(EMAIL_IMPORT_KEYWORD_KEY)?.value) void fetchEmailImportKeyword().catch(() => null);
}

export function setEmailImportKeyword(next: string) {
  setCacheValue(EMAIL_IMPORT_KEYWORD_KEY, next);
}

export function invalidateEmailImportKeyword() {
  cache.delete(EMAIL_IMPORT_KEYWORD_KEY);
}
