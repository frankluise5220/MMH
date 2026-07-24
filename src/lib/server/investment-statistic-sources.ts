import { FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { calculateWealthPositionsFromEntries } from "@/lib/wealth-position";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import type { HouseholdContext } from "@/lib/server/household-scope";
import type { InvestmentStatisticEntryLike } from "@/lib/transaction-statistics";

export type InvestmentStatisticSourceEntry = InvestmentStatisticEntryLike & {
  entryId: string;
  canEdit: boolean;
  date: Date;
  accountId: string;
  accountName: string;
  counterpartyName: string | null;
  note: string | null;
  createdAt: Date;
  tagIds: string[];
  tags: Array<{ tagId: string; id: string; name: string; color: string | null }>;
};

function isCashInAction(action: FundSubtype | string | null | undefined) {
  return action === FundSubtype.redeem || action === FundSubtype.switch_out || action === FundSubtype.dividend_cash;
}

function absNumber(value: unknown) {
  return Math.abs(toNumber(value));
}

export async function loadWealthStatisticSourceEntries(
  ctx: HouseholdContext,
  params: {
    start: Date;
    endExclusive: Date;
    accountIds?: string[] | null;
    tagIds?: string[] | null;
    excludeEntryIds?: Iterable<string>;
  },
): Promise<InvestmentStatisticSourceEntry[]> {
  const accountIds = Array.from(new Set(params.accountIds?.filter(Boolean) ?? []));
  const tagIds = Array.from(new Set(params.tagIds?.filter(Boolean) ?? []));
  const excluded = new Set(params.excludeEntryIds ?? []);

  const calcRows = await prisma.wealthTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      tradeDate: { lt: params.endExclusive },
      ...(accountIds.length
        ? { OR: [{ accountId: { in: accountIds } }, { cashAccountId: { in: accountIds } }] }
        : {}),
    },
    include: {
      Account: true,
      CashAccount: true,
      WealthProduct: true,
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const startMs = params.start.getTime();
  const endMs = params.endExclusive.getTime();
  const rows = calcRows.filter((row) => {
    const tradeMs = row.tradeDate.getTime();
    if (tradeMs < startMs || tradeMs >= endMs) return false;
    return isCashInAction(row.action) || row.realizedProfit != null || row.interest != null || row.fee != null;
  });

  const cashEntryIds = Array.from(new Set(rows.map((row) => row.cashEntryId).filter(Boolean) as string[]));
  const cashEntries = cashEntryIds.length
    ? await prisma.txRecord.findMany({
        where: { householdId: ctx.householdId, id: { in: cashEntryIds } },
        select: {
          id: true,
          accountId: true,
          accountName: true,
          note: true,
          EntryTag: {
            select: {
              tagId: true,
              Tag: { select: { id: true, name: true, color: true } },
            },
          },
        },
      })
    : [];
  const cashEntryById = new Map(cashEntries.map((entry) => [entry.id, entry]));
  const profitByTransactionId = new Map<string, number>();
  const rowsByAccountId = new Map<string, typeof calcRows>();
  for (const row of calcRows) {
    const list = rowsByAccountId.get(row.accountId) ?? [];
    list.push(row);
    rowsByAccountId.set(row.accountId, list);
  }
  for (const accountRows of rowsByAccountId.values()) {
    const fundUnitsDecimals = normalizeFundUnitsDecimals(accountRows[0]?.Account?.fundUnitsDecimals, 3);
    const calc = calculateWealthPositionsFromEntries(
      accountRows.map((row) => ({
        id: row.id,
        cashEntryId: row.cashEntryId,
        productKey: `${row.accountId}:${row.wealthProductId ?? row.productName ?? `wealth:${row.id}`}`,
        action: row.action,
        tradeDate: row.tradeDate,
        createdAt: row.createdAt,
        grossAmount: row.grossAmount,
        arrivalAmount: row.arrivalAmount,
        units: row.units,
        nav: row.nav,
        interest: row.interest,
        fee: row.fee,
      })),
      fundUnitsDecimals,
    );
    for (const [entryId, profit] of calc.realizedProfitByTransactionId) {
      profitByTransactionId.set(entryId, profit);
    }
  }

  return rows.flatMap((row): InvestmentStatisticSourceEntry[] => {
    const entryId = row.cashEntryId ?? row.id;
    if (excluded.has(row.id) || excluded.has(entryId)) return [];
    const cashEntry = row.cashEntryId ? cashEntryById.get(row.cashEntryId) ?? null : null;
    if (tagIds.length > 0 && !cashEntry?.EntryTag.some((tag) => tagIds.includes(tag.tagId))) return [];

    const isCashIn = isCashInAction(row.action);
    const isDividend = row.action === FundSubtype.dividend_cash;
    const grossAmount = absNumber(row.grossAmount);
    const arrivalAmount = row.arrivalAmount == null ? null : absNumber(row.arrivalAmount);
    const dividendAmount = arrivalAmount ?? absNumber(row.interest ?? row.realizedProfit ?? row.grossAmount);
    const displayAmount = isDividend
      ? dividendAmount
      : isCashIn
        ? arrivalAmount ?? grossAmount
        : -grossAmount;
    const productName = row.WealthProduct?.name ?? row.productName ?? "";
    const accountId = cashEntry?.accountId ?? row.cashAccountId ?? row.accountId;
    const accountName = cashEntry?.accountName ?? row.CashAccount?.name ?? row.Account.name;

    return [{
      id: `wealth:${row.id}`,
      entryId,
      canEdit: false,
      date: row.tradeDate,
      amount: displayAmount,
      fundSubtype: row.action,
      fundProductType: "wealth",
      realizedProfit: profitByTransactionId.get(row.id) ?? row.realizedProfit,
      depositInterest: row.interest,
      fundFee: row.fee,
      fundCode: null,
      fundName: productName,
      accountId,
      accountName,
      counterpartyName: productName || "理财",
      note: row.note ?? cashEntry?.note ?? null,
      createdAt: row.createdAt,
      tagIds: cashEntry?.EntryTag.map((tag) => tag.tagId) ?? [],
      tags: cashEntry?.EntryTag.map((tag) => ({
        tagId: tag.tagId,
        id: tag.Tag.id,
        name: tag.Tag.name,
        color: tag.Tag.color,
      })) ?? [],
    }];
  });
}
