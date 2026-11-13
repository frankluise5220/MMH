"use server";

import { FixedAssetType, FundSubtype, PropertyTransactionAction, TransactionType } from "@prisma/client";

import { parseDateInputToUtc, todayDateBusinessYmd, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { METAL_QUANTITY_DECIMALS, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcPropertyAssetsFromTransactions } from "@/lib/property/transactions";
import { applyEntryChangesToAccountBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { ENTRY_ORIGIN_MANUAL, TRANSACTION_SOURCE_METAL_EXTRACT } from "@/lib/transaction-semantics";

export type MetalExtractResult = {
  ok: boolean;
  message?: string;
  assetId?: string;
  assetName?: string;
  quantity?: number;
  cost?: number;
};

function trimNumberText(value: number) {
  return String(Number(value.toFixed(METAL_QUANTITY_DECIMALS)));
}

/**
 * 贵金属提取实物 → 固定资产（收藏品）。
 *
 * 口径（2026-11-13 用户裁定）：
 * - 落成 `FixedAssetType.collectible`，名称自动生成「实物黄金 Au 12.5g」，不动枚举、不新增迁移。
 * - 成本按移动加权同比例移出（成本 = 提取数量 × 当前平均成本），**不计已实现盈亏**：
 *   明细按「赎回」记账但金额恰等于移出成本，`recalcPreciousMetalPositions` 回算出的
 *   已实现盈亏因此为 0，不污染卖出收益。
 * - 资金侧不产生现金流水：对向账户直接记固定资产账户，收藏品成本由固定资产交易承担。
 */
export async function extractMetalToFixedAsset(formData: FormData): Promise<MetalExtractResult> {
  try {
    const ctx = await getHouseholdScope();
    const householdId = ctx.householdId;

    const accountId = String(formData.get("accountId") ?? "").trim();
    const metalTypeId = String(formData.get("metalTypeId") ?? "").trim();
    const metalUnitId = String(formData.get("metalUnitId") ?? "").trim();
    const propertyAccountId = String(formData.get("propertyAccountId") ?? "").trim();
    const quantityRaw = toNumber(formData.get("quantity"));
    const dateRaw = String(formData.get("date") ?? "").trim();
    const nameRaw = String(formData.get("name") ?? "").trim();
    const noteRaw = String(formData.get("note") ?? "").trim();

    if (!accountId || !metalTypeId || !metalUnitId) return { ok: false, message: "缺少贵金属账户或品种" };
    if (!propertyAccountId) return { ok: false, message: "请选择固定资产账户" };
    if (!(quantityRaw > 0)) return { ok: false, message: "请填写提取数量" };

    const tradeDate = parseDateInputToUtc(dateRaw) ?? parseDateInputToUtc(todayDateBusinessYmd());
    if (!tradeDate) return { ok: false, message: "提取日期不正确" };

    const [metalAccount, propertyAccount] = await Promise.all([
      prisma.account.findFirst({
        where: { id: accountId, householdId },
        select: { id: true, name: true, currency: true, kind: true, investProductType: true },
      }),
      prisma.account.findFirst({
        where: { id: propertyAccountId, householdId },
        select: { id: true, name: true, currency: true, kind: true, investProductType: true, fixedAssetType: true },
      }),
    ]);
    if (!metalAccount) return { ok: false, message: "贵金属账户不存在" };
    if (metalAccount.investProductType !== "metal") return { ok: false, message: "请选择贵金属投资账户" };
    if (!propertyAccount) return { ok: false, message: "固定资产账户不存在" };
    if (propertyAccount.investProductType !== "property") return { ok: false, message: "请选择固定资产账户" };
    // 提取实物只进「贵金属实物」账户（collectible）：房产 / 汽车 / 设备等账户不能接收实物贵金属。
    if (propertyAccount.fixedAssetType !== FixedAssetType.collectible) return { ok: false, message: "请选择贵金属实物账户" };

    const holding = await prisma.preciousMetalHolding.findFirst({
      where: { householdId, accountId: metalAccount.id, metalTypeId, metalUnitId },
      select: {
        id: true,
        metalTypeName: true,
        metalUnitName: true,
        quantity: true,
        cost: true,
        avgCost: true,
      },
    });
    if (!holding) return { ok: false, message: "该账户没有此品种的持仓" };

    const heldQuantity = toNumber(holding.quantity);
    const heldCost = toNumber(holding.cost);
    if (!(heldQuantity > 0)) return { ok: false, message: "该账户没有此品种的持仓" };

    const isFull = quantityRaw >= heldQuantity - 1e-6;
    const quantity = isFull ? heldQuantity : roundFundUnits(quantityRaw, METAL_QUANTITY_DECIMALS);
    if (!(quantity > 0)) return { ok: false, message: "提取数量需大于 0" };
    if (!isFull && quantity > heldQuantity + 1e-6) {
      return { ok: false, message: `提取数量不能超过可用 ${trimNumberText(heldQuantity)}` };
    }

    const unitCost = heldQuantity > 0 ? heldCost / heldQuantity : toNumber(holding.avgCost);
    // 全部提出时直接搬走整块成本，避免四舍五入留下 0.01 的残值。
    const costOut = isFull ? Number(heldCost.toFixed(2)) : Number((unitCost * quantity).toFixed(2));
    if (!(costOut > 0)) return { ok: false, message: "该持仓没有成本可结转，请先补记买入成本" };

    const [metalType, metalUnit] = await Promise.all([
      prisma.preciousMetalType.findUnique({ where: { id: metalTypeId }, select: { name: true, code: true, shortName: true } }),
      prisma.preciousMetalUnit.findUnique({ where: { id: metalUnitId }, select: { name: true, symbol: true } }),
    ]);

    const typeName = metalType?.name || holding.metalTypeName || "贵金属";
    const shortName = (metalType?.shortName || metalType?.code || "").trim();
    const unitSymbol = (metalUnit?.symbol || "").trim();
    const quantityText = `${trimNumberText(quantity)}${unitSymbol}`;
    const autoName = `实物${typeName} ${shortName ? `${shortName} ` : ""}${quantityText}`;
    const assetName = (nameRaw || autoName).trim();
    const unitNameSnapshot = metalUnit
      ? metalUnit.symbol
        ? `${metalUnit.name}(${metalUnit.symbol})`
        : metalUnit.name
      : holding.metalUnitName;

    const metalUnitPrice = Number((costOut / quantity).toFixed(6));
    const categoryName = getInvestmentCategoryName({
      fundProductType: "metal",
      fundSubtype: FundSubtype.redeem,
      source: TRANSACTION_SOURCE_METAL_EXTRACT,
    });

    const created = await prisma.$transaction(async (tx) => {
      const category = categoryName
        ? await resolveCategorySnapshot(tx, householdId, { categoryName, type: TransactionType.investment })
        : null;

      // 提取实物明细：贵金属账户(出) → 固定资产账户(入)，金额 = 移出成本（不为负，赎回口径），
      // 因此回算的已实现盈亏恒为 0。资金侧没有现金账户参与。
      const entry = await tx.txRecord.create({
        data: {
          householdId,
          date: tradeDate,
          type: TransactionType.investment,
          accountId: metalAccount.id,
          accountName: metalAccount.name,
          toAccountId: propertyAccount.id,
          toAccountName: propertyAccount.name,
          amount: costOut,
          currency: metalAccount.currency ?? propertyAccount.currency ?? "CNY",
          fundName: typeName,
          fundProductType: "metal",
          fundSubtype: FundSubtype.redeem,
          metalTypeId,
          metalTypeName: typeName,
          metalUnitId,
          metalUnitName: unitNameSnapshot,
          metalQuantity: quantity,
          metalUnitPrice,
          metalFee: 0,
          source: TRANSACTION_SOURCE_METAL_EXTRACT,
          entryOrigin: ENTRY_ORIGIN_MANUAL,
          categoryId: category?.id ?? null,
          categoryName: category?.name ?? categoryName ?? null,
          note: noteRaw || `提取实物转固定资产：${assetName}`,
        },
        select: { id: true },
      });

      const asset = await tx.propertyAsset.create({
        data: {
          householdId,
          accountId: propertyAccount.id,
          name: assetName,
          assetType: FixedAssetType.collectible,
          currency: metalAccount.currency ?? propertyAccount.currency ?? "CNY",
          purchaseDate: tradeDate,
          purchasePrice: String(costOut),
          cost: String(costOut),
          marketValue: String(costOut),
          latestValuationDate: tradeDate,
          status: "active",
          note: `贵金属提取实物：${typeName} ${quantityText}`,
        },
        select: { id: true, name: true },
      });

      await tx.propertyTransaction.create({
        data: {
          householdId,
          accountId: propertyAccount.id,
          propertyAssetId: asset.id,
          // 没有真实现金流水，但保留 cashEntryId 关联：删除提取实物明细时
          // entry-delete 会连带软删这条固定资产交易并回收资产。
          cashAccountId: null,
          cashEntryId: entry.id,
          action: PropertyTransactionAction.purchase,
          source: TRANSACTION_SOURCE_METAL_EXTRACT,
          entryOrigin: ENTRY_ORIGIN_MANUAL,
          tradeDate,
          amount: String(costOut),
          note: `提取实物转入：${metalAccount.name}`,
        },
        select: { id: true },
      });

      return { entryId: entry.id, asset };
    });

    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: created.entryId });
    await recalcPreciousMetalPositions(metalAccount.id);
    await applyEntryChangesToAccountBalances([{ entryId: created.entryId }]);
    await recalcPropertyAssetsFromTransactions(prisma, { householdId, propertyAssetIds: [created.asset.id] });
    await recalcAndSaveAccountBalance(propertyAccount.id).catch(() => {});
    await revalidateAfterInvestChange({ skipHomePath: true });

    return { ok: true, assetId: created.asset.id, assetName: created.asset.name, quantity, cost: costOut };
  } catch (error) {
    console.error("[metal-actions/extract]", error);
    return { ok: false, message: error instanceof Error ? error.message : "提取实物失败" };
  }
}

