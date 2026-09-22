import { verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export type SensitiveOperationVerification = {
  ok: boolean;
  code?: string;
  error?: string;
  status?: number;
};

/**
 * Verifies the current signed-in administrator's own password for sensitive
 * operations. Deployment-level passwords are intentionally not accepted.
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
    select: { passwordHash: true },
  });
  if (dbUser?.passwordHash) {
    const matched = await verifyPassword(password, dbUser.passwordHash);
    if (matched) return { ok: true };
    return { ok: false, code: "INVALID_PASSWORD", error: "The current user password is incorrect.", status: 401 };
  }

  return { ok: false, code: "PASSWORD_NOT_SET", error: "The current user has no password set.", status: 400 };
}
