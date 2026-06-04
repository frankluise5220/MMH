import { prisma } from "@/lib/db/prisma";

/**
 * 查询基金确认天数
 * 优先从 FundConfirmDays 表查询，如果没有则返回默认值 0 (T+0)
 *
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @returns 确认天数（默认 T+0）
 */
export async function getFundConfirmDays(
  accountId: string,
  fundCode: string
): Promise<number> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: {
      accountId_fundCode: { accountId, fundCode },
    },
  });

  return record?.days ?? 0;
}

/**
 * 更新基金确认天数
 * 强制同步确认天数到 FundConfirmDays 表
 *
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param days 确认天数（可以是 0）
 */
export async function setFundConfirmDays(
  accountId: string,
  fundCode: string,
  days: number
): Promise<void> {
  await prisma.fundConfirmDays.upsert({
    where: {
      accountId_fundCode: { accountId, fundCode },
    },
    create: {
      accountId,
      fundCode,
      days,
    },
    update: {
      days,
    },
  });
}

/**
 * 批量更新确认天数（用于事务内）
 *
 * @param tx Prisma事务客户端
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param days 确认天数（可以是 0）
 */
export async function setFundConfirmDaysInTx(
  tx: any,
  accountId: string,
  fundCode: string,
  days: number
): Promise<void> {
  await tx.fundConfirmDays.upsert({
    where: {
      accountId_fundCode: { accountId, fundCode },
    },
    create: {
      accountId,
      fundCode,
      days,
    },
    update: {
      days,
    },
  });
}