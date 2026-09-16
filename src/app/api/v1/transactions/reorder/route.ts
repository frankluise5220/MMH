/**
 * POST /api/v1/transactions/reorder
 *
 * Body:
 * - { accountId: string; entryId: string; direction: "up" | "down" }
 * - { accountId: string; entryId: string; targetEntryId: string; targetPosition?: "before" | "after" }
 * - { accountId: string; accountIds: string[]; entryId: string; targetEntryId: string; targetPosition?: "before" | "after" }
 * Response: { ok: true, changed: boolean, orderedEntryIds: string[] } | { ok: false, code, error }
 *
 * Reorders ordinary TxRecord rows within the same displayed local date for one
 * account detail view. It never moves balance anchors; those remain end-of-day
 * records for running balance calculation. Only the target day's rows are
 * loaded (padded date window + same-day wealth arrival links). Running
 * balances are rebased on the already-loaded client list.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { compareDetailEntriesDesc } from "@/lib/detail-entry-order";
import {
  buildReorderDateWindowWhere,
  entryReorderDayKey,
  isReorderBalanceAnchor,
  normalizeSameDayOrders,
  reorderRowsWithinDay,
  rowWithLinkedWealthDisplayDate,
  sameDayUtcWindow,
  type LinkedWealthForReorder,
} from "@/lib/entry-reorder";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterEntryOrderChange } from "@/lib/server/revalidate";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";

export const runtime = "nodejs";

type Direction = "up" | "down";
type TargetPosition = "before" | "after";

type ReorderRow = {
  id: string;
  date: Date;
  postedAt: Date | null;
  createdAt: Date;
  dayOrder: number | null;
  amount: unknown;
  type: string;
  accountId: string | null;
  toAccountId: string | null;
  debtPrincipalAmount: unknown;
  fundSubtype: string | null;
  source: string | null;
  toNote: string | null;
  fundArrivalDate: Date | null;
  fundArrivalAmount: unknown;
};

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: unknown;
      entryId?: unknown;
      accountIds?: unknown;
      direction?: unknown;
      targetEntryId?: unknown;
      targetPosition?: unknown;
    } | null;
    const accountId = String(body?.accountId ?? "").trim();
    const entryId = String(body?.entryId ?? "").trim();
    const targetEntryId = String(body?.targetEntryId ?? "").trim();
    const targetPositionRaw = String(body?.targetPosition ?? "").trim();
    const targetPosition = (targetPositionRaw === "before" || targetPositionRaw === "after" ? targetPositionRaw : "") as TargetPosition | "";
    const direction = String(body?.direction ?? "").trim() as Direction;

    if (!accountId || !entryId || (!targetEntryId && direction !== "up" && direction !== "down")) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "参数不完整" }, { status: 400 });
    }
    const accountIdsRaw = Array.isArray(body?.accountIds) ? body.accountIds : [];
    const scopeAccountIds = Array.from(new Set([
      accountId,
      ...accountIdsRaw.map((id) => String(id ?? "").trim()),
    ].filter(Boolean))).slice(0, 50);

    const { householdId } = await getHouseholdScope();
    const reorderRowSelect = {
      id: true,
      date: true,
      postedAt: true,
      createdAt: true,
      dayOrder: true,
      amount: true,
      type: true,
      accountId: true,
      toAccountId: true,
      debtPrincipalAmount: true,
      fundSubtype: true,
      source: true,
      toNote: true,
      fundArrivalDate: true,
      fundArrivalAmount: true,
    } as const;
    const scopeWhere = txRecordAccountScopeWhere(scopeAccountIds);
    const targetRows = await prisma.txRecord.findMany({
      where: {
        id: entryId,
        deletedAt: null,
        householdId,
        ...scopeWhere,
      },
      select: reorderRowSelect,
      take: 1,
    });
    const target = targetRows[0] ?? null;
    if (!target) {
      return NextResponse.json({ ok: false, code: "ENTRY_NOT_FOUND", error: "记录不存在" }, { status: 404 });
    }
    if (isReorderBalanceAnchor(target)) {
      return NextResponse.json({ ok: false, code: "BALANCE_ANCHOR_NOT_MOVABLE", error: "余额校准记录固定在当天末尾，不能手动移动" }, { status: 400 });
    }

    const targetWealthLinks = await prisma.entryBusinessLink.findMany({
      where: {
        householdId,
        deletedAt: null,
        wealthTransactionId: { not: null },
        OR: [
          { cashEntryId: entryId },
          { businessEntryId: entryId },
        ],
      },
      include: { WealthTransaction: true },
    });
    const linkedWealthByEntryId = new Map<string, LinkedWealthForReorder>();
    for (const link of targetWealthLinks) {
      const wealthRow = link.WealthTransaction;
      if (!wealthRow) continue;
      if (link.cashEntryId) linkedWealthByEntryId.set(link.cashEntryId, wealthRow);
      if (link.businessEntryId) linkedWealthByEntryId.set(link.businessEntryId, wealthRow);
    }
    const targetDay = entryReorderDayKey(
      rowWithLinkedWealthDisplayDate(target, linkedWealthByEntryId.get(target.id) ?? null),
      accountId,
    );
    const { start: wealthStart, endExclusive: wealthEnd } = sameDayUtcWindow(targetDay);
    const [windowRows, wealthArrivalLinks] = await Promise.all([
      prisma.txRecord.findMany({
        where: {
          deletedAt: null,
          householdId,
          AND: [scopeWhere, buildReorderDateWindowWhere(targetDay)],
        },
        select: reorderRowSelect,
      }),
      prisma.entryBusinessLink.findMany({
        where: {
          householdId,
          deletedAt: null,
          wealthTransactionId: { not: null },
          WealthTransaction: {
            deletedAt: null,
            action: { in: ["redeem", "dividend_cash"] },
            arrivalDate: { gte: wealthStart, lt: wealthEnd },
          },
        },
        include: { WealthTransaction: true },
      }),
    ]);
    const extraIds = Array.from(new Set(
      wealthArrivalLinks.flatMap((link) => [link.cashEntryId, link.businessEntryId].filter((id): id is string => !!id)),
    )).filter((id) => id !== target.id && !windowRows.some((row) => row.id === id));
    const extraRows = extraIds.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            id: { in: extraIds },
            deletedAt: null,
            householdId,
            ...scopeWhere,
          },
          select: reorderRowSelect,
        })
      : [];
    const rows = [target, ...windowRows.filter((row) => row.id !== target.id), ...extraRows.filter((row) => row.id !== target.id)];
    const rowIds = rows.map((row) => row.id);
    const wealthLinks = rowIds.length > 0
      ? await prisma.entryBusinessLink.findMany({
          where: {
            householdId,
            deletedAt: null,
            wealthTransactionId: { not: null },
            OR: [
              { cashEntryId: { in: rowIds } },
              { businessEntryId: { in: rowIds } },
            ],
          },
          include: { WealthTransaction: true },
        })
      : [];
    for (const link of [...wealthArrivalLinks, ...wealthLinks]) {
      const wealthRow = link.WealthTransaction;
      if (!wealthRow) continue;
      if (link.cashEntryId) linkedWealthByEntryId.set(link.cashEntryId, wealthRow);
      if (link.businessEntryId) linkedWealthByEntryId.set(link.businessEntryId, wealthRow);
    }
    const displayRowOf = (row: ReorderRow) => rowWithLinkedWealthDisplayDate(row, linkedWealthByEntryId.get(row.id) ?? null);
    const sameDayRows = rows
      .filter((row) => entryReorderDayKey(displayRowOf(row), accountId) === targetDay)
      .filter((row) => !isReorderBalanceAnchor(row))
      .sort((a, b) => compareDetailEntriesDesc(displayRowOf(a), displayRowOf(b), accountId));

    const reordered = reorderRowsWithinDay(
      sameDayRows,
      entryId,
      targetEntryId ? { targetEntryId, targetPosition } : undefined,
      direction,
    );
    if ("error" in reordered) {
      const message = reordered.error === "REORDER_WITHIN_DAY_ONLY"
        ? "只能在同一天记录内调整顺序"
        : reordered.error === "TARGET_ENTRY_NOT_FOUND"
          ? "目标记录不存在"
          : "记录不在当前账户的同日列表中";
      return NextResponse.json({ ok: false, code: reordered.error, error: message }, { status: 400 });
    }
    if (!reordered.changed) {
      return NextResponse.json({ ok: true, changed: false, orderedEntryIds: sameDayRows.map((row) => row.id) });
    }

    const reorderedRows = reordered.rows;
    const normalizedOrders = normalizeSameDayOrders(reorderedRows);

    await prisma.$transaction(async (tx) => {
      for (const row of sameDayRows) {
        await tx.txRecord.updateMany({
          where: { id: row.id, householdId },
          data: { dayOrder: normalizedOrders.get(row.id) ?? 0 },
        });
      }
    });

    revalidateAfterEntryOrderChange();

    return NextResponse.json({ ok: true, changed: true, orderedEntryIds: reorderedRows.map((row) => row.id) });
  } catch (error) {
    console.error("POST /api/v1/transactions/reorder error:", error);
    const message = error instanceof Error ? error.message : "调整顺序失败";
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: message || "调整顺序失败" }, { status: 500 });
  }
}
