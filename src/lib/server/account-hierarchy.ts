import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { isAggregateAccount, multiCurrencyChildName } from "@/lib/account-hierarchy";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";

type Db = Prisma.TransactionClient | PrismaClient;

const ACCOUNT_SELECT = {
  id: true,
  name: true,
  currency: true,
  kind: true,
  groupId: true,
  institutionId: true,
  parentId: true,
  isAggregate: true,
  isActive: true,
  householdId: true,
  investProductType: true,
  liabilityDirection: true,
} satisfies Prisma.AccountSelect;

type HierarchyAccount = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/**
 * 找到父账户下指定币种的子账户；没有就建一个（2026-10-18 用户裁定：
 * 「当有第二种货币提到这个账户时自动分成两个二级账户」）。
 *
 * 命名规则：子户默认 `原名 · 币种`，币种一律用 ISO 代码入库。
 * 并发下 `(parentId, currency)` 唯一约束会挡住重复创建，撞了就回头读一次。
 */
export async function resolveCurrencyChildAccount(
  db: Db,
  params: { householdId: string; parentId: string; currency: string },
): Promise<{ account: HierarchyAccount; created: boolean }> {
  const currency = normalizeCurrency(params.currency);
  const findChild = () =>
    db.account.findFirst({
      where: { householdId: params.householdId, parentId: params.parentId, currency },
      select: ACCOUNT_SELECT,
    });

  const existing = await findChild();
  if (existing) return { account: existing, created: false };

  const parent = await db.account.findFirst({
    where: { id: params.parentId, householdId: params.householdId },
    select: ACCOUNT_SELECT,
  });
  if (!parent) throw new Error("parent account not found");

  try {
    const created = await db.account.create({
      data: {
        householdId: params.householdId,
        name: multiCurrencyChildName(parent.name, currency),
        kind: parent.kind,
        currency,
        groupId: parent.groupId,
        institutionId: parent.institutionId,
        investProductType: parent.investProductType,
        liabilityDirection: parent.liabilityDirection,
        parentId: parent.id,
        isAggregate: false,
        isActive: parent.isActive,
        isPlaceholder: false,
        balance: 0,
      },
      select: ACCOUNT_SELECT,
    });
    return { account: created, created: true };
  } catch (error) {
    // P2002 = 唯一约束冲突：并发请求已经建好了同币种子户，直接复用。
    if ((error as { code?: string })?.code !== "P2002") throw error;
    const raced = await findChild();
    if (!raced) throw error;
    return { account: raced, created: false };
  }
}

/**
 * 把「目标账户 + 币种」解析成真正该记账的账户。
 *
 * - 传的是父账户 → 解析到对应币种子户（没有就建）；
 * - 传的是子账户 → 解析到同一父下目标币种的兄弟子户；
 * - 普通账户 → 原样返回（不做隐式升级：记录币种与账户币种不一致的历史行为
 *   仍然有效，比如信用卡的境外消费）。
 */
export async function resolveAccountForCurrency(
  db: Db,
  params: {
    householdId: string;
    accountId: string;
    currency: string;
    createChildIfMissing?: boolean;
  },
): Promise<{ account: HierarchyAccount; created: boolean }> {
  const account = await db.account.findFirst({
    where: { id: params.accountId, householdId: params.householdId },
    select: ACCOUNT_SELECT,
  });
  if (!account) throw new Error("account not found");

  const parentId = isAggregateAccount(account) ? account.id : account.parentId;
  if (!parentId) return { account, created: false };

  const currency = normalizeCurrency(params.currency);
  if (normalizeCurrency(account.currency) === currency && !isAggregateAccount(account)) {
    return { account, created: false };
  }
  if (params.createChildIfMissing === false) {
    const existing = await db.account.findFirst({
      where: { householdId: params.householdId, parentId, currency },
      select: ACCOUNT_SELECT,
    });
    if (!existing) throw new Error(`missing ${currency} child account`);
    return { account: existing, created: false };
  }
  return resolveCurrencyChildAccount(db, { householdId: params.householdId, parentId, currency });
}

/**
 * 父账户余额 = 子户按**账簿本位币**折算合计（用户裁定：外币统一按系统默认币种
 * 兑换后参与统计）。
 *
 * 汇率缺失时 `convertCurrencyAmounts` 跳过该币种并回传 `missingCurrencies`，
 * 绝不按 1:1 静默补齐。
 */
