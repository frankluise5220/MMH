import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { decrypt, encrypt, getOrCreateMasterKey } from "@/lib/auth/encrypt";

/**
 * Storage formats for AccessKey.key, oldest first:
 * 1. Plain text (legacy, migrated away on first successful verification).
 * 2. "bcrypt-sha256-v1:<preview>:<hash>" (legacy hash, still verified but cannot
 *    be revealed, so those keys show no copy button).
 * 3. "enc-aes-gcm-v1:<iv>.<ciphertext>.<tag>" (reversible AES-256-GCM; chosen over
 *    hashing because users must be able to copy an existing key again on the MCP
 *    settings page. The master key lives in SystemSetting, see encrypt.ts).
 */
const ACCESS_KEY_ENC_PREFIX = "enc-aes-gcm-v1:";
const ACCESS_KEY_HASH_PREFIX = "bcrypt-sha256-v1:";

type AccessKeyRow = {
  id: string;
  name: string;
  key: string;
  scope: string;
};

type AccessKeyAuthResult = {
  id: string;
  name: string;
  /** "read" keys may query; only "write" keys may create or delete records. */
  scope: "read" | "write";
};

function plainTextEquals(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function accessKeyPreview(plain: string) {
  const normalized = plain.trim();
  if (!normalized) return "****";
  const suffix = normalized.slice(-4);
  return `${"*".repeat(Math.max(8, Math.min(normalized.length, 12)))}${suffix}`;
}

type ParsedStoredAccessKey =
  | { kind: "encrypted"; cipher: string }
  | { kind: "hashed"; preview: string; hash: string }
  | { kind: "plain"; plain: string };

function parseStoredAccessKey(stored: string): ParsedStoredAccessKey {
  if (stored.startsWith(ACCESS_KEY_ENC_PREFIX)) {
    return { kind: "encrypted", cipher: stored.slice(ACCESS_KEY_ENC_PREFIX.length) };
  }
  if (stored.startsWith(ACCESS_KEY_HASH_PREFIX)) {
    const rest = stored.slice(ACCESS_KEY_HASH_PREFIX.length);
    const separator = rest.indexOf(":");
    if (separator <= 0) {
      return { kind: "hashed", preview: "****", hash: rest };
    }
    return {
      kind: "hashed",
      preview: rest.slice(0, separator),
      hash: rest.slice(separator + 1),
    };
  }
  return { kind: "plain", plain: stored };
}

/** New keys are stored reversibly so the settings page can copy them again later. */
export async function storeAccessKey(plain: string) {
  const normalized = plain.trim();
  if (!normalized) {
    throw new Error("Access key is required.");
  }
  const masterKey = await getOrCreateMasterKey();
  return `${ACCESS_KEY_ENC_PREFIX}${encrypt(normalized, masterKey)}`;
}

export async function storedAccessKeyPreview(stored: string) {
  const parsed = parseStoredAccessKey(stored);
  try {
    if (parsed.kind === "encrypted") {
      return accessKeyPreview(await decrypt(parsed.cipher, await getOrCreateMasterKey()));
    }
  } catch {
    return "****";
  }
  if (parsed.kind === "hashed") return parsed.preview;
  return accessKeyPreview(parsed.plain);
}

/** Full plain key when the storage format allows it, null for legacy hashed keys. */
export async function revealStoredAccessKey(stored: string): Promise<string | null> {
  const parsed = parseStoredAccessKey(stored);
  if (parsed.kind !== "encrypted") return null;
  try {
    return await decrypt(parsed.cipher, await getOrCreateMasterKey());
  } catch {
    return null;
  }
}

async function verifyStoredAccessKey(provided: string, row: AccessKeyRow) {
  const stored = parseStoredAccessKey(row.key);
  if (stored.kind === "encrypted") {
    let plain: string | null = null;
    try {
      plain = await decrypt(stored.cipher, await getOrCreateMasterKey());
    } catch {
      return false;
    }
    return plainTextEquals(provided, plain);
  }
  if (stored.kind === "hashed") {
    if (!stored.hash) return false;
    return verifyPassword(provided, stored.hash).catch(() => false);
  }
  if (!plainTextEquals(provided, stored.plain)) return false;
  // Legacy plain-text keys migrate to the reversible-encrypted format.
  const nextStored = await storeAccessKey(provided);
  await prisma.accessKey.update({
    where: { id: row.id },
    data: { key: nextStored },
  }).catch(() => null);
  return true;
}

/**
 * Record "this key was accepted", at most once a minute per key.
 *
 * A single MCP `tools/call` runs the key through verification 2-3 times (proxy, the
 * MCP route, then the inner handler it dispatches to), so an unconditional UPDATE
 * would turn every read request into a write. Fire-and-forget: a failed touch must
 * never fail authentication.
 */
const lastUsedTouchedAt = new Map<string, number>();
const LAST_USED_TOUCH_INTERVAL_MS = 60_000;

function touchAccessKey(id: string) {
  const now = Date.now();
  if (now - (lastUsedTouchedAt.get(id) ?? 0) < LAST_USED_TOUCH_INTERVAL_MS) return;
  lastUsedTouchedAt.set(id, now);
  void prisma.accessKey
    .update({ where: { id }, data: { lastUsedAt: new Date(now) } })
    .catch((error) => {
      // A failed touch must not block authentication, but it must not be silent
      // either: a stale Prisma client (schema changed, process not restarted) or a
      // database that has not run the migration both land here and would otherwise
      // look like "the column just never fills in".
      console.warn("[access-key] lastUsedAt update failed:", error instanceof Error ? error.message : error);
    });
}

export async function verifyAccessKey(providedKey: string | null | undefined): Promise<AccessKeyAuthResult | null> {
  const key = providedKey?.trim();
  if (!key || key.length < 4) return null;

  const rows = await prisma.accessKey.findMany({
    select: { id: true, name: true, key: true, scope: true },
    orderBy: { createdAt: "desc" },
  });

  for (const row of rows) {
    if (await verifyStoredAccessKey(key, row)) {
      touchAccessKey(row.id);
      // Anything other than an explicit "read" keeps full access, so keys
      // created before the column existed keep behaving as they always did.
      return { id: row.id, name: row.name, scope: row.scope === "read" ? "read" : "write" };
    }
  }

  return null;
}
