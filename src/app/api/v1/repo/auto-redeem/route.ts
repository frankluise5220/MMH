import { NextResponse } from "next/server";

import { todayDateBusinessYmd } from "@/lib/date-utils";
import { getHouseholdTimeZone } from "@/lib/server/household-preferences";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { autoRedeemDueRepos } from "@/lib/server/repo-transactions";

export const runtime = "nodejs";

/**
 * POST /api/v1/repo/auto-redeem —— 到期逆回购自动回款。
 *
 * 逆回购只有一个操作（借出），到期不需要用户再确认回款：业务日过了到期日，
 * 本息自动回到借出时的券商资金账户。开机巡检与股票视图打开时都会调一次，幂等。
 *
 * Body（可选）：
 * - accountId?: 只处理某个证券账户
 * - asOf?: 业务日 yyyy-MM-dd（默认按家庭时区取今天，仅用于回放/测试）
 */
export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const accountId = String(body?.accountId ?? "").trim() || null;
    const asOf =
      String(body?.asOf ?? "").trim() || todayDateBusinessYmd(await getHouseholdTimeZone(householdId));

    const result = await autoRedeemDueRepos({ householdId, asOf, accountId });
    return NextResponse.json({ ok: true, asOf, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "逆回购自动回款失败";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
