/**
 * API: /api/v1/transactions/detail
 *
 * 交易详情的增删改查接口
 *
 * GET    ?accountId=&page=&pageSize=  查询交易列表（已有）
 * POST   JSON body                    创建交易
 * PUT    JSON body { id, ... }         更新交易
 * DELETE ?id=xxx 或 POST { id }         删除交易（软删除）
 *
 * 贵金属交易:
 * - 接收 metalTypeId、metalUnitId、metalQuantity、metalUnitPrice、metalFee。
 * - 服务端会按当前账簿或系统字典校验品种和单位，并回写 metalTypeName / metalUnitName。
 * - 贵金属不使用 fundCode / fundUnits / fundNav 作为事实字段。
 *
 * 保险投保:
 * - 选择 insuranceProductMasterId 创建新保单时可接收 policyNo，写入保单层 InsuranceProduct.policyNo。
 * - policyNo 属于保单，不属于可复用保险产品主数据。
 *
 * 理财交易:
 * - fundProductType/productType 为 wealth 时，TxRecord 只保存资金流水。
 * - 理财业务字段写入 WealthTransaction，并通过 EntryBusinessLink 关联资金流水。
 * - PUT 可额外接收 businessTransactionId，用于明确更新关联的 WealthTransaction.id。
 * - 资金流水分类保存投资分类树中的动作分类，例如理财买入、理财赎回。
 * - 同一理财账户下同一产品已有份额记录时，继续买入必须提供 fundUnits。
 *
 * 接受的实体类型: id/entryId 为 TxRecord.id；businessTransactionId 为 WealthTransaction.id。
 *
 * 认证方式（混合）：
 * - cookie session（浏览器用户）
 * - X-Api-Key header（Android 客户端，用密码验证）
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType, FundSubtype, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { calculateWealthCashDividendProfit, recalcWealthPositions } from "@/lib/wealth-position";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { getFundConfirmDays, getFundArrivalDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { toNumber, addWorkdaysUtc, toStatementMonth, startOfDayUtc, formatDateLocal } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { isDepositAccount, isInsuranceAccount, isPureInvestmentAccount, isSpecialCashTargetAccount } from "@/lib/account-kind-utils";
import { getOrCreateInsuranceAccount } from "@/lib/insurance/autoAccount";
import { normalizeInsuranceAction } from "@/lib/insurance/transaction";
import { resolveOrCreateDepositAccount } from "@/lib/server/deposit-account";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import { resolveOrCreateAdvanceAccount } from "@/lib/server/advance-account";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { encodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { executeNonFundScheduledTaskPlan } from "@/lib/server/scheduled-task-executor";
import { applyBalanceReconcileEntry } from "@/lib/balance-reconcile";
import { attachEntryTags, replaceEntryTags } from "@/lib/server/entry-tags";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { resolveSameCurrencyTransfer } from "@/lib/currency";
import { resolveAdvanceTransfer } from "@/lib/advance-transfer";
import { isCreditCardRepaymentTransfer, statementMonthForTransfer } from "@/lib/transaction-semantics";
import { ensureSettlementTransferCategory, resolveCategorySnapshot, resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { buildWealthCashFlowNote } from "@/lib/wealth-cash-note";
import { INCOME_EXPENSE_INSTITUTION_TYPES } from "@/lib/institution-rules";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";
import {
  buildEntryBusinessLinkSummary,
  entryBusinessLinkSummaryInclude,
  upsertEntryBusinessCashFlowLink,
  upsertLegacyCombinedEntryBusinessLinks,
  type EntryBusinessType,
} from "@/lib/server/entry-business-link";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";

export const runtime = "nodejs";

function isSettlementDebtAccountForDetail(account?: { kind?: string | null; counterpartyId?: string | null } | null) {
  return account?.kind === AccountKind.loan && !!account.counterpartyId;
}
const DETAIL_LIST_MAX_PAGE_SIZE = 5000;
const TX_EDIT_TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 20_000,
} as const;

/* ────────────────── HELPERS ────────────────── */

