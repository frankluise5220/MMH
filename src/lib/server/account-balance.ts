import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";

/**
 * 重算账户余额并写回数据库。
 * 同时考虑 accountId 侧（发起方）和 toAccountId 侧（接收方）的记录。
 *
 * 规则：
 * - accountId 侧：amount 直接累加（支出为负、收入为正）
 * - toAccountId 侧：金额绝对值累加（无论来源方金额正负，接收方都是流入）
 */
export async function recalcAndSaveAccountBalance(accountId: string) {
  const fromAgg = await prisma.txRecord.aggregate({
    where: { accountId, deletedAt: null },
    _sum: { amount: true },
  });
  const fromSum = toNumber(fromAgg._sum.amount);

  // toAccountId 侧不能用 SUM+取反，因为 amount 正负方向不统一（dividend_cash 为正）
  const toRecords = await prisma.txRecord.findMany({
    where: { toAccountId: accountId, deletedAt: null },
    select: { amount: true },
  });
  const toSum = toRecords.reduce((s, r) => s + Math.abs(toNumber(r.amount)), 0);

  const txSum = fromSum + toSum;
  const acc = await prisma.account.findUnique({ where: { id: accountId }, select: { kind: true, billingDay: true } });
  if (!acc) return;
  const isBill = acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan;
  const newBalance = isBill && acc.billingDay ? "0" : String(txSum);
  await prisma.account.update({ where: { id: accountId }, data: { balance: newBalance } }).catch(() => {});
}