import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

/** 预览列表单次最多返回的行数（超出时响应带 truncated，总数仍以 total 为准）。 */
const PREVIEW_TAKE = 1000;

/**
 * GET /api/v1/entries/deleted?accountId=<id>
 * 账户管理页「待删」弹窗用：列出该账户名下（accountId 或 toAccountId 命中，
 * 与设置页软删计数同一口径）的软删除记录，按删除时间倒序。
 */
export async function GET(req: Request) {
  const { hidFilter } = await getHouseholdScope();
  const accountId = new URL(req.url).searchParams.get("accountId")?.trim() ?? "";

  if (!accountId) {
    return NextResponse.json(
      { ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少账户参数" },
      { status: 400 },
    );
  }

  const where = {
    deletedAt: { not: null },
    ...hidFilter,
    OR: [{ accountId }, { toAccountId: accountId }],
  };

  const total = await prisma.txRecord.count({ where });
  const records = await prisma.txRecord.findMany({
    where,
    orderBy: [{ deletedAt: "desc" }, { date: "desc" }],
    take: PREVIEW_TAKE,
    select: {
      id: true,
      date: true,
      postedAt: true,
      type: true,
      amount: true,
      currency: true,
      note: true,
      categoryName: true,
      accountId: true,
      accountName: true,
      toAccountId: true,
      toAccountName: true,
      deletedAt: true,
      source: true,
      fundCode: true,
      fundName: true,
      fundSubtype: true,
      metalTypeName: true,
      insuranceProductName: true,
    },
  });

  return NextResponse.json({
    ok: true,
    data: { records, total, truncated: total > records.length },
  });
}
