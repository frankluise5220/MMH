/**
 * API: GET /api/v1/accounts/balances
 *
 * 批量返回账户余额
 * 供 SidebarClient 局部刷新使用
 *
 * 查询参数:
 *   ids (required) - 逗号分隔的账户 ID 列表
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { toNumber } from "@/lib/date-utils";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idsRaw = (url.searchParams.get("ids") ?? "").trim();
  if (!idsRaw) {
    return NextResponse.json({ ok: false, error: "缺少 ids 参数" }, { status: 400 });
  }

  const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: "ids 参数无效" }, { status: 400 });
  }

  try {
    const { hidFilter } = await getHouseholdScope();

    const accounts = await prisma.account.findMany({
      where: {
        id: { in: ids },
        ...hidFilter,
      },
      select: {
        id: true,
        balance: true,
        kind: true,
      },
    });

    // 投资账户余额通过 computeInvestBalances 计算，但这里简化处理
    // 只返回 account.balance 字段
    const data = accounts.map((a) => ({
      id: a.id,
      balance: toNumber(a.balance),
      kind: a.kind,
    }));

    return NextResponse.json({ ok: true, data });
  } catch (err) {
    console.error("GET /api/v1/accounts/balances error:", err);
    return NextResponse.json({ ok: false, error: "服务器错误" }, { status: 500 });
  }
}