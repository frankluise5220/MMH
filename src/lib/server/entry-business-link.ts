import { Prisma, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { isFundUnitsReconcileEntry, isLicensedInsuranceEntry } from "@/lib/transaction-semantics";
import { chunk, IN_CHUNK_SIZE } from "@/lib/server/prisma-in-chunks";
import type { HouseholdContext } from "@/lib/server/household-scope";

type TxClient = Prisma.TransactionClient | typeof prisma;

type EntryBusinessLinkMetadata = Record<string, Prisma.InputJsonValue | null>;

export function mergeEntryBusinessLinkMetadata(
  metadata: Prisma.JsonValue | null | undefined,
  patch: EntryBusinessLinkMetadata,
): EntryBusinessLinkMetadata {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as EntryBusinessLinkMetadata) }
      : {};
  return { ...base, ...patch };
}

function inputJsonObjectOf(value: Record<string, unknown> | null | undefined, fallback: EntryBusinessLinkMetadata) {
  const source = value ?? fallback;
  return JSON.parse(JSON.stringify(source)) as EntryBusinessLinkMetadata;
}

export type EntryBusinessType = "fund" | "stock" | "wealth" | "bond" | "deposit" | "insurance" | "metal" | "property" | "other_investment";
export type EntryCashFlowDirection = "outflow" | "inflow" | "internal" | "none";
export type EntryBusinessDeleteImpact = {
  linkId: string;
  selectedEntryId: string;
  selectedSide: "cash" | "business" | "both";
  entryId: string;
  businessEntryId: string;
  counterpartEntryId?: string | null;
  counterpartLabel?: string;
  businessType: EntryBusinessType;
  businessLabel: string;
  linkType: string;
  legacyCombinedRecord: boolean;
  /** 该业务单在业务侧（如投资侧）另外显示的派生行数。整笔删除的提示需要把它算进
   * 「将删除 N 条记录」：资金侧腿各占一行，业务侧派生行（买入/退回等）也各占一行。 */
  businessDisplayRowCount?: number;
};

type EntryBusinessLinkSummaryRow = {
  id?: string | null;
  cashEntryId?: string | null;
  businessEntryId?: string | null;
  fundTransactionId?: string | null;
  insuranceTransactionId?: string | null;
  wealthTransactionId?: string | null;
  bondTransactionId?: string | null;
  depositTransactionId?: string | null;
  preciousMetalTransactionId?: string | null;
  stockTransactionId?: string | null;
  propertyTransactionId?: string | null;
  businessType: EntryBusinessType | string;
  linkType?: string | null;
  CashEntry?: { id: string; deletedAt?: Date | null } | null;
  BusinessEntry?: { id: string; deletedAt?: Date | null } | null;
  FundTransaction?: {
    id: string;
    deletedAt?: Date | null;
    fundAccountId?: string | null;
    source?: string | null;
    Account?: { id: string; name?: string | null } | null;
  } | null;
  InsuranceTransaction?: { id: string; deletedAt?: Date | null } | null;
  WealthTransaction?: { id: string; deletedAt?: Date | null } | null;
  BondTransaction?: { id: string; deletedAt?: Date | null } | null;
  DepositTransaction?: { id: string; deletedAt?: Date | null } | null;
  PreciousMetalTransaction?: { id: string; deletedAt?: Date | null } | null;
  StockTransaction?: {
    id: string;
    deletedAt?: Date | null;
    cashEntryId?: string | null;
    stockAccountId?: string | null;
    cashAccountId?: string | null;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
    stockName?: string | null;
    action?: string | null;
    tradeDate?: Date | null;
    settleDate?: Date | null;
    grossAmount?: unknown;
    netAmount?: unknown;
    quantity?: unknown;
    price?: unknown;
    brokerTradeId?: string | null;
    note?: string | null;
  } | null;
  PropertyTransaction?: { id: string; deletedAt?: Date | null } | null;
};

const STOCK_TRANSACTION_SUMMARY_SELECT = {
  id: true,
  deletedAt: true,
  cashEntryId: true,
  stockAccountId: true,
  cashAccountId: true,
  securityId: true,
  market: true,
  stockCode: true,
  stockName: true,
  action: true,
  tradeDate: true,
  settleDate: true,
  grossAmount: true,
  netAmount: true,
  quantity: true,
  price: true,
  brokerTradeId: true,
  note: true,
} as const;

