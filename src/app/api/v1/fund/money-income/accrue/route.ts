import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import { accrueMoneyFundIncome, previewMoneyFundRebuildWindow } from "@/lib/server/money-fund-income-accrual";
import { accrueWalletMoneyFundIncome } from "@/lib/server/wallet-money-fund-income";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { logger } from "@/lib/logger";

/**
 * GET /api/v1/fund/money-income/accrue?accountId=…&fundCode=…
 *
 * 重算前的只读预览：这只货基能算的历史有多长（起点 / 终点 / 天数 / 需要点几次）。
 * 界面用它决定要不要先弹「超过一年」的提示——重算一次只算一年，时间太久的基金
 * 更适合直接按当前份额手工记一笔买入。不写任何数据。
 */
export async function GET(request: Request) {
  try {
    // 只为拿登录 / 账本作用域（未登录会抛），预览本身只按账户 + 基金代码查。
    await getHouseholdScope();
    const url = new URL(request.url);
    const accountId = (url.searchParams.get("accountId") ?? "").trim();
    const fundCode = (url.searchParams.get("fundCode") ?? "").trim();
    if (!accountId || !fundCode) {
      return NextResponse.json(
        { ok: false, code: "MONEY_INCOME_PREVIEW_INVALID", error: "缺少账户或基金代码" },
        { status: 400 },
      );
    }
    const preview = await previewMoneyFundRebuildWindow({ fundAccountId: accountId, fundCode });
    return NextResponse.json({ ok: true, data: preview });
  } catch (error) {
    logger.error("Money fund rebuild preview failed", "money-fund-income", error);
    return NextResponse.json(
      { ok: false, code: "MONEY_INCOME_PREVIEW_FAILED", error: error instanceof Error ? error.message : "查询失败" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/fund/money-income/accrue
 *
 * 货币基金收益结转（每万份收益 → 增加份额），当前账本内的全部货基账户。
 *
 * 触发模型和存款/债券的自动生息一致：由开机自检（DailyTaskCheck）调用，
 * 没有 OS 后台任务。漏跑几天不会丢收益——服务按「上次结转到哪天」往前补
 * （每批 366 天、单次最多 6 批），同一天重复触发由幂等键挡掉。
 *
 * 自动结转（开机自检、后台任务）**不回补历史**：只从这只货基第一次被录进系统那天起
 * 逐日往下结（钱包模式按绑定记录的创建时间，份额模式按流水的 createdAt）。
 * 要历史收益必须由用户点「重算」，而且每点一次只跑一年（`maxBatches = 1`），
 * 算完由界面弹窗提示「已重算到哪天」，用户再点一次接着跑。
 *
 * body 可选：
 *   - `{ accountId }`：只结某一个货基账户（明细页手工触发用）；
 *   - `{ fundCode }`：只结某一只基金（持仓行上的「重算收益结转」按钮用）；
 *   - `{ rebuild: true }`：强制重算——先清掉该（些）基金已有的结转，再从最早一笔交易
 *     逐日重放（一次一年）。改过买入日期之后用它把历史补齐。
 *   - `{ accountId, fromDate: "YYYY-MM-DD", toDate?: "YYYY-MM-DD" }`：重算一段时间
 *     （两种模式都支持）——先删掉区间 `[fromDate, min(toDate, fromDate+一年)]` 的收益行，
 *     再重放这一年。`toDate` 省略 = 补到昨天；晚于昨天会被夹回昨天。
 *     返回的 `toDate` 是实际算到的最后一天、`truncated` 表示还没算完，用户再点一次
 *     把 `fromDate` 换成 `toDate + 1` 即可续算。
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
    // 两边都支持「重算一段」：删除与重放严格限定在同一段里（一次最多一年），
    // 续算由界面把上一次的 toDate + 1 当新的起点，不会出现「删了七年只结一年」。
    const result = await accrueMoneyFundIncome({
      householdId,
      fundAccountId: accountId,
      fundCode,
      rebuild,
      rebuildFrom: fromDate,
      rebuildTo: fromDate ? toDate : undefined,
      maxBatches: rebuild || fromDate ? 1 : undefined,
    });
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