function parseMoney(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function positiveNumber(value: unknown) {
  const n = toNumber(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveRecordFundFeeRate(record: {
  fundCode?: string | null;
  fundProductType?: string | null;
  fundSubtype?: FundSubtype | null;
  accountId: string;
  toAccountId?: string | null;
  date: Date;
  fundConfirmDate?: Date | null;
}) {
  const fundCode = String(record.fundCode ?? "").trim();
  if (!fundCode || record.fundProductType === "metal" || record.fundProductType === "wealth") return null;
  const redeemLike = record.fundSubtype === FundSubtype.redeem || record.fundSubtype === FundSubtype.switch_out;
  const fundAccountId = redeemLike ? record.accountId : record.toAccountId;
  if (!fundAccountId) return null;
  const feeType = redeemLike ? "redeem" : "buy";
  const feeDate = record.fundConfirmDate ?? record.date;
  return getFundFeeRateByDate(fundAccountId, fundCode, feeDate, feeType).catch(() => null);
}

async function resolveAccountDisplayBalance(
  account: { id: string; kind: AccountKind; balance: unknown; investProductType?: string | null; billingDay?: number | null },
  hidFilter: { householdId?: string },
) {
  if (isPureInvestmentAccount(account)) {
    const householdId = hidFilter.householdId;
    if (!householdId) return toNumber(account.balance);
    const balances = await computeInvestBalances({ hidFilter: { householdId }, householdId, user: null });
    return balances.get(account.id)?.marketValue ?? toNumber(account.balance);
  }

  if (account.kind === AccountKind.insurance) {
    const balances = await computeInsuranceAccountDisplayBalances([account.id], hidFilter);
    return balances.get(account.id) ?? toNumber(account.balance);
  }

  if (account.kind === AccountKind.bank_credit && account.billingDay) {
    const cycle = await prisma.creditCardCycle.findFirst({
      where: { accountId: account.id, isCurrentCycle: true },
      select: { effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
    });
    return cycle
      ? creditCardDisplayBalanceFromCurrentCycle(cycle)
      : toNumber(account.balance);
  }

  const balances = await computeAccountDisplayBalances([
    {
      id: account.id,
      kind: account.kind,
      investProductType: account.investProductType,
      billingDay: account.billingDay,
    },
  ], hidFilter);
  return balances.get(account.id) ?? toNumber(account.balance);
}

function insurancePremiumTotalCycles(paymentTermYears: unknown, premiumFrequencyMonths: number) {
  const years = positiveNumber(paymentTermYears);
  if (!years || premiumFrequencyMonths <= 0 || premiumFrequencyMonths >= 999999) return null;
  const total = Math.ceil((years * 12) / premiumFrequencyMonths);
  return total > 0 ? total : null;
}

function toDateOrNull(val: unknown): Date | null {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateOnlyLocal(value: Date | null | undefined): string | null {
  return value ? formatDateLocal(value) : null;
}

function dateFromYmd(value: string | null | undefined): Date | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
}

function ymdFromDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

async function upsertFundBuyRefundRecord(
  tx: any,
  params: {
    householdId: string;
    linkedRefundEntryId?: string | null;
    buyEntryId?: string | null;
    buyDate: Date;
    refundDate: Date;
    refundAmount: number;
    fundAccountId: string;
    fundAccountName: string;
    cashAccountId: string;
    cashAccountName: string;
    currency?: string | null;
    fundCode: string | null;
    fundName: string | null;
    fundProductType: string | null;
    fundConfirmDate?: Date | null;
    fundArrivalDate?: Date | null;
    regularInvestPlanId?: string | null;
    note?: string | null;
  },
) {
  const refundAmount = Math.max(0, Math.abs(Number(params.refundAmount) || 0));
  if (refundAmount <= 0 || !params.fundAccountId || !params.cashAccountId || !params.fundCode) return null;

  const directMatch = params.linkedRefundEntryId
    ? await tx.txRecord.findFirst({
        where: {
          id: params.linkedRefundEntryId,
          householdId: params.householdId,
          fundSubtype: FundSubtype.buy_failed,
          source: "regular_invest_refund",
          deletedAt: null,
        },
      })
    : null;
  const refundDateYmd = ymdFromDate(params.refundDate);
  const refundConfirmDateYmd = ymdFromDate(params.fundConfirmDate ?? null);
  const fallbackMatch = directMatch
    ? null
    : params.buyEntryId
      ? await tx.txRecord.findFirst({
          where: {
            householdId: params.householdId,
            deletedAt: null,
            type: TransactionType.investment,
            fundSubtype: FundSubtype.buy_failed,
            source: "regular_invest_refund",
            fundSourceEntryId: params.buyEntryId,
          },
          orderBy: [{ createdAt: "asc" }],
        })
      : null;
  const dateFallbackMatch = directMatch || fallbackMatch
    ? null
    : await tx.txRecord.findFirst({
        where: {
          householdId: params.householdId,
          deletedAt: null,
          type: TransactionType.investment,
          fundSubtype: FundSubtype.buy_failed,
          source: "regular_invest_refund",
          fundCode: params.fundCode,
          accountId: params.fundAccountId,
          toAccountId: params.cashAccountId,
          date: dateFromYmd(refundDateYmd) ?? params.refundDate,
          ...(refundConfirmDateYmd ? { fundConfirmDate: dateFromYmd(refundConfirmDateYmd) } : {}),
        },
        orderBy: [{ createdAt: "asc" }],
      });

  const refundRecordData = {
    date: params.refundDate,
    accountId: params.fundAccountId,
    accountName: params.fundAccountName,
    toAccountId: params.cashAccountId,
    toAccountName: params.cashAccountName,
    amount: refundAmount,
    currency: params.currency ?? "CNY",
    fundCode: params.fundCode,
    fundName: params.fundName,
    fundProductType: params.fundProductType as any,
    fundSubtype: FundSubtype.buy_failed,
    source: "regular_invest_refund",
    fundUnits: null,
    fundNav: null,
    fundFee: null,
    fundConfirmDate: params.fundConfirmDate ?? params.buyDate,
    fundArrivalDate: params.fundArrivalDate ?? params.refundDate,
    fundArrivalAmount: refundAmount,
    fundSourceEntryId: params.buyEntryId ?? null,
    regularInvestPlanId: params.regularInvestPlanId ?? null,
    note: params.note || `买入退回 ${params.fundName || params.fundCode}`,
    deletedAt: null,
  };

  const existing = directMatch ?? fallbackMatch ?? dateFallbackMatch;
  return existing
    ? tx.txRecord.update({ where: { id: existing.id }, data: refundRecordData })
    : tx.txRecord.create({
        data: {
          ...refundRecordData,
          type: TransactionType.investment,
          householdId: params.householdId,
        },
      });
}

function normalizeFundSubtype(value: unknown): FundSubtype {
  const text = String(value ?? "buy").trim();
  return Object.values(FundSubtype).includes(text as FundSubtype) ? (text as FundSubtype) : FundSubtype.buy;
}

function isWealthCashInSubtype(subtype: FundSubtype) {
  return subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out || subtype === FundSubtype.dividend_cash;
}

function parseNonNegativeMoney(value: unknown) {
  const amount = parseMoney(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : 0;
}

async function resolveWealthProductInTx(
  tx: any,
  params: {
    householdId: string;
    institutionId?: string | null;
    currency?: string | null;
    productId?: string | null;
    productName?: string | null;
    annualRate?: number | null;
  },
) {
  const productId = String(params.productId ?? "").trim();
  const productName = String(params.productName ?? "").trim();
  if (productId) {
    return tx.wealthProduct.findFirst({
      where: {
        id: productId,
        householdId: params.householdId,
        institutionId: params.institutionId ?? null,
        isActive: true,
      },
    });
  }
  if (!productName) return null;
  const existing = await tx.wealthProduct.findFirst({
    where: {
      householdId: params.householdId,
      institutionId: params.institutionId ?? null,
      name: productName,
      isActive: true,
    },
  });
  return existing ?? tx.wealthProduct.create({
    data: {
      householdId: params.householdId,
      institutionId: params.institutionId ?? null,
      name: productName,
      currency: params.currency ?? "CNY",
      annualRate: params.annualRate ?? undefined,
    },
  });
}

async function assertWealthUnitsWhenRequiredInTx(
  tx: any,
  params: {
    householdId: string;
    accountId: string;
    wealthProductId?: string | null;
    productName?: string | null;
    units: number | null;
  },
) {
  if (params.units != null && params.units > 0) return;
  const productName = params.productName?.trim();
  const productClauses = [
    params.wealthProductId ? { wealthProductId: params.wealthProductId } : null,
    productName ? { productName } : null,
  ].filter((clause): clause is { wealthProductId: string } | { productName: string } => !!clause);
  if (productClauses.length === 0) return;

  const existingUnitRecord = await tx.wealthTransaction.findFirst({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
      deletedAt: null,
      units: { not: null },
      OR: productClauses,
    },
    select: { id: true },
  });
  if (existingUnitRecord) {
    throw new Error("该理财产品已有份额记录，继续买入时必须填写份额");
  }
}

async function createSplitWealthTransactionFromBody(body: Record<string, unknown>, householdId: string, tagIds: string[]) {
  const date = toDateOrNull(body.date) ?? new Date();
  const subtype = normalizeFundSubtype(body.fundSubtype ?? body.subtype);
  const isCashIn = isWealthCashInSubtype(subtype);
  const isDividend = subtype === FundSubtype.dividend_cash;
  const amountAbs = Math.abs(parseMoney(body.amount));
  if (!amountAbs) throw new Error("金额不正确");

  const requestedWealthAccountId = String(body.accountId ?? body.toAccountId ?? "").trim();
  const cashAccountId = String(body.cashAccountId ?? "").trim();
  const productNameInput = String(body.fundName ?? "").trim();
  const wealthProductIdInput = String(body.wealthProductId ?? "").trim();
  const note = String(body.note ?? body.memo ?? "").trim();
  const units = positiveNumber(body.fundUnits);
  const nav = positiveNumber(body.fundNav);
  const annualRate = positiveNumber(body.depositAnnualRate);
  const feeRaw = parseNonNegativeMoney(body.fundFee);
  const fee = Object.prototype.hasOwnProperty.call(body, "fundFee") ? feeRaw : null;
  const interestRaw = parseMoney(body.depositInterest);
  const interest = Object.prototype.hasOwnProperty.call(body, "depositInterest")
    ? interestRaw
    : isDividend
      ? amountAbs
      : null;
  const arrivalDate = toDateOrNull(body.fundArrivalDate) ?? (isCashIn ? date : null);
  const arrivalAmountRaw = parseNonNegativeMoney(body.fundArrivalAmount);
  const principalAmount = isCashIn && !isDividend && units && nav ? Number((units * nav).toFixed(2)) : amountAbs;
  const grossAmount = isCashIn && !isDividend ? principalAmount : amountAbs;
  const arrivalAmount = isDividend
    ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : amountAbs)
    : isCashIn
      ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : Number(Math.max(0, principalAmount + (interest ?? 0) - Math.max(0, fee ?? 0)).toFixed(2)))
      : null;

  const touchedAccountIds = new Set<string>();
  const result = await prisma.$transaction(async (tx) => {
    const cashAcc = await tx.account.findUnique({
      where: { id: cashAccountId },
      select: { id: true, name: true, currency: true },
    });
    if (!cashAcc) throw new Error(isCashIn ? "请选择到账账户" : "请选择资金来源账户");

    const wealthAcc = isCashIn
      ? await tx.account.findUnique({
          where: { id: requestedWealthAccountId },
          select: { id: true, name: true, institutionId: true, currency: true },
        })
      : await resolveOrCreateWealthAccount(tx, {
          householdId,
          cashAccountId: cashAcc.id,
          requestedAccountId: requestedWealthAccountId || null,
        });
    if (!wealthAcc) throw new Error("请选择理财账户");

    const wealthProduct = await resolveWealthProductInTx(tx, {
      householdId,
      institutionId: wealthAcc.institutionId,
      currency: wealthAcc.currency ?? cashAcc.currency ?? "CNY",
      productId: wealthProductIdInput,
      productName: productNameInput,
      annualRate,
    });
    if (!wealthProduct) throw new Error("请选择或新增理财产品");
    if (!isCashIn && !isDividend) {
      await assertWealthUnitsWhenRequiredInTx(tx, {
        householdId,
        accountId: wealthAcc.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        units,
      });
    }

    const investmentCategoryName = getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: subtype });
    const investmentCategory = investmentCategoryName
      ? await resolveCategorySnapshot(tx, householdId, { categoryName: investmentCategoryName, type: "investment" })
      : null;
    const signedCashAmount = isCashIn ? Math.abs(arrivalAmount ?? amountAbs) : -amountAbs;
    const cashNote = buildWealthCashFlowNote({
      action: subtype,
      productName: wealthProduct.name,
      units,
      userNote: note,
    });
    const cashEntry = await tx.txRecord.create({
      data: {
        householdId,
        date: isCashIn ? (arrivalDate ?? date) : date,
        type: TransactionType.investment,
        accountId: isCashIn ? wealthAcc.id : cashAcc.id,
        accountName: isCashIn ? wealthAcc.name : cashAcc.name,
        toAccountId: isCashIn ? cashAcc.id : wealthAcc.id,
        toAccountName: isCashIn ? cashAcc.name : wealthAcc.name,
        amount: signedCashAmount,
        categoryId: investmentCategory?.id ?? null,
        categoryName: investmentCategory?.name ?? investmentCategoryName ?? null,
        currency: cashAcc.currency ?? wealthAcc.currency ?? "CNY",
        source: "manual",
        note: cashNote,
      },
    });

    const wealthTransaction = await tx.wealthTransaction.create({
      data: {
        householdId,
        accountId: wealthAcc.id,
        cashAccountId: cashAcc.id,
        cashEntryId: cashEntry.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        action: subtype,
        source: "manual",
        tradeDate: date,
        confirmDate: date,
        arrivalDate,
        grossAmount,
        arrivalAmount,
        units,
        nav,
        interest,
        fee,
        annualRate,
        realizedProfit: subtype === FundSubtype.dividend_cash
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : isCashIn
            ? (interest ?? 0) - Math.max(0, fee ?? 0)
            : null,
        note: note || null,
      },
    });

    await attachEntryTags({ tx, entryId: cashEntry.id, householdId, tagIds });
    await upsertEntryBusinessCashFlowLink(tx, {
      householdId,
      cashEntryId: cashEntry.id,
      businessEntryId: null,
      wealthTransactionId: wealthTransaction.id,
      businessType: "wealth",
      cashFlowDirection: signedCashAmount < 0 ? "outflow" : signedCashAmount > 0 ? "inflow" : "none",
      source: "manual",
      note: "Linked cash flow to wealth transaction",
      metadata: { splitRecord: true, independentBusinessTransaction: true },
    });

    touchedAccountIds.add(cashAcc.id);
    touchedAccountIds.add(wealthAcc.id);
    return { cashEntryId: cashEntry.id, wealthTransactionId: wealthTransaction.id };
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(logger.catchLog("理财持仓收益重算失败", "route.ts"));
  }
  for (const id of touchedAccountIds) {
    await recalcAndSaveAccountBalance(id).catch(logger.catchLog("操作失败", "route.ts"));
  }
  await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(logger.catchLog("信用卡账单缓存失效失败", "route.ts"));
  revalidateAfterInvestChange();
  return result;
}

async function editSplitWealthTransactionFromBody(body: Record<string, unknown>, householdId: string, tagIds: string[]) {
  const entryId = String(body.id ?? body.entryId ?? "").trim();
  const businessTransactionId = String(body.businessTransactionId ?? "").trim();
  if (!entryId && !businessTransactionId) throw new Error("缺少 id");
  const date = toDateOrNull(body.date) ?? new Date();
  const subtype = normalizeFundSubtype(body.fundSubtype ?? body.subtype);
  const isCashIn = isWealthCashInSubtype(subtype);
  const isDividend = subtype === FundSubtype.dividend_cash;
  const amountAbs = Math.abs(parseMoney(body.amount));
  if (!amountAbs) throw new Error("金额不正确");

  const requestedWealthAccountId = String(body.toAccountId ?? body.accountId ?? "").trim();
  const cashAccountIdInput = String(body.cashAccountId ?? "").trim();
  const productNameInput = String(body.fundName ?? "").trim();
  const wealthProductIdInput = String(body.wealthProductId ?? "").trim();
  const note = String(body.note ?? body.memo ?? "").trim();
  const units = positiveNumber(body.fundUnits);
  const nav = positiveNumber(body.fundNav);
  const annualRate = positiveNumber(body.depositAnnualRate);
  const feeRaw = parseNonNegativeMoney(body.fundFee);
  const fee = Object.prototype.hasOwnProperty.call(body, "fundFee") ? feeRaw : null;
  const interestRaw = parseMoney(body.depositInterest);
  const interest = Object.prototype.hasOwnProperty.call(body, "depositInterest")
    ? interestRaw
    : isDividend
      ? amountAbs
      : null;
  const arrivalDate = toDateOrNull(body.fundArrivalDate) ?? (isCashIn ? date : null);
  const arrivalAmountRaw = parseNonNegativeMoney(body.fundArrivalAmount);
  const principalAmount = isCashIn && !isDividend && units && nav ? Number((units * nav).toFixed(2)) : amountAbs;
  const grossAmount = isCashIn && !isDividend ? principalAmount : amountAbs;
  const arrivalAmount = isDividend
    ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : amountAbs)
    : isCashIn
      ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : Number(Math.max(0, principalAmount + (interest ?? 0) - Math.max(0, fee ?? 0)).toFixed(2)))
      : null;

  const touchedAccountIds = new Set<string>();
  const result = await prisma.$transaction(async (tx) => {
    const link = await tx.entryBusinessLink.findFirst({
      where: {
        householdId,
        businessType: "wealth",
        deletedAt: null,
        OR: [
          ...(entryId ? [{ cashEntryId: entryId }] : []),
          ...(businessTransactionId ? [{ wealthTransactionId: businessTransactionId }] : []),
          ...(entryId ? [{ wealthTransactionId: entryId }, { businessEntryId: entryId }] : []),
        ],
      },
      orderBy: { updatedAt: "desc" },
    });
    let wealthRow = businessTransactionId
      ? await tx.wealthTransaction.findFirst({ where: { id: businessTransactionId, householdId } })
      : null;
    if (!wealthRow) {
      wealthRow = link?.wealthTransactionId
        ? await tx.wealthTransaction.findUnique({ where: { id: link.wealthTransactionId } })
        : entryId
          ? await tx.wealthTransaction.findFirst({ where: { householdId, OR: [{ id: entryId }, { cashEntryId: entryId }] } })
          : null;
    }

    if (!wealthRow) {
      const legacy = await tx.txRecord.findFirst({
        where: { id: entryId, householdId, deletedAt: null, type: TransactionType.investment, fundProductType: "wealth" },
      });
      if (!legacy) throw new Error("理财记录不存在");
      await syncIndependentBusinessTransactionFromTxRecord(tx, { businessEntryId: legacy.id });
      wealthRow = await tx.wealthTransaction.findFirst({ where: { householdId, OR: [{ id: legacy.id }, { cashEntryId: legacy.id }] } });
    }
    if (!wealthRow) throw new Error("理财记录不存在");

    const oldCashEntry = wealthRow.cashEntryId ? await tx.txRecord.findUnique({ where: { id: wealthRow.cashEntryId } }) : null;
    if (oldCashEntry) {
      touchedAccountIds.add(oldCashEntry.accountId);
      if (oldCashEntry.toAccountId) touchedAccountIds.add(oldCashEntry.toAccountId);
    }
    touchedAccountIds.add(wealthRow.accountId);
    if (wealthRow.cashAccountId) touchedAccountIds.add(wealthRow.cashAccountId);

    const fallbackCashAccountId = cashAccountIdInput || wealthRow.cashAccountId || (isCashIn ? oldCashEntry?.toAccountId : oldCashEntry?.accountId) || "";
    const cashAcc = await tx.account.findUnique({
      where: { id: fallbackCashAccountId },
      select: { id: true, name: true, currency: true },
    });
    if (!cashAcc) throw new Error(isCashIn ? "请选择到账账户" : "请选择资金来源账户");

    const wealthAcc = isCashIn
      ? await tx.account.findUnique({
          where: { id: requestedWealthAccountId || wealthRow.accountId },
          select: { id: true, name: true, institutionId: true, currency: true },
        })
      : await resolveOrCreateWealthAccount(tx, {
          householdId,
          cashAccountId: cashAcc.id,
          requestedAccountId: requestedWealthAccountId || wealthRow.accountId,
        });
    if (!wealthAcc) throw new Error("请选择理财账户");

    const wealthProduct = await resolveWealthProductInTx(tx, {
      householdId,
      institutionId: wealthAcc.institutionId,
      currency: wealthAcc.currency ?? cashAcc.currency ?? "CNY",
      productId: wealthProductIdInput || wealthRow.wealthProductId,
      productName: productNameInput || wealthRow.productName,
      annualRate,
    });
    if (!wealthProduct) throw new Error("请选择或新增理财产品");
    if (!isCashIn && !isDividend) {
      await assertWealthUnitsWhenRequiredInTx(tx, {
        householdId,
        accountId: wealthAcc.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        units,
      });
    }

    const signedCashAmount = isCashIn ? Math.abs(arrivalAmount ?? amountAbs) : -amountAbs;
    const investmentCategoryName = getInvestmentCategoryName({ fundProductType: "wealth", fundSubtype: subtype });
    const investmentCategory = investmentCategoryName
      ? await resolveCategorySnapshot(tx, householdId, { categoryName: investmentCategoryName, type: "investment" })
      : null;
    const cashNote = buildWealthCashFlowNote({
      action: subtype,
      productName: wealthProduct.name,
      units,
      userNote: note,
    });
    const cashEntryData = {
      householdId,
      date: isCashIn ? (arrivalDate ?? date) : date,
      type: TransactionType.investment,
      accountId: isCashIn ? wealthAcc.id : cashAcc.id,
      accountName: isCashIn ? wealthAcc.name : cashAcc.name,
      toAccountId: isCashIn ? cashAcc.id : wealthAcc.id,
      toAccountName: isCashIn ? cashAcc.name : wealthAcc.name,
      amount: signedCashAmount,
      categoryId: investmentCategory?.id ?? null,
      categoryName: investmentCategory?.name ?? investmentCategoryName ?? null,
      currency: cashAcc.currency ?? wealthAcc.currency ?? "CNY",
      source: "manual",
      note: cashNote,
      fundCode: null,
      fundProductType: null,
      fundSubtype: null,
      fundName: null,
      wealthProductId: null,
      fundUnits: null,
      fundNav: null,
      fundFee: null,
      fundConfirmDate: null,
      fundArrivalDate: null,
      fundArrivalAmount: null,
      depositAnnualRate: null,
      depositInterest: null,
      realizedProfit: null,
      deletedAt: null,
    };
    const cashEntry = oldCashEntry
      ? await tx.txRecord.update({ where: { id: oldCashEntry.id }, data: cashEntryData })
      : await tx.txRecord.create({ data: cashEntryData });

    await tx.wealthTransaction.update({
      where: { id: wealthRow.id },
      data: {
        accountId: wealthAcc.id,
        cashAccountId: cashAcc.id,
        cashEntryId: cashEntry.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        action: subtype,
        source: "manual",
        tradeDate: date,
        confirmDate: date,
        arrivalDate,
        grossAmount,
        arrivalAmount,
        units,
        nav,
        interest,
        fee,
        annualRate,
        realizedProfit: subtype === FundSubtype.dividend_cash
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : isCashIn
            ? (interest ?? 0) - Math.max(0, fee ?? 0)
            : null,
        note: note || null,
        deletedAt: null,
      },
    });
    await replaceEntryTags({ tx, entryId: cashEntry.id, householdId, tagIds });
    await tx.entryBusinessLink.updateMany({
      where: {
        householdId,
        businessType: "wealth",
        linkType: "legacy_combined_record",
        OR: [{ cashEntryId: cashEntry.id }, { businessEntryId: cashEntry.id }],
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    await upsertEntryBusinessCashFlowLink(tx, {
      householdId,
      cashEntryId: cashEntry.id,
      businessEntryId: null,
      wealthTransactionId: wealthRow.id,
      businessType: "wealth",
      cashFlowDirection: signedCashAmount < 0 ? "outflow" : signedCashAmount > 0 ? "inflow" : "none",
      source: "manual",
      note: "Linked cash flow to wealth transaction",
      metadata: { splitRecord: true, independentBusinessTransaction: true },
    });

    touchedAccountIds.add(cashAcc.id);
    touchedAccountIds.add(wealthAcc.id);
    return { cashEntryId: cashEntry.id, wealthTransactionId: wealthRow.id };
  }, TX_EDIT_TRANSACTION_OPTIONS);

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(logger.catchLog("理财持仓收益重算失败", "route.ts"));
  }
  for (const id of touchedAccountIds) {
    await recalcAndSaveAccountBalance(id).catch(logger.catchLog("操作失败", "route.ts"));
  }
  await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(logger.catchLog("信用卡账单缓存失效失败", "route.ts"));
  revalidateAfterInvestChange();
  return result;
}

async function loadApiDetailRecord(entryId: string) {
  const entry = await prisma.txRecord.findUnique({
    where: { id: entryId },
    include: {
      ...entryBusinessLinkSummaryInclude,
      EntryTag: { include: { Tag: true } },
      account: { include: { Institution: { select: { name: true } } } },
      toAccount: { include: { Institution: { select: { name: true } } } },
    },
  });
  if (!entry) return null;
  const linkedWealthTransactionId = linkedWealthTransactionIdOf(entry);
  const linkedWealthTransaction = linkedWealthTransactionId && entry.householdId
    ? await prisma.wealthTransaction.findFirst({
        where: { id: linkedWealthTransactionId, householdId: entry.householdId, deletedAt: null },
        include: {
          WealthProduct: true,
          Account: { include: { Institution: { select: { name: true } } } },
          CashAccount: { include: { Institution: { select: { name: true } } } },
        },
      })
    : null;
  return {
    id: entry.id,
    date: formatDateLocal(entry.date),
    postedAt: toDateOnlyLocal(entry.postedAt),
    dayOrder: entry.dayOrder,
    amount: toNumber(entry.amount),
    type: entry.type,
    categoryId: entry.categoryId,
    categoryName: entry.categoryName,
    accountId: entry.accountId,
    accountName: entry.accountName,
    accountKind: entry.account?.kind ?? null,
    accountDebtDirection: entry.account?.debtDirection ?? null,
    accountIsSettlementDebt: isSettlementDebtAccountForDetail(entry.account),
    accountInstitutionName: entry.account?.Institution?.name ?? "",
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? null,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? null,
    toAccountId: entry.toAccountId,
    toAccountName: entry.toAccountName,
    toAccountKind: entry.toAccount?.kind ?? null,
    toAccountDebtDirection: entry.toAccount?.debtDirection ?? null,
    toAccountIsSettlementDebt: isSettlementDebtAccountForDetail(entry.toAccount),
    toAccountInstitutionName: entry.toAccount?.Institution?.name ?? "",
    note: entry.note,
    fundSubtype: entry.fundSubtype,
    fundCode: entry.fundCode,
    fundName: entry.fundName,
    wealthProductId: entry.wealthProductId ?? null,
    insuranceProductId: entry.insuranceProductId ?? null,
    fundProductType: entry.fundProductType,
    metalTypeId: entry.metalTypeId ?? null,
    metalTypeName: entry.metalTypeName ?? null,
    metalUnitId: entry.metalUnitId ?? null,
    metalUnitName: entry.metalUnitName ?? null,
    metalQuantity: entry.metalQuantity ? toNumber(entry.metalQuantity) : null,
    metalUnitPrice: entry.metalUnitPrice ? toNumber(entry.metalUnitPrice) : null,
    metalFee: entry.metalFee ? toNumber(entry.metalFee) : null,
    fundNav: entry.fundNav ? toNumber(entry.fundNav) : null,
    depositAnnualRate: entry.depositAnnualRate ? toNumber(entry.depositAnnualRate) : null,
    depositInterest: entry.depositInterest ? toNumber(entry.depositInterest) : null,
    businessNote: null,
    depositSourceEntryId: entry.depositSourceEntryId ?? null,
    fundUnits: entry.fundUnits ? toNumber(entry.fundUnits) : null,
    fundFee: entry.fundFee ? toNumber(entry.fundFee) : null,
    fundConfirmDate: entry.fundConfirmDate ? formatDateLocal(entry.fundConfirmDate) : null,
    fundArrivalDate: entry.fundArrivalDate ? formatDateLocal(entry.fundArrivalDate) : null,
    fundArrivalAmount: entry.fundArrivalAmount ? toNumber(entry.fundArrivalAmount) : null,
    source: entry.source,
    ...buildEntryBusinessLinkSummary(entry),
    ...(linkedWealthTransaction ? linkedWealthDetailFields(entry, linkedWealthTransaction) : {}),
    entryTags: mapEntryTags(entry),
  };
}

function linkedWealthTransactionIdOf(entry: {
  EntryBusinessLinkCash?: Array<{ wealthTransactionId?: string | null }> | null;
  EntryBusinessLinkBusiness?: Array<{ wealthTransactionId?: string | null }> | null;
}) {
  return [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
    .find((link) => link.wealthTransactionId)?.wealthTransactionId ?? null;
}

function linkedWealthDetailFields(record: any, wealthRow: any) {
  const action = normalizeFundSubtype(wealthRow.action);
  const isCashIn = isWealthCashInSubtype(action);
  const principalAmount = Math.abs(toNumber(wealthRow.grossAmount));
  const arrivalAmount = wealthRow.arrivalAmount == null ? null : Math.abs(toNumber(wealthRow.arrivalAmount));
  const cashAccount = wealthRow.CashAccount;
  const wealthAccount = wealthRow.Account;
  return {
    cashEntryId: wealthRow.cashEntryId ?? record.id,
    businessTransactionId: wealthRow.id,
    amount: isCashIn ? principalAmount : -principalAmount,
    accountId: isCashIn ? wealthRow.accountId : wealthRow.cashAccountId,
    accountName: isCashIn ? wealthAccount?.name ?? record.accountName : cashAccount?.name ?? record.accountName,
    accountKind: isCashIn ? wealthAccount?.kind ?? record.accountKind : cashAccount?.kind ?? record.accountKind,
    accountInstitutionName: isCashIn
      ? wealthAccount?.Institution?.name ?? record.accountInstitutionName ?? ""
      : cashAccount?.Institution?.name ?? record.accountInstitutionName ?? "",
    toAccountId: isCashIn ? wealthRow.cashAccountId : wealthRow.accountId,
    toAccountName: isCashIn ? cashAccount?.name ?? record.toAccountName : wealthAccount?.name ?? record.toAccountName,
    toAccountKind: isCashIn ? cashAccount?.kind ?? record.toAccountKind : wealthAccount?.kind ?? record.toAccountKind,
    toAccountInstitutionName: isCashIn
      ? cashAccount?.Institution?.name ?? record.toAccountInstitutionName ?? ""
      : wealthAccount?.Institution?.name ?? record.toAccountInstitutionName ?? "",
    fundSubtype: action,
    fundCode: null,
    fundName: wealthRow.WealthProduct?.name ?? wealthRow.productName ?? record.fundName,
    wealthProductId: wealthRow.wealthProductId ?? null,
    fundProductType: "wealth",
    fundNav: wealthRow.nav == null ? null : toNumber(wealthRow.nav),
    fundUnits: wealthRow.units == null ? null : toNumber(wealthRow.units),
    fundFee: wealthRow.fee == null ? null : toNumber(wealthRow.fee),
    fundConfirmDate: wealthRow.confirmDate ? formatDateLocal(wealthRow.confirmDate) : null,
    fundArrivalDate: wealthRow.arrivalDate ? formatDateLocal(wealthRow.arrivalDate) : (record.fundArrivalDate ? formatDateLocal(record.fundArrivalDate) : null),
    fundArrivalAmount: arrivalAmount,
    depositAnnualRate: wealthRow.annualRate == null ? wealthRow.WealthProduct?.annualRate ?? null : toNumber(wealthRow.annualRate),
    depositInterest: wealthRow.interest == null ? null : toNumber(wealthRow.interest),
    realizedProfit: wealthRow.realizedProfit == null ? null : toNumber(wealthRow.realizedProfit),
    source: wealthRow.source ?? record.source,
    note: buildWealthCashFlowNote({
      action,
      productName: wealthRow.WealthProduct?.name ?? wealthRow.productName ?? record.fundName,
      units: wealthRow.units == null ? null : toNumber(wealthRow.units),
      userNote: wealthRow.note,
    }),
    businessNote: wealthRow.note ?? null,
  };
}

function entryWithLinkedWealthDisplayDateFields(record: any, wealthRow: any | null) {
  if (!wealthRow) return record;
  const action = normalizeFundSubtype(wealthRow.action);
  if (!isWealthCashInSubtype(action)) return record;
  return {
    ...record,
    fundSubtype: action,
    fundArrivalDate: wealthRow.arrivalDate ?? record.fundArrivalDate,
    toAccountId: wealthRow.cashAccountId ?? record.toAccountId,
  };
}

async function ensureFamilyMemberInstitutionInTx(input: {
  tx: {
    institution: {
      findFirst: typeof prisma.institution.findFirst;
      findMany: typeof prisma.institution.findMany;
      create: typeof prisma.institution.create;
    };
  };
  householdId: string;
  personId: string | null;
  personName: string | null;
}) {
  if (input.personId) {
    const existing = await input.tx.institution.findFirst({
      where: {
        id: input.personId,
        householdId: input.householdId,
        type: "family_member",
      },
    });
    if (existing) return existing;
  }
  const normalizedName = String(input.personName ?? "").trim();
  if (!normalizedName) return null;
  const matched = await input.tx.institution.findFirst({
    where: {
      householdId: input.householdId,
      type: "family_member",
      OR: [{ name: normalizedName }, { shortName: normalizedName }],
    },
  });
  if (matched) return matched;
  await assertInstitutionDisplayNamesUnique(input.tx, {
    householdId: input.householdId,
    name: normalizedName,
  });
  return input.tx.institution.create({
    data: {
      householdId: input.householdId,
      type: "family_member",
      name: normalizedName,
      shortName: null,
    },
  });
}

async function resolveOwnerGroupFromPersonInTx(input: {
  tx: {
    accountGroup: {
      findFirst: typeof prisma.accountGroup.findFirst;
      create: typeof prisma.accountGroup.create;
    };
  };
  householdId: string;
  ownerGroupId: string | null;
  policyholderPerson: { name: string } | null;
}) {
  if (input.ownerGroupId) return input.ownerGroupId;
  const name = input.policyholderPerson?.name.trim();
  if (!name) return null;
  const existing = await input.tx.accountGroup.findFirst({
    where: { householdId: input.householdId, name },
  });
  if (existing) return existing.id;
  const lastGroup = await input.tx.accountGroup.findFirst({
    where: { householdId: input.householdId },
    orderBy: { sortOrder: "desc" },
  });
  const created = await input.tx.accountGroup.create({
    data: {
      householdId: input.householdId,
      name,
      sortOrder: (lastGroup?.sortOrder ?? 0) + 1,
    },
  });
  return created.id;
}

function mapEntryTags(entry: { EntryTag: Array<{ tagId: string; Tag: { name: string; color: string | null } | null }> }) {
  return entry.EntryTag.map((et) => ({
    tagId: et.tagId,
    Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
  }));
}

function mapFundLinkCandidate(entry: {
  id: string;
  date: Date;
  createdAt: Date;
  fundConfirmDate: Date | null;
  fundArrivalDate: Date | null;
  fundCode: string | null;
  fundSubtype: FundSubtype | null;
  fundUnits: unknown;
  source: string | null;
  accountId: string;
  toAccountId: string | null;
  amount: unknown;
  fundSourceEntryId: string | null;
}) {
  return {
    id: entry.id,
    date: formatDateLocal(entry.date),
    createdAt: entry.createdAt.toISOString(),
    fundConfirmDate: entry.fundConfirmDate ? formatDateLocal(entry.fundConfirmDate) : null,
    fundArrivalDate: entry.fundArrivalDate ? formatDateLocal(entry.fundArrivalDate) : null,
    fundCode: entry.fundCode ?? "",
    fundSubtype: entry.fundSubtype ?? "",
    fundUnits: entry.fundUnits ? toNumber(entry.fundUnits) : null,
    source: entry.source ?? null,
    accountId: entry.accountId,
    toAccountId: entry.toAccountId,
    amount: toNumber(entry.amount),
    fundSourceEntryId: entry.fundSourceEntryId ?? null,
  };
}

async function getFundLinkCandidateEntries(record: {
  id: string;
  type: TransactionType;
  fundCode: string | null;
  fundSubtype: FundSubtype | null;
  source: string | null;
  accountId: string;
  toAccountId: string | null;
}, householdId: string) {
  if (record.type !== TransactionType.investment || !record.fundCode) return [];
  const isBuy = record.fundSubtype === FundSubtype.buy;
  const isRefund = record.fundSubtype === FundSubtype.buy_failed && record.source === "regular_invest_refund";
  if (!isBuy && !isRefund) return [];

  const fundAccountId = isBuy ? record.toAccountId : record.accountId;
  const cashAccountId = isBuy ? record.accountId : record.toAccountId;
  if (!fundAccountId || !cashAccountId) return [];

  const entries = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      type: TransactionType.investment,
      fundCode: record.fundCode,
      OR: [
        {
          fundSubtype: FundSubtype.buy,
          accountId: cashAccountId,
          toAccountId: fundAccountId,
        },
        {
          fundSubtype: FundSubtype.buy_failed,
          source: "regular_invest_refund",
          accountId: fundAccountId,
          toAccountId: cashAccountId,
        },
      ],
    },
    select: {
      id: true,
      date: true,
      createdAt: true,
      fundConfirmDate: true,
      fundArrivalDate: true,
      fundCode: true,
      fundSubtype: true,
      fundUnits: true,
      source: true,
      accountId: true,
      toAccountId: true,
      amount: true,
      fundSourceEntryId: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  return entries.map(mapFundLinkCandidate);
}

/* ────────────────── GET ────────────────── */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = (url.searchParams.get("accountId") ?? "").trim();
  const entryId = (url.searchParams.get("id") ?? "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20), DETAIL_LIST_MAX_PAGE_SIZE);

  try {
    const { hidFilter } = await getHouseholdScope();

    // Single record lookup by ID
    if (entryId) {
      const record = await prisma.txRecord.findUnique({
        where: { id: entryId },
        include: {
          ...entryBusinessLinkSummaryInclude,
          EntryTag: { include: { Tag: true } },
          account: { include: { Institution: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true } } } },
          CreditCardInstallmentPlan: { select: { sourceType: true, sourceStatementMonth: true } },
        },
      });
      if (!record || record.deletedAt || record.householdId !== hidFilter.householdId) {
        return NextResponse.json({ ok: false, error: "记录不存在" }, { status: 404 });
      }
      const linkedWealthTransactionId = linkedWealthTransactionIdOf(record);
      const linkedWealthTransaction = linkedWealthTransactionId
        ? await prisma.wealthTransaction.findFirst({
            where: { id: linkedWealthTransactionId, householdId: hidFilter.householdId, deletedAt: null },
            include: {
              WealthProduct: true,
              Account: { include: { Institution: { select: { name: true } } } },
              CashAccount: { include: { Institution: { select: { name: true } } } },
            },
          })
        : null;
      const fundFeeRate = await resolveRecordFundFeeRate(record);
      const entry = {
        id: record.id,
        date: formatDateLocal(record.date),
        postedAt: toDateOnlyLocal(record.postedAt),
        dayOrder: record.dayOrder,
        amount: toNumber(record.amount),
        type: record.type,
        categoryId: record.categoryId,
        categoryName: record.categoryName,
        accountId: record.accountId,
        accountName: record.accountName,
        accountKind: record.account?.kind ?? null,
        accountDebtDirection: record.account?.debtDirection ?? null,
        accountIsSettlementDebt: isSettlementDebtAccountForDetail(record.account),
        accountInstitutionName: record.account?.Institution?.name ?? "",
        counterpartyInstitutionId: record.counterpartyInstitutionId ?? null,
        counterpartyInstitutionName: record.counterpartyInstitutionName ?? null,
        toAccountId: record.toAccountId,
        toAccountName: record.toAccountName,
        toAccountKind: record.toAccount?.kind ?? null,
        toAccountDebtDirection: record.toAccount?.debtDirection ?? null,
        toAccountIsSettlementDebt: isSettlementDebtAccountForDetail(record.toAccount),
        toAccountInstitutionName: record.toAccount?.Institution?.name ?? "",
        note: record.note,
        toNote: record.toNote,
        fundSubtype: record.fundSubtype,
        fundCode: record.fundCode,
        fundName: record.fundName,
        wealthProductId: record.wealthProductId ?? null,
        insuranceProductId: record.insuranceProductId ?? null,
        insuranceAction: record.insuranceAction ?? null,
        insuranceProductName: record.insuranceProductName ?? record.fundName ?? null,
        debtPrincipalAmount: record.debtPrincipalAmount ? toNumber(record.debtPrincipalAmount) : null,
        debtInterestAmount: record.debtInterestAmount ? toNumber(record.debtInterestAmount) : null,
        debtFeeAmount: record.debtFeeAmount ? toNumber(record.debtFeeAmount) : null,
        fundProductType: record.fundProductType,
        metalTypeId: record.metalTypeId ?? null,
        metalTypeName: record.metalTypeName ?? null,
        metalUnitId: record.metalUnitId ?? null,
        metalUnitName: record.metalUnitName ?? null,
        metalQuantity: record.metalQuantity ? toNumber(record.metalQuantity) : null,
        metalUnitPrice: record.metalUnitPrice ? toNumber(record.metalUnitPrice) : null,
        metalFee: record.metalFee ? toNumber(record.metalFee) : null,
        fundNav: record.fundNav ? toNumber(record.fundNav) : null,
        depositAnnualRate: record.depositAnnualRate ? toNumber(record.depositAnnualRate) : null,
        depositInterest: record.depositInterest ? toNumber(record.depositInterest) : null,
        depositSourceEntryId: record.depositSourceEntryId ?? null,
        fundSourceEntryId: record.fundSourceEntryId ?? null,
        fundUnits: record.fundUnits ? toNumber(record.fundUnits) : null,
        fundFee: record.fundFee ? toNumber(record.fundFee) : null,
        feeRate: fundFeeRate,
        fundConfirmDate: record.fundConfirmDate ? formatDateLocal(record.fundConfirmDate) : null,
        fundArrivalDate: record.fundArrivalDate ? formatDateLocal(record.fundArrivalDate) : null,
        fundArrivalAmount: record.fundArrivalAmount ? toNumber(record.fundArrivalAmount) : null,
        creditCardInstallmentPlanId: record.creditCardInstallmentPlanId,
        installmentNo: record.installmentNo,
        installmentTotal: record.installmentTotal,
        installmentPrincipal: record.installmentPrincipal ? toNumber(record.installmentPrincipal) : null,
        installmentInterest: record.installmentInterest ? toNumber(record.installmentInterest) : null,
        installmentRole: record.installmentRole,
        installmentSourceType: record.CreditCardInstallmentPlan?.sourceType ?? null,
        installmentSourceStatementMonth: record.CreditCardInstallmentPlan?.sourceStatementMonth ?? null,
        source: record.source,
        ...buildEntryBusinessLinkSummary(record),
        ...(linkedWealthTransaction ? linkedWealthDetailFields(record, linkedWealthTransaction) : {}),
        entryTags: mapEntryTags(record),
        linkedCandidateEntries: await getFundLinkCandidateEntries(record, hidFilter.householdId),
      };
      return NextResponse.json({ ok: true, data: entry });
    }

    if (!accountId) {
      return NextResponse.json({ ok: false, error: "缺少 accountId" }, { status: 400 });
    }

    const [account, totalCount, allEntries] = await Promise.all([
      prisma.account.findUnique({ where: { id: accountId } }),
      prisma.txRecord.count({
        where: {
          OR: [{ accountId }, { toAccountId: accountId }],
          deletedAt: null,
          ...hidFilter,
        },
      }),
      prisma.txRecord.findMany({
        where: {
          OR: [{ accountId }, { toAccountId: accountId }],
          deletedAt: null,
          ...hidFilter,
        },
        include: {
          ...entryBusinessLinkSummaryInclude,
          EntryTag: { include: { Tag: true } },
          account: { include: { Institution: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true } } } },
          CreditCardInstallmentPlan: { select: { sourceType: true, sourceStatementMonth: true } },
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      }),
    ]);

    if (!account) {
      return NextResponse.json({ ok: false, error: "账户不存在" }, { status: 404 });
    }

    const allLinkedWealthIds = Array.from(new Set(allEntries
      .map((entry) => linkedWealthTransactionIdOf(entry))
      .filter((id): id is string => !!id)));
    const allLinkedWealthRows = allLinkedWealthIds.length > 0
      ? await prisma.wealthTransaction.findMany({
          where: { id: { in: allLinkedWealthIds }, householdId: hidFilter.householdId, deletedAt: null },
          include: {
            WealthProduct: true,
            Account: { include: { Institution: { select: { name: true } } } },
            CashAccount: { include: { Institution: { select: { name: true } } } },
          },
        })
      : [];
    const linkedWealthById = new Map(allLinkedWealthRows.map((row) => [row.id, row]));
    const displayDateEntryOf = (entry: typeof allEntries[number]) => {
      const linkedWealthId = linkedWealthTransactionIdOf(entry);
      return entryWithLinkedWealthDisplayDateFields(entry, linkedWealthId ? linkedWealthById.get(linkedWealthId) ?? null : null);
    };

    const accountDisplayBalance = await resolveAccountDisplayBalance(account, hidFilter);
    const orderedEntries = [...allEntries].sort((a, b) => compareDetailEntriesDesc(displayDateEntryOf(a), displayDateEntryOf(b), accountId));
    const ascEntries = [...orderedEntries].sort((a, b) => compareDetailEntriesAsc(displayDateEntryOf(a), displayDateEntryOf(b), accountId));
    const runningBalanceById = new Map<string, number>();
    let runningBalance = 0;
    for (const entry of ascEntries) {
      runningBalance = applyBalanceReconcileEntry(runningBalance, entry, accountId);
      runningBalanceById.set(entry.id, runningBalance);
    }

    const pagedEntries = orderedEntries.slice((page - 1) * pageSize, page * pageSize);
    const entries = pagedEntries.map((e) => {
      const linkedWealthId = linkedWealthTransactionIdOf(e);
      const linkedWealth = linkedWealthId ? linkedWealthById.get(linkedWealthId) ?? null : null;
      const displayDateEntry = entryWithLinkedWealthDisplayDateFields(e, linkedWealth);
      return ({
      id: e.id,
      date: formatDateLocal(getDetailEntryDisplayDate(displayDateEntry, accountId)),
      postedAt: toDateOnlyLocal(e.postedAt),
      createdAt: e.createdAt?.toISOString?.() ?? null,
      dayOrder: e.dayOrder,
      amount: toNumber(e.amount),
      runningBalance: runningBalanceById.get(e.id) ?? null,
      type: e.type,
      categoryId: e.categoryId,
      categoryName: e.categoryName,
      accountId: e.accountId,
      accountName: e.accountName,
      accountKind: e.account?.kind ?? null,
      accountDebtDirection: e.account?.debtDirection ?? null,
      accountIsSettlementDebt: isSettlementDebtAccountForDetail(e.account),
      accountInstitutionName: e.account?.Institution?.name ?? "",
      counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
      counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
      toAccountId: e.toAccountId,
      toAccountName: e.toAccountName,
      toAccountKind: e.toAccount?.kind ?? null,
      toAccountDebtDirection: e.toAccount?.debtDirection ?? null,
      toAccountIsSettlementDebt: isSettlementDebtAccountForDetail(e.toAccount),
      toAccountInstitutionName: e.toAccount?.Institution?.name ?? "",
      note: e.note,
      toNote: e.toNote,
      fundSubtype: e.fundSubtype,
      fundCode: e.fundCode,
      fundName: e.fundName,
      wealthProductId: e.wealthProductId ?? null,
      insuranceProductId: e.insuranceProductId ?? null,
      insuranceAction: e.insuranceAction ?? null,
      insuranceProductName: e.insuranceProductName ?? e.fundName ?? null,
      debtPrincipalAmount: e.debtPrincipalAmount ? toNumber(e.debtPrincipalAmount) : null,
      debtInterestAmount: e.debtInterestAmount ? toNumber(e.debtInterestAmount) : null,
      debtFeeAmount: e.debtFeeAmount ? toNumber(e.debtFeeAmount) : null,
      fundProductType: e.fundProductType,
      metalTypeId: e.metalTypeId ?? null,
      metalTypeName: e.metalTypeName ?? null,
      metalUnitId: e.metalUnitId ?? null,
      metalUnitName: e.metalUnitName ?? null,
      metalQuantity: e.metalQuantity ? toNumber(e.metalQuantity) : null,
      metalUnitPrice: e.metalUnitPrice ? toNumber(e.metalUnitPrice) : null,
      metalFee: e.metalFee ? toNumber(e.metalFee) : null,
      fundNav: e.fundNav ? toNumber(e.fundNav) : null,
      depositAnnualRate: e.depositAnnualRate ? toNumber(e.depositAnnualRate) : null,
      depositInterest: e.depositInterest ? toNumber(e.depositInterest) : null,
      depositSourceEntryId: e.depositSourceEntryId ?? null,
      fundSourceEntryId: e.fundSourceEntryId ?? null,
      fundUnits: e.fundUnits ? toNumber(e.fundUnits) : null,
      fundFee: e.fundFee ? toNumber(e.fundFee) : null,
      fundConfirmDate: e.fundConfirmDate ? formatDateLocal(e.fundConfirmDate) : null,
      fundArrivalDate: e.fundArrivalDate ? formatDateLocal(e.fundArrivalDate) : null,
      fundArrivalAmount: e.fundArrivalAmount ? toNumber(e.fundArrivalAmount) : null,
      creditCardInstallmentPlanId: e.creditCardInstallmentPlanId,
      installmentNo: e.installmentNo,
      installmentTotal: e.installmentTotal,
      installmentPrincipal: e.installmentPrincipal ? toNumber(e.installmentPrincipal) : null,
      installmentInterest: e.installmentInterest ? toNumber(e.installmentInterest) : null,
      installmentRole: e.installmentRole,
      installmentSourceType: e.CreditCardInstallmentPlan?.sourceType ?? null,
      installmentSourceStatementMonth: e.CreditCardInstallmentPlan?.sourceStatementMonth ?? null,
      source: e.source,
      ...buildEntryBusinessLinkSummary(e),
      ...(linkedWealth ? linkedWealthDetailFields(e, linkedWealth) : {}),
      entryTags: mapEntryTags(e),
    });
    });

    return NextResponse.json({
      ok: true,
      data: {
        accountId: account.id,
        accountBalance: accountDisplayBalance,
        totalCount,
        page,
        pageSize,
        entries,
      },
    });
  } catch (err) {
    console.error("GET /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: "服务器错误" }, { status: 500 });
  }
}