export const entryBusinessLinkSummaryInclude = {
  EntryBusinessLinkCash: {
    where: { deletedAt: null },
    select: {
      id: true,
      cashEntryId: true,
      businessEntryId: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      bondTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      stockTransactionId: true,
      propertyTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: {
        select: {
          id: true,
          deletedAt: true,
          fundAccountId: true,
          source: true,
          Account: { select: { id: true, name: true } },
        },
      },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      BondTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
      StockTransaction: { select: STOCK_TRANSACTION_SUMMARY_SELECT },
      PropertyTransaction: { select: { id: true, deletedAt: true } },
    },
  },
  EntryBusinessLinkBusiness: {
    where: { deletedAt: null },
    select: {
      id: true,
      cashEntryId: true,
      businessEntryId: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      bondTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      stockTransactionId: true,
      propertyTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: {
        select: {
          id: true,
          deletedAt: true,
          fundAccountId: true,
          source: true,
          Account: { select: { id: true, name: true } },
        },
      },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      BondTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
      StockTransaction: { select: STOCK_TRANSACTION_SUMMARY_SELECT },
      PropertyTransaction: { select: { id: true, deletedAt: true } },
    },
  },
} as const;

type BusinessEntryLike = {
  id: string;
  householdId?: string | null;
  type?: TransactionType | string | null;
  amount?: unknown;
  fundProductType?: string | null;
  fundCode?: string | null;
  fundSubtype?: string | null;
  source?: string | null;
  wealthProductId?: string | null;
  bondProductId?: string | null;
  insuranceProductId?: string | null;
  metalTypeId?: string | null;
  depositSourceEntryId?: string | null;
  stockTransactionId?: string | null;
  propertyTransactionId?: string | null;
  createdAt?: Date | string | null;
};

export function classifyEntryBusinessType(entry: BusinessEntryLike): EntryBusinessType | null {
  if (!entry.householdId) return null;
  const isInvestmentEntry = entry.type === TransactionType.investment || entry.type === "investment";
  const hasBusinessFields = Boolean(
    entry.fundProductType ||
      entry.fundCode ||
      entry.wealthProductId ||
      entry.bondProductId ||
      entry.insuranceProductId ||
      isLicensedInsuranceEntry(entry) ||
      entry.metalTypeId ||
      entry.depositSourceEntryId ||
      entry.stockTransactionId ||
      entry.propertyTransactionId,
  );
  if (!isInvestmentEntry || !hasBusinessFields) return null;

  if (isLicensedInsuranceEntry(entry)) return "insurance";
  // 债券走独立业务行（bond_transactions），不再冒充理财。
  if (entry.fundProductType === "bond" || entry.bondProductId) return "bond";
  if (entry.fundProductType === "wealth" || entry.wealthProductId) return "wealth";
  if (entry.fundProductType === "deposit" || entry.depositSourceEntryId) return "deposit";
  if (entry.fundProductType === "metal" || entry.metalTypeId) return "metal";
  if (entry.fundProductType === "stock" || entry.stockTransactionId) return "stock";
  if (entry.propertyTransactionId) return "property";
  if (entry.fundProductType === "fund" || entry.fundProductType === "money" || entry.fundCode) return "fund";
  return "other_investment";
}

function classifyEntryCashFlowDirection(entry: BusinessEntryLike): EntryCashFlowDirection {
  if (entry.fundSubtype === "dividend_reinvest") return "internal";
  const amount = toNumber(entry.amount);
  if (amount < 0) return "outflow";
  if (amount > 0) return "inflow";
  return "none";
}

