/**
 * GET /api/v1/undo: returns the latest user entry operation and whether it can be undone.
 * POST /api/v1/undo: restores the latest edit/delete operation as one atomic group.
 */
import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { getLatestEntryUndo, undoLatestEntryOperation } from "@/lib/server/entry-undo";

export async function GET() {
  const ctx = await getHouseholdScope();
  if (!ctx.user) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const operation = await getLatestEntryUndo(ctx);
  return NextResponse.json({
    ok: true,
    data: operation ? {
      id: operation.id,
      label: operation.label,
      action: operation.action,
      createdAt: operation.createdAt.toISOString(),
      canUndo: !operation.undoneAt,
    } : null,
  });
}

export async function POST() {
  try {
    const ctx = await getHouseholdScope();
    if (!ctx.user) {
      return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
    }
    const result = await undoLatestEntryOperation(ctx);
    if (!result) {
      return NextResponse.json({ ok: false, error: "没有可撤销的操作" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "撤销失败",
    }, { status: 500 });
  }
}
