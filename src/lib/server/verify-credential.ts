import { verifyPassword } from "@/lib/auth/password";
import { credentialKindOf, type CredentialKind } from "@/lib/credential-kind";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";
import { getSystemSetting } from "@/lib/server/system-setting";
import type { SessionAuthMethod } from "@/lib/server/session-cookies";

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
  /**
   * MMH membership address captured at binding time.
   *
   * The only address that identifies the central account. `email` below is the
   * editable local contact field — it is how the local account is looked up for
   * password recovery — so it must never stand in for this, even as a fallback:
   * a binding whose recorded address is missing is a binding that has to be
   * re-verified, not one that can be addressed by a field the user may change.
   */
  registrationEmail?: string | null;
  email: string | null;
};

/** Exactly the columns `CredentialSubject` needs — use it as a Prisma `select`. */
export const CREDENTIAL_SUBJECT_SELECT = {
  passwordHash: true,
  fnosUid: true,
  registrationPrincipalId: true,
  registrationEmail: true,
  email: true,
} as const;

export { credentialKindOf, type CredentialKind };

/** Deployment-wide password of installations that predate per-user hashes. */
export const LEGACY_ACCESS_PASSWORD_KEY = "access_password";

type CredentialFailureCode = "INVALID_PASSWORD" | "LOCAL_PASSWORD_REQUIRED" | "PASSWORD_NOT_SET" | "MMH_IDENTITY_UNRECORDED";

/** Which branch the verifier tried, so callers can pick context-correct wording. */
type CredentialAttempt = "local" | "fnos" | "mmh" | "legacy" | "none";

export type CredentialVerification =
  | { ok: true; kind: "local" | "mmh" | "legacy" }
  | { ok: false; code: CredentialFailureCode; status: 400 | 401; attempted: CredentialAttempt };

/**
 * Reads the legacy deployment password. Only very old installations have one —
 * nothing in the current code writes it, so on a modern deployment this is
 * always empty and the legacy branch below is dead.
 */
export async function readLegacyAccessPassword(): Promise<string> {
  return (await getSystemSetting(LEGACY_ACCESS_PASSWORD_KEY)) ?? "";
}

/**
 * Verifies `password` against `subject`.
 *
 * Pass `options.authMethod` when the caller knows which identity the user
 * signed in with — that is the normal case for anything after login, because
 * the session cookie carries it. It pins the check to that one credential
 * type, which is what "sign in with X, confirm with X" means: an account can
 * hold several credentials at once (a local password plus an MMH binding), so
 * trying them in a fixed order would ask for the wrong secret and report a
 * meaningless "wrong password".
 *
 * Without `authMethod` (login, and the ledger-switch path where the secret
 * belongs to an account nobody is signed in as yet) the type is derived from
 * the row's own fields in this fixed order, which MUST NOT be reordered:
 *
 *   1. **local** — a bcrypt `passwordHash` on the account itself.
 *   2. **fnOS** — the fnOS gateway exposes no password-verification API to
 *      third-party apps, so a gateway session itself has no secret to confirm
 *      with. What it does have is the ledger-local password the owner set for
 *      exactly this purpose ("设置本地密码" in 用户管理): an account that carries
 *      one is verified against it, and one that carries none is refused with
 *      LOCAL_PASSWORD_REQUIRED. It must never fall through to MMH or to the
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
  options: { legacyPassword?: string | null; authMethod?: SessionAuthMethod | null } = {},
): Promise<CredentialVerification> {
  const authMethod = options.authMethod ?? null;

  if (authMethod === "local") {
    if (!subject.passwordHash) {
      return { ok: false, code: "PASSWORD_NOT_SET", status: 400, attempted: "local" };
    }
    const matched = await verifyPassword(password, subject.passwordHash);
    return matched
      ? { ok: true, kind: "local" }
      : { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "local" };
  }

  if (authMethod === "mmh") {
    // Address the central account by the address it was bound with. The local
    // `email` column is never a substitute: it is an editable contact field, and
    // using it here would let an email edit silently repoint credential checks.
    if (!subject.registrationPrincipalId) {
      return { ok: false, code: "PASSWORD_NOT_SET", status: 400, attempted: "none" };
    }
    if (!subject.registrationEmail) {
      return { ok: false, code: "MMH_IDENTITY_UNRECORDED", status: 400, attempted: "none" };
    }
    const verification = await verifyEmailPrincipal({ email: subject.registrationEmail, password });
    return verification.ok
      ? { ok: true, kind: "mmh" }
      : { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "mmh" };
  }

  if (authMethod === "fnos") {
    // A gateway session proves the fnOS identity but carries no secret MMH can
    // re-check, so a sensitive operation has to confirm with the local password
    // the account owns. Refusing unconditionally made every such dialog a dead
    // end — the guidance it showed ("set a local password first") promised a fix
    // that the verifier then ignored, because this branch never looked at the
    // hash.
    if (!subject.passwordHash) {
      return { ok: false, code: "LOCAL_PASSWORD_REQUIRED", status: 400, attempted: "fnos" };
    }
    const matched = await verifyPassword(password, subject.passwordHash);
    return matched
      ? { ok: true, kind: "local" }
      : { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "local" };
  }

  if (authMethod === "legacy") {
    const legacyPassword =
      options.legacyPassword === undefined
        ? await readLegacyAccessPassword()
        : options.legacyPassword ?? "";
    if (legacyPassword.length > 0 && password === legacyPassword) {
      return { ok: true, kind: "legacy" };
    }
    return { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "legacy" };
  }

  // No session identity available: derive the type from the row's own fields.
  if (subject.passwordHash) {
    const matched = await verifyPassword(password, subject.passwordHash);
    return matched
      ? { ok: true, kind: "local" }
      : { ok: false, code: "INVALID_PASSWORD", status: 401, attempted: "local" };
  }

  if (subject.fnosUid) {
    return { ok: false, code: "LOCAL_PASSWORD_REQUIRED", status: 400, attempted: "fnos" };
  }

  if (subject.registrationPrincipalId) {
    // Same rule as the `mmh` branch above. Callers without a session identity
    // (the ledger-switch path, where the secret belongs to an account nobody is
    // signed in as yet) land here.
    if (!subject.registrationEmail) {
      return { ok: false, code: "MMH_IDENTITY_UNRECORDED", status: 400, attempted: "none" };
    }
    const verification = await verifyEmailPrincipal({ email: subject.registrationEmail, password });
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
