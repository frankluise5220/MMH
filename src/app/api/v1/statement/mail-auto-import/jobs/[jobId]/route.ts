import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ jobId: string }> };

/**
 * GET /api/v1/statement/mail-auto-import/jobs/:jobId
 * 取回自动抓到的账单原文（正文 + 附件文字），前端据此调 /statement/parse 生成导入预览。
 */
export async function GET(_req: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const { householdId } = await getHouseholdScope();
  const job = await prisma.statementMailAutoImportJob.findFirst({
    where: { id: jobId, householdId },
    select: {
      id: true,
      subject: true,
      fromAddress: true,
      mailDate: true,
      content: true,
      accountId: true,
      accountName: true,
      emailAccountId: true,
      uid: true,
      hash: true,
      status: true,
    },
  });
  if (!job) {
    return NextResponse.json({ ok: false, code: "NOT_FOUND", error: "任务不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, data: job });
}

/**
 * PATCH /api/v1/statement/mail-auto-import/jobs/:jobId
 * Body: { status: "imported" | "dismissed" | "pending" }
 * 导入完成或用户忽略后标记，通知栏不再提示。
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  const { jobId } = await context.params;
  const { householdId } = await getHouseholdScope();
  const body = (await req.json().catch(() => ({}))) as { status?: unknown };
  const status = String(body.status ?? "").trim();
  if (!["pending", "imported", "dismissed"].includes(status)) {
    return NextResponse.json({ ok: false, code: "INVALID_STATUS", error: "状态不合法" }, { status: 400 });
  }
  const existing = await prisma.statementMailAutoImportJob.findFirst({
    where: { id: jobId, householdId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "NOT_FOUND", error: "任务不存在" }, { status: 404 });
  }
  await prisma.statementMailAutoImportJob.update({ where: { id: jobId }, data: { status } });
  return NextResponse.json({ ok: true });
}
