import { FundCashFlowKind, FundSubtype } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { calculateWealthPositionsFromEntries } from "@/lib/wealth-position";
import { getFundProfileNameMap } from "@/lib/fund/fundProfile";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import type { HouseholdContext } from "@/lib/server/household-scope";
import type { InvestmentStatisticEntryLike } from "@/lib/transaction-statistics";

type InvestmentStatisticSourceEntry = InvestmentStatisticEntryLike & {
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

function isRefundFlow(kind: FundCashFlowKind | string | null | undefined) {
  return kind === FundCashFlowKind.refund_in || kind === "refund_in";
}

function signedFundCashFlowAmount(kind: FundCashFlowKind | string | null | undefined, amount: unknown) {
  const value = absNumber(amount);
  if (kind === FundCashFlowKind.buy_out || kind === FundCashFlowKind.switch_in || kind === "buy_out" || kind === "switch_in") {
    return -value;
  }
  return value;
}

function absNumber(value: unknown) {
  return Math.abs(toNumber(value));
}

/**
 * 基金显示名：只认 FundProfile（资料库）。
 *
 * 名字是基金的维度属性，不是每一笔交易的属性。资料库的写入只发生在基金资料页，
 * 读路径（报表、列表、导出）一律只拿 fundCode 去查，查不到就交给调用方显示代码，
 * 不再回退到 fundTransaction.fundName 快照 —— 否则「改名的唯一入口」会被导入时
 * 的旧快照绕过。
 */
async function loadFundDisplayNames(fundCodes: Array<string | null>): Promise<Map<string, string>> {
  const codes = Array.from(new Set(fundCodes.map((code) => code?.trim()).filter(Boolean) as string[]));
  if (codes.length === 0) return new Map();
  return getFundProfileNameMap(codes);
}

export async function loadFundStatisticSourceEntries(
  ctx: HouseholdContext,
  params: {
    start: Date;
    endExclusive: Date;
    accountIds?: string[] | null;
    tagIds?: string[] | null;
  },
): Promise<InvestmentStatisticSourceEntry[]> {
  const accountIds = Array.from(new Set(params.accountIds?.filter(Boolean) ?? []));
  const tagIds = Array.from(new Set(params.tagIds?.filter(Boolean) ?? []));
  // 这条查询按设计没有 applyDate 下界（最多 5 万行），所以字段必须显式列出：
  // `include: { Account: true } / { cashFlows: true }` 会把两张账户表和现金流表的
  // 全部列按行数一起拉回来，而这里只用到账户名和现金流的日期/金额/条数。
  // fundName 也不取：同一只基金的名字在每行重复，改由 loadFundDisplayNames 按
  // fundCode 从资料库取（缺失时由调用方显示代码）。
  // 实测（scripts/bench-reports.ts）：收窄后报表的基金统计源从 908ms 降到 661ms。
  const rows = await prisma.fundTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      applyDate: { lt: params.endExclusive },
      ...(accountIds.length
        ? { OR: [{ fundAccountId: { in: accountIds } }, { cashAccountId: { in: accountIds } }] }
        : {}),
    },
    select: {
      id: true,
      applyDate: true,
      arrivalDate: true,
      cashEntryId: true,
      cashAccountId: true,
      fundAccountId: true,
      fundSubtype: true,
      fundProductType: true,
      fundCode: true,
      realizedProfit: true,
      units: true,
      nav: true,
      fee: true,
      note: true,
      createdAt: true,
      Account: { select: { name: true } },
      CashAccount: { select: { name: true } },
      cashFlows: {
        select: {
          id: true,
          kind: true,
          amount: true,
          flowDate: true,
          txRecordId: true,
          accountId: true,
          createdAt: true,
        },
      },
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { cashEntryId: true },
      },
    },
    orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 50000,
  });

  // 基金名要和现金腿查询并行，别串在它后面。
  const fundNameByCodePromise = loadFundDisplayNames(rows.map((row) => row.fundCode));
  const cashEntryIds = Array.from(new Set(rows.flatMap((row) => [
    row.cashEntryId,
    ...row.cashFlows.map((flow) => flow.txRecordId),
    ...row.EntryBusinessLink.map((link) => link.cashEntryId),
  ].filter(Boolean) as string[])));
  const cashEntries = cashEntryIds.length
    ? await prisma.txRecord.findMany({
        where: { householdId: ctx.householdId, id: { in: cashEntryIds }, deletedAt: null },
        select: {
          id: true,
          date: true,
          amount: true,
          accountId: true,
          accountName: true,
          account: { select: { name: true } },
          note: true,
          createdAt: true,
          EntryTag: {
            select: {
              tagId: true,
              Tag: { select: { id: true, name: true, color: true } },
            },
          },
        },
      })
    : [];
  const fundNameByCode = await fundNameByCodePromise;
  const cashEntryById = new Map(cashEntries.map((entry) => [entry.id, entry]));
  const startMs = params.start.getTime();
  const endMs = params.endExclusive.getTime();
  const entries: InvestmentStatisticSourceEntry[] = [];

  for (const row of rows) {
    const fundName = row.fundCode ? fundNameByCode.get(row.fundCode) ?? null : null;
    const orderedFlows = [...row.cashFlows].sort((a, b) =>
      a.flowDate.getTime() - b.flowDate.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
    );
    const primaryFlow = orderedFlows.find((flow) => !isRefundFlow(flow.kind)) ?? orderedFlows[0] ?? null;
    const primaryCashEntry = (
      (row.cashEntryId ? cashEntryById.get(row.cashEntryId) : null) ??
      (primaryFlow ? cashEntryById.get(primaryFlow.txRecordId) : null)
    ) ?? null;
    // 报表按「资金到账日」归期（2026-10-17）：赎回 / 转换转出 / 现金分红用业务行
    // 的到账日；部分历史行的现金腿 date 记的还是申请日。
    const mainDate = isCashInAction(row.fundSubtype) && row.arrivalDate
      ? row.arrivalDate
      : primaryCashEntry?.date ?? primaryFlow?.flowDate ?? row.applyDate;
    const mainEntryId = primaryCashEntry?.id ?? row.cashEntryId ?? primaryFlow?.txRecordId ?? row.id;
    const mainTags = primaryCashEntry?.EntryTag ?? [];
    const mainTagMatches = tagIds.length === 0 || mainTags.some((tag) => tagIds.includes(tag.tagId));

    if (mainTagMatches && mainDate.getTime() >= startMs && mainDate.getTime() < endMs) {
      // Economic returns (dividends and redemption gains) belong to the
      // investment account, matching bond interest. The cash account remains
      // represented by the cash-flow TxRecord and does not affect the balance.
      entries.push({
        id: mainEntryId,
        entryId: mainEntryId,
        canEdit: false,
        date: mainDate,
        amount: primaryCashEntry?.amount ?? signedFundCashFlowAmount(primaryFlow?.kind, primaryFlow?.amount),
        fundSubtype: row.fundSubtype,
        fundProductType: row.fundProductType,
        realizedProfit: row.realizedProfit,
        fundUnits: row.units,
        fundNav: row.nav,
        fundFee: row.fee,
        fundCode: row.fundCode,
        fundName,
        accountId: row.fundAccountId,
        accountName: row.Account.name,
        counterpartyName: fundName,
        note: row.note ?? primaryCashEntry?.note ?? null,
        createdAt: primaryCashEntry?.createdAt ?? row.createdAt,
        tagIds: mainTags.map((tag) => tag.tagId),
        tags: mainTags.map((tag) => ({
          tagId: tag.tagId,
          id: tag.Tag.id,
          name: tag.Tag.name,
          color: tag.Tag.color,
        })),
      });
    }

    for (const flow of orderedFlows) {
      if (!isRefundFlow(flow.kind)) continue;
      const cashEntry = cashEntryById.get(flow.txRecordId) ?? null;
      const date = cashEntry?.date ?? flow.flowDate;
      const tags = cashEntry?.EntryTag ?? [];
      if (tagIds.length > 0 && !tags.some((tag) => tagIds.includes(tag.tagId))) continue;
      if (date.getTime() < startMs || date.getTime() >= endMs) continue;
      entries.push({
        id: flow.txRecordId,
        entryId: flow.txRecordId,
        canEdit: false,
        date,
        amount: cashEntry?.amount ?? signedFundCashFlowAmount(flow.kind, flow.amount),
        fundSubtype: FundSubtype.buy_failed,
        fundProductType: row.fundProductType,
        fundCode: row.fundCode,
        fundName,
        accountId: cashEntry?.accountId ?? flow.accountId ?? row.cashAccountId ?? row.fundAccountId,
        accountName: cashEntry?.account?.name ?? cashEntry?.accountName ?? row.CashAccount?.name ?? row.Account.name,
        counterpartyName: fundName,
        note: row.note ?? cashEntry?.note ?? null,
        createdAt: cashEntry?.createdAt ?? flow.createdAt,
        tagIds: tags.map((tag) => tag.tagId),
        tags: tags.map((tag) => ({
          tagId: tag.tagId,
          id: tag.Tag.id,
          name: tag.Tag.name,
          color: tag.Tag.color,
        })),
      });
    }
  }

  return entries;
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
  const cashEntryIds = Array.from(new Set(calcRows.map((row) => row.cashEntryId).filter(Boolean) as string[]));
  const cashEntries = cashEntryIds.length
    ? await prisma.txRecord.findMany({
        where: { householdId: ctx.householdId, id: { in: cashEntryIds }, deletedAt: null },
        select: {
          id: true,
          date: true,
          accountId: true,
          accountName: true,
          account: { select: { name: true } },
          note: true,
          createdAt: true,
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
  const startMs = params.start.getTime();
  const endMs = params.endExclusive.getTime();
  const profitByTransactionId = new Map<string, number>();
  const rowsByAccountId = new Map<string, typeof calcRows>();
  for (const row of calcRows) {
    const list = rowsByAccountId.get(row.accountId) ?? [];
    list.push(row);
    rowsByAccountId.set(row.accountId, list);
  }
  for (const accountRows of rowsByAccountId.values()) {
    const fundUnitsDecimals = normalizeFundUnitsDecimals(accountRows[0]?.Account?.fundUnitsDecimals, 2);
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

  return calcRows.flatMap((row): InvestmentStatisticSourceEntry[] => {
    const entryId = row.cashEntryId ?? row.id;
    if (excluded.has(row.id) || excluded.has(entryId)) return [];
    const cashEntry = row.cashEntryId ? cashEntryById.get(row.cashEntryId) ?? null : null;
    // 同上：理财赎回的到账日优先于现金腿 date。
    const statisticDate = isCashInAction(row.action) && row.arrivalDate
      ? row.arrivalDate
      : cashEntry?.date ?? row.tradeDate;
    const statisticMs = statisticDate.getTime();
    if (statisticMs < startMs || statisticMs >= endMs) return [];
    if (!isCashInAction(row.action) && row.realizedProfit == null && row.interest == null && row.fee == null) return [];
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
    // Attribute wealth returns to the wealth investment account, matching the
    // fund and bond conventions.
    const accountId = row.accountId;
    const accountName = row.Account.name;

    return [{
      id: `wealth:${row.id}`,
      entryId,
      canEdit: false,
      date: statisticDate,
      amount: displayAmount,
      fundSubtype: row.action,
      fundProductType: "wealth",
      realizedProfit: profitByTransactionId.get(row.id) ?? row.realizedProfit,
      depositInterest: row.interest,
      fundFee: row.fee,
      fundUnits: row.units,
      fundNav: row.nav,
      fundCode: null,
      fundName: productName,
      accountId,
      accountName,
      counterpartyName: productName || null,
      note: row.note ?? cashEntry?.note ?? null,
      createdAt: cashEntry?.createdAt ?? row.createdAt,
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
