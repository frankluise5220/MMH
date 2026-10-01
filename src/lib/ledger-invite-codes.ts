export type LedgerInviteCodeRecord = {
  code: string;
  createdAt?: string;
  issuerHouseholdId?: string;
  signature?: string;
  /** Issuer-managed metadata. Not covered by the HMAC signature: only a ledger
   * administrator can write this setting, and these fields carry no cross-system
   * authority (the code itself remains the secret and stays signed).
   * `null` means "explicitly cleared"; `undefined`/empty means "keep previous". */
  note?: string | null;
  expiresAt?: string | null;
  createdByUserId?: string;
  createdByName?: string;
  usedAt?: string;
  usedHouseholdId?: string;
  usedHouseholdName?: string;
  usedUserId?: string;
  usedUserName?: string;
};

export const INVITE_CODE_NOTE_MAX_LENGTH = 200;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Merges a text field while honouring an explicit clear.
 * `null` clears the field; a non-empty value replaces it; empty/undefined keeps
 * whatever was stored before.
 */
function mergeText(next: unknown, previous?: string | null): string | undefined {
  if (next === null) return undefined;
  const text = cleanText(next);
  if (text) return text;
  return previous ?? undefined;
}

function normalizeInviteRecords(records: LedgerInviteCodeRecord[]) {
  const byCode = new Map<string, LedgerInviteCodeRecord>();
  for (const record of records) {
    const code = cleanText(record.code);
    if (!code) continue;
    const existing = byCode.get(code);
    byCode.set(code, {
      code,
      createdAt: mergeText(record.createdAt, existing?.createdAt),
      issuerHouseholdId: mergeText(record.issuerHouseholdId, existing?.issuerHouseholdId),
      signature: mergeText(record.signature, existing?.signature),
      note: mergeText(record.note, existing?.note),
      expiresAt: mergeText(record.expiresAt, existing?.expiresAt),
      createdByUserId: mergeText(record.createdByUserId, existing?.createdByUserId),
      createdByName: mergeText(record.createdByName, existing?.createdByName),
      usedAt: mergeText(record.usedAt, existing?.usedAt),
      usedHouseholdId: mergeText(record.usedHouseholdId, existing?.usedHouseholdId),
      usedHouseholdName: mergeText(record.usedHouseholdName, existing?.usedHouseholdName),
      usedUserId: mergeText(record.usedUserId, existing?.usedUserId),
      usedUserName: mergeText(record.usedUserName, existing?.usedUserName),
    });
  }
  return Array.from(byCode.values());
}

export function parseLedgerInviteCodeRecords(value: string | null | undefined): LedgerInviteCodeRecord[] {
  const text = cleanText(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return normalizeInviteRecords(parsed.map((item) => {
        if (typeof item === "string") return { code: item };
        if (item && typeof item === "object") {
          const source = item as Record<string, unknown>;
          return {
            code: cleanText(source.code),
            createdAt: cleanText(source.createdAt) || undefined,
            issuerHouseholdId: cleanText(source.issuerHouseholdId) || undefined,
            signature: cleanText(source.signature) || undefined,
            note: source.note === null ? null : cleanText(source.note) || undefined,
            expiresAt: source.expiresAt === null ? null : cleanText(source.expiresAt) || undefined,
            createdByUserId: cleanText(source.createdByUserId) || undefined,
            createdByName: cleanText(source.createdByName) || undefined,
            usedAt: cleanText(source.usedAt) || undefined,
            usedHouseholdId: cleanText(source.usedHouseholdId) || undefined,
            usedHouseholdName: cleanText(source.usedHouseholdName) || undefined,
            usedUserId: cleanText(source.usedUserId) || undefined,
            usedUserName: cleanText(source.usedUserName) || undefined,
          };
        }
        return { code: "" };
      }));
    }
    if (typeof parsed === "string" && parsed.trim()) return [{ code: parsed.trim() }];
  } catch {}
  return [{ code: text }];
}

export function serializeLedgerInviteCodeRecords(records: LedgerInviteCodeRecord[]) {
  const normalized = normalizeInviteRecords(records);
  return normalized.length > 0 ? JSON.stringify(normalized) : "";
}

export function createLedgerInviteCodeRecord(code: string, createdAt = new Date().toISOString()): LedgerInviteCodeRecord {
  return { code: cleanText(code), createdAt };
}

