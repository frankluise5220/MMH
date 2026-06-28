import { prisma } from "@/lib/db/prisma";

export const DEFAULT_FUND_UNITS_DECIMALS = 3;
export const MIN_FUND_UNITS_DECIMALS = 0;
export const MAX_FUND_UNITS_DECIMALS = 6;

export function normalizeFundUnitsDecimals(
  raw: unknown,
  fallback = DEFAULT_FUND_UNITS_DECIMALS,
): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(
    Math.max(Math.round(value), MIN_FUND_UNITS_DECIMALS),
    MAX_FUND_UNITS_DECIMALS,
  );
}

export function roundFundUnits(
  value: number,
  decimals = DEFAULT_FUND_UNITS_DECIMALS,
): number {
  if (!Number.isFinite(value)) return value;
  const normalizedDecimals = normalizeFundUnitsDecimals(decimals);
  const factor = 10 ** normalizedDecimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function roundNullableFundUnits(
  value: number | null | undefined,
  decimals = DEFAULT_FUND_UNITS_DECIMALS,
): number | null {
  if (value == null) return null;
  return roundFundUnits(value, decimals);
}

export async function getAccountFundUnitsDecimals(accountId: string): Promise<number> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { fundUnitsDecimals: true },
  });
  return normalizeFundUnitsDecimals(account?.fundUnitsDecimals);
}
