import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind, CreditCardInstallmentSourceType, FundCashFlowKind, TransactionType, FundSubtype, RegularInvestStatus } from "@prisma/client";
import { institutionTypeLabel, kindLabel } from "@/lib/account-kinds";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { StockTransactionFormModal } from "@/components/StockTransactionFormModal";
import { StockHoldingsPanel } from "@/components/StockHoldingsPanel";
import { PropertyFormModal } from "@/components/PropertyFormModal";
import { PropertyShell } from "@/components/PropertyShell";
import { WealthFormModal } from "@/components/WealthFormModal";
import { DepositFormModal } from "@/components/DepositFormModal";
import { InsuranceFormModal } from "@/components/InsuranceFormModal";
import { InsuranceEntryEditBridge } from "@/components/InsuranceEntryEditBridge";
import { DebtShell } from "@/components/DebtShell";
import { DebtTransactionModal } from "@/components/DebtTransactionModal";
import { FundShell } from "@/components/FundShell";
import { DepositShell } from "@/components/DepositShell";
import { InsuranceShell } from "@/components/InsuranceShell";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { DashboardOverview } from "@/components/DashboardOverview";
import { UnifiedEntryLauncher } from "@/components/UnifiedEntryLauncher";
import type { DetailEntry } from "@/components/DetailViewClient";
import { BasicDetailPanel } from "@/components/BasicDetailPanel";
import { CreditBillSummaryTable } from "@/components/CreditBillSummaryTable";
import { CreditBillDetailPanel } from "@/components/CreditBillDetailPanel";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";


import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { calculateWealthCashDividendProfit, recalcWealthPositions } from "@/lib/wealth-position";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import {
  applyDebtRowEntryMetrics,
  buildDebtDetailEntriesViewData,
  buildDebtRepaymentScheduleRows,
  buildDebtRowsViewData,
} from "@/lib/server/debt-view-data";
import { loadCreditBillPageData } from "@/lib/server/credit-bill-page-data";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { getFundArrivalDays, getFundConfirmDays, setFundConfirmDays, setFundArrivalDays } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDate } from "@/lib/fund/feeRate";
import { formatCurrencyMoney, formatMoney } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { LiveAccountBalance } from "@/components/LiveAccountBalance";
import { AccountFxRateInline } from "@/components/AccountFxRateInline";
import { createFundTransactionWithCashFlows, findFundTransactionForEntryId, syncFundTransactionsFromTxRecords, upsertFundTransactionRefundCashFlow, type FundCashFlowInput } from "@/lib/fund/transactions";
import { regularInvestRefundNote } from "@/lib/fund/regular-invest-display";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { getCachedHouseholdScope, getHouseholdScope } from "@/lib/server/household-scope";
import { attachEntryTags, replaceEntryTags } from "@/lib/server/entry-tags";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude, upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import {
  loadDepositTransactionDetailLike,
  loadInsuranceTransactionDetailLike,
  loadWealthTransactionEntryLike,
} from "@/lib/server/business-transaction-entries";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { insuranceCashValueDelta } from "@/lib/insurance/transaction";
import { loadCommonData, loadSelectedAccount, loadEntriesForAccount, loadInvestAccountData } from "@/lib/server/cached-data";
import { computeInvestBalances, computePositionDisplay } from "@/lib/invest-balance";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
  buildAccountDisplayOption,
  buildFlatAccountOptions,
  normalizeCreditCardLabelTemplate,
} from "@/lib/account-display";
import { getInvestmentAccountView, isDepositAccount, isPureInvestmentAccount, isSpecialCashTargetAccount } from "@/lib/account-kind-utils";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { resolveOrCreateDepositAccount } from "@/lib/server/deposit-account";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import { resolveOrCreateAdvanceAccount } from "@/lib/server/advance-account";
import { createCreditCardInstallmentPlan } from "@/lib/server/credit-card-installment";
import { regularInvestFormAction } from "@/lib/server/sidebar-actions/regular-invest-actions";
import { fillFundNavFromCache } from "@/lib/server/sidebar-actions/fund-actions";
import { createDebtTransaction } from "@/lib/server/sidebar-actions/debt-actions";
import {
  listLoanRateAdjustmentsByAccountIds,
} from "@/lib/server/loan-rate-adjustments";
import { getInsuranceDisplayTypeLabel, getInsuranceMetricLabel, getInsuranceMetricMode } from "@/lib/insurance/display";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, applyBalanceReconcileEntry, effectiveAmountForAccount, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { isCreditCardRepaymentTransfer, statementMonthForTransfer } from "@/lib/transaction-semantics";
import { ensureSettlementTransferCategory, resolveCategorySnapshot, resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { buildWealthCashFlowNote } from "@/lib/wealth-cash-note";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { resolveAdvanceTransfer } from "@/lib/advance-transfer";
import { findRecentManualTransactionDuplicate } from "@/lib/server/transaction-dedupe";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import {
  decodeDetailPaginationPreference,
  detailPaginationCookieName,
  normalizeDetailPage,
  normalizeDetailPageSize,
} from "@/lib/detail-pagination-preference";
import type { CreditCardInstallmentRateType } from "@/lib/credit/installment";
import { getServerT } from "@/lib/server/i18n";

export const dynamic = "force-dynamic";

import { formatDateLocal, formatDateUtc, toStatementMonth, toNumber, addWorkdaysUtc } from "@/lib/date-utils";

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
    fundCode: null,
    fundName: null,
    fundProductType: null,
    fundSubtype: FundSubtype.buy_failed,
    source: "regular_invest_refund",
    fundUnits: null,
    fundNav: null,
    fundFee: null,
    fundConfirmDate: null,
    fundArrivalDate: null,
    fundArrivalAmount: null,
    fundSourceEntryId: params.buyEntryId ?? null,
    regularInvestPlanId: params.regularInvestPlanId ?? null,
    note: regularInvestRefundNote(
      params.fundCode,
      params.fundName,
      refundAmount,
      params.buyDate,
      params.currency ?? "CNY",
      params.note,
    ),
    deletedAt: null,
  };

  const existing = directMatch ?? fallbackMatch ?? dateFallbackMatch;
  if (existing) {
    return tx.txRecord.update({
      where: { id: existing.id },
      data: refundRecordData,
    });
  }
  return tx.txRecord.create({
    data: {
      ...refundRecordData,
      type: TransactionType.investment,
      householdId: params.householdId,
    },
  });
}

function formatType(t: (key: string, params?: Record<string, string | number>) => string, type: string) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "advance") return t("txForm.advance");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return type;
}

function parseMortgageLprDiscountFromText(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/LPR\s*折扣\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return null;
  const discount = Number(match[1]);
  return Number.isFinite(discount) && discount > 0 ? discount : null;
}


import { subtypeDisplay } from "@/lib/investment-config";

type DetailFilterColumn = "date" | "flow" | "type" | "category" | "related" | "remark";

const DETAIL_FILTER_SEPARATOR = "\u001F";

