import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { LinkedFundForReorder, LinkedWealthForReorder } from "@/lib/entry-reorder";

/** 与 account-balance.ts 的 BalanceDbClient 同型：允许传事务 client。 */
type EntryBusinessDisplayClient = Prisma.TransactionClient | typeof prisma;

/**
 * 明细行的「业务生效日」回填数据源。
 *
 * 背景：基金独立交易保存时会把 TxRecord 上的 `fundSubtype` / `fundArrivalDate`
 * 清空（业务事实只存在 `fund_transactions`），明细展示层（transactions/detail）
 * 一直用 FundTransaction 覆盖这几列，但排序层（detail-page-query 的 SQL）、
 * RSC 的本地排序（page.tsx）和余额层（account-balance）此前没有这份兜底，
 * 导致赎回行按 `date`（申请日）而不是到账日排序 / 计息。
 *
 * 这里按 entryId 返回关联基金交易的 `fundSubtype` / `arrivalDate` / `cashAccountId`，
 * 由 `rowWithLinkedFundDisplayDate` 投影成明细行的形态，保证三层口径一致。
 * 同一条 TxRecord 若同时挂在 link 的 cashEntryId 与 businessEntryId 上，
 * 优先取 cashEntryId 那一侧（与 detail-page-query 的 wealth/fund candidates 优先级一致）。
 */
export type EntryLinkedFundDisplay = LinkedFundForReorder;

export async function loadEntryLinkedFundDisplay(
  entryIds: Array<string | null | undefined>,
  householdId: string | null | undefined,
  client: EntryBusinessDisplayClient = prisma,
): Promise<Map<string, EntryLinkedFundDisplay>> {
  const map = new Map<string, EntryLinkedFundDisplay>();
  const ids = Array.from(new Set(entryIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0 || !householdId) return map;
  const idSet = new Set(ids);

  const links = await client.entryBusinessLink.findMany({
    where: {
      householdId,
      deletedAt: null,
      fundTransactionId: { not: null },
      OR: [{ cashEntryId: { in: ids } }, { businessEntryId: { in: ids } }],
    },
    select: {
      id: true,
      cashEntryId: true,
      businessEntryId: true,
      FundTransaction: {
        select: { fundSubtype: true, arrivalDate: true, cashAccountId: true, deletedAt: true },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const priorityByEntryId = new Map<string, number>();
  for (const link of links) {
    const fundRow = link.FundTransaction;
    if (!fundRow || fundRow.deletedAt) continue;
    const display: EntryLinkedFundDisplay = {
      fundSubtype: fundRow.fundSubtype,
      arrivalDate: fundRow.arrivalDate,
      cashAccountId: fundRow.cashAccountId,
      deletedAt: fundRow.deletedAt,
    };
    const candidates: Array<[string | null, number]> = [
      [link.cashEntryId, 0],
      [link.businessEntryId, 1],
    ];
    for (const [entryId, priority] of candidates) {
      if (!entryId || !idSet.has(entryId)) continue;
      const current = priorityByEntryId.get(entryId);
      if (current != null && current <= priority) continue;
      priorityByEntryId.set(entryId, priority);
      map.set(entryId, display);
    }
  }
  return map;
}

export type EntryLinkedWealthDisplay = LinkedWealthForReorder;

/**
 * 理财侧的同一份回填数据源（`wealth_transactions`）。
 *
 * 与基金同理：理财独立交易的 TxRecord 上不写 `fundSubtype` / `fundArrivalDate`，
 * 只保留现金腿，到账日只存在 WealthTransaction。缺失时理财赎回会在资金侧
 * 按申请日而不是入账日排序 / 显示 / 计息（detail-page-query 的 wealth_candidates
 * 只覆盖了 SQL 一侧）。
 */
export async function loadEntryLinkedWealthDisplay(
  entryIds: Array<string | null | undefined>,
  householdId: string | null | undefined,
  client: EntryBusinessDisplayClient = prisma,
): Promise<Map<string, EntryLinkedWealthDisplay>> {
  const map = new Map<string, EntryLinkedWealthDisplay>();
  const ids = Array.from(new Set(entryIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (ids.length === 0 || !householdId) return map;
  const idSet = new Set(ids);

  const links = await client.entryBusinessLink.findMany({
    where: {
      householdId,
      deletedAt: null,
      wealthTransactionId: { not: null },
      OR: [{ cashEntryId: { in: ids } }, { businessEntryId: { in: ids } }],
    },
    select: {
      id: true,
      cashEntryId: true,
      businessEntryId: true,
      WealthTransaction: {
        select: { action: true, arrivalDate: true, cashAccountId: true, deletedAt: true },
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const priorityByEntryId = new Map<string, number>();
  for (const link of links) {
    const wealthRow = link.WealthTransaction;
    if (!wealthRow || wealthRow.deletedAt) continue;
    const display: EntryLinkedWealthDisplay = {
      action: wealthRow.action,
      arrivalDate: wealthRow.arrivalDate,
      cashAccountId: wealthRow.cashAccountId,
      deletedAt: wealthRow.deletedAt,
    };
    const candidates: Array<[string | null, number]> = [
      [link.cashEntryId, 0],
      [link.businessEntryId, 1],
    ];
    for (const [entryId, priority] of candidates) {
      if (!entryId || !idSet.has(entryId)) continue;
      const current = priorityByEntryId.get(entryId);
      if (current != null && current <= priority) continue;
      priorityByEntryId.set(entryId, priority);
      map.set(entryId, display);
    }
  }
  return map;
}

export type EntryLinkedInvestmentDisplay = {
  fund: Map<string, EntryLinkedFundDisplay>;
  wealth: Map<string, EntryLinkedWealthDisplay>;
};

/**
 * 一次取齐基金 + 理财两侧的业务生效日回填数据。
 *
 * 明细展示层（transactions/detail）两侧都会覆盖，排序 / 余额 / RSC 首屏也必须
 * 同时覆盖，否则同一行在首屏与接口刷新后会显示不同的日期。
 */
export async function loadEntryLinkedInvestmentDisplay(
  entryIds: Array<string | null | undefined>,
  householdId: string | null | undefined,
  client: EntryBusinessDisplayClient = prisma,
): Promise<EntryLinkedInvestmentDisplay> {
  const [fund, wealth] = await Promise.all([
    loadEntryLinkedFundDisplay(entryIds, householdId, client),
    loadEntryLinkedWealthDisplay(entryIds, householdId, client),
  ]);
  return { fund, wealth };
}
