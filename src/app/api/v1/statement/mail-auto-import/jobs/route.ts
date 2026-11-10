import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

/**
 * GET /api/v1/statement/mail-auto-import/jobs
 * 待确认导入的邮箱账单（不含正文，正文走 /jobs/:jobId）。
 * Response: { ok: true, data: [{ id, subject, fromAddress, mailDate, accountId, accountName, createdAt }] }
 */
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const rows = await prisma.statementMailAutoImportJob.findMany({
    where: { householdId, status: "pending" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      subject: true,
      fromAddress: true,
      mailDate: true,
      accountId: true,
      accountName: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ ok: true, data: rows });
}
