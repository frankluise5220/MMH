import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const runtime = "nodejs";

/**
 * GET /api/v1/fund/nav/history
 *
 * 查询指定基金在日期范围内的历史净值数据，用于绘制走势图。
 *
 * Query params:
 *   code      (required) — 基金代码
 *   start     (optional) — 开始日期 YYYY-MM-DD，默认 90 天前
 *   end       (optional) — 结束日期 YYYY-MM-DD，默认今天
 *
 * Response:
 *   { ok: true, data: [{ date, nav, cumNav }] }
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ ok: false, error: "缺少基金代码" }, { status: 400 });
  }

  const endRaw = req.nextUrl.searchParams.get("end")?.trim();
  const startRaw = req.nextUrl.searchParams.get("start")?.trim();

  const endDate = endRaw ? new Date(endRaw) : new Date();
  // 默认取 180 天数据，覆盖近6个月走势
  const defaultStart = new Date(endDate);
  defaultStart.setDate(defaultStart.getDate() - 180);
  const startDate = startRaw ? new Date(startRaw) : defaultStart;

  try {
    const rows = await prisma.fundNavCache.findMany({
      where: {
        fundCode: code,
        navDate: { gte: startDate, lte: endDate },
      },
      orderBy: { navDate: "asc" },
      select: { navDate: true, nav: true, cumNav: true },
    });

    const data = rows.map((r) => ({
      date: r.navDate.toISOString().substring(0, 10),
      nav: r.nav,
      cumNav: r.cumNav ?? null,
    }));

    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}
