import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadNotificationFeed } from "@/lib/server/notification-feed";
import { logger } from "@/lib/logger";

/**
 * GET /api/v1/notifications
 *
 * 通知栏数据源。返回当前账簿的
 *   - reminders：未来 7 天内到期（含最近 30 天逾期）的存单/债券/保险/贷款/转账计划；
 *   - receipt  ：系统**真实落账**的执行回执（读 TxRecord，不看 ok:true）；
 *   - overdueAutoCount：逾期未落账的自动计划数。
 *
 * 只读、无副作用。失败时返回 ok:false 而不是抛错——侧边栏通知栏是装饰性组件，
 * 取数失败不应该影响任何页面。
 */
export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const feed = await loadNotificationFeed({ householdId });
    return NextResponse.json({
      ok: true,
      serverTime: new Date().toISOString(),
      ...feed,
    });
  } catch (error) {
    logger.warn(
      "load notification feed failed: " + (error instanceof Error ? error.message : String(error)),
      "notifications",
    );
    return NextResponse.json({ ok: false, error: "load-failed", reminders: [], receipt: null, overdueAutoCount: 0 });
  }
}
