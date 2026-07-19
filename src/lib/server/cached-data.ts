/**
 * 显示层跨请求缓存模块
 *
 * 原则（CLAUDE.md）：
 * - 初次读库 → 后续全走缓存 → 仅写入/编辑/删除时操作库 + 刷新缓存
 * - common 数据（不随账户变化）：unstable_cache 跨请求缓存
 * - per-account 数据（随账户变化）：React.cache() 请求级去重
 */

import { cache } from "react";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { listPreciousMetalDictionaries } from "@/lib/server/precious-metals";
import { entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";
import { loadFundTransactionEntryLike } from "@/lib/fund/transactions";
import {
  loadPreciousMetalTransactionEntryLike,
  loadWealthTransactionEntryLike,
} from "@/lib/server/business-transaction-entries";

// ── 类型 ──

export type CommonData = Awaited<ReturnType<typeof _loadCommonData>>;

export type BaseData = CommonData & {
  selectedAccount: Awaited<ReturnType<typeof loadSelectedAccount>>;
};

// ── Common 基础数据（跨账户共享，跨请求缓存） ──

async function _loadCommonData(hidFilter: { householdId: string }) {
  const [categories, accounts, tags, groups, institutions, counterparties, preciousMetalDictionaries] = await Promise.all([
    prisma.category.findMany({
      where: { ...hidFilter },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    prisma.account.findMany({
      where: { isPlaceholder: { not: true }, ...hidFilter },
      include: { Institution: true, Counterparty: true, AccountGroup: true, AccountAlias: true },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    }),
    prisma.tag.findMany({
      where: { ...hidFilter },
      orderBy: { name: "asc" },
    }),
    prisma.accountGroup.findMany({
      where: { ...hidFilter },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: { ...hidFilter },
      orderBy: { name: "asc" },
    }),
    prisma.counterparty.findMany({
      where: { ...hidFilter },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    listPreciousMetalDictionaries(hidFilter.householdId),
  ]);
  return { categories, accounts, tags, groups, institutions, counterparties, preciousMetalDictionaries };
}

/** 跨请求缓存：不随账户变化的数据 */
export const loadCommonData = unstable_cache(_loadCommonData, ["common-data"], {
  revalidate: false,
  tags: ["common-data"],
});

// ── Per-account 数据（请求级缓存，仅同一请求内去重） ──

export const loadSelectedAccount = cache(
  async (accountId: string | undefined, hidFilter: { householdId: string }) => {
    if (!accountId) return null;
    return prisma.account.findFirst({
      where: { id: accountId, isPlaceholder: { not: true }, ...hidFilter },
      include: { Institution: true, Counterparty: true, AccountGroup: true },
    });
  },
);

// ── entries 数据（请求级缓存） ──

async function _loadEntriesForAccount(
  accountId: string,
  hidFilterStr: string,
) {
  const hidFilter = JSON.parse(hidFilterStr) as { householdId: string };
  const hid = { householdId: hidFilter.householdId };
  const where = {
    OR: [{ accountId }, { toAccountId: accountId }],
    deletedAt: null,
    ...hid,
  };

  return prisma.txRecord.findMany({
    where,
    include: {
      EntryTag: { include: { Tag: true } },
      ...entryBusinessLinkSummaryInclude,
      account: {
        include: {
          Institution: { select: { name: true, shortName: true } },
          AccountGroup: { select: { name: true } },
        },
      },
      toAccount: {
        include: {
          Institution: { select: { name: true, shortName: true } },
          AccountGroup: { select: { name: true } },
        },
      },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 5000,
  });
}

/**
 * 账户交易明细可能超过 Next.js data cache 单项 2MB 上限。
 * 这里只做 React.cache 请求级去重，避免大账户写入 unstable_cache 失败。
 */
export const loadEntriesForAccount = cache(_loadEntriesForAccount);

async function _loadInvestBalances(_hidFilterStr: string) {
  const hidFilter = JSON.parse(_hidFilterStr) as { householdId: string };
  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };

  const balances = await computeInvestBalances(ctx);
  return Object.fromEntries(balances);
}

export const loadInvestBalances = unstable_cache(
  _loadInvestBalances,
  ["invest-balances"],
  { revalidate: false, tags: ["invest-balances", "fund-holding"] },
);

// ── 投资账户持仓数据（请求级缓存） ──

async function _loadInvestAccountData(
  _hidFilterStr: string,
  accountId: string,
  _paramsStr: string,
) {
  const hidFilter = JSON.parse(_hidFilterStr) as { householdId: string };
  const params = JSON.parse(_paramsStr) as {
    fundSortParam: string;
    fundSortDirParam: "asc" | "desc";
    fundPageSize: number;
    fundPage: number;
    fundCodeParam: string;
    wealthProductIdParam?: string;
  };

  const ctx: HouseholdContext = {
    householdId: hidFilter.householdId,
    hidFilter,
    user: null,
  };

  const account = await prisma.account.findFirst({
    where: { id: accountId, isPlaceholder: { not: true }, ...hidFilter },
  });
  if (!account) return null;

  const positionDisplay = await computePositionDisplay(ctx, accountId);

  const dir = params.fundSortDirParam === "asc" ? 1 : -1;
  const sortFn = (a: { marketValue: number; cost: number; floatingPnL: number; floatingPnLRate: number; historicalProfit: number; fundCode: string }, b: typeof a) => {
    let value = 0;
    switch (params.fundSortParam) {
      case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
      case "cost": value = a.cost - b.cost; break;
      case "floatingPnL": value = a.floatingPnL - b.floatingPnL; break;
      case "floatingPnLRate": value = a.floatingPnLRate - b.floatingPnLRate; break;
      case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
      case "marketValue":
      default: value = a.marketValue - b.marketValue; break;
    }
    return value * dir;
  };

  positionDisplay.positions = [...positionDisplay.positions].sort(sortFn);

  const clearedSortFn = (a: { fundCode: string; firstBuyDate: string; clearedDate: string; returnRate: number; historicalProfit: number }, b: typeof a) => {
    let value = 0;
    switch (params.fundSortParam) {
      case "fundCode": value = a.fundCode.localeCompare(b.fundCode); break;
      case "firstBuyDate": value = a.firstBuyDate.localeCompare(b.firstBuyDate); break;
      case "clearedDate": value = a.clearedDate.localeCompare(b.clearedDate); break;
      case "returnRate": value = a.returnRate - b.returnRate; break;
      case "historicalProfit": value = a.historicalProfit - b.historicalProfit; break;
      case "clearedDate":
      default: value = a.clearedDate.localeCompare(b.clearedDate); break;
    }
    return value * dir;
  };
  positionDisplay.clearedPositions = [...positionDisplay.clearedPositions].sort(clearedSortFn);

  const selectedFundCode =
    account.investProductType === "wealth"
      ? (params.wealthProductIdParam || "")
      : params.fundCodeParam ||
        (positionDisplay.positions.length > 0
          ? positionDisplay.positions[0]!.fundCode
          : positionDisplay.clearedPositions.length > 0
            ? positionDisplay.clearedPositions[0]!.fundCode
            : "");

  const fundEntries =
    account.investProductType === "wealth"
      ? await loadWealthTransactionEntryLike({
          householdId: hidFilter.householdId,
          accountIds: [accountId],
        })
      : account.investProductType === "metal"
        ? await loadPreciousMetalTransactionEntryLike({
            householdId: hidFilter.householdId,
            accountIds: [accountId],
          })
        : await loadFundTransactionEntryLike({
            householdId: hidFilter.householdId,
            accountId,
            entryScope: "account",
          });

  const feeRateRecords = await prisma.fundFeeRate.findMany({
    where: { accountId },
    orderBy: { effectiveDate: "desc" },
  });
  const feeRateMap = new Map<string, string>();
  for (const fr of feeRateRecords) {
    const key = `${fr.fundCode}:${fr.feeType}`;
    if (!feeRateMap.has(key)) feeRateMap.set(key, String(fr.rate));
  }

  const confirmDaysRecords = await prisma.fundConfirmDays.findMany({
    where: { accountId },
  });
  const confirmDaysMap = new Map<string, number>();
  for (const cd of confirmDaysRecords) {
    confirmDaysMap.set(cd.fundCode, cd.days ?? 0);
  }

  const pendingByCode = new Map<string, number>();
  for (const p of positionDisplay.positions) {
    if (p.pendingCost > 0) pendingByCode.set(p.fundCode, p.pendingCost);
  }

  const filtered = selectedFundCode
    ? fundEntries.filter((e: any) =>
        account.investProductType === "wealth"
          ? e.wealthProductId === selectedFundCode
          : account.investProductType === "metal"
            ? e.metalTypeId === selectedFundCode
            : e.fundCode === selectedFundCode
      )
    : fundEntries;
  const totalEntries = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / params.fundPageSize));
  const safePage = Math.min(params.fundPage, totalPages);
  const pagedEntries = filtered.slice(
    (safePage - 1) * params.fundPageSize,
    safePage * params.fundPageSize,
  );

  return {
    ...positionDisplay,
    filteredEntries: pagedEntries,
    allEntries: fundEntries,
    totalEntries,
    totalPages,
    safePage,
    selectedFundCode,
    selectedWealthProductId: account.investProductType === "wealth" ? selectedFundCode : "",
    pendingByCode: Object.fromEntries(pendingByCode),
    feeRateMap: Object.fromEntries(feeRateMap),
    confirmDaysMap: Object.fromEntries(confirmDaysMap),
    account,
  };
}

/**
 * 投资账户持仓+明细数据可能包含大量 allEntries。
 * Next.js data cache 单项有 2MB 上限，因此这里只做请求级去重，避免基金明细较多时写入 unstable_cache 失败。
 */
export const loadInvestAccountData = cache(_loadInvestAccountData);
