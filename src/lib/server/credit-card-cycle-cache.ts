import { AccountKind, Prisma } from "@prisma/client";
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
 *
 * 两类「不必重算」的精细化（2026-11-24）：
 * 1. 编辑流水只改了备注/分类/标签/往来对象 —— 账单相关字段没变，传 `billImpact`
 *    即可直接跳过；重算 140+ 期只为了让结果和原来一模一样是纯浪费。
 * 2. 账单被锁定（手工改账期 manual_cycle / 对账单导入 statement_import）—— 锁定的
 *    期是外部事实，重算不会也不该改它；整卡全锁时连重建都跳过。
 */

/** 一笔流水里会改变信用卡账单口径的字段（改其它字段不影响账单金额/账期）。 */
export const CREDIT_BILL_IMPACT_SELECT = {
  date: true,
  postedAt: true,
  type: true,
  amount: true,
  accountId: true,
  toAccountId: true,
  statementMonth: true,
  source: true,
  fundSubtype: true,
  fundProductType: true,
} satisfies Prisma.TxRecordSelect;

export type CreditBillImpactSnapshot = {
  date: Date | string | null;
  postedAt: Date | string | null;
  type: string | null;
  amount: unknown;
  accountId: string | null;
  toAccountId: string | null;
  statementMonth?: string | null;
  source?: string | null;
  fundSubtype?: string | null;
  fundProductType?: string | null;
};

function impactDayKey(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function impactAmount(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

/**
 * 这次编辑是否可能改变信用卡账单。
 *
 * 只比「账单口径真正会读到」的字段：生效日 / 记账日 / 收支类型 / 金额 / 卡与对方账户，
 * 加上账单期（手填）、来源与基金子类（还款/投资腿走不同分支）。备注、分类、标签、
 * 往来对象、附件都不会改变应还金额与账期，返回 false 表示无需重算。
 */
export function creditCardBillImpactChanged(
  before: CreditBillImpactSnapshot | null | undefined,
  after: CreditBillImpactSnapshot | null | undefined,
) {
  if (!before || !after) return true;
  if (impactDayKey(before.date) !== impactDayKey(after.date)) return true;
  if (impactDayKey(before.postedAt) !== impactDayKey(after.postedAt)) return true;
  if ((before.type ?? "") !== (after.type ?? "")) return true;
  if (Math.abs(impactAmount(before.amount) - impactAmount(after.amount)) > 0.005) return true;
  if ((before.accountId ?? "") !== (after.accountId ?? "")) return true;
  if ((before.toAccountId ?? "") !== (after.toAccountId ?? "")) return true;
  if ((before.statementMonth ?? "") !== (after.statementMonth ?? "")) return true;
  if ((before.source ?? "") !== (after.source ?? "")) return true;
  if ((before.fundSubtype ?? "") !== (after.fundSubtype ?? "")) return true;
  if ((before.fundProductType ?? "") !== (after.fundProductType ?? "")) return true;
  return false;
}

export function hasLockedCreditCardCycle(lockSource: string | null | undefined) {
  return (
    (typeof lockSource === "string" && lockSource.includes(CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE)) ||
    (typeof lockSource === "string" && lockSource.includes(CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE))
  );
}

export async function invalidateCreditCardCycleCacheForAccountIds(
  accountIds: Iterable<string | null | undefined>,
  options: {
    deleteManualCycles?: boolean;
    rebuild?: boolean;
    /**
     * 编辑场景传 before/after 快照：账单相关字段完全没变时不重算。
     * 调用方已经确定「这批更新没碰账单字段」时可直接传 "unchanged"。
     * 新增/删除不需要传（金额必然变化）。
     */
    billImpact?: "unchanged" | {
      before: CreditBillImpactSnapshot | null | undefined;
      after: CreditBillImpactSnapshot | null | undefined;
    };
  } = {},
) {
  const ids = Array.from(new Set(Array.from(accountIds).filter((id): id is string => !!id)));
  if (ids.length === 0) return 0;

  if (
    options.billImpact === "unchanged" ||
    (options.billImpact && !creditCardBillImpactChanged(options.billImpact.before, options.billImpact.after))
  ) {
    return 0;
  }

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

  // 整卡账单都被锁定（手工改账期 / 对账单导入）时，重算既不会改动任何一行、也要
  // 白算 140+ 期，直接跳过。deleteManualCycles 是显式要求清锁（改账单日规则），不跳。
  let deletableAccountIds = billAccounts.map((account) => account.id);
  if (!options.deleteManualCycles) {
    const lockedCycles = await prisma.creditCardCycle.findMany({
      where: { accountId: { in: deletableAccountIds } },
      select: { accountId: true, lockSource: true },
    });
    const cyclesByAccount = new Map<string, string[]>();
    for (const cycle of lockedCycles) {
      const list = cyclesByAccount.get(cycle.accountId) ?? [];
      list.push(cycle.lockSource ?? "");
      cyclesByAccount.set(cycle.accountId, list);
    }
    deletableAccountIds = deletableAccountIds.filter((accountId) => {
      const lockSources = cyclesByAccount.get(accountId);
      if (!lockSources || lockSources.length === 0) return true;
      return !lockSources.every((lockSource) => hasLockedCreditCardCycle(lockSource));
    });
    if (deletableAccountIds.length === 0) return 0;
  }

  const result = await prisma.creditCardCycle.deleteMany({
    where: {
      accountId: { in: deletableAccountIds },
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
      if (!deletableAccountIds.includes(account.id)) continue;
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
