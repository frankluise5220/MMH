/**
 * API: /api/v1/bill/recalc
 *
 * POST JSON body: { accountId: string }
 *
 * 强制重算一张信用卡（含合并账单组）的全部账单周期，并写回 CreditCardCycle。
 *
 * 为什么需要这个接口：账单页在打开 / 切换账单月时只读周期缓存，不再按「今天
 * 还没算过」自动重算（那是把该卡 138~157 期全量汇总 + 逐期 upsert 一遍，
 * 打开页面就卡住）。日常重算由记账写入后的
 * `invalidateCreditCardCycleCacheForAccountIds` 完成；这个接口给用户一个
 * 手动兜底：导入对账单、批量改历史流水、或怀疑缓存不对时，点一下即可。
 */
import { NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { refreshCreditCardCycleCachesForAccountIds } from "@/lib/server/credit-bill-page-data";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT", error: "缺少账户" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });
    }

    const refreshed = await refreshCreditCardCycleCachesForAccountIds({
      householdId,
      accountIds: [account.id],
      // 手动重算：全锁卡也跑一遍刷新还款进度，但锁定的金额/账期保持不动。
      forceLocked: true,
    });
    // 只失效 tag，不 purge 首页：客户端拿到响应后自己 refresh 当前路由，
    // 避免「点重算 = 整页重渲染」。
    revalidateAfterTxChange({ skipHomePath: true });

    return NextResponse.json({ ok: true, data: { refreshed } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: "RECALC_FAILED",
      error: error instanceof Error ? error.message : "重算账单失败",
    }, { status: 500 });
  }
}
