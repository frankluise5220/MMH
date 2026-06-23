"use client";

export type SettingsAccountGroup = { id: string; name: string; sortOrder?: number };
export type SettingsInstitution = { id: string; name: string; type?: string | null };
export type SettingsAccountData = {
  accounts: unknown[];
  groups: SettingsAccountGroup[];
  institutions: SettingsInstitution[];
};
export type SettingsTag = { id: string; name: string; color: string | null };

const ACCOUNT_DATA_KEY = "accounts-basic";
const TAGS_KEY = "tags";
const TTL_MS = 60_000;

type CacheEntry<T> = {
  value?: T;
  promise?: Promise<T>;
  updatedAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

function isFresh(entry: CacheEntry<unknown> | undefined) {
  return Boolean(entry?.value) && Date.now() - entry!.updatedAt < TTL_MS;
}

export function getCachedSettingsAccountData() {
  const entry = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

export async function fetchSettingsAccountData(options?: { force?: boolean }) {
  const entry = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetch("/api/v1/accounts/internal?balances=false")
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取账户资料失败");
      const value: SettingsAccountData = {
        accounts: data.accounts || [],
        groups: data.groups || [],
        institutions: data.institutions || [],
      };
      cache.set(ACCOUNT_DATA_KEY, { value, updatedAt: Date.now() });
      return value;
    })
    .catch((error) => {
      const prev = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
      if (prev?.value) cache.set(ACCOUNT_DATA_KEY, { value: prev.value, updatedAt: prev.updatedAt });
      else cache.delete(ACCOUNT_DATA_KEY);
      throw error;
    });

  cache.set(ACCOUNT_DATA_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function setSettingsAccountData(next: SettingsAccountData) {
  cache.set(ACCOUNT_DATA_KEY, { value: next, updatedAt: Date.now() });
}

export function invalidateSettingsAccountData() {
  cache.delete(ACCOUNT_DATA_KEY);
}

export function getCachedSettingsTags() {
  const entry = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

export async function fetchSettingsTags(options?: { force?: boolean }) {
  const entry = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetch("/api/v1/tags")
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取标签失败");
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
}

export function invalidateSettingsTags() {
  cache.delete(TAGS_KEY);
}
