/**
 * 信用卡「显示余额」的唯一口径。
 *
 * 侧边栏、账户列表、概览、`/api/v1/accounts/*` 这些地方以前各自写一遍
 * 「查 isCurrentCycle 行 → 取 effectiveBill」，缺失当期行时各自退化成 0。
 * 结果是：账期刚切换（或账单页还没被访问、cycle 缓存还没重建）时，
 * 左侧账户树显示「信用卡 ¥0.00」，点进账单页却有金额 —— 同一张卡两个数。
 *
 * 这里把口径收成一份：当期行优先；没有当期行就退到**最近一期**的累计未还
 * (`cumulativeRemain - cumulativeOverpaid`)，而不是 0。最近一期就是跨月后
 * 还没重建缓存时的真实欠款额。
 *
 * 合并账单（`creditBillMode = consolidated`，同机构 + 同所有人）是**一份账单
 * 挂多张卡**：cycle 只写主卡，但用户看到的是同一个额度池，组内每张卡的余额
 * 必须显示同一个数（2026-11-16 用户裁定）。所以这里同时给出
 * `billStorageIdByAccountId`：汇总求和时按它去重，否则组内 N 张卡会把负债
 * 算成 N 倍。
 */
import { AccountKind, type CreditBillMode } from "@prisma/client";

import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { creditBillGroupKey } from "@/lib/server/credit-card-institution-settings";

const CREDIT_BILL_MODE_CONSOLIDATED: CreditBillMode = "consolidated";

export const CREDIT_CARD_CYCLE_BALANCE_SELECT = {
  accountId: true,
  statementMonth: true,
  isCurrentCycle: true,
  effectiveBill: true,
  cumulativeRemain: true,
  cumulativeOverpaid: true,
} as const;

export type CreditCardCycleBalanceRow = {
  accountId: string;
  statementMonth: string;
  isCurrentCycle: boolean;
  effectiveBill: unknown;
  cumulativeRemain: unknown;
  cumulativeOverpaid: unknown;
};

export type CreditCardBillGroupBalances = {
  /** 每张卡的显示余额；合并账单组内所有卡共享同一份。 */
  balanceByAccountId: Map<string, number>;
  /**
   * 汇总去重键：该卡所在账单组的存储账户（组内主卡 id）；单卡账户 = 自己。
   * 求和时同一 storageId 只应计入一次。
   */
  billStorageIdByAccountId: Map<string, string>;
};

/**
 * 把 cycle 行折算成 `accountId → 显示余额`。
 *
 * - 每张卡取 `isCurrentCycle` 行（有的话）；
 * - 没有当期行的卡，用 `statementMonth` 最大的那一期兜底；
 * - 完全没有 cycle 记录的卡不出现在 Map 里，调用方按自己的兜底语义处理。
 */
export function creditCardDisplayBalancesFromCycles(
  rows: readonly CreditCardCycleBalanceRow[],
): Map<string, number> {
  const currentByAccountId = new Map<string, number>();
  const latestByAccountId = new Map<string, CreditCardCycleBalanceRow>();

  for (const row of rows) {
    const accountId = String(row.accountId ?? "").trim();
    if (!accountId) continue;
    if (row.isCurrentCycle) {
      currentByAccountId.set(accountId, creditCardDisplayBalanceFromCurrentCycle(row));
    }
    const previous = latestByAccountId.get(accountId);
    if (!previous || String(row.statementMonth ?? "") > String(previous.statementMonth ?? "")) {
      latestByAccountId.set(accountId, row);
    }
  }

  const result = new Map(currentByAccountId);
  for (const [accountId, row] of latestByAccountId) {
    if (result.has(accountId)) continue;
    result.set(accountId, toNumber(row.cumulativeRemain) - toNumber(row.cumulativeOverpaid));
  }
  return result;
}

/**
 * 批量读取信用卡显示余额（不含 household 过滤，调用方负责账号范围）。
 *
 * 合并账单组会被展开：组内每张卡都拿到同一份「组账单余额」，主卡优先取
 * cycle，主卡没有行时依次取组内其它成员（历史数据可能记在别的成员上）。
 */
