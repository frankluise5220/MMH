import { createHmac, timingSafeEqual } from "node:crypto";
import type { LedgerInviteCodeRecord } from "@/lib/ledger-invite-codes";

const SIGNATURE_VERSION = "v1";
const MIN_SECRET_LENGTH = 32;

function signingSecret() {
  const explicit = process.env.MMH_SESSION_SECRET?.trim() ?? "";
  if (process.env.NODE_ENV === "production") {
    if (!explicit || explicit.length < MIN_SECRET_LENGTH || /^CHANGE_ME/i.test(explicit)) {
      throw new Error("MMH_SESSION_SECRET must be set to sign ledger invite codes in production.");
    }
    return explicit;
  }
  return explicit || "mmh-development-session-secret";
}

type SignedFields = Pick<LedgerInviteCodeRecord, "code" | "createdAt" | "issuerHouseholdId">;

function signatureInput(record: SignedFields) {
  return [
    SIGNATURE_VERSION,
    record.code.trim(),
    record.issuerHouseholdId?.trim() ?? "",
    record.createdAt?.trim() ?? "",
  ].join("|");
}

function createSignature(record: SignedFields) {
  return createHmac("sha256", signingSecret())
    .update(signatureInput(record), "utf8")
    .digest("base64url");
}

function timingSafeEqualText(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Records written before the signing feature existed may carry no `createdAt`
 * (the legacy shape was just `{ code }` or a bare string). Signing them with an
 * empty timestamp produces a signature that a stricter validator would reject
 * forever, so always persist a timestamp as part of the signed payload.
 */
function withCreatedAt(record: LedgerInviteCodeRecord): LedgerInviteCodeRecord {
  const createdAt = record.createdAt?.trim();
  return createdAt ? { ...record, createdAt } : { ...record, createdAt: new Date().toISOString() };
}

export function signLedgerInviteCodeRecord(
  record: LedgerInviteCodeRecord,
  issuerHouseholdId: string,
): LedgerInviteCodeRecord {
  const issuer = issuerHouseholdId.trim();
  if (!issuer) throw new Error("A household is required to sign a ledger invite code.");
  const signed = withCreatedAt({ ...record, issuerHouseholdId: issuer });
  return {
    ...signed,
    signature: `${SIGNATURE_VERSION}.${createSignature(signed)}`,
  };
}

/**
 * Verifies the HMAC over the identity fields exactly as stored.
 *
 * `createdAt` is optional on purpose: records signed before it was always
 * persisted are still ours, and the timestamp slot is signed either way, so an
 * empty value cannot be used to forge or replay a code. Callers that want a
 * complete record should use `signLedgerInviteCodeRecord`, which backfills it.
 */
export function isLedgerInviteCodeRecordAuthentic(record: LedgerInviteCodeRecord) {
  const issuer = record.issuerHouseholdId?.trim() ?? "";
  const signature = record.signature?.trim() ?? "";
  if (!record.code.trim() || !issuer || !signature) return false;
  const [version, digest, ...extra] = signature.split(".");
  if (version !== SIGNATURE_VERSION || !digest || extra.length > 0) return false;
  return timingSafeEqualText(digest, createSignature({
    code: record.code,
    createdAt: record.createdAt,
    issuerHouseholdId: issuer,
  }));
}

/**
 * Whether this deployment can sign/verify at all.
 *
 * In production a missing/weak `MMH_SESSION_SECRET` makes `signingSecret()`
 * throw. Callers must be able to tell that apart from "this code is foreign":
 * otherwise a misconfigured server reports every invite code as invalid, which
 * is indistinguishable from a real signature failure.
 */
export function isLedgerInviteCodeSigningAvailable() {
  try {
    signingSecret();
    return true;
  } catch {
    return false;
  }
}

/** Tri-state signature verdict used by the admin UI and the redemption guards. */
export type LedgerInviteCodeSignatureState = "valid" | "invalid" | "unavailable";

export function ledgerInviteCodeSignatureState(record: LedgerInviteCodeRecord): LedgerInviteCodeSignatureState {
  if (!isLedgerInviteCodeSigningAvailable()) return "unavailable";
  return isLedgerInviteCodeRecordAuthentic(record) ? "valid" : "invalid";
}

/**
 * Signs new/legacy records on an admin save and rejects any existing signed
 * record whose code, issuer, timestamp, or signature was altered by the client.
 *
 * An authentic record that is missing `createdAt` (signed by an older build) is
 * re-signed with a backfilled timestamp, so the setting heals itself the next
 * time an administrator saves it.
 */
export function signLedgerInviteCodeRecords(
  records: LedgerInviteCodeRecord[],
  issuerHouseholdId: string,
) {
  const issuer = issuerHouseholdId.trim();
  if (!issuer) throw new Error("Only a household administrator can issue invite codes.");
  // Name the offending codes: "one or more" leaves an administrator unable to
  // tell which row is the problem (and therefore unable to remove it).
  const invalidCodes = records
    .filter((record) => record.signature?.trim() && !isLedgerInviteCodeRecordAuthentic(record))
    .map((record) => record.code);
  if (invalidCodes.length > 0) {
    throw new Error(`One or more invite codes have an invalid signature: ${invalidCodes.join(", ")}`);
  }
  return records.map((record) => (
    record.signature?.trim() && record.createdAt?.trim()
      ? record
      : signLedgerInviteCodeRecord(record, issuer)
  ));
}
