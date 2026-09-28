import { prisma } from "@/lib/db/prisma";
import { formatDateUtc } from "@/lib/date-utils";

export function depositCalendarDate(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return formatDateUtc(value);
}

export function isDepositRedemptionDateAllowed(
  redemptionDate: Date,
  latestInterestDate: Date | null,
): boolean {
  const redemptionKey = depositCalendarDate(redemptionDate);
  const latestInterestKey = depositCalendarDate(latestInterestDate);
  return !redemptionKey || !latestInterestKey || redemptionKey >= latestInterestKey;
}

export type DepositLotBalance = {
  originalPrincipal: number;
  redeemedPrincipal: number;
  remainingPrincipal: number;
  settled: boolean;
};

export async function loadLatestDepositInterestDate(params: {
  householdId: string;
  lotId: string;
  client?: any;
}): Promise<Date | null> {
  const client = params.client ?? prisma;
  const lot = await client.txRecord.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
    },
    select: {
      toAccountId: true,
      fundName: true,
      fundCode: true,
      date: true,
      fundArrivalDate: true,
    },
  });
  if (!lot) return null;

  const latest = await client.txRecord.aggregate({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      depositSourceEntryId: params.lotId,
      source: "deposit",
      type: "income",
    },
    _max: { date: true },
  });
  const lotName = (lot.fundName ?? lot.fundCode ?? "").trim();
  let legacyDate: Date | null = null;
  if (lot.toAccountId && lotName) {
    const legacyRows = await client.txRecord.findMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        source: "deposit",
        type: "income",
        accountId: lot.toAccountId,
        date: {
          gte: lot.date,
          ...(lot.fundArrivalDate ? { lte: lot.fundArrivalDate } : {}),
        },
        depositSourceEntryId: null,
        note: { contains: lotName },
      },
      select: { date: true },
      orderBy: { date: "desc" },
      take: 1,
    });
    legacyDate = legacyRows[0]?.date ?? null;
  }
  if (!latest._max.date) return legacyDate;
  if (!legacyDate) return latest._max.date;
  return depositCalendarDate(latest._max.date)! >= depositCalendarDate(legacyDate)!
    ? latest._max.date
    : legacyDate;
}

type DepositAmountRow = {
  fundArrivalAmount?: unknown;
  amount?: unknown;
  depositInterest?: unknown;
};

function numericValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function depositLotOriginalPrincipal(lot: DepositAmountRow): number {
  return Math.max(0, Math.abs(numericValue(lot.fundArrivalAmount ?? lot.amount)));
}

export function depositRedemptionPrincipal(entry: DepositAmountRow): number {
  const arrivalAmount = Math.abs(numericValue(entry.fundArrivalAmount ?? entry.amount));
  const interest = Math.max(0, numericValue(entry.depositInterest));
  return Math.max(0, arrivalAmount - interest);
}

export async function loadDepositLotBalance(params: {
  householdId: string;
  lotId: string;
  excludeEntryId?: string | null;
  client?: any;
}): Promise<DepositLotBalance | null> {
  const client = params.client ?? prisma;
  const lot = await client.txRecord.findFirst({
    where: {
      id: params.lotId,
      householdId: params.householdId,
      deletedAt: null,
      type: "investment",
      fundProductType: "deposit",
      fundSubtype: "buy",
    },
    select: { amount: true, fundArrivalAmount: true },
  });
  if (!lot) return null;

  const redemptions = await client.txRecord.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      depositSourceEntryId: params.lotId,
      fundSubtype: { in: ["redeem", "switch_out"] },
      ...(params.excludeEntryId ? { id: { not: params.excludeEntryId } } : {}),
    },
    select: { amount: true, fundArrivalAmount: true, depositInterest: true },
  });
  const originalPrincipal = depositLotOriginalPrincipal(lot);
  const redeemedPrincipal = redemptions.reduce(
    (total, entry) => total + depositRedemptionPrincipal(entry),
    0,
  );
  const remainingPrincipal = Math.max(0, Number((originalPrincipal - redeemedPrincipal).toFixed(2)));
  return {
    originalPrincipal,
    redeemedPrincipal: Number(redeemedPrincipal.toFixed(2)),
    remainingPrincipal,
    settled: remainingPrincipal <= 0.0001,
  };
}
