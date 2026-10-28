import { NextResponse } from "next/server";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { loadCategoryUsageStats } from "@/lib/server/category-usage";

export const runtime = "nodejs";

/**
 * GET /api/v1/category/usage
 * 分类下拉的快捷选择数据（最近使用 / 使用次数最多）。
 *
 * Response: { ok: true, usage: { recent: string[], frequent: string[] } }
 * 两条列表都是候选 id（已按对应口径排序），由客户端按当前可见分类裁剪、去重。
 */
export async function GET(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const usage = await loadCategoryUsageStats(ctx.hidFilter);
    return NextResponse.json({ ok: true, usage }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("GET /api/v1/category/usage error:", e);
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: "查询失败" }, { status: 500 });
  }
}
