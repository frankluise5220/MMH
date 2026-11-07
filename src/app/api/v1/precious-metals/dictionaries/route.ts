/**
 * API: /api/v1/precious-metals/dictionaries
 *
 * Method:
 * - GET: queries the precious-metal types and measurement-unit dictionaries available to the current household.
 * - POST: creates a household-scoped type or unit (session auth only; Access Keys stay read-only).
 *
 * Auth: required
 * Context: server/book/user/role
 *
 * Success:
 * {
 *   ok: true,
 *   data: {
 *     types: [{ id, code, name, shortName }],
 *     units: [{ id, code, name, symbol, decimals }]
 *   }
 * }
 */
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { canWrite } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  createPreciousMetalDictionary,
  listPreciousMetalDictionaries,
  PreciousMetalDictionaryError,
} from "@/lib/server/precious-metals";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const data = await listPreciousMetalDictionaries(householdId);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取贵金属字典失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/v1/precious-metals/dictionaries
 * Body: { kind: "type" | "unit", name, code?, shortName?, symbol?, decimals? }
 *
 * 系统内置清单只读；新建的行只属于当前账簿，与外汇「新增货币」同一口径。
 */
export async function POST(req: Request) {
  try {
    const { householdId, user } = await getHouseholdScope();
    if (!user) return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
    if (!canWrite(user)) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "只读用户不能新增字典" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const item = await createPreciousMetalDictionary(householdId, body);
    // 字典来自服务端 props（common-data 缓存），失效后下次导航能拿到新行；
    // 当前已打开的下拉由客户端本地事件即时补齐，不必整页重渲染。
    try {
      revalidateTag("common-data", "max");
    } catch {
      /* 缓存失效失败不影响本次新建结果 */
    }
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    if (error instanceof PreciousMetalDictionaryError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.code === "DUPLICATE" ? 409 : 400 },
      );
    }
    const message = error instanceof Error ? error.message : "新增贵金属字典失败";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
