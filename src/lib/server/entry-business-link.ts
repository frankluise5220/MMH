import { Prisma, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import type { HouseholdContext } from "@/lib/server/household-scope";

type TxClient = Prisma.TransactionClient | typeof prisma;

export type EntryBusinessType = "fund" | "wealth" | "deposit" | "insurance" | "metal" | "other_investment";
export type EntryCashFlowDirection = "outflow" | "inflow" | "internal" | "none";
export type EntryBusinessDeleteImpact = {
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
  cashEntryId?: string | null;
  businessEntryId?: string | null;
  fundTransactionId?: string | null;
  insuranceTransactionId?: string | null;
  wealthTransactionId?: string | null;
  depositTransactionId?: string | null;
  preciousMetalTransactionId?: string | null;
  businessType: EntryBusinessType | string;
  linkType?: string | null;
  CashEntry?: { id: string; deletedAt?: Date | null } | null;
  BusinessEntry?: { id: string; deletedAt?: Date | null } | null;
  FundTransaction?: { id: string; deletedAt?: Date | null } | null;
  InsuranceTransaction?: { id: string; deletedAt?: Date | null } | null;
  WealthTransaction?: { id: string; deletedAt?: Date | null } | null;
  DepositTransaction?: { id: string; deletedAt?: Date | null } | null;
  PreciousMetalTransaction?: { id: string; deletedAt?: Date | null } | null;
};

export const entryBusinessLinkSummaryInclude = {
  EntryBusinessLinkCash: {
    where: { deletedAt: null },
    select: {
      cashEntryId: true,
      businessEntryId: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: { select: { id: true, deletedAt: true } },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
    },
  },
  EntryBusinessLinkBusiness: {
    where: { deletedAt: null },
    select: {
      cashEntryId: true,
      businessEntryId: true,
      fundTransactionId: true,
      insuranceTransactionId: true,
      wealthTransactionId: true,
      depositTransactionId: true,
      preciousMetalTransactionId: true,
      businessType: true,
      linkType: true,
      CashEntry: { select: { id: true, deletedAt: true } },
      BusinessEntry: { select: { id: true, deletedAt: true } },
      FundTransaction: { select: { id: true, deletedAt: true } },
      InsuranceTransaction: { select: { id: true, deletedAt: true } },
      WealthTransaction: { select: { id: true, deletedAt: true } },
      DepositTransaction: { select: { id: true, deletedAt: true } },
      PreciousMetalTransaction: { select: { id: true, deletedAt: true } },
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
      entry.depositSourceEntryId,
  );
  if (!isInvestmentEntry || !hasBusinessFields) return null;

  if (entry.source === "insurance" || entry.insuranceProductId) return "insurance";
  if (entry.fundProductType === "wealth" || entry.wealthProductId) return "wealth";
  if (entry.fundProductType === "deposit" || entry.depositSourceEntryId) return "deposit";
  if (entry.fundProductType === "metal" || entry.metalTypeId) return "metal";
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

  await client.$executeRaw`
    INSERT INTO "entry_business_links" (
      "id",
      "householdId",
      "cashEntryId",
      "businessEntryId",
      "businessType",
      "linkType",
      "cashFlowDirection",
      "source",
      "note",
      "metadata",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${linkId},
      ${entry.householdId},
      ${entry.id},
      ${entry.id},
      ${businessType}::"EntryBusinessType",
      'legacy_combined_record'::"EntryBusinessLinkType",
      ${direction}::"EntryCashFlowDirection",
      ${entry.source ?? "manual"},
      'Legacy combined cash/business TxRecord',
      ${JSON.stringify({ legacyCombinedRecord: true })}::jsonb,
      ${createdAt},
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("cashEntryId", "businessEntryId", "linkType")
    DO UPDATE SET
      "businessType" = EXCLUDED."businessType",
      "cashFlowDirection" = EXCLUDED."cashFlowDirection",
      "source" = EXCLUDED."source",
      "metadata" = EXCLUDED."metadata",
      "deletedAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  `;
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
              : params.businessEntryId ? `entry_${params.businessEntryId}`
                : "";
  if (!businessTarget) return;

  const linkId = params.cashEntryId
    ? `ebl_${params.cashEntryId}_${businessTarget}`
    : `ebl_business_${businessTarget}`;
  await client.$executeRaw`
    INSERT INTO "entry_business_links" (
      "id",
      "householdId",
      "cashEntryId",
      "businessEntryId",
      "fundTransactionId",
      "insuranceTransactionId",
      "wealthTransactionId",
      "depositTransactionId",
      "preciousMetalTransactionId",
      "businessType",
      "linkType",
      "cashFlowDirection",
      "source",
      "note",
      "metadata",
      "updatedAt"
    )
    VALUES (
      ${linkId},
      ${params.householdId},
      ${params.cashEntryId},
      ${params.businessEntryId ?? null},
      ${params.fundTransactionId ?? null},
      ${params.insuranceTransactionId ?? null},
      ${params.wealthTransactionId ?? null},
      ${params.depositTransactionId ?? null},
      ${params.preciousMetalTransactionId ?? null},
      ${params.businessType}::"EntryBusinessType",
      'cash_flow'::"EntryBusinessLinkType",
      ${params.cashFlowDirection ?? "none"}::"EntryCashFlowDirection",
      ${params.source ?? "manual"},
      ${params.note ?? null},
      ${JSON.stringify(params.metadata ?? { splitRecord: true })}::jsonb,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("id")
    DO UPDATE SET
      "cashEntryId" = EXCLUDED."cashEntryId",
      "businessEntryId" = EXCLUDED."businessEntryId",
      "fundTransactionId" = EXCLUDED."fundTransactionId",
      "insuranceTransactionId" = EXCLUDED."insuranceTransactionId",
      "wealthTransactionId" = EXCLUDED."wealthTransactionId",
      "depositTransactionId" = EXCLUDED."depositTransactionId",
      "preciousMetalTransactionId" = EXCLUDED."preciousMetalTransactionId",
      "businessType" = EXCLUDED."businessType",
      "cashFlowDirection" = EXCLUDED."cashFlowDirection",
      "source" = EXCLUDED."source",
      "note" = EXCLUDED."note",
      "metadata" = EXCLUDED."metadata",
      "deletedAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}

export function entryBusinessTypeLabel(type: EntryBusinessType | string) {
  if (type === "insurance") return "保险交易";
  if (type === "wealth") return "理财交易";
  if (type === "deposit") return "存款交易";
  if (type === "metal") return "贵金属交易";
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
    const targetId =
      row.fundTransactionId ??
      row.insuranceTransactionId ??
      row.wealthTransactionId ??
      row.depositTransactionId ??
      row.preciousMetalTransactionId ??
      row.businessEntryId ??
      "";
    const key = `${row.cashEntryId ?? ""}:${targetId}:${row.linkType ?? ""}`;
    uniqueRows.set(key, row);
  }
  const labels = Array.from(new Set(Array.from(uniqueRows.values()).map((row) => entryBusinessTypeLabel(row.businessType))));
  return {
    businessLinkCount: uniqueRows.size,
    businessLinkLabels: labels,
  };
}

export async function listEntryBusinessDeleteImpacts(
  ctx: HouseholdContext,
  entryIds: string[],
): Promise<EntryBusinessDeleteImpact[]> {
  const ids = Array.from(new Set(entryIds.filter(Boolean)));
  if (ids.length === 0) return [];
  await upsertLegacyCombinedEntryBusinessLinks(ids).catch(() => 0);

  const rows = await prisma.$queryRaw<Array<{
    selectedEntryId: string;
    selectedSide: "cash" | "business" | "both";
    entryId: string;
    businessEntryId: string;
    counterpartEntryId: string | null;
    businessType: EntryBusinessType;
    linkType: string;
    legacyCombinedRecord: boolean;
  }>>(Prisma.sql`
    SELECT
      CASE
        WHEN l."cashEntryId" IN (${Prisma.join(ids)}) AND l."businessEntryId" IN (${Prisma.join(ids)}) THEN l."cashEntryId"
        WHEN l."businessEntryId" IN (${Prisma.join(ids)}) THEN l."businessEntryId"
        WHEN l."fundTransactionId" IN (${Prisma.join(ids)}) THEN l."fundTransactionId"
        WHEN l."insuranceTransactionId" IN (${Prisma.join(ids)}) THEN l."insuranceTransactionId"
        WHEN l."wealthTransactionId" IN (${Prisma.join(ids)}) THEN l."wealthTransactionId"
        WHEN l."depositTransactionId" IN (${Prisma.join(ids)}) THEN l."depositTransactionId"
        WHEN l."preciousMetalTransactionId" IN (${Prisma.join(ids)}) THEN l."preciousMetalTransactionId"
        ELSE l."cashEntryId"
      END AS "selectedEntryId",
      CASE
        WHEN l."cashEntryId" IN (${Prisma.join(ids)}) AND l."businessEntryId" IN (${Prisma.join(ids)}) THEN 'both'
        WHEN l."businessEntryId" IN (${Prisma.join(ids)}) THEN 'business'
        WHEN l."fundTransactionId" IN (${Prisma.join(ids)}) THEN 'business'
        WHEN l."insuranceTransactionId" IN (${Prisma.join(ids)}) THEN 'business'
        WHEN l."wealthTransactionId" IN (${Prisma.join(ids)}) THEN 'business'
        WHEN l."depositTransactionId" IN (${Prisma.join(ids)}) THEN 'business'
        WHEN l."preciousMetalTransactionId" IN (${Prisma.join(ids)}) THEN 'business'
        ELSE 'cash'
      END AS "selectedSide",
      l."cashEntryId" AS "entryId",
      COALESCE(
        l."businessEntryId",
        l."fundTransactionId",
        l."insuranceTransactionId",
        l."wealthTransactionId",
        l."depositTransactionId",
        l."preciousMetalTransactionId"
      ) AS "businessEntryId",
      CASE
        WHEN l."businessEntryId" IN (${Prisma.join(ids)})
          OR l."fundTransactionId" IN (${Prisma.join(ids)})
          OR l."insuranceTransactionId" IN (${Prisma.join(ids)})
          OR l."wealthTransactionId" IN (${Prisma.join(ids)})
          OR l."depositTransactionId" IN (${Prisma.join(ids)})
          OR l."preciousMetalTransactionId" IN (${Prisma.join(ids)})
        THEN l."cashEntryId"
        ELSE COALESCE(
          l."businessEntryId",
          l."fundTransactionId",
          l."insuranceTransactionId",
          l."wealthTransactionId",
          l."depositTransactionId",
          l."preciousMetalTransactionId"
        )
      END AS "counterpartEntryId",
      l."businessType"::text AS "businessType",
      l."linkType"::text AS "linkType",
      (l."cashEntryId" = l."businessEntryId") AS "legacyCombinedRecord"
    FROM "entry_business_links" l
    LEFT JOIN "transactions" cash ON cash."id" = l."cashEntryId"
    LEFT JOIN "transactions" business ON business."id" = l."businessEntryId"
    LEFT JOIN "fund_transactions" fund_business ON fund_business."id" = l."fundTransactionId"
    LEFT JOIN "insurance_transactions" insurance_business ON insurance_business."id" = l."insuranceTransactionId"
    LEFT JOIN "wealth_transactions" wealth_business ON wealth_business."id" = l."wealthTransactionId"
    LEFT JOIN "deposit_transactions" deposit_business ON deposit_business."id" = l."depositTransactionId"
    LEFT JOIN "precious_metal_transactions" metal_business ON metal_business."id" = l."preciousMetalTransactionId"
    WHERE (
        l."cashEntryId" IN (${Prisma.join(ids)})
        OR l."businessEntryId" IN (${Prisma.join(ids)})
        OR l."fundTransactionId" IN (${Prisma.join(ids)})
        OR l."insuranceTransactionId" IN (${Prisma.join(ids)})
        OR l."wealthTransactionId" IN (${Prisma.join(ids)})
        OR l."depositTransactionId" IN (${Prisma.join(ids)})
        OR l."preciousMetalTransactionId" IN (${Prisma.join(ids)})
      )
      AND l."householdId" = ${ctx.householdId}
      AND l."deletedAt" IS NULL
      AND (l."cashEntryId" IS NULL OR cash."id" IS NOT NULL)
      AND (l."businessEntryId" IS NULL OR business."deletedAt" IS NULL)
      AND (l."fundTransactionId" IS NULL OR fund_business."deletedAt" IS NULL)
      AND (l."insuranceTransactionId" IS NULL OR insurance_business."deletedAt" IS NULL)
      AND (l."wealthTransactionId" IS NULL OR wealth_business."deletedAt" IS NULL)
      AND (l."depositTransactionId" IS NULL OR deposit_business."deletedAt" IS NULL)
      AND (l."preciousMetalTransactionId" IS NULL OR metal_business."deletedAt" IS NULL)
  `);

  const unique = new Map<string, EntryBusinessDeleteImpact>();
  for (const row of rows) {
    const key = `${row.entryId}:${row.businessEntryId}:${row.businessType}`;
    const businessLabel = entryBusinessTypeLabel(row.businessType);
    const counterpartLabel = row.selectedSide === "business" ? "资金交易" : businessLabel;
    unique.set(key, {
      ...row,
      businessLabel,
      counterpartLabel,
    });
  }
  return Array.from(unique.values());
}
