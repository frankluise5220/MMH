import { prisma } from "@/lib/db/prisma";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision-core";

export {
  DEFAULT_FUND_UNITS_DECIMALS,
  MAX_FUND_UNITS_DECIMALS,
  METAL_QUANTITY_DECIMALS,
  MIN_FUND_UNITS_DECIMALS,
  formatFundUnitsValue,
  normalizeFundUnitsDecimals,
  resolveQuantityDecimals,
  roundFundUnits,
  roundNullableFundUnits,
} from "@/lib/fund/unit-precision-core";

export async function getAccountFundUnitsDecimals(accountId: string): Promise<number> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { fundUnitsDecimals: true },
  });
  return normalizeFundUnitsDecimals(account?.fundUnitsDecimals);
}
