import { FundSubtype } from "@prisma/client";

import { toNumber, todayDateBusinessYmd } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdPreferences } from "@/lib/server/household-preferences";
import type { RepoOccupiedDaysMode } from "@/lib/preferences";
import {
  estimateRepoFee,
  estimateRepoInterest,
  repoOccupiedDays,
  repoProductFromLabel,
} from "@/lib/repo";
import { loadBondTransactionEntryLike } from "@/lib/server/business-transaction-entries";

/**
 * 逆回购视图（股票页 › 逆回购页签）的数据口径。
 *
 * 逆回购存单就是 bond_transactions 里 instrumentKind = "repo" 的 buy 行：
 *   - 本金固定、年化固定、到期一次还本付息，没有付息计划；
 *   - 回款 = 同一存单的 redeem 子行（sourceBondTransactionId 指回 buy 行）；
 *   - 利息按**实际占款天数**（成交日 → 回款日）计，不按名义期限。
 * 这里只做投影，不写库；落账见 repo-transactions.ts。
 */

export type RepoShellLot = {
  id: string;
  /** 品种名，如 `GC001 · 1天`。 */
  name: string;
  /** 交易代码（从品种名回推，取不到时为空）。 */
  code: string | null;
  termDays: number | null;
  annualRate: number | null;
  /** 借出本金（未回款部分）。 */
  principal: number;
  startDate: string | null;
  maturityDate: string | null;
  clearedDate: string | null;
  /** 占款天数（成交日 → 回款日 / 到期日）。 */
  occupiedDays: number | null;
  /** 距到期还剩几天（已回款为 null，过期未回款为负数）。 */
  remainingDays: number | null;
  /** 手续费（交易所按期限分档，借出时一次性收）。 */
  fee: number | null;
  /** 预计利息（借出时按占款天数推算）。 */
  expectedInterest: number | null;
  /** 实际利息（回款后 = 回款行的 interest）。 */
  actualInterest: number | null;
  /** 已实现收益（= 实际利息 − 手续费）。 */
  realizedProfit: number;
  status: "open" | "closed";
  /** 该存单在明细表里的分录 id，用于点中收窄明细。 */
  relatedEntryIds: string[];
};

export type RepoShellData = {
  account: {
    id: string;
    name: string;
    institutionName: string;
    currency: string;
  };
  lots: RepoShellLot[];
  entries: Awaited<ReturnType<typeof loadBondTransactionEntryLike>>;
  /** 未回款本金合计。 */
  totalPrincipal: number;
  /** 未回款存单的预计利息合计。 */
  totalExpectedInterest: number;
  /** 已实现收益合计（含已回款与部分回款）。 */
  totalRealizedProfit: number;
  openCount: number;
  /** 录入弹窗默认资金账户（取最近一笔借出的券商资金账户）。 */
  defaultCashAccountId: string | null;
};

const CLEAR_ACTIONS = new Set<string>([FundSubtype.redeem, FundSubtype.switch_out]);
const PRINCIPAL_EPSILON = 0.005;

type RepoRow = {
  id: string;
  accountId: string;
  cashAccountId: string | null;
  cashEntryId: string | null;
  productName: string | null;
  sourceBondTransactionId: string | null;
  action: string;
  tradeDate: Date;
  grossAmount: unknown;
  arrivalAmount: unknown;
  interest: unknown;
  fee: unknown;
  realizedProfit: unknown;
  annualRate: unknown;
  termDays: number | null;
  maturityDate: Date | null;
  createdAt: Date;
};

