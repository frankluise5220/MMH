/**
 * API: /api/v1/properties
 *
 * GET
 *   Query: accountId?: property investment account id
 *   Response: { ok: true, data: { assets, transactions } } where each asset includes mortgageLoanAccountId when linked.
 *
 * POST
 *   Body: {
 *     accountId, cashAccountId?, propertyAssetId?,
 *     action: "purchase" | "improvement" | "sale" | "disposal",
 *     name?, assetType?, propertyType?, address?, attributes?, tradeDate, settlementDate?,
 *     productionDate?, weight?, weightUnit?,
 *     amount, fee?, tax?, marketValue?, depreciation?, note?
 *   }
 *   Creates/updates the property asset, writes a PropertyTransaction, and
 *   creates the linked cash-side TxRecord when cashAccountId is supplied.
 *
 * PUT
 *   Body: { propertyAssetId, name?, assetType?, propertyType?, address?, attributes?, purchaseDate?,
 *          productionDate?, weight?, weightUnit?, purchasePrice?, note?, depreciationMethod?,
 *          usefulLifeMonths?, salvageValue?, accumulatedDepreciation? }
 *   Updates the fixed asset info fields on the PropertyAsset record. 折旧相关字段只有传了
 *   才会写（未传 = 保持原值），避免老的局部提交把折旧清空。
 *
 * 折旧口径：见 src/lib/fixed-asset-depreciation.ts。出售 / 处置的 realizedProfit 按
 * 账面净值（cost − 累计折旧）计算，处置时可以再传 depreciation（本次折损/折旧）。
 */
import { NextRequest, NextResponse } from "next/server";
import { AccountKind, Prisma, PropertyTransactionAction } from "@prisma/client";

import { normalizeCurrency } from "@/lib/currency";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";
import {
  DepreciationMethod,
  normalizeDepreciationMethod,
  normalizeWeightUnit,
  resolveAssetDepreciation,
} from "@/lib/fixed-asset-depreciation";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { ensurePropertyTransactionCashFlow } from "@/lib/property/cashFlow";
import { findUnsettledCollateralLoanAccounts } from "@/lib/server/collateral-mortgage";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import {
  depreciationPeriodMonth,
  recordedDepreciationTotal,
  recordedManualDepreciationTotal,
  syncPropertyAssetDepreciations,
} from "@/lib/server/property-depreciation";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const PROPERTY_ACTIONS = new Set(Object.values(PropertyTransactionAction));

/**
 * 抵押中的固定资产不能售出 / 处置（2026-11-15 用户裁定）。
 * 资产端 status=mortgaged 或 mortgageLoanAccountId 非空即视为抵押中；
 * 解除方式只有两条：结清贷款（自动解除）或在资产编辑里取消「抵押中」。
 */
const MORTGAGED_ASSET_LOCKED_MESSAGE = "该固定资产仍处于抵押中，请先结清对应贷款（结清后自动解除抵押）或在资产编辑里取消「抵押中」，再售出 / 处置";

/** 事务里抛出、catch 里转成 409 的哨兵错误（普通 Error 会被当成 500 处理）。 */
class MortgagedAssetLockedError extends Error {
  constructor(message: string = MORTGAGED_ASSET_LOCKED_MESSAGE) {
    super(message);
    this.name = "MortgagedAssetLockedError";
  }
}

/** 贷款侧反查到未结清抵押时的提示：把贷款账户名带上，用户知道该还哪笔。 */
function unsettledCollateralMessage(loanNames: string[]) {
  return `该固定资产仍抵押在未结清的贷款${loanNames.map((name) => `「${name}」`).join("、")}上，请先结清该贷款（结清后自动解除抵押）再售出 / 处置`;
}

function mortgagedAssetLockedResponse(message: string = MORTGAGED_ASSET_LOCKED_MESSAGE) {
  return NextResponse.json(
    { ok: false, code: "MORTGAGED_ASSET_CANNOT_TERMINATE", error: message },
    { status: 409, headers: corsHeaders() },
  );
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function parseDateOnly(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return 0;
  const num = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function parseOptionalNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return null;
  return parseNonNegativeNumber(value);
}

function decimalString(value: number | null) {
  return value == null ? null : String(value);
}

function parseAttributes(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value == null) return Prisma.JsonNull;
  if (typeof value === "object" && !Array.isArray(value)) return value as Prisma.InputJsonValue;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Prisma.InputJsonValue) : Prisma.JsonNull;
    } catch {
      return Prisma.JsonNull;
    }
  }
  return Prisma.JsonNull;
}