export async function loadCreditCardBillGroupBalances(
  accountIds: readonly string[],
): Promise<CreditCardBillGroupBalances> {
  const balanceByAccountId = new Map<string, number>();
  const billStorageIdByAccountId = new Map<string, string>();
  const ids = Array.from(new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0) return { balanceByAccountId, billStorageIdByAccountId };

  const accounts = await prisma.account.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      groupId: true,
      kind: true,
      creditBillMode: true,
    },
  });

  // 组键与 `getCreditBillAccountIds` 共用一份实现：同 household + 同机构 + 同所有人。
  // 不同所有人的卡属于不同 groupId，绝不会落进同一份账单。
  const consolidatedGroups = new Map<
    string,
    { householdId: string; institutionId: string; groupId: string }
  >();
  for (const account of accounts) {
    if (account.kind !== AccountKind.bank_credit) continue;
    if (account.creditBillMode !== CREDIT_BILL_MODE_CONSOLIDATED) continue;
    const key = creditBillGroupKey(account);
    if (!key || !account.institutionId || !account.groupId) continue;
    consolidatedGroups.set(key, {
      householdId: account.householdId,
      institutionId: account.institutionId,
      groupId: account.groupId,
    });
  }

  // 组内全部成员：合并账单的 cycle 只挂在主卡上，但余额要在每张卡上显示。
  const memberIdsByGroupKey = new Map<string, string[]>();
  const groupKeyByAccountId = new Map<string, string>();
  if (consolidatedGroups.size > 0) {
    const members = await prisma.account.findMany({
      where: {
        OR: Array.from(consolidatedGroups.values()),
        kind: AccountKind.bank_credit,
        creditBillMode: CREDIT_BILL_MODE_CONSOLIDATED,
      },
      select: { id: true, householdId: true, institutionId: true, groupId: true },
      orderBy: { id: "asc" },
    });
    for (const member of members) {
      const key = creditBillGroupKey(member);
      if (!key) continue;
      const list = memberIdsByGroupKey.get(key) ?? [];
      list.push(member.id);
      memberIdsByGroupKey.set(key, list);
      groupKeyByAccountId.set(member.id, key);
    }
  }

  const allCycleAccountIds = new Set(ids);
  for (const id of ids) {
    const key = groupKeyByAccountId.get(id);
    if (!key) continue;
    for (const memberId of memberIdsByGroupKey.get(key) ?? []) allCycleAccountIds.add(memberId);
  }

  const rows = await prisma.creditCardCycle.findMany({
    where: { accountId: { in: Array.from(allCycleAccountIds) } },
    select: CREDIT_CARD_CYCLE_BALANCE_SELECT,
  });
  const balanceByCycleAccountId = creditCardDisplayBalancesFromCycles(rows);

  for (const id of ids) {
    const groupKey = groupKeyByAccountId.get(id);
    const members = groupKey ? memberIdsByGroupKey.get(groupKey) ?? [id] : [id];
    // 与 `getCreditBillAccountIds` 一致：组内 id 升序第一个是账单存储账户（主卡）。
    const storageId = members[0] ?? id;
    billStorageIdByAccountId.set(id, storageId);

    let value = balanceByCycleAccountId.get(storageId);
    if (value == null) {
      for (const memberId of members) {
        const candidate = balanceByCycleAccountId.get(memberId);
        if (candidate != null) {
          value = candidate;
          break;
        }
      }
    }
    if (value != null) balanceByAccountId.set(id, value);
  }

  return { balanceByAccountId, billStorageIdByAccountId };
}

/**
 * 汇总求和用：同一账单组只计一次（组主卡那一份）。
 *
 * 入参是「每张卡的显示余额」（合并账单组内已是一致值），按 storageId 去重后
 * 求和，避免组内 N 张卡把负债算成 N 倍。
 */
export function sumCreditBalancesByBillGroup(
  rows: Iterable<{ accountId: string; amount: number }>,
  billStorageIdByAccountId: Map<string, string>,
): number {
  const seen = new Set<string>();
  let total = 0;
  for (const row of rows) {
    const storageId = billStorageIdByAccountId.get(row.accountId) ?? row.accountId;
    if (seen.has(storageId)) continue;
    seen.add(storageId);
    total += row.amount;
  }
  return total;
}
