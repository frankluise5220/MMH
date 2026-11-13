import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { resolveHouseholdTimeZone } from "@/lib/server/business-time-zone";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { metalPriceDateToUtc, queryMetalLatestUnitPrice } from "@/lib/metal/price";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

async function assertMetalAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: "investment", investProductType: "metal" },
    select: { id: true },
  });
  if (!account) throw new Error("贵金属账户不存在或不属于当前账簿");
  return account;
}

/**
 * POST /api/v1/precious-metals/prices/refresh
 *
 * 拉取贵金属账户里每个持仓品种的最新行情，写回 PreciousMetalHolding 的
 * latestPrice / latestPriceDate / priceSource，并同步重算 marketValue。
 *
 * Body: { accountId }
 * Response: { ok, data: { accountId, refreshed, failed, prices, message } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as { accountId?: unknown } | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) {
      return NextResponse.json({ ok: false, error: "缺少贵金属账户" }, { status: 400, headers: corsHeaders() });
    }
    await assertMetalAccount(accountId, householdId);

    const timeZone = await resolveHouseholdTimeZone(householdId);
    const holdings = await prisma.preciousMetalHolding.findMany({
      where: { householdId, accountId, quantity: { gt: 0 } },
      include: {
        PreciousMetalType: { select: { code: true, name: true } },
        PreciousMetalUnit: { select: { code: true, name: true } },
      },
      orderBy: [{ metalTypeId: "asc" }, { metalUnitId: "asc" }],
    });

    const prices: Array<{
      metalTypeId: string;
      metalUnitId: string;
      metalName: string;
      unitName: string;
      price: number;
      priceDate: string;
      source: string;
      quoteLabel: string;
    }> = [];
    const failed: Array<{ metalTypeId: string; metalUnitId: string; name: string; error: string }> = [];

    for (const holding of holdings) {
      const metalName = holding.PreciousMetalType?.name ?? holding.metalTypeName;
      const unitName = holding.PreciousMetalUnit?.name ?? holding.metalUnitName;
      const label = `${metalName} · ${unitName}`;
      const quote = await queryMetalLatestUnitPrice({
        metalCode: holding.PreciousMetalType?.code ?? null,
        metalName: holding.PreciousMetalType?.name ?? holding.metalTypeName,
        unitCode: holding.PreciousMetalUnit?.code ?? null,
        timeZone,
      });
      if (!quote) {
        failed.push({
          metalTypeId: holding.metalTypeId,
          metalUnitId: holding.metalUnitId,
          name: label,
          error: "暂无可用的自动行情（目前支持黄金、白银、铂金、钯金）",
        });
        continue;
      }
      const priceDate = metalPriceDateToUtc(quote.priceDate);
      if (!priceDate) {
        failed.push({
          metalTypeId: holding.metalTypeId,
          metalUnitId: holding.metalUnitId,
          name: label,
          error: "行情日期无效",
        });
        continue;
      }

      const quantity = toNumber(holding.quantity);
      await prisma.preciousMetalHolding.update({
        where: { id: holding.id },
        data: {
          latestPrice: String(quote.price),
          latestPriceDate: priceDate,
          priceSource: quote.source,
          marketValue: String(Math.round(quantity * quote.price * 100) / 100),
        },
      });
      prices.push({
        metalTypeId: holding.metalTypeId,
        metalUnitId: holding.metalUnitId,
        metalName,
        unitName,
        price: quote.price,
        priceDate: quote.priceDate,
        source: quote.source,
        quoteLabel: quote.quoteLabel,
      });
    }

    if (prices.length > 0) revalidateAfterInvestChange();

    const message = prices.length === 0
      ? (failed.length > 0 ? "未获取到任何贵金属行情" : "当前没有需要刷新的贵金属持仓")
      : (failed.length > 0
        ? `已更新 ${prices.length} 个品种，${failed.length} 个品种未获取到行情`
        : `已更新 ${prices.length} 个品种的最新价格`);

    return NextResponse.json({
      ok: true,
      data: {
        accountId,
        refreshed: prices.length,
        failed,
        prices,
        message,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "获取贵金属行情失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
