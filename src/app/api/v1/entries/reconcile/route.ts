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
import { revalidateAfterEntryOrderChange } from "@/lib/server/revalidate";

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

/**
 * 账户余额重算放后台，不挂在响应上。
 *
 * 锁定 / 解锁只写 `reconciledAt` / `reconciledBalance`，没有任何一笔流水的金额、
 * 账户、日期发生变化，所以账户余额的计算结果必然不变（写进去的锚点值本身就是
 * 当时现算的事后余额）。这里还同步重算纯属浪费：实测 6366 行的账户多花 0.4~0.6s，
 * 3100 行那个账户 1.7s（写入锚点后改为「从锚点往后折叠」，反而更慢），用户点了锁
 * 就干等着。丢到后台只是顺手校正历史脏值，失败也不影响本次操作。
 */
function recalcInBackground(accountIds: Set<string>) {
  if (accountIds.size === 0) return;
  void Promise.all(
    Array.from(accountIds).map((accountId) => recalcAndSaveAccountBalance(accountId).catch(() => undefined)),
  );
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
    recalcInBackground(affectedAccountIds);
    // 只失效 tag，不 purge 任何路由：明细页正是路由 "/overview"，purge 它等于让 dev
    // 在响应期间同步重渲染整个首页（实测 unlock 一条要 7.9 秒）。行集合 / 余额都没变，
    // 锁标记由客户端按回传的两列就地补，导航到别的页面时 tag 已失效，拿到的一定是新值。
    revalidateAfterEntryOrderChange();
    return NextResponse.json({
      ok: true,
      action,
      count: result.count,
      accountIds: Array.from(affectedAccountIds),
      // 落库后的两列原样回传：明细页据此就地改行（锁标记 / 锚点），
      // 不必为了两个字段重拉整页乃至整份（「全部」视图是 5 万行）。
      records: entries.map((entry) => ({ id: entry.id, reconciledAt: null, reconciledBalance: null })),
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
      records: [],
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
  const records: Array<{ id: string; reconciledAt: string | null; reconciledBalance: number | null }> = [];
  // 一次事务提交：以前是 N 条 update 各自自动提交，选中几十行时光等待 fsync / 往返
  // 就够转好几秒。行数不变、值不同，Prisma 的批量 update 表达不了，用事务数组包住。
  const updates = targets.map((entry) => {
    const reconciledBalance = money(toNumber(balanceById.get(entry.id)));
    records.push({ id: entry.id, reconciledAt: reconciledAt.toISOString(), reconciledBalance });
    return prisma.txRecord.update({
      where: { id: entry.id },
      data: { reconciledAt, reconciledBalance },
    });
  });
  if (updates.length > 0) await prisma.$transaction(updates);

  recalcInBackground(affectedAccountIds);
  // 同 unlock：只失效 tag。`revalidatePath("/overview")` 就是明细页自己，
  // purge 它会让响应多等一次整页重渲染（实测 2.6s → 8s 不等）。
  revalidateAfterEntryOrderChange();

  return NextResponse.json({
    ok: true,
    action,
    count: targets.length,
    accountIds: Array.from(affectedAccountIds),
    records,
  });
}
