import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

/** 单次请求最多彻底删除的记录条数（账户管理页「待删」精选删除）。 */
const MAX_PURGE_IDS = 500;

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

type PurgeCoreResult = {
  permanentlyDeleted: number;
  fundAccountsToRecalc: Map<string, string[]>;
  metalAccountsToRecalc: Set<string>;
};

/**
 * 彻底删除「已软删除」的 TxRecord 及其关联行（回收站清理语义）：
 * - 只删「属于该账本且 deletedAt 非空」的记录（入参与实际删除取交集，去重）；
 * - 关联业务行（基金/保险/理财/存款/贵金属/股票/固定资产，经 cashEntryId 关联）只在
 *   自身也已软删时才一并硬删——「移除资金流水但保留业务明细」场景下的在用业务行
 *   必须保留（其 cashEntryId 悬空为普通文本列，无外键约束，无碍）；
 * - EntryTag / Attachment 为硬外键级联，显式删除只为统计准确；
 * - EntryBusinessLink（SetNull）、FxConversion（Cascade）、分期计划源记录（Cascade）
 *   由数据库级联处理；在用的关联行 cashEntryId 会被 FK 自动置空。
 */
async function purgeSoftDeletedTxRecords(
  householdId: string,
  requestedIds: string[],
): Promise<PurgeCoreResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.txRecord.findMany({
      where: { id: { in: requestedIds }, deletedAt: { not: null }, householdId },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        fundCode: true,
        fundSubtype: true,
        fundProductType: true,
        metalTypeId: true,
      },
    });

    const purgedIds = Array.from(new Set(rows.map((row) => row.id)));
    const fundAccountsToRecalc = new Map<string, string[]>();
    const metalAccountsToRecalc = new Set<string>();

    if (purgedIds.length === 0) {
      return { permanentlyDeleted: 0, fundAccountsToRecalc, metalAccountsToRecalc };
    }

    // 收集基金/贵金属持仓重算目标（买：accountId=资金、toAccountId=投资；赎回相反）
    for (const row of rows) {
      const isRedeemLike = row.fundSubtype === "redeem" || row.fundSubtype === "switch_out";
      const investmentAccId = isRedeemLike ? row.accountId : row.toAccountId;
      if ((row.metalTypeId || row.fundProductType === "metal") && investmentAccId) {
        metalAccountsToRecalc.add(investmentAccId);
      } else if (row.fundCode && row.fundProductType && investmentAccId) {
        const codes = fundAccountsToRecalc.get(investmentAccId) ?? [];
        if (!codes.includes(row.fundCode)) {
          codes.push(row.fundCode);
          fundAccountsToRecalc.set(investmentAccId, codes);
        }
      }
    }

    // 关联业务行：cashEntryId 无外键，必须显式清理；只清已软删的（在用的不动）。
    const cashLinkWhere = { cashEntryId: { in: purgedIds }, deletedAt: { not: null } } as const;
    await tx.fundTransaction.deleteMany({ where: cashLinkWhere });
    await tx.insuranceTransaction.deleteMany({ where: cashLinkWhere });
    await tx.wealthTransaction.deleteMany({ where: cashLinkWhere });
    await tx.depositTransaction.deleteMany({ where: cashLinkWhere });
    await tx.preciousMetalTransaction.deleteMany({ where: cashLinkWhere });
    await tx.stockTransaction.deleteMany({ where: cashLinkWhere });
    await tx.propertyTransaction.deleteMany({ where: cashLinkWhere });

    // 基金资金流镜像行：所属业务单已软删（或已不存在）时一并清理；在用业务单保留。
    await tx.fundTransactionCashFlow.deleteMany({
      where: { txRecordId: { in: purgedIds }, FundTransaction: { deletedAt: { not: null } } },
    });

    // 软删态的业务关联行一并清掉，避免残留指向已物理删除记录的垃圾行。
    await tx.entryBusinessLink.deleteMany({
      where: {
        deletedAt: { not: null },
        OR: [{ cashEntryId: { in: purgedIds } }, { businessEntryId: { in: purgedIds } }],
      },
    });

    await tx.entryTag.deleteMany({ where: { entryId: { in: purgedIds } } });
    await tx.attachment.deleteMany({ where: { entryId: { in: purgedIds } } });

    const deleted = await tx.txRecord.deleteMany({
      where: { id: { in: purgedIds }, deletedAt: { not: null } },
    });

    return { permanentlyDeleted: deleted.count, fundAccountsToRecalc, metalAccountsToRecalc };
  });
}

export async function POST(req: Request) {
  const { hidFilter } = await getHouseholdScope();
  const body = await req.json().catch(() => null) as { days?: unknown; ids?: unknown } | null;

  // 方式一：按 ids 精选彻底删除（账户管理页「待删」弹窗，全选/逐条均走此通道）。
  if (Array.isArray(body?.ids)) {
    const ids = (body.ids as unknown[])
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    if (ids.length === 0) {
      return NextResponse.json(
        { ok: false, code: "INVALID_IDS", error: "没有可彻底删除的记录" },
        { status: 400, headers: corsHeaders() },
      );
    }
    if (ids.length > MAX_PURGE_IDS) {
      return NextResponse.json(
        { ok: false, code: "TOO_MANY_IDS", error: `单次最多彻底删除 ${MAX_PURGE_IDS} 条记录` },
        { status: 400, headers: corsHeaders() },
      );
    }
    const result = await purgeSoftDeletedTxRecords(hidFilter.householdId, ids);
    return NextResponse.json(
      {
        ok: true,
        permanentlyDeleted: result.permanentlyDeleted,
        message: `已彻底删除 ${result.permanentlyDeleted} 条回收站记录`,
      },
      { headers: corsHeaders() },
    );
  }

  // 方式二：按天数批量清理软删超过 N 天的记录（外部自动化按 API Key 调用）。
  const days = typeof body?.days === "number" ? body.days : 30;

  if (days < 1 || days > 365) {
    return NextResponse.json(
      { ok: false, code: "INVALID_DAYS", error: "天数必须在 1-365 之间" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);

  const stale = await prisma.txRecord.findMany({
    where: { deletedAt: { not: null, lte: cutoff }, ...hidFilter },
    select: { id: true },
  });
  const staleIds = stale.map((row) => row.id);
  const result = staleIds.length > 0
    ? await purgeSoftDeletedTxRecords(hidFilter.householdId, staleIds)
    : { permanentlyDeleted: 0, fundAccountsToRecalc: new Map<string, string[]>(), metalAccountsToRecalc: new Set<string>() };

  // Re-aggregate positions (outside the transaction)
  for (const [accountId, fundCodes] of result.fundAccountsToRecalc) {
    await recalcFundPositions(accountId, fundCodes).catch(logger.catchLog("操作失败", "route.ts"));
  }
  for (const accountId of result.metalAccountsToRecalc) {
    await recalcPreciousMetalPositions(accountId).catch(logger.catchLog("操作失败", "route.ts"));
  }

  return NextResponse.json(
    {
      ok: true,
      permanentlyDeleted: result.permanentlyDeleted,
      message: `已彻底删除 ${result.permanentlyDeleted} 条超过 ${days} 天的回收站记录`,
    },
    { headers: corsHeaders() },
  );
}
