﻿﻿﻿import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getFundArrivalDays, getFundConfirmDays, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();

  if (!accountId) {
    return NextResponse.json({ ok: false, error: "缺少参数" }, { status: 400 });
  }

  try {
    if (fundCode) {
      const record = await prisma.fundConfirmDays.findUnique({
        where: { accountId_fundCode: { accountId, fundCode } },
        select: { redeemCostDays: true },
      });
      const [days, arrivalDays] = await Promise.all([
        getFundConfirmDays(accountId, fundCode),
        getFundArrivalDays(accountId, fundCode),
      ]);
      return NextResponse.json({
        ok: true,
        days,
        redeemCostDays: normalizeNonNegativeDays(record?.redeemCostDays, 1),
        arrivalDays,
      });
    }
    const record = await prisma.account.findUnique({
      where: { id: accountId },
      select: { defaultConfirmDays: true, defaultArrivalDays: true },
    });
    return NextResponse.json({
      ok: true,
      days: normalizeNonNegativeDays(record?.defaultConfirmDays, 0),
      redeemCostDays: 1,
      arrivalDays: normalizeNonNegativeDays(record?.defaultArrivalDays, 2),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: string; fundCode?: string; days?: number; redeemCostDays?: number; arrivalDays?: number;
    } | null;
    if (!body?.accountId) {
      return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });
    }
    const existing = await prisma.fundConfirmDays.findUnique({
      where: { accountId_fundCode: { accountId: body.accountId, fundCode: body.fundCode || "" } },
    });
    if (existing) {
      const data: Record<string, number> = {};
      if (typeof body.days === "number" && body.days >= 0) data.days = body.days;
      if (typeof body.redeemCostDays === "number" && body.redeemCostDays >= 0) data.redeemCostDays = body.redeemCostDays;
      if (typeof body.arrivalDays === "number" && body.arrivalDays >= 0) data.arrivalDays = body.arrivalDays;
      if (Object.keys(data).length > 0) {
        await prisma.fundConfirmDays.update({ where: { id: existing.id }, data });
      }
    } else {
      await prisma.fundConfirmDays.create({
        data: {
          accountId: body.accountId,
          fundCode: body.fundCode || "",
          days: typeof body.days === "number" && body.days >= 0 ? body.days : 0,
          redeemCostDays: typeof body.redeemCostDays === "number" && body.redeemCostDays >= 1 ? body.redeemCostDays : 1,
          arrivalDays: typeof body.arrivalDays === "number" && body.arrivalDays >= 0 ? body.arrivalDays : 2,
        },
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "保存失败" },
      { status: 500 }
    );
  }
}