import {
  findLedgerInviteCodeRecord,
  isLedgerInviteCodeExpired,
  type LedgerInviteCodeRecord,
} from "@/lib/ledger-invite-codes";
import { ledgerInviteCodeSignatureState } from "@/lib/server/ledger-invite-code-signing";

/**
 * Why a submitted invite code cannot be redeemed.
 *
 * These used to collapse into one message ("The invite code is invalid, belongs
 * to another system, or has already been used."), which made a failed signup
 * impossible to diagnose: the administrator sees the code listed as available
 * in settings while the redeemer is told it may already be used. Each cause now
 * carries its own code + message, and the settings page shows the same verdict.
 */
export type LedgerInviteCodeRejectionCode =
  | "INVITE_CODE_NOT_FOUND"
  | "INVITE_CODE_USED"
  | "INVITE_CODE_FOREIGN"
  | "INVITE_CODE_EXPIRED"
  | "INVITE_CODE_ISSUER_MISSING"
  | "INVITE_CODE_SIGNING_UNAVAILABLE";

export type LedgerInviteCodeRejection = {
  code: LedgerInviteCodeRejectionCode;
  message: string;
  status: number;
};

export type LedgerInviteCodeInspection =
  | { ok: true; record: LedgerInviteCodeRecord }
  | { ok: false; rejection: LedgerInviteCodeRejection };

/**
 * Checks everything that can be decided without touching the database.
 *
 * The caller still has to verify that the issuing household exists, because
 * that lookup differs per route (transaction vs. plain client).
 */
export function inspectLedgerInviteCode(
  records: LedgerInviteCodeRecord[],
  submittedCode: string,
): LedgerInviteCodeInspection {
  const code = submittedCode.trim();
  const record = findLedgerInviteCodeRecord(records, code);
  if (!record) {
    return {
      ok: false,
      rejection: {
        code: "INVITE_CODE_NOT_FOUND",
        message: "This invite code does not exist. Check that it was copied completely and that upper/lower case matches.",
        status: 403,
      },
    };
  }
  if (record.usedAt) {
    return {
      ok: false,
      rejection: {
        code: "INVITE_CODE_USED",
        message: "This invite code has already been used.",
        status: 403,
      },
    };
  }
  const signatureState = ledgerInviteCodeSignatureState(record);
  if (signatureState === "unavailable") {
    return {
      ok: false,
      rejection: {
        code: "INVITE_CODE_SIGNING_UNAVAILABLE",
        message: "This server cannot verify invite codes: MMH_SESSION_SECRET is not configured. Ask the administrator to set it.",
        status: 503,
      },
    };
  }
  if (signatureState === "invalid") {
    return {
      ok: false,
      rejection: {
        code: "INVITE_CODE_FOREIGN",
        message: "This invite code was issued by a different system or by an instance using another MMH_SESSION_SECRET, so it cannot be verified here.",
        status: 403,
      },
    };
  }
  if (isLedgerInviteCodeExpired(record)) {
    return {
      ok: false,
      rejection: {
        code: "INVITE_CODE_EXPIRED",
        message: "This invite code has expired.",
        status: 403,
      },
    };
  }
  return { ok: true, record };
}

export function missingIssuerRejection(): LedgerInviteCodeRejection {
  return {
    code: "INVITE_CODE_ISSUER_MISSING",
    message: "The ledger that issued this invite code no longer exists.",
    status: 403,
  };
}
