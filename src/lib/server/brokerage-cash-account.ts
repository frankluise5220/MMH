import { AccountKind, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type TxClient = Prisma.TransactionClient | typeof prisma;

type StockAccountLike = {
  id: string;
  householdId: string;
  groupId: string;
  institutionId?: string | null;
  currency?: string | null;
};

export const BROKERAGE_CASH_ACCOUNT_NAME = "证券资金账户";

function buildBrokerageCashAccountName(institution?: { name?: string | null; shortName?: string | null } | null) {
  const institutionName = institution?.shortName?.trim() || institution?.name?.trim() || "";
  return institutionName ? `${institutionName}的资金账户` : BROKERAGE_CASH_ACCOUNT_NAME;
}

export function isCashLikeBrokerageFundingKind(kind: string | null | undefined) {
  return kind === AccountKind.cash || kind === AccountKind.bank_debit || kind === AccountKind.ewallet;
}

export type StockFundingAccount = {
  id: string;
  name: string;
  kind: AccountKind;
  investProductType: string | null;
};

/** 「同机构 + 同账户组 + 同币种」的首选资金账户（与 ensure 的选择顺序一致，但不创建）。 */
async function findBrokerageFundingAccount(
  client: TxClient,
  stockAccount: StockAccountLike,
): Promise<StockFundingAccount | null> {
  if (!stockAccount.institutionId) return null;

  return client.account.findFirst({
    where: {
      householdId: stockAccount.householdId,
      groupId: stockAccount.groupId,
      institutionId: stockAccount.institutionId,
      currency: stockAccount.currency?.trim() || "CNY",
      isPlaceholder: { not: true },
      kind: { in: [AccountKind.ewallet, AccountKind.cash, AccountKind.bank_debit] },
    },
    select: { id: true, name: true, kind: true, investProductType: true },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * 股票账户的资金账户只有这一个答案：最近一笔交易实际用的那只，没有才回退机构默认。
 * 表头余额和记账弹窗默认值都用它，钱记哪表头就显示哪（2026-11-13 两处各猜一次导致余额不动）。
 */
export async function resolveStockFundingAccount(
  client: TxClient,
  stockAccount: StockAccountLike,
): Promise<StockFundingAccount | null> {
  const latest = await client.stockTransaction.findFirst({
    where: {
      householdId: stockAccount.householdId,
      stockAccountId: stockAccount.id,
      deletedAt: null,
      cashAccountId: { not: null },
    },
    select: { cashAccountId: true },
    // 按录入时间而不是交易日：用户补记一笔早先的交易，资金也是刚从这里出去的。
    orderBy: [{ createdAt: "desc" }, { tradeDate: "desc" }, { id: "desc" }],
  });
  const latestCashAccountId = latest?.cashAccountId?.trim() ?? "";
  if (latestCashAccountId) {
    const used = await client.account.findFirst({
      where: { id: latestCashAccountId, householdId: stockAccount.householdId },
      select: { id: true, name: true, kind: true, investProductType: true },
    });
    if (used && isCashLikeBrokerageFundingKind(used.kind)) return used;
  }

  return findBrokerageFundingAccount(client, stockAccount);
}

/**
 * Ensure a stock account's brokerage has a visible funding account.
 *
 * Stock/fund holding accounts are business ledgers. Bank-securities transfers
 * land in the brokerage funding account, which can be shared by stock and fund
 * trades under the same brokerage institution.
 */
export async function ensureBrokerageCashAccountForStockAccount(
  client: TxClient,
  stockAccount: StockAccountLike,
) {
  if (!stockAccount.institutionId) return null;

  const currency = stockAccount.currency?.trim() || "CNY";
  const institution = await client.institution.findUnique({
    where: { id: stockAccount.institutionId },
    select: { name: true, shortName: true },
  });
  const existing = await client.account.findFirst({
    where: {
      householdId: stockAccount.householdId,
      groupId: stockAccount.groupId,
      institutionId: stockAccount.institutionId,
      currency,
      isPlaceholder: { not: true },
      OR: [
        { kind: AccountKind.ewallet },
        { kind: AccountKind.cash },
        { kind: AccountKind.bank_debit },
      ],
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true, type: true } },
      Counterparty: { select: { id: true, name: true, shortName: true, type: true } },
    },
    orderBy: [
      { isActive: "desc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
  if (existing) return existing;

  return client.account.create({
    data: {
      name: buildBrokerageCashAccountName(institution),
      kind: AccountKind.ewallet,
      currency,
      groupId: stockAccount.groupId,
      institutionId: stockAccount.institutionId,
      householdId: stockAccount.householdId,
      isActive: true,
      investProductType: null,
      costBasisMethod: null,
      tradingCalendar: null,
      fundUnitsDecimals: 2,
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true, type: true } },
      Counterparty: { select: { id: true, name: true, shortName: true, type: true } },
    },
  });
}