/* ────────────────── POST (CREATE) ────────────────── */

/**
 * POST /api/v1/transactions/detail
 * 创建交易记录
 *
 * Body (JSON):
 *   type: "expense" | "income" | "advance" | "transfer" | "investment"
 *   date: string (YYYY-MM-DD)
 *   postedAt?: string (YYYY-MM-DD; expense/income only, defaults to date)
 *   amount: number (advance: positive means paid on behalf of counterparty; negative means counterparty returned money)
 *   accountId: string
 *   categoryId?: string
 *   categoryName?: string
 *   toAccountId?: string (transfer; ordinary cash/credit targets only. Fund, deposit, and debt targets must use their specialized transaction payloads.)
 *   toAccountName?: string
 *   note?: string
 *   tagIds?: string[]
 *   --- investment fields ---
 *   fundCode?: string
 *   fundName?: string
 *   wealthProductId?: string
 *   fundProductType?: "fund" | "money" | "wealth" | "deposit" | "metal"
 *   fundSubtype?: "buy" | "redeem" | "dividend_reinvest" | "dividend_cash" | "regular_invest" | "switch_in" | "switch_out" | "buy_failed"
 *   fundNav?: number
 *   fundUnits?: number
 *   fundFee?: number
 *   fundConfirmDate?: string (YYYY-MM-DD)
 *   fundArrivalDate?: string (YYYY-MM-DD)
 *   fundArrivalAmount?: number
 *   cashAccountId?: string
 *   counterpartyInstitutionId?: string (expense/income uses bank/payment institution id; advance uses Counterparty.id or legacy Institution.id)
 *   source?: string (default "manual")
 *
 * 返回: { ok: true, data: { id, ... } } | { ok: false, error }
 */
