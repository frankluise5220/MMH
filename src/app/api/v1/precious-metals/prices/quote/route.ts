import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { resolveHouseholdTimeZone } from "@/lib/server/business-time-zone";
import { queryMetalLatestUnitPrice } from "@/lib/metal/price";

export const runtime = "nodejs";

/**
 * GET /api/v1/precious-metals/prices/quote?metalTypeId=&metalUnitId=
 *
 * 记账弹窗「获取最新价格」用：不依赖账户里已有持仓，按「品种 + 计量单位」直接查，
 * 报价口径与持仓刷新一致（人民币 / 计量单位）。
 *
 * Response: { ok: true, data: { price, priceDate, source, quoteLabel } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const url = new URL(req.url);
    const metalTypeId = String(url.searchParams.get("metalTypeId") ?? "").trim();
    const metalUnitId = String(url.searchParams.get("metalUnitId") ?? "").trim();
    if (!metalTypeId || !metalUnitId) {
      return NextResponse.json({ ok: false, error: "缺少贵金属品种或计量单位" }, { status: 400 });
    }

    const [metalType, metalUnit] = await Promise.all([
      prisma.preciousMetalType.findFirst({
        where: { id: metalTypeId, OR: [{ householdId }, { householdId: null }] },
        select: { code: true, name: true },
      }),
      prisma.preciousMetalUnit.findFirst({
        where: { id: metalUnitId, OR: [{ householdId }, { householdId: null }] },
        select: { code: true, name: true },
      }),
    ]);
    if (!metalType || !metalUnit) {
      return NextResponse.json({ ok: false, error: "贵金属品种或计量单位不存在" }, { status: 404 });
    }

    const timeZone = await resolveHouseholdTimeZone(householdId);
    const quote = await queryMetalLatestUnitPrice({
      metalCode: metalType.code,
      metalName: metalType.name,
      unitCode: metalUnit.code,
      timeZone,
    });
    if (!quote) {
      return NextResponse.json({
        ok: false,
        error: "未获取到该品种的行情（目前支持黄金、白银、铂金、钯金），请手动填写单价",
      });
    }

    return NextResponse.json({
      ok: true,
      data: {
        price: quote.price,
        priceDate: quote.priceDate,
        source: quote.source,
        quoteLabel: quote.quoteLabel,
        metalName: metalType.name,
        unitName: metalUnit.name,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "获取贵金属行情失败" },
      { status: 500 },
    );
  }
}
