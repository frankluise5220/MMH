import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import {
  CREDENTIAL_SUBJECT_SELECT,
  verifyUserCredential,
  type CredentialSubject,
  type CredentialVerification,
} from "@/lib/server/verify-credential";

export type SensitiveOperationVerification = {
  ok: boolean;
  code?: string;
  error?: string;
  status?: number;
};

/**
 * Context-specific wording for the shared verifier's machine codes. The codes
 * are owned by `verifyUserCredential`; the sentences belong here, because a
 * wrong local password and a wrong MMH membership password are different
 * mistakes that deserve different explanations.
 */
function failureMessage(verdict: Extract<CredentialVerification, { ok: false }>): string {
  switch (verdict.code) {
    case "LOCAL_PASSWORD_REQUIRED":
      return "该飞牛账户尚未建立本地密码，请先在用户设置中设置本地密码。";
    case "INVALID_PASSWORD":
      return verdict.attempted === "mmh"
        ? "The MMH account password is incorrect."
        : "The current user password is incorrect.";
    default:
      return "The current user has no password set.";
  }
}

/**
 * Verifies the current signed-in administrator's own password for sensitive
 * operations. Deployment-level passwords are intentionally not accepted.
 *
 * The credential order lives in `verifyUserCredential` and is shared with the
 * login form and the ledger-switch path — see that module for the rationale.
 * This wrapper only adds the "must be a signed-in admin" guard.
 */
export async function verifySensitiveOperationPassword(
  password: string,
): Promise<SensitiveOperationVerification> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { ok: false, code: "UNAUTHORIZED", error: "Sign in required.", status: 401 };
  }
  if (!isAdmin(currentUser)) {
    return { ok: false, code: "FORBIDDEN", error: "Administrator access is required.", status: 403 };
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: CREDENTIAL_SUBJECT_SELECT,
  });
  // A signed-in user always has a row. If it disappeared mid-session (a restore
  // replaced the user table), fall through with an empty subject so the legacy
  // bridge still gets a chance instead of throwing.
  const subject: CredentialSubject =
    dbUser ?? { passwordHash: null, fnosUid: null, registrationPrincipalId: null, email: null };

  const verdict = await verifyUserCredential(subject, password);
  if (verdict.ok) return { ok: true };
  return { ok: false, code: verdict.code, error: failureMessage(verdict), status: verdict.status };
}
