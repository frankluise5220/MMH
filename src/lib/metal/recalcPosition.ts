import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

function toNum(value: unknown): number {
  return toNumber(value);
}

function roundQuantity(value: number) {
  return Math.max(0, Math.round(value * 1_000_000) / 1_000_000);
}

type MetalPosition = {
  quantity: number;
  cost: number;
  historicalProfit: number;
  unitPrice: number | null;
  metalTypeName: string;
  metalUnitName: string;
};

export async function recalcPreciousMetalPositions(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, kind: true, householdId: true, investProductType: true },
  });
  if (!account || account.kind !== "investment" || account.investProductType !== "metal") return;

  const rows = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      OR: [{ accountId }, { toAccountId: accountId }],
      metalTypeId: { not: null },
      metalUnitId: { not: null },
    },
    select: {
      id: true,
      date: true,
      createdAt: true,
      amount: true,
      accountId: true,
      toAccountId: true,
      fundSubtype: true,
      metalTypeId: true,
      metalTypeName: true,
      metalUnitId: true,
      metalUnitName: true,
      metalQuantity: true,
      metalUnitPrice: true,
      metalFee: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  const positions = new Map<string, MetalPosition>();
  const realizedProfitByEntryId = new Map<string, number | null>();

  for (const row of rows) {
    if (!row.metalTypeId || !row.metalUnitId) continue;
    const quantity = row.metalQuantity != null ? toNum(row.metalQuantity) : 0;
    if (quantity <= 0) continue;

    const key = `${row.metalTypeId}::${row.metalUnitId}`;
    const current = positions.get(key) ?? {
      quantity: 0,
      cost: 0,
      historicalProfit: 0,
      unitPrice: null,
      metalTypeName: row.metalTypeName ?? row.metalTypeId,
      metalUnitName: row.metalUnitName ?? row.metalUnitId,
    };
    const subtype = row.fundSubtype ?? (toNum(row.amount) < 0 ? "buy" : "redeem");
    const fee = row.metalFee != null ? toNum(row.metalFee) : 0;
    const unitPrice = row.metalUnitPrice != null ? toNum(row.metalUnitPrice) : null;
    if (unitPrice != null && unitPrice > 0) current.unitPrice = unitPrice;

    if (subtype === "redeem" || row.accountId === accountId) {
      const avgCost = current.quantity > 0 ? current.cost / current.quantity : 0;
      const soldQuantity = Math.min(current.quantity, quantity);
      const costReduced = avgCost * soldQuantity;
      const proceeds = Math.max(0, toNum(row.amount) - fee);
      const realizedProfit = proceeds - costReduced;
      current.quantity = roundQuantity(current.quantity - soldQuantity);
      current.cost = Math.max(0, current.cost - costReduced);
      current.historicalProfit += realizedProfit;
      realizedProfitByEntryId.set(row.id, realizedProfit);
    } else {
      const costBasis = Math.abs(toNum(row.amount));
      current.quantity = roundQuantity(current.quantity + quantity);
      current.cost += costBasis;
      realizedProfitByEntryId.set(row.id, null);
    }

    positions.set(key, current);
  }

  for (const row of rows) {
    if (!realizedProfitByEntryId.has(row.id)) continue;
    await prisma.txRecord.update({
      where: { id: row.id },
      data: { realizedProfit: realizedProfitByEntryId.get(row.id) },
    });
  }

  const activeKeys = new Set(positions.keys());
  const existingHoldings = await prisma.preciousMetalHolding.findMany({
    where: { accountId },
    select: { metalTypeId: true, metalUnitId: true },
  });
  for (const holding of existingHoldings) {
    const key = `${holding.metalTypeId}::${holding.metalUnitId}`;
    if (!activeKeys.has(key)) {
      await prisma.preciousMetalHolding.delete({
        where: {
          accountId_metalTypeId_metalUnitId: {
            accountId,
            metalTypeId: holding.metalTypeId,
            metalUnitId: holding.metalUnitId,
          },
        },
      });
    }
  }

  for (const [key, position] of positions) {
    const [metalTypeId, metalUnitId] = key.split("::");
    if (!metalTypeId || !metalUnitId) continue;
    const quantity = roundQuantity(position.quantity);
    const avgCost = quantity > 0 ? position.cost / quantity : 0;
    const unitPrice = position.unitPrice ?? (quantity > 0 ? avgCost : null);
    const marketValue = quantity > 0 && unitPrice != null ? quantity * unitPrice : 0;

    await prisma.preciousMetalHolding.upsert({
      where: {
        accountId_metalTypeId_metalUnitId: {
          accountId,
          metalTypeId,
          metalUnitId,
        },
      },
      create: {
        accountId,
        householdId: account.householdId,
        metalTypeId,
        metalTypeName: position.metalTypeName,
        metalUnitId,
        metalUnitName: position.metalUnitName,
        quantity,
        avgCost,
        cost: position.cost,
        unitPrice,
        marketValue,
        historicalProfit: position.historicalProfit,
      },
      update: {
        metalTypeName: position.metalTypeName,
        metalUnitName: position.metalUnitName,
        quantity,
        avgCost,
        cost: position.cost,
        unitPrice,
        marketValue,
        historicalProfit: position.historicalProfit,
      },
    });
  }
}
