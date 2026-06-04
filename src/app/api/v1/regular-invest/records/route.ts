import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export async function GET(req: NextRequest) {
  const planId = req.nextUrl.searchParams.get("planId");
  if (!planId) return NextResponse.json({ ok: false, error: "缺少 planId" }, { status: 400 });

  const records = await prisma.txRecord.findMany({
    where: {
      regularInvestPlanId: planId,
      deletedAt: null,
    },
    select: {
      id: true,
      date: true,
      amount: true,
      fundUnits: true,
      fundConfirmDate: true,
    },
    orderBy: { date: "asc" },
  });

  return NextResponse.json({ ok: true, records });
}