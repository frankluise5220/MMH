import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
  CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
} from "@/lib/credit/billing";

/**
 * 信用卡账单 cycle 缓存失效。
 *
 * 这里以前是「只删不建」：任何一笔涉及信用卡的记账都会把该卡的全部 cycle 行删掉，
 * 于是侧边栏 / 账户列表 / 概览 / 余额接口读到空表，信用卡余额退化成 0
 * （bank_credit 的 `account.balance` 恒为 0），而账单页会实时重算并写回 ——
 * 同一天、同一张卡，账单页有金额、左侧却是 ¥0.00，且要等到有人访问账单页才恢复。
 *
 * 现在删完立刻按账单口径重建，保证「记账完成」这一刻缓存就是可读的。
 * `rebuild: false` 供重建流程自己调用（它接下来就会整体重算），避免递归。
 */
export async function invalidateCreditCardCycleCacheForAccountIds(
  accountIds: Iterable<string | null | undefined>,
  options: { deleteManualCycles?: boolean; rebuild?: boolean } = {},
) {
  const ids = Array.from(new Set(Array.from(accountIds).filter((id): id is string => !!id)));
  if (ids.length === 0) return 0;

  const billAccounts = await prisma.account.findMany({
    where: {
      id: { in: ids },
      kind: { in: [AccountKind.bank_credit, AccountKind.loan] },
      OR: [
        { kind: AccountKind.bank_credit },
        { billingDay: { not: null } },
      ],
    },
    select: { id: true, householdId: true },
  });
  if (billAccounts.length === 0) return 0;

  const result = await prisma.creditCardCycle.deleteMany({
    where: {
      accountId: { in: billAccounts.map((account) => account.id) },
      ...(options.deleteManualCycles
        ? {}
        : {
            OR: [
              { lockSource: null },
              {
                AND: [
                  { NOT: { lockSource: { contains: CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE } } },
                  { NOT: { lockSource: { contains: CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE } } },
                ],
              },
            ],
          }),
    },
  });

  if (options.rebuild !== false) {
    const accountIdsByHousehold = new Map<string, string[]>();
    for (const account of billAccounts) {
      const list = accountIdsByHousehold.get(account.householdId) ?? [];
      list.push(account.id);
      accountIdsByHousehold.set(account.householdId, list);
    }
    // 动态 import：credit-bill-page-data 静态依赖本模块，静态反向引用会成环。
    const { refreshCreditCardCycleCachesForAccountIds } = await import("@/lib/server/credit-bill-page-data");
    for (const [householdId, householdAccountIds] of accountIdsByHousehold) {
      await refreshCreditCardCycleCachesForAccountIds({ householdId, accountIds: householdAccountIds }).catch(() => 0);
    }
  }

  return result.count;
}