function ymd(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function daysBetween(fromKey: string | null, toKey: string | null): number | null {
  if (!fromKey || !toKey) return null;
  const from = new Date(`${fromKey}T00:00:00.000Z`).getTime();
  const to = new Date(`${toKey}T00:00:00.000Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86400000);
}

/**
 * 占款天数，口径由账簿设置决定（`RepoOccupiedDaysMode`，见 `repoOccupiedDays`）。
 * 未回款时才用品种期限兜底。
 * 与落账（repo-transactions）和录入预览（RepoEntryFields）共用 `repoOccupiedDays`，
 * 三处口径必须一致，否则列表写的利息和落库的利息会对不上。
 */
function occupiedDaysOf(
  startKey: string,
  endKey: string | null,
  termDays: number | null | undefined,
  mode: RepoOccupiedDaysMode,
): number | null {
  if (!endKey) return termDays ?? null;
  return repoOccupiedDays(startKey, endKey, termDays, mode) || termDays || null;
}

/** 逆回购存单投影（视图与回款弹窗共用同一份口径）。 */
export function projectRepoLots(
  rows: RepoRow[],
  todayKey: string,
  occupiedDaysMode: RepoOccupiedDaysMode = "actual",
): RepoShellLot[] {
  type LotAcc = {
    id: string;
    name: string;
    annualRate: number | null;
    termDays: number | null;
    startKey: string;
    maturityKey: string | null;
    principal: number;
    fee: number | null;
    expectedInterest: number | null;
    actualInterest: number | null;
    realizedProfit: number;
    clearedDate: string | null;
    relatedEntryIds: string[];
  };

  const lots: LotAcc[] = [];
  const lotById = new Map<string, LotAcc>();
  const lotsByName = new Map<string, LotAcc[]>();
  const entryIdOf = (row: RepoRow) => row.cashEntryId ?? row.id;

  for (const row of rows) {
    if (row.action !== FundSubtype.buy) continue;
    const name = row.productName ?? "";
    const startKey = ymd(row.tradeDate) ?? todayKey;
    const maturityKey = ymd(row.maturityDate);
    const principal = Math.abs(toNumber(row.grossAmount));
    const occupiedDays = occupiedDaysOf(startKey, maturityKey, row.termDays, occupiedDaysMode);
    const lot: LotAcc = {
      id: row.id,
      name,
      annualRate: row.annualRate == null ? null : Number(row.annualRate),
      termDays: row.termDays ?? null,
      startKey,
      maturityKey,
      principal,
      fee: row.fee == null ? null : Number(row.fee),
      expectedInterest: row.interest == null ? null : Number(row.interest),
      actualInterest: null,
      realizedProfit: 0,
      clearedDate: null,
      relatedEntryIds: [entryIdOf(row)],
    };
    // 借出行没有落利息时，用同一公式补一个预计值（占款天数口径）。
    if (lot.expectedInterest == null && occupiedDays) {
      const estimated = estimateRepoInterest({
        principal,
        annualRate: lot.annualRate,
        occupiedDays,
      });
      lot.expectedInterest = estimated > 0 ? estimated : null;
    }
    lots.push(lot);
    lotById.set(lot.id, lot);
    const list = lotsByName.get(name) ?? [];
    list.push(lot);
    lotsByName.set(name, list);
  }

  for (const row of rows) {
    if (row.action === FundSubtype.buy) continue;
    const explicit = row.sourceBondTransactionId ? lotById.get(row.sourceBondTransactionId) : undefined;
    const candidates = lotsByName.get(row.productName ?? "") ?? [];
    // 没有关联列的老数据：只有一张同品种存单时才自动归属（多张不摊派）。
    const lot = explicit ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!lot) continue;

    lot.relatedEntryIds.push(entryIdOf(row));
    if (CLEAR_ACTIONS.has(row.action)) {
      lot.principal -= Math.abs(toNumber(row.grossAmount));
      const interest = toNumber(row.interest);
      lot.actualInterest = (lot.actualInterest ?? 0) + (interest > 0 ? interest : Math.max(0, toNumber(row.realizedProfit)));
      lot.realizedProfit += toNumber(row.realizedProfit);
      const clearedKey = ymd(row.tradeDate);
      if (clearedKey && (!lot.clearedDate || clearedKey > lot.clearedDate)) lot.clearedDate = clearedKey;
    }
  }

  return lots
    .map((lot) => {
      const principal = Math.max(0, Number(lot.principal.toFixed(2)));
      const status: RepoShellLot["status"] = principal > PRINCIPAL_EPSILON ? "open" : "closed";
      const product = repoProductFromLabel(lot.name);
      const occupiedDays = occupiedDaysOf(
        lot.startKey,
        lot.clearedDate ?? lot.maturityKey,
        lot.termDays,
        occupiedDaysMode,
      );
      return {
        id: lot.id,
        name: lot.name,
        code: product?.code ?? null,
        termDays: lot.termDays ?? product?.termDays ?? null,
        annualRate: lot.annualRate,
        principal,
        startDate: lot.startKey,
        maturityDate: lot.maturityKey,
        clearedDate: lot.clearedDate,
        occupiedDays,
        remainingDays:
          status === "open" && lot.maturityKey ? daysBetween(todayKey, lot.maturityKey) : null,
        fee: lot.fee ?? (product ? estimateRepoFee(principal, product.termDays) : null),
        expectedInterest: lot.expectedInterest,
        actualInterest:
          lot.actualInterest == null ? null : Number(lot.actualInterest.toFixed(2)),
        realizedProfit: Number(lot.realizedProfit.toFixed(2)),
        status,
        relatedEntryIds: lot.relatedEntryIds,
      } satisfies RepoShellLot;
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "open" ? -1 : 1;
      return (b.startDate ?? "").localeCompare(a.startDate ?? "");
    });
}

export async function loadRepoShellData(params: {
  householdId: string;
  accountId: string;
  /** 业务日（家庭时区）；不传则按家庭偏好现算。 */
  todayKey?: string;
}): Promise<RepoShellData | null> {
  const { householdId, accountId } = params;
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isPlaceholder: { not: true } },
    include: { Institution: true },
  });
  if (!account) return null;
  const preferences = await getHouseholdPreferences(householdId);
  const todayKey = params.todayKey ?? todayDateBusinessYmd(preferences.timeZone);

  const [rows, entries] = await Promise.all([
    prisma.bondTransaction.findMany({
      where: { householdId, accountId, deletedAt: null, instrumentKind: "repo" },
      select: {
        id: true,
        accountId: true,
        cashAccountId: true,
        cashEntryId: true,
        productName: true,
        sourceBondTransactionId: true,
        action: true,
        tradeDate: true,
        grossAmount: true,
        arrivalAmount: true,
        interest: true,
        fee: true,
        realizedProfit: true,
        annualRate: true,
        termDays: true,
        maturityDate: true,
        createdAt: true,
      },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    }),
    loadBondTransactionEntryLike({
      householdId,
      accountIds: [accountId],
      instrumentKinds: ["repo"],
    }),
  ]);

  const lots = projectRepoLots(rows, todayKey, preferences.repoOccupiedDaysMode);
  const openLots = lots.filter((lot) => lot.status === "open");
  const latestBuy = [...rows].reverse().find((row) => row.action === FundSubtype.buy);

  return {
    account: {
      id: account.id,
      name: account.name,
      institutionName: account.Institution?.shortName || account.Institution?.name || "",
      currency: account.currency,
    },
    lots,
    entries,
    totalPrincipal: Number(openLots.reduce((sum, lot) => sum + lot.principal, 0).toFixed(2)),
    totalExpectedInterest: Number(
      openLots.reduce((sum, lot) => sum + (lot.expectedInterest ?? 0), 0).toFixed(2),
    ),
    totalRealizedProfit: Number(lots.reduce((sum, lot) => sum + lot.realizedProfit, 0).toFixed(2)),
    openCount: openLots.length,
    defaultCashAccountId: latestBuy?.cashAccountId ?? null,
  };
}