/** A code with an unparseable `expiresAt` is treated as having no expiry. */
export function isLedgerInviteCodeExpired(record: LedgerInviteCodeRecord, now: Date = new Date()) {
  const raw = cleanText(record.expiresAt);
  if (!raw) return false;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return false;
  return time <= now.getTime();
}

export function isLedgerInviteCodeRedeemable(record: LedgerInviteCodeRecord, now: Date = new Date()) {
  return !record.usedAt && !isLedgerInviteCodeExpired(record, now);
}

/** Codes a user could still redeem right now (unused and not expired). */
export function activeLedgerInviteCodes(records: LedgerInviteCodeRecord[], now: Date = new Date()) {
  return records.filter((record) => isLedgerInviteCodeRedeemable(record, now)).map((record) => record.code);
}

export function findLedgerInviteCodeRecord(records: LedgerInviteCodeRecord[], code: string) {
  const target = cleanText(code);
  return records.find((record) => record.code === target) ?? null;
}

/**
 * Validates and normalises issuer-managed metadata before signing.
 *
 * `expiresAt` is canonicalised to an ISO string so the stored value never
 * depends on the server's timezone — the browser already converted the user's
 * `datetime-local` pick into an absolute instant.
 */
export type LedgerInviteCodeMetadataIssue =
  | { kind: "note-too-long"; code: string; length: number; max: number }
  | { kind: "expiry-invalid"; code: string; value: string };

export function normalizeLedgerInviteCodeMetadata(
  records: LedgerInviteCodeRecord[],
): { ok: true; records: LedgerInviteCodeRecord[] } | { ok: false; issue: LedgerInviteCodeMetadataIssue } {
  const normalized: LedgerInviteCodeRecord[] = [];
  for (const record of records) {
    const note = record.note ?? null;
    if (typeof note === "string" && note.length > INVITE_CODE_NOTE_MAX_LENGTH) {
      return {
        ok: false,
        issue: { kind: "note-too-long", code: record.code, length: note.length, max: INVITE_CODE_NOTE_MAX_LENGTH },
      };
    }
    let expiresAt = record.expiresAt ?? null;
    if (expiresAt) {
      const parsed = Date.parse(expiresAt);
      if (!Number.isFinite(parsed)) {
        return { ok: false, issue: { kind: "expiry-invalid", code: record.code, value: expiresAt } };
      }
      expiresAt = new Date(parsed).toISOString();
    }
    normalized.push({ ...record, note, expiresAt });
  }
  return { ok: true, records: normalized };
}

/** Applies an issuer edit (note / expiry) to one record. Pass `null` to clear. */
export function updateLedgerInviteCodeRecord(
  records: LedgerInviteCodeRecord[],
  code: string,
  patch: { note?: string | null; expiresAt?: string | null },
) {
  const target = cleanText(code);
  return normalizeInviteRecords(records.map((record) => (
    record.code === target
      ? { ...record, note: patch.note, expiresAt: patch.expiresAt }
      : record
  )));
}

/**
 * Attributes an admin to the records that are genuinely new in this save.
 *
 * "New" is decided by diffing against the codes that were already stored before
 * the save — a record that already existed was issued earlier, so stamping it
 * with whoever happens to be saving now would be a lie. Legacy records (bare
 * strings, or codes issued before this field existed) therefore stay blank
 * rather than being mis-attributed. Already-set creators are always preserved.
 */
export function stampLedgerInviteCodeCreators(
  records: LedgerInviteCodeRecord[],
  creator: { id: string; name: string },
  knownCodes: Iterable<string>,
) {
  const known = new Set(Array.from(knownCodes, (code) => cleanText(code)));
  return records.map((record) => {
    if (record.createdByUserId || record.createdByName) return record;
    if (known.has(record.code)) return record;
    return { ...record, createdByUserId: cleanText(creator.id), createdByName: cleanText(creator.name) };
  });
}

export function markLedgerInviteCodeUsed(
  records: LedgerInviteCodeRecord[],
  code: string,
  used: { householdId: string; householdName: string; usedAt?: string; usedUserId?: string; usedUserName?: string },
) {
  const target = cleanText(code);
  const usedAt = used.usedAt ?? new Date().toISOString();
  return normalizeInviteRecords(records.map((record) => (
    record.code === target
      ? {
          ...record,
          usedAt,
          usedHouseholdId: used.householdId,
          usedHouseholdName: used.householdName,
          usedUserId: cleanText(used.usedUserId) || record.usedUserId,
          usedUserName: cleanText(used.usedUserName) || record.usedUserName,
        }
      : record
  )));
}
