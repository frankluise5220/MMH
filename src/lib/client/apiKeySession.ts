export type ApiKeySession = {
  key: string;
  savedAt: number;
  ttlDays: number;
};

const SESSION_STORAGE_KEY = "mmh_api_session_v1";
const TTL_STORAGE_KEY = "mmh_api_ttl_days_v1";
const LEGACY_KEY = "mmh_api_key";

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function getApiKeyTtlDaysSetting(): number {
  try {
    const raw = localStorage.getItem(TTL_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
  } catch {
    return 0;
  }
}

export function setApiKeyTtlDaysSetting(days: number) {
  try {
    const n = Number.isFinite(days) && days >= 0 ? Math.floor(days) : 0;
    localStorage.setItem(TTL_STORAGE_KEY, String(n));
  } catch {
    return;
  }
}

export function clearStoredApiKeySession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    return;
  }
}

export function saveApiKeySession(key: string, ttlDays: number) {
  const trimmed = (key ?? "").trim();
  if (!trimmed) return;
  const session: ApiKeySession = {
    key: trimmed,
    savedAt: Date.now(),
    ttlDays: Number.isFinite(ttlDays) && ttlDays >= 0 ? Math.floor(ttlDays) : 0,
  };
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    return;
  }
}

export function getStoredApiKey(): string | null {
  try {
    const existing = safeJsonParse<ApiKeySession>(localStorage.getItem(SESSION_STORAGE_KEY));
    if (existing?.key) {
      const ttl = Number.isFinite(existing.ttlDays) && existing.ttlDays >= 0 ? existing.ttlDays : 0;
      if (ttl === 0) return existing.key;
      const expiresAt = existing.savedAt + ttl * 24 * 60 * 60 * 1000;
      if (Date.now() <= expiresAt) return existing.key;
      clearStoredApiKeySession();
      return null;
    }

    const legacy = (localStorage.getItem(LEGACY_KEY) ?? "").trim();
    if (legacy) {
      const ttlDays = getApiKeyTtlDaysSetting();
      saveApiKeySession(legacy, ttlDays);
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }

    return null;
  } catch {
    return null;
  }
}

