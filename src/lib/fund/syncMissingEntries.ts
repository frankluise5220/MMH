/**
 * @deprecated 已废弃
 *
 * 基金明细现在直接存储在 TxRecord 中，不再需要同步 FundEntry。
 * 此文件保留仅供参考，所有调用已移除。
 *
 * 原功能：同步缺失的 FundEntry（从 TxRecord 创建对应的 FundEntry）
 * 废弃时间：2026-05-31
 */

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { TransactionType, FundSubtype } from "@prisma/client";

export async function syncMissingFundEntries(accountId: string, accountName: string) {
  // 此函数已废弃，不再执行任何操作
  console.warn("syncMissingFundEntries is deprecated and will be removed in future versions");
  return;
}