export async function upsertLegacyCombinedEntryBusinessLink(client: TxClient, entry: BusinessEntryLike) {
  const businessType = classifyEntryBusinessType(entry);
  if (!businessType || !entry.householdId) return false;

  const linkId = `ebl_${entry.id}`;
  const direction = classifyEntryCashFlowDirection(entry);
  const createdAt = entry.createdAt instanceof Date ? entry.createdAt : new Date();

  const existing = await client.entryBusinessLink.findFirst({
    where: {
      cashEntryId: entry.id,
      businessEntryId: entry.id,
      linkType: "legacy_combined_record",
    },
    select: { id: true },
  });

  if (existing) {
    await client.entryBusinessLink.update({
      where: { id: existing.id },
      data: {
        businessType,
        cashFlowDirection: direction,
        source: entry.source ?? "manual",
        metadata: { legacyCombinedRecord: true },
        deletedAt: null,
      },
    });
  } else {
    await client.entryBusinessLink.create({
      data: {
        id: linkId,
        householdId: entry.householdId,
        cashEntryId: entry.id,
        businessEntryId: entry.id,
        businessType,
        linkType: "legacy_combined_record",
        cashFlowDirection: direction,
        source: entry.source ?? "manual",
        note: "Legacy combined cash/business TxRecord",
        metadata: { legacyCombinedRecord: true },
        createdAt,
      },
    });
  }
  return true;
}

export async function upsertLegacyCombinedEntryBusinessLinks(entryIds: string[], client: TxClient = prisma) {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) return 0;
  const rows = await client.txRecord.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      householdId: true,
      type: true,
      amount: true,
      fundProductType: true,
      fundCode: true,
      fundSubtype: true,
      source: true,
      wealthProductId: true,
      insuranceProductId: true,
      metalTypeId: true,
      depositSourceEntryId: true,
      createdAt: true,
    },
  });

  let count = 0;
  for (const row of rows) {
    if (await upsertLegacyCombinedEntryBusinessLink(client, row)) count += 1;
  }
  return count;
}

