import { prisma } from "@/lib/db/prisma";
import { todayDateBusinessYmd } from "@/lib/date-utils";
import { resolveHouseholdTimeZone } from "@/lib/server/business-time-zone";
import { isInsuranceBalanceMetric } from "@/lib/insurance/display";
import { insuranceCashValueDelta } from "@/lib/insurance/transaction";

// 口径是 UTC（名称沿用历史）：DB 日历日字段存 UTC 零点。
function localDateKey(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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

  const entries = await prisma.insuranceTransaction.findMany({
    where: {
      ...(hidFilter ?? {}),
      deletedAt: null,
      insuranceProductId: { in: Array.from(balanceProductIds) },
    },
    select: {
      accountId: true,
      tradeDate: true,
      amount: true,
      action: true,
      insuranceProductId: true,
    },
  });

  const todayKey = todayDateBusinessYmd(await resolveHouseholdTimeZone(hidFilter?.householdId));
  const productAccountIdById = new Map(products.map((product) => [product.id, product.accountId]));
  for (const entry of entries) {
    if (localDateKey(entry.tradeDate) > todayKey) continue;
    const productId = entry.insuranceProductId ?? "";
    const accountId = productAccountIdById.get(productId);
    if (!accountId) continue;
    result.set(accountId, (result.get(accountId) ?? 0) + insuranceCashValueDelta(entry));
  }

  return result;
}
