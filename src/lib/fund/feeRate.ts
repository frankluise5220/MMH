import { prisma } from "@/lib/db/prisma";
export type FundFeeRateType = "buy" | "redeem";

/**
 * 查询基金手续费率（按确认日期查询）
 * 查询小于等于确认日期的最近一次费率值
 *
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param confirmDate 确认日期
 * @param feeType 费率类型：buy=申购手续费，redeem=赎回费率
 * @returns 手续费率（如果没有记录则返回默认值 0）
 */
export async function getFundFeeRateByDate(
  accountId: string,
  fundCode: string,
  confirmDate: Date,
  feeType: FundFeeRateType = "buy"
): Promise<number> {
  const record = await prisma.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        lte: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  return record?.rate ? Number(record.rate) : 0;
}

/**
 * 查询基金手续费率（查询最新的费率）
 *
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param feeType 费率类型：buy=申购手续费，redeem=赎回费率
 * @returns 手续费率（默认 0，免手续费）
 */
export async function getFundFeeRate(
  accountId: string,
  fundCode: string,
  feeType: FundFeeRateType = "buy"
): Promise<number> {
  const record = await prisma.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  return record?.rate ? Number(record.rate) : 0;
}

/**
 * 更新基金手续费率（智能模式）
 * 1. 查询小于等于确认日期的最近一次费率值
 * 2. 如果值相同，则不新增记录
 * 3. 如果值不同，则新增一条记录，日期为确认日期
 * 4. 清理大于确认日期且值相同的重复记录
 *
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param rate 新的费率值
 * @param confirmDate 确认日期（生效日期）
 * @param feeType 费率类型：buy=申购手续费，redeem=赎回费率
 */
export async function setFundFeeRateByDate(
  accountId: string,
  fundCode: string,
  rate: number,
  confirmDate: Date,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  const existingRecord = await prisma.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        lte: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  const existingRate = existingRecord?.rate ? Number(existingRecord.rate) : 0;

  if (existingRate === rate) {
    return;
  }

  await prisma.fundFeeRate.create({
    data: {
      accountId,
      fundCode,
      feeType,
      rate,
      effectiveDate: confirmDate,
    },
  });

  const futureRecords = await prisma.fundFeeRate.findMany({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        gt: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "asc",
    },
  });

  for (const record of futureRecords) {
    const recordRate = Number(record.rate);
    if (recordRate === rate) {
      await prisma.fundFeeRate.delete({
        where: { id: record.id },
      });
    }
  }
}

/**
 * 批量更新手续费率（用于事务内）
 * 与setFundFeeRateByDate逻辑相同，但用于事务内
 *
 * @param tx Prisma事务客户端
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param rate 新的费率值
 * @param confirmDate 确认日期（生效日期）
 * @param feeType 费率类型：buy=申购手续费，redeem=赎回费率
 */
export async function setFundFeeRateByDateInTx(
  tx: any,
  accountId: string,
  fundCode: string,
  rate: number,
  confirmDate: Date,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  const existingRecord = await tx.fundFeeRate.findFirst({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        lte: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "desc",
    },
  });

  const existingRate = existingRecord?.rate ? Number(existingRecord.rate) : 0;

  if (existingRate === rate) {
    return;
  }

  await tx.fundFeeRate.create({
    data: {
      accountId,
      fundCode,
      feeType,
      rate,
      effectiveDate: confirmDate,
    },
  });

  const futureRecords = await tx.fundFeeRate.findMany({
    where: {
      accountId,
      fundCode,
      feeType,
      effectiveDate: {
        gt: confirmDate,
      },
    },
    orderBy: {
      effectiveDate: "asc",
    },
  });

  for (const record of futureRecords) {
    const recordRate = Number(record.rate);
    if (recordRate === rate) {
      await tx.fundFeeRate.delete({
        where: { id: record.id },
      });
    }
  }
}

/**
 * 更新基金手续费率（定投计划专用）
 * 使用当前日期作为生效日期，按日期区间逻辑写入
 * 查询 <=当前日期 的最近一条费率，相同则不写入，不同则新增
 *
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param rate 手续费率（可以是 0）
 * @param feeType 费率类型：buy=申购手续费，redeem=赎回费率
 */
export async function setFundFeeRate(
  accountId: string,
  fundCode: string,
  rate: number,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  await setFundFeeRateByDate(accountId, fundCode, rate, new Date(), feeType);
}

/**
 * 批量更新手续费率（定投计划专用，用于事务内）
 * 使用当前日期作为生效日期，按日期区间逻辑写入
 *
 * @param tx Prisma事务客户端
 * @param accountId 账户ID
 * @param fundCode 基金代码
 * @param rate 手续费率（可以是 0）
 * @param feeType 费率类型：buy=申购手续费，redeem=赎回费率
 */
export async function setFundFeeRateInTx(
  tx: any,
  accountId: string,
  fundCode: string,
  rate: number,
  feeType: FundFeeRateType = "buy"
): Promise<void> {
  await setFundFeeRateByDateInTx(tx, accountId, fundCode, rate, new Date(), feeType);
}
