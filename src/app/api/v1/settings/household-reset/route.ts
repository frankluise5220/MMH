import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifySensitiveOperationPassword } from "@/lib/server/sensitive-operation-auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { resetHouseholdData } from "@/lib/server/household-reset";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/household-reset
 *
 * Initializes only the currently selected ledger: its accounts, transactions,
 * and business data are deleted, then its default account groups, accounts,
 * categories, and institutions are recreated. Other ledgers, system settings,
 * and the ledger's own members are untouched.
 *
 * Security requirements:
 * - The current signed-in user must be an administrator of the current ledger.
 * - The request must submit that user's own password. Legacy deployments without
 *   per-user passwords may still verify the old access password.
 * Body: { password: string }
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Please sign in first." }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = (body?.password ?? "").trim();
  if (!password) {
    return NextResponse.json({ ok: false, code: "PASSWORD_REQUIRED", error: "Current user password is required." }, { status: 400 });
  }

  const verification = await verifySensitiveOperationPassword(password);
  if (!verification.ok) {
    return NextResponse.json({ ok: false, code: verification.code ?? "AUTH_VERIFICATION_FAILED", error: verification.error }, { status: verification.status });
  }

  const { householdId } = await getHouseholdScope();
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { id: true } });
  if (!household) {
    return NextResponse.json({ ok: false, code: "HOUSEHOLD_NOT_FOUND", error: "Current ledger was not found." }, { status: 404 });
  }

  await resetHouseholdData({ householdId, operatorName: currentUser.name });

  return NextResponse.json({ ok: true, householdId });
}
