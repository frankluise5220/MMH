/**
 * POST /api/v1/transactions/reorder
 *
 * Body:
 * - { accountId: string; entryId: string; direction: "up" | "down" }
 * - { accountId: string; entryId: string; targetEntryId: string; targetPosition?: "before" | "after" }
 * Response: { ok: true, changed: boolean, orderedEntryIds: string[] } | { ok: false, error }
 *
 * Reorders ordinary TxRecord rows within the same displayed local date for one
 * account detail view. It never moves balance anchors; those remain end-of-day
 * records for running balance calculation.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

type Direction = "up" | "down";
type TargetPosition = "before" | "after";

type ReorderRow = {
  id: string;
  date: Date;
  createdAt: Date;
  dayOrder: number | null;
  type: string;
  accountId: string | null;
  toAccountId: string | null;
  fundSubtype: string | null;
  source: string | null;
  toNote: string | null;
  fundArrivalDate: Date | null;
};

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isBalanceAnchor(entry: { source?: string | null; toNote?: string | null }) {
  const source = String(entry.source ?? "");
  if (source !== BALANCE_RECONCILE_SOURCE && source !== BALANCE_INITIALIZATION_SOURCE) return false;
  return getBalanceReconcileTarget(entry) != null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: unknown;
      entryId?: unknown;
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
      return NextResponse.json({ ok: false, error: "参数不完整" }, { status: 400 });
    }

    const { householdId } = await getHouseholdScope();
    const targetRows = await prisma.$queryRaw<ReorderRow[]>`
      SELECT
        id,
        date,
        "createdAt",
        "dayOrder",
        type::text AS type,
        "accountId",
        "toAccountId",
        "fundSubtype"::text AS "fundSubtype",
        source,
        "toNote",
        "fundArrivalDate"
      FROM transactions
      WHERE id = ${entryId}
        AND "deletedAt" IS NULL
        AND "householdId" = ${householdId}
        AND ("accountId" = ${accountId} OR "toAccountId" = ${accountId})
      LIMIT 1
    `;
    const target = targetRows[0] ?? null;
    if (!target) {
      return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });
    }
    if (isBalanceAnchor(target)) {
      return NextResponse.json({ ok: false, error: "余额校准记录固定在当天末尾，不能手动移动" }, { status: 400 });
    }

    const rows = await prisma.$queryRaw<ReorderRow[]>`
      SELECT
        id,
        date,
        "createdAt",
        "dayOrder",
        type::text AS type,
        "accountId",
        "toAccountId",
        "fundSubtype"::text AS "fundSubtype",
        source,
        "toNote",
        "fundArrivalDate"
      FROM transactions
      WHERE "deletedAt" IS NULL
        AND "householdId" = ${householdId}
        AND ("accountId" = ${accountId} OR "toAccountId" = ${accountId})
    `;

    const targetDay = localDateKey(getDetailEntryDisplayDate(target, accountId));
    const sameDayRows = rows
      .filter((row) => localDateKey(getDetailEntryDisplayDate(row, accountId)) === targetDay)
      .filter((row) => !isBalanceAnchor(row))
      .sort((a, b) => compareDetailEntriesDesc(a, b, accountId));

    const currentIndex = sameDayRows.findIndex((row) => row.id === entryId);
    if (currentIndex < 0) {
      return NextResponse.json({ ok: false, error: "记录不在当前账户的同日列表中" }, { status: 400 });
    }

    let reorderedRows = [...sameDayRows];
    if (targetEntryId) {
      const targetIndex = sameDayRows.findIndex((row) => row.id === targetEntryId);
      if (targetIndex < 0) {
        return NextResponse.json({ ok: false, error: "只能在同一天记录内调整顺序" }, { status: 400 });
      }
      if (targetIndex === currentIndex) {
        return NextResponse.json({ ok: true, changed: false, orderedEntryIds: sameDayRows.map((row) => row.id) });
      }
      const position = targetPosition || (currentIndex < targetIndex ? "after" : "before");
      const [moving] = reorderedRows.splice(currentIndex, 1);
      const targetIndexAfterRemoval = reorderedRows.findIndex((row) => row.id === targetEntryId);
      if (targetIndexAfterRemoval < 0) {
        return NextResponse.json({ ok: false, error: "目标记录不存在" }, { status: 400 });
      }
      reorderedRows.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
    } else {
      const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      const neighbor = sameDayRows[nextIndex];
      if (!neighbor) {
        return NextResponse.json({ ok: true, changed: false, orderedEntryIds: sameDayRows.map((row) => row.id) });
      }
      [reorderedRows[currentIndex], reorderedRows[nextIndex]] = [reorderedRows[nextIndex], reorderedRows[currentIndex]];
    }

    const normalizedOrders = new Map<string, number>();
    const step = 1000;
    for (let index = 0; index < reorderedRows.length; index += 1) {
      normalizedOrders.set(reorderedRows[index].id, (reorderedRows.length - index) * step);
    }

    await prisma.$transaction(async (tx) => {
      for (const row of sameDayRows) {
        await tx.$executeRaw`
          UPDATE transactions
          SET "dayOrder" = ${normalizedOrders.get(row.id) ?? 0}, "updatedAt" = now()
          WHERE id = ${row.id}
            AND "householdId" = ${householdId}
        `;
      }
    });

    const accountIds = new Set<string>([accountId]);
    for (const row of sameDayRows) {
      if (row.accountId) accountIds.add(row.accountId);
      if (row.toAccountId) accountIds.add(row.toAccountId);
    }
    for (const id of accountIds) {
      await recalcAndSaveAccountBalance(id).catch(() => {});
    }
    revalidateAfterTxChange();

    return NextResponse.json({ ok: true, changed: true, orderedEntryIds: reorderedRows.map((row) => row.id) });
  } catch (error) {
    console.error("POST /api/v1/transactions/reorder error:", error);
    const message = error instanceof Error ? error.message : "调整顺序失败";
    return NextResponse.json({ ok: false, error: message || "调整顺序失败" }, { status: 500 });
  }
}