export async function recomputeAggregateAccountBalance(
  db: Db,
  parentId: string,
): Promise<{ total: number; missingCurrencies: string[] } | null> {
  const parent = await db.account.findFirst({
    where: { id: parentId, isAggregate: true },
    select: { id: true, householdId: true, currency: true },
  });
  if (!parent) return null;
  const children = await db.account.findMany({
    where: { parentId: parent.id },
    select: { balance: true, currency: true },
  });
  const conversion = await convertCurrencyAmounts({
    householdId: parent.householdId,
    toCurrency: parent.currency,
    amounts: children.map((child) => ({
      amount: Number(child.balance ?? 0),
      currency: child.currency,
    })),
    refreshMissing: true,
  });
  await db.account.update({
    where: { id: parent.id },
    data: { balance: conversion.total, balanceRecomputedAt: new Date() },
  });
  return { total: conversion.total, missingCurrencies: conversion.missingCurrencies };
}

/** 子户余额变化后，把父账户的折算余额跟着刷一遍（没有父就直接返回）。 */
export async function refreshParentAggregateBalance(
  db: Db,
  accountIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = Array.from(new Set(accountIds.filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return;
  const children = await db.account.findMany({
    where: { id: { in: ids }, parentId: { not: null } },
    select: { parentId: true },
  });
  const parentIds = Array.from(new Set(children.map((child) => child.parentId).filter((id): id is string => Boolean(id))));
  for (const parentId of parentIds) {
    await recomputeAggregateAccountBalance(db, parentId);
  }
}

export type UpgradeMultiCurrencyResult = {
  parentId: string;
  parentName: string;
  childId: string;
  childName: string;
  childCurrency: string;
};

/**
 * 把已有账户升级为多币种父账户。
 *
 * **不迁移任何流水**：父是新建的一行，原账户原地降级为默认币种子账户（id 不变），
 * 所以明细、余额、计划任务、报表、备份全部原样有效。用户裁定：父账户沿用原名，
 * 子账户默认名 = `原名 · 币种`。
 *
 * `TxRecord.accountName` / `toAccountName` 是写入时的快照，必须同步改名，否则
 * 明细/导出里新旧名字会混着出现（账户合并路由用的是同一套做法）。
 */
export async function upgradeAccountToMultiCurrency(params: {
  householdId: string;
  accountId: string;
}): Promise<UpgradeMultiCurrencyResult> {
  const baseCurrency = await getHouseholdBaseCurrency(params.householdId);
  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findFirst({
      where: { id: params.accountId, householdId: params.householdId },
      select: ACCOUNT_SELECT,
    });
    if (!account) throw new Error("account not found");
    if (isAggregateAccount(account)) throw new Error("already multi-currency");
    if (account.parentId) throw new Error("child account cannot be upgraded");

    const childCurrency = normalizeCurrency(account.currency);
    const parent = await tx.account.create({
      data: {
        householdId: params.householdId,
        name: account.name,
        kind: account.kind,
        // 父账户的币种就是统计币种：账簿本位币。
        currency: baseCurrency,
        groupId: account.groupId,
        institutionId: account.institutionId,
        investProductType: account.investProductType,
        liabilityDirection: account.liabilityDirection,
        isAggregate: true,
        isActive: account.isActive,
        isPlaceholder: false,
        balance: 0,
      },
      select: { id: true, name: true },
    });

    const childName = multiCurrencyChildName(account.name, childCurrency);
    await tx.account.update({
      where: { id: account.id },
      data: { name: childName, parentId: parent.id },
    });
    await tx.txRecord.updateMany({
      where: { accountId: account.id },
      data: { accountName: childName },
    });
    await tx.txRecord.updateMany({
      where: { toAccountId: account.id },
      data: { toAccountName: childName },
    });

    return {
      parentId: parent.id,
      parentName: parent.name,
      childId: account.id,
      childName,
      childCurrency,
    };
  });
}

/**
 * 降级：只在还剩一个子账户时允许。子户提升为根账户（keepName 决定是否改回原名），
 * 父行删除（`onDelete: SetNull` 会先解掉层级）。
 */
export async function downgradeMultiCurrencyAccount(params: {
  householdId: string;
  parentId: string;
}): Promise<{ childId: string; childName: string }> {
  const parent = await prisma.account.findFirst({
    where: { id: params.parentId, householdId: params.householdId, isAggregate: true },
    select: { id: true, name: true, Children: { select: { id: true, name: true } } },
  });
  if (!parent) throw new Error("multi-currency account not found");
  if (parent.Children.length !== 1) throw new Error("only single-child parent can be downgraded");

  const child = parent.Children[0];
  const childName = child.name;
  await prisma.$transaction(async (tx) => {
    await tx.account.update({ where: { id: child.id }, data: { parentId: null } });
    await tx.txRecord.updateMany({ where: { accountId: child.id }, data: { accountName: childName } });
    await tx.txRecord.updateMany({ where: { toAccountId: child.id }, data: { toAccountName: childName } });
    await tx.account.delete({ where: { id: parent.id } });
  });
  return { childId: child.id, childName };
}
