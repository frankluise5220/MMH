/**
 * The secret an account can be verified against.
 *
 * Lives in its own module (no server imports) because both sides need it: the
 * API route classifies an account, and the verification dialogs label the field
 * from the same value. `local` and `mmh` are verifiable secrets; `fnos` has no
 * verifiable secret at all; `none` is a legacy installation whose only secret
 * is the deployment-wide `access_password`.
 */
export type CredentialKind = "local" | "mmh" | "fnos" | "none";

export type CredentialKindSubject = {
  passwordHash: string | null;
  fnosUid: string | null;
  registrationPrincipalId: string | null;
  email: string | null;
};

/**
 * Classifies an account.
 *
 * MUST mirror the first three branches of `verifyUserCredential`
 * (`src/lib/server/verify-credential.ts`) in the same order — if the two
 * disagree, a dialog labels the wrong password and the user cannot tell why
 * their correct secret is rejected.
 */
export function credentialKindOf(subject: CredentialKindSubject): CredentialKind {
  if (subject.passwordHash) return "local";
  if (subject.fnosUid) return "fnos";
  if (subject.registrationPrincipalId && subject.email) return "mmh";
  return "none";
}
