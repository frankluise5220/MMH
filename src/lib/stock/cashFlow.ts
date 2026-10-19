import { Prisma, StockTransactionAction, TransactionType } from "@prisma/client";
import { ENTRY_ORIGIN_MANUAL } from "@/lib/transaction-semantics";

import { toNumber } from "@/lib/date-utils";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { getStockInvestmentCategoryName } from "@/lib/investment-category";
import {
  upsertEntryBusinessCashFlowLink,
  type EntryCashFlowDirection,
} from "@/lib/server/entry-business-link";
import { prisma } from "@/lib/db/prisma";
import { getCashFlowDate } from "@/lib/cash-flow-date";
import { investmentTargetText, isAutoInvestmentSourceNote } from "@/lib/investment-cash-note";

type TxClient = Prisma.TransactionClient | typeof prisma;

export type StockCashFlowRow = {
  id: string;
  householdId: string;
  stockAccountId: string;
  cashAccountId?: string | null;
  action: StockTransactionAction;
  source?: string | null;
  entryOrigin?: string | null;
  tradeDate: Date;
  settleDate?: Date | null;
  grossAmount: unknown;
  netAmount?: unknown | null;
  quantity?: unknown | null;
  price?: unknown | null;
  fee?: unknown | null;
  commission?: unknown | null;
  stampTax?: unknown | null;
  transferFee?: unknown | null;
  exchangeFee?: unknown | null;
  regulatoryFee?: unknown | null;
  otherFee?: unknown | null;
  realizedProfit?: unknown | null;
  stockCode: string;
  stockName?: string | null;
  note?: string | null;
  cashEntryId?: string | null;
};

type AccountSnapshot = {
  id: string;
  name: string;
  currency?: string | null;
};

export function stockActionLabel(action: StockTransactionAction | string) {
  if (action === StockTransactionAction.buy) return "股票买入";
  if (action === StockTransactionAction.sell) return "股票卖出";
  if (action === StockTransactionAction.dividend) return "股票分红";
  if (action === StockTransactionAction.bonus_share) return "送股";
  if (action === StockTransactionAction.split_share) return "拆股";
  if (action === StockTransactionAction.merge_share) return "并股";
  if (action === StockTransactionAction.fee_adjustment) return "股票费用调整";
  if (action === StockTransactionAction.tax_adjustment) return "股票税费调整";
  return "股票交易";
}

export function totalStockFee(row: Partial<StockCashFlowRow>) {
  return (
    toNumber(row.fee) +
    toNumber(row.commission) +
    toNumber(row.stampTax) +
    toNumber(row.transferFee) +
    toNumber(row.exchangeFee) +
    toNumber(row.regulatoryFee) +
    toNumber(row.otherFee)
  );
}

export function isStockCashInAction(action: StockTransactionAction | string) {
  return action === StockTransactionAction.sell || action === StockTransactionAction.dividend;
}

export function isStockCashOutAction(action: StockTransactionAction | string) {
  return (
    action === StockTransactionAction.buy ||
    action === StockTransactionAction.fee_adjustment ||
    action === StockTransactionAction.tax_adjustment
  );
}

export function stockCashFlowDirection(action: StockTransactionAction | string): EntryCashFlowDirection {
  if (isStockCashInAction(action)) return "inflow";
  if (isStockCashOutAction(action)) return "outflow";
  return "none";
}

export function stockCashAmount(row: Partial<StockCashFlowRow>) {
  const action = row.action;
  if (!action || stockCashFlowDirection(action) === "none") return 0;
  const grossAmount = Math.abs(toNumber(row.grossAmount));
  const netAmount = row.netAmount == null ? null : Math.abs(toNumber(row.netAmount));
  const fees = totalStockFee(row);
  if (netAmount != null) return netAmount;
  if (isStockCashInAction(action)) return Math.max(0, grossAmount - fees);
  return grossAmount + fees;
}

/**
 * 资金侧备注：用户写了备注就用用户备注，否则「股票买入 代码 名称」。
 *
 * 股票业务行的 note 可能是系统自动写的「资金来源 账户名」（用户没写备注时），
 * 那不是用户备注，不能把它当成资金侧备注，否则资金侧就看不到交易动作了。
 */
