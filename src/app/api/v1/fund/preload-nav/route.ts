import { NextRequest, NextResponse } from "next/server";
import { fetchHistoricalNavList, preloadNavListToCache } from "@/lib/fund/navCache";

/**
 * 扩充净值库 API
 * POST /api/v1/fund/preload-nav
 * Body: { fundCode: string, startDate: string, endDate: string }
 *
 * 仅将指定时间段内的历史净值写入 FundNavCache 缓存表。
 * 不返回净值数据，只返回成功/失败状态和写入条数。
 *
 * 调用时机：批量生成定投明细前，先调此 API 预填充净值库，
 * 之后批量生成时从缓存读取，无需再访问外部 API，节省时间。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fundCode, startDate, endDate } = body;

    if (!fundCode || !startDate || !endDate) {
      return NextResponse.json(
        { ok: false, error: "缺少 fundCode、startDate 或 endDate" },
        { status: 400 }
      );
    }

    // 从东方财富获取历史净值列表
    const navList = await fetchHistoricalNavList(fundCode, startDate, endDate);

    if (navList.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "该时间段内无净值数据",
        count: 0,
      });
    }

    // 将净值写入缓存表
    const written = await preloadNavListToCache(fundCode, navList);

    return NextResponse.json({
      ok: true,
      message: `已扩充净值库 ${written} 条`,
      count: written,
      total: navList.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "扩充净值库失败" },
      { status: 500 }
    );
  }
}