export async function upsertEntryBusinessCashFlowLink(
  client: TxClient,
  params: {
    householdId: string;
    cashEntryId: string | null;
    businessEntryId?: string | null;
    fundTransactionId?: string | null;
    insuranceTransactionId?: string | null;
    wealthTransactionId?: string | null;
    bondTransactionId?: string | null;
    depositTransactionId?: string | null;
    preciousMetalTransactionId?: string | null;
    stockTransactionId?: string | null;
    propertyTransactionId?: string | null;
    businessType: EntryBusinessType;
    cashFlowDirection?: EntryCashFlowDirection | null;
    source?: string | null;
    note?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const businessTarget =
    params.fundTransactionId ? `fund_${params.fundTransactionId}`
      : params.insuranceTransactionId ? `insurance_${params.insuranceTransactionId}`
        : params.wealthTransactionId ? `wealth_${params.wealthTransactionId}`
        : params.bondTransactionId ? `bond_${params.bondTransactionId}`
          : params.depositTransactionId ? `deposit_${params.depositTransactionId}`
            : params.preciousMetalTransactionId ? `metal_${params.preciousMetalTransactionId}`
              : params.stockTransactionId ? `stock_${params.stockTransactionId}`
                : params.propertyTransactionId ? `property_${params.propertyTransactionId}`
                  : params.businessEntryId ? `entry_${params.businessEntryId}`
                    : "";
  if (!businessTarget) return;

  const linkId = params.cashEntryId
    ? `ebl_${params.cashEntryId}_${businessTarget}`
    : `ebl_business_${businessTarget}`;
  const metadata = inputJsonObjectOf(params.metadata, { splitRecord: true });
  await client.entryBusinessLink.upsert({
    where: { id: linkId },
    create: {
      id: linkId,
      householdId: params.householdId,
      cashEntryId: params.cashEntryId,
      businessEntryId: params.businessEntryId ?? null,
      fundTransactionId: params.fundTransactionId ?? null,
      insuranceTransactionId: params.insuranceTransactionId ?? null,
      wealthTransactionId: params.wealthTransactionId ?? null,
      bondTransactionId: params.bondTransactionId ?? null,
      depositTransactionId: params.depositTransactionId ?? null,
      preciousMetalTransactionId: params.preciousMetalTransactionId ?? null,
      stockTransactionId: params.stockTransactionId ?? null,
      propertyTransactionId: params.propertyTransactionId ?? null,
      businessType: params.businessType,
      linkType: "cash_flow",
      cashFlowDirection: params.cashFlowDirection ?? "none",
      source: params.source ?? "manual",
      note: params.note ?? null,
      metadata,
    },
    update: {
      cashEntryId: params.cashEntryId,
      businessEntryId: params.businessEntryId ?? null,
      fundTransactionId: params.fundTransactionId ?? null,
      insuranceTransactionId: params.insuranceTransactionId ?? null,
      wealthTransactionId: params.wealthTransactionId ?? null,
      bondTransactionId: params.bondTransactionId ?? null,
      depositTransactionId: params.depositTransactionId ?? null,
      preciousMetalTransactionId: params.preciousMetalTransactionId ?? null,
      stockTransactionId: params.stockTransactionId ?? null,
      propertyTransactionId: params.propertyTransactionId ?? null,
      businessType: params.businessType,
      cashFlowDirection: params.cashFlowDirection ?? "none",
      source: params.source ?? "manual",
      note: params.note ?? null,
      metadata,
      deletedAt: null,
    },
  });
  return linkId;
}

export function entryBusinessTypeLabel(type: EntryBusinessType | string) {
  if (type === "insurance") return "保险交易";
  if (type === "wealth") return "理财交易";
  if (type === "bond") return "债券交易";
  if (type === "deposit") return "存款交易";
  if (type === "metal") return "贵金属交易";
  if (type === "stock") return "股票交易";
  if (type === "property") return "房产交易";
  if (type === "fund") return "基金交易";
  return "投资业务交易";
}

export function buildEntryBusinessLinkSummary(entry: {
  EntryBusinessLinkCash?: EntryBusinessLinkSummaryRow[] | null;
  EntryBusinessLinkBusiness?: EntryBusinessLinkSummaryRow[] | null;
}) {
  const uniqueRows = new Map<string, EntryBusinessLinkSummaryRow>();
  for (const row of [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]) {
    if (row.cashEntryId && (!row.CashEntry || row.CashEntry.deletedAt)) continue;
    if (row.businessEntryId && (!row.BusinessEntry || row.BusinessEntry.deletedAt)) continue;
    if (row.fundTransactionId && (!row.FundTransaction || row.FundTransaction.deletedAt)) continue;
    if (row.insuranceTransactionId && (!row.InsuranceTransaction || row.InsuranceTransaction.deletedAt)) continue;
    if (row.wealthTransactionId && (!row.WealthTransaction || row.WealthTransaction.deletedAt)) continue;
    if (row.bondTransactionId && (!row.BondTransaction || row.BondTransaction.deletedAt)) continue;
    if (row.depositTransactionId && (!row.DepositTransaction || row.DepositTransaction.deletedAt)) continue;
    if (row.preciousMetalTransactionId && (!row.PreciousMetalTransaction || row.PreciousMetalTransaction.deletedAt)) continue;
    if (row.stockTransactionId && (!row.StockTransaction || row.StockTransaction.deletedAt)) continue;
    if (row.propertyTransactionId && (!row.PropertyTransaction || row.PropertyTransaction.deletedAt)) continue;
    const targetId =
      row.fundTransactionId ??
      row.insuranceTransactionId ??
      row.wealthTransactionId ??
      row.bondTransactionId ??
      row.depositTransactionId ??
      row.preciousMetalTransactionId ??
      row.stockTransactionId ??
      row.propertyTransactionId ??
      row.businessEntryId ??
      "";
    const key = `${row.cashEntryId ?? ""}:${targetId}:${row.linkType ?? ""}`;
    uniqueRows.set(key, row);
  }
  const labels = Array.from(new Set(Array.from(uniqueRows.values()).map((row) => entryBusinessTypeLabel(row.businessType))));
  const fundAccountLink = Array.from(uniqueRows.values()).find((row) => row.FundTransaction?.fundAccountId);
  return {
    businessLinkCount: uniqueRows.size,
    businessLinkLabels: labels,
    businessLinkIds: Array.from(uniqueRows.values()).map((row) => row.id).filter(Boolean),
    businessLinkId: Array.from(uniqueRows.values()).find((row) => row.id)?.id ?? null,
    relatedAccountId: fundAccountLink?.FundTransaction?.fundAccountId ?? null,
    relatedAccountName: fundAccountLink?.FundTransaction?.Account?.name ?? null,
  };
}

export async function listEntryBusinessDeleteImpacts(
  ctx: HouseholdContext,
  entryIds: string[],
): Promise<EntryBusinessDeleteImpact[]> {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) return [];
  await upsertLegacyCombinedEntryBusinessLinks(ids).catch(() => 0);

  const idSet = new Set(ids);
  const hasId = (id?: string | null) => Boolean(id && idSet.has(id));
  const businessTargetIdOf = (row: {
    businessEntryId?: string | null;
    fundTransactionId?: string | null;
    insuranceTransactionId?: string | null;
    wealthTransactionId?: string | null;
    bondTransactionId?: string | null;
    depositTransactionId?: string | null;
    preciousMetalTransactionId?: string | null;
    stockTransactionId?: string | null;
    propertyTransactionId?: string | null;
  }) =>
    row.businessEntryId ??
    row.fundTransactionId ??
    row.insuranceTransactionId ??
    row.wealthTransactionId ??
    row.bondTransactionId ??
    row.depositTransactionId ??
    row.preciousMetalTransactionId ??
    row.stockTransactionId ??
    row.propertyTransactionId ??
    null;

  // This query's OR contains 10 `{ in: ids }` clauses. A large batch (for
  // example 195 rows) would accumulate about 10 x 195 = 1950 bound parameters,
  // exceeding SQLite's 999 limit. Query in id chunks and merge with dedupe.
  const linkSelect = {
    id: true,
    cashEntryId: true,
    businessEntryId: true,
    fundTransactionId: true,
    insuranceTransactionId: true,
    wealthTransactionId: true,
    bondTransactionId: true,
    depositTransactionId: true,
    preciousMetalTransactionId: true,
    stockTransactionId: true,
    propertyTransactionId: true,
    businessType: true,
    linkType: true,
    CashEntry: { select: { id: true, deletedAt: true } },
    BusinessEntry: { select: { id: true, deletedAt: true } },
    FundTransaction: { select: { id: true, deletedAt: true, source: true } },
    InsuranceTransaction: { select: { id: true, deletedAt: true } },
    WealthTransaction: { select: { id: true, deletedAt: true } },
    BondTransaction: { select: { id: true, deletedAt: true } },
    DepositTransaction: { select: { id: true, deletedAt: true } },
    PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
    StockTransaction: { select: { id: true, deletedAt: true } },
    PropertyTransaction: { select: { id: true, deletedAt: true } },
  } as const;

  const fetchLinks = (part: string[]) =>
    prisma.entryBusinessLink.findMany({
      where: {
        householdId: ctx.householdId,
        deletedAt: null,
        OR: [
          { cashEntryId: { in: part } },
          { businessEntryId: { in: part } },
          { fundTransactionId: { in: part } },
          { insuranceTransactionId: { in: part } },
          { wealthTransactionId: { in: part } },
          { bondTransactionId: { in: part } },
          { depositTransactionId: { in: part } },
          { preciousMetalTransactionId: { in: part } },
          { stockTransactionId: { in: part } },
          { propertyTransactionId: { in: part } },
        ],
      },
      select: linkSelect,
    });

  const seenLinkIds = new Set<string>();
  const rows: Awaited<ReturnType<typeof fetchLinks>> = [];
  for (const part of chunk(ids, IN_CHUNK_SIZE)) {
    const partRows = await fetchLinks(part);
    for (const row of partRows) {
      if (seenLinkIds.has(row.id)) continue;
      seenLinkIds.add(row.id);
      rows.push(row);
    }
  }

  const unique = new Map<string, EntryBusinessDeleteImpact>();
  for (const row of rows) {
    if (row.cashEntryId && !row.CashEntry) continue;
    if (!row.cashEntryId) continue;
    if (row.businessEntryId && (!row.BusinessEntry || row.BusinessEntry.deletedAt)) continue;
    if (row.fundTransactionId && (!row.FundTransaction || row.FundTransaction.deletedAt)) continue;
    if (row.FundTransaction && isFundUnitsReconcileEntry(row.FundTransaction)) continue;
    if (row.insuranceTransactionId && (!row.InsuranceTransaction || row.InsuranceTransaction.deletedAt)) continue;
    if (row.wealthTransactionId && (!row.WealthTransaction || row.WealthTransaction.deletedAt)) continue;
    if (row.bondTransactionId && (!row.BondTransaction || row.BondTransaction.deletedAt)) continue;
    if (row.depositTransactionId && (!row.DepositTransaction || row.DepositTransaction.deletedAt)) continue;
    if (row.preciousMetalTransactionId && (!row.PreciousMetalTransaction || row.PreciousMetalTransaction.deletedAt)) continue;
    if (row.stockTransactionId && (!row.StockTransaction || row.StockTransaction.deletedAt)) continue;
    if (row.propertyTransactionId && (!row.PropertyTransaction || row.PropertyTransaction.deletedAt)) continue;

    const businessEntryId = businessTargetIdOf(row);
    const selectedEntryId =
      hasId(row.cashEntryId) && hasId(row.businessEntryId) ? row.cashEntryId
        : hasId(row.businessEntryId) ? row.businessEntryId
          : hasId(row.fundTransactionId) ? row.fundTransactionId
            : hasId(row.insuranceTransactionId) ? row.insuranceTransactionId
              : hasId(row.wealthTransactionId) ? row.wealthTransactionId
                : hasId(row.bondTransactionId) ? row.bondTransactionId
                  : hasId(row.depositTransactionId) ? row.depositTransactionId
                    : hasId(row.preciousMetalTransactionId) ? row.preciousMetalTransactionId
                      : hasId(row.stockTransactionId) ? row.stockTransactionId
                        : hasId(row.propertyTransactionId) ? row.propertyTransactionId
                          : row.cashEntryId;
    if (!selectedEntryId) continue;

    const businessSideSelected =
      hasId(row.businessEntryId) ||
      hasId(row.fundTransactionId) ||
      hasId(row.insuranceTransactionId) ||
      hasId(row.wealthTransactionId) ||
      hasId(row.bondTransactionId) ||
      hasId(row.depositTransactionId) ||
      hasId(row.preciousMetalTransactionId) ||
      hasId(row.stockTransactionId) ||
      hasId(row.propertyTransactionId);
    const selectedSide =
      hasId(row.cashEntryId) && hasId(row.businessEntryId) ? "both"
        : businessSideSelected ? "business"
          : "cash";
    const counterpartEntryId = businessSideSelected ? row.cashEntryId : businessEntryId;
    const key = `${row.cashEntryId ?? ""}:${businessEntryId ?? ""}:${row.businessType}`;
    const businessLabel = entryBusinessTypeLabel(row.businessType);
    const counterpartLabel = selectedSide === "business" ? "资金交易" : businessLabel;
    unique.set(key, {
      linkId: row.id,
      selectedEntryId,
      selectedSide,
      entryId: row.cashEntryId ?? "",
      businessEntryId: businessEntryId ?? "",
      counterpartEntryId,
      businessType: row.businessType as EntryBusinessType,
      linkType: row.linkType,
      legacyCombinedRecord: Boolean(row.cashEntryId && row.cashEntryId === row.businessEntryId),
      businessLabel,
      counterpartLabel,
    });
  }

  // 整笔删除语义（2026-10-17 用户规则）：命中的是某笔独立业务单的一条资金腿时，
  // 把同一业务单的其余资金腿一并纳入影响范围。这样删除任意一条腿都会整笔删除
  // （资金侧多腿 + 投资侧派生行），撤销删除也按同一批 id 整笔恢复。
  const businessTargets = new Map<string, { type: EntryBusinessType; id: string }>();
  for (const impact of unique.values()) {
    if (!impact.businessEntryId) continue;
    businessTargets.set(`${impact.businessType}:${impact.businessEntryId}`, {
      type: impact.businessType,
      id: impact.businessEntryId,
    });
  }
  if (businessTargets.size > 0) {
    const idsOfType = (type: EntryBusinessType) =>
      Array.from(businessTargets.values())
        .filter((target) => target.type === type)
        .map((target) => target.id);
    const businessAlive = (row: (typeof rows)[number]) =>
      (!row.businessEntryId || Boolean(row.BusinessEntry && !row.BusinessEntry.deletedAt))
      && (!row.fundTransactionId || Boolean(row.FundTransaction && !row.FundTransaction.deletedAt))
      && (!row.insuranceTransactionId || Boolean(row.InsuranceTransaction && !row.InsuranceTransaction.deletedAt))
      && (!row.wealthTransactionId || Boolean(row.WealthTransaction && !row.WealthTransaction.deletedAt))
      && (!row.bondTransactionId || Boolean(row.BondTransaction && !row.BondTransaction.deletedAt))
      && (!row.depositTransactionId || Boolean(row.DepositTransaction && !row.DepositTransaction.deletedAt))
      && (!row.preciousMetalTransactionId || Boolean(row.PreciousMetalTransaction && !row.PreciousMetalTransaction.deletedAt))
      && (!row.stockTransactionId || Boolean(row.StockTransaction && !row.StockTransaction.deletedAt))
      && (!row.propertyTransactionId || Boolean(row.PropertyTransaction && !row.PropertyTransaction.deletedAt));
    const siblingLinks = await prisma.entryBusinessLink.findMany({
      where: {
        householdId: ctx.householdId,
        deletedAt: null,
        OR: [
          { fundTransactionId: { in: idsOfType("fund") } },
          { insuranceTransactionId: { in: idsOfType("insurance") } },
          { wealthTransactionId: { in: idsOfType("wealth") } },
          { bondTransactionId: { in: idsOfType("bond") } },
          { depositTransactionId: { in: idsOfType("deposit") } },
          { preciousMetalTransactionId: { in: idsOfType("metal") } },
          { stockTransactionId: { in: idsOfType("stock") } },
          { propertyTransactionId: { in: idsOfType("property") } },
        ],
      },
      select: linkSelect,
    });
    const coveredCashIds = new Set(Array.from(unique.values()).map((impact) => impact.entryId));
    for (const row of siblingLinks) {
      const cashEntryId = row.cashEntryId ?? "";
      if (!cashEntryId || coveredCashIds.has(cashEntryId)) continue;
      if (!row.CashEntry || row.CashEntry.deletedAt) continue;
      if (!businessAlive(row)) continue;
      if (row.FundTransaction && isFundUnitsReconcileEntry(row.FundTransaction)) continue;
      const businessEntryId = businessTargetIdOf(row);
      if (!businessEntryId) continue;
      coveredCashIds.add(cashEntryId);
      const businessLabel = entryBusinessTypeLabel(row.businessType);
      unique.set(`${cashEntryId}:${businessEntryId}:${row.businessType}`, {
        linkId: row.id,
        selectedEntryId: cashEntryId,
        selectedSide: "cash",
        entryId: cashEntryId,
        businessEntryId,
        counterpartEntryId: businessEntryId,
        businessType: row.businessType as EntryBusinessType,
        businessLabel,
        linkType: row.linkType,
        legacyCombinedRecord: cashEntryId === businessEntryId,
        counterpartLabel: businessLabel,
      });
    }
  }

  // 基金业务侧派生行（买入/退回/分红）也各占一行，整笔删除提示需要把它算进条数。
  const fundBusinessIds = Array.from(new Set(
    Array.from(unique.values())
      .filter((impact) => impact.businessType === "fund")
      .map((impact) => impact.businessEntryId)
      .filter(Boolean),
  ));
  if (fundBusinessIds.length > 0) {
    const flowCounts = await prisma.fundTransactionCashFlow.groupBy({
      by: ["fundTransactionId"],
      where: { fundTransactionId: { in: fundBusinessIds } },
      _count: { _all: true },
    });
    const countByFundId = new Map(flowCounts.map((row) => [row.fundTransactionId, row._count._all]));
    for (const impact of unique.values()) {
      if (impact.businessType !== "fund") continue;
      const count = countByFundId.get(impact.businessEntryId);
      if (count && count > 0) impact.businessDisplayRowCount = count;
    }
  }

  return Array.from(unique.values());
}

