import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { verifyEmailPrincipal } from "@/lib/server/registration-client";
import { queueLedgerInventoryReport } from "@/lib/server/ledger-inventory";

export const runtime = "nodejs";

const UnbindSchema = z.object({
  userId: z.string().min(1),
  password: z.string().min(1).max(200),
});

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

/**
 * POST /api/v1/settings/users/unbind-mmh — Removes the MMH binding from a user.
 *
 * Two rules, both deliberate:
 *
 * 1. **Only a non-MMH session may do it.** Whoever is signed in with MMH can
 *    already act as that identity, so letting an MMH session unbind itself (or
 *    any row) adds no control — it only hands a single-factor session the power
 *    to revoke credentials, and the MMH password it would present as proof is the
 *    very thing it already holds. Unbinding is a local-administrator action and
 *    is performed from a local-password or fnOS session.
 * 2. **It proves ownership of the MMH account being unbound**, by verifying the
 *    membership password against the registration service — not the operator's
 *    local password. A local admin removing a shared or mis-assigned membership
 *    must prove it is that MMH account being released; an accidental or hostile
 *    unbind of somebody else's membership is exactly what this prevents.
 *
 * It removes the two MMH columns and nothing else. `User.email` is a local
 * contact property (see the MMH registration section in AGENTS.md) and is never
 * touched — the local account and its password-recovery address stay exactly as
 * they were, the account simply stops being a member of the MMH account.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401, headers: cors() });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "需要管理员权限" }, { status: 403, headers: cors() });
  }
  if (currentUser.authMethod === "mmh") {
    return NextResponse.json(
      {
        ok: false,
        code: "MMH_UNBIND_REQUIRES_LOCAL",
        error: "取消 MMH 绑定需由本地账号登录后操作：MMH 登录本身无法证明对绑定数据的修改权。",
      },
      { status: 403, headers: cors() },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = UnbindSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "缺少必填字段（userId、password）" }, { status: 400, headers: cors() });
  }

  const { userId, password } = parsed.data;
  const { householdId } = await getHouseholdScope();

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      householdId: true,
      isSystem: true,
      passwordHash: true,
      fnosUid: true,
      registrationPrincipalId: true,
      registrationEmail: true,
    },
  });
  if (!target) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 404, headers: cors() });
  }
  if (target.isSystem && currentUser.isSystem !== true) {
    return NextResponse.json({ ok: false, code: "SYSTEM_ADMIN_RESTRICTED", error: "仅系统管理员可管理系统管理员" }, { status: 403, headers: cors() });
  }
  if (!target.isSystem && target.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403, headers: cors() });
  }
  if (!target.registrationPrincipalId) {
    return NextResponse.json({ ok: false, code: "MMH_NOT_BOUND", error: "该账号未绑定 MMH 账号" }, { status: 409, headers: cors() });
  }

  // Ownership proof needs an address to ask the registration service about, and
  // a binding that never recorded one cannot produce it. Repair that binding
  // (re-verify) instead of guessing from the local contact email, which is not
  // an identity.
  const membershipAddress = target.registrationEmail?.trim();
  if (!membershipAddress) {
    return NextResponse.json(
      {
        ok: false,
        code: "MMH_IDENTITY_UNRECORDED",
        error: "该账号的 MMH 绑定未记录账号地址，无法验证 MMH 密码。请先用该 MMH 账号密码重新验证绑定，补全地址后再取消绑定。",
      },
      { status: 409, headers: cors() },
    );
  }

  // Refuse to leave an account with no way in at all. An MMH-only account (no
  // local password, no fnOS identity) would simply stop being able to sign in,
  // which is indistinguishable from losing the account. Setting a local
  // password first keeps it reachable; deleting it outright is a different act.
  if (!target.passwordHash && !target.fnosUid) {
    return NextResponse.json(
      {
        ok: false,
        code: "MMH_ONLY_ACCOUNT",
        error: "该账号没有本地密码或飞牛绑定，取消 MMH 绑定后将无法登录。请先为其设置本地密码，或直接删除该账号。",
      },
      { status: 409, headers: cors() },
    );
  }

  // The membership password of the MMH account being released, checked against
  // the central registration service. A wrong password fails here even though the
  // caller is a perfectly authorized local administrator.
  const verification = await verifyEmailPrincipal({ email: membershipAddress, password });
  if (!verification.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: verification.code ?? "MMH_CREDENTIAL_VERIFICATION_FAILED",
        error: verification.code === "INVALID_CREDENTIALS"
          ? "该 MMH 账号的密码不正确。"
          : (verification.error ?? "MMH 账号验证失败。"),
      },
      { status: verification.status ?? 401, headers: cors() },
    );
  }

  await prisma.user.update({
    where: { id: userId },
    data: { registrationPrincipalId: null, registrationEmail: null },
  });

  // The ledger lost an MMH-bound member; refresh the installation inventory.
  queueLedgerInventoryReport("member-changed");

  return NextResponse.json(
    { ok: true, unboundFrom: membershipAddress },
    { headers: cors() },
  );
}