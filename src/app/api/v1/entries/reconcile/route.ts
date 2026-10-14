/**
 * POST /api/v1/entries/reconcile
 *
 * Body: { entryIds: string[]; action?: "lock" | "unlock"; contextAccountId?: string }
 * Response: { ok: true, action, count, accountIds } | { ok: false, code, error }
 *
 * 「对账」= 给选中的流水加锁：
 *   1) `reconciledAt` 非空 → 该记录不可删除、不可修改（编辑窗只读）；
 *   2) `reconciledBalance` 钉住「对账当时这一行的事后余额」，余额折叠把它当锚点用
 *      （与「余额校准」同一套语义），因此它之前流水的变化不再影响它及之后的行。
 *
 * `action="unlock"`（点锁标记解除对账）只清这两列；余额随之恢复由流水现算。
 *
 * 余额口径复用明细页的逐笔余额 SQL（`queryDetailRunningBalancesForEntries`），
 * 保证写进库的锚点值与列表上显示的值逐分一致。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { queryDetailRunningBalancesForEntries } from "@/lib/server/detail-page-query";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const BodySchema = z.object({
  entryIds: z.array(z.string().min(1)).min(1),
  action: z.enum(["lock", "unlock"]).optional(),
  /** 当前明细页账户（单账户明细视图）。多账户视图下缺省按每行自己的账户口径算。 */
  contextAccountId: z.string().optional(),
});

function money(value: number) {
  return Number(value.toFixed(2));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "VALIDATION_FAILED", error: "参数格式不正确" }, { status: 400 });
  }

  const action = parsed.data.action ?? "lock";
  const { hidFilter } = await getHouseholdScope();
  const householdId = hidFilter.householdId;
  const requestedIds = Array.from(new Set(parsed.data.entryIds.map((id) => id.trim()).filter(Boolean)));

  const entries = await prisma.txRecord.findMany({
    where: { id: { in: requestedIds }, householdId, deletedAt: null },
    select: { id: true, accountId: true, toAccountId: true, reconciledAt: true },
  });
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, code: "ENTRY_NOT_FOUND", error: "没有找到可对账的记录" }, { status: 404 });
  }

  const affectedAccountIds = new Set<string>();
  for (const entry of entries) {
    if (entry.accountId) affectedAccountIds.add(entry.accountId);
    if (entry.toAccountId) affectedAccountIds.add(entry.toAccountId);
  }

  if (action === "unlock") {
    const result = await prisma.txRecord.updateMany({
      where: { id: { in: entries.map((entry) => entry.id) }, householdId },
      data: { reconciledAt: null, reconciledBalance: null },
    });
    for (const accountId of affectedAccountIds) {
      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    }
    revalidateAfterTxChange();
    return NextResponse.json({
      ok: true,
      action,
      count: result.count,
      accountIds: Array.from(affectedAccountIds),
    });
  }

  // 已经对账过的行保持原锚点，不重复计算（幂等）。
  const targets = entries.filter((entry) => entry.reconciledAt == null);
  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      action,
      count: 0,
      accountIds: Array.from(affectedAccountIds),
    });
  }

  // 按「明细视图账户」分组：单账户明细视图用 contextAccountId（转入腿也归它），
  // 其余（多账户 / 无上下文）退回每行自己的账户。
  const viewAccountIdOf = (entry: { accountId: string; toAccountId: string | null }) => {
    const context = parsed.data.contextAccountId;
    if (context && (entry.accountId === context || entry.toAccountId === context)) return context;
    return entry.accountId;
  };
  const byAccount = new Map<string, string[]>();
  for (const entry of targets) {
    const accountId = viewAccountIdOf(entry);
    const bucket = byAccount.get(accountId);
    if (bucket) bucket.push(entry.id);
    else byAccount.set(accountId, [entry.id]);
  }

  const balanceById = new Map<string, number>();
  for (const [accountId, entryIds] of byAccount) {
    const balances = await queryDetailRunningBalancesForEntries({
      accountIds: [accountId],
      householdId,
      entryIds,
      sortAccountId: accountId,
    });
    for (const [entryId, value] of Object.entries(balances)) balanceById.set(entryId, value);
  }

  const missing = targets.filter((entry) => !balanceById.has(entry.id));
  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "RECONCILE_BALANCE_UNAVAILABLE",
        error: "有记录算不出「本行余额」（多为入账日在今天之后的流水），无法对账",
      },
      { status: 409 },
    );
  }

  const reconciledAt = new Date();
  for (const entry of targets) {
    await prisma.txRecord.update({
      where: { id: entry.id },
      data: {
        reconciledAt,
        reconciledBalance: money(toNumber(balanceById.get(entry.id))),
      },
    });
  }

  for (const accountId of affectedAccountIds) {
    await recalcAndSaveAccountBalance(accountId).catch(() => {});
  }
  revalidateAfterTxChange();

  return NextResponse.json({
    ok: true,
    action,
    count: targets.length,
    accountIds: Array.from(affectedAccountIds),
  });
}
