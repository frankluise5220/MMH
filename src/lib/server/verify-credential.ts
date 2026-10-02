import { verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db/prisma";
import { credentialKindOf, type CredentialKind } from "@/lib/credential-kind";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";

/**
 * The single credential-verification implementation.
 *
 * Three call sites used to carry their own copy of "which secret does this
 * account have, and in what order do we try them":
 *
 *  - `verifySensitiveOperationPassword` (sensitive-operation dialogs)
 *  - `POST /api/v1/households/switch` (the target ledger's administrator)
 *  - `POST /api/v1/auth/verify` (the login form)
 *
 * They drifted: the login copy let a fnOS account fall through to the legacy
 * deployment password, the switch copy had no legacy bridge at all, and only
 * the sensitive-operation copy blocked fnOS. Every caller now funnels through
 * `verifyUserCredential`, so the order below is the single source of truth and
 * the only thing that differs between callers is the wording they show.
 */

/**
 * The secrets an account can be verified against.
 *
 * A plain shape rather than a Prisma type on purpose: the three callers select
 * different supersets (login needs `id` / `authVersion` / `Household`, the
 * switch path needs the target admin's row, sensitive operations read the
 * current user), but all of them must be verified the same way.
 */
export type CredentialSubject = {
  passwordHash: string | null;
  fnosUid: string | null;
  registrationPrincipalId: string | null;
  email: string | null;
};

/** Exactly the columns `CredentialSubject` needs — use it as a Prisma `select`. */
export const CREDENTIAL_SUBJECT_SELECT = {
  passwordHash: true,
  fnosUid: true,
  registrationPrincipalId: true,
  email: true,
} as const;

export { credentialKindOf, type CredentialKind };

/** Deployment-wide password of installations that predate per-user hashes. */
export const LEGACY_ACCESS_PASSWORD_KEY = "access_password";

export type CredentialFailureCode = "INVALID_PASSWORD" | "LOCAL_PASSWORD_REQUIRED" | "PASSWORD_NOT_SET";

/** Which branch the verifier tried, so callers can pick context-correct wording. */
export type CredentialAttempt = "local" | "fnos" | "mmh" | "legacy" | "none";

export type CredentialVerification =
  | { ok: true; kind: "local" | "mmh" | "legacy" }
  | { ok: false; code: CredentialFailureCode; status: 400 | 401; attempted: CredentialAttempt };

/**
 * Reads the legacy deployment password. Only very old installations have one —
 * nothing in the current code writes it, so on a modern deployment this is
 * always empty and the legacy branch below is dead.
 */
export async function readLegacyAccessPassword(): Promise<string> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: LEGACY_ACCESS_PASSWORD_KEY },
    select: { value: true },
  });
  return setting?.value ?? "";
}

/**
 * Verifies `password` against `subject`. The order is fixed and MUST NOT be
 * reordered per caller:
 *
 *   1. **local** — a bcrypt `passwordHash` on the account itself.
 *   2. **fnOS** — a gateway-bound account with no local password is refused
 *      outright. The fnOS gateway exposes no password-verification API to
 *      third-party apps, so there is nothing to check; the only fix is to set a
 *      local password first. It must never fall through to MMH or to the
 *      deployment-wide legacy password.
 *   3. **MMH** — an MMH-only account is verified against the central
 *      registration service with its membership password.
 *   4. **legacy** — the deployment-wide `access_password` of pre-per-user-hash
 *      installations. Deliberately last, so an identity-aware path always wins.
 *
 * Pass `options.legacyPassword` to reuse one read across many candidates (the
 * login form verifies every same-name user before deciding whether the request
 * is ambiguous); omit it and the verifier reads it itself.
 *
 * Only machine codes are returned. Each caller owns its user-facing wording,
 * because the same code reads differently on the login page, in a
 * sensitive-operation dialog and in the ledger-switch dialog.
 */
export async function verifyUserCredential(
  subject: CredentialSubject,
  password: string,
  options: { legacyPassword?: string | null } = {},
): Promise<CredentialVerification> {
  if (subject.passwordHash) {
    const matched = await verifyPassword(password, subject.passwordHash);
    return matched
      ? { ok: true, kind: "local" }
      : { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "local" };
  }

  if (subject.fnosUid) {
    return { ok: false, code: "LOCAL_PASSWORD_REQUIRED", status: 400, attempted: "fnos" };
  }

  if (subject.registrationPrincipalId && subject.email) {
    const verification = await verifyEmailPrincipal({ email: subject.email, password });
    return verification.ok
      ? { ok: true, kind: "mmh" }
      : { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "mmh" };
  }

  const legacyPassword =
    options.legacyPassword === undefined
      ? await readLegacyAccessPassword()
      : options.legacyPassword ?? "";
  if (legacyPassword.length > 0 && password === legacyPassword) {
    return { ok: true, kind: "legacy" };
  }

  return { ok: false, code: "PASSWORD_NOT_SET", status: 400, attempted: "none" };
}
