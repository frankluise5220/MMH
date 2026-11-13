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

  const rows = await prisma.preciousMetalTransaction.findMany({
    where: {
      deletedAt: null,
      accountId,
    },
    select: {
      id: true,
      tradeDate: true,
      createdAt: true,
      amount: true,
      accountId: true,
      action: true,
      cashEntryId: true,
      metalTypeId: true,
      metalTypeName: true,
      metalUnitId: true,
      metalUnitName: true,
      quantity: true,
      unitPrice: true,
      fee: true,
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
  });

  const positions = new Map<string, MetalPosition>();
  const realizedProfitByEntryId = new Map<string, number | null>();

  for (const row of rows) {
    if (!row.metalTypeId || !row.metalUnitId) continue;
    const quantity = row.quantity != null ? toNum(row.quantity) : 0;
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
    const subtype = row.action ?? "buy";
    const fee = row.fee != null ? toNum(row.fee) : 0;
    const unitPrice = row.unitPrice != null ? toNum(row.unitPrice) : null;
    if (unitPrice != null && unitPrice > 0) current.unitPrice = unitPrice;

    if (subtype === "redeem" || subtype === "switch_out") {
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
    const realizedProfit = realizedProfitByEntryId.get(row.id);
    await prisma.preciousMetalTransaction.update({
      where: { id: row.id },
      data: { realizedProfit },
    });
    if (row.cashEntryId) {
      await prisma.txRecord.update({
        where: { id: row.cashEntryId },
        data: { realizedProfit },
      });
    }
  }

  const activeKeys = new Set(positions.keys());
  const existingHoldings = await prisma.preciousMetalHolding.findMany({
    where: { accountId },
    select: {
      metalTypeId: true,
      metalUnitId: true,
      latestPrice: true,
      latestPriceDate: true,
      priceSource: true,
    },
  });
  // 行情不是交易回放的产物：重算持仓时必须原样带过来，否则每次记账都把刷新出来的价格抹掉。
  const latestQuoteByKey = new Map<string, { latestPrice: number | null; latestPriceDate: Date | null; priceSource: string | null }>();
  for (const holding of existingHoldings) {
    const latestPrice = holding.latestPrice != null ? toNum(holding.latestPrice) : null;
    latestQuoteByKey.set(`${holding.metalTypeId}::${holding.metalUnitId}`, {
      latestPrice: latestPrice != null && latestPrice > 0 ? latestPrice : null,
      latestPriceDate: holding.latestPriceDate ?? null,
      priceSource: holding.priceSource ?? null,
    });
  }
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
    const latestQuote = latestQuoteByKey.get(key);
    const latestPrice = latestQuote?.latestPrice ?? null;
    // 有行情用行情，没有行情才退回最后一笔成交价（存量持仓的行为不变）。
    const valuationPrice = latestPrice ?? unitPrice;
    const marketValue = quantity > 0 && valuationPrice != null
      ? Math.round(quantity * valuationPrice * 100) / 100
      : 0;

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
        latestPrice,
        latestPriceDate: latestQuote?.latestPriceDate ?? null,
        priceSource: latestQuote?.priceSource ?? null,
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
        latestPrice,
        latestPriceDate: latestQuote?.latestPriceDate ?? null,
        priceSource: latestQuote?.priceSource ?? null,
        marketValue,
        historicalProfit: position.historicalProfit,
      },
    });
  }
}
