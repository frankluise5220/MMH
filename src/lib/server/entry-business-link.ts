import { Prisma, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import type { HouseholdContext } from "@/lib/server/household-scope";

type TxClient = Prisma.TransactionClient | typeof prisma;

export type EntryBusinessLinkMetadata = Record<string, Prisma.InputJsonValue | null>;

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

export type EntryBusinessType = "fund" | "stock" | "wealth" | "deposit" | "insurance" | "metal" | "other_investment";
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
};

type EntryBusinessLinkSummaryRow = {
  id?: string | null;
  cashEntryId?: string | null;
  businessEntryId?: string | null;
  fundTransactionId?: string | null;
  insuranceTransactionId?: string | null;
  wealthTransactionId?: string | null;
  depositTransactionId?: string | null;
  preciousMetalTransactionId?: string | null;
  stockTransactionId?: string | null;
  businessType: EntryBusinessType | string;
  linkType?: string | null;
  CashEntry?: { id: string; deletedAt?: Date | null } | null;
  BusinessEntry?: { id: string; deletedAt?: Date | null } | null;
  FundTransaction?: { id: string; deletedAt?: Date | null } | null;
  InsuranceTransaction?: { id: string; deletedAt?: Date | null } | null;
  WealthTransaction?: { id: string; deletedAt?: Date | null } | null;
  DepositTransaction?: { id: string; deletedAt?: Date | null } | null;
  PreciousMetalTransaction?: { id: string; deletedAt?: Date | null } | null;
  StockTransaction?: { id: string; deletedAt?: Date | null } | null;
};

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
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      stockTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: { select: { id: true, deletedAt: true } },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
      StockTransaction: { select: { id: true, deletedAt: true } },
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
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      stockTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: { select: { id: true, deletedAt: true } },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
      StockTransaction: { select: { id: true, deletedAt: true } },
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
  insuranceProductId?: string | null;
  metalTypeId?: string | null;
  depositSourceEntryId?: string | null;
  stockTransactionId?: string | null;
  createdAt?: Date | string | null;
};

export function classifyEntryBusinessType(entry: BusinessEntryLike): EntryBusinessType | null {
  if (!entry.householdId) return null;
  const isInvestmentEntry = entry.type === TransactionType.investment || entry.type === "investment";
  const hasBusinessFields = Boolean(
    entry.fundProductType ||
      entry.fundCode ||
      entry.wealthProductId ||
      entry.insuranceProductId ||
      entry.source === "insurance" ||
      entry.metalTypeId ||
      entry.depositSourceEntryId ||
      entry.stockTransactionId,
  );
  if (!isInvestmentEntry || !hasBusinessFields) return null;

  if (entry.source === "insurance" || entry.insuranceProductId) return "insurance";
  if (entry.fundProductType === "wealth" || entry.wealthProductId) return "wealth";
  if (entry.fundProductType === "deposit" || entry.depositSourceEntryId) return "deposit";
  if (entry.fundProductType === "metal" || entry.metalTypeId) return "metal";
  if (entry.fundProductType === "stock" || entry.stockTransactionId) return "stock";
  if (entry.fundProductType === "fund" || entry.fundProductType === "money" || entry.fundCode) return "fund";
  return "other_investment";
}

