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

function signatureInput(record: Pick<LedgerInviteCodeRecord, "code" | "createdAt" | "issuerHouseholdId">) {
  return [
    SIGNATURE_VERSION,
    record.code.trim(),
    record.issuerHouseholdId?.trim() ?? "",
    record.createdAt?.trim() ?? "",
  ].join("|");
}

function createSignature(record: Pick<LedgerInviteCodeRecord, "code" | "createdAt" | "issuerHouseholdId">) {
  return createHmac("sha256", signingSecret())
    .update(signatureInput(record), "utf8")
    .digest("base64url");
}

function timingSafeEqualText(left: string, right: string) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signLedgerInviteCodeRecord(
  record: LedgerInviteCodeRecord,
  issuerHouseholdId: string,
): LedgerInviteCodeRecord {
  const issuer = issuerHouseholdId.trim();
  if (!issuer) throw new Error("A household is required to sign a ledger invite code.");
  const signed = {
    ...record,
    issuerHouseholdId: issuer,
  };
  return {
    ...signed,
    signature: `${SIGNATURE_VERSION}.${createSignature(signed)}`,
  };
}

export function isLedgerInviteCodeRecordAuthentic(record: LedgerInviteCodeRecord) {
  const issuer = record.issuerHouseholdId?.trim() ?? "";
  const signature = record.signature?.trim() ?? "";
  if (!record.code.trim() || !record.createdAt?.trim() || !issuer || !signature) return false;
  const [version, digest, ...extra] = signature.split(".");
  if (version !== SIGNATURE_VERSION || !digest || extra.length > 0) return false;
  return timingSafeEqualText(digest, createSignature({
    code: record.code,
    createdAt: record.createdAt,
    issuerHouseholdId: issuer,
  }));
}

/**
 * Signs new/legacy records on an admin save and rejects any existing signed
 * record whose code, issuer, timestamp, or signature was altered by the client.
 */
export function signLedgerInviteCodeRecords(
  records: LedgerInviteCodeRecord[],
  issuerHouseholdId: string,
) {
  const issuer = issuerHouseholdId.trim();
  if (!issuer) throw new Error("Only a household administrator can issue invite codes.");
  return records.map((record) => {
    if (record.signature?.trim()) {
      if (!isLedgerInviteCodeRecordAuthentic(record)) {
        throw new Error("One or more invite codes have an invalid signature.");
      }
      return record;
    }
    return signLedgerInviteCodeRecord(record, issuer);
  });
}
