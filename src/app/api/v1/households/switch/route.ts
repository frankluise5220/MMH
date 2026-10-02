import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { CREDENTIAL_SUBJECT_SELECT, verifyUserCredential } from "@/lib/server/verify-credential";
import { HOUSEHOLD_COOKIE, USER_ID_COOKIE } from "@/lib/server/session-cookies";

/**
 * POST /api/v1/households/switch
 * Switches the active household (sets the householdId cookie).
 *
 * Body: { householdId: string, username?: string, password?: string }
 * The current system admin may switch to any household; a regular user switching to
 * another household must provide the target household admin username and password.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Authentication is required." }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const householdId = String(body.householdId ?? "").trim();
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!householdId) {
    return NextResponse.json({ ok: false, code: "MISSING_HOUSEHOLD_ID", error: "A ledger ID is required." }, { status: 400 });
  }

  const exists = await prisma.household.findUnique({ where: { id: householdId } });
  if (!exists) {
    return NextResponse.json({ ok: false, code: "HOUSEHOLD_NOT_FOUND", error: "Ledger not found." }, { status: 404 });
  }

  // Permission check: the current admin can switch directly; a regular user switching to a different household must verify the target household admin credentials.
  if (!isAdmin(user) && user.householdId !== householdId) {
    if (!username || !password) {
      return NextResponse.json({ ok: false, code: "ADMIN_CREDENTIALS_REQUIRED", error: "Target ledger administrator credentials are required." }, { status: 403 });
    }
    const namedTargetUser = await prisma.user.findFirst({
      where: { name: username, householdId, role: "admin" },
      select: CREDENTIAL_SUBJECT_SELECT,
    });
    const targetUser = namedTargetUser ?? await prisma.user.findFirst({
      where: { householdId, role: "admin" },
      select: CREDENTIAL_SUBJECT_SELECT,
    });
    if (!targetUser) {
      return NextResponse.json({ ok: false, code: "TARGET_ADMIN_NOT_FOUND", error: "The target ledger administrator was not found." }, { status: 401 });
    }
    // The target administrator may be a local, MMH-only or fnOS-bound account,
    // so this runs the same credential order as login and sensitive operations
    // (`verifyUserCredential`). Only the wording differs, because here the
    // secret belongs to someone else.
    const verdict = await verifyUserCredential(targetUser, password);
    if (!verdict.ok) {
      const code = verdict.code === "INVALID_PASSWORD" ? "INVALID_ADMIN_PASSWORD" : verdict.code;
      const error =
        verdict.code === "INVALID_PASSWORD"
          ? "The target ledger administrator password is incorrect."
          : verdict.code === "LOCAL_PASSWORD_REQUIRED"
            ? "该飞牛账户尚未建立本地密码，请先在用户设置中设置本地密码。"
            : "The target ledger administrator has no password set.";
      return NextResponse.json({ ok: false, code, error }, { status: verdict.status });
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(USER_ID_COOKIE, user.id, {
    path: "/",
    maxAge: 31536000,
    httpOnly: true,
    sameSite: "lax",
  });
  res.cookies.set(HOUSEHOLD_COOKIE, householdId, {
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
  });
  return res;
}