function buildStockCashFlowNote(row: StockCashFlowRow, cashAccountName?: string | null) {
  const label = stockActionLabel(row.action);
  const customNote = isAutoInvestmentSourceNote(row.note, cashAccountName) ? "" : row.note?.trim();
  if (customNote) return customNote;
  const target = investmentTargetText(row.stockCode, row.stockName);
  return target ? `${label} ${target}` : label;
}

export async function ensureStockTransactionCashFlow(
  client: TxClient,
  params: {
    householdId: string;
    row: StockCashFlowRow;
    stockAccount: AccountSnapshot;
    cashAccount?: AccountSnapshot | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const direction = stockCashFlowDirection(params.row.action);
  const cashAmount = stockCashAmount(params.row);
  const shouldCreateCashEntry = direction !== "none" && cashAmount > 0 && params.row.cashAccountId && params.cashAccount;
  let cashEntryId: string | null = params.row.cashEntryId ?? null;

  if (shouldCreateCashEntry && params.cashAccount) {
    const isCashIn = direction === "inflow";
    const categoryName = getStockInvestmentCategoryName(params.row.action);
    const category = await resolveCategorySnapshot(client, params.householdId, {
      categoryName,
      type: "investment",
    });
    const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
    const cashDate = getCashFlowDate({
      direction,
      operationDate: params.row.tradeDate,
      settlementDate: params.row.settleDate,
    });
    const cashEntryData = {
      householdId: params.householdId,
      date: cashDate,
      type: TransactionType.investment,
      accountId: params.cashAccount.id,
      accountName: params.cashAccount.name,
      toAccountId: null,
      toAccountName: null,
      amount: signedCashAmount,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? categoryName,
      currency: params.cashAccount.currency ?? params.stockAccount.currency ?? "CNY",
      source: params.row.source ?? "manual",
      entryOrigin: params.row.entryOrigin ?? ENTRY_ORIGIN_MANUAL,
      note: buildStockCashFlowNote(params.row, params.cashAccount.name),
      fundCode: null,
      fundProductType: null,
      fundSubtype: null,
      fundName: null,
      wealthProductId: null,
      metalTypeId: null,
      metalTypeName: null,
      metalUnitId: null,
      metalUnitName: null,
      metalQuantity: null,
      metalUnitPrice: null,
      metalFee: null,
      insuranceProductId: null,
      insuranceAction: null,
      insuranceProductName: null,
      fundUnits: null,
      fundNav: null,
      fundFee: null,
      fundConfirmDate: null,
      // 股票资金腿的生效日由上面的 date 承担（`getCashFlowDate`：流入取结算日）；
      // 这里仍把结算日写进到账日字段，与基金 / 理财 / 金属的资金腿保持同一份事实
      // （本行 `toAccountId` 为 null、`fundSubtype` 为 null，解析器不会用它覆盖 date）。
      fundArrivalDate: isCashIn ? (params.row.settleDate ?? null) : null,
      fundArrivalAmount: null,
      depositAnnualRate: null,
      depositInterest: null,
      realizedProfit: params.row.realizedProfit == null ? null : toNumber(params.row.realizedProfit),
      deletedAt: null,
    };

    const existingCashEntry = cashEntryId
      ? await client.txRecord.findUnique({ where: { id: cashEntryId } })
      : null;
    const cashEntry = existingCashEntry
      ? await client.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
      : await client.txRecord.create({ data: cashEntryData });

    cashEntryId = cashEntry.id;
    await client.stockTransaction.update({
      where: { id: params.row.id },
      data: {
        cashEntryId,
        cashAccountId: params.row.cashAccountId ?? params.cashAccount.id,
      },
    });
  }

  const linkId = await upsertEntryBusinessCashFlowLink(client, {
    householdId: params.householdId,
    cashEntryId,
    businessEntryId: null,
    stockTransactionId: params.row.id,
    businessType: "stock",
    cashFlowDirection: direction,
    source: params.row.source ?? "manual",
    note: "Linked cash flow to stock transaction",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
      ...(params.metadata ?? {}),
    },
  });

  return {
    cashEntryId,
    linkId: linkId ?? null,
    cashFlowDirection: direction,
    cashAmount: direction === "outflow" ? -Math.abs(cashAmount) : Math.abs(cashAmount),
  };
}
