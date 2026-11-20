import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { accrueMoneyFundIncome } from "@/lib/server/money-fund-income-accrual";
import { accrueWalletMoneyFundIncome } from "@/lib/server/wallet-money-fund-income";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { logger } from "@/lib/logger";

/**
 * POST /api/v1/fund/money-income/accrue
 *
 * 货币基金收益结转（每万份收益 → 增加份额），当前账本内的全部货基账户。
 *
 * 触发模型和存款/债券的自动生息一致：由开机自检（DailyTaskCheck）调用，
 * 没有 OS 后台任务。漏跑几天不会丢收益——服务按「上次结转到哪天」往前补，
 * 首次建仓的账户按年分批把历史补齐（每批 366 天、单次最多 6 批），
 * 同一天重复触发由幂等键挡掉。
 *
 * body 可选：
 *   - `{ accountId }`：只结某一个货基账户（明细页手工触发用）；
 *   - `{ fundCode }`：只结某一只基金（持仓行上的「重算收益结转」按钮用）；
 *   - `{ rebuild: true }`：强制重算——先清掉该（些）基金已有的结转，再从最早一笔交易
 *     逐日重放。改过买入日期之后用它把历史补齐。
 *   - `{ accountId, fromDate: "YYYY-MM-DD", toDate?: "YYYY-MM-DD" }`：重算一段时间
 *     （电子钱包直接挂货基代码的轻量模式）——先删掉区间 `[fromDate, toDate]` 的收益行，
 *     再按当前余额与万份收益重放。`toDate` 省略 = 补到昨天；晚于昨天会被夹回昨天。
 */
export async function POST(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
      fundCode?: unknown;
      rebuild?: unknown;
      fromDate?: unknown;
      toDate?: unknown;
    } | null;
    const accountId = typeof body?.accountId === "string" && body.accountId.trim() ? body.accountId.trim() : undefined;
    const fundCode = typeof body?.fundCode === "string" && body.fundCode.trim() ? body.fundCode.trim() : undefined;
    const rebuild = body?.rebuild === true;
    const fromDateRaw = typeof body?.fromDate === "string" ? body.fromDate.trim() : "";
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromDateRaw) ? fromDateRaw : undefined;
    const toDateRaw = typeof body?.toDate === "string" ? body.toDate.trim() : "";
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(toDateRaw) ? toDateRaw : undefined;
    if (fromDate && toDate && toDate < fromDate) {
      return NextResponse.json(
        { ok: false, code: "MONEY_INCOME_RANGE_INVALID", error: "重算结束日不能早于起始日" },
        { status: 400 },
      );
    }

    // 两套模型各结各的：有关联货基账户的老数据走 fund_transactions，
    // 直接挂代码的钱包（2026-11-19 轻量模型）走自己的流水。互不重叠。
    // 「重算一段时间」只属于轻量模式：老模型是份额体系，按日期删一半会把持仓算坏。
    const result = fromDate
      ? null
      : await accrueMoneyFundIncome({ householdId, fundAccountId: accountId, fundCode, rebuild });
    const walletResult = await accrueWalletMoneyFundIncome({
      householdId,
      walletAccountId: accountId,
      rebuild: fromDate ? false : rebuild,
      rebuildFrom: fromDate,
      rebuildTo: fromDate ? toDate : undefined,
    });
    if (result?.status === "accrued" || walletResult.status === "accrued") revalidateAfterInvestChange();
    return NextResponse.json({ ok: true, data: { ...(result ?? { status: "skipped" }), wallet: walletResult } });
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
