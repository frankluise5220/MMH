import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";

function parsePrompt(prompt: string) {
  let dateFrom = "";
  let dateTo = "";
  let amountMin: number | undefined;
  let amountMax: number | undefined;

  // Date range: "2025年1月到2025年3月" or "2025-01到2025-03"
  const rangeMatch = prompt.match(/(\d{4}-\d{2}|\d{4}\s*年\s*\d{1,2}\s*月)\s*[到至\-]\s*(\d{4}-\d{2}|\d{4}\s*年\s*\d{1,2}\s*月)/);
  if (rangeMatch) {
    const fromP = rangeMatch[1].match(/(\d{4}).*?(\d{1,2})/);
    const toP = rangeMatch[2].match(/(\d{4}).*?(\d{1,2})/);
    if (fromP) dateFrom = `${fromP[1]}-${fromP[2].padStart(2, "0")}`;
    if (toP) dateTo = `${toP[1]}-${toP[2].padStart(2, "0")}`;
  } else {
    const months: string[] = [];
    const yearMonth = prompt.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/g) || prompt.match(/\d{4}-\d{2}/g) || [];
    for (const m of yearMonth) {
      const parts = m.match(/(\d{4}).*?(\d{1,2})/) || m.match(/(\d{4})-(\d{2})/);
      if (parts) months.push(`${parts[1]}-${parts[2].padStart(2, "0")}`);
    }
    if (months.length >= 2) { dateFrom = months[0]; dateTo = months[months.length - 1]; }
    else if (months.length === 1) dateFrom = months[0];
  }

  // Amount: "金额小于500" or "金额大于100"
  const amtLt = prompt.match(/金额\s*(小于|低于|不超过|<=?)\s*(\d+)/);
  const amtGt = prompt.match(/金额\s*(大于|高于|大于等于|不低于|>=?)\s*(\d+)/);
  if (amtLt) amountMax = parseInt(amtLt[2]);
  if (amtGt) amountMin = parseInt(amtGt[2]);

  // Fund code change: "改成004011" or "基金改成014982"
  const changeFund = prompt.match(/(?:改成|改成\s*基金|基金\s*改成|基金代码\s*改成?)\s*(\d{6})/);
  const newFundCode = changeFund?.[1] || null;

  return { dateFrom, dateTo, amountMin, amountMax, newFundCode };
}

/**
 * POST /api/v1/entries/batch-edit
 *
 * Body: { prompt: string, accountId?: string, fundCode?: string, apply?: boolean }
 *
 * Without apply: returns preview with matching records
 * With apply=true: applies the changes
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter } = ctx;
    const body = await req.json();
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return NextResponse.json({ ok: false, error: "请输入修改指令" }, { status: 400 });

    const accountId = String(body.accountId ?? "").trim();
    const fundCodeFilter = String(body.fundCode ?? "").trim();
    const apply = body.apply === true;

    const { dateFrom, dateTo, amountMin, amountMax, newFundCode } = parsePrompt(prompt);

    // Build filter
    const where: any = { deletedAt: null, fundCode: { not: null }, ...hidFilter };
    if (accountId) where.OR = [{ accountId }, { toAccountId: accountId }];
    if (fundCodeFilter) where.fundCode = fundCodeFilter;
    if (dateFrom) where.date = { ...(where.date || {}), gte: new Date(`${dateFrom}-01T00:00:00.000Z`) };
    if (dateTo) {
      const end = new Date(`${dateTo}-01T00:00:00.000Z`);
      end.setUTCMonth(end.getUTCMonth() + 1);
      where.date = { ...(where.date || {}), lt: end };
    }
    if (amountMax !== undefined) where.amount = { gte: -amountMax, lte: amountMax };

    if (!apply) {
      // Preview mode
      const preview = await prisma.txRecord.findMany({
        where,
        select: { id: true, date: true, amount: true, fundCode: true, fundName: true, fundSubtype: true, note: true, accountId: true, toAccountId: true },
        orderBy: { date: "asc" },
        take: 200,
      });

      return NextResponse.json({
        ok: true,
        preview: {
          count: preview.length,
          samples: preview.slice(0, 10).map(e => ({
            id: e.id, date: e.date.toISOString().slice(0, 10),
            amount: Number(e.amount), fundCode: e.fundCode, fundName: e.fundName,
            subtype: e.fundSubtype, note: e.note,
          })),
          changes: newFundCode ? { fundCode: newFundCode } : null,
          parsed: { dateFrom, dateTo, amountMin, amountMax, newFundCode },
        },
      });
    }

    // Apply mode
    const ids = await prisma.txRecord.findMany({ where, select: { id: true } });

    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "没有匹配的记录" }, { status: 404 });
    }
    const undo = await prepareEntryUndo(prisma, ctx.householdId, ids.map((entry) => entry.id));

    if (newFundCode) {
      const name = await prisma.fundNavCache.findFirst({
        where: { fundCode: newFundCode },
        orderBy: { navDate: "desc" },
        select: { name: true },
      });
      await prisma.txRecord.updateMany({
        where: { id: { in: ids.map(e => e.id) } },
        data: { fundCode: newFundCode, fundName: name?.name ?? newFundCode },
      });
    }

    await saveEntryUndo(prisma, ctx, undo, "batch_edit", `批量编辑 ${ids.length} 条明细`);

    return NextResponse.json({ ok: true, updatedCount: ids.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "操作失败" }, { status: 500 });
  }
}
