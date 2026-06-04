import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getFundConfirmDays } from "@/lib/fund/confirmDays";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();

  if (!accountId) {
    return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400 });
  }

  try {
    if (fundCode) {
      const days = await getFundConfirmDays(accountId, fundCode);
      return NextResponse.json({ ok: true, days });
    }
    // 没有 fundCode 时返回账户默认值
    const record = await prisma.account.findUnique({
      where: { id: accountId },
      select: { defaultConfirmDays: true },
    });
    return NextResponse.json({ ok: true, days: record?.defaultConfirmDays ?? 0 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}