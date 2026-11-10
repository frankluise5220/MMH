/**
 * POST /api/v1/undo/register: 一次「确认导入」登记一条可撤销记录。
 *
 * 账单 Excel 导入会把一次点击拆成多个 POST /api/v1/statement/import 请求，
 * 那些请求本身不写 undo（否则一次确认会变成多条撤销记录，而通用撤销只撤最新一条）。
 * 前端汇总本次新建的明细 id 后，在确认结束时调用这里一次，整批只生成一条 batch_create。
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { prepareCreatedEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { getHouseholdScope } from "@/lib/server/household-scope";

const MAX_ENTRY_IDS = 10_000;

export async function POST(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    if (!ctx.user) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json().catch(() => null) as { entryIds?: unknown } | null;
    const ids = Array.isArray(body?.entryIds)
      ? Array.from(new Set(body.entryIds.filter((id): id is string => typeof id === "string" && id.length > 0)))
      : [];
    if (ids.length === 0) {
      return NextResponse.json({ ok: true, data: { undoOperationId: null } });
    }
    const undo = await prepareCreatedEntryUndo(prisma, ctx.householdId, ids.slice(0, MAX_ENTRY_IDS));
    const saved = undo
      ? await saveEntryUndo(prisma, ctx, undo, "batch_create", `批量导入 ${undo.entryIds.length} 条明细`)
      : null;
    return NextResponse.json({ ok: true, data: { undoOperationId: saved?.id ?? null } });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        code: "UNDO_REGISTER_FAILED",
        error: error instanceof Error ? error.message : "Failed to register undo",
      },
      { status: 500 },
    );
  }
}