function parseDetailFilterParam(value: string | undefined) {
  if (!value) return [];
  return value.split(DETAIL_FILTER_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

function fundSubtypeInfo(
  t: (key: string, params?: Record<string, string | number>) => string,
  subtype: string | null | undefined,
  source: string | null | undefined,
  _amount: number,
  fundProductType?: string | null,
) {
  const base = subtypeDisplay(subtype, source);
  if (fundProductType === "deposit") {
    if (subtype === "buy") return { label: t("deposit.subtype.buy"), cls: "bg-blue-50 text-blue-600" };
    if (subtype === "redeem") return { label: t("deposit.subtype.redeem"), cls: "bg-orange-50 text-orange-600" };
  }
  // Source-based overrides for the buy subtype (auto-invest / dividend reinvest / switch in).
  if (subtype === "buy" && source) {
    const srcLabels: Record<string, { label: string; cls: string; textCls?: string }> = {
      regular_invest: { label: t("fund.subtype.regular_invest"), cls: "bg-blue-50 text-blue-600" },
      dividend: { label: t("fund.subtype.dividend"), cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
      switch: { label: t("fund.subtype.switch"), cls: "bg-blue-50 text-blue-600" },
    };
    return srcLabels[source] ?? base;
  }
  return base;
}

const ymdUtc = formatDateUtc;

function mdUtcDots(d: Date) {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}.${day}`;
}

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toDateOnlyLocalOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? formatDateLocal(date) : null;
}

function toYmdOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? ymdUtc(date) : null;
}

function buildCategoryPathLabels(categories: Array<{ id: string; name: string; type: string; parentId: string | null }>) {
  const labelById = new Map<string, string>();
  for (const c of categories) {
    labelById.set(c.id, c.name);
  }
  return labelById;
}

function buildCategoryExportLabels(
  t: (key: string, params?: Record<string, string | number>) => string,
  categories: Array<{ id: string; name: string; type: string; parentId: string | null }>,
) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map<string, string[]>();
  // Root category names are user data stored in the DB; keep the Chinese names for matching.
  const rootLabels = new Set(["支出", "收入", "转账", "代付", "投资"]);

  function pathNames(id: string): string[] {
    const cached = memo.get(id);
    if (cached) return cached;
    const c = byId.get(id);
    if (!c) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    let cur: typeof c | undefined = c;
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      names.push(cur.name);
      if (!cur.parentId) break;
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      if (parent.type !== cur.type) break;
      cur = parent;
    }
    names.reverse();
    memo.set(id, names);
    return names;
  }

  const labelById = new Map<string, string>();
  for (const c of categories) {
    const names = pathNames(c.id);
    const exportNames = [...names];
    if (exportNames[0] === formatType(t, c.type) || rootLabels.has(exportNames[0] ?? "")) {
      exportNames.shift();
    }
    labelById.set(c.id, exportNames.join("."));
  }
  return labelById;
}

type ExportAccountLike = {
  name?: string | null;
  kind?: string | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { name?: string | null } | null;
} | null | undefined;

function exportAccountLabel(account: ExportAccountLike, fallbackName?: string | null) {
  const owner = account?.kind === "loan" ? "" : account?.AccountGroup?.name?.trim() || "";
  const institution = account?.Institution?.shortName?.trim() || account?.Institution?.name?.trim() || "";
  const accountName = account?.name?.trim() || fallbackName?.trim() || "";
  const tailOrName = account?.numberMasked?.trim() || accountName;
  const accountType = account?.kind ? kindLabel(account.kind) : "";
  return [owner, institution, tailOrName, accountType].filter(Boolean).join("·");
}

function stripExportCategoryRootLabel(value?: string | null) {
  const text = value?.trim() ?? "";
  return ["支出", "收入", "转账", "代付", "投资"].includes(text) ? "" : text;
}

function parseMoneyInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return n;
}

async function assertWealthUnitsWhenRequiredInTx(
  t: (key: string, params?: Record<string, string | number>) => string,
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
    throw new Error(t("sidebar.action.wealthUnitsRequired"));
  }
}

function parseOptionalDateTimeInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function createSplitWealthTransaction(
  t: (key: string, params?: Record<string, string | number>) => string,
  formData: FormData,
  householdId: string,
) {
  const dateStr = String(formData.get("date") ?? "").trim();
  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const subtypeInput = String(formData.get("subtype") ?? "buy").trim();
  const validSubtypes = Object.values(FundSubtype);
  const subtype: FundSubtype = validSubtypes.includes(subtypeInput as FundSubtype) ? (subtypeInput as FundSubtype) : FundSubtype.buy;
  const isRedeem = subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out;
  const isDividend = subtype === FundSubtype.dividend_cash;
  const amountAbs = Math.abs(parseMoneyInput(formData.get("amount") ?? null));
  if (!amountAbs) throw new Error(t("txForm.alert.invalidAmount"));

  const requestedWealthAccountId = String(formData.get("accountId") ?? formData.get("toAccountId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const productNameInput = String(formData.get("fundName") ?? "").trim();
  const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
  const note = String(formData.get("note") ?? formData.get("memo") ?? "").trim();
  const unitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const navRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const annualRateRaw = parseFloat(String(formData.get("depositAnnualRate") ?? ""));
  const interestRaw = parseFloat(String(formData.get("depositInterest") ?? ""));
  const feeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
  const arrivalAmountRaw = parseMoneyInput(formData.get("fundArrivalAmount") ?? null);
  const arrivalDate = dateFromYmd(String(formData.get("fundArrivalDate") ?? "").trim()) ?? (isRedeem || isDividend ? date : null);
  const units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : null;
  const nav = Number.isFinite(navRaw) && navRaw > 0 ? navRaw : null;
  const annualRate = Number.isFinite(annualRateRaw) && annualRateRaw > 0 ? annualRateRaw : null;
  const fee = Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : null;
  const interest = Number.isFinite(interestRaw)
    ? interestRaw
    : isDividend
      ? amountAbs
      : null;
  const principalAmount = isRedeem && units && nav ? Number((units * nav).toFixed(2)) : amountAbs;
  const grossAmount = (isRedeem || isDividend) && !isDividend ? principalAmount : amountAbs;
  const arrivalAmount = isDividend
    ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : amountAbs)
    : isRedeem
      ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : Number(Math.max(0, principalAmount + (interest ?? 0) - Math.max(0, fee ?? 0)).toFixed(2)))
      : null;

  let touchedAccountIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const cashAcc = await tx.account.findUnique({
      where: { id: cashAccountId },
      select: { id: true, name: true, currency: true },
    });
    if (!cashAcc) throw new Error(isRedeem || isDividend ? t("sidebar.action.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount"));

    const wealthAcc = isRedeem || isDividend
      ? await tx.account.findUnique({
          where: { id: requestedWealthAccountId },
          select: { id: true, name: true, institutionId: true, currency: true },
        })
      : await resolveOrCreateWealthAccount(tx, {
          householdId,
          cashAccountId: cashAcc.id,
          requestedAccountId: requestedWealthAccountId || null,
        });
    if (!wealthAcc) throw new Error(t("sidebar.action.selectWealthAccount"));

    const wealthProduct = wealthProductIdInput
      ? await tx.wealthProduct.findFirst({
          where: { id: wealthProductIdInput, householdId, institutionId: wealthAcc.institutionId, isActive: true },
        })
      : productNameInput
        ? await tx.wealthProduct.findFirst({
            where: { householdId, institutionId: wealthAcc.institutionId ?? null, name: productNameInput, isActive: true },
          }) ?? await tx.wealthProduct.create({
            data: {
              householdId,
              institutionId: wealthAcc.institutionId ?? null,
              name: productNameInput,
              currency: wealthAcc.currency ?? cashAcc.currency ?? "CNY",
              annualRate: annualRate ?? undefined,
            },
          })
        : null;
    if (!wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));
    if (!isRedeem && !isDividend) {
      await assertWealthUnitsWhenRequiredInTx(t, tx, {
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
    const signedCashAmount = isRedeem || isDividend ? Math.abs(arrivalAmount ?? amountAbs) : -amountAbs;
    const cashNote = buildWealthCashFlowNote({
      action: subtype,
      productName: wealthProduct.name,
      units,
      userNote: note,
    });
    const cashEntry = await tx.txRecord.create({
      data: {
        householdId,
        date: isRedeem || isDividend ? (arrivalDate ?? date) : date,
        type: TransactionType.investment,
        accountId: isRedeem || isDividend ? wealthAcc.id : cashAcc.id,
        accountName: isRedeem || isDividend ? wealthAcc.name : cashAcc.name,
        toAccountId: isRedeem || isDividend ? cashAcc.id : wealthAcc.id,
        toAccountName: isRedeem || isDividend ? cashAcc.name : wealthAcc.name,
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
        realizedProfit: isDividend
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : isRedeem
            ? (interest ?? 0) - Math.max(0, fee ?? 0)
            : null,
        note: note || null,
      },
    });

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
    touchedAccountIds = Array.from(new Set([cashAcc.id, wealthAcc.id].filter(Boolean)));
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(() => {});
  }
  for (const id of touchedAccountIds) {
    await recalcAndSaveAccountBalance(id).catch(() => {});
  }
  await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
  revalidateAfterInvestChange();
}

async function createTransaction(formData: FormData) {
  "use server";
  const t = await getServerT();
  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const postedAtInput = parseOptionalDateTimeInput(formData.get("postedAt"));
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = Math.abs(amountRaw);
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();
  const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);
  const createInstallment = formData.get("createInstallment") === "true";
  const installmentAmount = parseMoneyInput(formData.get("installmentAmount"));
  const installmentTotal = Number.parseInt(String(formData.get("installmentTotal") ?? "0"), 10);
  const installmentRate = Number(String(formData.get("installmentRate") ?? "0"));
  const installmentRateType = String(formData.get("installmentRateType") ?? "period_fee") as CreditCardInstallmentRateType;

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const postedAt = type === "expense" || type === "income" ? (postedAtInput ?? date) : null;
  const { householdId } = await getHouseholdScope();

  if (!amountAbs) {
    return { ok: false as const, error: t("txForm.alert.invalidAmount") };
  }

  try {
    if (type === "transfer") {
      const formFromAccountId = String(formData.get("fromAccountId") ?? "").trim();
      const formToAccountId = String(formData.get("toAccountId") ?? "").trim();
      if (!formFromAccountId || !formToAccountId) return { ok: false as const, error: t("sidebar.action.transferAccountsRequired") };
      if (formFromAccountId === formToAccountId) return { ok: false as const, error: t("sidebar.action.transferAccountsSame") };
      const fromAccountId = amountRaw < 0 ? formToAccountId : formFromAccountId;
      const toAccountId = amountRaw < 0 ? formFromAccountId : formToAccountId;

      await prisma.$transaction(async (tx) => {
        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId }, include: { Institution: true } }),
          tx.account.findUnique({ where: { id: toAccountId }, include: { Institution: true } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error(t("sidebar.action.accountNotFound"));
        const counterpartyInstitution = counterpartyInstitutionId
          ? await tx.institution.findUnique({ where: { id: counterpartyInstitutionId } })
          : null;
        const isDebtTransfer = fromAcc.kind === AccountKind.loan || toAcc.kind === AccountKind.loan;
        if (fromAcc.kind === AccountKind.loan && toAcc.kind === AccountKind.loan) {
          throw new Error(t("sidebar.action.settlementTransferNotAllowed"));
        }
        if (!isDebtTransfer && (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc))) {
          throw new Error(t("sidebar.action.specialTargetTransferNotAllowed"));
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
        const duplicate = await findRecentManualTransactionDuplicate(tx, {
          householdId,
          type: TransactionType.transfer,
          date,
          accountId: fromAcc.id,
          toAccountId: toAcc.id,
          amount: signedTransferAmount,
          categoryId: transferCategory?.id ?? null,
          note,
          source: debtMode ? `debt_${debtMode}` : "manual",
        });
        if (duplicate) return;

        const created = await tx.txRecord.create({
          data: {accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: signedTransferAmount,
            type: TransactionType.transfer,
            date,
            categoryId: transferCategory?.id ?? null,
            categoryName: transferCategory?.name ?? null,
            counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
            counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            statementMonth: transferStatementMonth,
            source: debtMode ? `debt_${debtMode}` : "manual",
            debtPrincipalAmount: debtMode ? amountAbs : null,
            debtInterestAmount: debtMode ? 0 : null,
            debtFeeAmount: debtMode ? 0 : null,
            ...{ householdId },
          },
        });
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      await recalcAndSaveAccountBalance(fromAccountId).catch(() => {});
      await recalcAndSaveAccountBalance(toAccountId).catch(() => {});
    } else if (type === "expense") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error(t("sidebar.action.accountNotFound"));
        if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.investmentNoIncomeExpense"));
        if (createInstallment && acc.kind !== AccountKind.bank_credit) throw new Error(t("sidebar.action.installmentCreditCardOnly"));
        if (createInstallment && (installmentAmount <= 0 || installmentAmount > amountAbs)) {
          throw new Error(t("sidebar.action.installmentAmountInvalid"));
        }
        if (createInstallment && installmentRateType !== "annual_interest" && installmentRateType !== "period_fee") {
          throw new Error(t("sidebar.action.installmentRateTypeInvalid"));
        }

        const statementMonth =
          (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;
        const duplicate = createInstallment
          ? null
          : await findRecentManualTransactionDuplicate(tx, {
              householdId,
              type: TransactionType.expense,
              date,
              accountId: acc.id,
              amount: amountRaw,
              categoryId: cat?.id ?? null,
              note,
            });
        if (duplicate) return;

        const created = await tx.txRecord.create({
          data: {accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: amountRaw,
            type: TransactionType.expense,
            date,
            postedAt,
            note: note || null,
            statementMonth,
            ...{ householdId },
          },
        });
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });

        if (createInstallment) {
          if (!statementMonth) throw new Error(t("sidebar.action.creditCardMissingBillingDay"));
          await createCreditCardInstallmentPlan(tx, {
            householdId,
            account: { id: acc.id, name: acc.name },
            sourceType: CreditCardInstallmentSourceType.transaction,
            sourceEntryId: created.id,
            originalAmount: amountAbs,
            principal: installmentAmount,
            totalRuns: installmentTotal,
            rateType: installmentRateType,
            rate: installmentRate,
            adjustmentDate: date,
            adjustmentStatementMonth: statementMonth,
            billingDay: acc.billingDay ?? 1,
            firstPaymentDate: date,
            firstPaymentStatementMonth: statementMonth,
            category: cat ? { id: cat.id, name: cat.name } : null,
            label: note || cat?.name || t("creditBill.creditCardExpense"),
            tagIds,
          });
        }
      });

      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    } else if (type === "advance") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
      if (!accountId) return { ok: false as const, error: t("investForm.selectCashAccount") };
      if (!counterpartyInstitutionId) return { ok: false as const, error: t("debtTx.placeholder.selectCounterparty") };

      let advanceAccountId = "";
      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error(t("sidebar.action.accountNotFound"));
        if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.advanceNoIncomeExpense"));
        const resolvedAdvance = await resolveOrCreateAdvanceAccount(tx, {
          householdId,
          cashAccountId: acc.id,
          debtObjectId: counterpartyInstitutionId,
        });
        const advanceAccount = resolvedAdvance.account;
        if (advanceAccount.id === acc.id) throw new Error(t("sidebar.action.cashAccountSameAsSettlement"));
        advanceAccountId = advanceAccount.id;
        const transfer = resolveAdvanceTransfer({ amount: amountRaw, cashAccount: acc, advanceAccount });
        const statementMonth = statementMonthForTransfer(date, transfer.fromAccount, transfer.toAccount);

        const created = await tx.txRecord.create({
          data: {
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
            toNote: null,
            householdId,
          },
        });
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      await recalcAndSaveAccountBalance(accountId).catch(() => {});
      if (advanceAccountId) await recalcAndSaveAccountBalance(advanceAccountId).catch(() => {});
    } else if (type === "income") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();

      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          accountId ? tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }) : Promise.resolve(null),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);

        const statementMonth =
          acc && (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;
        if (acc) {
          const duplicate = await findRecentManualTransactionDuplicate(tx, {
            householdId,
            type: TransactionType.income,
            date,
            accountId: acc.id,
            amount: amountRaw,
            categoryId: cat?.id ?? null,
            note,
          });
          if (duplicate) return;
        }

        const created = await tx.txRecord.create({
          data: { accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? t("common.unknownAccount"),
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            amount: amountRaw,
            type: TransactionType.income,
            date,
            note: note || undefined,
            statementMonth: statementMonth ?? undefined,
            ...{ householdId },
          } as any,
        });
        await attachEntryTags({ tx, entryId: created.id, householdId, tagIds });
      });

      if (accountId) await recalcAndSaveAccountBalance(accountId).catch(() => {});
    } else if (type === "investment") {
      if (String(formData.get("fundProductType") ?? "").trim() === "wealth") {
        await createSplitWealthTransaction(t, formData, householdId);
        return { ok: true as const };
      }
      let createdInvestmentEntryId: string | null = null;
      let createdFundTransactionId: string | null = null;
      const accountId = String(formData.get("accountId") ?? "").trim();
      const subtype = String(formData.get("subtype") ?? "buy").trim();
      let fundCode = String(formData.get("fundCode") ?? "").trim() || null;
      const fundProductType = String(formData.get("fundProductType") ?? "").trim() || null;
      const metalQuantityRaw = parseFloat(String(formData.get("metalQuantity") ?? formData.get("fundUnits") ?? ""));
      const metalUnitPriceRaw = parseFloat(String(formData.get("metalUnitPrice") ?? formData.get("fundNav") ?? ""));
      const metalFeeRaw = parseFloat(String(formData.get("metalFee") ?? formData.get("fundFee") ?? ""));
      const fundUnitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const fundNavRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const depositAnnualRateRaw = parseFloat(String(formData.get("depositAnnualRate") ?? ""));
  const depositInterestRaw = parseFloat(String(formData.get("depositInterest") ?? ""));
  const fundFeeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
      const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
      const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
      const fundArrivalAmountRaw = parseFloat(String(formData.get("fundArrivalAmount") ?? ""));
      const buyResultStatus = String(formData.get("buyResultStatus") ?? "normal").trim();
      const refundAmountRaw = parseFloat(String(formData.get("refundAmount") ?? ""));
      const refundDateStr = String(formData.get("refundDate") ?? "").trim();
      const depositPrincipalAmountRaw = parseFloat(String(formData.get("depositPrincipalAmount") ?? ""));
      const recordCurrency = String(formData.get("currency") ?? "").trim().toUpperCase() || null;
      const depositSourceEntryId = String(formData.get("depositSourceEntryId") ?? "").trim() || null;
      const cashAccountIdInput = String(formData.get("cashAccountId") ?? "").trim() || null;
      const fundConfirmDate = fundConfirmDateStr ? new Date(fundConfirmDateStr) : null;
      const fundArrivalDate = fundArrivalDateStr ? new Date(fundArrivalDateStr) : null;
      const fundArrivalAmount = Number.isFinite(fundArrivalAmountRaw) && fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null;
      const refundAmount = Number.isFinite(refundAmountRaw) && refundAmountRaw > 0 ? Math.abs(refundAmountRaw) : null;
      const refundDate = refundDateStr ? new Date(`${refundDateStr.slice(0, 10)}T00:00:00.000Z`) : null;
      const depositPrincipalAmount = Number.isFinite(depositPrincipalAmountRaw) && depositPrincipalAmountRaw > 0 ? depositPrincipalAmountRaw : null;
      const fundUnits = Number.isFinite(fundUnitsRaw) && fundUnitsRaw > 0 ? fundUnitsRaw : null;
      const fundNav = Number.isFinite(fundNavRaw) && fundNavRaw > 0 ? fundNavRaw : null;
      const metalQuantity = Number.isFinite(metalQuantityRaw) && metalQuantityRaw > 0 ? metalQuantityRaw : fundUnits;
      const metalUnitPrice = Number.isFinite(metalUnitPriceRaw) && metalUnitPriceRaw > 0 ? metalUnitPriceRaw : fundNav;
      const metalFee = Number.isFinite(metalFeeRaw) && metalFeeRaw > 0 ? metalFeeRaw : null;
      const depositAnnualRate = Number.isFinite(depositAnnualRateRaw) && depositAnnualRateRaw > 0 ? depositAnnualRateRaw : null;
      const depositInterest = Number.isFinite(depositInterestRaw) && depositInterestRaw >= 0 ? depositInterestRaw : null;
      const fundFee = Number.isFinite(fundFeeRaw) && fundFeeRaw > 0 ? fundFeeRaw : null;

      if (!fundCode && note) {
        const codeMatch = note.match(/\b(\d{6})\b/);
        if (codeMatch) fundCode = codeMatch[1];
      }

      const fundNameInput = String(formData.get("fundName") ?? "").trim();
      const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
      const metalTypeIdInput = String(formData.get("metalTypeId") ?? "").trim();
      const metalUnitIdInput = String(formData.get("metalUnitId") ?? "").trim();
      const effectiveAccountId = accountId || (fundProductType === "deposit" ? "__auto_deposit__" : fundProductType === "wealth" ? "__auto_wealth__" : "");
      if (!effectiveAccountId) return { ok: false as const, error: t("investForm.selectAccount") };

      const redeemLike = subtype === "redeem" || subtype === "switch_out";
      const validSubtypes = Object.values(FundSubtype);
      const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;

      const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;
      const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;

      // Map source field: dividend_reinvest → source='dividend', otherwise use form source or 'manual'
      const sourceValue = fundProductType === "deposit"
        ? "deposit"
        : isDividendReinvest
          ? "dividend"
          : (String(formData.get("source") ?? "manual").trim() || "manual");
      // dividend_reinvest → fundSubtype='buy'
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;

      let finalInvestmentAccId = "";
      await prisma.$transaction(async (tx) => {
        // accountId is unified as the investment (fund) account.
        const investAcc =
          fundProductType === "deposit"
            ? await resolveOrCreateDepositAccount(tx, {
                householdId,
                requestedAccountId: accountId || null,
                cashAccountId: cashAccountIdInput,
                fundName: fundNameInput || note || null,
                currency: recordCurrency,
              })
            : fundProductType === "wealth" && finalFundSubtype === FundSubtype.buy
              ? await resolveOrCreateWealthAccount(tx, {
                  householdId,
                  cashAccountId: cashAccountIdInput ?? "",
                  requestedAccountId: accountId || null,
                })
              : await tx.account.findUnique({ where: { id: accountId } });
        if (!investAcc) throw new Error(t("sidebar.action.accountNotFound"));
        if (!isPureInvestmentAccount(investAcc) && !isDepositAccount(investAcc)) throw new Error(t("sidebar.action.selectInvestmentDepositAccount"));
        finalInvestmentAccId = investAcc.id;
        const fundUnitsPrecisionAccount = await tx.account.findUnique({
          where: { id: investAcc.id },
          select: { fundUnitsDecimals: true },
        });
        const fundUnitsDecimals = normalizeFundUnitsDecimals(fundUnitsPrecisionAccount?.fundUnitsDecimals, 3);
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
        if (fundProductType === "metal" && !metalType) throw new Error(t("sidebar.action.selectMetalType"));
        if (fundProductType === "metal" && !metalUnit) throw new Error(t("sidebar.action.selectMetalUnit"));

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
                      currency: recordCurrency ?? investAcc.currency ?? "CNY",
                      annualRate: depositAnnualRate ?? undefined,
                    },
                  })
                : null)
          : null;
        if (fundProductType === "wealth" && !wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));

        const isMetalProduct = fundProductType === "metal";
        const isWealthProduct = fundProductType === "wealth";
        const entryFundCode = isMetalProduct || isWealthProduct ? null : fundCode || null;
        // fundName stores fund/deposit product names; precious metal names come from metalTypeName.
        const entryFundName = isMetalProduct ? null : (wealthProduct?.name || fundNameInput || fundCode || null);


        // Create the TxRecord, including all fund fields directly.
        // Rule: toAccountId = the cash receiving side.
        // buy/dividend_cash: accountId=cash (source), toAccountId=investment (receiver)
        // redeem/switch_out: accountId=investment (source), toAccountId=cash (receiver)
        // dividend_reinvest: accountId=investment (source), toAccountId=investment (receiver)
        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        if (redeemLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAcc?.id ?? investAcc.id;
          recordToAccountName = cashAcc?.name ?? investAcc.name;
          signedAmount = fundArrivalAmount ?? Math.max(0, amountAbs + (depositInterest ?? 0) - (fundFee ?? 0));
        } else if (isDividendReinvest) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        } else if (isDividendCash && cashAcc) {
          // Cash dividend: investment account (source) → cash account (receiver), positive amount (cash inflow).
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAcc.id;
          recordToAccountName = cashAcc.name;
          signedAmount = amountAbs;
        } else {
          recordAccountId = cashAcc?.id ?? investAcc.id;
          recordAccountName = cashAcc?.name ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }
        const entryArrivalAmount =
          fundProductType === "deposit" && !redeemLike && !isDividendCash && !isDividendReinvest
            ? (depositPrincipalAmount ?? amountAbs)
            : fundArrivalAmount;

        const applyDateStr = date.toISOString().slice(0, 10);
        const shouldComputeArrival = finalFundSubtype === FundSubtype.buy && !redeemLike && !isDividendCash && !isDividendReinvest;
        let computedConfirmDate: Date | null = fundConfirmDate;
        let computedArrivalDate: Date | null = fundArrivalDate;

        if (!isMetalProduct && !isWealthProduct && shouldComputeArrival && entryFundCode) {
          const confirmStr = computedConfirmDate
            ? computedConfirmDate.toISOString().slice(0, 10)
            : addWorkdaysUtc(applyDateStr, await getFundConfirmDays(investAcc.id, entryFundCode));
          if (confirmStr < applyDateStr) console.warn(`[createTransaction] confirmDate ${confirmStr} < applyDate ${applyDateStr}`);
          computedConfirmDate = new Date(`${confirmStr}T00:00:00.000Z`);

          if (!computedArrivalDate) {
            const arrivalStr = addWorkdaysUtc(confirmStr, await getFundArrivalDays(investAcc.id, entryFundCode));
            computedArrivalDate = new Date(`${arrivalStr}T00:00:00.000Z`);
          }
        }

        const shouldDirectWriteFund =
          sourceValue !== "insurance" &&
          !isMetalProduct &&
          !isWealthProduct &&
          (!fundProductType || fundProductType === "fund" || fundProductType === "money") &&
          !!entryFundCode;

        if (shouldDirectWriteFund && entryFundCode) {
          const fundCashFlows: FundCashFlowInput[] = [];
          if (cashAcc && cashAcc.id !== investAcc.id && signedAmount !== 0 && !isDividendReinvest) {
            const primaryCashFlowKind =
              finalFundSubtype === FundSubtype.redeem || finalFundSubtype === FundSubtype.switch_out
                ? FundCashFlowKind.redeem_in
                : finalFundSubtype === FundSubtype.dividend_cash
                  ? FundCashFlowKind.dividend_in
                  : FundCashFlowKind.buy_out;
            fundCashFlows.push({
              kind: primaryCashFlowKind,
              date: redeemLike || isDividendCash ? computedArrivalDate ?? date : date,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              amount: signedAmount,
              currency: recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
              source: sourceValue,
              note: note || entryFundName || undefined,
            });
          }

          const effectiveRefundDate = refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date;
          if (
            finalFundSubtype === FundSubtype.buy &&
            buyResultStatus === "refund" &&
            refundAmount &&
            refundAmount > 0 &&
            cashAcc
          ) {
            fundCashFlows.push({
              kind: FundCashFlowKind.refund_in,
              date: effectiveRefundDate,
              accountId: cashAcc.id,
              accountName: cashAcc.name,
              amount: Math.abs(refundAmount),
              currency: recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
              source: "regular_invest_refund",
              note: regularInvestRefundNote(
                entryFundCode,
                entryFundName,
                refundAmount,
                date,
                recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
                note,
              ),
            });
          }

          const createdFund = await createFundTransactionWithCashFlows(tx, {
            householdId,
            fundAccountId: investAcc.id,
            cashAccountId: cashAcc?.id ?? null,
            fundCode: entryFundCode,
            fundName: entryFundName,
            fundProductType,
            fundSubtype: finalFundSubtype,
            source: sourceValue,
            applyDate: date,
            confirmDate: computedConfirmDate,
            arrivalDate: computedArrivalDate,
            grossAmount: amountAbs,
            refundAmount: buyResultStatus === "refund" ? refundAmount ?? 0 : 0,
            arrivalAmount: entryArrivalAmount ?? (redeemLike || isDividendCash ? Math.abs(signedAmount) : null),
            fee: fundFee ?? null,
            nav: fundNav ?? null,
            units: roundedFundUnits ?? null,
            note: note || null,
            cashFlows: fundCashFlows,
          });
          createdFundTransactionId = createdFund.fundTransaction.id;
          createdInvestmentEntryId = createdFund.cashEntry?.id ?? createdFund.fundTransaction.id;
        } else {
          const created = await tx.txRecord.create({
            data: {
              date,
              type: TransactionType.investment,
              accountId: recordAccountId,
              accountName: recordAccountName,
              toAccountId: recordToAccountId,
              toAccountName: recordToAccountName,
              amount: signedAmount,
              currency: recordCurrency ?? (fundProductType === "deposit" ? investAcc.currency : cashAcc?.currency) ?? "CNY",
              fundName: entryFundName,
              wealthProductId: wealthProduct?.id ?? undefined,
              metalTypeId: metalType?.id ?? undefined,
              metalTypeName: metalType?.name ?? undefined,
              metalUnitId: metalUnit?.id ?? undefined,
              metalUnitName: metalUnit ? (metalUnit.symbol ? `${metalUnit.name}(${metalUnit.symbol})` : metalUnit.name) : undefined,
              metalQuantity: isMetalProduct ? (metalQuantity != null ? roundFundUnits(metalQuantity, fundUnitsDecimals) : undefined) : undefined,
              metalUnitPrice: isMetalProduct ? metalUnitPrice ?? undefined : undefined,
              metalFee: isMetalProduct ? metalFee ?? undefined : undefined,
              insuranceAction: sourceValue === "insurance" ? (redeemLike ? "refund" : "premium") : undefined,
              insuranceProductName: sourceValue === "insurance" ? entryFundName : undefined,
              fundProductType: sourceValue === "insurance" ? null : fundProductType as "fund" | "money" | "wealth" | "deposit" | "metal" | null | undefined,
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
              fundArrivalAmount: entryArrivalAmount ?? undefined,
              note: note || undefined,
              ...{ householdId },
            },
          });
          createdInvestmentEntryId = created.id;
          if (
            finalFundSubtype === FundSubtype.buy &&
            sourceValue !== "insurance" &&
            !isMetalProduct &&
            !isWealthProduct &&
            buyResultStatus === "refund" &&
            refundAmount &&
            refundAmount > 0 &&
            cashAcc &&
            entryFundCode
          ) {
            await upsertFundBuyRefundRecord(tx, {
              householdId,
              buyEntryId: created.id,
              buyDate: date,
              refundDate: refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date,
              refundAmount,
              fundAccountId: investAcc.id,
              fundAccountName: investAcc.name,
              cashAccountId: cashAcc.id,
              cashAccountName: cashAcc.name,
              currency: recordCurrency ?? cashAcc.currency ?? investAcc.currency ?? "CNY",
              fundCode: entryFundCode,
              fundName: entryFundName,
              fundProductType,
              fundConfirmDate: computedConfirmDate,
              fundArrivalDate: refundDate ?? computedArrivalDate ?? computedConfirmDate ?? date,
              regularInvestPlanId: created.regularInvestPlanId ?? null,
              note: note || `${t("detailView.buyRefund")} ${entryFundName || entryFundCode}`,
            });
          }
        }
      });
      if (createdInvestmentEntryId && !createdFundTransactionId) {
        if (fundProductType !== "wealth") {
          await syncFundTransactionsFromTxRecords([createdInvestmentEntryId]).catch((e) => {
            console.error("createTransaction sync fund transaction:", e);
          });
        }
        await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: createdInvestmentEntryId }).catch((e) => {
          console.error("createTransaction sync independent business transaction:", e);
        });
      }

      if (sourceValue !== "insurance" && fundProductType === "metal" && finalInvestmentAccId) {
        await recalcPreciousMetalPositions(finalInvestmentAccId).catch(() => {});
      } else if (sourceValue !== "insurance" && fundProductType !== "deposit" && fundProductType !== "wealth" && finalInvestmentAccId) {
        await recalcFundPositions(finalInvestmentAccId, fundCode ? [fundCode] : undefined).catch(() => {});
      }
      const balanceAccountId = finalInvestmentAccId;
      if (balanceAccountId) {
        await recalcAndSaveAccountBalance(balanceAccountId).catch(() => {});
      }
      if (cashAccountIdInput && cashAccountIdInput !== balanceAccountId) {
        await recalcAndSaveAccountBalance(cashAccountIdInput).catch(() => {});
      }
    } else {
      return { ok: false as const, error: t("sidebar.action.invalidType") };
    }

    const touchedAccountIds =
      type === "transfer"
        ? [String(formData.get("fromAccountId") ?? "").trim(), String(formData.get("toAccountId") ?? "").trim()]
        : type === "investment"
          ? [String(formData.get("accountId") ?? "").trim(), String(formData.get("cashAccountId") ?? "").trim()]
          : [String(formData.get("accountId") ?? "").trim()];
    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
    if (type === "investment") revalidateAfterInvestChange();
    else revalidateAfterTxChange();
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : t("txForm.alert.saveFailed");
    return { ok: false as const, error: msg };
  }
}

async function editSplitWealthTransaction(
  t: (key: string, params?: Record<string, string | number>) => string,
  formData: FormData,
  householdId: string,
) {
  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) throw new Error(t("sidebar.action.missingParams"));
  const businessTransactionId = String(formData.get("businessTransactionId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  if (!dateStr) throw new Error(t("sidebar.action.applyDateRequired"));
  const date = new Date(dateStr);
  const subtypeInput = String(formData.get("subtype") ?? "buy").trim();
  const validSubtypes = Object.values(FundSubtype);
  const subtype: FundSubtype = validSubtypes.includes(subtypeInput as FundSubtype) ? (subtypeInput as FundSubtype) : FundSubtype.buy;
  const isRedeem = subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out;
  const isDividend = subtype === FundSubtype.dividend_cash;
  const amountAbs = Math.abs(parseMoneyInput(formData.get("amount") ?? null));
  if (!amountAbs) throw new Error(t("txForm.alert.invalidAmount"));

  const requestedWealthAccountId = String(formData.get("toAccountId") ?? formData.get("accountId") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const productNameInput = String(formData.get("fundName") ?? "").trim();
  const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
  const note = String(formData.get("memo") ?? formData.get("note") ?? "").trim();
  const unitsRaw = parseFloat(String(formData.get("fundUnits") ?? ""));
  const navRaw = parseFloat(String(formData.get("fundNav") ?? ""));
  const annualRateRaw = parseFloat(String(formData.get("depositAnnualRate") ?? ""));
  const interestRaw = parseFloat(String(formData.get("depositInterest") ?? ""));
  const feeRaw = parseFloat(String(formData.get("fundFee") ?? ""));
  const arrivalAmountRaw = parseMoneyInput(formData.get("fundArrivalAmount") ?? null);
  const arrivalDate = dateFromYmd(String(formData.get("fundArrivalDate") ?? "").trim()) ?? (isRedeem || isDividend ? date : null);
  const units = Number.isFinite(unitsRaw) && unitsRaw > 0 ? unitsRaw : null;
  const nav = Number.isFinite(navRaw) && navRaw > 0 ? navRaw : null;
  const annualRate = Number.isFinite(annualRateRaw) && annualRateRaw > 0 ? annualRateRaw : null;
  const fee = Number.isFinite(feeRaw) && feeRaw >= 0 ? feeRaw : null;
  const interest = Number.isFinite(interestRaw)
    ? interestRaw
    : isDividend
      ? amountAbs
      : null;
  const principalAmount = isRedeem && units && nav ? Number((units * nav).toFixed(2)) : amountAbs;
  const grossAmount = (isRedeem || isDividend) && !isDividend ? principalAmount : amountAbs;
  const arrivalAmount = isDividend
    ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : amountAbs)
    : isRedeem
      ? (arrivalAmountRaw > 0 ? Math.abs(arrivalAmountRaw) : Number(Math.max(0, principalAmount + (interest ?? 0) - Math.max(0, fee ?? 0)).toFixed(2)))
      : null;

  const touchedAccountIds = new Set<string>();
  await prisma.$transaction(async (tx) => {
    const link = await tx.entryBusinessLink.findFirst({
      where: {
        householdId,
        businessType: "wealth",
        deletedAt: null,
        OR: [
          { cashEntryId: entryId },
          ...(businessTransactionId ? [{ wealthTransactionId: businessTransactionId }] : []),
          { wealthTransactionId: entryId },
          { businessEntryId: entryId },
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
        : await tx.wealthTransaction.findFirst({
            where: { householdId, OR: [{ id: entryId }, { cashEntryId: entryId }] },
          });
    }
    if (!wealthRow) {
      const legacy = await tx.txRecord.findFirst({
        where: { id: entryId, householdId, deletedAt: null, type: TransactionType.investment, fundProductType: "wealth" },
      });
      if (!legacy) throw new Error(t("sidebar.action.wealthRecordNotFound"));
      await syncIndependentBusinessTransactionFromTxRecord(tx, { businessEntryId: legacy.id });
      wealthRow = await tx.wealthTransaction.findFirst({
        where: { householdId, OR: [{ id: legacy.id }, { cashEntryId: legacy.id }] },
      });
    }
    if (!wealthRow) throw new Error(t("sidebar.action.wealthRecordNotFound"));

    const oldCashEntry = wealthRow.cashEntryId
      ? await tx.txRecord.findUnique({ where: { id: wealthRow.cashEntryId } })
      : null;
    if (oldCashEntry) {
      touchedAccountIds.add(oldCashEntry.accountId);
      if (oldCashEntry.toAccountId) touchedAccountIds.add(oldCashEntry.toAccountId);
    }
    touchedAccountIds.add(wealthRow.accountId);
    if (wealthRow.cashAccountId) touchedAccountIds.add(wealthRow.cashAccountId);

    const fallbackCashAccountId =
      cashAccountId ||
      wealthRow.cashAccountId ||
      (isRedeem || isDividend ? oldCashEntry?.toAccountId : oldCashEntry?.accountId) ||
      "";
    const cashAcc = await tx.account.findUnique({
      where: { id: fallbackCashAccountId },
      select: { id: true, name: true, currency: true },
    });
    if (!cashAcc) throw new Error(isRedeem || isDividend ? t("sidebar.action.selectArrivalAccount") : t("txForm.alert.selectCashSourceAccount"));
    const wealthAcc = await tx.account.findUnique({
      where: { id: requestedWealthAccountId || wealthRow.accountId },
      select: { id: true, name: true, institutionId: true, currency: true },
    });
    if (!wealthAcc) throw new Error(t("sidebar.action.selectWealthAccount"));

    const resolvedWealthProductId = wealthProductIdInput || wealthRow.wealthProductId || "";
    const resolvedProductNameInput = productNameInput || wealthRow.productName || "";
    const wealthProduct = resolvedWealthProductId
      ? await tx.wealthProduct.findFirst({
          where: { id: resolvedWealthProductId, householdId, institutionId: wealthAcc.institutionId, isActive: true },
        })
      : resolvedProductNameInput
        ? await tx.wealthProduct.findFirst({
            where: { householdId, institutionId: wealthAcc.institutionId ?? null, name: resolvedProductNameInput, isActive: true },
          }) ?? await tx.wealthProduct.create({
            data: {
              householdId,
              institutionId: wealthAcc.institutionId ?? null,
              name: resolvedProductNameInput,
              currency: wealthAcc.currency ?? cashAcc.currency ?? "CNY",
              annualRate: annualRate ?? undefined,
            },
          })
        : null;
    if (!wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));
    if (!isRedeem && !isDividend) {
      await assertWealthUnitsWhenRequiredInTx(t, tx, {
        householdId,
        accountId: wealthAcc.id,
        wealthProductId: wealthProduct.id,
        productName: wealthProduct.name,
        units,
      });
    }

    const signedCashAmount = isRedeem || isDividend ? Math.abs(arrivalAmount ?? amountAbs) : -amountAbs;
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
      date: isRedeem || isDividend ? (arrivalDate ?? date) : date,
      type: TransactionType.investment,
      accountId: isRedeem || isDividend ? wealthAcc.id : cashAcc.id,
      accountName: isRedeem || isDividend ? wealthAcc.name : cashAcc.name,
      toAccountId: isRedeem || isDividend ? cashAcc.id : wealthAcc.id,
      toAccountName: isRedeem || isDividend ? cashAcc.name : wealthAcc.name,
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
        realizedProfit: isDividend
          ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount })
          : isRedeem
            ? (interest ?? 0) - Math.max(0, fee ?? 0)
            : null,
        note: note || null,
        deletedAt: null,
      },
    });

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
  });

  for (const id of touchedAccountIds) {
    await recalcWealthPositions(id).catch(() => {});
  }
  for (const id of touchedAccountIds) {
    await recalcAndSaveAccountBalance(id).catch(() => {});
  }
  await invalidateCreditCardCycleCacheForAccountIds(Array.from(touchedAccountIds)).catch(() => {});
  revalidateAfterInvestChange();
}

async function editInvestment(formData: FormData) {
  "use server";
  const t = await getServerT();
  const { householdId } = await getHouseholdScope();
  const entryId = String(formData.get("entryId") ?? "").trim();
  const subtype = String(formData.get("subtype") ?? "buy").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const memo = String(formData.get("memo") ?? "").trim();
  const fundCode = String(formData.get("fundCode") ?? "").trim() || null;
  const fundName = String(formData.get("fundName") ?? "").trim() || null;
  const wealthProductIdInput = String(formData.get("wealthProductId") ?? "").trim();
  const fundProductType = String(formData.get("fundProductType") ?? "").trim() || null;
  if (fundProductType === "wealth") {
    try {
      await editSplitWealthTransaction(t, formData, householdId);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : t("investForm.alert.saveFailed") };
    }
  }
  const metalTypeIdInput = String(formData.get("metalTypeId") ?? "").trim();
  const metalUnitIdInput = String(formData.get("metalUnitId") ?? "").trim();
  const buyResultStatus = String(formData.get("buyResultStatus") ?? "normal").trim();
  const linkedRefundEntryId = String(formData.get("linkedRefundEntryId") ?? "").trim() || null;
  const refundAmountRaw = parseFloat(String(formData.get("refundAmount") ?? ""));
  const refundDateStr = String(formData.get("refundDate") ?? "").trim();

  // Detect which fields were passed (distinguish "not updated" vs "cleared").
  const hasFundUnits = formData.has("fundUnits");
  const hasFundNav = formData.has("fundNav");
  const hasDepositAnnualRate = formData.has("depositAnnualRate");
  const hasDepositInterest = formData.has("depositInterest");
  const hasFundFee = formData.has("fundFee");
  const hasFundConfirmDate = formData.has("fundConfirmDate");
  const hasCashAccountId = formData.has("cashAccountId");
  const hasFundArrivalDate = formData.has("fundArrivalDate");
  const hasFundArrivalAmount = formData.has("fundArrivalAmount");
  const hasDepositSourceEntryId = formData.has("depositSourceEntryId");
  const hasConfirmDays = formData.has("confirmDays");
  const hasFeeRate = formData.has("feeRate");
  const hasArrivalDays = formData.has("arrivalDays");

  const fundUnitsStr = String(formData.get("fundUnits") ?? "").trim();
  const fundNavStr = String(formData.get("fundNav") ?? "").trim();
  const fundFeeStr = String(formData.get("fundFee") ?? "").trim();
  const metalQuantityStr = String(formData.get("metalQuantity") ?? formData.get("fundUnits") ?? "").trim();
  const metalUnitPriceStr = String(formData.get("metalUnitPrice") ?? formData.get("fundNav") ?? "").trim();
  const metalFeeStr = String(formData.get("metalFee") ?? formData.get("fundFee") ?? "").trim();
  const depositAnnualRateStr = String(formData.get("depositAnnualRate") ?? "").trim();
  const depositInterestStr = String(formData.get("depositInterest") ?? "").trim();
  const fundConfirmDateStr = String(formData.get("fundConfirmDate") ?? "").trim();
  const cashAccountIdStr = String(formData.get("cashAccountId") ?? "").trim();
  const fundArrivalDateStr = String(formData.get("fundArrivalDate") ?? "").trim();
  const fundArrivalAmountStr = String(formData.get("fundArrivalAmount") ?? "").trim();
  const depositSourceEntryIdStr = String(formData.get("depositSourceEntryId") ?? "").trim();
  const confirmDaysStr = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysStr = String(formData.get("arrivalDays") ?? "").trim();
  const feeRateStr = String(formData.get("feeRate") ?? "").trim();

  // Empty string → null (clear), value present → parsed number.
  const fundUnitsRaw = fundUnitsStr ? parseFloat(fundUnitsStr) : NaN;
  const fundNavRaw = fundNavStr ? parseFloat(fundNavStr) : NaN;
  const fundFeeRaw = fundFeeStr ? parseFloat(fundFeeStr) : NaN;
  const metalQuantityRaw = metalQuantityStr ? parseFloat(metalQuantityStr) : NaN;
  const metalUnitPriceRaw = metalUnitPriceStr ? parseFloat(metalUnitPriceStr) : NaN;
  const metalFeeRaw = metalFeeStr ? parseFloat(metalFeeStr) : NaN;
  const fundArrivalAmountRaw = fundArrivalAmountStr ? parseFloat(fundArrivalAmountStr) : NaN;
  const refundAmount = Number.isFinite(refundAmountRaw) && refundAmountRaw > 0 ? Math.abs(refundAmountRaw) : null;
  const refundDate = refundDateStr ? dateFromYmd(refundDateStr) : null;
  const depositAnnualRateRaw = depositAnnualRateStr ? parseFloat(depositAnnualRateStr) : NaN;
  const depositInterestRaw = depositInterestStr ? parseFloat(depositInterestStr) : NaN;
  const confirmDaysRaw = confirmDaysStr ? parseInt(confirmDaysStr, 10) : NaN;
  const arrivalDaysRaw = arrivalDaysStr ? parseInt(arrivalDaysStr, 10) : NaN;
  const feeRateRaw = feeRateStr ? parseFloat(feeRateStr) : NaN;

  const fundUnits: number | null | undefined = hasFundUnits
    ? (Number.isFinite(fundUnitsRaw) && fundUnitsRaw > 0 ? fundUnitsRaw : null)
    : undefined; // undefined means do not update.
  const fundUnitsExplicitlyCleared = hasFundUnits && fundUnits === null;
  const fundNav: number | null | undefined = hasFundNav
    ? (Number.isFinite(fundNavRaw) && fundNavRaw > 0 ? fundNavRaw : null)
    : undefined;
  const depositAnnualRate: number | null | undefined = hasDepositAnnualRate
    ? (Number.isFinite(depositAnnualRateRaw) && depositAnnualRateRaw > 0 ? depositAnnualRateRaw : null)
    : undefined;
  const depositInterest: number | null | undefined = hasDepositInterest
    ? (Number.isFinite(depositInterestRaw) && depositInterestRaw >= 0 ? depositInterestRaw : null)
    : undefined;
  const fundFee: number | null | undefined = hasFundFee
    ? (Number.isFinite(fundFeeRaw) && fundFeeRaw >= 0 ? fundFeeRaw : null)
    : undefined;
  const metalQuantity: number | null = Number.isFinite(metalQuantityRaw) && metalQuantityRaw > 0 ? metalQuantityRaw : fundUnits ?? null;
  const metalUnitPrice: number | null = Number.isFinite(metalUnitPriceRaw) && metalUnitPriceRaw > 0 ? metalUnitPriceRaw : fundNav ?? null;
  const metalFee: number | null = Number.isFinite(metalFeeRaw) && metalFeeRaw > 0 ? metalFeeRaw : fundFee ?? null;
  const fundConfirmDate = hasFundConfirmDate
    ? (fundConfirmDateStr ? new Date(fundConfirmDateStr) : null)
    : undefined;
  const cashAccountId = hasCashAccountId
    ? (cashAccountIdStr || null)
    : undefined;
  const fundArrivalDate = hasFundArrivalDate
    ? (fundArrivalDateStr ? new Date(fundArrivalDateStr) : null)
    : undefined;
  const fundArrivalAmount: number | null | undefined = hasFundArrivalAmount
    ? (Number.isFinite(fundArrivalAmountRaw) && fundArrivalAmountRaw > 0 ? fundArrivalAmountRaw : null)
    : undefined;
  const depositSourceEntryId: string | null | undefined = hasDepositSourceEntryId
    ? (depositSourceEntryIdStr || null)
    : undefined;
  const confirmDays: number | null | undefined = hasConfirmDays
    ? (Number.isFinite(confirmDaysRaw) && confirmDaysRaw >= 0 ? confirmDaysRaw : null)
    : undefined;
  const feeRate: number | null | undefined = hasFeeRate
    ? (Number.isFinite(feeRateRaw) && feeRateRaw >= 0 ? feeRateRaw : null)
    : undefined;
  const arrivalDays: number | null | undefined = hasArrivalDays
    ? (Number.isFinite(arrivalDaysRaw) && arrivalDaysRaw >= 0 ? arrivalDaysRaw : null)
    : undefined;

  if (!entryId) return { ok: false as const, error: t("sidebar.action.missingParams") };
  const amountAbs = Number.isFinite(amountRaw) ? Math.abs(amountRaw) : 0;
  if (!amountAbs) return { ok: false as const, error: t("txForm.alert.invalidAmount") };
  if (!dateStr) return { ok: false as const, error: t("sidebar.action.applyDateRequired") };
  const date = new Date(dateStr);
  const redeemLike = subtype === "redeem" || subtype === "switch_out";
  const validSubtypes = Object.values(FundSubtype);
  const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;
  const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;
  const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;

  try {
    // Query the TxRecord directly.
    let txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
    });

    if (!txRecord) return { ok: false as const, error: t("sidebar.action.fundRecordNotFound") };
    if (txRecord.fundSubtype === FundSubtype.buy_failed && txRecord.source === "regular_invest_refund") {
      const sourceBuy = txRecord.fundSourceEntryId
        ? await prisma.txRecord.findFirst({
            where: {
              id: txRecord.fundSourceEntryId,
              householdId,
              deletedAt: null,
              type: TransactionType.investment,
              fundSubtype: FundSubtype.buy,
            },
          })
        : null;
      if (!sourceBuy || !sourceBuy.accountId || !sourceBuy.toAccountId || !sourceBuy.fundCode) {
        return { ok: false as const, error: t("sidebar.action.buyRefundMissingBuy") };
      }
      const [fundAccount, cashAccount] = await Promise.all([
        prisma.account.findUnique({ where: { id: sourceBuy.toAccountId }, select: { id: true, name: true, currency: true } }),
        prisma.account.findUnique({ where: { id: sourceBuy.accountId }, select: { id: true, name: true } }),
      ]);
      if (!fundAccount || !cashAccount) return { ok: false as const, error: t("sidebar.action.buyRefundAccountsNotFound") };
      const nextRefundAmount = refundAmount ?? amountAbs;
      const nextRefundDate = refundDate ?? fundArrivalDate ?? date;
      await prisma.$transaction(async (tx) => {
        await upsertFundBuyRefundRecord(tx, {
          householdId,
          linkedRefundEntryId: txRecord.id,
          buyEntryId: sourceBuy.id,
          buyDate: sourceBuy.date,
          refundDate: nextRefundDate,
          refundAmount: nextRefundAmount,
          fundAccountId: fundAccount.id,
          fundAccountName: fundAccount.name,
          cashAccountId: cashAccount.id,
          cashAccountName: cashAccount.name,
          currency: sourceBuy.currency ?? fundAccount.currency ?? "CNY",
          fundCode: sourceBuy.fundCode,
          fundName: sourceBuy.fundName,
          fundProductType: sourceBuy.fundProductType,
          fundConfirmDate: sourceBuy.fundConfirmDate ?? sourceBuy.date,
          fundArrivalDate: nextRefundDate,
          regularInvestPlanId: sourceBuy.regularInvestPlanId ?? null,
          note: regularInvestRefundNote(
            sourceBuy.fundCode,
            sourceBuy.fundName,
            nextRefundAmount,
            sourceBuy.date,
            sourceBuy.currency ?? fundAccount.currency ?? "CNY",
            memo || txRecord.note,
          ),
        });
      });
      await syncFundTransactionsFromTxRecords([sourceBuy.id]).catch((e) => {
        console.error("editInvestment sync linked refund fund transaction:", e);
      });
      await recalcFundPositions(sourceBuy.toAccountId, sourceBuy.fundCode ? [sourceBuy.fundCode] : undefined).catch((e) => { console.error("editInvestment recalc linked refund fund positions:", e); });
      await recalcAndSaveAccountBalance(sourceBuy.toAccountId).catch((e) => { console.error("editInvestment recalc linked refund invest balance:", e); });
      await recalcAndSaveAccountBalance(sourceBuy.accountId).catch((e) => { console.error("editInvestment recalc linked refund cash balance:", e); });
      revalidateAfterInvestChange();
      return { ok: true as const };
    }

    // Buy: accountId=cash account (source), toAccountId=investment account (receiver).
    // Redeem / cash dividend / buy_failed refund: accountId=investment account (source), toAccountId=cash account (receiver).
    const isRedeemOrRefund = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out"
      || txRecord.fundSubtype === "dividend_cash"
      || (txRecord.fundSubtype === "buy_failed" && txRecord.source === "regular_invest_refund");
    const existingFundTransactionForRecalc = fundProductType !== "wealth" && fundProductType !== "metal"
      ? await findFundTransactionForEntryId(prisma, { id: entryId, householdId }).catch(() => null)
      : null;
    const oldInvestmentAccId = existingFundTransactionForRecalc?.fundAccountId ?? ((isRedeemOrRefund ? txRecord.accountId : txRecord.toAccountId) ?? "");
    const oldCashAccId = existingFundTransactionForRecalc?.cashAccountId ?? ((isRedeemOrRefund ? txRecord.toAccountId : txRecord.accountId) ?? "");
    const oldFundCode = existingFundTransactionForRecalc?.fundCode ?? null;

    // Detect whether a new fund account was passed (via the toAccountId field).
    const hasNewToAccountId = formData.has("toAccountId");
    const newToAccountIdStr = String(formData.get("toAccountId") ?? "").trim();
    const newToAccountId = hasNewToAccountId && newToAccountIdStr ? newToAccountIdStr : null;
    let usedIndependentFundTransaction = false;

    await prisma.$transaction(async (tx) => {
      const requestedInvestmentAccountId = newToAccountId ?? oldInvestmentAccId;
      const requestedCashAccountId = cashAccountId ?? oldCashAccId;
      const resolvedWealthAccount = fundProductType === "wealth" && !redeemLike
        ? await resolveOrCreateWealthAccount(tx, {
            householdId,
            cashAccountId: requestedCashAccountId,
            requestedAccountId: requestedInvestmentAccountId || null,
          })
        : null;
      // Query the cash account info first (if needed).
      const cashAccountInfo = requestedCashAccountId
        ? await tx.account.findUnique({ where: { id: requestedCashAccountId }, select: { id: true, name: true } })
        : null;

      // Query the new fund account info (if needed).
      const newInvestmentAccountInfo = resolvedWealthAccount ?? (newToAccountId
        ? await tx.account.findUnique({ where: { id: newToAccountId }, select: { id: true, name: true, fundUnitsDecimals: true, institutionId: true, currency: true } })
        : null);
      const existingInvestmentAccountInfo = !newInvestmentAccountInfo && oldInvestmentAccId
        ? await tx.account.findUnique({ where: { id: oldInvestmentAccId }, select: { id: true, name: true, fundUnitsDecimals: true, institutionId: true, currency: true } })
        : null;
      const finalInvestmentAccountInfo = newInvestmentAccountInfo ?? existingInvestmentAccountInfo;
      const finalFundAccountId = finalInvestmentAccountInfo?.id ?? oldInvestmentAccId;
      const finalFundAccountName = finalInvestmentAccountInfo?.name ?? txRecord.toAccountName ?? txRecord.accountName ?? "";
      const finalCashAccountId = cashAccountInfo?.id ?? oldCashAccId;
      const finalCashAccountName = cashAccountInfo?.name ?? txRecord.accountName ?? "";
      const fundUnitsDecimals = normalizeFundUnitsDecimals(
        finalInvestmentAccountInfo?.fundUnitsDecimals,
        3,
      );
      const roundedFundUnits = fundUnits != null ? roundFundUnits(fundUnits, fundUnitsDecimals) : null;
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
      if (fundProductType === "metal" && !metalType) throw new Error(t("sidebar.action.selectMetalType"));
      if (fundProductType === "metal" && !metalUnit) throw new Error(t("sidebar.action.selectMetalUnit"));
      const wealthProduct = fundProductType === "wealth"
        ? (wealthProductIdInput
            ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, institutionId: finalInvestmentAccountInfo?.institutionId, isActive: true } })
            : fundName
              ? await tx.wealthProduct.findFirst({
                  where: { householdId, institutionId: finalInvestmentAccountInfo?.institutionId ?? null, name: fundName, isActive: true },
                }) ?? await tx.wealthProduct.create({
                  data: {
                    householdId,
                    institutionId: finalInvestmentAccountInfo?.institutionId ?? null,
                    name: fundName,
                    currency: finalInvestmentAccountInfo?.currency ?? "CNY",
                  },
                })
              : null)
        : null;
      if (fundProductType === "wealth" && !wealthProduct) throw new Error(t("sidebar.action.selectOrCreateWealthProduct"));

      // Build the TxRecord update data.
      const sourceValue = fundProductType === "deposit"
        ? "deposit"
        : isDividendReinvest
          ? "dividend"
          : (String(formData.get("source") ?? txRecord.source ?? "manual").trim() || "manual");
      const finalFundSubtype: FundSubtype = isDividendReinvest ? FundSubtype.buy : fundSubtypeValue;
      const isBuyFailedRefund =
        finalFundSubtype === FundSubtype.buy_failed &&
        sourceValue === "regular_invest_refund";
      const signedAmount = (redeemLike || isBuyFailedRefund)
        ? (fundArrivalAmount ?? Math.max(0, amountAbs + (depositInterest ?? 0) - (fundFee ?? 0)))
        : (isDividendCash ? amountAbs : -amountAbs);
      const isMetalProduct = fundProductType === "metal";
      const isWealthProduct = fundProductType === "wealth";
      const updateData: any = {
        date,
        fundCode: isMetalProduct || isWealthProduct ? null : fundCode,
        fundName: isMetalProduct ? null : (wealthProduct?.name || fundName),
        wealthProductId: wealthProduct?.id ?? null,
        fundProductType,
        metalTypeId: metalType?.id ?? null,
        metalTypeName: metalType?.name ?? null,
        metalUnitId: metalUnit?.id ?? null,
        metalUnitName: metalUnit ? (metalUnit.symbol ? `${metalUnit.name}(${metalUnit.symbol})` : metalUnit.name) : null,
        metalQuantity: isMetalProduct ? (metalQuantity != null ? roundFundUnits(metalQuantity, fundUnitsDecimals) : null) : null,
        metalUnitPrice: isMetalProduct ? metalUnitPrice : null,
        metalFee: isMetalProduct ? metalFee : null,
        fundSubtype: finalFundSubtype,
        source: sourceValue,
        fundUnits: isMetalProduct ? null : (hasFundUnits ? roundedFundUnits : txRecord.fundUnits),
        fundNav: isMetalProduct || fundProductType === "deposit" ? null : fundNav ?? null,
        depositAnnualRate: depositAnnualRate ?? null,
        depositInterest: depositInterest ?? null,
        depositSourceEntryId: depositSourceEntryId ?? null,
        fundFee: isMetalProduct ? null : fundFee ?? null,
        fundConfirmDate: isMetalProduct ? null : fundConfirmDate ?? null,
        fundArrivalDate: isMetalProduct ? null : fundArrivalDate ?? null,
        fundArrivalAmount: fundArrivalAmount ?? null,
        note: memo || null,
      };
      if (
        !isMetalProduct &&
        !isWealthProduct &&
        finalFundSubtype === FundSubtype.buy &&
        buyResultStatus === "refund" &&
        !fundUnitsExplicitlyCleared &&
        refundAmount &&
        refundAmount > 0
      ) {
        const recalculatedUnits = calculateConfirmedBuyUnits({
          grossAmount: amountAbs,
          refundAmount,
          fee: fundFee ?? toNumber(txRecord.fundFee),
          nav: fundNav ?? toNumber(txRecord.fundNav),
          roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
        });
        if (recalculatedUnits != null) {
          updateData.fundUnits = recalculatedUnits;
        }
      }

        // Buy: cash account -> fund account; redeem/cash dividend/buy refund: fund account -> cash account.
        if (redeemLike || isDividendCash || isBuyFailedRefund) {
          updateData.accountId = finalFundAccountId;
          updateData.accountName = finalFundAccountName;
          updateData.toAccountId = finalCashAccountId || finalFundAccountId;
          updateData.toAccountName = finalCashAccountName || finalFundAccountName;
          updateData.amount = isDividendCash ? amountAbs : signedAmount;
          updateData.deletedAt = null;
        } else if (fundSubtypeValue === FundSubtype.dividend_reinvest) {
          updateData.accountId = finalFundAccountId;
          updateData.accountName = finalFundAccountName;
          updateData.toAccountId = finalFundAccountId;
          updateData.toAccountName = finalFundAccountName;
          updateData.amount = amountAbs;
          updateData.deletedAt = null;
        } else {
          updateData.accountId = finalCashAccountId || finalFundAccountId;
          updateData.accountName = finalCashAccountName || finalFundAccountName;
          updateData.toAccountId = finalFundAccountId;
          updateData.toAccountName = finalFundAccountName;
          updateData.amount = signedAmount;
          updateData.deletedAt = null;
        }

      const isFundLikeIndependentEdit =
        !isMetalProduct &&
        !isWealthProduct &&
        fundProductType !== "deposit" &&
        !!fundCode &&
        (!fundProductType || fundProductType === "fund" || fundProductType === "money" || fundProductType === "money_fund");
      let independentFundTransaction: Awaited<ReturnType<typeof findFundTransactionForEntryId>> = null;
      if (isFundLikeIndependentEdit) {
        independentFundTransaction = await findFundTransactionForEntryId(tx, { id: entryId, householdId });
        if (!independentFundTransaction) throw new Error(t("sidebar.action.fundTransactionNotMigrated"));
        usedIndependentFundTransaction = true;
        const businessUnits = updateData.fundUnits;
        const businessNav = fundNav ?? independentFundTransaction.nav;
        const businessFee = fundFee ?? independentFundTransaction.fee;
        await tx.fundTransaction.update({
          where: { id: independentFundTransaction.id },
          data: {
            fundAccountId: finalFundAccountId,
            cashAccountId: finalCashAccountId || null,
            fundCode,
            fundName: fundName || independentFundTransaction.fundName || fundCode,
            fundProductType: fundProductType === "money_fund" ? "money" : ((fundProductType || "fund") as any),
            fundSubtype: finalFundSubtype,
            source: sourceValue,
            applyDate: date,
            confirmDate: fundConfirmDate ?? null,
            arrivalDate: fundArrivalDate ?? null,
            grossAmount: amountAbs,
            refundAmount: buyResultStatus === "refund" ? refundAmount ?? 0 : 0,
            arrivalAmount: fundArrivalAmount ?? null,
            fee: businessFee,
            nav: businessNav,
            units: businessUnits,
            note: memo || null,
          },
        });
        if (independentFundTransaction.cashEntryId && finalCashAccountId && updateData.amount !== 0 && !isDividendReinvest) {
          const cashFlowDate = redeemLike || isDividendCash || isBuyFailedRefund ? fundArrivalDate ?? date : date;
          const cashFlowKind =
            finalFundSubtype === FundSubtype.redeem || finalFundSubtype === FundSubtype.switch_out
              ? FundCashFlowKind.redeem_in
              : finalFundSubtype === FundSubtype.dividend_cash
                ? FundCashFlowKind.dividend_in
                : FundCashFlowKind.buy_out;
          await tx.fundTransactionCashFlow.upsert({
            where: { id: `cff_${independentFundTransaction.cashEntryId}` },
            create: {
              id: `cff_${independentFundTransaction.cashEntryId}`,
              fundTransactionId: independentFundTransaction.id,
              txRecordId: independentFundTransaction.cashEntryId,
              kind: cashFlowKind,
              amount: Math.abs(Number(updateData.amount)),
              flowDate: cashFlowDate,
              accountId: finalCashAccountId,
            },
            update: {
              kind: cashFlowKind,
              amount: Math.abs(Number(updateData.amount)),
              flowDate: cashFlowDate,
              accountId: finalCashAccountId,
            },
          });
          await upsertEntryBusinessCashFlowLink(tx, {
            householdId,
            cashEntryId: independentFundTransaction.cashEntryId,
            fundTransactionId: independentFundTransaction.id,
            businessType: "fund",
            cashFlowDirection: Number(updateData.amount) < 0 ? "outflow" : "inflow",
            source: sourceValue,
            note: "Linked cash flow to fund transaction",
            metadata: {
              splitRecord: true,
              independentBusinessTransaction: true,
            },
          });
        }
        Object.assign(updateData, {
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
        });
      }

      await tx.txRecord.update({
        where: { id: entryId },
        data: updateData,
      });
      if (
        !isFundLikeIndependentEdit &&
        finalFundSubtype === FundSubtype.buy &&
        sourceValue !== "insurance" &&
        !isMetalProduct &&
        !isWealthProduct &&
        buyResultStatus === "refund" &&
        refundAmount &&
        refundAmount > 0 &&
        fundCode &&
        finalFundAccountId &&
        finalCashAccountId
      ) {
        const effectiveRefundDate = refundDate ?? fundArrivalDate ?? fundConfirmDate ?? date;
        await upsertFundBuyRefundRecord(tx, {
          householdId,
          linkedRefundEntryId,
          buyEntryId: entryId,
          buyDate: date,
          refundDate: effectiveRefundDate,
          refundAmount,
          fundAccountId: finalFundAccountId,
          fundAccountName: finalFundAccountName,
          cashAccountId: finalCashAccountId,
          cashAccountName: finalCashAccountName,
          currency: finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
          fundCode,
          fundName: wealthProduct?.name || fundName,
          fundProductType,
          fundConfirmDate: fundConfirmDate ?? null,
          fundArrivalDate: effectiveRefundDate,
          regularInvestPlanId: txRecord.regularInvestPlanId ?? null,
          note: regularInvestRefundNote(
            fundCode,
            wealthProduct?.name || fundName || fundCode,
            refundAmount,
            date,
            finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
            memo,
          ),
        });
      } else if (finalFundSubtype === FundSubtype.buy && linkedRefundEntryId) {
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
      if (
        independentFundTransaction &&
        finalFundSubtype === FundSubtype.buy &&
        buyResultStatus === "refund" &&
        refundAmount &&
        refundAmount > 0 &&
        finalCashAccountId
      ) {
        const effectiveRefundDate = refundDate ?? fundArrivalDate ?? fundConfirmDate ?? date;
        await upsertFundTransactionRefundCashFlow(tx, {
          householdId,
          fundTransactionId: independentFundTransaction.id,
          linkedRefundEntryId,
          refundDate: effectiveRefundDate,
          refundAmount,
          cashAccountId: finalCashAccountId,
          cashAccountName: finalCashAccountName,
          currency: finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
          source: "regular_invest_refund",
          note: regularInvestRefundNote(
            fundCode,
            fundName,
            refundAmount,
            date,
            finalInvestmentAccountInfo?.currency ?? txRecord.currency ?? "CNY",
            memo,
          ),
        });
      }
    });
    if (fundProductType !== "wealth" && !usedIndependentFundTransaction) {
      await syncFundTransactionsFromTxRecords([entryId]).catch((e) => {
        console.error("editInvestment sync fund transaction:", e);
      });
    }
    if (!usedIndependentFundTransaction) {
      await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: entryId }).catch((e) => {
        console.error("editInvestment sync independent business transaction:", e);
      });
    }

    // Recalculate positions: if the fund account changed, recalculate both the old and new accounts.
    const finalInvestmentAccId = newToAccountId ?? oldInvestmentAccId;
    const recalcCodes = Array.from(new Set([oldFundCode, fundCode].filter((code): code is string => !!code)));

    const wasMetal = txRecord.fundProductType === "metal" || !!txRecord.metalTypeId;
    const isMetalProduct = fundProductType === "metal";
    if (wasMetal || isMetalProduct) {
      if (oldInvestmentAccId) await recalcPreciousMetalPositions(oldInvestmentAccId).catch((e) => { console.error("editInvestment recalc old metal positions:", e); });
      if (finalInvestmentAccId && finalInvestmentAccId !== oldInvestmentAccId) {
        await recalcPreciousMetalPositions(finalInvestmentAccId).catch((e) => { console.error("editInvestment recalc new metal positions:", e); });
      }
    }
    if (!isMetalProduct && fundProductType !== "wealth") {
      if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
        // Fund account changed: recalculate both the old and new accounts.
        await recalcFundPositions(oldInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc old fund positions:", e); });
        await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc new fund positions:", e); });
      } else if (finalInvestmentAccId) {
        // Fund account unchanged: recalculate only that account.
        await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc fund positions:", e); });
      }
    }

    // Recalculate the investment account balance.
    await recalcAndSaveAccountBalance(finalInvestmentAccId).catch((e) => { console.error("editInvestment recalc invest balance:", e); });
    if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldInvestmentAccId).catch((e) => { console.error("editInvestment recalc old invest balance:", e); });
    }

    // Recalculate the cash account balance (if the cash account changed).
    if (oldCashAccId && oldCashAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldCashAccId).catch((e) => { console.error("editInvestment recalc old cash balance:", e); });
    }
    if (cashAccountId && cashAccountId !== oldCashAccId && cashAccountId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(cashAccountId).catch((e) => { console.error("editInvestment recalc new cash balance:", e); });
    }

    // Update the T+N confirm days in the unified confirm-days store.
    if (fundProductType !== "metal" && fundProductType !== "wealth" && finalInvestmentAccId && fundCode && confirmDays !== undefined && confirmDays !== null) {
      await setFundConfirmDays(finalInvestmentAccId, fundCode, confirmDays).catch(() => {});

    // Update the arrival days in the unified arrival-days store.
    if (finalInvestmentAccId && fundCode && arrivalDays !== undefined && arrivalDays !== null) {
      await setFundArrivalDays(finalInvestmentAccId, fundCode, arrivalDays).catch(() => {});
    }
    }

    // Update the fee rate in the unified fee-rate store, split by buy/redeem.
    if (fundProductType !== "metal" && fundProductType !== "wealth" && finalInvestmentAccId && fundCode && feeRate !== undefined && feeRate !== null) {
      await setFundFeeRateByDate(finalInvestmentAccId, fundCode, feeRate, fundConfirmDate ?? date, redeemLike ? "redeem" : "buy").catch(() => {});
    }

    await invalidateCreditCardCycleCacheForAccountIds([
      oldInvestmentAccId,
      finalInvestmentAccId,
      oldCashAccId,
      cashAccountId,
    ]).catch(() => {});
    revalidateAfterInvestChange();
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : t("investForm.alert.saveFailed") };
  }
}


async function updateTransactionFromDialog(formData: FormData) {
  "use server";
  const t = await getServerT();

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: t("sidebar.action.missingEntryId") };

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const postedAtInput = parseOptionalDateTimeInput(formData.get("postedAt"));
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = Math.abs(amountRaw);
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();
  const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const postedAt = type === "expense" || type === "income" ? (postedAtInput ?? date) : null;
  if (!amountAbs) return { ok: false as const, error: t("txForm.alert.invalidAmount") };

  try {
    const ctx = await getHouseholdScope();
    const undo = await prepareEntryUndo(prisma, ctx.householdId, [entryId]);
    let investRecalcAccountId: string | null = null;
    let investRecalcFundCode: string | null = null;
    const touchedAccountIds = new Set<string>();
    await prisma.$transaction(async (tx) => {
      const entry = await tx.txRecord.findUnique({
        where: { id: entryId },

      });
      if (!entry) throw new Error(t("sidebar.action.recordNotFound"));
      if (entry.accountId) touchedAccountIds.add(entry.accountId);
      if (entry.toAccountId) touchedAccountIds.add(entry.toAccountId);

      await replaceEntryTags({ tx, entryId, householdId: entry.householdId, tagIds });

      if (type === "transfer") {
        const formFromAccountId = String(formData.get("fromAccountId") ?? "").trim();
        const formToAccountId = String(formData.get("toAccountId") ?? "").trim();
        if (!formFromAccountId || !formToAccountId) throw new Error(t("sidebar.action.transferAccountsRequired"));
        if (formFromAccountId === formToAccountId) throw new Error(t("sidebar.action.transferAccountsSame"));
        const fromAccountId = amountRaw < 0 ? formToAccountId : formFromAccountId;
        const toAccountId = amountRaw < 0 ? formFromAccountId : formToAccountId;

        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId } }),
          tx.account.findUnique({ where: { id: toAccountId } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error(t("sidebar.action.accountNotFound"));
        const counterpartyInstitution = counterpartyInstitutionId
          ? await tx.institution.findUnique({ where: { id: counterpartyInstitutionId } })
          : null;
        touchedAccountIds.add(fromAcc.id);
        touchedAccountIds.add(toAcc.id);
        const isDebtTransfer = fromAcc.kind === AccountKind.loan || toAcc.kind === AccountKind.loan;
        if (fromAcc.kind === AccountKind.loan && toAcc.kind === AccountKind.loan) {
          throw new Error(t("sidebar.action.settlementTransferNotAllowed"));
        }
        if (!isDebtTransfer && (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc))) {
          throw new Error(t("sidebar.action.specialTargetTransferNotAllowed"));
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);
        const debtMode = isDebtTransfer
          ? fromAcc.kind === AccountKind.loan
            ? fromAcc.debtDirection === "receivable" ? "collect_in" : "borrow_in"
            : toAcc.debtDirection === "receivable" ? "lend_out" : "repay_out"
          : null;
        if (
          !debtMode &&
          String(entry.source ?? "").startsWith("debt_") &&
          (Math.abs(toNumber(entry.debtInterestAmount)) > 0.005 || Math.abs(toNumber(entry.debtFeeAmount)) > 0.005)
        ) {
          throw new Error(t("sidebar.action.debtWithInterestNoTransfer"));
        }
        const signedTransferAmount = debtMode === "collect_in" ? amountAbs : -amountAbs;

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);
        const transferCategory = debtMode
          ? await ensureSettlementTransferCategory(tx, ctx.householdId)
          : isCreditCardRepaymentTransfer({
              type: TransactionType.transfer,
              accountKind: fromAcc.kind,
              toAccountKind: toAcc.kind,
            })
            ? await resolveCreditCardRepaymentCategory(tx, ctx.householdId)
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
            counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
            counterpartyInstitutionName: counterpartyInstitution?.name ?? null,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            source: debtMode ? `debt_${debtMode}` : "manual",
            debtPrincipalAmount: debtMode ? amountAbs : null,
            debtInterestAmount: debtMode ? 0 : null,
            debtFeeAmount: debtMode ? 0 : null,
          },
        });
        return;
      }

      if (type === "investment") {
        // Edit mode: accountId=investment account (unified), cashAccountId=cash account.
        const accountIdFormData = String(formData.get("accountId") ?? "").trim();
        const cashAccountIdFormData = String(formData.get("cashAccountId") ?? "").trim();
        const fundCode = String(formData.get("fundCode") ?? "").trim();
        const productType = String(formData.get("productType") ?? "fund").trim();
        const subtype = String(formData.get("subtype") ?? "buy").trim();
        const redeemLike = subtype === "redeem" || subtype === "switch_out";
        const isInsuranceEntry = entry.source === "insurance" || !!entry.insuranceProductId;

        const investAcc = accountIdFormData ? await tx.account.findUnique({ where: { id: accountIdFormData } }) : null;
        if (!investAcc) throw new Error(t("sidebar.action.selectInvestmentAccount"));
        touchedAccountIds.add(investAcc.id);

        // Cash account: prefer the form value; otherwise infer from the original record.
        let cashAccId: string | null = null;
        let cashAccName: string | null = null;
        if (cashAccountIdFormData) {
          const cashAcc = await tx.account.findUnique({ where: { id: cashAccountIdFormData } });
          if (cashAcc) { cashAccId = cashAcc.id; cashAccName = cashAcc.name; touchedAccountIds.add(cashAcc.id); }
        }
        // Fallback: infer the cash account from the original record.
        if (!cashAccId) {
          if (redeemLike) {
            // Redeem records: toAccountId is the cash account (receiver).
            if (entry.toAccountId) {
              const acc = await tx.account.findUnique({ where: { id: entry.toAccountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; touchedAccountIds.add(acc.id); }
            }
          } else {
            // Buy records: accountId is the cash account (source).
            if (entry.accountId && entry.accountId !== investAcc.id) {
              const acc = await tx.account.findUnique({ where: { id: entry.accountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; touchedAccountIds.add(acc.id); }
            }
          }
        }

        // Determine record direction: toAccountId = cash receiving side.
        let recordAccountId: string;
        let recordAccountName: string;
        let recordToAccountId: string;
        let recordToAccountName: string;
        let signedAmount: number;

        const fundArrivalAmount = parseFloat(String(formData.get("fundArrivalAmount") ?? ""));
        const fundFee = parseFloat(String(formData.get("fundFee") ?? ""));

        if (redeemLike) {
          recordAccountId = investAcc.id;
          recordAccountName = investAcc.name;
          recordToAccountId = cashAccId ?? investAcc.id;
          recordToAccountName = cashAccName ?? investAcc.name;
          signedAmount = Number.isFinite(fundArrivalAmount) && fundArrivalAmount > 0
            ? fundArrivalAmount
            : Math.max(0, amountAbs - (Number.isFinite(fundFee) && fundFee > 0 ? fundFee : 0));
        } else {
          recordAccountId = cashAccId ?? investAcc.id;
          recordAccountName = cashAccName ?? investAcc.name;
          recordToAccountId = investAcc.id;
          recordToAccountName = investAcc.name;
          signedAmount = -amountAbs;
        }

        const isFundLikeIndependentEdit =
          !isInsuranceEntry &&
          !!fundCode &&
          (productType === "fund" || productType === "money" || productType === "money_fund");
        const independentFundTransaction = isFundLikeIndependentEdit
          ? await findFundTransactionForEntryId(tx, { id: entryId, householdId: ctx.householdId })
          : null;
        if (isFundLikeIndependentEdit && !independentFundTransaction) {
          throw new Error(t("sidebar.action.fundTransactionNotMigrated"));
        }
        if (independentFundTransaction) {
          const arrivalAmount = Number.isFinite(fundArrivalAmount) && fundArrivalAmount > 0 ? fundArrivalAmount : null;
          const fee = Number.isFinite(fundFee) && fundFee > 0 ? fundFee : independentFundTransaction.fee;
          await tx.fundTransaction.update({
            where: { id: independentFundTransaction.id },
            data: {
              fundAccountId: investAcc.id,
              cashAccountId: cashAccId ?? null,
              fundCode,
              fundName: independentFundTransaction.fundName ?? fundCode,
              fundProductType: productType === "money_fund" ? "money" : (productType as any),
              fundSubtype: subtype as any,
              applyDate: date,
              grossAmount: amountAbs,
              arrivalAmount,
              fee,
              note: note || null,
            },
          });
          if (independentFundTransaction.cashEntryId && cashAccId && signedAmount !== 0) {
            const cashFlowKind =
              subtype === "redeem" || subtype === "switch_out"
                ? FundCashFlowKind.redeem_in
                : subtype === "dividend_cash"
                  ? FundCashFlowKind.dividend_in
                  : FundCashFlowKind.buy_out;
            await tx.fundTransactionCashFlow.upsert({
              where: { id: `cff_${independentFundTransaction.cashEntryId}` },
              create: {
                id: `cff_${independentFundTransaction.cashEntryId}`,
                fundTransactionId: independentFundTransaction.id,
                txRecordId: independentFundTransaction.cashEntryId,
                kind: cashFlowKind,
                amount: Math.abs(signedAmount),
                flowDate: redeemLike ? date : date,
                accountId: cashAccId,
              },
              update: {
                kind: cashFlowKind,
                amount: Math.abs(signedAmount),
                flowDate: date,
                accountId: cashAccId,
              },
            });
            await upsertEntryBusinessCashFlowLink(tx, {
              householdId: ctx.householdId,
              cashEntryId: independentFundTransaction.cashEntryId,
              fundTransactionId: independentFundTransaction.id,
              businessType: "fund",
              cashFlowDirection: signedAmount < 0 ? "outflow" : "inflow",
              source: entry.source,
              note: "Linked cash flow to fund transaction",
              metadata: {
                splitRecord: true,
                independentBusinessTransaction: true,
              },
            });
          }
        }

        // Update the TxRecord.
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
            fundCode: null,
            insuranceAction: isInsuranceEntry ? (redeemLike ? "refund" : "premium") : entry.insuranceAction,
            insuranceProductName: isInsuranceEntry ? (entry.fundName ?? null) : entry.insuranceProductName,
            fundProductType: isFundLikeIndependentEdit || isInsuranceEntry ? null : (productType as any) || null,
            fundSubtype: isFundLikeIndependentEdit ? null : (subtype as any) || null,
            date,
            type: TransactionType.investment,
            note: note || null,
          },
        });

        investRecalcAccountId = investAcc.id;
        investRecalcFundCode = fundCode || null;
        return;
      }

      if (type === "advance") {
        const accountId = String(formData.get("accountId") ?? "").trim();
        const categoryId = String(formData.get("categoryId") ?? "").trim();
        const debtObjectId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
        if (!accountId) throw new Error(t("investForm.selectCashAccount"));
        if (!debtObjectId) throw new Error(t("debtTx.placeholder.selectCounterparty"));
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error(t("sidebar.action.accountNotFound"));
        if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.advanceNoIncomeExpense"));
        const resolvedAdvance = await resolveOrCreateAdvanceAccount(tx, {
          householdId: ctx.householdId,
          cashAccountId: acc.id,
          debtObjectId,
        });
        const transfer = resolveAdvanceTransfer({ amount: amountRaw, cashAccount: acc, advanceAccount: resolvedAdvance.account });
        const statementMonth = statementMonthForTransfer(date, transfer.fromAccount, transfer.toAccount);
        touchedAccountIds.add(acc.id);
        touchedAccountIds.add(resolvedAdvance.account.id);
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

      if (type !== "expense" && type !== "income") throw new Error(t("sidebar.action.invalidType"));
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const keepFundDetail = formData.get("keepFundDetail") === "true";

      const [acc, cat] = await Promise.all([
        accountId ? tx.account.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
        categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
      ]);
      if (!acc) throw new Error(t("investForm.selectAccount"));
      touchedAccountIds.add(acc.id);
      if (isPureInvestmentAccount(acc)) throw new Error(t("sidebar.action.investmentNoIncomeExpense"));

      // Check whether this is a fund transaction (via toAccountId + fundProductType).
      const isFundTransaction = entry.toAccountId && entry.fundProductType;

      const statementMonth =
        (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
          ? toStatementMonth(date, acc.billingDay)
          : null;

      const expenseOrIncomeData: Record<string, unknown> = {
        amount: amountRaw,
        accountId: acc.id,
        accountName: acc.name,
        categoryId: cat ? cat.id : null,
        categoryName: cat?.name ?? null,
        statementMonth,
        toAccountId: null,
        toAccountName: null,
        fundCode: null,
        fundProductType: null,
            toNote: null,
            date,
            postedAt,
            type: type === "income" ? TransactionType.income : TransactionType.expense,
            note: note || null,
      };
      if (isFundTransaction && !keepFundDetail) {
        expenseOrIncomeData.fundSubtype = null;
        expenseOrIncomeData.fundUnits = null;
        expenseOrIncomeData.fundNav = null;
        expenseOrIncomeData.fundFee = null;
        expenseOrIncomeData.fundConfirmDate = null;
        expenseOrIncomeData.fundArrivalDate = null;
        expenseOrIncomeData.fundArrivalAmount = null;
      }

      await tx.txRecord.update({
        where: { id: entryId },
        data: expenseOrIncomeData,
      });
    });

    if (investRecalcAccountId) {
      await recalcFundPositions(
        investRecalcAccountId,
        investRecalcFundCode ? [investRecalcFundCode] : undefined,
      ).catch(() => {});
    }

    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
    if (type === "investment") revalidateAfterInvestChange();
    else revalidateAfterTxChange();
    await saveEntryUndo(prisma, ctx, undo, "edit", t("sidebar.undo.editEntry"));
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : t("investForm.alert.saveFailed");
    return { ok: false as const, error: msg };
  }
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    accountId?: string;
    view?: string;
    billMonth?: string;
    hideZeroBills?: string;
    hideSettledBills?: string;
    billMonthsLimit?: string;
    billPage?: string;
    pageSize?: string;
    detailPage?: string;
    symbol?: string;
    fundCode?: string;
    wealthProductId?: string;
    fundSort?: string;
    fundSortDir?: string;
    fundPageSize?: string;
    fundPage?: string;
    showCleared?: string;
    debtPerson?: string;
    detailAll?: string;
    detailFilterDate?: string;
    detailFilterFlow?: string;
    detailFilterType?: string;
    detailFilterCategory?: string;
    detailFilterRelated?: string;
    detailFilterRemark?: string;
    detailDateFrom?: string;
    detailDateTo?: string;
    detailInFrom?: string;
    detailInTo?: string;
    detailOutFrom?: string;
    detailOutTo?: string;
    focusEntryId?: string;
    guide?: string;
  }>;
}) {
  const t = await getServerT();
  const params = await searchParams;
  await connection();
  const accountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const accountName = typeof params?.account === "string" ? params.account.trim() : "";
  // If no account is selected, default to the overview page.
  if (!accountId && !accountName && params?.view !== "debt") {
    redirect("/overview");
  }
  const viewParam =
    params?.view === "bill"
      ? "bill"
      : params?.view === "detail"
        ? "detail"
        : params?.view === "investfund"
          ? "investfund"
        : params?.view === "investmoney"
          ? "investmoney"
          : params?.view === "investwealth"
            ? "investwealth"
            : params?.view === "investstock"
              ? "investstock"
              : params?.view === "investproperty"
                ? "investproperty"
                : params?.view === "regularinvest"
                  ? "regularinvest"
                  : params?.view === "debt"
                    ? "debt"
                    : params?.view === "deposit"
                      ? "deposit"
                      : "";
  const debtPersonParam = typeof params?.debtPerson === "string" ? params.debtPerson.trim() : "";
  const billMonthParam = typeof params?.billMonth === "string" ? params.billMonth.trim() : "";
  const billPageParam = typeof params?.billPage === "string" ? parseInt(params.billPage, 10) : 1;
  const billPage = Number.isFinite(billPageParam) && billPageParam >= 1 ? billPageParam : 1;

  // Read the cookie preference. The pagination cookie preserves the detail-table
  // context after an edit refresh.
  const cookieStore = await cookies();
  const detailPaginationPref = decodeDetailPaginationPreference(
    cookieStore.get(detailPaginationCookieName(accountId))?.value,
  );
  const pageSizeParam = typeof params?.pageSize === "string"
    ? parseInt(params.pageSize, 10)
    : detailPaginationPref?.pageSize ?? 20;
  const pageSize = normalizeDetailPageSize(pageSizeParam);
  const detailPageParam = typeof params?.detailPage === "string"
    ? parseInt(params.detailPage, 10)
    : detailPaginationPref?.detailPage ?? 1;
  const detailPage = normalizeDetailPage(detailPageParam);
  const detailAll = params?.detailAll === "1"
    ? true
    : typeof params?.detailAll === "string"
      ? false
      : detailPaginationPref?.detailAll ?? false;
  const detailDateFrom = typeof params?.detailDateFrom === "string" ? params.detailDateFrom.trim() : "";
  const detailDateTo = typeof params?.detailDateTo === "string" ? params.detailDateTo.trim() : "";
  const detailInFrom = typeof params?.detailInFrom === "string" ? params.detailInFrom.trim() : "";
  const detailInTo = typeof params?.detailInTo === "string" ? params.detailInTo.trim() : "";
  const detailOutFrom = typeof params?.detailOutFrom === "string" ? params.detailOutFrom.trim() : "";
  const detailOutTo = typeof params?.detailOutTo === "string" ? params.detailOutTo.trim() : "";
  const focusEntryId = typeof params?.focusEntryId === "string" ? params.focusEntryId.trim() : "";
  const guideParam = typeof params?.guide === "string" ? params.guide.trim() : "";
  const detailColumnFilters: Record<DetailFilterColumn, string[]> = {
    date: parseDetailFilterParam(params?.detailFilterDate),
    flow: parseDetailFilterParam(params?.detailFilterFlow),
    type: parseDetailFilterParam(params?.detailFilterType),
    category: parseDetailFilterParam(params?.detailFilterCategory),
    related: parseDetailFilterParam(params?.detailFilterRelated),
    remark: parseDetailFilterParam(params?.detailFilterRemark),
  };
  const hasDetailFilters =
    !!(detailDateFrom || detailDateTo || detailInFrom || detailInTo || detailOutFrom || detailOutTo) ||
    Object.values(detailColumnFilters).some((values) => values.length > 0);
  const rawFundCodeParam = typeof params?.fundCode === "string" ? params.fundCode.trim() : "";
  const wealthProductIdParam = typeof params?.wealthProductId === "string" ? params.wealthProductId.trim() : "";
  const fundSortParam = typeof params?.fundSort === "string" ? params.fundSort.trim() : "marketValue";
  const fundSortDirParam = params?.fundSortDir === "asc" ? "asc" : "desc";
  const fundPageSizeParam = typeof params?.fundPageSize === "string" ? parseInt(params.fundPageSize, 10) : 20;
  const fundPageSize = [10, 20, 40].includes(fundPageSizeParam) ? fundPageSizeParam : 20;
  const fundPageParam = typeof params?.fundPage === "string" ? parseInt(params.fundPage, 10) : 1;
  const fundPage = Number.isFinite(fundPageParam) && fundPageParam >= 1 ? fundPageParam : 1;
  const showCleared = params?.showCleared === "1";

  // Read the up/down color scheme.
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const creditBillHideZeroPref = cookieStore.get("mmh_credit_hide_zero_bills")?.value;
  const creditBillHideSettledPref = cookieStore.get("mmh_credit_hide_settled_bills")?.value;
  const creditBillRecentCyclesPref = cookieStore.get("mmh_credit_recent_cycles")?.value;
  const hideZeroBills =
    typeof params?.hideZeroBills === "string"
      ? params.hideZeroBills === "1"
      : creditBillHideZeroPref === "1" || creditBillHideZeroPref === "true";
  const hideSettledBills =
    typeof params?.hideSettledBills === "string"
      ? params.hideSettledBills === "1"
      : creditBillHideSettledPref === "1" || creditBillHideSettledPref === "true";
  const showRecentBillCycles =
    typeof params?.billMonthsLimit === "string"
      ? params.billMonthsLimit !== "all"
      : creditBillRecentCyclesPref == null
        ? true
        : creditBillRecentCyclesPref === "1" || creditBillRecentCyclesPref === "true";
  const billMonthsLimit = showRecentBillCycles ? 10 : 9999;
  const isRedUp = colorScheme === "red_up_green_down";
  const ctx = await getCachedHouseholdScope();
  const { hidFilter, householdId } = ctx;
  const baseCurrency = await getHouseholdBaseCurrency(householdId);
  // Color helper.
  const pnlCls = (n: number) => pnlClassFromRedUp(n, isRedUp);
  // Common data: shared across accounts, cached across requests.
  const common = await loadCommonData(hidFilter);
  const { categories, tags, groups, institutions, counterparties, preciousMetalDictionaries } = common;
  const metalTypes = preciousMetalDictionaries.types;
  const metalUnits = preciousMetalDictionaries.units;
  // Account balance/active state changes frequently and drives financial totals.
  // Read accounts fresh so sidebar, debt view, and detail pages use one source of truth.
  const accounts = await prisma.account.findMany({
    where: { isPlaceholder: { not: true }, ...hidFilter },
    include: { Institution: true, Counterparty: true, AccountGroup: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  // selectedAccount: per-account, deduplicated at request level.
  const selectedAccount = await loadSelectedAccount(accountId || undefined, hidFilter);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(selectedAccount?.fundUnitsDecimals, 3);
  const isBillAccount =
    (selectedAccount?.kind === AccountKind.bank_credit || selectedAccount?.kind === AccountKind.loan) ||
    !!selectedAccount?.billingDay;
  const billAccountIds = selectedAccount && isBillAccount
    ? await getCreditBillAccountIds(prisma, selectedAccount)
    : [];
  const billStorageAccountId = billAccountIds[0] ?? selectedAccount?.id ?? "";
  const isDebtAccount = selectedAccount?.kind === AccountKind.loan;
  const isInvestAccount = selectedAccount ? isPureInvestmentAccount(selectedAccount) : false;
  const isDepositView = selectedAccount ? isDepositAccount(selectedAccount) : false;
  const missingBillingDayForBill =
    viewParam === "bill" &&
    selectedAccount?.kind === AccountKind.bank_credit &&
    !selectedAccount?.billingDay;
  const isOverview = !viewParam && !accountId && !accountName;
  const isInsuranceView = selectedAccount?.kind === AccountKind.insurance;
  const view: "bill" | "detail" | "investfund" | "investmoney" | "investwealth" | "investstock" | "investproperty" | "regularinvest" | "debt" | "overview" | "deposit" | "insurance" =
    isDebtAccount
      ? "debt"
      : viewParam
        ? viewParam
        : isBillAccount
          ? "bill"
          : isDepositView
            ? "deposit"
          : isInsuranceView
            ? "insurance"
          : isInvestAccount
            ? getInvestmentAccountView(selectedAccount)
            : isOverview
              ? "overview"
          : "detail";
  const selectedWealthProductIdParam = view === "investwealth"
    ? (wealthProductIdParam || rawFundCodeParam)
    : "";
  const fundCodeParam = view === "investwealth" ? "" : rawFundCodeParam;
  const needsDetailEntries = view === "detail" || view === "deposit" || view === "insurance" || (view === "bill" && isBillAccount);

  const hid = { householdId };
  const where = accountId
    ? {
        ...txRecordAccountScopeWhere(accountId),
        deletedAt: null,
        ...hid,
      }
    : accountName
      ? { accountName: accountName, deletedAt: null, ...hid }
      : {
          deletedAt: null,
          account: {
            OR: [
              { kind: { not: AccountKind.investment } },
              { kind: AccountKind.investment, investProductType: "deposit" as any },
            ],
            ...hidFilter,
          },
        };

  const insuranceProductsForAccount =
    view === "insurance" && selectedAccount
      ? await prisma.insuranceProduct.findMany({
          where: { ...hidFilter, accountId: selectedAccount.id },
          include: { OwnerGroup: true, InsuredUser: true, InsuredPerson: true, PolicyholderPerson: true },
          orderBy: [{ name: "asc" }],
        })
      : [];
  const insuranceProductIdsForAccount = insuranceProductsForAccount.map((product) => product.id);

  const rawEntries = needsDetailEntries
    ? accountId
      ? view === "insurance" && selectedAccount
        ? await prisma.txRecord.findMany({
            where: {
              ...hid,
              deletedAt: null,
              type: "investment",
              source: "insurance",
              OR: [
                { accountId },
                { toAccountId: accountId },
                ...(insuranceProductIdsForAccount.length > 0
                  ? [{ insuranceProductId: { in: insuranceProductIdsForAccount } }]
                  : []),
              ],
            },
            include: {
              EntryTag: { include: { Tag: true } },
              ...entryBusinessLinkSummaryInclude,
              account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
              toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            },
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: 5000,
          })
        : view === "bill" && isBillAccount && billAccountIds.length > 0
          ? await prisma.txRecord.findMany({
              where: {
                ...hid,
                deletedAt: null,
                ...txRecordAccountScopeWhere(billAccountIds),
              },
              include: {
                EntryTag: { include: { Tag: true } },
                ...entryBusinessLinkSummaryInclude,
                account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
                toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
              },
              orderBy: [{ date: "desc" }, { createdAt: "desc" }],
              take: 5000,
            })
        : await loadEntriesForAccount(accountId, JSON.stringify(hidFilter))
      : await prisma.txRecord.findMany({
          where,
          include: {
            EntryTag: { include: { Tag: true } },
            ...entryBusinessLinkSummaryInclude,
            account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 5000,
        })
    : [];
  const entryDisplayDate = (e: (typeof rawEntries)[number]) => getDetailEntryDisplayDate(e, accountId);
  const entries = [...rawEntries].sort((a, b) => compareDetailEntriesDesc(a, b, accountId));
  const accountMetaById = new Map(accounts.map((account) => [account.id, account]));
  const isSettlementDebtAccountId = (id?: string | null) => {
    if (!id) return false;
    const account = accountMetaById.get(id);
    if (!account || account.kind !== AccountKind.loan) return false;
    return !!account.counterpartyId || account.Institution?.type !== "bank";
  };
  const isCreditCardRepaymentForDisplay = (e: (typeof entries)[number]) => {
    if (isSettlementDebtAccountId(e.accountId) || isSettlementDebtAccountId(e.toAccountId)) return false;
    return isCreditCardRepaymentTransfer({
      type: e.type,
      accountKind: e.account?.kind ?? accountMetaById.get(e.accountId ?? "")?.kind ?? null,
      toAccountKind: e.toAccount?.kind ?? accountMetaById.get(e.toAccountId ?? "")?.kind ?? null,
    });
  };
  const getEntryDisplayNote = (e: (typeof entries)[number]) => {
    const fromNote = (e.note ?? "").trim();
    const receiverNote = (e.toNote ?? "").trim();
    const displayNote = !accountId
      ? fromNote
      : e.toAccountId === accountId ? (receiverNote || fromNote) : fromNote;
    return getInsuranceDetailNote({
      source: e.source,
      fundName: e.fundName,
      fundSubtype: e.fundSubtype,
      note: displayNote,
    });
  };
  const getDetailFilterColumnValue = (e: (typeof entries)[number], column: DetailFilterColumn) => {
    const amount = toNumber(e.amount);
    const effectiveAmount = effectiveAmountForAccount(e, accountId);
    const balanceTarget = getBalanceReconcileTarget(e);
    if (column === "date") return entryDisplayDate(e).toISOString().slice(0, 10);
    if (column === "flow" && balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE) return t("detailView.initialBalance");
    if (column === "flow" && e.source === BALANCE_RECONCILE_SOURCE) return t("detailView.balanceReconcile");
    if (column === "flow") return effectiveAmount >= 0 ? t("detail.column.inflow") : t("detail.column.outflow");
    if (column === "type" && balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE) return t("detailView.initialBalance");
    if (column === "type" && e.source === BALANCE_RECONCILE_SOURCE) return t("detailView.balanceReconcile");
    if (column === "type") {
      if (e.source === "insurance") return getInsuranceDetailCategoryName(e);
      if (e.source === "advance") return t("txForm.advance");
      if (e.type === "investment" && e.fundProductType === "deposit") return t("detailView.deposit");
      return e.type === "investment" && e.fundSubtype ? (fundSubtypeInfo(t, e.fundSubtype, e.source, amount, e.fundProductType)?.label ?? formatType(t, e.type)) : formatType(t, e.type);
    }
    if (column === "category") {
      if (isCreditCardRepaymentForDisplay(e)) return t("transaction.category.creditCardRepayment");
      if (e.type === TransactionType.investment) {
        if (e.source === "insurance") return getInsuranceDetailCategoryName(e);
        return e.categoryName || getInvestmentCategoryName(e) || t("detail.emptyValue");
      }
      return getInsuranceDetailCategoryName(e) || t("detail.emptyValue");
    }
    if (column === "related") {
      const related = accountId && e.toAccountId === accountId ? (e.accountName ?? "") : (e.toAccountName ?? "");
      return related.trim() || t("detail.emptyValue");
    }
    return getEntryDisplayNote(e) || t("detail.emptyValue");
  };
  const detailDateInRange = (v: string) => {
    let f = detailDateFrom;
    let t = detailDateTo;
    if (f && t && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (!f && !t) return true;
    if (!v) return false;
    if (f && v < f) return false;
    if (t && v > t) return false;
    return true;
  };

  const parseRangeNumber = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const detailInFromN = parseRangeNumber(detailInFrom);
  const detailInToN = parseRangeNumber(detailInTo);
  const detailOutFromN = parseRangeNumber(detailOutFrom);
  const detailOutToN = parseRangeNumber(detailOutTo);

  const detailNumberInRange = (n: number, fromN: number | null, toN: number | null) => {
    let f = fromN;
    let t = toN;
    if (f != null && t != null && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (f != null && n < f) return false;
    if (t != null && n > t) return false;
    return true;
  };

  const filteredEntries = entries.filter((e) => (Object.keys(detailColumnFilters) as DetailFilterColumn[]).every((column) => {
    const allowedValues = detailColumnFilters[column];
    const v = getDetailFilterColumnValue(e, column);
    if (allowedValues.length > 0 && !allowedValues.includes(v)) return false;
    if (column === "date" && (detailDateFrom || detailDateTo) && !detailDateInRange(v)) return false;
    return true;
  }));
  const filteredEntries2 = filteredEntries.filter((e) => {
    const effectiveAmount = effectiveAmountForAccount(e, accountId);
    const inflow = effectiveAmount > 0 ? effectiveAmount : null;
    const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
    if ((detailInFromN != null || detailInToN != null)) {
      if (inflow == null) return false;
      if (!detailNumberInRange(inflow, detailInFromN, detailInToN)) return false;
    }
    if ((detailOutFromN != null || detailOutToN != null)) {
      if (outflow == null) return false;
      if (!detailNumberInRange(outflow, detailOutFromN, detailOutToN)) return false;
    }
    return true;
  });
  const detailTotalPages = Math.max(1, Math.ceil(filteredEntries2.length / pageSize));
  const focusEntryIndex = focusEntryId
    ? filteredEntries2.findIndex((entry) => entry.id === focusEntryId)
    : -1;
  const focusDetailPage = focusEntryIndex >= 0
    ? Math.floor(focusEntryIndex / pageSize) + 1
    : null;
  const safeDetailPage = detailAll ? 1 : Math.min(focusDetailPage ?? detailPage, detailTotalPages);
  const categoryLabels = buildCategoryPathLabels(categories);
  const exportCategoryLabels = buildCategoryExportLabels(t, categories);
  const getExportCategoryName = (e: (typeof filteredEntries2)[number]) => {
    if (isCreditCardRepaymentForDisplay(e)) return t("transaction.category.creditCardRepayment");
    if (e.categoryId) return exportCategoryLabels.get(e.categoryId) ?? stripExportCategoryRootLabel(e.categoryName);
    if (e.type === TransactionType.investment) {
      if (e.source === "insurance") return getInsuranceDetailCategoryName(e);
      return stripExportCategoryRootLabel(e.categoryName) || getInvestmentCategoryName(e) || "";
    }
    return stripExportCategoryRootLabel(e.categoryName);
  };
  const normalExportRows = (() => {
    const rows = [[
      t("detail.column.date"),
      t("detailView.column.type"),
      t("detail.column.category"),
      t("detail.column.outflow"),
      t("detail.column.inflow"),
      t("common.account"),
      t("batchImport.field.counterAccount"),
      t("detail.column.counterparty"),
      t("detail.column.tags"),
      t("detail.column.remark"),
    ]];
    for (const e of filteredEntries2) {
      const effectiveAmount = effectiveAmountForAccount(e, accountId);
      const outflow = effectiveAmount < 0 ? String(-effectiveAmount) : "";
      const inflow = effectiveAmount > 0 ? String(effectiveAmount) : "";
      const isToSide = accountId && e.toAccountId === accountId;
      const accountLabel = isToSide
        ? exportAccountLabel(e.toAccount, e.toAccountName)
        : exportAccountLabel(e.account, e.accountName);
      const counterAccountLabel = e.type === TransactionType.transfer || e.type === TransactionType.investment
        ? isToSide
          ? exportAccountLabel(e.account, e.accountName)
          : exportAccountLabel(e.toAccount, e.toAccountName)
        : "";
      const tagsText = (e.EntryTag || [])
        .map((entryTag) => entryTag.Tag?.name?.trim() || "")
        .filter(Boolean)
        .join("、");
      rows.push([
        entryDisplayDate(e).toISOString().slice(0, 10),
        e.source === "insurance" ? getInsuranceDetailCategoryName(e) : formatType(t, e.type),
        getExportCategoryName(e),
        outflow,
        inflow,
        accountLabel,
        counterAccountLabel,
        e.counterpartyInstitutionName ?? "",
        tagsText,
        getEntryDisplayNote(e),
      ]);
    }
    return rows;
  })();
  const normalExportFilename = t("sidebar.export.filename", {
    name: selectedAccount?.name || accountName || t("statistics.allAccounts"),
  });

  const expenseCategories = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  const incomeCategories = categories
    .filter((c) => c.type === "income")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  const advanceCategories = categories
    .filter((c) => c.type === "advance")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
  const categoryBatchReplaceOptions = (() => {
    const typeLabels: Record<string, string> = {
      expense: t("stats.expenseCategories"),
      income: t("categoryType.income"),
      advance: t("categoryType.advance"),
      transfer: t("categoryType.transfer"),
      investment: t("categoryType.investment"),
    };
    const typeOrder = ["expense", "income", "advance", "transfer", "investment"];
    const options: Array<{
      value: string;
      label: string;
      subLabel?: string;
      parentId?: string;
      isHeader?: boolean;
      isGroup?: boolean;
      categoryType?: string;
    }> = [];
    const indent = "　";

    for (const type of typeOrder) {
      const typedCategories = categories.filter((category) => category.type === type);
      if (typedCategories.length === 0) continue;

      const childrenByParentId = new Map<string | null, typeof typedCategories>();
      for (const category of typedCategories) {
        const key = category.parentId ?? null;
        const list = childrenByParentId.get(key) ?? [];
        list.push(category);
        childrenByParentId.set(key, list);
      }
      for (const list of childrenByParentId.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      }

      const headerId = `category-type:${type}`;
      options.push({ value: headerId, label: typeLabels[type] ?? type, isHeader: true, categoryType: type });

      function walk(parentId: string | null, level: number, parentOptionId: string) {
        const children = childrenByParentId.get(parentId) ?? [];
        for (const child of children) {
          const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
          options.push({
            value: child.id,
            label: `${indent.repeat(level)}${child.name}`,
            subLabel: typeLabels[type] ?? type,
            parentId: parentOptionId,
            isGroup: hasChildren,
            categoryType: type,
          });
          if (hasChildren) walk(child.id, level + 1, child.id);
        }
      }

      walk(null, 0, headerId);
    }

    return options;
  })();

  const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    accounts
      .filter((account) => !isPureInvestmentAccount(account) && account.kind !== AccountKind.insurance)
      .map((account) => ({
        id: account.id,
        kind: account.kind,
        investProductType: account.investProductType,
        billingDay: account.billingDay,
      })),
    hidFilter,
  );
  const insuranceDisplayBalanceByAccountId = await computeInsuranceAccountDisplayBalances(
    accounts
      .filter((account) => account.kind === AccountKind.insurance)
      .map((account) => account.id),
    hidFilter,
  );
  const debtDisplaySummary = await computeDebtDisplaySummary(ctx);
  const investBalByAccountId = await computeInvestBalances(ctx);

  const accountDisplayValueById = new Map<string, number>();
  for (const account of accounts) {
    const value = isPureInvestmentAccount(account)
      ? investBalByAccountId.get(account.id)?.marketValue ?? toNumber(account.balance)
      : account.kind === AccountKind.insurance
        ? insuranceDisplayBalanceByAccountId.get(account.id) ?? 0
        : account.kind === AccountKind.loan
          ? debtDisplaySummary.balanceByAccountId.get(account.id) ?? cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance)
          : cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    accountDisplayValueById.set(account.id, value);
  }
  const netWorthConversion = await convertCurrencyAmounts({
    householdId,
    amounts: accounts.map((account) => ({
      amount: accountDisplayValueById.get(account.id) ?? 0,
      currency: account.currency,
    })),
    toCurrency: baseCurrency,
    refreshMissing: true,
  });
  const fxRateByCurrency = new Map(netWorthConversion.rates.map((rate) => [rate.fromCurrency, rate]));
  const convertedAccountValueById = new Map<string, number | null>();
  for (const account of accounts) {
    const rate = fxRateByCurrency.get(normalizeCurrency(account.currency));
    convertedAccountValueById.set(
      account.id,
      rate?.rate == null ? null : (accountDisplayValueById.get(account.id) ?? 0) * rate.rate,
    );
  }
  const totalNetWorthValue = netWorthConversion.total;
  const missingFxCurrencies = netWorthConversion.missingCurrencies;
  const monthGrowthValue = 0; // TODO: Real calculation

  const balanceByEntryId = new Map<string, number>();
  if (where) {
    const asc = [...rawEntries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    let running = 0;
    for (const e of asc) {
      running = applyBalanceReconcileEntry(running, e, accountId);
      balanceByEntryId.set(e.id, running);
    }
  }

  const selectedAccountLabel = (() => {
    if (view === "debt") return t("account.kind.loan");
    if (selectedAccount) {
      const display = buildAccountDisplayOption({
        id: selectedAccount.id,
        name: selectedAccount.name,
        kind: selectedAccount.kind,
        numberMasked: selectedAccount.numberMasked,
        groupId: selectedAccount.groupId,
        investProductType: selectedAccount.investProductType,
        Institution: selectedAccount.Institution,
        AccountGroup: selectedAccount.AccountGroup,
      }, selectedAccount.kind === AccountKind.bank_credit ? SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE : creditCardLabelTemplate);
      const accountLabel = display.label;
      if (isPureInvestmentAccount(selectedAccount)) return accountLabel;
      if (isDepositAccount(selectedAccount)) return `${t("entry.kind.deposit")} / ${accountLabel}`;
      if (selectedAccount.kind === AccountKind.insurance) return `${t("entry.kind.insurance")} / ${accountLabel}`;
      const group = selectedAccount.kind === AccountKind.loan ? "" : (selectedAccount.AccountGroup?.name ?? "").trim();
      return [group, accountLabel].filter(Boolean).join(" / ");
    }
    return accountName || "";
  })();

  const accountOptions = accounts
    .filter(a => a.name !== "未指定账户")
    .map((a) => {
    const display = buildAccountDisplayOption({
      id: a.id,
      name: a.name,
      kind: a.kind,
      numberMasked: a.numberMasked,
      groupId: a.groupId,
      investProductType: a.investProductType,
      Institution: a.Institution,
      AccountGroup: a.AccountGroup,
    }, creditCardLabelTemplate);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      numberMasked: a.numberMasked,
      label: display.selectorLabel,
      fullLabel: display.fullLabel,
      title: display.hoverTitle,
      hoverTitle: display.hoverTitle,
      groupId: display.groupId,
      groupName: display.groupName,
      institutionName: display.institutionName,
      institutionId: a.institutionId ?? "",
      institutionType: a.Institution?.type ?? "",
      investProductType: a.investProductType,
      debtDirection: a.debtDirection ?? null,
      billingDay: a.billingDay ?? null,
      subLabel: kindLabel(a.kind),
      currency: a.currency ?? "CNY",
    };
  });

  // Build hierarchical SmartSelect options: grouped by AccountGroup (isHeader),
  // ungrouped accounts shown flat with institution as subLabel
  type SSOpt = { id: string; label: string; subLabel?: string; title?: string; isHeader?: boolean; isGroup?: boolean; parentId?: string; kind?: string | null; investProductType?: string | null; debtDirection?: string | null; institutionId?: string | null; billingDay?: number | null; currency?: string | null };
  const joinSSSubLabel = (parts: Array<string | null | undefined>) => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const text = part?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
    return result.join(" · ");
  };
  function buildAccountSSOptions(filter?: (a: typeof accountOptions[number]) => boolean): SSOpt[] {
    const filtered = filter ? accountOptions.filter(filter) : accountOptions;
    const grouped = filtered.filter(a => a.groupId);
    const ungrouped = filtered.filter(a => !a.groupId);

    // Build group header entries — exclude the unspecified group (stored group name is user data).
    const groupHeaders: SSOpt[] = groups
      .filter(g => g.name !== "未指定")
      .filter(g => grouped.some(a => a.groupId === g.id))
      .map(g => ({ id: `group:${g.id}`, label: g.name, isHeader: true }));

    // Build grouped account entries (parentId → group header)
    // Also exclude accounts belonging to excluded groups
    const excludedGroupIds = new Set(groups.filter(g => g.name === "未指定").map(g => g.id));
    const groupedItems: SSOpt[] = grouped
      .filter(a => !excludedGroupIds.has(a.groupId))
      .map(a => ({
        id: a.id,
        label: a.label,
        subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
        title: a.hoverTitle,
        parentId: `group:${a.groupId}`,
        kind: a.kind,
        investProductType: a.investProductType ?? null,
        debtDirection: a.debtDirection ?? null,
        institutionId: a.institutionId || null,
        billingDay: a.billingDay ?? null,
        currency: a.currency ?? null,
      }));

    // Build ungrouped account entries (no parentId)
    const ungroupedItems: SSOpt[] = ungrouped.map(a => ({
      id: a.id,
      label: a.label,
      subLabel: joinSSSubLabel([a.subLabel]),
      title: a.hoverTitle,
      kind: a.kind,
      investProductType: a.investProductType ?? null,
      debtDirection: a.debtDirection ?? null,
      institutionId: a.institutionId || null,
      billingDay: a.billingDay ?? null,
      currency: a.currency ?? null,
    }));

    return [...groupHeaders, ...groupedItems, ...ungroupedItems];
  }

  const spendingAccountOptions = accounts
    .filter((a) => a.name !== "未指定账户" && !isPureInvestmentAccount(a))
    .map((a) => {
      const display = buildAccountDisplayOption({
        id: a.id,
        name: a.name,
        kind: a.kind,
        numberMasked: a.numberMasked,
        groupId: a.groupId,
        investProductType: a.investProductType,
        Institution: a.Institution,
        AccountGroup: a.AccountGroup,
      }, creditCardLabelTemplate);
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        label: display.selectorLabel,
        title: display.hoverTitle,
        hoverTitle: display.hoverTitle,
        groupId: display.groupId,
        groupName: display.groupName,
        institutionId: a.institutionId ?? "",
        institutionType: a.Institution?.type ?? "",
        investProductType: a.investProductType,
        debtDirection: a.debtDirection ?? null,
        billingDay: a.billingDay ?? null,
        subLabel: kindLabel(a.kind),
        currency: a.currency ?? "CNY",
      };
    });
  const investmentAccountOptions = accounts
    .filter((a) => isPureInvestmentAccount(a) || isDepositAccount(a))
    .map((a) => {
      const display = buildAccountDisplayOption({
        id: a.id,
        name: a.name,
        kind: a.kind,
        numberMasked: a.numberMasked,
        groupId: a.groupId,
        investProductType: a.investProductType,
        Institution: a.Institution,
        AccountGroup: a.AccountGroup,
      }, creditCardLabelTemplate);
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        label: display.selectorLabel,
        title: display.hoverTitle,
        hoverTitle: display.hoverTitle,
        groupId: display.groupId,
        groupName: display.groupName,
        institutionId: a.institutionId ?? "",
        institutionType: a.Institution?.type ?? "",
        investProductType: a.investProductType,
        subLabel: kindLabel(a.kind),
        currency: a.currency ?? "CNY",
      };
    });
  const accountLabelById = new Map(accountOptions.map((a) => [a.id, a.label]));
  const investmentProductTypeByAccountId = new Map(investmentAccountOptions.map((a) => [a.id, a.investProductType]));
  const investmentProductTypeByAccountIdObj = Object.fromEntries(investmentProductTypeByAccountId);
  const defaultFundInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && (selectedAccount.investProductType === "fund" || selectedAccount.investProductType === "money")
      ? selectedAccount.id
      : investmentAccountOptions.find((account) => account.investProductType === "fund" || account.investProductType === "money")?.id ?? "";
  const defaultMetalInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "metal"
      ? selectedAccount.id
      : investmentAccountOptions.find((account) => account.investProductType === "metal")?.id ?? "";
  const stockAccountOptions = investmentAccountOptions.filter((account) => account.investProductType === "stock");
  const defaultStockInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "stock"
      ? selectedAccount.id
      : stockAccountOptions[0]?.id ?? "";
  const propertyAccountOptions = investmentAccountOptions.filter((account) => account.investProductType === "property");
  const defaultPropertyInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "property"
      ? selectedAccount.id
      : propertyAccountOptions[0]?.id ?? "";
  const defaultInvestmentCreateAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount)
      ? selectedAccount.id
      : (defaultFundInvestmentAccountId || (investmentAccountOptions.find((account) => account.investProductType !== "deposit")?.id ?? ""));

  // Pre-computed hierarchical SS options for modal props
  const allAccountSSOptions = buildAccountSSOptions(); // all accounts for transfer dropdown
  const cashAccountSSOptions = buildAccountSSOptions(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet");
  // Transfers in the cash view stay unchanged: just exclude investment accounts.
  // In the stock view, transfers only allow cash accounts (bank_debit/ewallet) of the same owner.
  const transferOwnerGroupId = (selectedAccount?.groupId ?? "").trim();
  const isStockTransferEligibleAccount = (a: (typeof accountOptions)[number]) =>
    (a.kind === "bank_debit" || a.kind === "ewallet")
    && (!transferOwnerGroupId || a.groupId === transferOwnerGroupId);
  const transferAccountSSOptions = view === "investstock"
    ? buildAccountSSOptions(isStockTransferEligibleAccount)
    : buildAccountSSOptions(a => !isPureInvestmentAccount(a));
  const transferAccountOptions = view === "investstock"
    ? accountOptions.filter(isStockTransferEligibleAccount)
    : accountOptions.filter(a => !isPureInvestmentAccount(a));
  const stockAccountSSOptions = buildAccountSSOptions(a => a.kind === "investment" && a.investProductType === "stock");
  const propertyAccountSSOptions = buildAccountSSOptions(a => a.kind === "investment" && a.investProductType === "property");
  const debtTransferAccountSSOptions = buildAccountSSOptions(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet" || a.kind === "bank_credit");
  const debtCounterpartyOptions = counterparties;
  const debtSourceInstitutions = institutions.filter((institution) => institution.type === "bank");
  const debtObjectOptions: SSOpt[] = [
    ...(debtCounterpartyOptions.length > 0
      ? [
          { id: "debt-counterparty-header", label: t("txForm.counterparty"), isHeader: true },
          ...debtCounterpartyOptions.map((counterparty) => ({
            id: `counterparty:${counterparty.id}`,
            label: counterparty.shortName?.trim() || counterparty.name,
            subLabel: counterparty.type === "person" ? t("sidebar.debt.counterpartyPerson") : t("sidebar.debt.counterpartyOrganization"),
          })),
        ]
      : []),
    ...(debtSourceInstitutions.length > 0
      ? [
          { id: "debt-institution-source-header", label: t("sidebar.debt.institutionSource"), isHeader: true },
          ...debtSourceInstitutions.map((institution) => ({
            id: `institution:${institution.id}`,
            label: institution.shortName?.trim() || institution.name,
            subLabel: institutionTypeLabel(institution.type ?? null),
          })),
        ]
      : []),
  ];
  const spendingAccountSSOptions = buildAccountSSOptions(a => a.kind !== "investment" || a.investProductType === "deposit");
  const investmentAccountSSOptions = buildFlatAccountOptions(accountOptions.filter(a => isPureInvestmentAccount(a) || isDepositAccount(a)));
  // Flat lists for components that don't use SS hierarchy (backward compat)
  const cashAccountList = accountOptions
    .filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet")
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      groupId: a.groupId ?? "",
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
      currency: a.currency,
    }));
  const debtTransferAccountList = accountOptions
    .filter(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet" || a.kind === "bank_credit")
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      groupId: a.groupId ?? "",
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
      currency: a.currency,
    }));
  const investmentAccountList = accountOptions
    .filter(a => isPureInvestmentAccount(a) || isDepositAccount(a))
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      groupId: a.groupId ?? "",
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      investProductType: a.investProductType ?? null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
      currency: a.currency,
    }));
  // NestedAddModal fieldData for groups & institutions
  const nestedFieldData = {
    groupId: groups.filter(g => g.name !== "未指定").map(g => ({ id: g.id, name: g.name })),
    institutionId: institutions.map(it => ({ id: it.id, name: it.name, type: it.type ?? "" })),
    counterpartyId: counterparties.map(it => ({ id: it.id, name: it.shortName?.trim() || it.name, type: it.type ?? "organization" })),
  };

  const debtAccounts = accounts.filter((account) => account.kind === AccountKind.loan && account.isActive);
  const loanRepaymentPlans =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.regularInvestPlan.findMany({
          where: {
            ...hid,
            accountId: { in: debtAccounts.map((account) => account.id) },
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          select: {
            id: true,
            accountId: true,
            amount: true,
            intervalUnit: true,
            intervalValue: true,
            executionDay: true,
            memo: true,
            startDate: true,
            nextRunDate: true,
            lastRunDate: true,
            cashAccountId: true,
            totalRuns: true,
            executedRuns: true,
            status: true,
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
        })
      : [];
  const loanRateAdjustmentsByAccountId =
    view === "debt" && loanRepaymentPlans.length > 0
      ? await listLoanRateAdjustmentsByAccountIds({
          householdId,
          accountIds: loanRepaymentPlans.map((plan) => plan.accountId),
        })
      : new Map<string, Array<{ effectiveDate: string; annualRate: number }>>();
  const debtBorrowLprDiscountEntries =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            ...hid,
            source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
            accountId: { in: debtAccounts.map((account) => account.id) },
          },
          select: { accountId: true, note: true, toNote: true },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: debtAccounts.length * 5,
        })
      : [];
  const debtBorrowLprDiscountByAccountId = new Map<string, number>();
  for (const entry of debtBorrowLprDiscountEntries) {
    const discount = parseMortgageLprDiscountFromText(entry.note) ?? parseMortgageLprDiscountFromText(entry.toNote);
    if (discount != null && !debtBorrowLprDiscountByAccountId.has(entry.accountId)) {
      debtBorrowLprDiscountByAccountId.set(entry.accountId, discount);
    }
  }
  const loanRepaymentPlanByAccountId = new Map<string, (typeof loanRepaymentPlans)[number]>();
  for (const plan of loanRepaymentPlans) {
    const existing = loanRepaymentPlanByAccountId.get(plan.accountId);
    if (!existing || (existing.status !== RegularInvestStatus.active && plan.status === RegularInvestStatus.active)) {
      loanRepaymentPlanByAccountId.set(plan.accountId, plan);
    }
  }
  const {
    debtRows,
    debtRowsForShell,
    selectedDebtKey,
    selectedDebtRow,
    selectedDebtObjectValue,
    ordinaryDebtAccountIds,
  } = buildDebtRowsViewData({
    debtAccounts,
    cashDisplayBalanceByAccountId,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
    debtBorrowLprDiscountByAccountId,
    selectedAccountId: selectedAccount?.id,
    selectedAccountKind: selectedAccount?.kind,
    debtPersonParam,
  });
  const selectedRepaymentPlan = selectedDebtRow ? loanRepaymentPlanByAccountId.get(selectedDebtRow.accountId) ?? null : null;
  const repaymentScheduleRows = buildDebtRepaymentScheduleRows({ selectedDebtRow, selectedRepaymentPlan });

  const loanRepaymentPlanIds = loanRepaymentPlans.map((plan) => plan.id);
  const debtEntriesRaw =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            ...hid,
            OR: [
              { accountId: { in: debtAccounts.map((account) => account.id) } },
              { toAccountId: { in: debtAccounts.map((account) => account.id) } },
              ...(loanRepaymentPlanIds.length > 0 ? [{ regularInvestPlanId: { in: loanRepaymentPlanIds } }] : []),
            ],
          },
          include: {
            EntryTag: { include: { Tag: true } },
            ...entryBusinessLinkSummaryInclude,
            account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 3000,
        })
      : [];
  applyDebtRowEntryMetrics({
    debtRows,
    debtEntriesRaw,
    loanRepaymentPlans,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
    displayAccountId: accountId,
  });
  const debtShellRemainingTotal = debtRowsForShell.reduce((sum, row) => sum + row.remainingTotal, 0);
  const debtDisplaySummaryValue = debtShellRemainingTotal;
  const selectedDebtAccountIds = new Set(selectedDebtRow?.accountIds ?? ordinaryDebtAccountIds);
  const debtAccountLabelById = new Map(
    debtAccounts.map((account) => [
      account.id,
      (account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name),
    ]),
  );
  const debtDirectionByAccountId = new Map(
    debtAccounts.map((account) => [account.id, account.debtDirection ?? null]),
  );
  const selectedLoanRepaymentPlanIds = new Set(
    loanRepaymentPlans
      .filter((plan) => selectedDebtAccountIds.has(plan.accountId))
      .map((plan) => plan.id),
  );
  const { debtDetailEntries, repaymentScheduleRows: finalRepaymentScheduleRows } = buildDebtDetailEntriesViewData({
    debtEntriesRaw,
    selectedDebtAccountIds,
    selectedLoanRepaymentPlanIds,
    selectedDebtRow,
    selectedRepaymentPlan,
    repaymentScheduleRows,
    accountLabelById,
    debtDirectionByAccountId,
    displayAccountId: accountId,
  });

  // Query the most recently used cash account.
  const lastUsedCashAccount = isInvestAccount && accountId
    ? await prisma.txRecord.findFirst({
        where: {
          toAccountId: accountId,
          fundProductType: { not: null },
          accountId: { not: accountId },
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { accountId: true },
      })
    : null;

  const {
    creditCardBill,
    settledBillMonth,
    lastRepayToAccountId,
    lastRepayFromAccountId,
    creditBillSummaryRows,
    selectedCreditBillMonth,
    creditBillBalanceValue,
    creditCardBillDetails,
    currentPage,
    billListPageSize,
    hasCreditBillSummaries,
    showAllCreditBillDetails,
  } = await loadCreditBillPageData({
    householdId,
    selectedAccount,
    isBillAccount,
    billAccountIds,
    billStorageAccountId,
    billMonthParam,
    billPage,
    billMonthsLimit,
    hideZeroBills,
    hideSettledBills,
    showRecentBillCycles,
    view,
    categoryLabels,
    isSettlementDebtAccountId,
    isCreditCardRepaymentForDisplay,
  });

  const selectedAccountRawBalanceValue = selectedAccount
    ? isPureInvestmentAccount(selectedAccount)
      ? investBalByAccountId.get(selectedAccount.id)?.marketValue ?? toNumber(selectedAccount.balance)
      : selectedAccount.kind === AccountKind.bank_credit
        ? creditBillBalanceValue
      : selectedAccount.kind === AccountKind.loan
        ? debtDisplaySummary.balanceByAccountId.get(selectedAccount.id) ?? cashDisplayBalanceByAccountId.get(selectedAccount.id) ?? toNumber(selectedAccount.balance)
        : cashDisplayBalanceByAccountId.get(selectedAccount.id) ?? toNumber(selectedAccount.balance)
    : 0;
  const selectedAccountFxRate = selectedAccount ? fxRateByCurrency.get(normalizeCurrency(selectedAccount.currency)) : null;
  const selectedAccountCurrency = selectedAccount ? normalizeCurrency(selectedAccount.currency) : baseCurrency;
  const showSelectedAccountFxInline = !!selectedAccount && selectedAccountCurrency !== baseCurrency;

  const investDataParams = JSON.stringify({
    fundSortParam,
    fundSortDirParam,
    fundPageSize,
    fundPage,
    fundCodeParam,
    wealthProductIdParam: selectedWealthProductIdParam,
  });
  const investDataHidFilter = JSON.stringify(hidFilter);
  const investmoneyData = view === "investmoney" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const investwealthData = view === "investwealth" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const investstockData = view === "investstock" && accountId
    ? await computePositionDisplay(ctx, accountId)
    : null;
  const investpropertyData = view === "investproperty" && accountId
    ? await computePositionDisplay(ctx, accountId)
    : null;
  const investfundData = view === "investfund" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const currentInvestData =
    view === "investfund"
      ? investfundData
      : view === "investmoney"
        ? investmoneyData
        : view === "investwealth"
          ? investwealthData
          : null;
  const isFundLikeInvestView = view === "investfund" || view === "investmoney";
  const currentFundDefault = currentInvestData && isFundLikeInvestView
    ? currentInvestData.positions.find((position) => position.fundCode === currentInvestData.selectedFundCode)
    : null;

  const baseQuery = new URLSearchParams();
  if (accountId) baseQuery.set("accountId", accountId);
  else if (accountName) baseQuery.set("account", accountName);
  const detailLinkedWealthIds = Array.from(new Set((filteredEntries2 || []).flatMap((entry: any) =>
    [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
      .map((link: any) => link.wealthTransactionId)
      .filter(Boolean),
  )));
  const detailLinkedWealthRows = detailLinkedWealthIds.length > 0
    ? await prisma.wealthTransaction.findMany({
        where: { id: { in: detailLinkedWealthIds }, householdId, deletedAt: null },
        include: { WealthProduct: true, Account: true, CashAccount: true },
      })
    : [];
  const detailLinkedWealthById = new Map(detailLinkedWealthRows.map((row) => [row.id, row]));
  const linkedWealthRowOf = (entry: any) => {
    const link = [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
      .find((item: any) => item.wealthTransactionId && detailLinkedWealthById.has(item.wealthTransactionId));
    return link?.wealthTransactionId ? detailLinkedWealthById.get(link.wealthTransactionId) ?? null : null;
  };

  // Convert filtered entries to serializable format for client-side detail paging.
  const allDetailEntries: DetailEntry[] = (filteredEntries2 || []).map((e) => {
    const linkedWealth = linkedWealthRowOf(e);
    const linkedWealthAction = linkedWealth?.action ?? null;
    const linkedWealthIsCashIn =
      linkedWealthAction === FundSubtype.redeem ||
      linkedWealthAction === FundSubtype.switch_out ||
      linkedWealthAction === FundSubtype.dividend_cash;
    const linkedWealthGrossAmount = linkedWealth ? Math.abs(toNumber(linkedWealth.grossAmount)) : null;
    const linkedWealthArrivalAmount = linkedWealth?.arrivalAmount != null ? Math.abs(toNumber(linkedWealth.arrivalAmount)) : null;
    const linkedWealthAmount = linkedWealth && linkedWealthGrossAmount != null
      ? linkedWealthIsCashIn
        ? linkedWealthGrossAmount
        : -linkedWealthGrossAmount
      : toNumber(e.amount);
    return ({
    id: e.id,
    cashEntryId: linkedWealth?.cashEntryId ?? e.id,
    businessTransactionId: linkedWealth?.id ?? null,
    date: entryDisplayDate(e).toISOString().slice(0, 10),
    postedAt: toDateOnlyLocalOrNull(e.postedAt),
    createdAt: toIsoOrNull(e.createdAt),
    dayOrder: e.dayOrder ?? 0,
    amount: linkedWealthAmount,
    currency: e.currency ?? "CNY",
    runningBalance: balanceByEntryId.get(e.id) ?? null,
    type: e.type,
    categoryId: e.categoryId,
    categoryName: e.categoryName,
    accountId: e.accountId,
    accountName: e.accountName,
    accountKind: e.account?.kind ?? null,
    accountDebtDirection: e.account?.debtDirection ?? null,
    accountIsSettlementDebt: isSettlementDebtAccountId(e.accountId),
    counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
    counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
    toAccountId: e.toAccountId,
    toAccountName: e.toAccountName,
    toAccountKind: e.toAccount?.kind ?? null,
    toAccountDebtDirection: e.toAccount?.debtDirection ?? null,
    toAccountIsSettlementDebt: isSettlementDebtAccountId(e.toAccountId),
    note: linkedWealth
      ? buildWealthCashFlowNote({
          action: linkedWealth.action,
          productName: linkedWealth.WealthProduct?.name ?? linkedWealth.productName ?? e.fundName,
          units: linkedWealth.units == null ? null : toNumber(linkedWealth.units),
          userNote: linkedWealth.note,
        })
      : e.note,
    businessNote: linkedWealth?.note ?? null,
    toNote: e.toNote,
    fundSubtype: linkedWealth?.action ?? e.fundSubtype,
    fundCode: linkedWealth ? null : e.fundCode,
    fundName: linkedWealth?.WealthProduct?.name ?? linkedWealth?.productName ?? e.fundName,
    wealthProductId: linkedWealth?.wealthProductId ?? e.wealthProductId ?? null,
    source: e.source,
    insuranceProductId: e.insuranceProductId ?? null,
    debtPrincipalAmount: e.debtPrincipalAmount != null ? toNumber(e.debtPrincipalAmount) : null,
    debtInterestAmount: e.debtInterestAmount != null ? toNumber(e.debtInterestAmount) : null,
    debtFeeAmount: e.debtFeeAmount != null ? toNumber(e.debtFeeAmount) : null,
    realizedProfit: e.realizedProfit != null ? toNumber(e.realizedProfit) : null,
    depositAnnualRate: linkedWealth?.annualRate != null ? toNumber(linkedWealth.annualRate) : e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
    depositInterest: linkedWealth?.interest != null ? toNumber(linkedWealth.interest) : e.depositInterest != null ? toNumber(e.depositInterest) : null,
    fundProductType: linkedWealth ? "wealth" : e.fundProductType,
    metalTypeId: e.metalTypeId ?? null,
    metalTypeName: e.metalTypeName ?? null,
    metalUnitId: e.metalUnitId ?? null,
    metalUnitName: e.metalUnitName ?? null,
    metalQuantity: e.metalQuantity != null ? toNumber(e.metalQuantity) : null,
    metalUnitPrice: e.metalUnitPrice != null ? toNumber(e.metalUnitPrice) : null,
    metalFee: e.metalFee != null ? toNumber(e.metalFee) : null,
    fundUnits: linkedWealth?.units != null ? toNumber(linkedWealth.units) : e.fundUnits != null ? toNumber(e.fundUnits) : null,
    fundNav: linkedWealth?.nav != null ? toNumber(linkedWealth.nav) : e.fundNav != null ? toNumber(e.fundNav) : null,
    fundFee: linkedWealth?.fee != null ? toNumber(linkedWealth.fee) : e.fundFee != null ? toNumber(e.fundFee) : null,
    fundConfirmDate: linkedWealth?.confirmDate ? toIsoOrNull(linkedWealth.confirmDate) : toIsoOrNull(e.fundConfirmDate),
    fundArrivalDate: linkedWealth?.arrivalDate ? toIsoOrNull(linkedWealth.arrivalDate) : toIsoOrNull(e.fundArrivalDate),
    fundSourceEntryId: e.fundSourceEntryId ?? null,
    fundArrivalAmount: linkedWealthArrivalAmount ?? (e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null),
    ...buildEntryBusinessLinkSummary(e),
    entryTags: (e.EntryTag || []).map((et: any) => ({
      tagId: et.tagId,
      Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
    })),
  });
  });
  const pagedDetailEntries: DetailEntry[] = detailAll
    ? allDetailEntries
    : allDetailEntries.slice((safeDetailPage - 1) * pageSize, safeDetailPage * pageSize);
  const creditBillDetailEntries = showAllCreditBillDetails
    ? allDetailEntries
    : (creditCardBillDetails?.details ?? []);
  const creditBillDetailTitle = showAllCreditBillDetails
    ? t("creditBill.allDetails")
    : creditCardBill?.statementMonth
      ? t("creditBill.detailTitleWithMonth", { month: creditCardBill.statementMonth })
      : t("creditBill.detailTitle");

  const allDepositAccounts = accounts.filter((account) => isDepositAccount(account));
  const selectedDepositAccountIds =
    view === "deposit" && selectedAccount
      ? isDepositAccount(selectedAccount)
        ? [selectedAccount.id]
        : selectedAccount.institutionId
          ? allDepositAccounts
              .filter((account) => account.institutionId === selectedAccount.institutionId)
              .map((account) => account.id)
          : []
      : [];
  const currentDepositTransactionEntries =
    view === "deposit"
      ? await loadDepositTransactionDetailLike({
          householdId,
          accountIds: selectedDepositAccountIds,
        })
      : [];

  const depositEntries =
    view === "deposit"
      ? (currentDepositTransactionEntries || []).map((entry) => {
          const depositSubtype = String(entry.fundSubtype ?? "");
          const isRedeemEntry = depositSubtype === "redeem" || depositSubtype === "switch_out";
          const cashAccountLabel = isRedeemEntry ? (entry.toAccountName ?? "") : (entry.accountName ?? "");
          const entryDate = toYmdOrNull(entry.date) ?? "";
          const arrivalDate = toYmdOrNull(entry.fundArrivalDate);
          return {
            id: entry.id,
            date: entryDate,
            typeLabel: entry.fundSubtype === "redeem" ? t("deposit.subtype.redeem") : t("deposit.subtype.buy"),
            fundName: entry.fundName ?? entry.fundCode ?? "",
            maturityDate: arrivalDate,
            cashAccountLabel,
            note: entry.note ?? "",
            amount: entry.toAccountId === accountId ? Math.abs(toNumber(entry.fundArrivalAmount ?? entry.amount)) : toNumber(entry.amount),
            businessLinkCount: entry.businessLinkCount ?? 0,
            businessLinkLabels: entry.businessLinkLabels ?? [],
            edit: {
              type: "investment" as const,
              date: entryDate,
              amount: Math.abs(toNumber(entry.amount)),
              note: entry.note ?? "",
              accountId: isRedeemEntry ? (entry.accountId ?? "") : (entry.toAccountId ?? ""),
              cashAccountId: isRedeemEntry ? (entry.toAccountId ?? "") : (entry.accountId ?? ""),
              fundName: entry.fundName ?? undefined,
              fundNav: entry.fundNav ?? undefined,
              depositAnnualRate:
                entry.depositAnnualRate != null
                  ? toNumber(entry.depositAnnualRate)
                  : entry.fundNav != null ? toNumber(entry.fundNav) : undefined,
              depositInterest:
                entry.depositInterest != null
                  ? toNumber(entry.depositInterest)
                  : undefined,
              depositSourceEntryId: entry.depositSourceEntryId ?? undefined,
              fundArrivalDate: arrivalDate ?? undefined,
              fundProductType: "deposit",
              fundSubtype: entry.fundSubtype ?? "buy",
            },
          };
        })
      : [];

  const insuranceEntries =
    view === "insurance"
      ? (await loadInsuranceTransactionDetailLike({ householdId, accountId: accountId ?? "" }))
          .map((entry) => {
            const insuranceSubtype = String(entry.fundSubtype ?? "");
            const isRedeemEntry = insuranceSubtype === "redeem" || insuranceSubtype === "switch_out";
            const cashAccountLabel = isRedeemEntry ? (entry.toAccountName ?? "") : (entry.accountName ?? "");
            const amount = isRedeemEntry ? Math.abs(toNumber(entry.amount)) : -Math.abs(toNumber(entry.amount));
            const entryDate = toYmdOrNull(entry.date) ?? "";
            return {
              id: entry.id,
              date: entryDate,
              typeLabel: isRedeemEntry ? t("fund.subtype.redeem") : t("insuranceShell.entryType.premium"),
              productName: entry.fundName ?? "",
              cashAccountLabel,
              cashAccountId: isRedeemEntry ? (entry.toAccountId ?? null) : (entry.accountId ?? null),
              note: entry.note ?? "",
              amount,
              businessLinkCount: entry.businessLinkCount ?? 0,
              businessLinkLabels: entry.businessLinkLabels ?? [],
              coverageAmount:
                (entry as { coverageAmount?: number | null }).coverageAmount ?? null,
              paymentTermYears:
                (entry as { paymentTermYears?: number | null }).paymentTermYears ?? null,
              edit: {
                type: "investment" as const,
                date: entryDate,
                amount: Math.abs(toNumber(entry.amount)),
                note: entry.note ?? "",
                accountId: isRedeemEntry ? (entry.accountId ?? "") : (entry.toAccountId ?? ""),
                cashAccountId: isRedeemEntry ? (entry.toAccountId ?? "") : (entry.accountId ?? ""),
                insuranceProductId: (entry as { insuranceProductId?: string | null }).insuranceProductId ?? null,
                fundName: entry.fundName ?? undefined,
                fundProductType: entry.fundProductType ?? undefined,
                fundSubtype: entry.fundSubtype ?? undefined,
                source: "insurance",
              },
            };
          })
      : [];

  const insuranceHoldings =
    view === "insurance" && selectedAccount
      ? insuranceProductsForAccount.map((product) => {
          const relatedEntries = insuranceEntries.filter(
            (entry) => entry.edit?.insuranceProductId === product.id,
          );
          const sortedEntries = [...relatedEntries].sort((a, b) => a.date.localeCompare(b.date));
          const metricMode = getInsuranceMetricMode(product.productType, product.accountingType, product.cashValueEnabled);
          const balance = relatedEntries.reduce((sum, entry) => sum + insuranceCashValueDelta({
            amount: entry.amount,
            fundSubtype: entry.edit?.fundSubtype,
            source: "insurance",
          }), 0);
          const totalPremium = relatedEntries
            .filter((entry) => entry.amount < 0)
            .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
          const coverageAmount = Number(product.coverageAmount ?? 0);
          return {
            id: product.id,
            label: product.name,
            policyNo: product.policyNo ?? null,
            startDate: sortedEntries[0]?.date ?? product.startDate?.toISOString().slice(0, 10) ?? null,
            ownerName: product.PolicyholderPerson?.name ?? product.OwnerGroup?.name ?? "",
            policyholderPersonId: product.policyholderPersonId ?? null,
            insuredPersonName: product.InsuredPerson?.name ?? product.InsuredUser?.name ?? "",
            insuredPersonId: product.insuredPersonId ?? null,
            beneficiaryName: product.beneficiaryName ?? null,
            displayTypeLabel: getInsuranceDisplayTypeLabel(metricMode),
            cashValueLabel: getInsuranceMetricLabel(metricMode),
            cashValue: metricMode === "coverage" ? null : balance,
            coverageAmount,
            totalPremium,
            statusLabel:
              product.status === "matured"
                ? t("insuranceShell.status.matured")
                : product.status === "surrendered"
                  ? t("insuranceShell.status.surrendered")
                  : product.status === "lapsed"
                    ? t("insuranceShell.status.lapsed")
                    : t("insuranceShell.status.active"),
            status: product.status,
            frequencyLabel:
              product.premiumFrequencyMonths === 1
                ? t("insuranceShell.frequency.monthly")
                : product.premiumFrequencyMonths === 3
                  ? t("insuranceShell.frequency.quarterly")
                  : product.premiumFrequencyMonths === 6
                    ? t("insuranceShell.frequency.semiannual")
                    : product.premiumFrequencyMonths === 12
                      ? t("insuranceShell.frequency.annual")
                      : product.premiumFrequencyMonths === 999999
                        ? t("insuranceShell.frequency.single")
                        : "-",
            paymentTermYears: product.paymentTermYears ? Number(product.paymentTermYears) : null,
            coverageTermYears: product.coverageTermYears ? Number(product.coverageTermYears) : null,
            institutionId: product.institutionId ?? null,
            institutionName: selectedAccount.Institution?.name ?? null,
            ownerGroupId: product.ownerGroupId ?? null,
            productType: product.productType ?? null,
            accountingType: product.accountingType ?? null,
            currency: product.currency ?? null,
            accountId: product.accountId ?? null,
            premiumMode: product.premiumMode ?? null,
            premiumFrequencyMonths: product.premiumFrequencyMonths ?? null,
            cashValueEnabled: product.cashValueEnabled ?? null,
            effectiveDate: product.effectiveDate?.toISOString().slice(0, 10) ?? null,
            maturityDate: product.maturityDate?.toISOString().slice(0, 10) ?? null,
            note: product.note ?? null,
            relatedEntryIds: relatedEntries.map((entry) => entry.id),
          };
        })
      : [];
  const allDepositAccountIds = allDepositAccounts.map((account) => account.id);
  const allDepositEntries =
    allDepositAccountIds.length > 0
      ? await loadDepositTransactionDetailLike({
          householdId,
          accountIds: allDepositAccountIds,
        })
      : [];

  const allWealthAccounts = investmentAccountOptions.filter((account) => account.investProductType === "wealth");
  const allWealthAccountIds = allWealthAccounts.map((account) => account.id);
  const allWealthEntries =
    allWealthAccountIds.length > 0
      ? await loadWealthTransactionEntryLike({
          householdId,
          accountIds: allWealthAccountIds,
        })
      : [];

  function buildWealthHoldingOptions(sourceEntryPool: Array<any>) {
    if (allWealthAccountIds.length === 0) return [];
    const accountNameById = new Map(allWealthAccounts.map((account) => [account.id, account.label || account.name]));
    const buckets = new Map<string, {
      id: string;
      label: string;
      fundName: string;
      wealthProductId: string | null;
      wealthAccountId: string;
      wealthAccountLabel: string;
      remainingAmount: number;
      remainingUnits: number;
      hasUnits: boolean;
      annualRate: number | null;
      termDays: number | null;
      firstDate: string;
      movements: Array<{ date: string; delta: number }>;
      unitMovements: Array<{ date: string; delta: number }>;
    }>();

    for (const entry of sourceEntryPool) {
      if (entry.fundProductType !== "wealth" || entry.deletedAt) continue;
      const amountValue = toNumber(entry.amount);
      const principalAmountValue = entry.wealthPrincipalAmount != null ? toNumber(entry.wealthPrincipalAmount) : amountValue;
      const isRedeemEntry =
        entry.fundSubtype === "redeem" ||
        entry.fundSubtype === "switch_out" ||
        (amountValue > 0 && allWealthAccountIds.includes(entry.accountId ?? "") && entry.fundSubtype !== "dividend_cash");
      const isDividendEntry = entry.fundSubtype === "dividend_cash";
      const wealthAccountId = (isRedeemEntry ? entry.accountId : entry.toAccountId) ?? "";
      if (!wealthAccountId || !allWealthAccountIds.includes(wealthAccountId)) continue;

      const productName = entry.WealthProduct?.name ?? entry.fundName ?? t("sidebar.wealthHolding.unnamed");
      const productLabel = entry.WealthProduct?.shortName?.trim() || productName;
      const productKey = entry.wealthProductId ? `product:${entry.wealthProductId}` : `name:${productName}`;
      const key = `${wealthAccountId}\u001f${productKey}`;
      const existing = buckets.get(key);
      const annualRate =
        entry.depositAnnualRate != null
          ? toNumber(entry.depositAnnualRate)
          : entry.WealthProduct?.annualRate != null
            ? toNumber(entry.WealthProduct.annualRate)
            : null;
      const principalDelta = isRedeemEntry
        ? -Math.abs(principalAmountValue)
        : isDividendEntry
          ? 0
          : Math.abs(principalAmountValue);
      const unitsValue = entry.fundUnits == null ? null : Math.abs(toNumber(entry.fundUnits));
      const unitsDelta = unitsValue == null || isDividendEntry ? 0 : isRedeemEntry ? -unitsValue : unitsValue;
      const movementDate = toYmdOrNull(entry.date) ?? "";

      if (existing) {
        existing.remainingAmount += principalDelta;
        if (unitsValue != null) {
          existing.hasUnits = true;
          existing.remainingUnits += unitsDelta;
        }
        if (principalDelta !== 0 && movementDate) {
          existing.movements.push({ date: movementDate, delta: Number(principalDelta.toFixed(2)) });
        }
        if (unitsValue != null && unitsDelta !== 0 && movementDate) {
          existing.unitMovements.push({ date: movementDate, delta: Number(unitsDelta.toFixed(6)) });
        }
        if (existing.annualRate == null && annualRate != null) existing.annualRate = annualRate;
        if (existing.termDays == null && entry.WealthProduct?.termDays != null) existing.termDays = entry.WealthProduct.termDays;
      } else {
        buckets.set(key, {
          id: key,
          label: productLabel,
          fundName: productName,
          wealthProductId: entry.wealthProductId ?? null,
          wealthAccountId,
          wealthAccountLabel: accountNameById.get(wealthAccountId) ?? entry.toAccountName ?? entry.accountName ?? t("sidebar.wealthAccount"),
          remainingAmount: principalDelta,
          remainingUnits: unitsDelta,
          hasUnits: unitsValue != null,
          annualRate,
          termDays: entry.WealthProduct?.termDays ?? null,
          firstDate: movementDate,
          movements: principalDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(principalDelta.toFixed(2)) }] : [],
          unitMovements: unitsValue != null && unitsDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(unitsDelta.toFixed(6)) }] : [],
        });
      }
    }

    return Array.from(buckets.values())
      .filter((holding) => holding.movements.some((movement) => movement.delta > 0))
      .map((holding) => ({
        id: holding.id,
        label: holding.label,
        subLabel: [
          holding.wealthAccountLabel,
          holding.annualRate != null ? t("sidebar.wealthHolding.annualRate", { rate: holding.annualRate }) : "",
          holding.termDays ? t("sidebar.wealthHolding.termDays", { days: holding.termDays }) : "",
          t("sidebar.wealthHolding.redeemable", { amount: formatMoney(holding.remainingAmount) }),
          holding.hasUnits ? t("sidebar.wealthHolding.units", { units: holding.remainingUnits.toFixed(6) }) : "",
        ].filter(Boolean).join(" · "),
        fundName: holding.fundName,
        wealthProductId: holding.wealthProductId,
        wealthAccountId: holding.wealthAccountId,
        wealthAccountLabel: holding.wealthAccountLabel,
        remainingAmount: Number(holding.remainingAmount.toFixed(2)),
        remainingUnits: Number(holding.remainingUnits.toFixed(6)),
        hasUnits: holding.hasUnits,
        annualRate: holding.annualRate,
        termDays: holding.termDays,
        firstDate: holding.firstDate,
        movements: holding.movements,
        unitMovements: holding.unitMovements,
      }))
      .sort((a, b) => {
        if (a.wealthAccountLabel !== b.wealthAccountLabel) return a.wealthAccountLabel.localeCompare(b.wealthAccountLabel, "zh-Hans-CN");
        return a.label.localeCompare(b.label, "zh-Hans-CN");
      });
  }

  const wealthHoldingOptions = buildWealthHoldingOptions(allWealthEntries);

  function buildDepositLots(sourceEntryPool: Array<any>, activeDepositAccountIds: Set<string>, sortAccountId?: string | null) {
    if (activeDepositAccountIds.size === 0) return [];
    const sourceEntries = sourceEntryPool.filter(
      (entry) =>
        entry.fundProductType === "deposit" &&
        !entry.deletedAt &&
        ((entry.accountId && activeDepositAccountIds.has(entry.accountId)) ||
          (entry.toAccountId && activeDepositAccountIds.has(entry.toAccountId))),
    );
    if (sourceEntries.length === 0) return [];

    const accountNameById = new Map(allDepositAccounts.map((account) => [account.id, account.name]));
    const sourceEntryById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const depositSourceEntries = [...sourceEntries].sort((a, b) =>
      compareDetailEntriesAsc(a, b, sortAccountId ?? undefined),
    );

    const lotBuckets = new Map<
      string,
      Array<{
        id: string;
        fundName: string;
        maturityDate: string | null;
        remainingAmount: number;
        depositAccountId: string;
        depositAccountName: string;
        relatedEntryIds: string[];
      }>
    >();

    const allLots: Array<{
      id: string;
      fundName: string;
      maturityDate: string | null;
      remainingAmount: number;
      depositAccountId: string;
      depositAccountName: string;
      relatedEntryIds: string[];
    }> = [];

    for (const entry of depositSourceEntries) {
      const fundName = (entry.fundName ?? entry.fundCode ?? "").trim() || t("sidebar.deposit.unnamed");
      const maturityDate = toYmdOrNull(entry.fundArrivalDate);
      const isRedeemEntry = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
      const amountValue = isRedeemEntry
        ? Math.max(
            0,
            Math.abs(toNumber(entry.amount)) - Math.max(0, toNumber(entry.depositInterest)),
          )
        : Math.abs(toNumber(entry.fundArrivalAmount ?? entry.amount));
      const depositAccountId = (
        isRedeemEntry ? entry.accountId : entry.toAccountId
      ) ?? "";
      const depositAccountName = accountNameById.get(depositAccountId) ?? entry.toAccountName ?? entry.accountName ?? t("sidebar.deposit.fallbackName");
      const lotKey = `${depositAccountId}\u001f${fundName}\u001f${maturityDate ?? ""}`;

      if (!isRedeemEntry) {
        const lot = {
          id: entry.id,
          fundName,
          maturityDate,
          remainingAmount: amountValue,
          depositAccountId,
          depositAccountName,
          relatedEntryIds: [entry.id],
        };
        const bucket = lotBuckets.get(lotKey);
        if (bucket) bucket.push(lot);
        else lotBuckets.set(lotKey, [lot]);
        allLots.push(lot);
        continue;
      }

      const linkedBucket = entry.depositSourceEntryId
        ? allLots.filter((lot) => lot.id === entry.depositSourceEntryId)
        : [];
      const bucket = linkedBucket.length > 0 ? linkedBucket : (lotBuckets.get(lotKey) ?? []);
      for (const lot of bucket) {
        if (lot.remainingAmount <= 0) continue;
        lot.relatedEntryIds.push(entry.id);
        lot.remainingAmount = 0;
        break;
      }
    }

    return allLots
      .map((lot) => {
        const sourceEntry = sourceEntryById.get(lot.id);
        return {
          id: lot.id,
          label: lot.fundName,
          originalAmount: Number(Math.abs(toNumber(sourceEntry?.fundArrivalAmount ?? sourceEntry?.amount ?? lot.remainingAmount)).toFixed(2)),
          subLabel: [
            lot.depositAccountName,
            lot.maturityDate ? t("sidebar.depositLot.maturity", { date: lot.maturityDate }) : "",
            lot.remainingAmount > 0.0001 ? t("sidebar.depositLot.withdrawable", { amount: formatMoney(lot.remainingAmount) }) : t("sidebar.depositLot.closed"),
          ]
            .filter(Boolean)
            .join(" · "),
          fundName: lot.fundName,
          startDate: toYmdOrNull(sourceEntry?.date),
          maturityDate: lot.maturityDate,
          remainingAmount: Number(lot.remainingAmount.toFixed(2)),
          status: lot.remainingAmount > 0.0001 ? "open" as const : "closed" as const,
          annualRate: (() => {
            if (sourceEntry?.depositAnnualRate != null) return toNumber(sourceEntry.depositAnnualRate);
            return sourceEntry?.fundNav != null ? toNumber(sourceEntry.fundNav) : null;
          })(),
          depositAccountId: lot.depositAccountId,
          depositAccountLabel: lot.depositAccountName,
          relatedEntryIds: lot.relatedEntryIds,
        };
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        const dateA = a.maturityDate ?? "9999-12-31";
        const dateB = b.maturityDate ?? "9999-12-31";
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return a.label.localeCompare(b.label, "zh-Hans-CN");
      });
  }

  const activeDepositAccountIds = new Set<string>();
  if (selectedAccount) {
    if (isDepositAccount(selectedAccount)) {
      activeDepositAccountIds.add(selectedAccount.id);
    }
    if (selectedAccount.institutionId) {
      for (const account of allDepositAccounts) {
        if (account.institutionId === selectedAccount.institutionId) {
          activeDepositAccountIds.add(account.id);
        }
      }
    }
    for (const entry of allDepositEntries) {
      if (entry.fundProductType !== "deposit" || entry.deletedAt) continue;
      if (entry.accountId !== selectedAccount.id && entry.toAccountId !== selectedAccount.id) continue;
      const isRedeemEntry = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
      const depositAccountId = (isRedeemEntry ? entry.accountId : entry.toAccountId) ?? "";
      if (depositAccountId && allDepositAccounts.some((account) => account.id === depositAccountId)) {
        activeDepositAccountIds.add(depositAccountId);
      }
    }
  }
  const depositLots = buildDepositLots(
    entries,
    activeDepositAccountIds,
    selectedAccount && isDepositAccount(selectedAccount) ? selectedAccount.id : undefined,
  );
  const allDepositLots = buildDepositLots(allDepositEntries, new Set(allDepositAccountIds));
  const scopedOpenDepositLots = depositLots.filter((lot) => lot.status === "open" && lot.remainingAmount > 0.0001);
  const globalOpenDepositLots = allDepositLots.filter((lot) => lot.status === "open" && lot.remainingAmount > 0.0001);
  const redeemLotSource = scopedOpenDepositLots.length > 0 ? scopedOpenDepositLots : globalOpenDepositLots;
  const redeemLotOptions = redeemLotSource
    .map((lot) => ({
      id: lot.id,
      label: lot.label,
      subLabel: lot.subLabel,
      fundName: lot.fundName,
      startDate: lot.startDate,
      maturityDate: lot.maturityDate,
      remainingAmount: lot.remainingAmount,
      annualRate: lot.annualRate,
      depositAccountId: lot.depositAccountId,
      depositAccountLabel: lot.depositAccountLabel,
    }));
  const selectedAccountDisplayValue = selectedAccount
    ? accountDisplayValueById.get(selectedAccount.id) ?? selectedAccountRawBalanceValue
    : selectedAccountRawBalanceValue;
  const selectedViewHeaderAmount = view === "debt"
    ? debtDisplaySummaryValue
    : selectedAccountDisplayValue;
  const showDerivedViewHeaderAmount =
    !!currentInvestData ||
    (view === "investstock" && !!investstockData) ||
    (view === "investproperty" && !!investpropertyData) ||
    (view === "insurance" && !!selectedAccount) ||
    (view === "deposit" && !!selectedAccount);
  const headerFxBalance = showDerivedViewHeaderAmount ? selectedViewHeaderAmount : selectedAccountRawBalanceValue;
  const defaultDepositAccountForSelectedInstitution =
    selectedAccount && isDepositAccount(selectedAccount)
      ? selectedAccount.id
      : selectedAccount?.institutionId
        ? allDepositAccounts.find((account) => account.institutionId === selectedAccount.institutionId)?.id ?? ""
        : "";
  const defaultCashAccountForSelectedInstitution =
    selectedAccount && cashAccountList.some((account) => account.id === selectedAccount.id)
      ? selectedAccount.id
      : selectedAccount?.institutionId
        ? cashAccountList.find((account) => account.kind === "bank_debit" && account.institutionId === selectedAccount.institutionId)?.id
        ?? cashAccountList.find((account) => account.institutionId === selectedAccount.institutionId)?.id
        ?? cashAccountList[0]?.id
        ?? ""
      : cashAccountList[0]?.id ?? "";
  const defaultStockCashAccountId = (() => {
    const stockAccount = stockAccountOptions.find((account) => account.id === defaultStockInvestmentAccountId) ?? null;
    const stockOwnerGroupId = (stockAccount?.groupId ?? "").trim();
    if (stockAccount?.institutionId) {
      const sameOwnerCash = (account: typeof cashAccountList[number]) =>
        (!stockOwnerGroupId || (account.groupId ?? "") === stockOwnerGroupId);
      const cashAccount = cashAccountList.find((account) =>
        account.institutionId === stockAccount.institutionId && account.institutionType === "brokerage" && sameOwnerCash(account))
        ?? cashAccountList.find((account) =>
          account.institutionId === stockAccount.institutionId && sameOwnerCash(account))
        ?? null;
      return cashAccount?.id ?? defaultCashAccountForSelectedInstitution;
    }
    return defaultCashAccountForSelectedInstitution;
  })();
  const defaultStockCashAccountName = cashAccountList.find((account) => account.id === defaultStockCashAccountId)?.label ?? null;
  const defaultStockTransferFromAccountId = (() => {
    const stockAccount = stockAccountOptions.find((account) => account.id === defaultStockInvestmentAccountId) ?? null;
    const stockOwnerGroupId = (stockAccount?.groupId ?? "").trim();
    const sameOwner = (account: typeof cashAccountList[number]) =>
      (!stockOwnerGroupId || (account.groupId ?? "") === stockOwnerGroupId);
    // Stock transfer: default the source to a bank debit card of the same owner
    // (not the securities cash account itself, and not cash/credit cards).
    return cashAccountList.find((account) => account.id !== defaultStockCashAccountId && account.kind === "bank_debit" && sameOwner(account))?.id
      ?? cashAccountList.find((account) => account.id !== defaultStockCashAccountId && sameOwner(account) && account.kind !== "cash")?.id
      ?? "";
  })();
  const defaultWealthAccountForSelectedInstitution =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "wealth"
      ? selectedAccount.id
      : selectedAccount?.institutionId
        ? investmentAccountOptions.find((account) => account.investProductType === "wealth" && account.institutionId === selectedAccount.institutionId)?.id
          ?? investmentAccountOptions.find((account) => account.investProductType === "wealth")?.id
          ?? ""
        : investmentAccountOptions.find((account) => account.investProductType === "wealth")?.id ?? "";

  return (
    <div className="flex h-full w-full bg-transparent">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
            <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
              <span className="page-title">{selectedAccountLabel || t("statistics.allAccounts")}</span>
              {view === "debt" ? (
                <span className={`tabular-nums font-semibold ${pnlCls(debtDisplaySummaryValue)}`}>
                  {formatCurrencyMoney(debtDisplaySummaryValue, baseCurrency)}
                </span>
              ) : !selectedAccount ? (
                <LiveAccountBalance mode="total" initialValue={totalNetWorthValue} isRedUp={isRedUp} baseCurrency={baseCurrency} />
              ) : showDerivedViewHeaderAmount ? (
                <span className={`tabular-nums font-semibold ${pnlCls(selectedViewHeaderAmount)}`}>{formatCurrencyMoney(selectedViewHeaderAmount, selectedAccountCurrency)}</span>
              ) : (
                <LiveAccountBalance
                  mode="account"
                  accountId={selectedAccount.id}
                  initialValue={selectedAccountRawBalanceValue}
                  isRedUp={isRedUp}
                  semantic={selectedAccount.kind === AccountKind.bank_credit ? "liability" : "default"}
                  displayMultiplier={selectedAccount.kind === AccountKind.bank_credit ? -1 : 1}
                  baseCurrency={selectedAccountCurrency}
                  accountDisplayMode="original"
                />
              )}
              {showSelectedAccountFxInline ? (
                <AccountFxRateInline
                  fromCurrency={selectedAccountCurrency}
                  toCurrency={baseCurrency}
                  accountBalance={headerFxBalance}
                  initialRate={selectedAccountFxRate?.rate ?? null}
                  initialRateDate={selectedAccountFxRate?.rateDate ?? null}
                  initialSource={selectedAccountFxRate?.source ?? null}
                />
              ) : null}
              {missingFxCurrencies.length > 0 ? (
                <span className="text-xs text-amber-700">
                  {t("sidebar.missingFxRateDetail", { currencies: missingFxCurrencies.join("、") })}
                </span>
              ) : null}
            </div>
            <div className={`flex shrink-0 flex-wrap items-center justify-end gap-2 ${currentInvestData ? "hidden md:flex" : ""}`}>
              <UnifiedEntryLauncher
                defaultAction={
                  isDepositView
                    ? "deposit"
                    : view === "investstock"
                      ? "stock"
                    : view === "investproperty"
                      ? "property"
                    : currentInvestData
                      ? (
                          selectedAccount?.investProductType === "metal"
                            ? "metal"
                            : selectedAccount?.investProductType === "wealth"
                              ? "wealth"
                              : "investment"
                        )
                      : view === "regularinvest"
                        ? "regular-task"
                        : view === "debt"
                          ? "debt"
                          : isInsuranceView
                            ? "insurance"
                            : isBillAccount
                              ? "transaction"
                              : "transaction"
                }
                context={{
                  defaultAccountId: selectedAccount?.id ?? accountId ?? "",
                  defaultCashAccountId: defaultCashAccountForSelectedInstitution,
                  defaultTransferFromAccountId: isBillAccount
                    ? (lastRepayFromAccountId ?? cashAccountList[0]?.id ?? "")
                    : view === "investstock"
                      ? (defaultStockCashAccountId || defaultStockTransferFromAccountId || (cashAccountList[0]?.id ?? ""))
                      : (selectedAccount?.id ?? accountId ?? ""),
                  defaultTransferToAccountId: isBillAccount ? (selectedAccount?.id ?? accountId ?? "") : "",
                  defaultInvestmentAccountId: defaultFundInvestmentAccountId,
                  defaultStockAccountId: defaultStockInvestmentAccountId,
                  defaultStockCashAccountId,
                  defaultStockTransferFromAccountId,
                  defaultPropertyAccountId: defaultPropertyInvestmentAccountId,
                  defaultMetalAccountId: defaultMetalInvestmentAccountId,
                  defaultWealthAccountId: defaultWealthAccountForSelectedInstitution,
                  defaultDepositAccountId: isDepositView ? defaultDepositAccountForSelectedInstitution : "",
                  defaultDepositSubtype: isDepositView && globalOpenDepositLots.length > 0 ? "redeem" : "buy",
                  defaultInsuranceAccountId: isInsuranceView ? (selectedAccount?.id ?? "") : "",
                  defaultDebtAccountId: selectedDebtRow?.accountIds?.[0] ?? "",
                  defaultDebtInstitutionId: selectedDebtObjectValue,
                  defaultFundCode: isFundLikeInvestView ? currentFundDefault?.fundCode ?? currentInvestData?.selectedFundCode ?? "" : "",
                  defaultFundName: currentFundDefault?.name ?? "",
                  defaultScheduledTaskType:
                    view === "regularinvest"
                      ? "fund_regular_invest"
                      : isInsuranceView
                        ? "insurance_premium"
                        : "fund_regular_invest",
                }}
                actions={[
                  { key: "transaction", label: t("entry.kind.transaction") },
                  { key: "advance", label: t("entry.kind.advance") },
                  { key: "transfer", label: isBillAccount ? t("transaction.type.creditCardRepayment") : t("entry.kind.transfer") },
                  { key: "fx", label: t("entry.kind.fx") },
                  { key: "investment", label: t("entry.kind.investment") },
                  { key: "stock", label: t("entry.kind.stock") },
                  { key: "stock-transfer", label: t("entry.kind.stockTransfer") },
                  { key: "property", label: t("entry.kind.property") },
                  { key: "metal", label: t("entry.kind.metal") },
                  { key: "wealth", label: t("entry.kind.wealth") },
                  { key: "deposit", label: t("entry.kind.deposit") },
                  { key: "insurance", label: t("entry.kind.insurance") },
                  { key: "debt", label: t("entry.kind.debt"), disabled: cashAccountList.length === 0 },
                  { key: "regular-task", label: t("entry.kind.regularTask") },
                ]}
              />
              <>
              <TransactionFormModal
                accounts={spendingAccountOptions} transferAccounts={transferAccountOptions}
                accountSSOptions={spendingAccountSSOptions} transferAccountSSOptions={transferAccountSSOptions}
                nestedFieldData={nestedFieldData}
                expenseCategories={expenseCategories.map((c) => ({ id: c.id, label: c.label, parentId: c.parentId, type: c.type }))}
                incomeCategories={incomeCategories.map((c) => ({ id: c.id, label: c.label, parentId: c.parentId, type: c.type }))}
                advanceCategories={advanceCategories.map((c) => ({ id: c.id, label: c.label, parentId: c.parentId, type: c.type }))}
                defaultAccountId={accountId || undefined}
                lastRepayToAccountId={lastRepayToAccountId} lastRepayFromAccountId={lastRepayFromAccountId}
                isCreditCardAccount={isBillAccount} showInvestment={isInvestAccount} action={createTransaction} editAction={updateTransactionFromDialog}
                allTags={tags.map(t => ({ id: t.id, name: t.name, color: t.color }))}
                hideTrigger
              />
              <StockTransactionFormModal
                defaultStockAccountId={defaultStockInvestmentAccountId}
                defaultCashAccountId={defaultStockCashAccountId}
                stockAccounts={stockAccountOptions}
                stockAccountSSOptions={stockAccountSSOptions}
                cashAccounts={cashAccountList}
                cashAccountSSOptions={cashAccountSSOptions}
              />
              <PropertyFormModal
                defaultPropertyAccountId={defaultPropertyInvestmentAccountId}
                defaultCashAccountId={defaultCashAccountForSelectedInstitution}
                propertyAccounts={propertyAccountOptions}
                propertyAccountSSOptions={propertyAccountSSOptions}
                cashAccounts={cashAccountList}
                cashAccountSSOptions={cashAccountSSOptions}
                propertyAssets={investpropertyData?.positions.map((position) => ({
                  id: position.propertyAssetId ?? position.fundCode,
                  name: position.name,
                  marketValue: position.marketValue,
                })) ?? []}
              />
              <InvestmentFormModal
                mode="create"
                hideTrigger
                accountId={defaultInvestmentCreateAccountId}
                accountProductType={selectedAccount && isPureInvestmentAccount(selectedAccount) ? selectedAccount.investProductType ?? null : null}
                defaults={{
                  fundCode: isFundLikeInvestView ? currentInvestData?.selectedFundCode ?? undefined : undefined,
                  fundName: currentFundDefault?.name ?? undefined,
                  fundUnits: currentFundDefault?.units ?? undefined,
                }}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                metalTypes={metalTypes}
                metalUnits={metalUnits}
                nestedFieldData={nestedFieldData}
                holdings={currentInvestData?.positions.map(p => ({ fundCode: p.fundCode, name: p.name, units: p.units })) ?? undefined}
                allEntries={currentInvestData?.allEntries.map(e => ({
                  id: e.id,
                  date: toYmdOrNull(e.date) ?? "",
                  createdAt: toIsoOrNull(e.createdAt),
                  fundConfirmDate: toYmdOrNull(e.fundConfirmDate),
                  fundArrivalDate: toYmdOrNull(e.fundArrivalDate),
                  fundSourceEntryId: e.fundSourceEntryId ?? null,
                  fundCode: e.fundCode ?? "",
                  fundSubtype: e.fundSubtype ?? "",
                  fundUnits: e.fundUnits != null ? Number(e.fundUnits) : null,
                  source: e.source ?? null,
                  accountId: e.accountId ?? null,
                  toAccountId: e.toAccountId ?? null,
                  amount: e.amount != null ? Number(e.amount) : 0,
                })) ?? undefined}
                createAction={createTransaction}
                fundUnitsDecimals={fundUnitsDecimals}
              />
              <InvestmentFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                accountProductType={selectedAccount?.investProductType ?? null}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                metalTypes={metalTypes}
                metalUnits={metalUnits}
                nestedFieldData={nestedFieldData}
                holdings={currentInvestData?.positions.map(p => ({ fundCode: p.fundCode, name: p.name, units: p.units })) ?? undefined}
                allEntries={currentInvestData?.allEntries.map(e => ({
                  id: e.id,
                  date: toYmdOrNull(e.date) ?? "",
                  createdAt: toIsoOrNull(e.createdAt),
                  fundConfirmDate: toYmdOrNull(e.fundConfirmDate),
                  fundArrivalDate: toYmdOrNull(e.fundArrivalDate),
                  fundSourceEntryId: e.fundSourceEntryId ?? null,
                  fundCode: e.fundCode ?? "",
                  fundSubtype: e.fundSubtype ?? "",
                  fundUnits: e.fundUnits != null ? Number(e.fundUnits) : null,
                  source: e.source ?? null,
                  accountId: e.accountId ?? null,
                  toAccountId: e.toAccountId ?? null,
                  amount: e.amount != null ? Number(e.amount) : 0,
                })) ?? undefined}
                createAction={createTransaction}
                editAction={editInvestment}
                fundUnitsDecimals={fundUnitsDecimals}
              />
              <WealthFormModal
                mode="create"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                wealthHoldingOptions={wealthHoldingOptions}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <WealthFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                wealthHoldingOptions={wealthHoldingOptions}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <DepositFormModal
                mode="create"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                redeemLotOptions={redeemLotOptions}
                allRedeemLotOptions={allDepositLots}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <DepositFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                redeemLotOptions={redeemLotOptions}
                allRedeemLotOptions={allDepositLots}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <InsuranceFormModal
                mode="create"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                cashAccountSSOptions={cashAccountSSOptions}
                nestedFieldData={nestedFieldData}
              />
              {!isInsuranceView ? (
                <InsuranceEntryEditBridge
                  cashAccounts={cashAccountList}
                  cashAccountSSOptions={cashAccountSSOptions}
                  nestedFieldData={nestedFieldData}
                />
              ) : null}
              <RegularInvestForm
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                accountLabel={selectedAccountLabel}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions.map((item) => ({ id: item.id, name: item.label, label: item.label }))}
                transferTargetAccounts={accountOptions}
                insuranceProductOptions={[]}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                transferTargetAccountSSOptions={allAccountSSOptions}
                nestedFieldData={nestedFieldData}
                action={regularInvestFormAction}
                showTriggerButton={false}
              />
              <DebtTransactionModal
                debtAccounts={debtAccounts.map((account) => ({
                  id: account.id,
                  label: debtAccountLabelById.get(account.id) ?? account.name,
                  subLabel: account.Counterparty?.name ? t("txForm.counterparty") : account.Institution?.name ? t("liabilities.institutionDeal") : t("account.kind.loan"),
                  institutionId: account.institutionId ?? null,
                  counterpartyId: account.counterpartyId ?? null,
                  institutionType: account.Institution?.type ?? account.Counterparty?.type ?? null,
                  isInstitutionLoan: !!account.institutionId && account.Institution?.type === "bank",
                  debtDirection: account.debtDirection ?? null,
                }))}
                cashAccounts={debtTransferAccountList}
                debtObjectOptions={debtObjectOptions}
                cashAccountSSOptions={debtTransferAccountSSOptions}
                nestedFieldData={nestedFieldData}
                defaultDebtAccountId={selectedDebtRow?.accountIds?.[0] ?? ""}
                defaultDebtInstitutionId={selectedDebtObjectValue}
                defaultCashAccountId={debtTransferAccountList[0]?.id ?? ""}
                action={createDebtTransaction}
                showTriggerButton={false}
              />
              </>
            </div>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden bg-transparent">
          {isOverview ? (
            <DashboardOverview 
              totalNetWorth={totalNetWorthValue} 
              monthGrowth={monthGrowthValue} 
              isRedUp={isRedUp}
              createAction={createTransaction}
            />
          ) : view === "bill" && isBillAccount ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
              <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-5">
                {missingBillingDayForBill ? (
                  <div className="panel-surface border-amber-200 bg-amber-50/70">
                    <div className="px-4 py-4">
                      <div className="text-sm font-semibold text-amber-900">{t("sidebar.bill.missingBillingDayTitle")}</div>
                      <div className="mt-1 text-xs leading-5 text-amber-800">
                        {t("sidebar.bill.missingBillingDayBody")}
                      </div>
                      <div className="mt-2 text-xs text-amber-700">
                        {t("sidebar.bill.missingBillingDayAction")}
                      </div>
                    </div>
                  </div>
                ) : null}
                <ResizableVerticalSplit
                  storageKey="mmh:credit-bill:split-height"
                  hasLowerPane
                  defaultUpperHeight={360}
                  separatorLabel={t("sidebar.bill.resizeLabel")}
                  separatorTitle={t("sidebar.bill.resizeTitle")}
                >
                  {hasCreditBillSummaries ? (
                    <CreditBillSummaryTable
                      accountId={selectedAccount?.id ?? ""}
                      accountName={selectedAccount?.name ?? ""}
                      billingDay={selectedAccount?.billingDay ?? null}
                      rows={creditBillSummaryRows}
                      initialPage={currentPage}
                      pageSize={billListPageSize}
                      selectedBillMonth={selectedCreditBillMonth}
                      activeStatementMonth={selectedCreditBillMonth}
                      settledBillMonth={settledBillMonth}
                      hideZeroBills={hideZeroBills}
                      hideSettledBills={hideSettledBills}
                      showRecentBillCycles={showRecentBillCycles}
                      fillHeight
                    />
                  ) : (
                    <div className="panel-surface flex h-full items-center justify-center text-sm text-slate-400">
                      {t("creditBill.empty")}
                    </div>
                  )}

                  <CreditBillDetailPanel
                    accountId={selectedAccount?.id ?? ""}
                    reorderAccountIds={billAccountIds}
                    showCardColumn
                    entries={creditBillDetailEntries}
                    initialPage={detailPage}
                    initialPageSize={pageSize}
                    initialDetailAll={detailAll}
                    resetKey={`${selectedAccount?.id ?? ""}:${selectedCreditBillMonth || "all"}:credit-bill-detail`}
                    title={creditBillDetailTitle}
                    periodLabel={
                      !showAllCreditBillDetails && creditCardBill
                        ? <>{t("creditBill.period")}：{mdUtcDots(creditCardBill.start)} ~ {mdUtcDots(creditCardBill.end)} · {creditCardBill.isCurrentCycle ? t("creditBill.currentCycle") : t("creditBill.currentBill")}</>
                        : undefined
                    }
                    accountOptions={accountOptions}
                    categoryOptions={categoryBatchReplaceOptions}
                    investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                  />
                </ResizableVerticalSplit>
              </div>
            </div>
          ) : view === "debt" ? (
            <DebtShell
              rows={debtRowsForShell.map((row) => ({
                key: row.key,
                name: row.name,
                objectType: row.objectType,
                objectName: row.objectName,
                itemName: row.itemName,
                accountId: row.accountId,
                institutionId: row.institutionId,
                counterpartyId: row.counterpartyId,
                itemType: row.itemType,
                repaymentMethod: row.repaymentMethod,
                repaymentCycle: row.repaymentCycle,
                annualRate: row.annualRate,
                mortgageLprDiscount: row.mortgageLprDiscount,
                remainingRuns: row.remainingRuns,
                paidPrincipal: row.paidPrincipal,
                paidInterest: row.paidInterest,
                remainingPrincipal: row.remainingPrincipal,
                remainingInterest: row.remainingInterest,
                remainingTotal: row.remainingTotal,
                nextRepaymentDate: row.nextRepaymentDate,
                nextRepaymentPrincipal: row.nextRepaymentPrincipal,
                nextRepaymentInterest: row.nextRepaymentInterest,
                nextRepaymentCashAccountId: row.nextRepaymentCashAccountId,
                loanRateAdjustments: row.loanRateAdjustments,
                payable: row.payable,
                receivable: row.receivable,
                net: row.net,
                accountCount: row.accountCount,
                parentKey: row.parentKey,
                depth: row.depth,
                isGroup: row.isGroup,
              }))}
              selectedKey={selectedDebtKey}
              entries={debtDetailEntries}
              repaymentScheduleRows={finalRepaymentScheduleRows}
              summaryRemainingTotal={debtShellRemainingTotal}
              totalPayable={debtDisplaySummary.totalPayable}
              totalReceivable={debtDisplaySummary.totalReceivable}
              isRedUp={isRedUp}
              accountOptions={accountOptions}
              categoryOptions={categoryBatchReplaceOptions}
            />
          ) : view === "deposit" && selectedAccount ? (
            <DepositShell
              accountLabel={selectedAccountLabel}
              institutionName={selectedAccount.Institution?.name ?? ""}
              entries={depositEntries}
              lots={depositLots}
            />
          ) : view === "insurance" && selectedAccount ? (
            <InsuranceShell
              accountId={selectedAccount.id}
              accountLabel={selectedAccountLabel}
              institutionName={selectedAccount.Institution?.name ?? ""}
              holdings={insuranceHoldings}
              entries={insuranceEntries}
              cashAccounts={cashAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              familyMemberOptions={institutions
                .filter((item) => item.type === "family_member")
                .map((item) => ({
                  id: item.id,
                  label: item.name,
                  subLabel: t("settings.familyMembers"),
                }))}
            />
          ) : view === "investmoney" && investmoneyData ? (
            <FundShell
              key={`investmoney-${accountId}`}
              view="investmoney"
              initialFundCode={investmoneyData.selectedFundCode}
              positions={investmoneyData.positions}
              clearedPositions={investmoneyData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investmoneyData.allEntries))}
              totalMarketValue={investmoneyData.totalMarketValue}
              totalCost={investmoneyData.totalCost}
              totalHistoricalProfit={investmoneyData.totalHistoricalProfit}
              confirmDaysMap={investmoneyData.confirmDaysMap}
              feeRateMap={investmoneyData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              wealthHoldingOptions={wealthHoldingOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : view === "investwealth" && investwealthData ? (
            <FundShell
              key={`investwealth-${accountId}`}
              view="investwealth"
              initialFundCode={investwealthData.selectedWealthProductId}
              positions={investwealthData.positions}
              clearedPositions={investwealthData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investwealthData.allEntries))}
              totalMarketValue={investwealthData.totalMarketValue}
              totalCost={investwealthData.totalCost}
              totalHistoricalProfit={investwealthData.totalHistoricalProfit}
              confirmDaysMap={investwealthData.confirmDaysMap}
              feeRateMap={investwealthData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              wealthHoldingOptions={wealthHoldingOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : view === "investproperty" && investpropertyData ? (
            <PropertyShell
              key={`investproperty-${accountId}`}
              accountId={accountId}
              accountLabel={selectedAccountLabel}
              currency={selectedAccount?.currency ?? baseCurrency}
              baseCurrency={baseCurrency}
              positions={JSON.parse(JSON.stringify(investpropertyData.positions))}
              totalMarketValue={investpropertyData.totalMarketValue}
              totalCost={investpropertyData.totalCost}
              isRedUp={isRedUp}
            />
          ) : view === "investstock" && investstockData ? (
            <StockHoldingsPanel
              key={`investstock-${accountId}`}
              accountId={accountId}
              accountLabel={selectedAccountLabel}
              currency={selectedAccount?.currency ?? baseCurrency}
              positions={JSON.parse(JSON.stringify(investstockData.positions))}
              cashBalance={investstockData.cashBalance ?? 0}
              totalMarketValue={investstockData.totalMarketValue}
              totalCost={investstockData.totalCost}
              isRedUp={isRedUp}
              stockCashAccountId={defaultStockCashAccountId}
              stockCashAccountName={defaultStockCashAccountName}
            />
          ) : view === "investfund" && investfundData ? (
            <FundShell
              key={`investfund-${accountId}`}
              view="investfund"
              initialFundCode={investfundData.selectedFundCode}
              positions={investfundData.positions}
              clearedPositions={investfundData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investfundData.allEntries))}
              totalMarketValue={investfundData.totalMarketValue}
              totalCost={investfundData.totalCost}
              totalHistoricalProfit={investfundData.totalHistoricalProfit}
              confirmDaysMap={investfundData.confirmDaysMap}
              feeRateMap={investfundData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col bg-transparent p-4 md:p-5">
              <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">
                <BasicDetailPanel
                  accountId={accountId}
                  isInvestAccount={isInvestAccount}
                  entries={pagedDetailEntries}
                  totalCount={filteredEntries2.length}
                  originalCount={entries.length}
                  hasDetailFilters={hasDetailFilters}
                  initialPage={safeDetailPage}
                  initialPageSize={pageSize}
                  initialDetailAll={detailAll}
                  normalExportFilename={normalExportFilename}
                  normalExportRows={normalExportRows}
                  accountOptions={accountOptions.map((a) => ({ id: a.id, label: a.label, fullLabel: a.fullLabel, title: a.hoverTitle }))}
                  categoryOptions={categoryBatchReplaceOptions}
                  investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                  compactRows={selectedAccount?.kind === AccountKind.bank_debit}
                  showBalanceReconcile={
                    selectedAccount?.kind === AccountKind.cash ||
                    selectedAccount?.kind === AccountKind.bank_debit ||
                    selectedAccount?.kind === AccountKind.ewallet
                  }
                  accountKind={selectedAccount?.kind ?? null}
                  accountName={selectedAccount?.name ?? ""}
                  accountLabel={selectedAccountLabel}
                  currentBalance={selectedAccountRawBalanceValue}
                  focusEntryId={focusEntryId}
                  showGuideOverlay={guideParam === "daily-table"}
                />
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
    );
  }
