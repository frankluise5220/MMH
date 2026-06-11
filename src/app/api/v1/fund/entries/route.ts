import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function GET(req: NextRequest) {
  const { hidFilter } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();
  const subtype = searchParams.get("subtype")?.trim();

  if (!accountId || !fundCode) {
    return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400 });
  }

  try {
    const entries = await prisma.txRecord.findMany({
      where: {
        ...hidFilter,
        OR: [{ toAccountId: accountId }, { accountId: accountId }],
        fundCode,
        source: subtype || "regular_invest",
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });

    const result = entries.map(e => ({
      id: e.id,
      date: e.date.toISOString().slice(0, 10),
      fundCode: e.fundCode,
      fundName: e.fundName,
      amount: String(e.amount),
      fundNav: e.fundNav ? String(e.fundNav) : null,
      fundUnits: e.fundUnits ? String(e.fundUnits) : null,
      fundConfirmDate: e.fundConfirmDate ? e.fundConfirmDate.toISOString().slice(0, 10) : null,
    }));

    return NextResponse.json({ ok: true, entries: result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}