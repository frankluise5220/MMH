import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { softDeleteEntriesByIds, type EntryDeleteLinkedAction } from "@/lib/server/entry-delete";
import { listEntryBusinessDeleteImpacts } from "@/lib/server/entry-business-link";
import { restoreDeletedEntries } from "@/lib/server/entry-restore";

/**
 * Delete / restore transaction records.
 *
 * Delete:
 *   POST { entryIds: string[], checkOnly?: boolean, linkedAction?: "deleteBusiness" | "keepBusiness" }
 *   entryIds must be TxRecord.id
 *   Ordinary entries are soft-deleted.
 *   With checkOnly=true, only reports whether linked business exists without deleting.
 *   If entries link to business details (insurance/fund/wealth/deposit/precious metal) and linkedAction is not passed,
 *   returns { ok:false, needConfirm:true, impacts } for the client to prompt the user.
 *   linkedAction="deleteBusiness" deletes the linked business details too;
 *   linkedAction="keepBusiness" removes only the cash-flow entries and keeps the business details.
 *
 * Restore (undo soft delete):
 *   POST { action: "restore", transactionIds: string[] }
 *   transactionIds must be TxRecord.id
 *
 * Response: { ok: true, message } or { ok: false, error }
 */
export async function POST(req: Request) {
  try {
    const ctx = await getHouseholdScope();
    const { householdId } = ctx;
    const body = await req.json().catch(() => null);
    const action: string | undefined = body?.action;

    if (action === "restore") {
      const transactionIds: string[] | undefined = body?.transactionIds;
      if (!transactionIds || !Array.isArray(transactionIds) || transactionIds.length === 0) {
        return NextResponse.json({ ok: false, code: "MISSING_TRANSACTION_IDS", error: "缺少 transactionIds" }, { status: 400 });
      }
      const { count, accountIds } = await restoreDeletedEntries(ctx, transactionIds);
      // Client-side will handle page refresh
      return NextResponse.json({ ok: true, count, accountIds, message: `已恢复 ${count} 条记录` });
    }

    const entryIds: string[] = body?.entryIds;
    const linkedAction = body?.linkedAction === "deleteBusiness" || body?.linkedAction === "keepBusiness"
      ? body.linkedAction as EntryDeleteLinkedAction
      : undefined;
    const checkOnly = body?.checkOnly === true;

    if (!entryIds || !Array.isArray(entryIds) || entryIds.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_ENTRY_IDS", error: "缺少 entryIds" }, { status: 400 });
    }
    // 「对账」锁定守卫：已对账的记录不可删除，必须先解除对账（点锁标记）。
    const reconciledRows = await prisma.txRecord.findMany({
      where: {
        id: { in: entryIds },
        OR: [{ householdId }, { householdId: null }],
        deletedAt: null,
        reconciledAt: { not: null },
      },
      select: { id: true },
    });
    if (reconciledRows.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "ENTRY_RECONCILED",
          error: `有 ${reconciledRows.length} 条记录已对账锁定，需先解除对账才能删除`,
        },
        { status: 409 },
      );
    }
    const impacts = await listEntryBusinessDeleteImpacts(ctx, entryIds);
    // 存单删除影响（2026-09-15）：lot=buy 的 TxRecord，其到期/取息计划为
    // depm_<buyId>/depi_<buyId>；计划生成的记录不会随存单删除而删除
    // （计划自动 completed、自愈设计），确认弹窗需要向用户提示这一口径。
    const depositBuyRows = await prisma.txRecord.findMany({
      where: { id: { in: entryIds }, deletedAt: null, type: "investment", fundProductType: "deposit", fundSubtype: "buy" },
      select: { id: true },
    });
    const depositLotPlanIds = depositBuyRows.flatMap((row) => [`depm_${row.id}`, `depa_${row.id}`, `depi_${row.id}`]);
    const depositGeneratedRecordCount = depositLotPlanIds.length > 0
      ? await prisma.txRecord.count({ where: { regularInvestPlanId: { in: depositLotPlanIds }, deletedAt: null } })
      : 0;
    if (checkOnly) {
      return NextResponse.json({
        ok: true,
        message: impacts.length > 0 ? "存在关联业务，请选择删除范围" : "可以删除",
        needConfirm: impacts.length > 0,
        impacts,
        depositGeneratedRecordCount,
      });
    }
    if (!linkedAction && impacts.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          code: "DELETE_CONFLICT",
          needConfirm: true,
          error: "这些资金交易关联了业务明细，请确认删除方式",
          impacts,
          depositGeneratedRecordCount,
        },
        { status: 409 },
      );
    }

    const effectiveEntryIds = linkedAction === "deleteBusiness"
      ? Array.from(new Set([
          ...entryIds,
          ...impacts.map((impact) => impact.entryId).filter(Boolean),
          ...impacts.map((impact) => impact.businessEntryId).filter(Boolean),
        ]))
      : entryIds;

    const { deletedCount, keptBusinessCount, deletedEntryIds, removedEntryIds, accountIds } = await softDeleteEntriesByIds(ctx, effectiveEntryIds, undefined, { linkedAction });

    if (deletedCount === 0 && keptBusinessCount === 0) {
      return NextResponse.json(
        { ok: false, code: "RECORDS_NOT_FOUND", error: `未找到匹配的记录 (IDs: ${entryIds.slice(0, 3).join(", ")}${entryIds.length > 3 ? "..." : ""})` },
        { status: 404 }
      );
    }

    // Client-side updates visible rows and derived numbers through finance change events.
    return NextResponse.json({
      ok: true,
      message: keptBusinessCount > 0
        ? `已移除 ${keptBusinessCount} 条资金流水并保留业务明细${deletedCount > 0 ? `，另删除 ${deletedCount} 条记录` : ""}`
        : `已删除 ${deletedCount} 条记录`,
      deletedCount,
      keptBusinessCount,
      deletedEntryIds,
      removedEntryIds,
      accountIds,
    });
  } catch (e) {
    console.error("[delete] Error:", e);
    return NextResponse.json(
      { ok: false, code: "DELETE_FAILED", error: e instanceof Error ? e.message : "删除失败" },
      { status: 500 }
    );
  }
}