function normalizePropertyAction(value: unknown) {
  const action = String(value ?? PropertyTransactionAction.purchase).trim();
  return PROPERTY_ACTIONS.has(action as PropertyTransactionAction)
    ? (action as PropertyTransactionAction)
    : PropertyTransactionAction.purchase;
}

async function assertPropertyAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: AccountKind.investment, investProductType: "property" },
    select: { id: true, householdId: true, name: true, currency: true, fixedAssetType: true },
  });
  if (!account) throw new Error("房产账户不存在或不属于当前账簿");
  return account;
}

async function findCashAccount(accountId: string | null, householdId: string) {
  if (!accountId) return null;
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isPlaceholder: { not: true } },
    select: { id: true, name: true, kind: true, currency: true },
  });
  if (!account) throw new Error("资金账户不存在或不属于当前账簿");
  const isCashLike = account.kind === AccountKind.bank_debit || account.kind === AccountKind.cash || account.kind === AccountKind.ewallet;
  if (!isCashLike) throw new Error("房产资金账户必须是现金、借记卡或钱包账户");
  return account;
}

/**
 * 折旧台账摘要（单资产详情 / 资产编辑弹窗用）。
 * `periods` / `recorded` 只算自动计提（直线法）；手工登记的折损单独给
 * `manualCount` / `manualTotal`，否则两边混算会让处置结算把折损算两遍。
 */
type AssetDepreciationSummary = {
  periods: number;
  recorded: number;
  lastPeriod: string | null;
  manualCount: number;
  manualTotal: number;
};

function serializeAsset(row: {
  id: string;
  accountId: string;
  mortgageLoanAccountId?: string | null;
  name: string;
  assetType?: string | null;
  propertyType?: string | null;
  address?: string | null;
  attributes?: unknown | null;
  currency?: string | null;
  purchaseDate?: Date | null;
  productionDate?: Date | null;
  weight?: unknown | null;
  weightUnit?: string | null;
  purchasePrice?: unknown | null;
  cost: unknown;
  marketValue: unknown;
  depreciationMethod?: string | null;
  usefulLifeMonths?: number | null;
  salvageValue?: unknown | null;
  accumulatedDepreciation?: unknown | null;
  latestValuationDate?: Date | null;
  status: string;
  note?: string | null;
}, depreciation?: AssetDepreciationSummary) {
  return {
    id: row.id,
    accountId: row.accountId,
    mortgageLoanAccountId: row.mortgageLoanAccountId ?? null,
    name: row.name,
    assetType: normalizeFixedAssetType(row.assetType),
    propertyType: row.propertyType ?? null,
    address: row.address ?? null,
    attributes: row.attributes ?? null,
    currency: normalizeCurrency(row.currency),
    purchaseDate: row.purchaseDate ? formatDateUtc(row.purchaseDate) : null,
    productionDate: row.productionDate ? formatDateUtc(row.productionDate) : null,
    weight: row.weight == null ? null : toNumber(row.weight),
    weightUnit: normalizeWeightUnit(row.weightUnit),
    purchasePrice: row.purchasePrice == null ? null : toNumber(row.purchasePrice),
    cost: toNumber(row.cost),
    marketValue: toNumber(row.marketValue),
    depreciationMethod: normalizeDepreciationMethod(row.depreciationMethod),
    usefulLifeMonths: row.usefulLifeMonths ?? null,
    salvageValue: row.salvageValue == null ? 0 : toNumber(row.salvageValue),
    accumulatedDepreciation: row.accumulatedDepreciation == null ? 0 : toNumber(row.accumulatedDepreciation),
    latestValuationDate: row.latestValuationDate ? formatDateUtc(row.latestValuationDate) : null,
    status: row.status,
    note: row.note ?? null,
    depreciation: depreciation ?? { periods: 0, recorded: 0, lastPeriod: null, manualCount: 0, manualTotal: 0 },
  };
}

