import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { credentialKindOf } from "@/lib/credential-kind";
import { CREDENTIAL_SUBJECT_SELECT } from "@/lib/server/verify-credential";

export const runtime = "nodejs";

/**
 * GET /api/v1/auth/credential-kind[?householdId=<id>]
 *
 * Which secret must be presented to verify an account.
 *
 * `verifyUserCredential()` accepts three different credentials depending on how
 * the account was created (ledger-local password, fnOS binding, or the central
 * MMH membership password). The verification dialogs have to name the right one
 * — otherwise an MMH-only administrator is asked for a "current user password"
 * that does not exist and reasonably concludes the dialog is broken.
 *
 * Without `householdId` this describes the signed-in user, which is what every
 * sensitive-operation dialog needs.
 *
 * With `householdId` it describes that ledger's administrator instead. The
 * ledger-switch dialog verifies *someone else's* credential, so it must not be
 * answered with the caller's own kind. Only the kind is returned for a target —
 * never its email or name — because the caller has no business reading another
 * account's identifiers.
 *
 * The verdict MUST stay in sync with `verifyUserCredential`; both derive from
 * `credentialKindOf` so the order cannot drift.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required." }, { status: 401 });
  }

  const householdId = req.nextUrl.searchParams.get("householdId")?.trim() ?? "";

  if (householdId) {
    const targetAdmin = await prisma.user.findFirst({
      where: { householdId, role: "admin" },
      select: CREDENTIAL_SUBJECT_SELECT,
      orderBy: { createdAt: "asc" },
    });
    if (!targetAdmin) {
      return NextResponse.json(
        { ok: false, code: "TARGET_ADMIN_NOT_FOUND", error: "The target ledger administrator was not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      credentialKind: credentialKindOf(targetAdmin),
      target: true,
      email: null,
    });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: CREDENTIAL_SUBJECT_SELECT,
  });
  if (!dbUser) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "The signed-in user no longer exists." }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    credentialKind: credentialKindOf(dbUser),
    target: false,
    // Only used to explain *which* account is being verified; never a secret.
    email: dbUser.email ?? null,
  });
}