export function classifyEntryCashFlowDirection(entry: BusinessEntryLike): EntryCashFlowDirection {
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
    depositTransactionId?: string | null;
    preciousMetalTransactionId?: string | null;
    stockTransactionId?: string | null;
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
          : params.depositTransactionId ? `deposit_${params.depositTransactionId}`
            : params.preciousMetalTransactionId ? `metal_${params.preciousMetalTransactionId}`
              : params.stockTransactionId ? `stock_${params.stockTransactionId}`
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
      depositTransactionId: params.depositTransactionId ?? null,
      preciousMetalTransactionId: params.preciousMetalTransactionId ?? null,
      stockTransactionId: params.stockTransactionId ?? null,
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
      depositTransactionId: params.depositTransactionId ?? null,
      preciousMetalTransactionId: params.preciousMetalTransactionId ?? null,
      stockTransactionId: params.stockTransactionId ?? null,
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
  if (type === "deposit") return "存款交易";
  if (type === "metal") return "贵金属交易";
  if (type === "stock") return "股票交易";
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
    if (row.depositTransactionId && (!row.DepositTransaction || row.DepositTransaction.deletedAt)) continue;
    if (row.preciousMetalTransactionId && (!row.PreciousMetalTransaction || row.PreciousMetalTransaction.deletedAt)) continue;
    if (row.stockTransactionId && (!row.StockTransaction || row.StockTransaction.deletedAt)) continue;
    const targetId =
      row.fundTransactionId ??
      row.insuranceTransactionId ??
      row.wealthTransactionId ??
      row.depositTransactionId ??
      row.preciousMetalTransactionId ??
      row.stockTransactionId ??
      row.businessEntryId ??
      "";
    const key = `${row.cashEntryId ?? ""}:${targetId}:${row.linkType ?? ""}`;
    uniqueRows.set(key, row);
  }
  const labels = Array.from(new Set(Array.from(uniqueRows.values()).map((row) => entryBusinessTypeLabel(row.businessType))));
  return {
    businessLinkCount: uniqueRows.size,
    businessLinkLabels: labels,
    businessLinkIds: Array.from(uniqueRows.values()).map((row) => row.id).filter(Boolean),
    businessLinkId: Array.from(uniqueRows.values()).find((row) => row.id)?.id ?? null,
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
    depositTransactionId?: string | null;
    preciousMetalTransactionId?: string | null;
    stockTransactionId?: string | null;
  }) =>
    row.businessEntryId ??
    row.fundTransactionId ??
    row.insuranceTransactionId ??
    row.wealthTransactionId ??
    row.depositTransactionId ??
    row.preciousMetalTransactionId ??
    row.stockTransactionId ??
    null;

  const rows = await prisma.entryBusinessLink.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      OR: [
        { cashEntryId: { in: ids } },
        { businessEntryId: { in: ids } },
        { fundTransactionId: { in: ids } },
        { insuranceTransactionId: { in: ids } },
        { wealthTransactionId: { in: ids } },
        { depositTransactionId: { in: ids } },
        { preciousMetalTransactionId: { in: ids } },
        { stockTransactionId: { in: ids } },
      ],
    },
    select: {
      id: true,
      cashEntryId: true,
      businessEntryId: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      stockTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: { select: { id: true, deletedAt: true } },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
      StockTransaction: { select: { id: true, deletedAt: true } },
    },
  });

  const unique = new Map<string, EntryBusinessDeleteImpact>();
  for (const row of rows) {
    if (row.cashEntryId && !row.CashEntry) continue;
    if (row.businessEntryId && (!row.BusinessEntry || row.BusinessEntry.deletedAt)) continue;
    if (row.fundTransactionId && (!row.FundTransaction || row.FundTransaction.deletedAt)) continue;
    if (row.insuranceTransactionId && (!row.InsuranceTransaction || row.InsuranceTransaction.deletedAt)) continue;
    if (row.wealthTransactionId && (!row.WealthTransaction || row.WealthTransaction.deletedAt)) continue;
    if (row.depositTransactionId && (!row.DepositTransaction || row.DepositTransaction.deletedAt)) continue;
    if (row.preciousMetalTransactionId && (!row.PreciousMetalTransaction || row.PreciousMetalTransaction.deletedAt)) continue;
    if (row.stockTransactionId && (!row.StockTransaction || row.StockTransaction.deletedAt)) continue;

    const businessEntryId = businessTargetIdOf(row);
    const selectedEntryId =
      hasId(row.cashEntryId) && hasId(row.businessEntryId) ? row.cashEntryId
        : hasId(row.businessEntryId) ? row.businessEntryId
          : hasId(row.fundTransactionId) ? row.fundTransactionId
            : hasId(row.insuranceTransactionId) ? row.insuranceTransactionId
              : hasId(row.wealthTransactionId) ? row.wealthTransactionId
                : hasId(row.depositTransactionId) ? row.depositTransactionId
                  : hasId(row.preciousMetalTransactionId) ? row.preciousMetalTransactionId
                    : hasId(row.stockTransactionId) ? row.stockTransactionId
                      : row.cashEntryId;
    if (!selectedEntryId) continue;

    const businessSideSelected =
      hasId(row.businessEntryId) ||
      hasId(row.fundTransactionId) ||
      hasId(row.insuranceTransactionId) ||
      hasId(row.wealthTransactionId) ||
      hasId(row.depositTransactionId) ||
      hasId(row.preciousMetalTransactionId) ||
      hasId(row.stockTransactionId);
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
      businessType: row.businessType,
      linkType: row.linkType,
      legacyCombinedRecord: Boolean(row.cashEntryId && row.cashEntryId === row.businessEntryId),
      businessLabel,
      counterpartLabel,
    });
  }
  return Array.from(unique.values());
}
