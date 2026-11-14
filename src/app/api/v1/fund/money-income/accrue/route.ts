import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { accrueMoneyFundIncome } from "@/lib/server/money-fund-income-accrual";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { logger } from "@/lib/logger";

/**
 * POST /api/v1/fund/money-income/accrue
 *
 * 货币基金收益结转（每万份收益 → 增加份额），当前账本内的全部货基账户。
 *
 * 触发模型和存款/债券的自动生息一致：由开机自检（DailyTaskCheck）调用，
 * 没有 OS 后台任务。漏跑几天不会丢收益——服务按「上次结转到哪天」往前补，
 * 最多补 30 天；同一天重复触发由幂等键挡掉。
 *
 * body 可选 `{ accountId }`：只结某一个货基账户（明细页手工触发用）。
 */
export async function POST(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await request.json().catch(() => null)) as { accountId?: unknown } | null;
    const accountId = typeof body?.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : undefined;

    const result = await accrueMoneyFundIncome({ householdId, fundAccountId: accountId });
    if (result.status === "accrued") revalidateAfterInvestChange();
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    logger.error("Money fund income accrual route failed", "money-fund-income", error);
    return NextResponse.json(
      {
        ok: false,
        code: "MONEY_INCOME_ACCRUAL_FAILED",
        error: error instanceof Error ? error.message : "执行失败",
      },
      { status: 500 },
    );
  }
}
