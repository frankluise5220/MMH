import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { isInsuranceBalanceMetric } from "@/lib/insurance/display";

export async function computeInsuranceAccountDisplayBalances(
  accountIds: string[],
  hidFilter?: { householdId?: string },
) {
  const result = new Map<string, number>();
  const normalizedAccountIds = accountIds.filter(Boolean);
  for (const accountId of normalizedAccountIds) {
    result.set(accountId, 0);
  }
  if (normalizedAccountIds.length === 0) return result;

  const products = await prisma.insuranceProduct.findMany({
    where: {
      ...(hidFilter ?? {}),
      accountId: { in: normalizedAccountIds },
    },
    select: {
      id: true,
      accountId: true,
      productType: true,
      accountingType: true,
      cashValueEnabled: true,
    },
  });

  const balanceProductIds = new Set(
    products
      .filter((product) => isInsuranceBalanceMetric(product.productType, product.accountingType, product.cashValueEnabled))
      .map((product) => product.id),
  );
  if (balanceProductIds.size === 0) return result;

  const entries = await prisma.txRecord.findMany({
    where: {
      ...(hidFilter ?? {}),
      deletedAt: null,
      type: "investment",
      source: "insurance",
      insuranceProductId: { in: Array.from(balanceProductIds) },
    },
    select: {
      accountId: true,
      toAccountId: true,
      amount: true,
      fundSubtype: true,
      insuranceProductId: true,
    },
  });

  const productAccountIdById = new Map(products.map((product) => [product.id, product.accountId]));
  for (const entry of entries) {
    const productId = entry.insuranceProductId ?? "";
    const accountId = productAccountIdById.get(productId);
    if (!accountId) continue;
    const amount = Math.abs(toNumber(entry.amount));
    const delta = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out"
      ? -amount
      : amount;
    result.set(accountId, (result.get(accountId) ?? 0) + delta);
  }

  return result;
}
