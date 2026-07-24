import { NextRequest, NextResponse } from "next/server";
import {
  HOUSEHOLD_COOKIE,
  SESSION_DAYS_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  sessionCookieOptions,
} from "@/lib/server/session-cookies";
import { prisma } from "@/lib/db/prisma";
import {
  createLedgerWithDefaults,
  LEDGER_CREATION_INVITE_CODE_KEY,
} from "@/lib/households/create-ledger";

function resolveSessionMaxAge(req: NextRequest) {
  const raw = req.cookies.get(SESSION_DAYS_COOKIE)?.value ?? "30";
  const days = Number(raw);
  const normalizedDays = Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 365) : 30;
  return normalizedDays * 24 * 60 * 60;
}

/**
 * POST /api/v1/auth/create-ledger
 * 公开入口：通过邀请码创建新账簿，并直接登录到新账簿管理员。
 *
 * Body:
 * {
 *   inviteCode: string,
 *   name: string,
 *   adminName: string,
 *   adminPassword: string,
 *   adminEmail: string
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const inviteCode = String(body.inviteCode ?? "").trim();
  const name = String(body.name ?? "").trim();
  const adminName = String(body.adminName ?? name).trim();
  const adminPassword = String(body.adminPassword ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();

  if (!inviteCode) {
    return NextResponse.json({ ok: false, error: "请输入邀请码" }, { status: 400 });
  }
  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, error: "账簿名称不合法（1-50字）" }, { status: 400 });
  }
  if (!adminName || adminName.length > 50) {
    return NextResponse.json({ ok: false, error: "管理员用户名不合法（1-50字）" }, { status: 400 });
  }
  if (!adminPassword) {
    return NextResponse.json({ ok: false, error: "请设置管理员密码" }, { status: 400 });
  }
  if (!adminEmail) {
    return NextResponse.json({ ok: false, error: "请输入邮箱" }, { status: 400 });
  }

  const inviteSetting = await prisma.systemSetting.findUnique({
    where: { key: LEDGER_CREATION_INVITE_CODE_KEY },
  });
  const expectedInviteCode = inviteSetting?.value?.trim() ?? "";
  if (!expectedInviteCode) {
    return NextResponse.json({ ok: false, error: "当前未开放新建账簿，请联系管理员" }, { status: 403 });
  }
  if (inviteCode !== expectedInviteCode) {
    return NextResponse.json({ ok: false, error: "邀请码不正确" }, { status: 403 });
  }

  const { household, adminUser } = await prisma.$transaction((tx) =>
    createLedgerWithDefaults(tx, {
      name,
      adminName,
      adminPassword,
      adminEmail,
    }),
  );

  const response = NextResponse.json({
    ok: true,
    household: { id: household.id, name: household.name },
  });
  const maxAge = resolveSessionMaxAge(req);
  const cookieOptions = sessionCookieOptions(maxAge, req);
  response.cookies.set(VERIFIED_COOKIE, "ok", cookieOptions);
  response.cookies.set(USERNAME_COOKIE, adminUser.name, cookieOptions);
  response.cookies.set(HOUSEHOLD_COOKIE, household.id, cookieOptions);
  return response;
}
