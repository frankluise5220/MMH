/**
 * POST /api/v1/entries/reconcile-state
 *
 * Body: { entryIds: string[] }
 * Response: { ok: true, data: { states: Record<string, { reconciledAt, reconciledBalance }> } }
 *
 * 只读：批量读取流水的「对账」锁定状态。
 *
 * 为什么需要它：投资/资产类视图（基金、理财、债券、存款、房产、保险、负债）的明细行
 * 就是它背后的现金流水（`cashEntryId`），服务端把业务行和现金流水做成同一行展示，
 * 所以现金明细页里锁定的记录在这些视图里同样成立。这些视图的数据来自各自的业务
 * loader（不含 `reconciledAt`），行内锁标记因此统一走这个接口取状态；
 * 解锁仍复用 `POST /api/v1/entries/reconcile`（`action: "unlock"`）。
 *
 * 只返回已锁定的 id，未锁定的记录不出现在结果里，避免大列表无谓的体积。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const BodySchema = z.object({
  entryIds: z.array(z.string().min(1)).max(10000),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "VALIDATION_FAILED", error: "参数格式不正确" }, { status: 400 });
  }

  const { hidFilter } = await getHouseholdScope();
  const householdId = hidFilter.householdId;
  const requestedIds = Array.from(new Set(parsed.data.entryIds.map((id) => id.trim()).filter(Boolean)));
  if (requestedIds.length === 0) {
    return NextResponse.json({ ok: true, data: { states: {} } });
  }

  const rows = await prisma.txRecord.findMany({
    where: { id: { in: requestedIds }, householdId, deletedAt: null, reconciledAt: { not: null } },
    select: { id: true, reconciledAt: true, reconciledBalance: true },
  });

  const states: Record<string, { reconciledAt: string; reconciledBalance: number | null }> = {};
  for (const row of rows) {
    if (!row.reconciledAt) continue;
    states[row.id] = {
      reconciledAt: row.reconciledAt.toISOString(),
      reconciledBalance: row.reconciledBalance == null ? null : toNumber(row.reconciledBalance),
    };
  }

  return NextResponse.json({ ok: true, data: { states } });
}