/**
 * 编辑提取实物明细：提取实物只认「提取数量」（2026-11-13 用户裁定）。
 *
 * - 金额永远由「平均成本 × 新克数」重算，全额提出时直接搬走整块成本，避免四舍五入残值；
 *   重算后的成本同步写回固定资产交易与收藏品资产，已实现盈亏仍为 0。
 * - 品种 / 单位 / 贵金属账户 / 固定资产账户沿用原明细：要换就删了重记，
 *   否则持仓与收藏品资产两边对不上。
 */
export async function updateMetalExtractEntry(formData: FormData): Promise<MetalExtractResult> {
  try {
    const ctx = await getHouseholdScope();
    const householdId = ctx.householdId;

    const entryId = String(formData.get("entryId") ?? formData.get("transactionId") ?? "").trim();
    if (!entryId) return { ok: false, message: "缺少提取实物明细" };
    const quantityRaw = toNumber(formData.get("metalQuantity") ?? formData.get("fundUnits"));
    if (!(quantityRaw > 0)) return { ok: false, message: "提取数量需大于 0" };
    const dateStr = String(formData.get("date") ?? "").trim();
    const memoProvided = formData.has("memo") || formData.has("note");
    const memoStr = String(formData.get("memo") ?? formData.get("note") ?? "").trim();

    const entry = await prisma.txRecord.findFirst({
      where: { id: entryId, householdId, source: TRANSACTION_SOURCE_METAL_EXTRACT, deletedAt: null },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        date: true,
        amount: true,
        metalTypeId: true,
        metalTypeName: true,
        metalUnitId: true,
        metalQuantity: true,
      },
    });
    if (!entry) return { ok: false, message: "提取实物明细不存在" };
    const metalAccountId = entry.accountId;
    const propertyAccountId = entry.toAccountId;
    const metalTypeId = entry.metalTypeId;
    const metalUnitId = entry.metalUnitId;
    if (!metalAccountId || !propertyAccountId || !metalTypeId || !metalUnitId) {
      return { ok: false, message: "提取实物明细缺少账户或品种信息，请删除后重新记账" };
    }

    const propertyTransaction = await prisma.propertyTransaction.findFirst({
      where: { householdId, cashEntryId: entry.id, source: TRANSACTION_SOURCE_METAL_EXTRACT },
      select: { id: true, propertyAssetId: true },
    });
    if (!propertyTransaction) {
      return { ok: false, message: "提取实物明细对应的固定资产交易已不存在，请删除后重新记账" };
    }

    const holding = await prisma.preciousMetalHolding.findFirst({
      where: { householdId, accountId: metalAccountId, metalTypeId, metalUnitId },
      select: { quantity: true, cost: true },
    });
    const previousQuantity = toNumber(entry.metalQuantity);
    const previousCost = toNumber(entry.amount);
    // 明细本身已经从持仓里扣掉了，可用量要把它加回来。
    const heldQuantity = toNumber(holding?.quantity);
    const available = heldQuantity + previousQuantity;
    if (!(available > 0)) return { ok: false, message: "该账户没有此品种的持仓" };
    if (quantityRaw > available + 1e-6) {
      return { ok: false, message: `提取数量不能超过可用 ${trimNumberText(available)}` };
    }
    const isFull = quantityRaw >= available - 1e-6;
    const quantity = isFull ? available : roundFundUnits(quantityRaw, METAL_QUANTITY_DECIMALS);
    if (!(quantity > 0)) return { ok: false, message: "提取数量需大于 0" };

    // 成本基数 = 现持仓成本 + 这条明细已结转的成本，也就是「提取实物前」的整块成本。
    const costBasis = toNumber(holding?.cost) + previousCost;
    const costOut = isFull
      ? Number(costBasis.toFixed(2))
      : Number(((costBasis / available) * quantity).toFixed(2));
    if (!(costOut > 0)) return { ok: false, message: "该持仓没有成本可结转，请先补记买入成本" };
    const metalUnitPrice = Number((costOut / quantity).toFixed(6));

    const [metalType, metalUnit] = await Promise.all([
      prisma.preciousMetalType.findUnique({ where: { id: metalTypeId }, select: { name: true, code: true, shortName: true } }),
      prisma.preciousMetalUnit.findUnique({ where: { id: metalUnitId }, select: { name: true, symbol: true } }),
    ]);
    const typeName = metalType?.name || entry.metalTypeName || "贵金属";
    const shortName = (metalType?.shortName || metalType?.code || "").trim();
    const unitSymbol = (metalUnit?.symbol || "").trim();
    const quantityText = `${trimNumberText(quantity)}${unitSymbol}`;
    const autoName = `实物${typeName} ${shortName ? `${shortName} ` : ""}${quantityText}`;
    // 只有名字还是当初自动生成的那份才跟着克数改；用户改过名字就不动。
    const previousAutoName = `实物${typeName} ${shortName ? `${shortName} ` : ""}${trimNumberText(previousQuantity)}${unitSymbol}`;

    const tradeDate = parseDateInputToUtc(dateStr) ?? entry.date;
    const asset = await prisma.propertyAsset.findUnique({
      where: { id: propertyTransaction.propertyAssetId },
      select: { id: true, name: true },
    });
    const renameAsset = asset != null && asset.name === previousAutoName;

    await prisma.$transaction(async (tx) => {
      await tx.txRecord.update({
        where: { id: entry.id },
        data: {
          amount: costOut,
          metalQuantity: quantity,
          metalUnitPrice,
          date: tradeDate,
          ...(memoProvided ? { note: memoStr || `提取实物转固定资产：${autoName}` } : {}),
        },
      });
      await tx.propertyTransaction.update({
        where: { id: propertyTransaction.id },
        data: { amount: String(costOut), tradeDate },
      });
      if (asset) {
        await tx.propertyAsset.update({
          where: { id: asset.id },
          data: {
            purchaseDate: tradeDate,
            ...(renameAsset ? { name: autoName } : {}),
            note: `贵金属提取实物：${typeName} ${quantityText}`,
          },
        });
      }
    });

    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: entry.id });
    await recalcPreciousMetalPositions(metalAccountId);
    await applyEntryChangesToAccountBalances([{ entryId: entry.id }]);
    await recalcPropertyAssetsFromTransactions(prisma, {
      householdId,
      propertyAssetIds: [propertyTransaction.propertyAssetId],
    });
    await recalcAndSaveAccountBalance(propertyAccountId).catch(() => {});
    await revalidateAfterInvestChange({ skipHomePath: true });

    return {
      ok: true,
      quantity,
      cost: costOut,
      assetId: asset?.id,
      assetName: renameAsset ? autoName : asset?.name,
    };
  } catch (error) {
    console.error("[metal-actions/updateExtract]", error);
    return { ok: false, message: error instanceof Error ? error.message : "保存提取实物明细失败" };
  }
}
