import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { isAdmin } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import {
  computeNextMonthlyRunAt,
  normalizeAutoImportDayOfMonth,
  normalizeAutoImportHourOfDay,
} from "@/lib/server/statement-mail-auto-import";

export const runtime = "nodejs";

function normalizeText(value: unknown, max = 120): string | null {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

/** GET /api/v1/statement/mail-auto-import/schedules —— 当前账簿的自动导入计划。 */
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const rows = await prisma.statementMailAutoImport.findMany({
    where: { householdId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      emailAccountId: true,
      accountId: true,
      accountName: true,
      fromIncludes: true,
      subjectIncludes: true,
      dayOfMonth: true,
      hourOfDay: true,
      enabled: true,
      lastRunAt: true,
      lastError: true,
      nextRunAt: true,
    },
  });
  return NextResponse.json({ ok: true, data: rows });
}

/**
 * PUT /api/v1/statement/mail-auto-import/schedules
 * 开/关或调整「下期自动导入」。同一邮箱 + 同一目标账户只保留一条，重复调用即更新。
 */
export async function PUT(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { ok: false, code: "ADMIN_REQUIRED", error: "只有管理员可以设置自动导入" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const emailAccountId = normalizeText(body.emailAccountId, 64);
  if (!emailAccountId) {
    return NextResponse.json({ ok: false, code: "EMAIL_ACCOUNT_REQUIRED", error: "缺少邮箱账户" }, { status: 400 });
  }
  const emailAccount = await prisma.emailAccount.findFirst({
    where: { id: emailAccountId, householdId },
    select: { id: true },
  });
  if (!emailAccount) {
    return NextResponse.json({ ok: false, code: "EMAIL_ACCOUNT_NOT_FOUND", error: "邮箱账户不存在" }, { status: 404 });
  }

  const accountId = normalizeText(body.accountId, 64);
  const accountName = normalizeText(body.accountName);
  const dayOfMonth = normalizeAutoImportDayOfMonth(body.dayOfMonth ?? 1);
  const hourOfDay = normalizeAutoImportHourOfDay(body.hourOfDay ?? 9);
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  const timeZone = await getHouseholdTimeZone(householdId);
  const nextRunAt = computeNextMonthlyRunAt({ from: new Date(), dayOfMonth, hourOfDay, timeZone });

  const data = {
    accountId,
    accountName,
    fromIncludes: normalizeText(body.fromIncludes),
    subjectIncludes: normalizeText(body.subjectIncludes),
    dayOfMonth,
    hourOfDay,
    enabled,
    nextRunAt,
    lastError: null,
  };

  const existing = await prisma.statementMailAutoImport.findFirst({
    where: { householdId, emailAccountId, accountId },
    select: { id: true },
  });
  const saved = existing
    ? await prisma.statementMailAutoImport.update({ where: { id: existing.id }, data })
    : await prisma.statementMailAutoImport.create({
        data: { ...data, householdId, emailAccountId },
      });

  return NextResponse.json({ ok: true, data: saved });
}

/** DELETE /api/v1/statement/mail-auto-import/schedules?id=xxx —— 关闭并删除计划。 */
export async function DELETE(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json(
      { ok: false, code: "ADMIN_REQUIRED", error: "只有管理员可以设置自动导入" },
      { status: 403 },
    );
  }
  const id = normalizeText(req.nextUrl.searchParams.get("id"), 64);
  if (!id) {
    return NextResponse.json({ ok: false, code: "ID_REQUIRED", error: "缺少计划 id" }, { status: 400 });
  }
  const existing = await prisma.statementMailAutoImport.findFirst({
    where: { id, householdId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "NOT_FOUND", error: "计划不存在" }, { status: 404 });
  }
  await prisma.statementMailAutoImport.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