export async function POST(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
    }

    const type = String(body.type ?? "").trim();
    const dateStr = String(body.date ?? "").trim();
    const amountRaw = parseMoney(body.amount);
    const amountAbs = Math.abs(amountRaw);
    const note = String(body.note ?? "").trim();
    const toNote = String(body.toNote ?? "").trim();
    const counterpartyInstitutionId = String(body.counterpartyInstitutionId ?? "").trim();
    const tagIdsRaw = body.tagIds;
    const tagIds: string[] = Array.isArray(tagIdsRaw)
      ? tagIdsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
    const postedAt = type === "expense" || type === "income" ? (toDateOrNull(body.postedAt) ?? date) : null;
    const { householdId } = ctx;

    if (!amountAbs) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    let createdId: string | undefined;
    let createdCashEntryId: string | undefined;
    let createdPlanId: string | undefined;
    let changedInvestment = false;

    if (type === "advance") {
      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();
      if (!accountId || !counterpartyInstitutionId) {
        return NextResponse.json({ ok: false, error: !accountId ? "请选择资金账户" : "请选择往来对象" }, { status: 400 });
      }
      let advanceAccountId = "";
      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId } }),
          resolveCategorySnapshot(tx, householdId, { categoryId, type: "advance" }),
        ]);
        if (!acc) throw new Error("账户不存在");
        if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与代付记账");
        const resolvedAdvance = await resolveOrCreateAdvanceAccount(tx, {
          householdId,
          cashAccountId: acc.id,
          debtObjectId: counterpartyInstitutionId,
        });
        advanceAccountId = resolvedAdvance.account.id;
        const transfer = resolveAdvanceTransfer({ amount: amountRaw, cashAccount: acc, advanceAccount: resolvedAdvance.account });
        const statementMonth = statementMonthForTransfer(date, transfer.fromAccount, transfer.toAccount);
        const created = await tx.txRecord.create({
          data: {
            householdId,
            accountId: transfer.fromAccount.id,
            accountName: transfer.fromAccount.name,
            toAccountId: transfer.toAccount.id,
            toAccountName: transfer.toAccount.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            counterpartyInstitutionId: resolvedAdvance.objectId,
            counterpartyInstitutionName: resolvedAdvance.objectName,
            amount: transfer.transferAmount,
            type: TransactionType.transfer,
            date,
            statementMonth,
            source: "advance",
            note: note || transfer.defaultNote,
          },
        });
        createdId = created.id;
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });
      await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
      if (advanceAccountId) await recalcAndSaveAccountBalance(advanceAccountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "transfer") {
      const fromAccountId = String(body.fromAccountId ?? body.accountId ?? "").trim();
      const toAccountId = String(body.toAccountId ?? "").trim();
      if (!fromAccountId || !toAccountId) {
        return NextResponse.json({ ok: false, error: "转账需要选择转出/转入账户" }, { status: 400 });
      }
      if (fromAccountId === toAccountId) {
        return NextResponse.json({ ok: false, error: "转出/转入账户不能相同" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId }, include: { Institution: true } }),
          tx.account.findUnique({ where: { id: toAccountId }, include: { Institution: true } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error("账户不存在");
        const isDebtTransfer = fromAcc.kind === AccountKind.loan || toAcc.kind === AccountKind.loan;
        if (fromAcc.kind === AccountKind.loan && toAcc.kind === AccountKind.loan) {
          throw new Error("往来款账户之间不能保存为普通转账");
        }
        if (!isDebtTransfer && (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc))) {
          throw new Error("基金、存款和往来款账户不能保存为普通转账，请使用对应的专用记账窗口");
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);
        const debtMode = isDebtTransfer
          ? fromAcc.kind === AccountKind.loan
            ? fromAcc.debtDirection === "receivable" ? "collect_in" : "borrow_in"
            : toAcc.debtDirection === "receivable" ? "lend_out" : "repay_out"
          : null;
        const signedTransferAmount = debtMode === "collect_in" ? amountAbs : -amountAbs;

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);
        const transferCategory = debtMode
          ? await ensureSettlementTransferCategory(tx, householdId)
          : isCreditCardRepaymentTransfer({
              type: TransactionType.transfer,
              accountKind: fromAcc.kind,
              toAccountKind: toAcc.kind,
            })
            ? await resolveCreditCardRepaymentCategory(tx, householdId)
            : null;

        const created = await tx.txRecord.create({
          data: {
            accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: signedTransferAmount,
            type: TransactionType.transfer,
            date,
            categoryId: transferCategory?.id ?? null,
            categoryName: transferCategory?.name ?? null,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            statementMonth: transferStatementMonth,
            source: debtMode ? `debt_${debtMode}` : "manual",
            debtPrincipalAmount: debtMode ? amountAbs : null,
            debtInterestAmount: debtMode ? 0 : null,
            debtFeeAmount: debtMode ? 0 : null,
            householdId,
          },
        });
        createdId = created.id;

        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      await recalcAndSaveAccountBalance(fromAccountId).catch(logger.catchLog("操作失败", "route.ts"));
      await recalcAndSaveAccountBalance(toAccountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "expense") {
      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();
      const counterpartyInstitution = counterpartyInstitutionId
        ? await prisma.institution.findFirst({
            where: { id: counterpartyInstitutionId, householdId, type: { in: [...INCOME_EXPENSE_INSTITUTION_TYPES] } },
          })
        : null;
      if (counterpartyInstitutionId && !counterpartyInstitution) {
        return NextResponse.json({ ok: false, error: "收支机构只能选择银行或第三方支付机构" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          resolveCategorySnapshot(tx, householdId, { categoryId, type: "expense" }),
        ]);
        if (!acc) throw new Error("账户不存在");
        if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与收支记账");

        const statementMonth =
          (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;

        const created = await tx.txRecord.create({
          data: {
            accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
            counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
            amount: amountRaw,
            type: TransactionType.expense,
            date,
            postedAt,
            note: note || null,
            statementMonth,
            householdId,
          },
        });
        createdId = created.id;

        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "income") {
      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();
      const counterpartyInstitution = counterpartyInstitutionId
        ? await prisma.institution.findFirst({
            where: { id: counterpartyInstitutionId, householdId, type: { in: [...INCOME_EXPENSE_INSTITUTION_TYPES] } },
          })
        : null;
      if (counterpartyInstitutionId && !counterpartyInstitution) {
        return NextResponse.json({ ok: false, error: "收支机构只能选择银行或第三方支付机构" }, { status: 400 });
      }

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          accountId ? tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }) : Promise.resolve(null),
          resolveCategorySnapshot(tx, householdId, { categoryId, type: "income" }),
        ]);

        const statementMonth =
          acc && (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;

        const created = await tx.txRecord.create({
          data: {
            accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? "未知账户",
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
            counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
            amount: amountRaw,
            type: TransactionType.income,
            date,
            note: note || undefined,
            statementMonth: statementMonth ?? undefined,
            householdId,
          } as any,
        });
        createdId = created.id;

        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      if (accountId) await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("操作失败", "route.ts"));
    } else if (type === "investment") {
      changedInvestment = true;
      const accountId = String(body.accountId ?? "").trim();
      const subtype = String(body.fundSubtype ?? "buy").trim();
      let fundCode = String(body.fundCode ?? "").trim() || null;
      const fundProductType = String(body.fundProductType ?? body.productType ?? "").trim() || null;
      const metalTypeIdInput = String(body.metalTypeId ?? "").trim();
      const metalUnitIdInput = String(body.metalUnitId ?? "").trim();
      const metalQuantityRaw = parseMoney(body.metalQuantity ?? body.fundUnits);
      const metalUnitPriceRaw = parseMoney(body.metalUnitPrice ?? body.fundNav);
      const metalFeeRaw = parseMoney(body.metalFee ?? body.fundFee);
      const fundUnitsRaw = parseMoney(body.fundUnits);
      const fundNavRaw = parseMoney(body.fundNav);
      const depositAnnualRateRaw = parseMoney(body.depositAnnualRate);
      const depositInterestRaw = parseMoney(body.depositInterest);
      const fundFeeRaw = parseMoney(body.fundFee);
      const fundConfirmDateStr = String(body.fundConfirmDate ?? "").trim();
      const fundArrivalDateStr = String(body.fundArrivalDate ?? "").trim();
      const fundArrivalAmountRaw = parseMoney(body.fundArrivalAmount);
      const buyResultStatus = String(body.buyResultStatus ?? "normal").trim();
      const refundAmountRaw = parseMoney(body.refundAmount);
      const refundDateStr = String(body.refundDate ?? "").trim();
      const depositSourceEntryId = String(body.depositSourceEntryId ?? "").trim() || null;
      const cashAccountIdInput = String(body.cashAccountId ?? "").trim() || null;
      const fundConfirmDate = fundConfirmDateStr ? new Date(fundConfirmDateStr) : null;
      const fundArrivalDate = fundArrivalDateStr ? new Date(fundArrivalDateStr) : null;
      const fundArrivalAmount = fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null;
      const refundAmount = refundAmountRaw > 0 ? Math.abs(refundAmountRaw) : null;
      const refundDate = refundDateStr ? dateFromYmd(refundDateStr) : null;
      const fundUnits = fundUnitsRaw > 0 ? fundUnitsRaw : null;
      const fundNav = fundNavRaw > 0 ? fundNavRaw : null;
      const fundFee = fundFeeRaw > 0 ? fundFeeRaw : null;
      const metalQuantity = metalQuantityRaw > 0 ? metalQuantityRaw : fundUnits;
      const metalUnitPrice = metalUnitPriceRaw > 0 ? metalUnitPriceRaw : fundNav;
      const metalFee = metalFeeRaw > 0 ? metalFeeRaw : null;
      const depositAnnualRate = depositAnnualRateRaw > 0 ? depositAnnualRateRaw : null;
      const depositInterest = depositInterestRaw >= 0 ? depositInterestRaw : null;

      if (!fundCode && note) {
        const codeMatch = note.match(/\b(\d{6})\b/);
        if (codeMatch) fundCode = codeMatch[1];
      }

      const fundNameInput = String(body.fundName ?? "").trim();
      const wealthProductIdInput = String(body.wealthProductId ?? "").trim();
      if (fundProductType === "wealth") {
        const created = await createSplitWealthTransactionFromBody(body, householdId, tagIds);
        const data = await loadApiDetailRecord(created.cashEntryId);
        return NextResponse.json({ ok: true, data: data ?? { id: created.cashEntryId } });
      }
      let insuranceProductId = String(body.insuranceProductId ?? "").trim() || null;
      const insuranceProductMasterId = String(body.insuranceProductMasterId ?? "").trim() || null;
      const ownerGroupId = String(body.ownerGroupId ?? "").trim() || null;
      const createInsurancePremiumPlan =
        body.createInsurancePremiumPlan !== false &&
        body.createPremiumPlan !== false &&
        body.skipPlanCreation !== true;
      const backfillInsurancePremiumRecords =
        body.insurancePremiumBackfillPastRecords === true ||
        body.backfillPastInsurancePremiumRecords === true;
      const skipDuplicateInsurancePremiumDate = body.skipDuplicateInsurancePremiumDate === true;

      const redeemLike = subtype === "redeem" || subtype === "switch_out";
      const validSubtypes = Object.values(FundSubtype);
      const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype)
        ? (subtype as FundSubtype)
        : FundSubtype.buy;

      const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
      const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;

      const sourceValue =
        fundProductType === "deposit"
          ? "deposit"
          : isDividendReinvest
            ? "dividend"
            : (String(body.source ?? "manual").trim() || "manual");
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;
      const isInsurance = sourceValue === "insurance";
      const insuranceActionForEntry = isInsurance
        ? (redeemLike ? "refund" : normalizeInsuranceAction(body.insuranceAction, "premium"))
        : null;
      if (!accountId && fundProductType !== "deposit" && fundProductType !== "wealth" && !isInsurance) {
        return NextResponse.json({ ok: false, error: "请选择账户" }, { status: 400 });
      }
      if (isInsurance && !insuranceProductId && !insuranceProductMasterId && !ownerGroupId && !String(body.policyholderPersonId ?? "").trim()) {
        return NextResponse.json({ ok: false, error: "请选择投保人" }, { status: 400 });
      }

      let finalInvestmentAccId = "";
      let scheduledInsurancePremiumPlanId: string | null = null;
      await prisma.$transaction(async (tx) => {
        let resolvedInsuranceProductName: string | null = null;
        let insuranceProductForPlan: {
          id: string;
          name: string;
          accountId: string;
          premiumFrequencyMonths: number | null;
          premiumAmount: unknown;
          paymentTermYears: unknown;
          startDate: Date | null;
        } | null = null;
        let investAcc =
          fundProductType === "deposit"
            ? await resolveOrCreateDepositAccount(tx, {
                householdId,
                requestedAccountId: accountId || null,
                cashAccountId: cashAccountIdInput,
                fundName: fundNameInput || note || null,
              })
            : fundProductType === "wealth" && finalFundSubtype === FundSubtype.buy
              ? await resolveOrCreateWealthAccount(tx, {
                  householdId,
                  cashAccountId: cashAccountIdInput ?? "",
                  requestedAccountId: accountId || null,
                })
              : accountId
                ? await tx.account.findUnique({ where: { id: accountId } })
                : null;

        if (isInsurance) {
          const policyholderPersonIdInput = String(body.policyholderPersonId ?? "").trim() || null;
          const insuredPersonIdInput = String(body.insuredPersonId ?? "").trim() || null;
          const policyholderPersonName = String(body.policyholderPersonName ?? "").trim() || null;
          const insuredPersonName = String(body.insuredPersonName ?? "").trim() || null;
          const beneficiaryName = String(body.beneficiaryName ?? "").trim() || null;
          const policyNo = String(body.policyNo ?? "").trim() || null;
          const policyholderPerson = await ensureFamilyMemberInstitutionInTx({
            tx,
            householdId,
            personId: policyholderPersonIdInput,
            personName: policyholderPersonName,
          });
          const insuredPerson = await ensureFamilyMemberInstitutionInTx({
            tx,
            householdId,
            personId: insuredPersonIdInput,
            personName: insuredPersonName,
          });
          const resolvedOwnerGroupId = await resolveOwnerGroupFromPersonInTx({
            tx,
            householdId,
            ownerGroupId,
            policyholderPerson,
          });
          let resolvedInsuranceProductId = insuranceProductId;
          let insuranceProduct =
            resolvedInsuranceProductId
              ? await tx.insuranceProduct.findFirst({
                  where: { id: resolvedInsuranceProductId, householdId },
                })
              : null;
          if (!insuranceProduct && insuranceProductMasterId) {
            if (!resolvedOwnerGroupId) throw new Error("请选择投保人");
            const productMaster = await tx.insuranceProductMaster.findFirst({
              where: { id: insuranceProductMasterId, householdId },
            });
            if (!productMaster) throw new Error("保险产品不存在");
            const account = await getOrCreateInsuranceAccount(tx, resolvedOwnerGroupId, householdId, productMaster.institutionId);
            insuranceProduct = await tx.insuranceProduct.create({
              data: {
                householdId,
                accountId: account.id,
                ownerGroupId: resolvedOwnerGroupId,
                institutionId: productMaster.institutionId,
                productMasterId: productMaster.id,
                policyNo,
                name: productMaster.name,
                shortName: productMaster.shortName,
                productType: productMaster.productType,
                accountingType: productMaster.accountingType,
                currency: productMaster.currency,
                status: "active",
                policyholderPersonId: policyholderPerson?.id ?? null,
                insuredPersonId: insuredPerson?.id ?? null,
                beneficiaryName: beneficiaryName || null,
                startDate: toDateOrNull(body.startDate),
                effectiveDate: toDateOrNull(body.effectiveDate) ?? toDateOrNull(body.startDate),
                premiumMode: String(body.premiumMode ?? "").trim() || null,
                premiumFrequencyMonths: positiveNumber(body.premiumFrequencyMonths) ?? null,
                premiumAmount: positiveNumber(body.premiumAmount) ?? amountAbs,
                paymentTermYears: positiveNumber(body.paymentTermYears) ?? null,
                coverageTermYears: positiveNumber(body.coverageTermYears) ?? null,
                coverageAmount: positiveNumber(body.coverageAmount) ?? null,
                cashValueEnabled: body.cashValueEnabled === false ? false : productMaster.accountingType !== "protection",
                note: String(body.productNote ?? body.note ?? "").trim() || productMaster.note || null,
              },
            });
            resolvedInsuranceProductId = insuranceProduct.id;
          }
          if (!insuranceProduct) throw new Error("请选择保险产品");
          if (!insuranceProduct) throw new Error("保险产品不存在");
          if (!insuranceProduct.ownerGroupId) throw new Error("该保险产品缺少投保人");
          if (resolvedOwnerGroupId && resolvedOwnerGroupId !== insuranceProduct.ownerGroupId) throw new Error("投保人与保险产品不一致");
          resolvedInsuranceProductName = insuranceProduct.name;
          insuranceProductForPlan = {
            id: insuranceProduct.id,
            name: insuranceProduct.name,
            accountId: insuranceProduct.accountId,
            premiumFrequencyMonths: insuranceProduct.premiumFrequencyMonths,
            premiumAmount: insuranceProduct.premiumAmount,
            paymentTermYears: insuranceProduct.paymentTermYears,
            startDate: insuranceProduct.startDate ?? insuranceProduct.effectiveDate ?? null,
          };
          insuranceProductId = resolvedInsuranceProductId;
          if (!investAcc) {
            investAcc = await tx.account.findUnique({ where: { id: insuranceProduct.accountId } });
          }
          if (!investAcc || !isInsuranceAccount(investAcc)) {
            if (!insuranceProduct.ownerGroupId) throw new Error("该保险产品缺少投保人");
            if (!insuranceProduct.institutionId) throw new Error("该保险产品缺少承保机构");
            investAcc = await getOrCreateInsuranceAccount(tx, insuranceProduct.ownerGroupId, householdId, insuranceProduct.institutionId);
            await tx.insuranceProduct.update({
              where: { id: insuranceProduct.id },
              data: { accountId: investAcc.id },
            });
            insuranceProductForPlan.accountId = investAcc.id;
          }
        }

        if (!investAcc) throw new Error("账户不存在");
        if (isInsurance) {
          if (!isInsuranceAccount(investAcc)) throw new Error("保险产品未关联保险账户");
        } else if (!isPureInvestmentAccount(investAcc) && !isDepositAccount(investAcc)) {
          throw new Error("请选择投资/存款账户");
        }
        finalInvestmentAccId = investAcc.id;
        const fundUnitsPrecisionAccount = await tx.account.findUnique({
          where: { id: investAcc.id },
          select: { fundUnitsDecimals: true },
        });
        const fundUnitsDecimals = normalizeFundUnitsDecimals(fundUnitsPrecisionAccount?.fundUnitsDecimals);
        const roundedFundUnits = fundUnits != null ? roundFundUnits(fundUnits, fundUnitsDecimals) : null;

        const cashAcc = cashAccountIdInput
          ? await tx.account.findUnique({ where: { id: cashAccountIdInput }, select: { id: true, name: true, kind: true, currency: true } })
          : null;

        const metalType = fundProductType === "metal" && metalTypeIdInput
          ? await tx.preciousMetalType.findFirst({
              where: {
                id: metalTypeIdInput,
                isActive: true,
                OR: [{ householdId }, { householdId: null }],
              },
            })
          : null;
        const metalUnit = fundProductType === "metal" && metalUnitIdInput
          ? await tx.preciousMetalUnit.findFirst({
              where: {
                id: metalUnitIdInput,
                isActive: true,
                OR: [{ householdId }, { householdId: null }],
              },
            })
          : null;
        if (fundProductType === "metal" && !metalType) throw new Error("请选择贵金属品种");
        if (fundProductType === "metal" && !metalUnit) throw new Error("请选择贵金属单位");
        const wealthProduct = fundProductType === "wealth"
          ? (wealthProductIdInput
              ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, institutionId: investAcc.institutionId, isActive: true } })
              : fundNameInput
                ? await tx.wealthProduct.findFirst({
                    where: { householdId, institutionId: investAcc.institutionId ?? null, name: fundNameInput, isActive: true },
                  }) ?? await tx.wealthProduct.create({
                    data: {
                      householdId,
                      institutionId: investAcc.institutionId ?? null,
                      name: fundNameInput,
                      currency: investAcc.currency ?? "CNY",
                    },
                  })
                : null)
          : null;
        if (fundProductType === "wealth" && !wealthProduct) throw new Error("请选择或新增理财产品");

        const isMetalProduct = fundProductType === "metal";
        const entryFundCode = isMetalProduct ? null : fundCode || null;
        const entryFundName = isMetalProduct ? null : resolvedInsuranceProductName || wealthProduct?.name || fundNameInput || fundCode || null;
        const isInsurancePremiumBuy = isInsurance && insuranceActionForEntry === "premium" && finalFundSubtype === FundSubtype.buy && !redeemLike;
        const premiumFrequencyMonths = insuranceProductForPlan
          ? Number(insuranceProductForPlan.premiumFrequencyMonths ?? 0)
          : 0;
        const premiumAmount = insuranceProductForPlan
          ? positiveNumber(insuranceProductForPlan.premiumAmount) ?? amountAbs
          : amountAbs;
        const insurancePremiumTotalRuns = insuranceProductForPlan
          ? insurancePremiumTotalCycles(insuranceProductForPlan.paymentTermYears, premiumFrequencyMonths)
          : null;
        const shouldUseInsurancePremiumPlan = !!(
          isInsurancePremiumBuy &&
          (createInsurancePremiumPlan || backfillInsurancePremiumRecords) &&
          insuranceProductForPlan &&
          cashAcc?.id &&
          insurancePremiumTotalRuns &&
          insurancePremiumTotalRuns > 1 &&
          premiumAmount > 0
        );

        if (
          skipDuplicateInsurancePremiumDate &&
          !shouldUseInsurancePremiumPlan &&
          isInsurance &&
          insuranceProductId &&
          insuranceActionForEntry === "premium" &&
          finalFundSubtype === FundSubtype.buy &&
          !redeemLike
        ) {
          const nextDay = new Date(date);
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          const existingPremiumEntry = await tx.txRecord.findFirst({
            where: {
              householdId,
              insuranceProductId,
              source: "insurance",
              type: TransactionType.investment,
              fundSubtype: FundSubtype.buy,
              deletedAt: null,
              date: { gte: date, lt: nextDay },
            },
            select: { id: true },
          });
          if (existingPremiumEntry) {
            createdId = existingPremiumEntry.id;
            return;
          }
        }

        if (shouldUseInsurancePremiumPlan && insuranceProductForPlan && cashAcc?.id && insurancePremiumTotalRuns) {
          const anchorDate = startOfDayUtc(insuranceProductForPlan.startDate ?? date);
          const anchorDay = anchorDate.getUTCDate();
          const memo = encodeScheduledTaskMemo({
            type: "insurance_premium",
            title: `${insuranceProductForPlan.name} 缴费`,
            fromAccountId: cashAcc.id,
            toAccountId: investAcc.id,
            insuranceProductId: insuranceProductForPlan.id,
          });
          const existingPlan = await tx.regularInvestPlan.findFirst({
            where: {
              householdId,
              fundCode: "insurance_premium",
              memo: { contains: insuranceProductForPlan.id },
              status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused, RegularInvestStatus.completed] },
            },
            orderBy: { createdAt: "desc" },
          });
          const existingExecutedRuns = existingPlan?.executedRuns ?? 0;
          const existingCompleted = existingPlan?.status === RegularInvestStatus.completed && existingExecutedRuns >= insurancePremiumTotalRuns;
          const planData = {
            accountId: investAcc.id,
            accountName: investAcc.name,
            cashAccountId: cashAcc.id,
            cashAccountName: cashAcc.name,
            fundCode: "insurance_premium",
            fundName: `${insuranceProductForPlan.name} 缴费`,
            taskType: "insurance_premium",
            targetName: insuranceProductForPlan.name,
            insuranceProductName: insuranceProductForPlan.name,
            fundProductType: null,
            amount: premiumAmount,
            intervalUnit: premiumFrequencyMonths === 12 ? IntervalUnit.year : IntervalUnit.month,
            intervalValue: premiumFrequencyMonths === 12 ? 1 : premiumFrequencyMonths,
            executionDay: premiumFrequencyMonths === 12 ? null : anchorDay,
            startDate: anchorDate,
            nextRunDate: existingPlan?.nextRunDate ?? anchorDate,
            totalRuns: insurancePremiumTotalRuns,
            executedRuns: existingExecutedRuns,
            lastRunDate: existingPlan?.lastRunDate ?? null,
            feeRate: 0,
            confirmDays: 0,
            arrivalDays: 0,
            memo,
            skipPendingPreceding: false,
            status: existingCompleted ? RegularInvestStatus.completed : RegularInvestStatus.active,
          };
          if (existingPlan) {
            await tx.regularInvestPlan.update({
              where: { id: existingPlan.id },
              data: planData,
            });
            scheduledInsurancePremiumPlanId = existingPlan.id;
          } else {
            const createdPlan = await tx.regularInvestPlan.create({
              data: {
                householdId,
                ...planData,
              },
            });
            scheduledInsurancePremiumPlanId = createdPlan.id;
          }
          createdPlanId = scheduledInsurancePremiumPlanId;
          return;
        }

        let cashFlowAmount: number;
        let cashFlowDate = date;
        let signedAmount: number;

        if (redeemLike) {
          signedAmount = fundArrivalAmount ?? Math.max(0, amountAbs + (depositInterest ?? 0) - (fundFee ?? 0));
          cashFlowAmount = signedAmount;
          cashFlowDate = fundArrivalDate ?? date;
        } else if (isDividendReinvest) {
          signedAmount = -amountAbs;
          cashFlowAmount = 0;
        } else if (isDividendCash && cashAcc) {
          signedAmount = amountAbs;
          cashFlowAmount = signedAmount;
          cashFlowDate = fundArrivalDate ?? date;
        } else {
          signedAmount = -amountAbs;
          cashFlowAmount = signedAmount;
        }

        const applyDateStr = date.toISOString().slice(0, 10);
        const shouldComputeArrival = finalFundSubtype === FundSubtype.buy && !redeemLike && !isDividendCash && !isDividendReinvest;
        let computedConfirmDate: Date | null = fundConfirmDate;
        let computedArrivalDate: Date | null = fundArrivalDate;

        if (!isMetalProduct && shouldComputeArrival && entryFundCode) {
          const confirmStr = computedConfirmDate
            ? computedConfirmDate.toISOString().slice(0, 10)
            : addWorkdaysUtc(applyDateStr, await getFundConfirmDays(investAcc.id, entryFundCode));
          computedConfirmDate = new Date(`${confirmStr}T00:00:00.000Z`);

          if (!computedArrivalDate) {
            const arrivalStr = addWorkdaysUtc(confirmStr, await getFundArrivalDays(investAcc.id, entryFundCode));
            computedArrivalDate = new Date(`${arrivalStr}T00:00:00.000Z`);
          }
        }

        const created = await tx.txRecord.create({
          data: {
            date,
            type: TransactionType.investment,
            accountId: investAcc.id,
            accountName: investAcc.name,
            toAccountId: null,
            toAccountName: null,
            amount: signedAmount,
            fundCode: entryFundCode,
            fundName: entryFundName,
            wealthProductId: wealthProduct?.id ?? undefined,
            metalTypeId: metalType?.id ?? undefined,
            metalTypeName: metalType?.name ?? undefined,
            metalUnitId: metalUnit?.id ?? undefined,
            metalUnitName: metalUnit ? (metalUnit.symbol ? `${metalUnit.name}(${metalUnit.symbol})` : metalUnit.name) : undefined,
            metalQuantity: isMetalProduct ? (metalQuantity != null ? roundFundUnits(metalQuantity, fundUnitsDecimals) : undefined) : undefined,
            metalUnitPrice: isMetalProduct ? metalUnitPrice ?? undefined : undefined,
            metalFee: isMetalProduct ? metalFee ?? undefined : undefined,
            insuranceProductId: insuranceProductId ?? undefined,
            insuranceAction: insuranceActionForEntry ?? undefined,
            insuranceProductName: isInsurance ? entryFundName : undefined,
            fundProductType: isInsurance ? null : fundProductType as "fund" | "money" | "wealth" | "deposit" | "metal" | null | undefined,
            fundSubtype: finalFundSubtype,
            source: sourceValue,
            fundUnits: isMetalProduct ? undefined : roundedFundUnits ?? undefined,
            fundNav: isMetalProduct || fundProductType === "deposit" ? undefined : fundNav ?? undefined,
            depositAnnualRate: depositAnnualRate ?? undefined,
            depositInterest: depositInterest ?? undefined,
            depositSourceEntryId: depositSourceEntryId ?? undefined,
            fundFee: isMetalProduct ? undefined : fundFee ?? undefined,
            fundConfirmDate: isMetalProduct ? undefined : computedConfirmDate ?? undefined,
            fundArrivalDate: isMetalProduct ? undefined : computedArrivalDate ?? undefined,
            fundArrivalAmount: fundArrivalAmount ?? undefined,
            note: note || (isInsurance && finalFundSubtype === FundSubtype.buy && !redeemLike
              ? `${insuranceActionForEntry === "additional_premium" ? "保全缴费" : "保险缴费"}：${entryFundName}`
              : undefined),
            householdId,
          },
        });
        createdId = created.id;

        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
        const shouldCreateCashEntry = !!cashAcc && cashAcc.id !== investAcc.id && cashFlowAmount !== 0;
        if (shouldCreateCashEntry && cashAcc) {
          const cashEntry = await tx.txRecord.create({
            data: {
              date: cashFlowDate,
              type: TransactionType.investment,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              toAccountId: null,
              toAccountName: null,
              amount: cashFlowAmount,
              currency: cashAcc.currency ?? investAcc.currency ?? "CNY",
              source: `${sourceValue || "manual"}_cash_flow`,
              note: note || entryFundName || undefined,
              householdId,
            },
          });
          createdCashEntryId = cashEntry.id;
          const businessType: EntryBusinessType = isInsurance
            ? "insurance"
            : fundProductType === "wealth"
              ? "wealth"
              : fundProductType === "deposit"
                ? "deposit"
                : fundProductType === "metal"
                  ? "metal"
                  : "fund";
          if (businessType === "fund") {
            await upsertEntryBusinessCashFlowLink(tx, {
              householdId,
              cashEntryId: cashEntry.id,
              businessEntryId: created.id,
              businessType,
              cashFlowDirection: cashFlowAmount < 0 ? "outflow" : "inflow",
              source: sourceValue,
              note: "Split cash flow from business detail",
              metadata: {
                splitRecord: true,
                cashDate: cashFlowDate.toISOString(),
              },
            });
          }
        }
        await syncIndependentBusinessTransactionFromTxRecord(tx, {
          businessEntryId: created.id,
          cashEntryId: createdCashEntryId,
        });
        if (
          finalFundSubtype === FundSubtype.buy &&
          sourceValue !== "insurance" &&
          !isMetalProduct &&
          buyResultStatus === "refund" &&
          refundAmount &&
          refundAmount > 0 &&
          cashAcc &&
          entryFundCode
        ) {
          const effectiveRefundDate = refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date;
          await upsertFundBuyRefundRecord(tx, {
            householdId,
            buyEntryId: created.id,
            buyDate: date,
            refundDate: effectiveRefundDate,
            refundAmount,
            fundAccountId: investAcc.id,
            fundAccountName: investAcc.name,
            cashAccountId: cashAcc.id,
            cashAccountName: cashAcc.name,
            currency: investAcc.currency ?? "CNY",
            fundCode: entryFundCode,
            fundName: entryFundName,
            fundProductType,
            fundConfirmDate: computedConfirmDate,
            fundArrivalDate: effectiveRefundDate,
            regularInvestPlanId: created.regularInvestPlanId ?? null,
            note: note || `买入退回 ${entryFundName || entryFundCode}`,
          });
        }
      });

      if (scheduledInsurancePremiumPlanId && backfillInsurancePremiumRecords) {
        const plan = await prisma.regularInvestPlan.findFirst({
          where: { id: scheduledInsurancePremiumPlanId, householdId },
        });
        if (plan) {
          await executeNonFundScheduledTaskPlan({
            householdId,
            plan,
            now: date,
          });
        }
      }

      if (!isInsurance && fundProductType === "metal" && finalInvestmentAccId) {
        await recalcPreciousMetalPositions(finalInvestmentAccId).catch(logger.catchLog("操作失败", "route.ts"));
      } else if (!isInsurance && fundProductType !== "deposit" && finalInvestmentAccId) {
        await recalcFundPositions(finalInvestmentAccId, fundCode ? [fundCode] : undefined).catch(logger.catchLog("操作失败", "route.ts"));
      }
      if (finalInvestmentAccId) {
        await recalcAndSaveAccountBalance(finalInvestmentAccId).catch(logger.catchLog("操作失败", "route.ts"));
      }
      if (cashAccountIdInput && cashAccountIdInput !== finalInvestmentAccId) {
        await recalcAndSaveAccountBalance(cashAccountIdInput).catch(logger.catchLog("操作失败", "route.ts"));
      }
    } else {
      return NextResponse.json({ ok: false, error: "类型不正确" }, { status: 400 });
    }

    if (changedInvestment && createdId) {
      await syncFundTransactionsFromTxRecords([createdId]).catch(logger.catchLog("sync fund transaction", "route.ts"));
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: createdId }).catch(
        logger.catchLog("sync independent business transaction", "route.ts"),
      );
    }
    if (createdId) {
      const createdAccounts = await prisma.txRecord.findMany({
        where: { id: { in: [createdId, createdCashEntryId].filter((id): id is string => !!id) } },
        select: { accountId: true, toAccountId: true },
      });
      if (createdAccounts.length > 0) {
        await invalidateCreditCardCycleCacheForAccountIds(createdAccounts.flatMap((row) => [row.accountId, row.toAccountId])).catch(
          logger.catchLog("信用卡账单缓存失效失败", "route.ts"),
        );
      }
    }
    if (changedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();

    // 返回刚创建的记录
    if (createdId) {
      const created = await prisma.txRecord.findUnique({
        where: { id: createdId },
        include: {
          ...entryBusinessLinkSummaryInclude,
          EntryTag: { include: { Tag: true } },
          account: { include: { Institution: { select: { name: true } } } },
          toAccount: { include: { Institution: { select: { name: true } } } },
        },
      });
      if (created) {
        return NextResponse.json({
          ok: true,
          data: {
            id: created.id,
            date: formatDateLocal(created.date),
            postedAt: toDateOnlyLocal(created.postedAt),
            dayOrder: created.dayOrder,
            amount: toNumber(created.amount),
            type: created.type,
            categoryId: created.categoryId,
            categoryName: created.categoryName,
            accountId: created.accountId,
            accountName: created.accountName,
            accountKind: created.account?.kind ?? null,
            accountDebtDirection: created.account?.debtDirection ?? null,
            accountIsSettlementDebt: isSettlementDebtAccountForDetail(created.account),
            accountInstitutionName: created.account?.Institution?.name ?? "",
            toAccountId: created.toAccountId,
            toAccountName: created.toAccountName,
            toAccountKind: created.toAccount?.kind ?? null,
            toAccountDebtDirection: created.toAccount?.debtDirection ?? null,
            toAccountIsSettlementDebt: isSettlementDebtAccountForDetail(created.toAccount),
            toAccountInstitutionName: created.toAccount?.Institution?.name ?? "",
            note: created.note,
            fundSubtype: created.fundSubtype,
            fundCode: created.fundCode,
            fundName: created.fundName,
            wealthProductId: created.wealthProductId ?? null,
            insuranceProductId: created.insuranceProductId ?? null,
            fundProductType: created.fundProductType,
            fundNav: created.fundNav ? toNumber(created.fundNav) : null,
            depositAnnualRate: created.depositAnnualRate ? toNumber(created.depositAnnualRate) : null,
            depositInterest: created.depositInterest ? toNumber(created.depositInterest) : null,
            depositSourceEntryId: created.depositSourceEntryId ?? null,
            fundUnits: created.fundUnits ? toNumber(created.fundUnits) : null,
            fundFee: created.fundFee ? toNumber(created.fundFee) : null,
            fundConfirmDate: created.fundConfirmDate ? formatDateLocal(created.fundConfirmDate) : null,
            fundArrivalDate: created.fundArrivalDate ? formatDateLocal(created.fundArrivalDate) : null,
            fundArrivalAmount: created.fundArrivalAmount ? toNumber(created.fundArrivalAmount) : null,
            source: created.source,
            ...buildEntryBusinessLinkSummary(created),
            entryTags: mapEntryTags(created),
          },
        });
      }
    }

    return NextResponse.json({ ok: true, data: { id: createdId, regularInvestPlanId: createdPlanId } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "创建失败";
    console.error("POST /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/* ────────────────── PUT (UPDATE) ────────────────── */

/**
 * PUT /api/v1/transactions/detail
 * 更新交易记录
 *
 * Body (JSON):
 *   id: string (必填)
 *   date?: string (YYYY-MM-DD)
 *   postedAt?: string (YYYY-MM-DD; expense/income only, defaults to date)
 *   amount?: number
 *   type?: "expense" | "income" | "advance" | "transfer" | "investment"
 *   accountId?: string
 *   categoryId?: string
 *   toAccountId?: string (transfer; ordinary cash/credit targets only. Fund, deposit, and debt targets must use their specialized transaction payloads.)
 *   toAccountName?: string
 *   note?: string
 *   tagIds?: string[]
 *   --- investment fields ---
 *   fundCode?: string
 *   fundName?: string
 *   wealthProductId?: string
 *   insuranceProductId?: string
 *   fundProductType?: string
 *   fundSubtype?: string
 *   fundNav?: number
 *   fundUnits?: number
 *   fundFee?: number
 *   fundConfirmDate?: string
 *   fundArrivalDate?: string
 *   fundArrivalAmount?: number
 *   cashAccountId?: string
 *   keepFundDetail?: boolean
 *
 * 返回: { ok: true, data: { id, ... } } | { ok: false, error }
 */
export async function PUT(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "无效的请求体" }, { status: 400 });
    }

    const type = String(body.type ?? "").trim();
    const entryId = String(body.id ?? body.entryId ?? "").trim();
    const productType = String(body.fundProductType ?? body.productType ?? "").trim();
    const businessTransactionId = String(body.businessTransactionId ?? "").trim();
    if (!entryId && !(type === "investment" && productType === "wealth" && businessTransactionId)) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }

    const dateStr = String(body.date ?? "").trim();
    const amountRaw = parseMoney(body.amount);
    const amountAbs = Math.abs(amountRaw);
    const note = String(body.note ?? "").trim();
    const toNote = String(body.toNote ?? "").trim();
    const counterpartyInstitutionId = String(body.counterpartyInstitutionId ?? "").trim();
    const tagIdsRaw = body.tagIds;
    const tagIds: string[] = Array.isArray(tagIdsRaw)
      ? tagIdsRaw.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];

    const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
    const postedAt = type === "expense" || type === "income" ? (toDateOrNull(body.postedAt) ?? date) : null;
    if (!amountAbs) {
      return NextResponse.json({ ok: false, error: "金额不正确" }, { status: 400 });
    }

    const { householdId } = ctx;
    const undo = entryId ? await prepareEntryUndo(prisma, householdId, [entryId]) : null;

    let oldAccountId: string | undefined;
    let oldToAccountId: string | undefined;
    let investmentAccId: string | undefined;
    let advanceAccountId: string | undefined;
    let changedInvestment = false;

    if (type === "investment" && String(body.fundProductType ?? body.productType ?? "").trim() === "wealth") {
      const updated = await editSplitWealthTransactionFromBody(body, householdId, tagIds);
      await saveEntryUndo(prisma, ctx, undo, "edit", "编辑明细");
      const data = await loadApiDetailRecord(updated.cashEntryId);
      if (!data) {
        return NextResponse.json({ ok: false, error: "更新后记录不存在" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, data });
    }

    await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({ where: { id: entryId } });
      if (!entry) throw new Error("记录不存在");
      if (entry.householdId && entry.householdId !== householdId) {
        throw new Error("记录不属于当前账簿");
      }

      // Save old account IDs for balance recalculation
      oldAccountId = entry.accountId ?? undefined;
      oldToAccountId = entry.toAccountId ?? undefined;

      await replaceEntryTags({ tx, entryId, householdId: entry.householdId, tagIds });

      if (type === "transfer") {
        const fromAccountId = String(body.fromAccountId ?? body.accountId ?? "").trim();
        const toAccountId = String(body.toAccountId ?? "").trim();
        if (!fromAccountId || !toAccountId) throw new Error("转账需要选择转出/转入账户");
        if (fromAccountId === toAccountId) throw new Error("转出/转入账户不能相同");

        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId } }),
          tx.account.findUnique({ where: { id: toAccountId } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error("账户不存在");
        const isDebtTransfer = fromAcc.kind === AccountKind.loan || toAcc.kind === AccountKind.loan;
        if (fromAcc.kind === AccountKind.loan && toAcc.kind === AccountKind.loan) {
          throw new Error("往来款账户之间不能保存为普通转账");
        }
        if (!isDebtTransfer && (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc))) {
          throw new Error("基金、存款和往来款账户不能保存为普通转账，请使用对应的专用记账窗口");
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);
        const debtMode = isDebtTransfer
          ? fromAcc.kind === AccountKind.loan
            ? fromAcc.debtDirection === "receivable" ? "collect_in" : "borrow_in"
            : toAcc.debtDirection === "receivable" ? "lend_out" : "repay_out"
          : null;
        const signedTransferAmount = debtMode === "collect_in" ? amountAbs : -amountAbs;

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);
        const transferCategory = debtMode
          ? await ensureSettlementTransferCategory(tx, householdId)
          : isCreditCardRepaymentTransfer({
              type: TransactionType.transfer,
              accountKind: fromAcc.kind,
              toAccountKind: toAcc.kind,
            })
            ? await resolveCreditCardRepaymentCategory(tx, householdId)
            : null;

        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: signedTransferAmount,
            accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            categoryId: transferCategory?.id ?? null,
            categoryName: transferCategory?.name ?? null,
            statementMonth: transferStatementMonth,
            date,
            postedAt: null,
            type: TransactionType.transfer,
            counterpartyInstitutionId: null,
            counterpartyInstitutionName: null,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            source: debtMode ? `debt_${debtMode}` : entry.source,
            fundCode: null,
            fundName: null,
            fundProductType: null,
            fundSubtype: null,
            fundUnits: null,
            fundNav: null,
            fundFee: null,
            fundConfirmDate: null,
            fundArrivalDate: null,
            fundArrivalAmount: null,
            fundSourceEntryId: null,
            wealthProductId: null,
            depositAnnualRate: null,
            depositInterest: null,
            depositSourceEntryId: null,
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
            debtPrincipalAmount: debtMode ? amountAbs : null,
            debtInterestAmount: debtMode ? 0 : null,
            debtFeeAmount: debtMode ? 0 : null,
            realizedProfit: null,
          },
        });
        return;
      }

  if (type === "investment") {
    changedInvestment = true;
    const accountIdFormData = String(body.accountId ?? body.investAccountId ?? "").trim();
    const cashAccountIdFormData = String(body.cashAccountId ?? "").trim();
    const fundCode = String(body.fundCode ?? "").trim() || null;
    const wealthProductIdInput = String(body.wealthProductId ?? "").trim();
    const metalTypeIdInput = String(body.metalTypeId ?? "").trim();
    const metalUnitIdInput = String(body.metalUnitId ?? "").trim();
    const insuranceProductId = String(body.insuranceProductId ?? "").trim() || entry.insuranceProductId || null;
    const ownerGroupIdFromBody = String(body.ownerGroupId ?? "").trim() || null;
    const productType = String(body.fundProductType ?? "fund").trim();
    const subtype = String(body.fundSubtype ?? "buy").trim();
    const buyResultStatus = String(body.buyResultStatus ?? "normal").trim();
    const linkedRefundEntryId = String(body.linkedRefundEntryId ?? "").trim() || null;
    const refundAmountRaw = parseMoney(body.refundAmount);
    const refundDateStr = String(body.refundDate ?? "").trim();
    const refundAmount = refundAmountRaw > 0 ? Math.abs(refundAmountRaw) : null;
    const refundDate = refundDateStr ? dateFromYmd(refundDateStr) : null;
    const redeemLike = subtype === "redeem" || subtype === "switch_out";
    const sourceValue = String(body.source ?? entry.source ?? "manual").trim();
    const isBuyFailedRefund = subtype === "buy_failed" && sourceValue === "regular_invest_refund";
    const cashReceivingLike = redeemLike || subtype === "dividend_cash" || isBuyFailedRefund;
    const isInsuranceEdit = sourceValue === "insurance";
    const insuranceActionForEdit = isInsuranceEdit
      ? (redeemLike
          ? "refund"
          : normalizeInsuranceAction(
              body.insuranceAction,
              entry.insuranceAction === "additional_premium" ? "additional_premium" : "premium",
            ))
      : null;

    let investAcc = isInsuranceEdit && !accountIdFormData
      ? null
      : accountIdFormData
        ? await tx.account.findUnique({ where: { id: accountIdFormData } })
        : null;
    let resolvedInsuranceProductName: string | null = null;

    if (isInsuranceEdit) {
      if (!insuranceProductId) throw new Error("请选择保险产品");
      const insuranceProduct = await tx.insuranceProduct.findFirst({
        where: { id: insuranceProductId, householdId },
      });
      if (!insuranceProduct) throw new Error("保险产品不存在");
      if (!insuranceProduct.ownerGroupId) throw new Error("该保险产品缺少投保人");
      if (ownerGroupIdFromBody && ownerGroupIdFromBody !== insuranceProduct.ownerGroupId) throw new Error("投保人与保险产品不一致");
      resolvedInsuranceProductName = insuranceProduct.name;
      if (!investAcc) {
        investAcc = await tx.account.findUnique({ where: { id: insuranceProduct.accountId } });
      }
      if (!investAcc || !isInsuranceAccount(investAcc)) {
        const effectiveOwnerId = insuranceProduct.ownerGroupId || ownerGroupIdFromBody;
        if (!effectiveOwnerId) throw new Error("该保险产品缺少投保人");
        if (!insuranceProduct.institutionId) throw new Error("该保险产品缺少承保机构");
        investAcc = await getOrCreateInsuranceAccount(tx, effectiveOwnerId, householdId, insuranceProduct.institutionId);
        await tx.insuranceProduct.update({
          where: { id: insuranceProduct.id },
          data: { accountId: investAcc.id },
        });
      }
    }

    if (productType === "wealth" && !cashReceivingLike) {
      const requestedCashAccountId = cashAccountIdFormData || (entry.accountId !== investAcc?.id ? entry.accountId : "");
      investAcc = await resolveOrCreateWealthAccount(tx, {
        householdId,
        cashAccountId: requestedCashAccountId,
        requestedAccountId: investAcc?.id ?? (accountIdFormData || null),
      });
    }

    if (!investAcc) throw new Error("请选择投资账户");
    investmentAccId = investAcc.id;
    const hasFundUnits = Object.prototype.hasOwnProperty.call(body, "fundUnits");
    const fundUnitsInput = hasFundUnits ? positiveNumber(body.fundUnits) : null;
    const metalQuantityInput = positiveNumber(body.metalQuantity ?? body.fundUnits);
    const metalUnitPriceInput = positiveNumber(body.metalUnitPrice ?? body.fundNav);
    const metalFeeInput = positiveNumber(body.metalFee ?? body.fundFee);
    const fundUnitsDecimals = normalizeFundUnitsDecimals(investAcc.fundUnitsDecimals);
    const roundedFundUnits = fundUnitsInput != null ? roundFundUnits(fundUnitsInput, fundUnitsDecimals) : null;
    const roundedMetalQuantity = metalQuantityInput != null ? roundFundUnits(metalQuantityInput, fundUnitsDecimals) : roundedFundUnits;
    const isMetalProduct = productType === "metal";
    const metalType = productType === "metal" && metalTypeIdInput
      ? await tx.preciousMetalType.findFirst({
          where: {
            id: metalTypeIdInput,
            isActive: true,
            OR: [{ householdId }, { householdId: null }],
          },
        })
      : null;
    const metalUnit = productType === "metal" && metalUnitIdInput
      ? await tx.preciousMetalUnit.findFirst({
          where: {
            id: metalUnitIdInput,
            isActive: true,
            OR: [{ householdId }, { householdId: null }],
          },
        })
      : null;
    if (productType === "metal" && !metalType) throw new Error("请选择贵金属品种");
    if (productType === "metal" && !metalUnit) throw new Error("请选择贵金属单位");
    const fundNameInput = String(body.fundName ?? "").trim();
    const wealthProduct = productType === "wealth"
      ? (wealthProductIdInput
          ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, institutionId: investAcc.institutionId, isActive: true } })
          : fundNameInput
            ? await tx.wealthProduct.findFirst({
                where: { householdId, institutionId: investAcc.institutionId ?? null, name: fundNameInput, isActive: true },
              }) ?? await tx.wealthProduct.create({
                data: {
                  householdId,
                  institutionId: investAcc.institutionId ?? null,
                  name: fundNameInput,
                  currency: investAcc.currency ?? "CNY",
                },
              })
            : null)
      : null;
    if (productType === "wealth" && !wealthProduct) throw new Error("请选择或新增理财产品");

        let cashAccId: string | null = null;
        let cashAccName: string | null = null;
        if (cashAccountIdFormData) {
          const cashAcc = await tx.account.findUnique({ where: { id: cashAccountIdFormData } });
          if (cashAcc) { cashAccId = cashAcc.id; cashAccName = cashAcc.name; }
        }
        if (!cashAccId) {
          if (redeemLike) {
            if (entry.toAccountId) {
              const acc = await tx.account.findUnique({ where: { id: entry.toAccountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; }
            }
          } else {
            if (entry.accountId && entry.accountId !== investAcc.id) {
              const acc = await tx.account.findUnique({ where: { id: entry.accountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; }
            }
          }
        }

        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        const hasFundFee = Object.prototype.hasOwnProperty.call(body, "fundFee");
        const fundArrivalAmount = parseMoney(body.fundArrivalAmount);
        const depositSourceEntryId = String(body.depositSourceEntryId ?? "").trim() || null;
        const fundFee = hasFundFee ? parseMoney(body.fundFee) : toNumber(entry.fundFee);

        if (cashReceivingLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAccId ?? investAcc.id;
          recordToAccountName = cashAccName ?? investAcc.name;
          signedAmount = subtype === "dividend_cash"
            ? amountAbs
            : (fundArrivalAmount > 0
                ? fundArrivalAmount
                : Math.max(0, amountAbs - (fundFee > 0 ? fundFee : 0)));
        } else {
          recordAccountId = cashAccId ?? investAcc.id;
          recordAccountName = cashAccName ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }

        const recalculatedRefundUnits = (
          (subtype as FundSubtype) === FundSubtype.buy &&
          sourceValue !== "insurance" &&
          !isMetalProduct &&
          buyResultStatus === "refund" &&
          refundAmount &&
          refundAmount > 0
        )
          ? calculateConfirmedBuyUnits({
              grossAmount: amountAbs,
              refundAmount,
              fee: fundFee > 0 ? fundFee : 0,
              nav: positiveNumber(body.fundNav) ?? toNumber(entry.fundNav),
              roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
            })
          : null;

        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: signedAmount,
            accountId: recordAccountId,
            accountName: recordAccountName,
            categoryId: null,
            categoryName: null,
            toAccountId: recordToAccountId,
            toAccountName: recordToAccountName,
            fundCode: isMetalProduct ? null : fundCode || null,
            fundName: isMetalProduct ? null : (resolvedInsuranceProductName || wealthProduct?.name || fundNameInput || entry.fundName),
            wealthProductId: wealthProduct?.id ?? null,
            metalTypeId: metalType?.id ?? null,
            metalTypeName: metalType?.name ?? null,
            metalUnitId: metalUnit?.id ?? null,
            metalUnitName: metalUnit ? (metalUnit.symbol ? `${metalUnit.name}(${metalUnit.symbol})` : metalUnit.name) : null,
            metalQuantity: isMetalProduct ? roundedMetalQuantity : null,
            metalUnitPrice: isMetalProduct ? metalUnitPriceInput : null,
            metalFee: isMetalProduct ? (metalFeeInput ?? (hasFundFee ? (fundFee > 0 ? fundFee : null) : entry.metalFee != null ? toNumber(entry.metalFee) : null)) : null,
            insuranceProductId,
            insuranceAction: insuranceActionForEdit ?? entry.insuranceAction,
            insuranceProductName: isInsuranceEdit
              ? (resolvedInsuranceProductName ?? entry.insuranceProductName ?? entry.fundName)
              : entry.insuranceProductName,
            fundProductType: isInsuranceEdit ? null : (productType as any) || null,
            fundSubtype: (subtype as any) || null,
            fundConfirmDate: isMetalProduct ? null : toDateOrNull(body.fundConfirmDate),
            fundArrivalDate: isMetalProduct ? null : toDateOrNull(body.fundArrivalDate),
            fundArrivalAmount: parseMoney(body.fundArrivalAmount) || null,
            fundUnits: isMetalProduct ? null : (recalculatedRefundUnits ?? (hasFundUnits ? roundedFundUnits : entry.fundUnits)),
            fundNav: isMetalProduct ? null : positiveNumber(body.fundNav),
            fundFee: isMetalProduct ? null : hasFundFee ? (fundFee > 0 ? fundFee : null) : entry.fundFee,
            depositAnnualRate: parseMoney(body.depositAnnualRate) || null,
            depositInterest: parseMoney(body.depositInterest) || null,
            depositSourceEntryId,
            date,
            postedAt: null,
            type: TransactionType.investment,
            note: note || null,
          },
        });

        if (
          (subtype as FundSubtype) === FundSubtype.buy &&
          sourceValue !== "insurance" &&
          !isMetalProduct &&
          buyResultStatus === "refund" &&
          refundAmount &&
          refundAmount > 0 &&
          fundCode &&
          cashAccId
        ) {
          const effectiveRefundDate =
            refundDate ??
            toDateOrNull(body.fundArrivalDate) ??
            toDateOrNull(body.fundConfirmDate) ??
            date;
          await upsertFundBuyRefundRecord(tx, {
            householdId,
            linkedRefundEntryId,
            buyEntryId: entry.id,
            buyDate: date,
            refundDate: effectiveRefundDate,
            refundAmount,
            fundAccountId: investAcc.id,
            fundAccountName: investAcc.name,
            cashAccountId: cashAccId,
            cashAccountName: cashAccName ?? "",
            currency: investAcc.currency ?? entry.currency ?? "CNY",
            fundCode,
            fundName: resolvedInsuranceProductName || wealthProduct?.name || fundNameInput || entry.fundName,
            fundProductType: productType,
            fundConfirmDate: toDateOrNull(body.fundConfirmDate),
            fundArrivalDate: effectiveRefundDate,
            regularInvestPlanId: entry.regularInvestPlanId ?? null,
            note: note || `买入退回 ${resolvedInsuranceProductName || wealthProduct?.name || fundNameInput || fundCode}`,
          });
        } else if ((subtype as FundSubtype) === FundSubtype.buy && linkedRefundEntryId) {
          await tx.txRecord.updateMany({
            where: {
              id: linkedRefundEntryId,
              householdId,
              fundSubtype: FundSubtype.buy_failed,
              source: "regular_invest_refund",
            },
            data: { deletedAt: new Date() },
          });
        }

if (!isInsuranceEdit && isMetalProduct) {
  await recalcPreciousMetalPositions(investAcc.id).catch(logger.catchLog("操作失败", "route.ts"));
} else if (!isInsuranceEdit) {
  await recalcFundPositions(investAcc.id, fundCode ? [fundCode] : undefined).catch(logger.catchLog("操作失败", "route.ts"));
}
if (!isInsuranceEdit || isInsuranceAccount(investAcc)) {
  await recalcAndSaveAccountBalance(investAcc.id).catch(logger.catchLog("操作失败", "route.ts"));
}
return;
      }

      if (type === "advance") {
        const accountId = String(body.accountId ?? "").trim();
        const categoryId = String(body.categoryId ?? "").trim();
        if (!accountId) throw new Error("请选择资金账户");
        if (!counterpartyInstitutionId) throw new Error("请选择往来对象");
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId } }),
          resolveCategorySnapshot(tx, householdId, { categoryId, type: "advance" }),
        ]);
        if (!acc) throw new Error("账户不存在");
        if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与代付记账");
        const resolvedAdvance = await resolveOrCreateAdvanceAccount(tx, {
          householdId,
          cashAccountId: acc.id,
          debtObjectId: counterpartyInstitutionId,
        });
        advanceAccountId = resolvedAdvance.account.id;
        const transfer = resolveAdvanceTransfer({ amount: amountRaw, cashAccount: acc, advanceAccount: resolvedAdvance.account });
        const statementMonth = statementMonthForTransfer(date, transfer.fromAccount, transfer.toAccount);
        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: transfer.transferAmount,
            accountId: transfer.fromAccount.id,
            accountName: transfer.fromAccount.name,
            toAccountId: transfer.toAccount.id,
            toAccountName: transfer.toAccount.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            counterpartyInstitutionId: resolvedAdvance.objectId,
            counterpartyInstitutionName: resolvedAdvance.objectName,
            statementMonth,
            date,
            postedAt: null,
            type: TransactionType.transfer,
            source: "advance",
            note: note || transfer.defaultNote,
            toNote: null,
            fundCode: null,
            fundProductType: null,
            fundSubtype: null,
          },
        });
        return;
      }

      if (type !== "expense" && type !== "income") throw new Error("类型不正确");

      const accountId = String(body.accountId ?? "").trim();
      const categoryId = String(body.categoryId ?? "").trim();
      const counterpartyInstitution = counterpartyInstitutionId
        ? await tx.institution.findFirst({
            where: { id: counterpartyInstitutionId, householdId, type: { in: [...INCOME_EXPENSE_INSTITUTION_TYPES] } },
          })
        : null;
      if (counterpartyInstitutionId && !counterpartyInstitution) {
        throw new Error("收支机构只能选择银行或第三方支付机构");
      }
      const keepFundDetail = body.keepFundDetail === true;

      const [acc, cat] = await Promise.all([
        accountId ? tx.account.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
        resolveCategorySnapshot(tx, householdId, {
          categoryId,
          type: type === "income" ? "income" : "expense",
        }),
      ]);
      if (!acc) throw new Error("请选择账户");
      if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与收支记账");

      const isFundTransaction = entry.toAccountId && entry.fundProductType;

      if (isFundTransaction) {
        if (keepFundDetail) {
          await tx.txRecord.update({
            where: { id: entryId },
            data: {
              accountId: entry.toAccountId ?? undefined,
              accountName: entry.toAccountName ?? "",
              amount: Math.abs(toNumber(entry.amount)),
            } as any,
          });
        } else {
          await tx.txRecord.update({
            where: { id: entryId },
            data: {
              toAccountId: null,
              toAccountName: null,
              fundCode: null,
              fundProductType: null,
              fundSubtype: null,
              fundUnits: null,
              fundNav: null,
              fundFee: null,
              fundConfirmDate: null,
              fundArrivalDate: null,
              fundArrivalAmount: null,
            },
          });
        }
      }

      const statementMonth =
        (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
          ? toStatementMonth(date, acc.billingDay)
          : null;

      await tx.txRecord.update({
        where: { id: entryId },
        data: {
          amount: amountRaw,
          accountId: acc.id,
          accountName: acc.name,
          categoryId: cat ? cat.id : null,
          categoryName: cat?.name ?? null,
          counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
          counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
          statementMonth,
          toAccountId: null,
          toAccountName: null,
          fundCode: null,
          fundName: null,
          fundProductType: null,
          fundSubtype: null,
          fundUnits: null,
          fundNav: null,
          fundFee: null,
          fundConfirmDate: null,
          fundArrivalDate: null,
          fundArrivalAmount: null,
          fundSourceEntryId: null,
          wealthProductId: null,
          depositAnnualRate: null,
          depositInterest: null,
          depositSourceEntryId: null,
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
          debtPrincipalAmount: null,
          debtInterestAmount: null,
          debtFeeAmount: null,
          realizedProfit: null,
        },
      });

      await tx.txRecord.update({
        where: { id: entry.id },
        data: {
          date,
          postedAt,
          type: type === "income" ? TransactionType.income : TransactionType.expense,
          note: note || null,
        },
      });
    }, TX_EDIT_TRANSACTION_OPTIONS);

    if (changedInvestment) {
      await upsertLegacyCombinedEntryBusinessLinks([entryId]).catch(logger.catchLog("sync entry business link", "route.ts"));
      await syncFundTransactionsFromTxRecords([entryId]).catch(logger.catchLog("sync fund transaction", "route.ts"));
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: entryId }).catch(
        logger.catchLog("sync independent business transaction", "route.ts"),
      );
    }

    // 重算余额：所有涉及的旧/新账户
    const accountsToRecalc = new Set<string>();
    if (oldAccountId) accountsToRecalc.add(oldAccountId);
    if (oldToAccountId) accountsToRecalc.add(oldToAccountId);

    if (type === "transfer") {
      const fromAccountId = String(body.fromAccountId ?? body.accountId ?? "").trim();
      const toAccountId = String(body.toAccountId ?? "").trim();
      if (fromAccountId) accountsToRecalc.add(fromAccountId);
      if (toAccountId) accountsToRecalc.add(toAccountId);
    } else if (type === "investment") {
      if (investmentAccId) accountsToRecalc.add(investmentAccId);
      const cashId = String(body.cashAccountId ?? "").trim();
      if (cashId) accountsToRecalc.add(cashId);
    } else if (type === "advance") {
      const accountId = String(body.accountId ?? "").trim();
      if (accountId) accountsToRecalc.add(accountId);
      if (advanceAccountId) accountsToRecalc.add(advanceAccountId);
    } else if (type === "expense" || type === "income") {
      const accountId = String(body.accountId ?? "").trim();
      if (accountId) accountsToRecalc.add(accountId);
    }

    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    await invalidateCreditCardCycleCacheForAccountIds(accountsToRecalc).catch(
      logger.catchLog("信用卡账单缓存失效失败", "route.ts"),
    );
    if (changedInvestment) revalidateAfterInvestChange();
    else revalidateAfterTxChange();

    // 返回更新后的记录
    const updated = await prisma.txRecord.findUnique({
      where: { id: entryId },
      include: {
        ...entryBusinessLinkSummaryInclude,
        EntryTag: { include: { Tag: true } },
        account: { include: { Institution: { select: { name: true } } } },
        toAccount: { include: { Institution: { select: { name: true } } } },
      },
    });

    if (!updated) {
      return NextResponse.json({ ok: false, error: "更新后记录不存在" }, { status: 404 });
    }
    await saveEntryUndo(prisma, ctx, undo, "edit", "编辑明细");

    return NextResponse.json({
      ok: true,
      data: {
        id: updated.id,
        date: formatDateLocal(updated.date),
        postedAt: toDateOnlyLocal(updated.postedAt),
        dayOrder: updated.dayOrder,
        amount: toNumber(updated.amount),
        type: updated.type,
        categoryId: updated.categoryId,
        categoryName: updated.categoryName,
        accountId: updated.accountId,
        accountName: updated.accountName,
        accountKind: updated.account?.kind ?? null,
        accountDebtDirection: updated.account?.debtDirection ?? null,
        accountIsSettlementDebt: isSettlementDebtAccountForDetail(updated.account),
        accountInstitutionName: updated.account?.Institution?.name ?? "",
        counterpartyInstitutionId: updated.counterpartyInstitutionId ?? null,
        counterpartyInstitutionName: updated.counterpartyInstitutionName ?? null,
        toAccountId: updated.toAccountId,
        toAccountName: updated.toAccountName,
        toAccountKind: updated.toAccount?.kind ?? null,
        toAccountDebtDirection: updated.toAccount?.debtDirection ?? null,
        toAccountIsSettlementDebt: isSettlementDebtAccountForDetail(updated.toAccount),
        toAccountInstitutionName: updated.toAccount?.Institution?.name ?? "",
        note: updated.note,
        fundSubtype: updated.fundSubtype,
        fundCode: updated.fundCode,
        fundName: updated.fundName,
        wealthProductId: updated.wealthProductId ?? null,
        insuranceProductId: updated.insuranceProductId ?? null,
        fundProductType: updated.fundProductType,
        metalTypeId: updated.metalTypeId ?? null,
        metalTypeName: updated.metalTypeName ?? null,
        metalUnitId: updated.metalUnitId ?? null,
        metalUnitName: updated.metalUnitName ?? null,
        metalQuantity: updated.metalQuantity ? toNumber(updated.metalQuantity) : null,
        metalUnitPrice: updated.metalUnitPrice ? toNumber(updated.metalUnitPrice) : null,
        metalFee: updated.metalFee ? toNumber(updated.metalFee) : null,
        fundNav: updated.fundNav ? toNumber(updated.fundNav) : null,
        depositAnnualRate: updated.depositAnnualRate ? toNumber(updated.depositAnnualRate) : null,
        depositInterest: updated.depositInterest ? toNumber(updated.depositInterest) : null,
        depositSourceEntryId: updated.depositSourceEntryId ?? null,
        fundUnits: updated.fundUnits ? toNumber(updated.fundUnits) : null,
        fundFee: updated.fundFee ? toNumber(updated.fundFee) : null,
        fundConfirmDate: updated.fundConfirmDate ? formatDateLocal(updated.fundConfirmDate) : null,
        fundArrivalDate: updated.fundArrivalDate ? formatDateLocal(updated.fundArrivalDate) : null,
        fundArrivalAmount: updated.fundArrivalAmount ? toNumber(updated.fundArrivalAmount) : null,
        source: updated.source,
        ...buildEntryBusinessLinkSummary(updated),
        entryTags: mapEntryTags(updated),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "更新失败";
    console.error("PUT /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/* ────────────────── DELETE ────────────────── */

/**
 * DELETE /api/v1/transactions/detail?id=xxx
 *
 * 软删除一条交易记录
 *
 * 返回: { ok: true } | { ok: false, error }
 */
export async function DELETE(req: Request) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const url = new URL(req.url);
    const id = (url.searchParams.get("id") ?? "").trim();

    if (!id) {
      return NextResponse.json({ ok: false, error: "缺少 id" }, { status: 400 });
    }

    const { householdId } = ctx;

    // Find the record first
    const txRecord = await prisma.txRecord.findUnique({ where: { id } });

    if (!txRecord) {
      return NextResponse.json({ ok: false, error: `记录不存在 (id: ${id})` }, { status: 404 });
    }

    // Verify household
    if (txRecord.householdId && txRecord.householdId !== householdId) {
      return NextResponse.json({ ok: false, error: "记录不属于当前账簿" }, { status: 403 });
    }
    const undo = await prepareEntryUndo(prisma, householdId, [id]);

    // Soft delete
    await prisma.txRecord.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // Recalculate balances for affected accounts
    const accountsToRecalc = new Set<string>();
    if (txRecord.accountId) accountsToRecalc.add(txRecord.accountId);
    if (txRecord.toAccountId) accountsToRecalc.add(txRecord.toAccountId);

    // If fund transaction, recalc positions too
    if (txRecord.fundCode && txRecord.fundProductType) {
      const isRedeemLike = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
      const investmentAccId = isRedeemLike ? txRecord.accountId : txRecord.toAccountId;
      if (investmentAccId) {
        await recalcFundPositions(investmentAccId, [txRecord.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));
      }
    }

    for (const acctId of accountsToRecalc) {
      await recalcAndSaveAccountBalance(acctId).catch(logger.catchLog("操作失败", "route.ts"));
    }

    if (txRecord.type === TransactionType.investment || txRecord.fundProductType) {
      revalidateAfterInvestChange();
    } else {
      revalidateAfterTxChange();
    }

    await saveEntryUndo(prisma, ctx, undo, "delete", "删除明细");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "删除失败";
    console.error("DELETE /api/v1/transactions/detail error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
