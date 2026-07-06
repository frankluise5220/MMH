import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const MailRefSchema = z.object({
  emailAccountId: z.string().min(1),
  uid: z.number().int().min(1),
});

function buildMailImportNote(mail: z.infer<typeof MailRefSchema>) {
  return `email:${mail.emailAccountId}:${mail.uid}`;
}

/**
 * POST /api/v1/statement/imported-mail
 *
 * Body: { mails: [{ emailAccountId, uid }] }
 * Response: { ok: true, imported: [{ emailAccountId, uid, importBatchId, createdAt }] }
 *
 * Used by credit-card email bill import to mark messages that were already imported.
 */
export async function POST(req: Request) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, error: "未授权" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = z.object({ mails: z.array(MailRefSchema).max(100) }).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "mails 格式不正确" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();
  const notes = Array.from(new Set(parsed.data.mails.map(buildMailImportNote)));
  if (notes.length === 0) {
    return NextResponse.json({ ok: true, imported: [] });
  }

  const batches = await prisma.importBatch.findMany({
    where: {
      householdId,
      source: "credit_bill_mail",
      note: { in: notes },
    },
    select: {
      id: true,
      note: true,
      createdAt: true,
    },
  });

  const imported = batches.flatMap((batch) => {
    const match = batch.note?.match(/^email:(.+):(\d+)$/);
    if (!match) return [];
    return [{
      emailAccountId: match[1],
      uid: Number(match[2]),
      importBatchId: batch.id,
      createdAt: batch.createdAt.toISOString(),
    }];
  });

  return NextResponse.json({ ok: true, imported });
}
