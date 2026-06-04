import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

/**
 * 批量更新交易记录
 *
 * POST { updates: Array<{ id: string; accountName?: string; remark?: string }> }
 *   id 必须是 TxRecord.id
 *   返回 { ok: true, updatedCount } 或 { ok: false, error }
 *   如果所有 ID 都未匹配到记录，返回 { ok: false, error }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const updates: Array<{ id: string; accountName?: string; remark?: string; type?: string }> = body.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ ok: false, error: "没有更新数据" }, { status: 400 });
    }

    let updatedCount = 0;
    const notFoundIds: string[] = [];
    for (const item of updates) {
      if (!item.id) continue;
      const data: Record<string, unknown> = {};
      if (item.accountName) {
        data.accountName = item.accountName;
        const account = await prisma.account.findFirst({
          where: { name: item.accountName, isActive: true },
        });
        if (account) data.accountId = account.id;
      }
      if (item.remark !== undefined) data.note = item.remark;

      const result = await prisma.txRecord.updateMany({
        where: { id: item.id },
        data,
      });
      if (result.count > 0) {
        updatedCount++;
      } else {
        notFoundIds.push(item.id);
      }
    }

    if (updatedCount === 0) {
      return NextResponse.json(
        { ok: false, error: `未找到匹配的记录 (IDs: ${notFoundIds.slice(0, 3).join(", ")}${notFoundIds.length > 3 ? "..." : ""})` },
        { status: 404 }
      );
    }

    revalidateAfterTxChange();
    return NextResponse.json({ ok: true, updatedCount, notFoundIds: notFoundIds.length > 0 ? notFoundIds : undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "更新失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}