function serializeTransaction(row: {
  id: string;
  accountId: string;
  cashAccountId?: string | null;
  cashEntryId?: string | null;
  propertyAssetId: string;
  action: PropertyTransactionAction;
  source?: string | null;
  tradeDate: Date;
  settlementDate?: Date | null;
  amount: unknown;
  fee?: unknown | null;
  tax?: unknown | null;
  realizedProfit?: unknown | null;
  note?: string | null;
  PropertyAsset?: { name?: string | null } | null;
  Account?: { name?: string | null } | null;
  CashAccount?: { name?: string | null } | null;
  EntryBusinessLink?: Array<{ id: string }> | null;
}) {
  return {
    id: row.id,
    linkId: row.EntryBusinessLink?.[0]?.id ?? null,
    cashEntryId: row.cashEntryId ?? null,
    accountId: row.accountId,
    accountName: row.Account?.name ?? "",
    cashAccountId: row.cashAccountId ?? null,
    cashAccountName: row.CashAccount?.name ?? null,
    propertyAssetId: row.propertyAssetId,
    propertyName: row.PropertyAsset?.name ?? null,
    action: row.action,
    source: row.source ?? "manual",
    tradeDate: formatDateUtc(row.tradeDate),
    settlementDate: row.settlementDate ? formatDateUtc(row.settlementDate) : null,
    amount: toNumber(row.amount),
    fee: row.fee == null ? null : toNumber(row.fee),
    tax: row.tax == null ? null : toNumber(row.tax),
    realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
    note: row.note ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || "";
    if (accountId) await assertPropertyAccount(accountId, householdId);
    // The transaction list is only needed by full property views; entry dialogs
    // pass transactions=0 to skip the heavy query. linkedCashEntryId asks for
    // the single property transaction linked to one cash entry (loan/fixed-asset
    // edit prefill).
    const includeTransactions = req.nextUrl.searchParams.get("transactions") !== "0";
    const linkedCashEntryId = req.nextUrl.searchParams.get("linkedCashEntryId")?.trim() || "";
    // 单资产详情：固定资产编辑弹窗要读整行（生产日期 / 重量 / 折旧等新列），
    // 而持仓列表走的是白名单 select，拿不到这些字段。
    const assetId = req.nextUrl.searchParams.get("assetId")?.trim() || "";
    // 单资产详情就是「用户点开编辑」这一刻：顺手把折旧台账补到当前月，
    // 弹窗里的「已计提 N 期」不会落后于定时任务一轮。
    if (assetId) {
      try {
        await syncPropertyAssetDepreciations({ householdId, propertyAssetId: assetId });
      } catch {
        // 补记失败不影响详情读取，系统任务下一轮会补。
      }
    }

    const [assets, transactions, linkedTransaction] = await Promise.all([
      prisma.propertyAsset.findMany({
        where: {
          householdId,
          deletedAt: null,
          ...(accountId ? { accountId } : {}),
          ...(assetId ? { id: assetId } : {}),
        },
        orderBy: [{ status: "asc" }, { latestValuationDate: "desc" }, { createdAt: "asc" }],
      }),
      includeTransactions
        ? prisma.propertyTransaction.findMany({
            where: { householdId, deletedAt: null, ...(accountId ? { accountId } : {}) },
            include: {
              Account: true,
              CashAccount: true,
              PropertyAsset: true,
              EntryBusinessLink: { where: { deletedAt: null }, select: { id: true }, take: 1 },
            },
            orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
            take: 500,
          })
        : Promise.resolve([] as Array<Prisma.PropertyTransactionGetPayload<{ include: {
            Account: true;
            CashAccount: true;
            PropertyAsset: true;
            EntryBusinessLink: { where: { deletedAt: null }; select: { id: true }; take: 1 };
          } }>>),
      linkedCashEntryId
        ? prisma.propertyTransaction.findFirst({
            where: { householdId, cashEntryId: linkedCashEntryId, deletedAt: null },
            select: { accountId: true, propertyAssetId: true },
          })
        : Promise.resolve(null),
    ]);

    // 折旧台账摘要：一次 groupBy（按资产 × 来源）拿到已计提期数、累计金额、最近一期，
    // 不逐资产查（资产数会到几十个）。自动计提与手工折损分开累计。
    const depreciationGroups = assets.length > 0
      ? await prisma.propertyAssetDepreciation.groupBy({
          by: ["propertyAssetId", "method"],
          where: { propertyAssetId: { in: assets.map((asset) => asset.id) } },
          _count: { _all: true },
          _sum: { amount: true },
          _max: { periodMonth: true },
        })
      : [];
    const depreciationByAsset = new Map<string, AssetDepreciationSummary>();
    for (const group of depreciationGroups) {
      const current = depreciationByAsset.get(group.propertyAssetId) ?? {
        periods: 0,
        recorded: 0,
        lastPeriod: null,
        manualCount: 0,
        manualTotal: 0,
      };
      if ((group.method ?? "straight_line") === "manual") {
        current.manualCount = group._count._all;
        current.manualTotal = toNumber(group._sum.amount ?? 0);
      } else {
        current.periods = group._count._all;
        current.recorded = toNumber(group._sum.amount ?? 0);
        current.lastPeriod = group._max.periodMonth ? formatDateUtc(group._max.periodMonth) : null;
      }
      depreciationByAsset.set(group.propertyAssetId, current);
    }

    return NextResponse.json({
      ok: true,
      data: {
        assets: assets.map((asset) => serializeAsset(asset, depreciationByAsset.get(asset.id))),
        transactions: transactions.map(serializeTransaction),
        linkedTransaction: linkedTransaction
          ? {
              cashEntryId: linkedCashEntryId,
              accountId: linkedTransaction.accountId,
              propertyAssetId: linkedTransaction.propertyAssetId,
            }
          : null,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "查询失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_REQUEST_BODY", error: "请求体无效" }, { status: 400, headers: corsHeaders() });

    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_PROPERTY_ACCOUNT", error: "缺少房产账户" }, { status: 400, headers: corsHeaders() });
    const propertyAccount = await assertPropertyAccount(accountId, householdId);
    const cashAccountId = String(body.cashAccountId ?? "").trim() || null;
    const cashAccount = await findCashAccount(cashAccountId, householdId);
    const action = normalizePropertyAction(body.action);
    const tradeDate = parseDateOnly(body.tradeDate);
    const settlementDate = parseDateOnly(body.settlementDate);
    if (!tradeDate) return NextResponse.json({ ok: false, code: "INVALID_TRADE_DATE", error: "交易日期无效" }, { status: 400, headers: corsHeaders() });

    const amount = parseNonNegativeNumber(body.amount);
    const fee = parseOptionalNonNegativeNumber(body.fee);
    const tax = parseOptionalNonNegativeNumber(body.tax);
    const marketValueInput = parseOptionalNonNegativeNumber(body.marketValue);
    const isDisposal = action === PropertyTransactionAction.disposal;
    /**
     * 处置方式（报废 / 赠送 / 遗弃 / 损耗 / 其他）+ 折损率（只有「损耗」带）。
     * 报废、赠送、遗弃是「完全没有了」：没有回款、没有残值，折损率一律不填；
     * 损耗是「还剩下一部分」：0<r<1 时把剩余部分按 1−r 重新入库。
     */
    const disposalReason = String(body.disposalReason ?? "").trim();
    const lossRatioInput = parseOptionalNonNegativeNumber(body.lossRatio);
    const partialLossRatio = isDisposal && disposalReason === "loss" && lossRatioInput != null && lossRatioInput > 0 && lossRatioInput < 1
      ? lossRatioInput
      : null;
    const isPurchase = action === PropertyTransactionAction.purchase;
    const isImprovement = action === PropertyTransactionAction.improvement;
    // 购入 / 产值调整（improvement）允许金额为 0：只登记资产、或只改产值，
    // 不生成现金流（`ensurePropertyTransactionCashFlow` 在金额为 0 时本就不建流水）。
    // 出售仍要求金额 > 0，纯粹没回款的报废走 disposal。
    if (amount <= 0 && !isDisposal && !isPurchase && !isImprovement) {
      return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "交易金额必须大于 0" }, { status: 400, headers: corsHeaders() });
    }

    const touchedAccountIds = new Set<string>([accountId]);
    if (cashAccountId) touchedAccountIds.add(cashAccountId);

    const created = await prisma.$transaction(async (tx) => {
      const totalCostDelta = amount + (fee ?? 0) + (tax ?? 0);
      let propertyAssetId = String(body.propertyAssetId ?? "").trim();
      let existingAsset = propertyAssetId
        ? await tx.propertyAsset.findFirst({ where: { id: propertyAssetId, householdId, accountId, deletedAt: null } })
        : null;
      // 出售 / 处置时结算出来的累计折旧（含本次折损），用于算账面净值与处置损益。
      let settledAccumulated: number | null = null;
      /**
       * 损耗处置的结算结果（只在 0<折损率<1 时有值）：原资产按折损部分记损失，
       * 剩余部分按净值 × (1 − 折损率) 在同一账户下重新入库，继续持有。
       */
      let lossSettlement: {
        ratio: number;
        lossAmount: number;
        reentryCost: number;
        reentryMarketValue: number;
        reentryWeight: number | null;
      } | null = null;
      const nextAssetType = normalizeFixedAssetType(
        action === PropertyTransactionAction.purchase
          ? body.assetType ?? propertyAccount.fixedAssetType
          : existingAsset?.assetType ?? propertyAccount.fixedAssetType,
      );

      if (action === PropertyTransactionAction.purchase) {
        // 资产名称可选：留空时沿用固定资产账户名称（与支出链路
        // linkExpenseToFixedAsset 的「propertyName || propertyAccount.name」口径一致）。
        const assetName = String(body.name ?? "").trim() || propertyAccount.name.trim();
        if (!assetName) throw new Error("购入固定资产需要填写资产名称或账户名称");
        const initialMarketValue = marketValueInput ?? totalCostDelta;
        existingAsset = await tx.propertyAsset.create({
          data: {
            householdId,
            accountId,
            name: assetName,
            assetType: nextAssetType,
            propertyType: String(body.propertyType ?? "").trim() || null,
            address: String(body.address ?? "").trim() || null,
            attributes: parseAttributes(body.attributes),
            currency: propertyAccount.currency ?? cashAccount?.currency ?? "CNY",
            purchaseDate: tradeDate,
            productionDate: parseDateOnly(body.productionDate),
            weight: decimalString(parseOptionalNonNegativeNumber(body.weight)),
            weightUnit: body.weightUnit == null ? null : normalizeWeightUnit(body.weightUnit),
            purchasePrice: decimalString(amount),
            cost: String(totalCostDelta),
            marketValue: String(initialMarketValue),
            latestValuationDate: tradeDate,
            note: String(body.note ?? "").trim() || null,
          },
        });
        propertyAssetId = existingAsset.id;
        await tx.propertyValuation.create({
          data: {
            householdId,
            propertyAssetId,
            valuationDate: tradeDate,
            marketValue: String(initialMarketValue),
            source: "purchase",
            note: "购入时初始估值",
          },
        });
      } else {
        if (!existingAsset) throw new Error("房产不存在或不属于当前账户");
        const isTerminal = action === PropertyTransactionAction.sale || action === PropertyTransactionAction.disposal;
        const recovery = isTerminal ? Math.max(0, amount - (fee ?? 0) - (tax ?? 0)) : 0;
        const nextCost = action === PropertyTransactionAction.improvement
          ? toNumber(existingAsset.cost) + totalCostDelta
          : toNumber(existingAsset.cost);
        const nextMarketValue = isTerminal
          ? recovery
          : marketValueInput ?? toNumber(existingAsset.marketValue);
        if (isTerminal) {
          // 抵押中的资产不能售出 / 处置：房子、车还压在那笔贷款上，卖掉贷款就悬空了，
          // 而且处置后 mortgageLoanAccountId 会留在资产上，贷款侧 collateralAssetId 仍指着它。
          // 正当路径只有结清贷款（releaseMortgagedAssetsForSettledLoanAccounts 自动解除）。
          if (existingAsset.status === "mortgaged" || existingAsset.mortgageLoanAccountId) {
            throw new MortgagedAssetLockedError();
          }
          // 资产端没有抵押标记也要反查一次贷款侧（2026-11-16 方案 A）：房贷借入时固定资产
          // 是可选关联、老数据可能从未建立关联，只看资产字段会让「贷款没还清就把房 / 车处置掉」
          // 从这道校验里漏过去。
          const unsettledCollaterals = await findUnsettledCollateralLoanAccounts(tx, {
            householdId,
            propertyAssetId: existingAsset.id,
          });
          if (unsettledCollaterals.length > 0) {
            throw new MortgagedAssetLockedError(
              unsettledCollateralMessage(unsettledCollaterals.map((account) => account.name)),
            );
          }
          // 终止时把累计折旧结算下来落到资产上：
          //   直线法部分 = 折旧台账已生成的累计（2026-11-18 起按月自动落账）；
          //   台账还没补到这天（老数据 / 定时任务未跑）时退回按日期推算；
          //   再叠加手工登记的额外折损/减值 + 本次填写的折损/折旧（body.depreciation）。
          // 上限是成本（不能折成负数净值）。
          const depreciationAtTrade = resolveAssetDepreciation(existingAsset, formatDateUtc(tradeDate));
          // 台账补到的是当前月，结算日可能填在过去的月份（补记历史处置）：
          // 只取「结算日已满的整月」那几期，否则会多算后面几个月，净值偏低、损益虚高。
          const cutoffMonth = existingAsset.purchaseDate && depreciationAtTrade.monthsUsed > 0
            ? depreciationPeriodMonth(existingAsset.purchaseDate, depreciationAtTrade.monthsUsed)
            : null;
          const recorded = await recordedDepreciationTotal(existingAsset.id, tx, cutoffMonth);
          const autoPart = recorded > 0 ? recorded : depreciationAtTrade.autoAccumulated;
          const impairment = parseOptionalNonNegativeNumber(body.depreciation) ?? 0;
          settledAccumulated = Math.min(nextCost, autoPart + depreciationAtTrade.manualAccumulated + impairment);
          if (partialLossRatio != null) {
            // 损耗：折损掉的那部分价值进本期损失，剩下 1−折损率 的净值原样重新入库。
            const netBookValueBeforeLoss = Math.max(0, nextCost - settledAccumulated);
            const roundMoney = (value: number) => Math.round(value * 100) / 100;
            const lossAmount = roundMoney(netBookValueBeforeLoss * partialLossRatio);
            lossSettlement = {
              ratio: partialLossRatio,
              lossAmount,
              reentryCost: roundMoney(netBookValueBeforeLoss - lossAmount),
              reentryMarketValue: roundMoney(Math.max(0, toNumber(existingAsset.marketValue) * (1 - partialLossRatio))),
              reentryWeight: existingAsset.weight != null
                ? Math.round(toNumber(existingAsset.weight) * (1 - partialLossRatio) * 1000) / 1000
                : null,
            };
          }
        }
        await tx.propertyAsset.update({
          where: { id: existingAsset.id },
          data: {
            assetType: nextAssetType,
            cost: String(nextCost),
            marketValue: String(nextMarketValue),
            latestValuationDate: marketValueInput != null || isTerminal ? (settlementDate ?? tradeDate) : existingAsset.latestValuationDate,
            status: action === PropertyTransactionAction.sale ? "sold" : isDisposal ? "disposed" : existingAsset.status,
            ...(settledAccumulated != null ? { accumulatedDepreciation: String(settledAccumulated) } : {}),
          },
        });
        if (marketValueInput != null || isTerminal) {
          await tx.propertyValuation.create({
            data: {
              householdId,
              propertyAssetId: existingAsset.id,
              valuationDate: settlementDate ?? tradeDate,
              marketValue: String(nextMarketValue),
              source: action === PropertyTransactionAction.sale ? "sale" : isDisposal ? "disposal" : "manual",
              note: action === PropertyTransactionAction.sale ? "出售回收金额" : isDisposal ? "处置回收金额" : "交易后手动估值",
            },
          });
        }
      }

      await tx.account.update({
        where: { id: accountId },
        data: { fixedAssetType: nextAssetType as any },
      });

      const isTerminalAction = action === PropertyTransactionAction.sale || action === PropertyTransactionAction.disposal;
      // 处置 / 出售损益按「回收净额 − 账面净值」算，净值 = 成本 − 累计折旧。
      // 折旧没登记时 settledAccumulated 为 0，与旧口径（回收 − 成本）完全一致。
      const netBookValueAtTerminal = Math.max(0, toNumber(existingAsset?.cost ?? 0) - (settledAccumulated ?? 0));
      // 损耗只损失折损掉的那部分（剩余部分重新入库，不能把整条净值都记成损失）。
      const realizedProfit = isTerminalAction && existingAsset
        ? lossSettlement
          ? -lossSettlement.lossAmount
          : Math.max(0, amount - (fee ?? 0) - (tax ?? 0)) - netBookValueAtTerminal
        : null;
      const row = await tx.propertyTransaction.create({
        data: {
          householdId,
          accountId,
          cashAccountId: cashAccount?.id ?? null,
          propertyAssetId,
          action,
          source: String(body.source ?? "manual").trim() || "manual",
          tradeDate,
          settlementDate,
          amount: String(amount),
          fee: decimalString(fee),
          tax: decimalString(tax),
          realizedProfit: decimalString(realizedProfit),
          note: String(body.note ?? "").trim() || null,
        },
        include: { Account: true, CashAccount: true, PropertyAsset: true },
      });
      const link = await ensurePropertyTransactionCashFlow(tx, {
        householdId,
        row,
        propertyAccount: row.Account,
        cashAccount: row.CashAccount,
        metadata: { createdBy: "properties-api" },
      });
      /**
       * 损耗后剩余部分重新入库（原资产已在上面按 disposal 终结）：
       * 新资产按「净值 × (1−折损率)」入账，净值连续；重量、产值、残值同比缩减。
       * 同时补一条金额 = 剩余净值的 purchase 交易（不挂资金账户 → 不生成现金流，
       * 成本是从原资产结转过来的），这样 recalcPropertyAssetsFromTransactions
       * 以后重算这条资产时能把成本还原回来（没有交易记录会被当成空资产软删）。
       */
      let reentryAssetId: string | null = null;
      if (lossSettlement && existingAsset) {
        const source = existingAsset;
        const tradeDay = settlementDate ?? tradeDate;
        const reentry = await tx.propertyAsset.create({
          data: {
            householdId,
            accountId,
            name: source.name,
            assetType: nextAssetType,
            propertyType: source.propertyType,
            address: source.address,
            ...(source.attributes == null ? {} : { attributes: source.attributes as Prisma.InputJsonValue }),
            currency: source.currency,
            purchaseDate: tradeDay,
            productionDate: source.productionDate,
            weight: decimalString(lossSettlement.reentryWeight),
            weightUnit: source.weightUnit,
            purchasePrice: decimalString(lossSettlement.reentryCost),
            cost: String(lossSettlement.reentryCost),
            marketValue: String(lossSettlement.reentryMarketValue),
            latestValuationDate: tradeDay,
            depreciationMethod: source.depreciationMethod,
            usefulLifeMonths: source.usefulLifeMonths,
            salvageValue: String(Math.round(toNumber(source.salvageValue) * (1 - lossSettlement.ratio) * 100) / 100),
            accumulatedDepreciation: "0",
            status: "active",
            note: `「${source.name}」损耗 ${Math.round(lossSettlement.ratio * 10000) / 100}% 后剩余部分重新入库（原资产 ${source.id}）`,
          },
        });
        reentryAssetId = reentry.id;
        await tx.propertyValuation.create({
          data: {
            householdId,
            propertyAssetId: reentry.id,
            valuationDate: tradeDay,
            marketValue: String(lossSettlement.reentryMarketValue),
            source: "manual",
            note: "损耗后剩余部分重新入库估值",
          },
        });
        await tx.propertyTransaction.create({
          data: {
            householdId,
            accountId,
            cashAccountId: null,
            propertyAssetId: reentry.id,
            action: PropertyTransactionAction.purchase,
            source: "disposal-loss-reentry",
            tradeDate,
            settlementDate,
            amount: String(lossSettlement.reentryCost),
            note: `损耗后剩余部分重新入库（承接「${source.name}」）`,
          },
        });
      }
      return { id: row.id, link, reentryAssetId };
    });

    for (const id of touchedAccountIds) {
      await recalcAndSaveAccountBalance(id).catch(() => undefined);
    }
    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => undefined);
    revalidateAfterInvestChange();

    const row = await prisma.propertyTransaction.findUnique({
      where: { id: created.id },
      include: {
        Account: true,
        CashAccount: true,
        PropertyAsset: true,
        EntryBusinessLink: { where: { deletedAt: null }, select: { id: true }, take: 1 },
      },
    });

    return NextResponse.json({
      ok: true,
      data: {
        transaction: row ? serializeTransaction(row) : null,
        linkId: created.link.linkId,
        cashEntryId: created.link.cashEntryId,
        /** 损耗处置时新入库的剩余资产 id（报废 / 赠送 / 遗弃为 null）。 */
        reentryAssetId: created.reentryAssetId,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    if (error instanceof MortgagedAssetLockedError) return mortgagedAssetLockedResponse(error.message);
    return NextResponse.json(
      { ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "创建失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}


export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const propertyAssetId = String(body?.propertyAssetId ?? "").trim();
    if (!propertyAssetId) {
      return NextResponse.json({ ok: false, code: "MISSING_PROPERTY_ASSET_ID", error: "Missing propertyAssetId" }, { status: 400, headers: corsHeaders() });
    }
    const asset = await prisma.propertyAsset.findFirst({
      where: { id: propertyAssetId, householdId, deletedAt: null },
    });
    if (!asset) {
      return NextResponse.json({ ok: false, code: "PROPERTY_ASSET_NOT_FOUND", error: "Property asset not found" }, { status: 404, headers: corsHeaders() });
    }
    const name = String(body?.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ ok: false, code: "INVALID_NAME", error: "Asset name is required" }, { status: 400, headers: corsHeaders() });
    }
    const purchaseDate = parseDateOnly(body?.purchaseDate);
    const purchasePrice = parseOptionalNonNegativeNumber(body?.purchasePrice);
    const nextStatus = String(body?.status ?? "").trim() || "active";
    // 抵押中的资产不允许被编辑成终态（否则 `status=sold` 就绕过了
    // 售出 / 处置接口的抵押校验，资产凭空消失而贷款还挂着它）。
    const isTerminalAssetStatus = ["sold", "disposed", "deleted"].includes(nextStatus);
    const assetMortgaged = asset.status === "mortgaged" || Boolean(asset.mortgageLoanAccountId);
    if (assetMortgaged && isTerminalAssetStatus) {
      return mortgagedAssetLockedResponse();
    }
    // 与 POST 同口径的反查（2026-11-16 方案 A）：资产端没标记，也可能抵押在未结清的贷款上，
    // 这里同样不允许直接把状态改成售出 / 处置 / 删除。
    if (isTerminalAssetStatus) {
      const unsettledCollaterals = await findUnsettledCollateralLoanAccounts(prisma, { householdId, propertyAssetId });
      if (unsettledCollaterals.length > 0) {
        return mortgagedAssetLockedResponse(
          unsettledCollateralMessage(unsettledCollaterals.map((account) => account.name)),
        );
      }
    }
    // 手动解除抵押（编辑弹窗取消「抵押中」勾选）：状态回到 active 时把关联一起清掉，
    // 否则 releaseMortgagedAssetsForSettledLoanAccounts 只看 mortgageLoanAccountId，
    // 会让「已经取消勾选」的资产仍被当成抵押中。
    const releaseMortgageLink = assetMortgaged && nextStatus === "active" && Boolean(asset.mortgageLoanAccountId);
    const updated = await prisma.$transaction(async (tx) => {
      // 缺省时沿用资产现有类型：`normalizeFixedAssetType(undefined)` 会得到 "property"，
      // 任何只改名称/状态的局部提交都会把车辆、设备静默改回房产。
      const nextAssetType = normalizeFixedAssetType(body?.assetType ?? asset.assetType);
      // 折旧与扩展属性只在请求里出现过才写：老的局部提交（只改名称/地址）不该把
      // 生产日期、重量、折旧口径清空。
      const extended: Prisma.PropertyAssetUpdateInput = {};
      if (body && "productionDate" in body) extended.productionDate = parseDateOnly(body.productionDate);
      if (body && "weight" in body) {
        const weight = parseOptionalNonNegativeNumber(body.weight);
        extended.weight = weight == null ? null : String(weight);
      }
      if (body && "weightUnit" in body) {
        extended.weightUnit = body.weightUnit == null || String(body.weightUnit).trim() === ""
          ? null
          : normalizeWeightUnit(body.weightUnit);
      }
      if (body && "depreciationMethod" in body) {
        extended.depreciationMethod = normalizeDepreciationMethod(body.depreciationMethod);
      }
      if (body && "usefulLifeMonths" in body) {
        const months = parseOptionalNonNegativeNumber(body.usefulLifeMonths);
        extended.usefulLifeMonths = months == null ? null : Math.round(months);
      }
      if (body && "salvageValue" in body) {
        extended.salvageValue = String(parseNonNegativeNumber(body.salvageValue));
      }
      if (body && "accumulatedDepreciation" in body) {
        extended.accumulatedDepreciation = String(parseNonNegativeNumber(body.accumulatedDepreciation));
      }
      // 有手工折损台账时累计折旧由台账驱动（登记/删除记录时已写回）。手填值若覆盖
      // 它，会出现「编辑弹窗显示一个数、台账合计另一个数」，这里一律以台账为准。
      const manualRecorded = await recordedManualDepreciationTotal(propertyAssetId, tx);
      if (manualRecorded > 0) {
        extended.accumulatedDepreciation = String(manualRecorded);
      }
      const updatedAsset = await tx.propertyAsset.update({
        where: { id: propertyAssetId },
        data: {
          name,
          assetType: nextAssetType,
          propertyType: String(body?.propertyType ?? "").trim() || null,
          address: String(body?.address ?? "").trim() || null,
          attributes: parseAttributes(body?.attributes),
          purchaseDate,
          purchasePrice: purchasePrice == null ? null : String(purchasePrice),
          note: String(body?.note ?? "").trim() || null,
          status: nextStatus,
          ...(releaseMortgageLink ? { MortgageLoanAccount: { disconnect: true } } : {}),
          ...extended,
        },
      });
      await tx.account.updateMany({
        where: { id: updatedAsset.accountId, householdId, kind: AccountKind.investment, investProductType: "property" },
        data: { fixedAssetType: nextAssetType as any },
      });
      return updatedAsset;
    });
    revalidateAfterInvestChange();
    // 折旧设定落到直线法（或改了年限 / 残值 / 购入日）时立刻补记历史期间：
    // 用户点保存后就要看到台账，不等下一轮 10 分钟的系统任务。
    if (updated.status === "active" && updated.depreciationMethod === DepreciationMethod.straightLine) {
      try {
        await syncPropertyAssetDepreciations({ householdId, propertyAssetId });
      } catch {
        // 补记失败不回滚资产设置：系统任务下一轮会再补。
      }
    }
    return NextResponse.json({ ok: true, data: { asset: serializeAsset(updated) } }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "Update failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