export type RestoredBusinessFundTarget = { fundAccountId: string; fundCode: string };

/**
 * 撤销/恢复整笔删除的业务明细：按资金腿反查 EntryBusinessLink，把同一笔业务单
 * （基金/保险/理财/债券/存款/贵金属/股票/房产）的 deletedAt 清空。
 * deletedAfter 用于只恢复「本次删除」连带删掉的业务单，避免复活更早单独删除的业务。
 */
export async function restoreBusinessRecordsForCashEntryIds(
  ctx: HouseholdContext,
  cashEntryIds: string[],
  options?: { deletedAfter?: Date | null },
): Promise<{ restoredCount: number; fundTargets: RestoredBusinessFundTarget[] }> {
  const ids = Array.from(new Set(cashEntryIds.filter(Boolean)));
  const result: { restoredCount: number; fundTargets: RestoredBusinessFundTarget[] } = {
    restoredCount: 0,
    fundTargets: [],
  };
  if (ids.length === 0) return result;

  // 注意：整笔删除会把 EntryBusinessLink 一起软删，所以这里不能要求 link.deletedAt = null，
  // 否则撤销时反查不到业务单，投资侧派生行永远回不来。
  const links = await prisma.entryBusinessLink.findMany({
    where: { householdId: ctx.householdId, cashEntryId: { in: ids } },
    select: {
      id: true,
      deletedAt: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      bondTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      stockTransactionId: true,
      propertyTransactionId: true,
    },
  });
  if (links.length === 0) return result;
  const idsOf = (field: keyof (typeof links)[number]) =>
    Array.from(new Set(links.map((link) => link[field]).filter((id): id is string => Boolean(id))));
  const deletedAtWhere = options?.deletedAfter ? { gte: options.deletedAfter } : { not: null };

  // link 是删除范围的反查入口：删除时被连带软删，撤销必须先把它恢复，
  // 否则恢复后的这笔业务再被删除时「整笔」范围就查不到其余资金腿了。
  const restoreLinkIds = links
    .filter((link) => link.deletedAt && (!options?.deletedAfter || link.deletedAt >= options.deletedAfter))
    .map((link) => link.id);
  if (restoreLinkIds.length > 0) {
    await prisma.entryBusinessLink.updateMany({
      where: { id: { in: restoreLinkIds }, householdId: ctx.householdId },
      data: { deletedAt: null },
    });
  }

  const fundIds = idsOf("fundTransactionId");
  if (fundIds.length > 0) {
    const updated = await prisma.fundTransaction.updateMany({
      where: { householdId: ctx.householdId, id: { in: fundIds }, deletedAt: deletedAtWhere },
      data: { deletedAt: null },
    });
    result.restoredCount += updated.count;
    const fundRows = await prisma.fundTransaction.findMany({
      where: { householdId: ctx.householdId, id: { in: fundIds } },
      select: { fundAccountId: true, fundCode: true },
    });
    result.fundTargets.push(...fundRows);
  }

  const restoreTable = async (
    model: "insuranceTransaction" | "wealthTransaction" | "bondTransaction" | "depositTransaction" | "preciousMetalTransaction" | "stockTransaction" | "propertyTransaction",
    recordIds: string[],
  ) => {
    if (recordIds.length === 0) return;
    const updated = await (prisma[model] as unknown as {
      updateMany: (args: {
        where: { householdId: string; id: { in: string[] }; deletedAt: { gte: Date } | { not: null } };
        data: { deletedAt: null };
      }) => Promise<{ count: number }>;
    }).updateMany({
      where: { householdId: ctx.householdId, id: { in: recordIds }, deletedAt: deletedAtWhere },
      data: { deletedAt: null },
    });
    result.restoredCount += updated.count;
  };

  await restoreTable("insuranceTransaction", idsOf("insuranceTransactionId"));
  await restoreTable("wealthTransaction", idsOf("wealthTransactionId"));
  await restoreTable("bondTransaction", idsOf("bondTransactionId"));
  await restoreTable("depositTransaction", idsOf("depositTransactionId"));
  await restoreTable("preciousMetalTransaction", idsOf("preciousMetalTransactionId"));
  await restoreTable("stockTransaction", idsOf("stockTransactionId"));
  await restoreTable("propertyTransaction", idsOf("propertyTransactionId"));

  return result;
}
