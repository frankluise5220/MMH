import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind, TransactionType, FundSubtype, RegularInvestStatus, IntervalUnit } from "@prisma/client";
import { institutionTypeLabel, kindLabel } from "@/lib/account-kinds";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import { InvestmentFormModal, type InvestmentEntry, type InvestmentDefaults } from "@/components/InvestmentFormModal";
import { WealthFormModal } from "@/components/WealthFormModal";
import { DepositFormModal } from "@/components/DepositFormModal";
import { InsuranceFormModal } from "@/components/InsuranceFormModal";
import { InsuranceEntryEditBridge } from "@/components/InsuranceEntryEditBridge";
import { DepositCreateButton } from "@/components/DepositCreateButton";
import { FillNavButton } from "@/components/FillNavButton";
import { DebtShell } from "@/components/DebtShell";
import { DebtTransactionModal } from "@/components/DebtTransactionModal";
import { FundShell } from "@/components/FundShell";
import { DepositShell } from "@/components/DepositShell";
import { InsuranceShell } from "@/components/InsuranceShell";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { RegularInvestActionButtons } from "@/components/RegularInvestActionButtons";
import { DashboardOverview } from "@/components/DashboardOverview";
import { UnifiedEntryLauncher } from "@/components/UnifiedEntryLauncher";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { BasicDetailPanel } from "@/components/BasicDetailPanel";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import { CreditBillSummaryTable, type CreditBillSummaryRow } from "@/components/CreditBillSummaryTable";


import { RefreshNavButton } from "@/components/RefreshNavButton";
import Link from "next/link";
import { Upload } from "lucide-react";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { allocateBuyFailedRefunds, calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { getFundArrivalDays, getFundConfirmDays, normalizeNonNegativeDays, setFundConfirmDays, setFundConfirmDaysInTx, setFundArrivalDays, setFundArrivalDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDate, getFundFeeRateByDate, setFundFeeRateByDateInTx } from "@/lib/fund/feeRate";
import { syncMissingFundEntries } from "@/lib/fund/syncMissingEntries";
import { formatMoney } from "@/lib/format";
import { LiveAccountBalance } from "@/components/LiveAccountBalance";
import { getFundNav } from "@/lib/fund/navCache";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { getCachedHouseholdScope, getHouseholdScope } from "@/lib/server/household-scope";
import { attachEntryTags, replaceEntryTags } from "@/lib/server/entry-tags";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { loadCommonData, loadSelectedAccount, loadEntriesForAccount, loadInvestAccountData, loadInvestBalances } from "@/lib/server/cached-data";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
  buildAccountDisplayOption,
  buildFlatAccountOptions,
  normalizeCreditCardLabelTemplate,
} from "@/lib/account-display";
import { debtActionLabel } from "@/lib/debt";
import { getInvestmentAccountView, isDepositAccount, isPureInvestmentAccount, isSpecialCashTargetAccount } from "@/lib/account-kind-utils";
import { getAccountFundUnitsDecimals, normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { resolveOrCreateDepositAccount } from "@/lib/server/deposit-account";
import { executeNonFundScheduledTaskPlan } from "@/lib/server/scheduled-task-executor";
import {
  listLoanRateAdjustmentsByAccountIds,
  replaceLoanRateAdjustmentsForAccount,
  resolveLoanRateAdjustments,
} from "@/lib/server/loan-rate-adjustments";
import {
  DEFAULT_LOAN_PREPAY_STRATEGY,
  encodeLoanPrepayStrategy,
  normalizeLoanPrepayStrategy,
  parseLoanPrepayStrategy,
} from "@/lib/loan-prepay-strategy";
import { getInsuranceDisplayTypeLabel, getInsuranceMetricLabel, getInsuranceMetricMode, isInsuranceBalanceMetric } from "@/lib/insurance/display";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, applyBalanceReconcileEntry, effectiveAmountForAccount, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { isCreditCardRepaymentTransfer, statementMonthForTransfer } from "@/lib/transaction-semantics";
import { resolveSameCurrencyTransfer } from "@/lib/currency";
import {
  calcLoanScheduledAmountForPeriodStart,
  calcLoanRunPartsWithRateAdjustments,
  calcLoanScheduledAmount,
  getEffectiveLoanAnnualRate,
  normalizeLoanRateAdjustments,
} from "@/lib/loan-repayment";
import {
  buildMortgageLprRateAdjustments,
  inferMortgageLprDiscountFromRateAdjustments,
  MORTGAGE_BASE_BENCHMARK_RATE,
} from "@/lib/loan-lpr";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import {
  buildCreditCardCyclePersistRows,
  computeCreditBillCascade,
  cycleForStatementMonth,
  fillMissingCreditBillSummaries,
  mergeCreditBillSummariesWithCascade,
} from "@/lib/credit/billing";
import { buildCreditCardInstallmentSchedule, type CreditCardInstallmentRateType } from "@/lib/credit/installment";

export const dynamic = "force-dynamic";

import { addDaysUtc, formatDateLocal, formatDateUtc, toStatementMonth, creditCardCycle, toNumber, addWorkdaysUtc } from "@/lib/date-utils";

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

function formatType(type: string) {
  if (type === "expense") return "支出";
  if (type === "income") return "收入";
  if (type === "advance") return "代付";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
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

function debtPrincipalForAccountSide(
  entry: { amount: unknown; debtPrincipalAmount?: unknown; toAccountId?: string | null },
  debtAccountIds: Set<string>,
) {
  const amount = toNumber(entry.amount);
  const isToDebtAccount = debtAccountIds.has(entry.toAccountId ?? "");
  if (!isToDebtAccount) return amount;
  return Math.abs(toNumber(entry.debtPrincipalAmount ?? amount));
}

function debtPaymentTotal(
  entry: { amount: unknown; debtPrincipalAmount?: unknown; debtInterestAmount?: unknown; debtFeeAmount?: unknown },
  fallbackInterest = 0,
  fallbackFee = 0,
) {
  const hasStructuredSplit =
    entry.debtPrincipalAmount != null ||
    entry.debtInterestAmount != null ||
    entry.debtFeeAmount != null;
  const principal = Math.abs(toNumber(entry.debtPrincipalAmount ?? entry.amount));
  const interest = Math.abs(toNumber(entry.debtInterestAmount));
  const fee = Math.abs(toNumber(entry.debtFeeAmount));
  if (!hasStructuredSplit) return principal + fallbackInterest + fallbackFee;
  return Math.abs(toNumber(entry.amount)) || principal + interest + fee;
}

async function resolveOrCreateAdvanceAccount(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  institutionId: string,
) {
  const institution = await tx.institution.findFirst({
    where: {
      id: institutionId,
      householdId,
      type: { in: ["person", "organization"] },
    },
    select: { id: true, name: true, shortName: true },
  });
  if (!institution) throw new Error("请选择往来对象");

  const existing = await tx.account.findFirst({
    where: {
      householdId,
      institutionId: institution.id,
      kind: AccountKind.loan,
      debtDirection: "receivable",
      isPlaceholder: { not: true },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const group =
    (await tx.accountGroup.findFirst({ where: { householdId, name: { in: ["往来款", "借入/借出", "负债"] } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })) ??
    (await tx.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
  if (!group) throw new Error("缺少账户分组，无法创建往来款账户");

  return tx.account.create({
    data: {
      name: institution.shortName?.trim() || institution.name,
      kind: AccountKind.loan,
      debtDirection: "receivable",
      currency: "CNY",
      groupId: group.id,
      institutionId: institution.id,
      householdId,
      isActive: true,
    },
    select: { id: true, name: true },
  });
}

async function resolveOrCreateDebtAccount(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  debtObjectId: string,
  direction: "payable" | "receivable",
  itemName?: string,
  options?: { forceCreate?: boolean },
) {
  const debtObject = await resolveDebtObject(tx, householdId, debtObjectId);

  const objectName = debtObject.shortName?.trim() || debtObject.name;
  const accountName = itemName?.trim() || `${objectName}的往来款`;
  const objectWhere = debtObject.kind === "counterparty"
    ? { counterpartyId: debtObject.id, institutionId: null }
    : { institutionId: debtObject.id, counterpartyId: null };
  if (!options?.forceCreate) {
    const existing =
      (await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: AccountKind.loan,
          name: accountName,
          debtDirection: direction,
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      })) ??
      (await tx.account.findFirst({
        where: {
          householdId,
          ...objectWhere,
          kind: AccountKind.loan,
          name: accountName,
          isPlaceholder: { not: true },
        },
        include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
      }));
    if (existing) {
      if (!existing.isActive || existing.debtDirection !== direction) {
        return tx.account.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            debtDirection: direction,
          },
          include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
        });
      }
      return existing;
    }
  }

  const group =
    (await tx.accountGroup.findFirst({ where: { householdId, name: { in: ["往来款", "借入/借出", "负债"] } }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] })) ??
    (await tx.accountGroup.findFirst({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
  if (!group) throw new Error("缺少账户分组，无法创建往来款账户");

  return tx.account.create({
    data: {
      name: accountName,
      kind: AccountKind.loan,
      debtDirection: direction,
      currency: "CNY",
      groupId: group.id,
      institutionId: debtObject.kind === "institution" ? debtObject.id : null,
      counterpartyId: debtObject.kind === "counterparty" ? debtObject.id : null,
      householdId,
      isActive: true,
    },
    include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
  });
}

async function resolveDebtObject(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  householdId: string,
  debtObjectId: string,
) {
  const refMatch = /^(counterparty|institution):(.+)$/.exec(debtObjectId);
  const sourceKind = refMatch?.[1] ?? "counterparty";
  const sourceId = refMatch?.[2] ?? debtObjectId;
  if (sourceKind === "institution") {
    const institution = await tx.institution.findFirst({
      where: { id: sourceId, householdId, type: "bank" },
      select: { id: true, name: true, shortName: true, type: true },
    });
    if (!institution) throw new Error("贷款机构只能选择银行");
    return { ...institution, kind: "institution" as const };
  }

  const counterparty = await tx.counterparty.findFirst({
    where: { id: sourceId, householdId },
    select: { id: true, name: true, shortName: true, type: true },
  });
  if (!counterparty) throw new Error("请选择往来对象");
  return { ...counterparty, kind: "counterparty" as const };
}

function parseDateOnlyUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function sameDateOnly(a: Date | null | undefined, b: Date | null | undefined) {
  if (!a || !b) return a == null && b == null;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

const INTEREST_FREE_LOAN_REPAYMENT_METHOD = "免息分期还本";
const FIXED_LOAN_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INTEREST_FREE_LOAN_REPAYMENT_METHOD, "先还利息一次性还本"]);

function parseOptionalPositiveNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveInteger(value: unknown, fallback = 1): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLoanRateAdjustmentsText(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = rows.map((line) => {
    const match = /^(\d{4}-\d{2}-\d{2})\s*[,，\s]\s*([0-9]+(?:\.[0-9]+)?)%?$/.exec(line);
    if (!match) throw new Error(`历史利率格式不正确：${line}`);
    return {
      effectiveDate: match[1],
      annualRate: Number(match[2]),
    };
  });
  const invalid = parsed.find((item) => !Number.isFinite(item.annualRate) || item.annualRate <= 0);
  if (invalid) throw new Error(`历史利率不正确：${invalid.effectiveDate}`);
  return normalizeLoanRateAdjustments(parsed);
}

function calculateLoanPlanAmount(params: {
  principal: number;
  annualRate: number | null;
  totalRuns: number;
  intervalMonths: number;
  repaymentMethod: string;
}) {
  return calcLoanScheduledAmount(params);
}

import { subtypeDisplay } from "@/lib/investment-config";
import { LinkDateRangeFilter, LinkNumberRangeFilter, LinkTableColumnFilter } from "@/components/TableColumnFilter";

type DetailFilterColumn = "date" | "flow" | "type" | "category" | "related" | "remark";

function normalizeIntervalUnitValue(value: string): IntervalUnit {
  if (value === "day" || value === "week" || value === "biweek" || value === "month" || value === "year") {
    return value;
  }
  return IntervalUnit.month;
}

function normalizeIntervalScheduleValue(unit: IntervalUnit, value: number): { unit: IntervalUnit; value: number } {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 1;
  if (unit === "biweek") return { unit: "week", value: safeValue * 2 };
  return { unit, value: safeValue };
}

function parseExecutionDayValue(raw: string, intervalUnit: IntervalUnit): number | null {
  if (intervalUnit === "year") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const DETAIL_EMPTY_VALUE = "(空)";
const DETAIL_FILTER_SEPARATOR = "\u001F";
const DETAIL_FILTER_PARAM_BY_COLUMN: Record<DetailFilterColumn, string> = {
  date: "detailFilterDate",
  flow: "detailFilterFlow",
  type: "detailFilterType",
  category: "detailFilterCategory",
  related: "detailFilterRelated",
  remark: "detailFilterRemark",
};

function parseDetailFilterParam(value: string | undefined) {
  if (!value) return [];
  return value.split(DETAIL_FILTER_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

function serializeDetailFilterValues(values: string[]) {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).join(DETAIL_FILTER_SEPARATOR);
}

function detailFilterSort(a: string, b: string) {
  if (a === DETAIL_EMPTY_VALUE) return 1;
  if (b === DETAIL_EMPTY_VALUE) return -1;
  return a.localeCompare(b, "zh-CN");
}

function fundSubtypeInfo(
  subtype: string | null | undefined,
  source: string | null | undefined,
  _amount: number,
  fundProductType?: string | null,
) {
  const base = subtypeDisplay(subtype, source);
  if (fundProductType === "deposit") {
    if (subtype === "buy") return { label: "存入", cls: "bg-blue-50 text-blue-600" };
    if (subtype === "redeem") return { label: "取出", cls: "bg-orange-50 text-orange-600" };
  }
  // source-based overrides for buy subtype (定投/红利转投/转入)
  if (subtype === "buy" && source) {
    const srcLabels: Record<string, { label: string; cls: string; textCls?: string }> = {
      regular_invest: { label: "定投", cls: "bg-blue-50 text-blue-600" },
      dividend: { label: "红利转投", cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
      switch: { label: "转入", cls: "bg-blue-50 text-blue-600" },
    };
    return srcLabels[source] ?? base;
  }
  return base;
}

function ymdUtc(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ymdUtcDots(d: Date) {
  return ymdUtc(d).replace(/-/g, ".");
}

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

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsvDataUri(rows: string[][]) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;
}

function buildCategoryPathLabels(categories: Array<{ id: string; name: string; type: string; parentId: string | null }>) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map<string, string[]>();

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

  const typeLabel = (type: string) => (type === "expense" ? "支出" : type === "income" ? "收入" : type);
  const labelById = new Map<string, string>();
  for (const c of categories) {
    const names = pathNames(c.id);
    // If the first path name matches the type label (e.g. root "支出" = type "支出"), don't duplicate it
    const prefix = names[0] === typeLabel(c.type) ? "" : `${typeLabel(c.type)}.`;
    labelById.set(c.id, `${prefix}${names.join(".")}`);
  }
  return labelById;
}

function parseMoneyInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return 0;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return n;
}

function parseOptionalDateTimeInput(value: FormDataEntryValue | null) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}


async function updateEntryRow(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return;

  const dateStr = String(formData.get("date") ?? "").trim();
  const inflow = parseMoneyInput(formData.get("inflow"));
  const outflow = parseMoneyInput(formData.get("outflow"));
  const accountIdRaw = String(formData.get("accountId") ?? "").trim();
  const categoryIdRaw = String(formData.get("categoryId") ?? "").trim();
  const categoryName = String(formData.get("categoryName") ?? "").trim();
  const tagsText = String(formData.get("tags") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const memo = String(formData.get("memo") ?? "").trim();
  const touchedAccountIds = new Set<string>();

  const tagNames = tagsText
    .split(/[)]/)
    .map((s) => s.trim())
    .filter(Boolean);

  await prisma.$transaction(async (tx) => {
    const entry = await tx.txRecord.findUnique({
      where: { id: entryId },
      include: {},
    });
    if (!entry) return;
    if (entry.accountId) touchedAccountIds.add(entry.accountId);
    if (entry.toAccountId) touchedAccountIds.add(entry.toAccountId);

    const date =
      dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : entry.date;

    let amount = 0;
    if (inflow > 0) amount = Math.abs(inflow);
    else if (outflow > 0) amount = -Math.abs(outflow);
    else amount = 0;

    let categoryId: string | null = categoryIdRaw || null;
    let nextCategoryName: string | null = null;
    if (categoryId) {
      const found = await tx.category.findUnique({ where: { id: categoryId } });
      if (!found) categoryId = null;
      nextCategoryName = found?.name ?? null;
    } else {
      nextCategoryName = categoryName || null;
      categoryId = nextCategoryName
        ? (await tx.category.findFirst({ where: { name: nextCategoryName } }))?.id ?? null
        : null;
    }

    const siblings = await tx.txRecord.findMany({
      where: { id: entry.id },
      select: { id: true, type: true },
    });
    const currentEntry = siblings[0];

    let nextAccountId: string | null = entry.accountId;
    let nextAccountName: string = entry.accountName;
    if (accountIdRaw) {
      const acc = await tx.account.findUnique({ where: { id: accountIdRaw } });
      if (acc) {
        nextAccountId = acc.id;
        nextAccountName = acc.name;
        touchedAccountIds.add(acc.id);
      }
    }

    const nextStatementMonth = await (async () => {
      if (!nextAccountId) return null;
      const acc = await tx.account.findUnique({ where: { id: nextAccountId }, select: { kind: true, billingDay: true } });
      if (!acc) return null;
      if (acc.kind !== AccountKind.bank_credit && acc.kind !== AccountKind.loan) return null;
      if (!acc.billingDay) return null;
      return toStatementMonth(date, acc.billingDay);
    })();

    const nextType: TransactionType =
        amount > 0
          ? TransactionType.income
          : amount < 0
            ? TransactionType.expense
            : entry.type;

      await tx.txRecord.update({
        where: { id: entryId },
        data: { amount, categoryId, categoryName: nextCategoryName, accountId: nextAccountId, accountName: nextAccountName, statementMonth: nextStatementMonth },
      });

      await tx.txRecord.update({
        where: { id: entry.id },
        data: {
          date,
          type: nextType,
          note: note || null,
        },
      });

if (tagNames.length) {
      const tagIds: string[] = [];
      for (const name of tagNames) {
        const existing = await tx.tag.findFirst({ where: { name } });
        if (existing?.id) {
          tagIds.push(existing.id);
          continue;
        }
        try {
          const created = await tx.tag.create({ data: { name } });
          tagIds.push(created.id);
        } catch {
          const retry = await tx.tag.findFirst({ where: { name } });
          if (retry?.id) tagIds.push(retry.id);
        }
      }

      await replaceEntryTags({ tx, entryId, householdId, tagIds });
    } else {
      await tx.entryTag.deleteMany({ where: { entryId } });
    }
  });

  for (const accountId of touchedAccountIds) {
    await recalcAndSaveAccountBalance(accountId).catch(() => {});
  }
  await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => {});
  revalidateAfterTxChange();
  // Client-side handles refresh via mmh:fund:refresh
}

async function createTransaction(formData: FormData) {
  "use server";

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const postedAtInput = parseOptionalDateTimeInput(formData.get("postedAt"));
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = type === "expense" ? Math.abs(amountRaw) : amountRaw > 0 ? Math.abs(amountRaw) : 0;
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);
  const createInstallment = formData.get("createInstallment") === "true";
  const installmentAmount = parseMoneyInput(formData.get("installmentAmount"));
  const installmentTotal = Number.parseInt(String(formData.get("installmentTotal") ?? "0"), 10);
  const installmentRate = Number(String(formData.get("installmentRate") ?? "0"));
  const installmentRateType = String(formData.get("installmentRateType") ?? "period_fee") as CreditCardInstallmentRateType;

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const postedAt = type === "expense" ? (postedAtInput ?? date) : null;
  const { householdId } = await getHouseholdScope();

  if (!amountAbs) {
    return { ok: false as const, error: "金额不正确" };
  }

  try {
    if (type === "transfer") {
      const fromAccountId = String(formData.get("fromAccountId") ?? "").trim();
      const toAccountId = String(formData.get("toAccountId") ?? "").trim();
      if (!fromAccountId || !toAccountId) return { ok: false as const, error: "转账需要选择转出/转入账户" };
      if (fromAccountId === toAccountId) return { ok: false as const, error: "转出/转入账户不能相同" };

      await prisma.$transaction(async (tx) => {
        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId }, include: { Institution: true } }),
          tx.account.findUnique({ where: { id: toAccountId }, include: { Institution: true } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error("账户不存在");
        if (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc)) {
          throw new Error("基金、存款和往来款账户不能保存为普通转账，请使用对应的专用记账窗口");
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);

        const created = await tx.txRecord.create({
          data: {accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            amount: -amountAbs,
            type: TransactionType.transfer,
            date,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
            statementMonth: transferStatementMonth,
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
        if (!acc) throw new Error("账户不存在");
        if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与收支记账");
        if (createInstallment && acc.kind !== AccountKind.bank_credit) throw new Error("只有信用卡支出可以设置分期");
        if (createInstallment && (installmentAmount <= 0 || installmentAmount > amountAbs)) {
          throw new Error("分期金额必须大于 0，且不能超过本笔支出金额");
        }
        if (createInstallment && installmentRateType !== "annual_interest" && installmentRateType !== "period_fee") {
          throw new Error("分期费率类型不正确");
        }

        const statementMonth =
          (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
            ? toStatementMonth(date, acc.billingDay)
            : null;

        const created = await tx.txRecord.create({
          data: {accountId: acc.id,
            accountName: acc.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: amountRaw < 0 ? amountAbs : -amountAbs,
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
          if (!statementMonth) throw new Error("信用卡账户缺少账单日，无法计算分期账期");
          const schedule = buildCreditCardInstallmentSchedule({
            principal: installmentAmount,
            totalRuns: installmentTotal,
            rateType: installmentRateType,
            rate: installmentRate,
            firstStatementMonth: statementMonth,
            firstDate: date,
          });
          const plan = await tx.creditCardInstallmentPlan.create({
            data: {
              householdId,
              accountId: acc.id,
              sourceEntryId: created.id,
              originalAmount: amountAbs,
              installmentPrincipal: installmentAmount,
              totalRuns: installmentTotal,
              rateType: installmentRateType,
              rate: installmentRate,
              firstStatementMonth: statementMonth,
            },
          });

          await tx.txRecord.create({
            data: {
              householdId,
              accountId: acc.id,
              accountName: acc.name,
              categoryId: cat?.id ?? null,
              categoryName: cat?.name ?? null,
              amount: installmentAmount,
              type: TransactionType.expense,
              date,
              postedAt,
              statementMonth,
              source: "credit_card_installment",
              creditCardInstallmentPlanId: plan.id,
              installmentTotal,
              installmentPrincipal: installmentAmount,
              installmentInterest: 0,
              installmentRole: "adjustment",
              note: `分期冲抵：${note || cat?.name || "信用卡支出"}`,
            },
          });

          for (const row of schedule) {
            const installmentEntry = await tx.txRecord.create({
              data: {
                householdId,
                accountId: acc.id,
                accountName: acc.name,
                categoryId: cat?.id ?? null,
                categoryName: cat?.name ?? null,
                amount: -row.payment,
                type: TransactionType.expense,
                date: row.date,
                postedAt: row.date,
                statementMonth: row.statementMonth,
                source: "credit_card_installment",
                creditCardInstallmentPlanId: plan.id,
                installmentNo: row.installmentNo,
                installmentTotal,
                installmentPrincipal: row.principal,
                installmentInterest: row.interest,
                installmentRole: "payment",
                note: `${note || cat?.name || "信用卡支出"}（分期 ${row.installmentNo}/${installmentTotal}）`,
              },
            });
            await attachEntryTags({ tx, entryId: installmentEntry.id, householdId, tagIds });
          }
        }
      });

      await recalcAndSaveAccountBalance(accountId).catch(() => {});
    } else if (type === "advance") {
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const counterpartyInstitutionId = String(formData.get("counterpartyInstitutionId") ?? "").trim();
      if (!accountId) return { ok: false as const, error: "请选择资金账户" };
      if (!counterpartyInstitutionId) return { ok: false as const, error: "请选择往来对象" };

      let advanceAccountId = "";
      await prisma.$transaction(async (tx) => {
        const [acc, cat] = await Promise.all([
          tx.account.findUnique({ where: { id: accountId }, include: { Institution: true } }),
          categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
        ]);
        if (!acc) throw new Error("账户不存在");
        if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与代付记账");
        const advanceAccount = await resolveOrCreateAdvanceAccount(tx, householdId, counterpartyInstitutionId);
        if (advanceAccount.id === acc.id) throw new Error("资金账户不能和往来款账户相同");
        advanceAccountId = advanceAccount.id;

        const created = await tx.txRecord.create({
          data: {
            accountId: acc.id,
            accountName: acc.name,
            toAccountId: advanceAccount.id,
            toAccountName: advanceAccount.name,
            categoryId: cat?.id ?? null,
            categoryName: cat?.name ?? null,
            amount: -amountAbs,
            type: TransactionType.transfer,
            date,
            note: note || "代付",
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

        const created = await tx.txRecord.create({
          data: { accountId: acc?.id ?? undefined,
            accountName: acc?.name ?? "未知账户",
            categoryId: cat?.id ?? undefined,
            categoryName: cat?.name ?? undefined,
            amount: amountAbs,
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
      let createdInvestmentEntryId: string | null = null;
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
      const effectiveAccountId = accountId || (fundProductType === "deposit" ? "__auto_deposit__" : "");
      if (!effectiveAccountId) return { ok: false as const, error: "请选择账户" };

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
        // accountId 统一为投资账户（基金账户）
        const investAcc =
          fundProductType === "deposit"
            ? await resolveOrCreateDepositAccount(tx, {
                householdId,
                requestedAccountId: accountId || null,
                cashAccountId: cashAccountIdInput,
                fundName: fundNameInput || note || null,
                currency: recordCurrency,
              })
            : await tx.account.findUnique({ where: { id: accountId } });
        if (!investAcc) throw new Error("账户不存在");
        if (!isPureInvestmentAccount(investAcc) && !isDepositAccount(investAcc)) throw new Error("请选择投资/存款账户");
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
        if (fundProductType === "metal" && !metalType) throw new Error("请选择贵金属品种");
        if (fundProductType === "metal" && !metalUnit) throw new Error("请选择贵金属单位");

        const wealthProduct = fundProductType === "wealth"
          ? (wealthProductIdInput
              ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, isActive: true } })
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
        if (fundProductType === "wealth" && !wealthProduct) throw new Error("请选择或新增理财产品");

        const isMetalProduct = fundProductType === "metal";
        const entryFundCode = isMetalProduct ? null : fundCode || null;
        // fundName 只存基金/存款等产品名称；贵金属名称来自 metalTypeName。
        const entryFundName = isMetalProduct ? null : (wealthProduct?.name || fundNameInput || fundCode || null);


        // 创建 TxRecord，直接包含所有基金字段
        // 规则：toAccountId = 资金收到方
        // buy/dividend_cash: accountId=现金(发起), toAccountId=投资(接收)
        // redeem/switch_out: accountId=投资(发起), toAccountId=现金(接收)
        // dividend_reinvest: accountId=投资(发起), toAccountId=投资(接收)
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
          // 现金红利：投资账户(发起) → 现金账户(接收)，金额为正（资金流入现金账户）
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

        if (!isMetalProduct && shouldComputeArrival && entryFundCode) {
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
            note: note || `买入退回 ${entryFundName || entryFundCode}`,
          });
        }
      });
      if (createdInvestmentEntryId) {
        await syncFundTransactionsFromTxRecords([createdInvestmentEntryId]).catch((e) => {
          console.error("createTransaction sync fund transaction:", e);
        });
      }

      if (sourceValue !== "insurance" && fundProductType === "metal" && finalInvestmentAccId) {
        await recalcPreciousMetalPositions(finalInvestmentAccId).catch(() => {});
      } else if (sourceValue !== "insurance" && fundProductType !== "deposit" && finalInvestmentAccId) {
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
      return { ok: false as const, error: "类型不正确" };
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
    const msg = e instanceof Error ? e.message : "记账失败";
    return { ok: false as const, error: msg };
  }
}

async function createDebtTransaction(formData: FormData) {
  "use server";

  const mode = String(formData.get("mode") ?? "").trim();
  const editEntryId = String(formData.get("editEntryId") ?? "").trim();
  const debtAccountId = String(formData.get("debtAccountId") ?? "").trim();
  const debtObjectId = String(formData.get("debtObjectId") ?? formData.get("debtInstitutionId") ?? "").trim();
  const debtItemName = String(formData.get("debtItemName") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const principal = parseMoneyInput(formData.get("principal"));
  const rawInterest = parseMoneyInput(formData.get("interest"));
  const penalty = parseMoneyInput(formData.get("penalty"));
  const prepayStrategyRaw = String(formData.get("prepayStrategy") ?? "").trim();
  const prepayStrategy = normalizeLoanPrepayStrategy(prepayStrategyRaw);
  const annualRateRaw = String(formData.get("annualRate") ?? "").trim();
  const mortgageLprDiscountRaw = String(formData.get("mortgageLprDiscount") ?? "").trim();
  const repaymentMethod = String(formData.get("repaymentMethod") ?? "").trim() || "自由还款";
  const isInterestFreeRepayment = repaymentMethod === INTEREST_FREE_LOAN_REPAYMENT_METHOD;
  const loanYearsRaw = parseInt(String(formData.get("loanYears") ?? ""), 10);
  const repaymentIntervalMonthsRaw = parseInt(String(formData.get("repaymentIntervalMonths") ?? "1"), 10);
  const loanTotalRunsRaw = parseInt(String(formData.get("loanTotalRuns") ?? ""), 10);
  const firstRepaymentDateStr = String(formData.get("firstRepaymentDate") ?? "").trim();
  const createRepaymentPlan = String(formData.get("createRepaymentPlan") ?? "false") === "true";
  const createHistoricalRepaymentRecords = String(formData.get("createHistoricalRepaymentRecords") ?? "false") === "true";
  const historicalLoanRatesText = String(formData.get("historicalLoanRates") ?? "").trim();
  const acceptedLprRateEffectiveDateStr = String(formData.get("acceptedLprRateEffectiveDate") ?? "").trim();
  const acceptedLprAnnualRateRaw = String(formData.get("acceptedLprAnnualRate") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const { householdId } = await getHouseholdScope();
  let recalculateAfterSave: { accountId: string; startDate: string } | null = null;

  if (!["borrow_in", "repay_out", "prepay_out", "lend_out", "collect_in"].includes(mode)) {
    return { ok: false as const, error: "操作类型不正确" };
  }
  if ((!debtAccountId && !debtObjectId) || !cashAccountId) {
    return { ok: false as const, error: "请选择往来对象和资金账户" };
  }
  if (debtAccountId && debtAccountId === cashAccountId) {
    return { ok: false as const, error: "往来对象账户与资金账户不能相同" };
  }
  if (principal <= 0) {
    return { ok: false as const, error: "请输入正确的金额" };
  }
  const interest = mode === "prepay_out" ? 0 : rawInterest;
  if (interest < 0) {
    return { ok: false as const, error: "利息不能小于 0" };
  }
  if (penalty < 0) {
    return { ok: false as const, error: "手续费不能小于 0" };
  }

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const mortgageLprDiscount = isInterestFreeRepayment
    ? null
    : mortgageLprDiscountRaw
      ? parseFloat(mortgageLprDiscountRaw)
      : null;
  if (
    !isInterestFreeRepayment &&
    mortgageLprDiscountRaw &&
    (mortgageLprDiscount == null || !Number.isFinite(mortgageLprDiscount) || mortgageLprDiscount <= 0)
  ) {
    return { ok: false as const, error: "LPR 利率折扣不正确" };
  }
  const annualRate = isInterestFreeRepayment
    ? 0
    : annualRateRaw
      ? parseFloat(annualRateRaw)
      : mortgageLprDiscount != null
        ? Math.round(MORTGAGE_BASE_BENCHMARK_RATE * mortgageLprDiscount * 1000) / 1000
        : null;
  if (!isInterestFreeRepayment && annualRateRaw && (annualRate == null || !Number.isFinite(annualRate) || annualRate <= 0)) {
    return { ok: false as const, error: "年利率不正确" };
  }
  const acceptedLprRateEffectiveDate = acceptedLprRateEffectiveDateStr
    ? parseDateOnlyUtc(acceptedLprRateEffectiveDateStr)
    : null;
  const acceptedLprAnnualRate = acceptedLprAnnualRateRaw ? parseFloat(acceptedLprAnnualRateRaw) : null;
  if (acceptedLprRateEffectiveDateStr && !acceptedLprRateEffectiveDate) {
    return { ok: false as const, error: "接受的 LPR 利率生效日期不正确" };
  }
  if (
    acceptedLprAnnualRateRaw &&
    (acceptedLprAnnualRate == null || !Number.isFinite(acceptedLprAnnualRate) || acceptedLprAnnualRate <= 0)
  ) {
    return { ok: false as const, error: "接受的 LPR 年利率不正确" };
  }
  const firstRepaymentDate = firstRepaymentDateStr ? parseDateOnlyUtc(firstRepaymentDateStr) : null;
  if (firstRepaymentDateStr && !firstRepaymentDate) return { ok: false as const, error: "首次还款日不正确" };
  const repaymentIntervalMonths =
    Number.isFinite(repaymentIntervalMonthsRaw) && repaymentIntervalMonthsRaw > 0 ? repaymentIntervalMonthsRaw : 1;
  const loanTotalRuns =
    Number.isFinite(loanTotalRunsRaw) && loanTotalRunsRaw > 0
      ? loanTotalRunsRaw
      : Number.isFinite(loanYearsRaw) && loanYearsRaw > 0
        ? loanYearsRaw * 12
        : NaN;
  const isFixedRepaymentMethod = FIXED_LOAN_REPAYMENT_METHODS.has(repaymentMethod);
  const calculatedPlanAmount = calculateLoanPlanAmount({
    principal,
    annualRate,
    totalRuns: loanTotalRuns,
    intervalMonths: repaymentIntervalMonths,
    repaymentMethod,
  });
  const repaymentPlanAmount = calculatedPlanAmount;

  if (mode === "borrow_in" && isFixedRepaymentMethod) {
    if (!isInterestFreeRepayment && (annualRate == null || !Number.isFinite(annualRate) || annualRate <= 0)) {
      return { ok: false as const, error: "固定还款方式需要填写年利率" };
    }
    if (!Number.isFinite(repaymentIntervalMonths) || repaymentIntervalMonths <= 0) {
      return { ok: false as const, error: "固定还款方式需要填写还款周期" };
    }
    if (!Number.isFinite(loanTotalRuns) || loanTotalRuns <= 0) {
      return { ok: false as const, error: "固定还款方式需要填写总期数" };
    }
    if (!firstRepaymentDate) {
      return { ok: false as const, error: "固定还款方式需要填写首次还款日" };
    }
    if (!repaymentPlanAmount || repaymentPlanAmount <= 0) {
      return { ok: false as const, error: "无法计算计划还款金额，请检查借款总额、利率和期数" };
    }
  }
  let historicalLoanRateAdjustments: ReturnType<typeof parseLoanRateAdjustmentsText> = [];
  try {
    historicalLoanRateAdjustments = isInterestFreeRepayment ? [] : parseLoanRateAdjustmentsText(historicalLoanRatesText);
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "历史利率格式不正确" };
  }
  if (!isInterestFreeRepayment && historicalLoanRateAdjustments.length === 0 && mortgageLprDiscount != null && mortgageLprDiscount > 0) {
    historicalLoanRateAdjustments = buildMortgageLprRateAdjustments({
      discount: mortgageLprDiscount,
      throughDate: formatDateUtc(new Date()),
    });
  }

  try {
    let resolvedDebtAccountId = debtAccountId;
    let createdRepaymentPlanId: string | null = null;
    const affectedAccountIds = new Set<string>();
    await prisma.$transaction(async (tx) => {
      const debtDirection = mode === "borrow_in" || mode === "repay_out" || mode === "prepay_out" ? "payable" : "receivable";
      const cashAccount = await tx.account.findUnique({ where: { id: cashAccountId } });
      const debtAccount = debtObjectId
        ? await resolveOrCreateDebtAccount(tx, householdId, debtObjectId, debtDirection, debtItemName, { forceCreate: mode === "borrow_in" || mode === "lend_out" })
        : await tx.account.findUnique({
            where: { id: debtAccountId },
            include: { Institution: { select: { id: true, name: true, type: true } }, Counterparty: { select: { id: true, name: true, type: true } } },
          });

      if (!debtAccount || debtAccount.kind !== AccountKind.loan) {
        throw new Error("往来对象账户不存在");
      }
      if (!cashAccount || isPureInvestmentAccount(cashAccount) || cashAccount.kind === AccountKind.loan) {
        throw new Error("资金账户不正确");
      }
      if ((mode === "repay_out" || mode === "prepay_out") && debtAccount.debtDirection !== "payable") {
        throw new Error("还款只能选择已有借款项");
      }
      if (mode === "lend_out" && debtAccount.debtDirection !== "receivable") {
        throw new Error("借出只能选择已有借出项或往来对象");
      }
      if (mode === "collect_in" && debtAccount.debtDirection !== "receivable") {
        throw new Error("收回只能选择已有借出项");
      }
      resolvedDebtAccountId = debtAccount.id;
      if (
        acceptedLprRateEffectiveDate &&
        acceptedLprAnnualRate != null &&
        mode === "repay_out"
      ) {
        const repaymentPlan = await tx.regularInvestPlan.findFirst({
          where: {
            householdId,
            accountId: debtAccount.id,
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
          select: { id: true },
        });
        await tx.loanRateAdjustment.deleteMany({
          where: {
            householdId,
            accountId: debtAccount.id,
            effectiveDate: acceptedLprRateEffectiveDate,
          },
        });
        await tx.loanRateAdjustment.create({
          data: {
            householdId,
            accountId: debtAccount.id,
            regularInvestPlanId: repaymentPlan?.id ?? null,
            effectiveDate: acceptedLprRateEffectiveDate,
            annualRate: acceptedLprAnnualRate,
          },
        });
      }
      const outstandingPrincipalBefore = Math.abs(toNumber(debtAccount.balance));
      if (!editEntryId && mode === "prepay_out" && principal - outstandingPrincipalBefore > 0.005) {
        throw new Error(`提前还本金不能超过当前贷款本金余额 ${outstandingPrincipalBefore.toFixed(2)}`);
      }
      if (!editEntryId && mode === "prepay_out" && prepayStrategy === "settle" && Math.abs(principal - outstandingPrincipalBefore) > 0.005) {
        throw new Error(`全部结清时，提前还本金应等于当前贷款本金余额 ${outstandingPrincipalBefore.toFixed(2)}`);
      }
      if (editEntryId) {
        if (!["borrow_in", "repay_out", "prepay_out", "lend_out", "collect_in"].includes(mode)) {
          throw new Error("只能在借入、借出、还款、提前还款或收回界面编辑往来款记录");
        }
        const original = await tx.txRecord.findFirst({
          where: {
            id: editEntryId,
            householdId,
            deletedAt: null,
            type: TransactionType.transfer,
          },
        });
        if (!original) throw new Error("原还款记录不存在");
        affectedAccountIds.add(original.accountId);
        if (original.toAccountId) affectedAccountIds.add(original.toAccountId);
        affectedAccountIds.add(cashAccount.id);
        affectedAccountIds.add(debtAccount.id);

        const isDebtAccountFromSide = mode === "borrow_in" || mode === "collect_in";
        const transferFromAccount = isDebtAccountFromSide ? debtAccount : cashAccount;
        const transferToAccount = isDebtAccountFromSide ? cashAccount : debtAccount;
        const transferStatementMonth =
          (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
          transferToAccount.billingDay
            ? toStatementMonth(date, transferToAccount.billingDay)
            : null;
        await tx.txRecord.update({
          where: { id: original.id },
          data: {
            accountId: transferFromAccount.id,
            accountName: transferFromAccount.name,
            toAccountId: transferToAccount.id,
            toAccountName: transferToAccount.name,
            amount: mode === "repay_out" || mode === "prepay_out"
              ? -Math.abs(principal + interest + (mode === "prepay_out" ? penalty : 0))
              : mode === "collect_in"
                ? Math.abs(principal + interest)
                : -Math.abs(principal),
            debtPrincipalAmount: Math.abs(principal),
            debtInterestAmount: ["repay_out", "lend_out", "collect_in"].includes(mode) ? Math.abs(interest) : 0,
            debtFeeAmount: mode === "prepay_out" ? Math.abs(penalty) : 0,
            date,
            note: note || null,
            toNote: mode === "prepay_out" ? encodeLoanPrepayStrategy(prepayStrategy) : original.toNote,
            statementMonth: transferStatementMonth,
            source: `debt_${mode}`,
          },
        });
        if (mode === "prepay_out" && transferToAccount.id) {
          recalculateAfterSave = {
            accountId: transferToAccount.id,
            startDate: formatDateUtc(date),
          };
        }

        await tx.txRecord.updateMany({
          where: {
            householdId,
            id: { not: original.id },
            accountId: original.accountId,
            toAccountId: original.toAccountId,
            date: original.date,
            deletedAt: null,
            type: { not: TransactionType.transfer },
            OR: [
              { source: { in: ["debt_repay_out_interest", "debt_prepay_out_interest", "debt_collect_in_interest", "debt_prepay_out_fee"] } },
              { categoryName: { contains: "利息" } },
              { note: { contains: "利息" } },
              { categoryName: { contains: "手续费" } },
              { note: { contains: "违约金" } },
            ],
          },
          data: { deletedAt: new Date() },
        });
        return;
      }
      const isInstitutionBorrow =
        mode === "borrow_in" &&
        !!debtAccount.institutionId &&
        !!debtAccount.Institution &&
        debtAccount.Institution.type === "bank";
      const shouldCreateRepaymentPlan =
        mode === "borrow_in" &&
        createRepaymentPlan &&
        !!firstRepaymentDate &&
        !!repaymentPlanAmount &&
        repaymentPlanAmount > 0 &&
        Number.isFinite(loanTotalRuns) &&
        loanTotalRuns > 0;

      const transferFromAccount = mode === "borrow_in" || mode === "collect_in" ? debtAccount : cashAccount;
      const transferToAccount = mode === "borrow_in" || mode === "collect_in" ? cashAccount : debtAccount;
      const transferStatementMonth =
        (transferToAccount.kind === AccountKind.bank_credit || transferToAccount.kind === AccountKind.loan) &&
        transferToAccount.billingDay
          ? toStatementMonth(date, transferToAccount.billingDay)
          : null;

      await tx.txRecord.create({
        data: {
          accountId: transferFromAccount.id,
          accountName: transferFromAccount.name,
          toAccountId: transferToAccount.id,
          toAccountName: transferToAccount.name,
          amount: mode === "repay_out" || mode === "prepay_out"
            ? -Math.abs(principal + interest + (mode === "prepay_out" ? penalty : 0))
            : mode === "collect_in"
              ? Math.abs(principal + interest)
              : -Math.abs(principal),
          debtPrincipalAmount: Math.abs(principal),
          debtInterestAmount: ["repay_out", "lend_out", "collect_in"].includes(mode) ? Math.abs(interest) : null,
          debtFeeAmount: mode === "prepay_out" ? Math.abs(penalty) : null,
          type: TransactionType.transfer,
          date,
          note: mode === "borrow_in"
            ? [
                note || (isInstitutionBorrow ? "机构借入" : "借入"),
                `还款方式：${repaymentMethod}`,
                isFixedRepaymentMethod && Number.isFinite(repaymentIntervalMonths) && repaymentIntervalMonths > 0
                  ? `周期：每${repaymentIntervalMonths === 1 ? "月" : `${repaymentIntervalMonths}个月`}`
                  : "",
                isFixedRepaymentMethod && Number.isFinite(loanTotalRuns) && loanTotalRuns > 0 ? `期数：${loanTotalRuns}` : "",
                isFixedRepaymentMethod && annualRate != null ? `年利率：${annualRate}%` : "",
                isFixedRepaymentMethod && mortgageLprDiscount != null ? `LPR折扣：${mortgageLprDiscount}` : "",
              ].filter(Boolean).join("；")
            : note || null,
          toNote: mode === "prepay_out" ? encodeLoanPrepayStrategy(prepayStrategy) : null,
          statementMonth: transferStatementMonth,
          source: `debt_${mode}`,
          householdId,
        },
      });

      if (shouldCreateRepaymentPlan && firstRepaymentDate) {
        const totalRuns = loanTotalRuns;
        const executionDay = firstRepaymentDate.getUTCDate();
        const title = `还款：${debtAccount.Institution?.name ?? debtAccount.Counterparty?.name ?? debtAccount.name}`;
        const plan = await tx.regularInvestPlan.create({
          data: {
            accountId: debtAccount.id,
            accountName: debtAccount.name,
            cashAccountId: cashAccount.id,
            cashAccountName: cashAccount.name,
            fundCode: "loan_repayment",
            fundName: title,
            fundProductType: null,
            amount: repaymentPlanAmount,
            intervalUnit: IntervalUnit.month,
            intervalValue: repaymentIntervalMonths,
            executionDay,
            startDate: firstRepaymentDate,
            nextRunDate: calcInitialScheduledRunDate(firstRepaymentDate, IntervalUnit.month, repaymentIntervalMonths, executionDay, false),
            endDate: null,
            totalRuns,
            status: RegularInvestStatus.active,
            feeRate: 0,
            confirmDays: 0,
            arrivalDays: 0,
            memo: encodeScheduledTaskMemo({
              type: "loan_repayment",
              title,
              fromAccountId: cashAccount.id,
              toAccountId: debtAccount.id,
              annualRate: annualRate ?? null,
              mortgageLprDiscount: mortgageLprDiscount ?? null,
              repaymentMethod,
              repaymentIntervalMonths,
              originalTotalRuns: totalRuns,
            }),
            skipPendingPreceding: false,
            householdId,
          },
        });
        await replaceLoanRateAdjustmentsForAccount(tx, {
          householdId,
          accountId: debtAccount.id,
          regularInvestPlanId: plan.id,
          adjustments: historicalLoanRateAdjustments,
        });
        createdRepaymentPlanId = plan.id;
      }

      if (mode === "prepay_out") {
        recalculateAfterSave = {
          accountId: debtAccount.id,
          startDate: formatDateUtc(date),
        };
      }
    });

    await Promise.all([
      ...Array.from(new Set([resolvedDebtAccountId, cashAccountId, ...affectedAccountIds].filter(Boolean)))
        .map((id) => recalcAndSaveAccountBalance(id).catch(() => {})),
    ]);
    await invalidateCreditCardCycleCacheForAccountIds([
      resolvedDebtAccountId,
      cashAccountId,
      ...affectedAccountIds,
    ]).catch(() => {});
    let historicalGenerationWarning: string | null = null;
    if (createdRepaymentPlanId && createHistoricalRepaymentRecords) {
      const createdPlan = await prisma.regularInvestPlan.findFirst({
        where: { id: createdRepaymentPlanId, householdId },
      });
      if (createdPlan) {
        try {
          await executeNonFundScheduledTaskPlan({
            householdId,
            plan: createdPlan,
            task: decodeScheduledTaskMemo(createdPlan.memo),
            initialLoanPrincipal: principal,
          });
        } catch (error) {
          historicalGenerationWarning = error instanceof Error ? error.message : "历史还款记录补生成失败";
        }
      }
    }
    revalidateAfterTxChange();
    if (historicalGenerationWarning) {
      return {
        ok: true as const,
        warning: `借款和还款计划已保存，但历史还款记录没有补生成：${historicalGenerationWarning}`,
        recalculateAfterSave,
      };
    }
    return { ok: true as const, recalculateAfterSave };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "借还款失败" };
  }
}

async function editInvestment(formData: FormData) {
  "use server";
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
  const metalTypeIdInput = String(formData.get("metalTypeId") ?? "").trim();
  const metalUnitIdInput = String(formData.get("metalUnitId") ?? "").trim();
  const buyResultStatus = String(formData.get("buyResultStatus") ?? "normal").trim();
  const linkedRefundEntryId = String(formData.get("linkedRefundEntryId") ?? "").trim() || null;
  const refundAmountRaw = parseFloat(String(formData.get("refundAmount") ?? ""));
  const refundDateStr = String(formData.get("refundDate") ?? "").trim();

  // 检测字段是否被传递（用于区分"不更新"vs"清空")
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

  // 空字符串 → null（清空），有值 → 数值
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
    : undefined; // undefined 表示不更新
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

  if (!entryId) return { ok: false as const, error: "缺少参数" };
  const amountAbs = Number.isFinite(amountRaw) ? Math.abs(amountRaw) : 0;
  if (!amountAbs) return { ok: false as const, error: "金额不正确" };
  if (!dateStr) return { ok: false as const, error: "申请日期不能为空" };
  const date = new Date(dateStr);
  const redeemLike = subtype === "redeem" || subtype === "switch_out";
  const validSubtypes = Object.values(FundSubtype);
  const fundSubtypeValue: FundSubtype = validSubtypes.includes(subtype as FundSubtype) ? (subtype as FundSubtype) : FundSubtype.buy;
  const isDividendReinvest = fundSubtypeValue === FundSubtype.dividend_reinvest;
  const isDividendCash = fundSubtypeValue === FundSubtype.dividend_cash;

  try {
    // 直接查询 TxRecord
    let txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
    });

    if (!txRecord) return { ok: false as const, error: "基金记录不存在" };
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
        return { ok: false as const, error: "买入退回缺少关联买入记录，无法保存" };
      }
      const [fundAccount, cashAccount] = await Promise.all([
        prisma.account.findUnique({ where: { id: sourceBuy.toAccountId }, select: { id: true, name: true, currency: true } }),
        prisma.account.findUnique({ where: { id: sourceBuy.accountId }, select: { id: true, name: true } }),
      ]);
      if (!fundAccount || !cashAccount) return { ok: false as const, error: "买入退回关联账户不存在" };
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
          note: memo || txRecord.note || `买入退回 ${sourceBuy.fundName || sourceBuy.fundCode}`,
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

    // 买入类：accountId=资金账户(发起), toAccountId=投资账户(接收)
    // 赎回/现金红利/buy_failed退回：accountId=投资账户(发起), toAccountId=资金账户(接收)
    const isRedeemOrRefund = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out"
      || txRecord.fundSubtype === "dividend_cash"
      || (txRecord.fundSubtype === "buy_failed" && txRecord.source === "regular_invest_refund");
    const oldInvestmentAccId = (isRedeemOrRefund ? txRecord.accountId : txRecord.toAccountId) ?? "";
    const oldCashAccId = (isRedeemOrRefund ? txRecord.toAccountId : txRecord.accountId) ?? "";
    const oldFundCode = txRecord.fundCode;

    // 检测是否有新的基金账户（通过toAccountId字段传递）
    const hasNewToAccountId = formData.has("toAccountId");
    const newToAccountIdStr = String(formData.get("toAccountId") ?? "").trim();
    const newToAccountId = hasNewToAccountId && newToAccountIdStr ? newToAccountIdStr : null;

    await prisma.$transaction(async (tx) => {
      // 先查询资金账户信息（如果需要）
      const cashAccountInfo = cashAccountId
        ? await tx.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true } })
        : null;

      // 查询新基金账户信息（如果需要）
      const newInvestmentAccountInfo = newToAccountId
        ? await tx.account.findUnique({ where: { id: newToAccountId }, select: { id: true, name: true, fundUnitsDecimals: true, institutionId: true, currency: true } })
        : null;
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
      if (fundProductType === "metal" && !metalType) throw new Error("请选择贵金属品种");
      if (fundProductType === "metal" && !metalUnit) throw new Error("请选择贵金属单位");
      const wealthProduct = fundProductType === "wealth"
        ? (wealthProductIdInput
            ? await tx.wealthProduct.findFirst({ where: { id: wealthProductIdInput, householdId, isActive: true } })
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
      if (fundProductType === "wealth" && !wealthProduct) throw new Error("请选择或新增理财产品");

      // 构建 TxRecord 更新数据
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
      const updateData: any = {
        date,
        fundCode: isMetalProduct ? null : fundCode,
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

        // 买入：资金账户 -> 基金账户；赎回/现金红利/买入退回：基金账户 -> 资金账户。
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

      await tx.txRecord.update({
        where: { id: entryId },
        data: updateData,
      });
      if (
        finalFundSubtype === FundSubtype.buy &&
        sourceValue !== "insurance" &&
        !isMetalProduct &&
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
          note: memo || `买入退回 ${wealthProduct?.name || fundName || fundCode}`,
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
    });
    await syncFundTransactionsFromTxRecords([entryId]).catch((e) => {
      console.error("editInvestment sync fund transaction:", e);
    });

    // 重算持仓：如果基金账户变更，需要重算旧账户和新账户
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
    if (!isMetalProduct) {
      if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
        // 基金账户变更：重算旧账户和新账户
        await recalcFundPositions(oldInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc old fund positions:", e); });
        await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc new fund positions:", e); });
      } else if (finalInvestmentAccId) {
        // 基金账户未变更：只重算该账户
        await recalcFundPositions(finalInvestmentAccId, recalcCodes.length > 0 ? recalcCodes : undefined).catch((e) => { console.error("editInvestment recalc fund positions:", e); });
      }
    }

    // 重算投资账户余额
    await recalcAndSaveAccountBalance(finalInvestmentAccId).catch((e) => { console.error("editInvestment recalc invest balance:", e); });
    if (oldInvestmentAccId && oldInvestmentAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldInvestmentAccId).catch((e) => { console.error("editInvestment recalc old invest balance:", e); });
    }

    // 重算资金账户余额（如果资金账户变更）
    if (oldCashAccId && oldCashAccId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(oldCashAccId).catch((e) => { console.error("editInvestment recalc old cash balance:", e); });
    }
    if (cashAccountId && cashAccountId !== oldCashAccId && cashAccountId !== finalInvestmentAccId) {
      await recalcAndSaveAccountBalance(cashAccountId).catch((e) => { console.error("editInvestment recalc new cash balance:", e); });
    }

    // 更新 T+N 确认天数到统一确认天数库
    if (fundProductType !== "metal" && finalInvestmentAccId && fundCode && confirmDays !== undefined && confirmDays !== null) {
      await setFundConfirmDays(finalInvestmentAccId, fundCode, confirmDays).catch(() => {});

    // 更新入账天数到统一入账天数库
    if (finalInvestmentAccId && fundCode && arrivalDays !== undefined && arrivalDays !== null) {
      await setFundArrivalDays(finalInvestmentAccId, fundCode, arrivalDays).catch(() => {});
    }
    }

    // 更新费率到统一费率库，并按申购/赎回分开保存
    if (fundProductType !== "metal" && finalInvestmentAccId && fundCode && feeRate !== undefined && feeRate !== null) {
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
    return { ok: false as const, error: e instanceof Error ? e.message : "保存失败" };
  }
}

async function fillFundNavFromCache(formData: FormData) {
  "use server";

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: "缺少 entryId" };

  try {
    const txRecord = await prisma.txRecord.findUnique({
      where: { id: entryId },
      select: {
        id: true,
        accountId: true,
        toAccountId: true,
        fundCode: true,
        fundSourceEntryId: true,
        source: true,
        createdAt: true,
        fundArrivalDate: true,
        fundConfirmDate: true,
        date: true,
        amount: true,
        fundSubtype: true,
        fundFee: true,
      },
    });

    if (!txRecord) return { ok: false as const, error: "基金记录不存在" };
    if (!txRecord.fundCode) return { ok: false as const, error: "该记录无基金代码" };

    // 买入类：accountId=资金账户, toAccountId=投资账户
    // 赎回类：accountId=投资账户, toAccountId=资金账户
    const isRedeemFill = txRecord.fundSubtype === "redeem" || txRecord.fundSubtype === "switch_out";
    const investmentAccId = isRedeemFill ? txRecord.accountId : txRecord.toAccountId;
    if (!investmentAccId) return { ok: false as const, error: "该记录没有关联投资账户" };

    const applyDate = ymdUtc(txRecord.date);
    const confirmDate = txRecord.fundConfirmDate
      ? ymdUtc(txRecord.fundConfirmDate)
      : addWorkdaysUtc(applyDate, await getFundConfirmDays(investmentAccId, txRecord.fundCode));
    const navDate = new Date(`${confirmDate}T00:00:00.000Z`);
    const navData = await getFundNav(txRecord.fundCode, navDate, investmentAccId);

    if (!navData) {
      return { ok: false as const, error: `API 未能获取 ${txRecord.fundCode} 在 ${confirmDate} 的净值，确认日期可能是非交易日，或基金查询API未配置` };
    }
    if (!navData.dateMatch) {
      return { ok: false as const, error: `${txRecord.fundCode} 在 ${confirmDate} 无净值，该日期可能是非交易日，请检查确认日期是否正确` };
    }

    const nav = navData.nav;
    const amount = Math.abs(toNumber(txRecord.amount));

    // 从费率库查询费率（按确认日期）
    const arrivalDays = await getFundArrivalDays(investmentAccId, txRecord.fundCode);
    const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDate, arrivalDays) : confirmDate;
    const arrivalDate = new Date(Date.UTC(parseInt(arrivalDateStr.slice(0, 4)), parseInt(arrivalDateStr.slice(5, 7)) - 1, parseInt(arrivalDateStr.slice(8, 10))));
    const feeType = isRedeemFill ? "redeem" : "buy";
    const feeRateRaw = await getFundFeeRateByDate(investmentAccId, txRecord.fundCode, navDate, feeType);
    const feeRate = feeRateRaw / 100;
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(investmentAccId);
    let refundAmount = 0;
    if (txRecord.fundSubtype === "buy") {
      const linkedEntries = await prisma.txRecord.findMany({
        where: {
          deletedAt: null,
          fundCode: txRecord.fundCode,
          OR: [
            { id: txRecord.id },
            { fundSourceEntryId: txRecord.id },
            {
              fundSubtype: FundSubtype.buy_failed,
              source: "regular_invest_refund",
              accountId: investmentAccId,
            },
          ],
        },
        select: {
          id: true,
          date: true,
          createdAt: true,
          fundConfirmDate: true,
          fundArrivalDate: true,
          accountId: true,
          toAccountId: true,
          fundCode: true,
          fundSubtype: true,
          source: true,
          amount: true,
          fundSourceEntryId: true,
        },
      });
      const { refundAmountByBuyId } = allocateBuyFailedRefunds(linkedEntries.map((entry) => ({
        id: entry.id,
        date: entry.date,
        createdAt: entry.createdAt,
        fundConfirmDate: entry.fundConfirmDate,
        fundArrivalDate: entry.fundArrivalDate,
        accountId: entry.accountId,
        toAccountId: entry.toAccountId,
        fundCode: entry.fundCode,
        fundSubtype: entry.fundSubtype,
        source: entry.source,
        amount: toNumber(entry.amount),
        fundSourceEntryId: entry.fundSourceEntryId,
      })));
      refundAmount = refundAmountByBuyId.get(txRecord.id) ?? 0;
    }
    const confirmedAmount = txRecord.fundSubtype === "buy"
      ? Math.max(0, amount - refundAmount)
      : amount;
    const fee = confirmedAmount * feeRate;
    const units = calculateConfirmedBuyUnits({
      grossAmount: amount,
      refundAmount,
      fee,
      nav,
      roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
    });

    // 更新净值、确认日期、手续费、份额
    const updateData: {
      fundConfirmDate: Date;
      fundNav: number;
      fundFee: number;
      fundUnits?: number;
      fundName?: string;
      fundArrivalDate?: Date;
    } = {
      fundConfirmDate: navDate,
      fundNav: nav,
      fundFee: fee,
      fundArrivalDate: arrivalDate,
    };
    if (units != null) {
      updateData.fundUnits = units;
    }
    if (navData.name) {
      updateData.fundName = navData.name;
    }

    await prisma.txRecord.update({
      where: { id: entryId },
      data: updateData,
    });

    await recalcFundPositions(investmentAccId, [txRecord.fundCode]).catch(() => {});
    // revalidation handled by FundShell optimistic update


    return { ok: true as const, nav, units, fee, confirmDate, arrivalDate: arrivalDateStr };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "获取净值失败" };
  }
}



async function createRegularInvest(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "createRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const taskType = normalizeScheduledTaskType(formData.get("taskType"));
  const isFundTask = taskType === "fund_regular_invest";
  const accountId = String(formData.get("accountId") ?? "").trim();
  const fundCodeRaw = String(formData.get("fundCode") ?? "").trim();
  const fundCode = isFundTask ? fundCodeRaw : taskType;
  const fundName = String(formData.get("fundName") ?? "").trim() || (isFundTask ? fundCode : scheduledTaskTypeLabel(taskType));
  const insuranceProductId = String(formData.get("insuranceProductId") ?? "").trim() || null;
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const intervalUnit = String(formData.get("intervalUnit") ?? "month").trim();
  const intervalValueRaw = parseInt(String(formData.get("intervalValue") ?? "1"), 10);
  const startDateStr = String(formData.get("startDate") ?? "").trim();
  const nextRunDateStr = String(formData.get("nextRunDate") ?? "").trim();
  const endDateStr = String(formData.get("endDate") ?? "").trim();
  const totalRunsRaw = String(formData.get("totalRuns") ?? "").trim();
  const executionDayRaw = String(formData.get("executionDay") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || null;
  const feeRateRaw = String(formData.get("feeRate") ?? "").trim();
  const confirmDaysRaw = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysRaw = String(formData.get("arrivalDays") ?? "").trim();
  const annualRate = parseOptionalPositiveNumber(formData.get("annualRate"));
  const repaymentMethod = String(formData.get("repaymentMethod") ?? "").trim() || "自由还款";
  const repaymentIntervalMonths = parsePositiveInteger(formData.get("repaymentIntervalMonths"), 1);
  const skipPendingPreceding = formData.get("skipPendingPreceding") !== "false"; // default true

  if (!accountId || !amountRaw || !startDateStr || (isFundTask && !fundCode)) {
    return { ok: false as const, error: "缺少必填字段" };
  }
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    return { ok: false as const, error: "金额不正确" };
  }
  if (!isFundTask && !cashAccountId) {
    return { ok: false as const, error: "计划任务缺少资金账户" };
  }
  if (taskType === "insurance_premium" && !insuranceProductId) {
    return { ok: false as const, error: "缴费计划缺少保险产品" };
  }

  const targetAcc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!targetAcc) return { ok: false as const, error: isFundTask ? "基金账户不存在" : "目标账户不存在" };
  if (householdId && targetAcc.householdId !== householdId) return { ok: false as const, error: "目标账户不属于当前账簿" };

  const cashAcc = cashAccountId
    ? await prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, householdId: true } })
    : null;
  if (cashAcc && householdId && cashAcc.householdId !== householdId) return { ok: false as const, error: "资金账户不属于当前账簿" };

  const parsedStartDate = parseDateOnlyUtc(startDateStr);
  if (!parsedStartDate) return { ok: false as const, error: "开始日期不正确" };

  const feeRate = feeRateRaw ? parseFloat(feeRateRaw) : null;
  const confirmDays = confirmDaysRaw ? normalizeNonNegativeDays(confirmDaysRaw, 0) : null;
  const arrivalDays = arrivalDaysRaw ? normalizeNonNegativeDays(arrivalDaysRaw, 2) : null;
  const normalizedInterval = normalizeIntervalScheduleValue(
    normalizeIntervalUnitValue(intervalUnit),
    Number.isFinite(intervalValueRaw) && intervalValueRaw > 0 ? intervalValueRaw : 1,
  );
  const intervalValue = normalizedInterval.value;
  const intervalUnitValue = normalizedInterval.unit;
  const executionDay = parseExecutionDayValue(executionDayRaw, intervalUnitValue);
  const startDate = isFundTask ? skipWeekend(parsedStartDate) : parsedStartDate;
  const parsedNextRunDate = nextRunDateStr ? parseDateOnlyUtc(nextRunDateStr) : null;
  if (nextRunDateStr && !parsedNextRunDate) return { ok: false as const, error: "下次执行日期不正确" };
  const nextRunDate = parsedNextRunDate ?? calcInitialScheduledRunDate(parsedStartDate, intervalUnitValue, intervalValue, executionDay, isFundTask);
  const endDate = endDateStr ? parseDateOnlyUtc(endDateStr) : null;
  if (endDateStr && !endDate) return { ok: false as const, error: "结束日期不正确" };
  const totalRuns = totalRunsRaw ? parseInt(totalRunsRaw, 10) : null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.regularInvestPlan.create({
        data: {
          accountId,
          accountName: targetAcc.name,
          cashAccountId: cashAccountId || null,
          cashAccountName: cashAcc?.name || null,
          fundCode,
          fundName,
          fundProductType: isFundTask ? (targetAcc.investProductType || null) : null,
          amount: amountRaw,
          intervalUnit: intervalUnitValue,
          intervalValue,
          executionDay: executionDay != null && Number.isFinite(executionDay) ? executionDay : null,
          startDate,
          nextRunDate,
          endDate: endDate && Number.isFinite(endDate.getTime()) ? endDate : null,
          totalRuns: totalRuns && Number.isFinite(totalRuns) && totalRuns > 0 ? totalRuns : null,
          status: RegularInvestStatus.active,
          feeRate: isFundTask && feeRate != null && Number.isFinite(feeRate) ? feeRate : isFundTask ? null : 0,
          confirmDays: isFundTask ? confirmDays : 0,
          arrivalDays: isFundTask ? arrivalDays : 0,
          memo: encodeScheduledTaskMemo({
            type: taskType,
            title: fundName,
            fromAccountId: cashAccountId || null,
            toAccountId: accountId,
            insuranceProductId,
            annualRate: taskType === "loan_repayment" ? annualRate : null,
            repaymentMethod: taskType === "loan_repayment" ? repaymentMethod : null,
            repaymentIntervalMonths: taskType === "loan_repayment" ? repaymentIntervalMonths : null,
          }),
          skipPendingPreceding: isFundTask ? skipPendingPreceding : false,
          ...{ householdId },
        },
      });

      // 同步更新确认天数和手续费率统一库（与 API Route 保持一致）
      const newDays = confirmDays != null && Number.isFinite(confirmDays) ? confirmDays : 0;
      const newRate = feeRate != null && Number.isFinite(feeRate) ? feeRate : 0;
      if (isFundTask && accountId && fundCode) {
        await setFundConfirmDaysInTx(tx, accountId, fundCode, newDays);
        await setFundFeeRateByDateInTx(tx, accountId, fundCode, newRate, startDate, "buy");
        const newArrivalDays = arrivalDays != null && Number.isFinite(arrivalDays) ? arrivalDays : 2;
        await setFundArrivalDaysInTx(tx, accountId, fundCode, newArrivalDays);
      }
    });







    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "创建失败" };
  }
}

async function regularInvestAction(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "regularInvestAction") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  const actionType = String(formData.get("action") ?? "").trim();

  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

  try {
    if (actionType === "pause") {
      if (plan.status !== RegularInvestStatus.active) {
        return { ok: false as const, error: "只有活跃状态的计划才能暂停" };
      }
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.paused },
      });
    } else if (actionType === "resume") {
      if (plan.status !== RegularInvestStatus.paused) {
        return { ok: false as const, error: "只有暂停状态的计划才能恢复" };
      }
      const task = decodeScheduledTaskMemo(plan.memo);
      const usesBusinessDays = task.type === "fund_regular_invest";
      const now = new Date();
      const nextRun = plan.lastRunDate
        ? calcNextScheduledRunDate(plan.lastRunDate, plan.intervalUnit, plan.intervalValue, plan.executionDay, usesBusinessDays)
        : calcInitialScheduledRunDate(plan.startDate, plan.intervalUnit, plan.intervalValue, plan.executionDay, usesBusinessDays);
      const actualNextRun = nextRun < now
        ? calcInitialScheduledRunDate(now, plan.intervalUnit, plan.intervalValue, plan.executionDay, usesBusinessDays)
        : nextRun;

      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.active, nextRunDate: actualNextRun },
      });
    } else if (actionType === "stop") {
      if (plan.status === RegularInvestStatus.stopped || plan.status === RegularInvestStatus.completed) {
        return { ok: false as const, error: "计划已终止或已完成" };
      }
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.stopped },
      });
    } else {
      return { ok: false as const, error: "未知操作类型" };
    }

    // Client-side handles page refresh via router.refresh() + mmh:fund:refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "操作失败" };
  }
}

async function updateRegularInvest(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "updateRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

  const existingTask = decodeScheduledTaskMemo(plan.memo);
  const taskType = normalizeScheduledTaskType(formData.get("taskType") || existingTask.type);
  const isFundTask = taskType === "fund_regular_invest";
  const accountId = String(formData.get("accountId") ?? plan.accountId).trim();
  const fundCodeRaw = String(formData.get("fundCode") ?? plan.fundCode).trim();
  const fundCode = isFundTask ? fundCodeRaw : taskType;
  const insuranceProductId = String(formData.get("insuranceProductId") ?? "").trim() || existingTask.insuranceProductId || null;
  const fundName = String(formData.get("fundName") ?? "").trim();
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const intervalUnit = String(formData.get("intervalUnit") ?? "").trim();
  const intervalValueRaw = parseInt(String(formData.get("intervalValue") ?? "1"), 10);
  const startDateStr = String(formData.get("startDate") ?? "").trim();
  const nextRunDateStr = String(formData.get("nextRunDate") ?? "").trim();
  const endDateStr = String(formData.get("endDate") ?? "").trim();
  const totalRunsRaw = String(formData.get("totalRuns") ?? "").trim();
  const executionDayRaw = String(formData.get("executionDay") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || null;
  const feeRateRaw = String(formData.get("feeRate") ?? "").trim();
  const confirmDaysRaw = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysRaw = String(formData.get("arrivalDays") ?? "").trim();
  const nextAnnualRate = formData.has("annualRate")
    ? parseOptionalPositiveNumber(formData.get("annualRate"))
    : existingTask.annualRate ?? null;
  const nextRepaymentMethod = formData.has("repaymentMethod") && String(formData.get("repaymentMethod") ?? "").trim()
    ? String(formData.get("repaymentMethod") ?? "").trim()
    : existingTask.repaymentMethod ?? "自由还款";
  const nextRepaymentIntervalMonths = formData.has("repaymentIntervalMonths")
    ? parsePositiveInteger(formData.get("repaymentIntervalMonths"), 1)
    : existingTask.repaymentIntervalMonths ?? 1;

  if (!accountId || (isFundTask && !fundCode)) return { ok: false as const, error: "缺少必填字段" };
  if (!isFundTask && !cashAccountId) return { ok: false as const, error: "计划任务缺少资金账户" };
  if (taskType === "insurance_premium" && !insuranceProductId) return { ok: false as const, error: "缴费计划缺少保险产品" };

  const updateData: any = {};
  const displayName = fundName || (isFundTask ? plan.fundName || fundCode : scheduledTaskTypeLabel(taskType));
  updateData.accountId = accountId;
  updateData.fundCode = fundCode;
  updateData.fundName = displayName;
  updateData.memo = encodeScheduledTaskMemo({
    type: taskType,
    title: displayName,
    fromAccountId: cashAccountId || null,
    toAccountId: accountId,
    insuranceProductId,
    annualRate: taskType === "loan_repayment" ? nextAnnualRate : null,
    repaymentMethod: taskType === "loan_repayment" ? nextRepaymentMethod : null,
    repaymentIntervalMonths: taskType === "loan_repayment" ? nextRepaymentIntervalMonths : null,
  });
  if (accountId !== plan.accountId || formData.has("accountId")) {
    const targetAcc = await prisma.account.findUnique({ where: { id: accountId }, select: { name: true, householdId: true, investProductType: true } });
    if (!targetAcc) return { ok: false as const, error: isFundTask ? "基金账户不存在" : "目标账户不存在" };
    if (householdId && targetAcc.householdId !== householdId) return { ok: false as const, error: "目标账户不属于当前账簿" };
    updateData.accountName = targetAcc.name;
    updateData.fundProductType = isFundTask ? (targetAcc.investProductType || plan.fundProductType || null) : null;
  } else if (!isFundTask) {
    updateData.fundProductType = null;
  }
  if (Number.isFinite(amountRaw) && amountRaw > 0) updateData.amount = amountRaw;
  const normalizedEffectiveInterval = normalizeIntervalScheduleValue(
    normalizeIntervalUnitValue(intervalUnit || plan.intervalUnit),
    Number.isFinite(intervalValueRaw) && intervalValueRaw > 0 ? intervalValueRaw : plan.intervalValue,
  );
  const effectiveIntervalUnit = normalizedEffectiveInterval.unit;
  const effectiveIntervalValue = normalizedEffectiveInterval.value;
  const effectiveExecutionDay = effectiveIntervalUnit === "year"
    ? null
    : executionDayRaw
      ? parseExecutionDayValue(executionDayRaw, effectiveIntervalUnit)
      : formData.has("executionDay")
        ? null
        : plan.executionDay;
  if (intervalUnit || (Number.isFinite(intervalValueRaw) && intervalValueRaw > 0)) {
    updateData.intervalUnit = effectiveIntervalUnit;
    updateData.intervalValue = effectiveIntervalValue;
  }
  const parsedStartDate = startDateStr ? parseDateOnlyUtc(startDateStr) : null;
  if (startDateStr && !parsedStartDate) return { ok: false as const, error: "开始日期不正确" };
  const effectiveStartDate = parsedStartDate ?? plan.startDate;
  const nextStoredStartDate = parsedStartDate
    ? isFundTask ? skipWeekend(parsedStartDate) : parsedStartDate
    : plan.startDate;
  const startDateChanged = parsedStartDate != null && !sameDateOnly(nextStoredStartDate, plan.startDate);
  if (startDateChanged && ((plan.executedRuns ?? 0) > 0 || plan.lastRunDate)) {
    return { ok: false as const, error: "该计划已生成记录，不能修改起始日期。请通过下次执行/缴费日期、停止日期或总次数调整后续计划。" };
  }
  if (startDateChanged) {
    const linkedRecordCount = await prisma.txRecord.count({ where: { regularInvestPlanId: plan.id, deletedAt: null } });
    if (linkedRecordCount > 0) {
      return { ok: false as const, error: "该计划已生成记录，不能修改起始日期。请通过下次执行/缴费日期、停止日期或总次数调整后续计划。" };
    }
  }
  const scheduleChanged =
    (formData.has("taskType") && taskType !== existingTask.type) ||
    startDateChanged ||
    (intervalUnit !== "" && effectiveIntervalUnit !== plan.intervalUnit) ||
    (formData.has("intervalValue") && effectiveIntervalValue !== plan.intervalValue) ||
    (effectiveIntervalUnit !== "year" && formData.has("executionDay") && effectiveExecutionDay !== plan.executionDay);
  if (parsedStartDate) updateData.startDate = nextStoredStartDate;
  if (effectiveIntervalUnit === "year") updateData.executionDay = null;
  else if (formData.has("executionDay")) updateData.executionDay = effectiveExecutionDay;
  if (nextRunDateStr) {
    const parsedNextRunDate = parseDateOnlyUtc(nextRunDateStr);
    if (!parsedNextRunDate) return { ok: false as const, error: "下次执行日期不正确" };
    updateData.nextRunDate = parsedNextRunDate;
  } else if (scheduleChanged) {
    updateData.nextRunDate = plan.lastRunDate
      ? calcNextScheduledRunDate(
          plan.lastRunDate,
          effectiveIntervalUnit,
          effectiveIntervalValue,
          effectiveExecutionDay,
          isFundTask,
        )
      : calcInitialScheduledRunDate(
          effectiveStartDate,
          effectiveIntervalUnit,
          effectiveIntervalValue,
          effectiveExecutionDay,
          isFundTask,
        );
  }
  if (endDateStr) {
    const endDate = parseDateOnlyUtc(endDateStr);
    if (!endDate) return { ok: false as const, error: "结束日期不正确" };
    updateData.endDate = endDate;
  } else if (formData.has("endDate")) {
    updateData.endDate = null;
  }
  if (totalRunsRaw) {
    const totalRuns = parseInt(totalRunsRaw, 10);
    if (Number.isFinite(totalRuns) && totalRuns > 0) updateData.totalRuns = totalRuns;
  } else if (formData.has("totalRuns")) {
    updateData.totalRuns = null;
  }
  if (cashAccountId != null) {
    updateData.cashAccountId = cashAccountId;
    if (cashAccountId) {
      const cashAcc = await prisma.account.findUnique({ where: { id: cashAccountId }, select: { name: true, householdId: true } });
      if (cashAcc && householdId && cashAcc.householdId !== householdId) return { ok: false as const, error: "资金账户不属于当前账簿" };
      updateData.cashAccountName = cashAcc?.name || null;
    } else {
      updateData.cashAccountName = null;
    }
  }
  if (isFundTask && feeRateRaw) {
    const feeRate = parseFloat(feeRateRaw);
    if (Number.isFinite(feeRate)) updateData.feeRate = feeRate;
  } else if (isFundTask && formData.has("feeRate")) {
    updateData.feeRate = null;
  }
  if (isFundTask && confirmDaysRaw) {
    updateData.confirmDays = normalizeNonNegativeDays(confirmDaysRaw, 0);
  } else if (isFundTask && formData.has("confirmDays")) {
    updateData.confirmDays = null;
  }

  if (isFundTask && arrivalDaysRaw) {
    updateData.arrivalDays = normalizeNonNegativeDays(arrivalDaysRaw, 2);
  } else if (isFundTask && formData.has("arrivalDays")) {
    updateData.arrivalDays = null;
  }
  if (!isFundTask) {
    updateData.fundProductType = null;
    updateData.confirmDays = 0;
    updateData.arrivalDays = 0;
    updateData.feeRate = 0;
    updateData.skipPendingPreceding = false;
  } else if (formData.has("skipPendingPreceding")) {
    updateData.skipPendingPreceding = formData.get("skipPendingPreceding") !== "false";
  }

  try {
    await prisma.regularInvestPlan.update({
      where: { id: planId },
      data: updateData,
    });

    if (isFundTask && updateData.confirmDays != null) {
      await setFundConfirmDays(accountId, fundCode, updateData.confirmDays).catch(() => {});
    }
    if (isFundTask && updateData.arrivalDays != null) {
      await setFundArrivalDays(accountId, fundCode, updateData.arrivalDays).catch(() => {});
    }

    // Client-side handles page refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "更新失败" };
  }
}

async function deleteRegularInvest(formData: FormData) {
  "use server";
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "deleteRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

  const deleteRecords = formData.get("deleteRecords") === "1";

  try {
    if (deleteRecords && plan.accountId) {
      // 软删除关联的交易记录
      await prisma.txRecord.updateMany({
        where: { regularInvestPlanId: planId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    await prisma.regularInvestPlan.delete({ where: { id: planId } });

    if (plan.accountId && plan.fundCode) {
      await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
    }

    // Client-side handles page refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "删除失败" };
  }
}

/** 定投操作的统一入口：根据 intent 分发到不同的 Server Action */
async function regularInvestFormAction(formData: FormData) {
  "use server";
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent === "createRegularInvest") return createRegularInvest(formData);
  if (intent === "regularInvestAction") return regularInvestAction(formData);
  if (intent === "updateRegularInvest") return updateRegularInvest(formData);
  if (intent === "deleteRegularInvest") return deleteRegularInvest(formData);
  return { ok: false as const, error: "未知 intent" };
}

async function updateTransactionFromDialog(formData: FormData) {
  "use server";

  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: "缺少 entryId" };

  const type = String(formData.get("type") ?? "").trim();
  const dateStr = String(formData.get("date") ?? "").trim();
  const postedAtInput = parseOptionalDateTimeInput(formData.get("postedAt"));
  const amountRaw = parseMoneyInput(formData.get("amount") ?? null);
  const amountAbs = type === "expense" ? Math.abs(amountRaw) : amountRaw > 0 ? Math.abs(amountRaw) : 0;
  const note = String(formData.get("note") ?? "").trim();
  const toNote = String(formData.get("toNote") ?? "").trim();
  const tagIdsRaw = String(formData.get("tagIds") ?? "[]");
  const tagIds: string[] = JSON.parse(tagIdsRaw).filter((id: string) => typeof id === "string" && id.length > 0);

  const date = dateStr && !Number.isNaN(new Date(dateStr).getTime()) ? new Date(dateStr) : new Date();
  const postedAt = type === "expense" ? (postedAtInput ?? date) : null;
  if (!amountAbs) return { ok: false as const, error: "金额不正确" };

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
      if (!entry) throw new Error("记录不存 ");
      if (entry.accountId) touchedAccountIds.add(entry.accountId);
      if (entry.toAccountId) touchedAccountIds.add(entry.toAccountId);

      await replaceEntryTags({ tx, entryId, householdId: entry.householdId, tagIds });

      if (type === "transfer") {
        const fromAccountId = String(formData.get("fromAccountId") ?? "").trim();
        const toAccountId = String(formData.get("toAccountId") ?? "").trim();
        if (!fromAccountId || !toAccountId) throw new Error("转账需要选择转出/转入账户");
        if (fromAccountId === toAccountId) throw new Error("转出/转入账户不能相同");

        const [fromAcc, toAcc] = await Promise.all([
          tx.account.findUnique({ where: { id: fromAccountId } }),
          tx.account.findUnique({ where: { id: toAccountId } }),
        ]);
        if (!fromAcc || !toAcc) throw new Error("账户不存在");
        touchedAccountIds.add(fromAcc.id);
        touchedAccountIds.add(toAcc.id);
        if (isSpecialCashTargetAccount(fromAcc) || isSpecialCashTargetAccount(toAcc)) {
          throw new Error("基金、存款和往来款账户不能保存为普通转账，请使用对应的专用记账窗口");
        }
        const transferCurrency = resolveSameCurrencyTransfer(fromAcc, toAcc);

        const transferStatementMonth = statementMonthForTransfer(date, fromAcc, toAcc);

        await tx.txRecord.update({
          where: { id: entryId },
          data: {
            amount: -amountAbs,
            accountId: fromAcc.id,
            accountName: fromAcc.name,
            toAccountId: toAcc.id,
            toAccountName: toAcc.name,
            categoryId: null,
            categoryName: null,
            statementMonth: transferStatementMonth,
            date,
            type: TransactionType.transfer,
            note: note || null,
            toNote: (toNote || note) || null,
            currency: transferCurrency,
          },
        });
        return;
      }

      if (type === "investment") {
        // 编辑模式：accountId=投资账户(统一), cashAccountId=资金账户
        const accountIdFormData = String(formData.get("accountId") ?? "").trim();
        const cashAccountIdFormData = String(formData.get("cashAccountId") ?? "").trim();
        const fundCode = String(formData.get("fundCode") ?? "").trim();
        const productType = String(formData.get("productType") ?? "fund").trim();
        const subtype = String(formData.get("subtype") ?? "buy").trim();
        const redeemLike = subtype === "redeem" || subtype === "switch_out";
        const isInsuranceEntry = entry.source === "insurance" || !!entry.insuranceProductId;

        const investAcc = accountIdFormData ? await tx.account.findUnique({ where: { id: accountIdFormData } }) : null;
        if (!investAcc) throw new Error("请选择投资账户");
        touchedAccountIds.add(investAcc.id);

        // 资金账户：优先用表单传入的，否则从原始记录推断
        let cashAccId: string | null = null;
        let cashAccName: string | null = null;
        if (cashAccountIdFormData) {
          const cashAcc = await tx.account.findUnique({ where: { id: cashAccountIdFormData } });
          if (cashAcc) { cashAccId = cashAcc.id; cashAccName = cashAcc.name; touchedAccountIds.add(cashAcc.id); }
        }
        // 回退：从原始记录推断资金账户
        if (!cashAccId) {
          if (redeemLike) {
            // 赎回记录：toAccountId 是资金账户（接收方）
            if (entry.toAccountId) {
              const acc = await tx.account.findUnique({ where: { id: entry.toAccountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; touchedAccountIds.add(acc.id); }
            }
          } else {
            // 买入记录：accountId 是资金账户（发起方）
            if (entry.accountId && entry.accountId !== investAcc.id) {
              const acc = await tx.account.findUnique({ where: { id: entry.accountId } });
              if (acc) { cashAccId = acc.id; cashAccName = acc.name; touchedAccountIds.add(acc.id); }
            }
          }
        }

        // 确定记录方向：toAccountId = 资金收到方
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

        // 更新 TxRecord
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
            fundCode: fundCode || null,
            insuranceAction: isInsuranceEntry ? (redeemLike ? "refund" : "premium") : entry.insuranceAction,
            insuranceProductName: isInsuranceEntry ? (entry.fundName ?? null) : entry.insuranceProductName,
            fundProductType: isInsuranceEntry ? null : (productType as any) || null,
            fundSubtype: (subtype as any) || null,
            date,
            type: TransactionType.investment,
            note: note || null,
          },
        });

        investRecalcAccountId = investAcc.id;
        investRecalcFundCode = fundCode || null;
        return;
      }

      if (type !== "expense" && type !== "income") throw new Error("类型不正确");
      const accountId = String(formData.get("accountId") ?? "").trim();
      const categoryId = String(formData.get("categoryId") ?? "").trim();
      const keepFundDetail = formData.get("keepFundDetail") === "true";

      const [acc, cat] = await Promise.all([
        accountId ? tx.account.findUnique({ where: { id: accountId } }) : Promise.resolve(null),
        categoryId ? tx.category.findUnique({ where: { id: categoryId } }) : Promise.resolve(null),
      ]);
      if (!acc) throw new Error("请选择账户");
      touchedAccountIds.add(acc.id);
      if (isPureInvestmentAccount(acc)) throw new Error("基金/理财账户不参与收支记账");

      // 检查是否是基金交易（通过 toAccountId + fundProductType）
      const isFundTransaction = entry.toAccountId && entry.fundProductType;

      const statementMonth =
        (acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan) && acc.billingDay
          ? toStatementMonth(date, acc.billingDay)
          : null;

      const expenseOrIncomeData: Record<string, unknown> = {
        amount: type === "income" ? amountAbs : amountRaw < 0 ? amountAbs : -amountAbs,
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
    await saveEntryUndo(prisma, ctx, undo, "edit", "编辑明细");
    return { ok: true as const };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "保存失败";
    return { ok: false as const, error: msg };
  }
}

async function backfillStatementMonthForAccount(formData: FormData) {
  "use server";

  const accountId = String(formData.get("accountId") ?? "").trim();
  if (!accountId) return;

  await prisma.$transaction(async (tx) => {
    const acc = await tx.account.findUnique({
      where: { id: accountId },
      include: { Institution: true },
    });
    if (!acc?.billingDay) return;
    if (acc.kind !== AccountKind.bank_credit && acc.kind !== AccountKind.loan) return;

    const inst = (acc.Institution?.name ?? "").trim();
    const legacyNames = [acc.name, inst ? `${inst}·${acc.name}` : ""].filter(Boolean);

    const rows = await tx.txRecord.findMany({
      where: {
        statementMonth: null,
        deletedAt: null,
        OR: [
          { accountId: acc.id },
          ...(legacyNames.length ? [{ accountName: { in: legacyNames } }] : []),
        ],
      },
      select: { id: true, date: true },
      take: 20000,
    });

    const byMonth = new Map<string, string[]>();
    for (const r of rows) {
      const m = toStatementMonth(r.date, acc.billingDay);
      const list = byMonth.get(m) ?? [];
      list.push(r.id);
      byMonth.set(m, list);
    }

    for (const [m, ids] of byMonth.entries()) {
      await tx.txRecord.updateMany({
        where: { id: { in: ids } },
        data: { statementMonth: m },
      });
    }
  });

  // Client-side handles page refresh
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
  }>;
}) {
  const params = await searchParams;
  await connection();
  const accountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const accountName = typeof params?.account === "string" ? params.account.trim() : "";
  // 如果没有选择账户，默认跳转到概览页
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
  const pageSizeParam = typeof params?.pageSize === "string" ? parseInt(params.pageSize, 10) : 20;
  const pageSize = [10, 20, 40].includes(pageSizeParam) ? pageSizeParam : 20;
  const detailPageParam = typeof params?.detailPage === "string" ? parseInt(params.detailPage, 10) : 1;
  const detailPage = Number.isFinite(detailPageParam) && detailPageParam >= 1 ? detailPageParam : 1;
  const detailAll = params?.detailAll === "1";
  const detailDateFrom = typeof params?.detailDateFrom === "string" ? params.detailDateFrom.trim() : "";
  const detailDateTo = typeof params?.detailDateTo === "string" ? params.detailDateTo.trim() : "";
  const detailInFrom = typeof params?.detailInFrom === "string" ? params.detailInFrom.trim() : "";
  const detailInTo = typeof params?.detailInTo === "string" ? params.detailInTo.trim() : "";
  const detailOutFrom = typeof params?.detailOutFrom === "string" ? params.detailOutFrom.trim() : "";
  const detailOutTo = typeof params?.detailOutTo === "string" ? params.detailOutTo.trim() : "";
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
  const fundCodeParam = typeof params?.fundCode === "string" ? params.fundCode.trim() : "";
  const fundSortParam = typeof params?.fundSort === "string" ? params.fundSort.trim() : "marketValue";
  const fundSortDirParam = params?.fundSortDir === "asc" ? "asc" : "desc";
  const fundPageSizeParam = typeof params?.fundPageSize === "string" ? parseInt(params.fundPageSize, 10) : 20;
  const fundPageSize = [10, 20, 40].includes(fundPageSizeParam) ? fundPageSizeParam : 20;
  const fundPageParam = typeof params?.fundPage === "string" ? parseInt(params.fundPage, 10) : 1;
  const fundPage = Number.isFinite(fundPageParam) && fundPageParam >= 1 ? fundPageParam : 1;
  const showCleared = params?.showCleared === "1";

  // 读取涨跌颜色方案
  const cookieStore = await cookies();
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
  // 颜色辅助函数
  const upCls = isRedUp ? "text-red-600" : "text-emerald-700";
  const downCls = isRedUp ? "text-emerald-700" : "text-red-600";
  const pnlCls = (n: number) => n > 0 ? upCls : n < 0 ? downCls : "text-slate-600";
  const pnlBinCls = (cond: boolean) => cond ? upCls : downCls;

  // Common data: 跨账户共享，跨请求缓存
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
  // selectedAccount: per-account，请求级缓存去重
  const selectedAccount = await loadSelectedAccount(accountId || undefined, hidFilter);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(selectedAccount?.fundUnitsDecimals, 3);
  const isBillAccount =
    (selectedAccount?.kind === AccountKind.bank_credit || selectedAccount?.kind === AccountKind.loan) ||
    !!selectedAccount?.billingDay;
  const billAccountIds = selectedAccount && isBillAccount
    ? await getCreditBillAccountIds(prisma, selectedAccount)
    : [];
  const billAccountIdSet = new Set(billAccountIds);
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
  const view: "bill" | "detail" | "investfund" | "investmoney" | "investwealth" | "regularinvest" | "debt" | "overview" | "deposit" | "insurance" =
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
  const needsDetailEntries = view === "detail" || view === "deposit" || view === "insurance" || (view === "bill" && isBillAccount);

  const legacyNames = (() => {
    if (!selectedAccount) return [];
    const set = new Set<string>();
    const scopedAccounts = accounts.filter((account) => billAccountIdSet.has(account.id));
    for (const account of scopedAccounts.length > 0 ? scopedAccounts : [selectedAccount]) {
      set.add(account.name);
      const inst = (account.Institution?.name ?? "").trim();
      if (inst) set.add(`${inst}·${account.name}`);
    }
    return [...set].filter(Boolean);
  })();

  const hid = { householdId };
  const where = accountId
    ? {
        OR: [{ accountId }, { toAccountId: accountId }],
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
              account: { include: { Institution: { select: { name: true } } } },
              toAccount: { include: { Institution: { select: { name: true } } } },
            },
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: 5000,
          })
        : await loadEntriesForAccount(accountId, JSON.stringify(hidFilter))
      : await prisma.txRecord.findMany({
          where,
          include: {
            EntryTag: { include: { Tag: true } },
            account: { include: { Institution: { select: { name: true } } } },
            toAccount: { include: { Institution: { select: { name: true } } } },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 5000,
        })
    : [];
  const toDateValue = (value: unknown) => {
    return toValidDate(value) ?? new Date(0);
  };
  const entryDisplayDate = (e: (typeof rawEntries)[number]) => getDetailEntryDisplayDate(e, accountId);
  const entries = [...rawEntries].sort((a, b) => compareDetailEntriesDesc(a, b, accountId));
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
    if (column === "flow" && balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE) return "初始";
    if (column === "flow" && e.source === BALANCE_RECONCILE_SOURCE) return "校准";
    if (column === "flow") return effectiveAmount >= 0 ? "流入" : "流出";
    if (column === "type" && balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE) return "初始";
    if (column === "type" && e.source === BALANCE_RECONCILE_SOURCE) return "校准";
    if (column === "type") {
      if (isCreditCardRepaymentTransfer(e)) return "信用卡还款";
      if (e.type === "investment" && e.fundProductType === "deposit") return "存款";
      return e.type === "investment" && e.fundSubtype ? (fundSubtypeInfo(e.fundSubtype, e.source, amount, e.fundProductType)?.label ?? formatType(e.type)) : formatType(e.type);
    }
    if (column === "category") return (isCreditCardRepaymentTransfer(e) ? "还款" : getInsuranceDetailCategoryName(e)) || DETAIL_EMPTY_VALUE;
    if (column === "related") {
      const related = accountId && e.toAccountId === accountId ? (e.accountName ?? "") : (e.toAccountName ?? "");
      return related.trim() || DETAIL_EMPTY_VALUE;
    }
    return getEntryDisplayNote(e) || DETAIL_EMPTY_VALUE;
  };
  const detailFilterOptions: Record<DetailFilterColumn, string[]> = {
    date: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "date")))).sort(detailFilterSort),
    flow: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "flow")))).sort(detailFilterSort),
    type: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "type")))).sort(detailFilterSort),
    category: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "category")))).sort(detailFilterSort),
    related: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "related")))).sort(detailFilterSort),
    remark: Array.from(new Set(entries.map((e) => getDetailFilterColumnValue(e, "remark")))).sort(detailFilterSort),
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
  const safeDetailPage = detailAll ? 1 : Math.min(detailPage, detailTotalPages);
  const normalExportRows = (() => {
    const rows = [["日期", "类型", "流出", "流入", "账户", "对向账户", "备注"]];
    for (const e of filteredEntries2) {
      const effectiveAmount = effectiveAmountForAccount(e, accountId);
      const outflow = effectiveAmount < 0 ? String(-effectiveAmount) : "";
      const inflow = effectiveAmount > 0 ? String(effectiveAmount) : "";
      const accountLabel = accountId && e.toAccountId === accountId ? (e.toAccountName ?? "") : (e.accountName ?? "");
      const counterAccountLabel = e.type === TransactionType.transfer || e.type === TransactionType.investment
        ? (accountId && e.toAccountId === accountId ? (e.accountName ?? "") : (e.toAccountName ?? ""))
        : "";
      rows.push([
        entryDisplayDate(e).toISOString().slice(0, 10),
        formatType(e.type),
        outflow,
        inflow,
        accountLabel,
        counterAccountLabel,
        getEntryDisplayNote(e),
      ]);
    }
    return rows;
  })();
  const normalExportHref = buildCsvDataUri(normalExportRows);
  const normalExportFilename = `${selectedAccount?.name || accountName || "全部账户"}-资金明细.csv`;

  const categoryLabels = buildCategoryPathLabels(categories);
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
      expense: "支出分类",
      income: "收入分类",
      advance: "代付分类",
    };
    const typeOrder = ["expense", "income", "advance"];
    const options: Array<{
      value: string;
      label: string;
      subLabel?: string;
      parentId?: string;
      isHeader?: boolean;
      isGroup?: boolean;
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
      options.push({ value: headerId, label: typeLabels[type] ?? type, isHeader: true });

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
      .filter((account) => !isPureInvestmentAccount(account))
      .map((account) => ({
        id: account.id,
        kind: account.kind,
        investProductType: account.investProductType,
        billingDay: account.billingDay,
      })),
    hidFilter,
  );
  const investBalByAccountId = new Map(Object.entries(await loadInvestBalances(JSON.stringify(hidFilter))));

  const total = filteredEntries.reduce(
    (acc, e) => {
      // 确定对当前账户而言的资金方向
      // 规则：toAccountId = 资金收到方
      // 对于当前账户：资金流入当前账户 → 正数(in)，流出 → 负数(out)
      const effectiveAmount = effectiveAmountForAccount(e, accountId);
      if (effectiveAmount >= 0) acc.in += effectiveAmount;
      else acc.out += -effectiveAmount;
      acc.net += effectiveAmount;
      return acc;
    },
    { in: 0, out: 0, net: 0 },
  );

  const totalNetWorthValue = accounts.reduce((sum, account) => {
    if (isPureInvestmentAccount(account)) {
      return sum + (investBalByAccountId.get(account.id)?.marketValue ?? toNumber(account.balance));
    }
    return sum + (cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance));
  }, 0);
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
    if (view === "debt") return "借入/借出";
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
      if (isDepositAccount(selectedAccount)) return `存款 / ${accountLabel}`;
      if (selectedAccount.kind === AccountKind.insurance) return `保险 / ${accountLabel}`;
      const group = (selectedAccount.AccountGroup?.name ?? "").trim();
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
      label: display.selectorLabel,
      title: display.hoverTitle,
      hoverTitle: display.hoverTitle,
      groupId: a.groupId ?? "",
      groupName: a.AccountGroup?.name ?? "",
      institutionName: display.institutionName,
      institutionId: a.institutionId ?? "",
      institutionType: a.Institution?.type ?? "",
      investProductType: a.investProductType,
      debtDirection: a.debtDirection ?? null,
      subLabel: kindLabel(a.kind),
      currency: a.currency ?? "CNY",
    };
  });

  // Build hierarchical SmartSelect options: grouped by AccountGroup (isHeader),
  // ungrouped accounts shown flat with institution as subLabel
  type SSOpt = { id: string; label: string; subLabel?: string; title?: string; isHeader?: boolean; isGroup?: boolean; parentId?: string; kind?: string | null; investProductType?: string | null; debtDirection?: string | null; institutionId?: string | null; currency?: string | null };
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

    // Build group header entries — exclude "未指定" group
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
        subLabel: joinSSSubLabel([a.groupName, a.institutionName, a.subLabel]),
        title: a.hoverTitle,
        parentId: `group:${a.groupId}`,
        kind: a.kind,
        investProductType: a.investProductType ?? null,
        debtDirection: a.debtDirection ?? null,
        institutionId: a.institutionId || null,
        currency: a.currency ?? null,
      }));

    // Build ungrouped account entries (no parentId)
    const ungroupedItems: SSOpt[] = ungrouped.map(a => ({
      id: a.id,
      label: a.label,
      subLabel: joinSSSubLabel([a.institutionName, a.subLabel]),
      title: a.hoverTitle,
      kind: a.kind,
      investProductType: a.investProductType ?? null,
      debtDirection: a.debtDirection ?? null,
      institutionId: a.institutionId || null,
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
        groupId: a.groupId ?? "",
        groupName: a.AccountGroup?.name ?? "",
        institutionId: a.institutionId ?? "",
        institutionType: a.Institution?.type ?? "",
        investProductType: a.investProductType,
        debtDirection: a.debtDirection ?? null,
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
        groupId: a.groupId ?? "",
        groupName: a.AccountGroup?.name ?? "",
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
  const defaultInvestmentCreateAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount)
      ? selectedAccount.id
      : (defaultFundInvestmentAccountId || (investmentAccountOptions.find((account) => account.investProductType !== "deposit")?.id ?? ""));

  // Pre-computed hierarchical SS options for modal props
  const allAccountSSOptions = buildAccountSSOptions(); // all accounts for transfer dropdown
  const cashAccountSSOptions = buildAccountSSOptions(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet");
  const debtCounterpartyOptions = counterparties;
  const debtSourceInstitutions = institutions.filter((institution) => institution.type === "bank");
  const debtObjectOptions: SSOpt[] = [
    ...(debtCounterpartyOptions.length > 0
      ? [
          { id: "debt-counterparty-header", label: "往来对象", isHeader: true },
          ...debtCounterpartyOptions.map((counterparty) => ({
            id: `counterparty:${counterparty.id}`,
            label: counterparty.shortName?.trim() || counterparty.name,
            subLabel: counterparty.type === "person" ? "往来人员" : "往来组织",
          })),
        ]
      : []),
    ...(debtSourceInstitutions.length > 0
      ? [
          { id: "debt-institution-source-header", label: "从机构选择", isHeader: true },
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
      institutionId: a.institutionId || null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.institutionName, a.subLabel]),
      currency: a.currency,
    }));
  const investmentAccountList = accountOptions
    .filter(a => isPureInvestmentAccount(a) || isDepositAccount(a))
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      institutionId: a.institutionId || null,
      investProductType: a.investProductType ?? null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.institutionName, a.subLabel]),
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
            source: "debt_borrow_in",
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
  const debtRowMap = new Map<string, {
    key: string;
    name: string;
    accountId: string;
    institutionId: string;
    counterpartyId: string;
    itemType: string;
    repaymentMethod: string;
    repaymentCycle: string;
    annualRate: number | null;
    mortgageLprDiscount: number | null;
    remainingRuns: number | null;
    paidPrincipal: number;
    paidInterest: number;
    remainingPrincipal: number;
    remainingInterest: number;
    nextRepaymentDate: string;
    nextRepaymentPrincipal: number | null;
    nextRepaymentInterest: number | null;
    nextRepaymentCashAccountId: string;
    loanRateAdjustments: Array<{ effectiveDate: string; annualRate: number }>;
    payable: number;
    receivable: number;
    net: number;
    accountCount: number;
    accountIds: string[];
    accountLabels: string[];
  }>();

  for (const account of debtAccounts) {
    const institutionName = (account.Institution?.name ?? "").trim();
    const counterpartyName = (account.Counterparty?.name ?? "").trim();
    const objectName = counterpartyName || institutionName || account.name;
    const defaultItemName = objectName ? `${objectName}的往来款` : "";
    const itemName = objectName && (account.name === defaultItemName || account.name === objectName)
      ? "往来款"
      : account.name;
    const rowKey = `account:${account.id}`;
    const rowName = objectName && objectName !== itemName ? `${objectName} | ${itemName}` : account.name;
    const balance = cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    const loanPlan = loanRepaymentPlanByAccountId.get(account.id);
    const loanMemo = loanPlan ? decodeScheduledTaskMemo(loanPlan.memo) : null;
    const loanRateAdjustments = resolveLoanRateAdjustments({
      tableAdjustments: loanPlan ? loanRateAdjustmentsByAccountId.get(account.id) : [],
      memoAdjustments: loanMemo?.loanRateAdjustments,
    });
    const remainingRuns =
      loanPlan?.totalRuns == null
        ? null
        : Math.max(0, loanPlan.totalRuns - Math.max(0, loanPlan.executedRuns ?? 0));
    const nextRunDateKey = loanPlan?.nextRunDate ? formatDateUtc(loanPlan.nextRunDate) : "";
    const nextEffectiveAnnualRate = loanMemo
      ? getEffectiveLoanAnnualRate({
          baseAnnualRate: loanMemo.annualRate,
          adjustments: loanRateAdjustments,
          date: nextRunDateKey,
        })
      : null;
    const loanIntervalMonths = loanMemo?.repaymentIntervalMonths ?? (loanPlan?.intervalUnit === IntervalUnit.month ? loanPlan.intervalValue : null);
    const nextPreviousRunDateKey = loanPlan?.lastRunDate
      ? formatDateUtc(loanPlan.lastRunDate)
      : loanPlan?.startDate
        ? formatDateUtc(loanPlan.startDate)
        : null;
    const nextPeriodStartScheduledAmount = loanPlan && balance < 0
      ? calcLoanScheduledAmountForPeriodStart({
          repaymentMethod: loanMemo?.repaymentMethod,
          baseAnnualRate: loanMemo?.annualRate,
          adjustments: loanRateAdjustments,
          intervalMonths: loanIntervalMonths,
          scheduledAmount: toNumber(loanPlan.amount),
          remainingPrincipal: Math.abs(balance),
          remainingRuns: remainingRuns ?? 1,
          periodStartDate: nextPreviousRunDateKey,
        })
      : 0;
    const nextRepaymentParts = loanPlan && balance < 0
      ? calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: loanMemo?.repaymentMethod,
          baseAnnualRate: loanMemo?.annualRate,
          adjustments: loanRateAdjustments,
          intervalMonths: loanIntervalMonths,
          scheduledAmount: nextPeriodStartScheduledAmount,
          remainingPrincipal: Math.abs(balance),
          remainingRuns: remainingRuns ?? 1,
          previousRunDate: nextPreviousRunDateKey,
          runDate: nextRunDateKey,
        })
      : null;
    const repaymentCycle = loanPlan
      ? (() => {
          const intervalMonths = loanMemo?.repaymentIntervalMonths ?? (loanPlan.intervalUnit === IntervalUnit.month ? loanPlan.intervalValue : null);
          if (intervalMonths === 1) return "每月";
          if (intervalMonths === 3) return "每季度";
          if (intervalMonths === 6) return "每半年";
          if (intervalMonths === 12 || loanPlan.intervalUnit === IntervalUnit.year) return "每年";
          if (intervalMonths && intervalMonths > 0) return `每${intervalMonths}个月`;
          return loanPlan.intervalUnit === IntervalUnit.day ? `每${loanPlan.intervalValue}天` : "";
        })()
      : "";
    const current = debtRowMap.get(rowKey) ?? {
      key: rowKey,
      name: rowName,
      accountId: account.id,
      institutionId: account.institutionId ?? "",
      counterpartyId: account.counterpartyId ?? "",
      itemType: balance >= 0 ? "【债权】应收款" : "【债务】应付款",
      repaymentMethod: "",
      repaymentCycle: "",
      annualRate: null,
      mortgageLprDiscount: null,
      remainingRuns: null,
      paidPrincipal: 0,
      paidInterest: 0,
      remainingPrincipal: 0,
      remainingInterest: 0,
      nextRepaymentDate: "",
      nextRepaymentPrincipal: null,
      nextRepaymentInterest: null,
      nextRepaymentCashAccountId: "",
      loanRateAdjustments: [],
      payable: 0,
      receivable: 0,
      net: 0,
      accountCount: 0,
      accountIds: [],
      accountLabels: [],
    };
    current.accountCount += 1;
    current.accountIds.push(account.id);
    current.accountLabels.push(rowName);
    current.name = rowName;
    current.net += balance;
    if (balance >= 0) current.receivable += balance;
    else current.payable += Math.abs(balance);
    if (loanPlan) {
      current.repaymentMethod = loanMemo?.repaymentMethod || current.repaymentMethod;
      current.repaymentCycle = repaymentCycle || current.repaymentCycle;
      current.annualRate = nextEffectiveAnnualRate ?? current.annualRate;
      current.mortgageLprDiscount =
        loanMemo?.mortgageLprDiscount ??
        debtBorrowLprDiscountByAccountId.get(account.id) ??
        inferMortgageLprDiscountFromRateAdjustments(loanRateAdjustments) ??
        current.mortgageLprDiscount;
      current.remainingRuns = remainingRuns ?? current.remainingRuns;
      current.nextRepaymentDate = loanPlan.nextRunDate ? formatDateUtc(loanPlan.nextRunDate) : current.nextRepaymentDate;
      current.nextRepaymentPrincipal = nextRepaymentParts?.principal ?? current.nextRepaymentPrincipal;
      current.nextRepaymentInterest = nextRepaymentParts?.interest ?? current.nextRepaymentInterest;
      current.nextRepaymentCashAccountId = loanPlan.cashAccountId ?? current.nextRepaymentCashAccountId;
      current.loanRateAdjustments = loanRateAdjustments;
    }
    current.itemType = current.net >= 0 ? "【债权】应收款" : "【债务】应付款";
    current.remainingPrincipal = Math.abs(current.net);
    debtRowMap.set(rowKey, current);
  }

  const debtRows = Array.from(debtRowMap.values()).sort(
    (a, b) => (b.payable + b.receivable) - (a.payable + a.receivable),
  );
  const derivedDebtKey = selectedAccount?.kind === AccountKind.loan ? `account:${selectedAccount.id}` : "";
  const legacyInstitutionDebtRow = debtPersonParam.startsWith("institution:")
    ? debtRows.find((row) => row.institutionId === debtPersonParam.slice("institution:".length))
    : null;
  const legacyCounterpartyDebtRow = debtPersonParam.startsWith("counterparty:")
    ? debtRows.find((row) => row.counterpartyId === debtPersonParam.slice("counterparty:".length))
    : null;
  const selectedDebtKey = debtRows.some((row) => row.key === debtPersonParam)
    ? debtPersonParam
    : legacyInstitutionDebtRow
      ? legacyInstitutionDebtRow.key
    : legacyCounterpartyDebtRow
      ? legacyCounterpartyDebtRow.key
    : debtRows.some((row) => row.key === derivedDebtKey)
      ? derivedDebtKey
      : "";
  const selectedDebtRow = debtRows.find((row) => row.key === selectedDebtKey) ?? null;
  const selectedDebtInstitutionId = selectedDebtRow?.institutionId ?? "";
  const selectedDebtObjectValue = selectedDebtRow?.counterpartyId
    ? `counterparty:${selectedDebtRow.counterpartyId}`
    : selectedDebtRow?.institutionId
      ? `institution:${selectedDebtRow.institutionId}`
      : "";
  const totalDebtPayable = debtRows.reduce((sum, row) => sum + row.payable, 0);
  const totalDebtReceivable = debtRows.reduce((sum, row) => sum + row.receivable, 0);
  const selectedRepaymentPlan = selectedDebtRow ? loanRepaymentPlanByAccountId.get(selectedDebtRow.accountId) : null;
  const selectedRepaymentMemo = selectedRepaymentPlan ? decodeScheduledTaskMemo(selectedRepaymentPlan.memo) : null;
  const selectedRemainingRuns =
    selectedRepaymentPlan?.totalRuns == null
      ? null
      : Math.max(0, selectedRepaymentPlan.totalRuns - Math.max(0, selectedRepaymentPlan.executedRuns ?? 0));
  const repaymentScheduleRows: Array<{
    rowType: "payment" | "rate_adjustment";
    status?: "paid" | "planned";
    eventType?: "repayment" | "prepayment" | "rate_adjustment";
    period: number;
    date: string;
    payment: number;
    principal: number;
    interest: number;
    remainingPrincipal: number;
    annualRate: number | null;
  }> = [];
  if (selectedDebtRow && selectedRepaymentPlan && selectedDebtRow.net < -0.005) {
    let remainingPrincipal = Math.abs(selectedDebtRow.net);
    let runDate = selectedRepaymentPlan.nextRunDate;
    let lastScheduleDate = selectedRepaymentPlan.lastRunDate ?? selectedRepaymentPlan.startDate;
    const rateAdjustments = normalizeLoanRateAdjustments(selectedDebtRow.loanRateAdjustments);
    const emittedAdjustmentKeys = new Set<string>();
    const maxRuns = Math.min(selectedRemainingRuns ?? 24, 360);
    let scheduledAmountForRun = calcLoanScheduledAmountForPeriodStart({
      repaymentMethod: selectedRepaymentMemo?.repaymentMethod,
      baseAnnualRate: selectedRepaymentMemo?.annualRate,
      adjustments: rateAdjustments,
      intervalMonths: selectedRepaymentMemo?.repaymentIntervalMonths ?? (selectedRepaymentPlan.intervalUnit === IntervalUnit.month ? selectedRepaymentPlan.intervalValue : null),
      scheduledAmount: toNumber(selectedRepaymentPlan.amount),
      remainingPrincipal,
      remainingRuns: selectedRemainingRuns ?? maxRuns,
      periodStartDate: formatDateUtc(lastScheduleDate),
    });
    for (let index = 0; index < maxRuns && remainingPrincipal > 0.005; index++) {
      const runDateKey = formatDateUtc(runDate);
      const lastScheduleDateKey = formatDateUtc(lastScheduleDate);
      for (const adjustment of rateAdjustments) {
        if (
          adjustment.effectiveDate > lastScheduleDateKey &&
          adjustment.effectiveDate <= runDateKey &&
          !emittedAdjustmentKeys.has(adjustment.effectiveDate)
        ) {
          repaymentScheduleRows.push({
            rowType: "rate_adjustment",
            status: "planned",
            eventType: "rate_adjustment",
            period: 0,
            date: adjustment.effectiveDate,
            payment: 0,
            principal: 0,
            interest: 0,
            remainingPrincipal,
            annualRate: adjustment.annualRate,
          });
          emittedAdjustmentKeys.add(adjustment.effectiveDate);
        }
      }
      const remainingRunsForThisRun = selectedRemainingRuns == null ? Math.max(1, maxRuns - index) : Math.max(1, selectedRemainingRuns - index);
      const parts = calcLoanRunPartsWithRateAdjustments({
        repaymentMethod: selectedRepaymentMemo?.repaymentMethod,
        baseAnnualRate: selectedRepaymentMemo?.annualRate,
        adjustments: rateAdjustments,
        intervalMonths: selectedRepaymentMemo?.repaymentIntervalMonths ?? (selectedRepaymentPlan.intervalUnit === IntervalUnit.month ? selectedRepaymentPlan.intervalValue : null),
        scheduledAmount: scheduledAmountForRun,
        remainingPrincipal,
        remainingRuns: remainingRunsForThisRun,
        previousRunDate: lastScheduleDateKey,
        runDate: runDateKey,
      });
      scheduledAmountForRun = parts.scheduledAmount;
      const nextRemainingPrincipal = Math.max(0, Math.round((remainingPrincipal - parts.principal) * 100) / 100);
      repaymentScheduleRows.push({
        rowType: "payment",
        status: "planned",
        eventType: "repayment",
        period: Math.max(0, selectedRepaymentPlan.executedRuns ?? 0) + index + 1,
        date: runDateKey,
        payment: parts.payment,
        principal: parts.principal,
        interest: parts.interest,
        remainingPrincipal: nextRemainingPrincipal,
        annualRate: parts.annualRate,
      });
      remainingPrincipal = nextRemainingPrincipal;
      lastScheduleDate = runDate;
      runDate = calcNextScheduledRunDate(
        runDate,
        selectedRepaymentPlan.intervalUnit,
        selectedRepaymentPlan.intervalValue,
        selectedRepaymentPlan.executionDay,
        false,
      );
    }
  }

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
            account: { include: { Institution: { select: { name: true } } } },
            toAccount: { include: { Institution: { select: { name: true } } } },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 3000,
        })
      : [];
  for (const row of debtRows) {
    const rowAccountIds = new Set(row.accountIds);
    const rowPlanIds = new Set(
      loanRepaymentPlans
        .filter((plan) => rowAccountIds.has(plan.accountId))
        .map((plan) => plan.id),
    );
    const rowPrincipalEntries = debtEntriesRaw.filter(
      (entry) =>
        entry.type === TransactionType.transfer &&
        (rowAccountIds.has(entry.accountId ?? "") || rowAccountIds.has(entry.toAccountId ?? "")),
    );
    const rowPrincipalKey = (entry: (typeof debtEntriesRaw)[number]) => {
      const dateKey = entryDisplayDate(entry).toISOString().slice(0, 10);
      if (entry.regularInvestPlanId) return `plan:${entry.regularInvestPlanId}:${dateKey}`;
      const debtAccountId = rowAccountIds.has(entry.toAccountId ?? "")
        ? entry.toAccountId
        : rowAccountIds.has(entry.accountId ?? "")
          ? entry.accountId
          : "";
      const cashSideAccountId = rowAccountIds.has(entry.toAccountId ?? "")
        ? entry.accountId
        : entry.toAccountId;
      return `account:${debtAccountId ?? ""}:${dateKey}:${cashSideAccountId ?? ""}`;
    };
    const rowLockedInterestKeys = new Set<string>();
    for (const entry of debtEntriesRaw) {
      if (
        entry.type === TransactionType.transfer ||
        !(
          rowAccountIds.has(entry.toAccountId ?? "") ||
          (entry.regularInvestPlanId ? rowPlanIds.has(entry.regularInvestPlanId) : false)
        ) ||
        !(
          String(entry.source ?? "").includes("interest") ||
          String(entry.categoryName ?? "").includes("利息") ||
          String(entry.note ?? "").includes("利息")
        )
      ) {
        continue;
      }
      const source = String(entry.source ?? "");
      if (source.startsWith("debt_") && source.includes("interest")) {
        rowLockedInterestKeys.add(rowPrincipalKey(entry));
      }
    }
    const rowInterestByPrincipalKey = new Map<string, number>();
    for (const entry of debtEntriesRaw) {
      if (
        entry.type === TransactionType.transfer ||
        !(
          rowAccountIds.has(entry.toAccountId ?? "") ||
          (entry.regularInvestPlanId ? rowPlanIds.has(entry.regularInvestPlanId) : false)
        ) ||
        !(
          String(entry.source ?? "").includes("interest") ||
          String(entry.categoryName ?? "").includes("利息") ||
          String(entry.note ?? "").includes("利息")
        )
      ) {
        continue;
      }
      const key = rowPrincipalKey(entry);
      if (String(entry.source ?? "") === "scheduled_task" && rowLockedInterestKeys.has(key)) continue;
      rowInterestByPrincipalKey.set(key, (rowInterestByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
    }
    const paidEntries = rowPrincipalEntries.filter((entry) => {
      const displayAmount = debtPrincipalForAccountSide(entry, rowAccountIds);
      if (displayAmount <= 0) return false;
      const source = String(entry.source ?? "");
      return (
        source === "debt_repay_out" ||
        source === "debt_prepay_out" ||
        source === "scheduled_task" ||
        (entry.regularInvestPlanId ? rowPlanIds.has(entry.regularInvestPlanId) : false)
      );
    });
    row.paidPrincipal = paidEntries.reduce((sum, entry) => {
      return sum + Math.abs(debtPrincipalForAccountSide(entry, rowAccountIds));
    }, 0);
    row.paidInterest = paidEntries.reduce(
      (sum, entry) => sum + Math.abs(toNumber(entry.debtInterestAmount)) + (rowInterestByPrincipalKey.get(rowPrincipalKey(entry)) ?? 0),
      0,
    );
    row.remainingPrincipal = Math.abs(row.net);

    const plan = loanRepaymentPlanByAccountId.get(row.accountId);
    const memo = plan ? decodeScheduledTaskMemo(plan.memo) : null;
    row.remainingInterest = 0;
    if (plan && memo && row.net < -0.005 && plan.nextRunDate) {
      let remainingPrincipal = Math.abs(row.net);
      let runDate = plan.nextRunDate;
      let lastScheduleDate = plan.lastRunDate ?? plan.startDate;
      const remainingRuns =
        plan.totalRuns == null
          ? null
          : Math.max(0, plan.totalRuns - Math.max(0, plan.executedRuns ?? 0));
      const maxRuns = Math.min(remainingRuns ?? 24, 360);
      const intervalMonths = memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : null);
      const adjustments = resolveLoanRateAdjustments({
        tableAdjustments: loanRateAdjustmentsByAccountId.get(row.accountId),
        memoAdjustments: memo.loanRateAdjustments,
      });
      let scheduledAmountForRun = calcLoanScheduledAmountForPeriodStart({
        repaymentMethod: memo.repaymentMethod,
        baseAnnualRate: memo.annualRate,
        adjustments,
        intervalMonths,
        scheduledAmount: toNumber(plan.amount),
        remainingPrincipal,
        remainingRuns: remainingRuns ?? maxRuns,
        periodStartDate: formatDateUtc(lastScheduleDate),
      });
      for (let index = 0; index < maxRuns && remainingPrincipal > 0.005; index++) {
        const remainingRunsForThisRun = remainingRuns == null ? Math.max(1, maxRuns - index) : Math.max(1, remainingRuns - index);
        const parts = calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: memo.repaymentMethod,
          baseAnnualRate: memo.annualRate,
          adjustments,
          intervalMonths,
          scheduledAmount: scheduledAmountForRun,
          remainingPrincipal,
          remainingRuns: remainingRunsForThisRun,
          previousRunDate: formatDateUtc(lastScheduleDate),
          runDate: formatDateUtc(runDate),
        });
        row.remainingInterest += parts.interest;
        scheduledAmountForRun = parts.scheduledAmount;
        remainingPrincipal = Math.max(0, Math.round((remainingPrincipal - parts.principal) * 100) / 100);
        lastScheduleDate = runDate;
        runDate = calcNextScheduledRunDate(
          runDate,
          plan.intervalUnit,
          plan.intervalValue,
          plan.executionDay,
          false,
        );
      }
    }
  }
  const selectedDebtAccountIds = new Set(selectedDebtRow?.accountIds ?? []);
  const debtAccountLabelById = new Map(
    debtAccounts.map((account) => [
      account.id,
      (account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name),
    ]),
  );
  const debtDirectionByAccountId = new Map(
    debtAccounts.map((account) => [account.id, account.debtDirection ?? null]),
  );
  const filteredDebtEntries = debtEntriesRaw.filter(
    (entry) => selectedDebtAccountIds.has(entry.accountId ?? "") || selectedDebtAccountIds.has(entry.toAccountId ?? ""),
  );
  const selectedLoanRepaymentPlanIds = new Set(
    loanRepaymentPlans
      .filter((plan) => selectedDebtAccountIds.has(plan.accountId))
      .map((plan) => plan.id),
  );
  const filteredDebtInterestEntries = debtEntriesRaw.filter(
    (entry) =>
      entry.type !== TransactionType.transfer &&
      (
        selectedDebtAccountIds.has(entry.toAccountId ?? "") ||
        (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
      ) &&
      (
        String(entry.source ?? "").includes("interest") ||
        String(entry.categoryName ?? "").includes("利息") ||
        String(entry.note ?? "").includes("利息")
      ),
  );
  const filteredDebtFeeEntries = debtEntriesRaw.filter(
    (entry) =>
      entry.type !== TransactionType.transfer &&
      (
        selectedDebtAccountIds.has(entry.toAccountId ?? "") ||
        (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
      ) &&
      (
        String(entry.source ?? "").includes("fee") ||
        String(entry.categoryName ?? "").includes("手续费") ||
        String(entry.note ?? "").includes("违约金")
      ),
  );
  function debtPrincipalKey(entry: (typeof debtEntriesRaw)[number]) {
    const dateKey = entryDisplayDate(entry).toISOString().slice(0, 10);
    if (entry.regularInvestPlanId) return `plan:${entry.regularInvestPlanId}:${dateKey}`;
    const debtAccountId = selectedDebtAccountIds.has(entry.toAccountId ?? "")
      ? entry.toAccountId
      : selectedDebtAccountIds.has(entry.accountId ?? "")
        ? entry.accountId
        : "";
    const cashSideAccountId = selectedDebtAccountIds.has(entry.toAccountId ?? "")
      ? entry.accountId
      : entry.toAccountId;
    return `account:${debtAccountId ?? ""}:${dateKey}:${cashSideAccountId ?? ""}`;
  }
  const debtInterestByPrincipalKey = new Map<string, number>();
  const lockedDebtInterestKeys = new Set<string>();
  for (const entry of filteredDebtInterestEntries) {
    const source = String(entry.source ?? "");
    if (source.startsWith("debt_") && source.includes("interest")) {
      lockedDebtInterestKeys.add(debtPrincipalKey(entry));
    }
  }
  for (const entry of filteredDebtInterestEntries) {
    const key = debtPrincipalKey(entry);
    if (String(entry.source ?? "") === "scheduled_task" && lockedDebtInterestKeys.has(key)) continue;
    debtInterestByPrincipalKey.set(key, (debtInterestByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
  }
  const debtFeeByPrincipalKey = new Map<string, number>();
  for (const entry of filteredDebtFeeEntries) {
    const key = debtPrincipalKey(entry);
    debtFeeByPrincipalKey.set(key, (debtFeeByPrincipalKey.get(key) ?? 0) + Math.abs(toNumber(entry.amount)));
  }
  const filteredDebtPrincipalEntries = filteredDebtEntries.filter((entry) => entry.type === TransactionType.transfer);
  const debtBalanceByEntryId = new Map<string, number>();
  const debtBalanceTimeline: Array<{ date: string; balance: number }> = [];
  let runningDebtBalance = 0;
  for (const entry of [...filteredDebtPrincipalEntries].sort((a, b) => compareDetailEntriesAsc(a, b))) {
    const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
    runningDebtBalance += displayAmount;
    debtBalanceByEntryId.set(entry.id, runningDebtBalance);
    debtBalanceTimeline.push({
      date: entryDisplayDate(entry).toISOString().slice(0, 10),
      balance: runningDebtBalance,
    });
  }
  function getDebtRemainingPrincipalBeforeDate(dateKey: string) {
    let balanceBeforeDate: number | null = null;
    for (const item of debtBalanceTimeline) {
      if (item.date >= dateKey) break;
      balanceBeforeDate = item.balance;
    }
    return Math.abs(balanceBeforeDate ?? selectedDebtRow?.net ?? 0);
  }
  const debtDetailEntries = filteredDebtPrincipalEntries
    .map((entry) => {
      const amount = toNumber(entry.amount);
      const isToDebtAccount = selectedDebtAccountIds.has(entry.toAccountId ?? "");
      const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
      const interestAmount = Math.abs(toNumber(entry.debtInterestAmount)) + (debtInterestByPrincipalKey.get(debtPrincipalKey(entry)) ?? 0);
      const feeAmount = Math.abs(toNumber(entry.debtFeeAmount)) + (debtFeeByPrincipalKey.get(debtPrincipalKey(entry)) ?? 0);
      const paymentTotal =
        interestAmount > 0 || feeAmount > 0 || entry.source === "debt_repay_out" || entry.source === "debt_prepay_out" || entry.source === "debt_collect_in" || entry.source === "scheduled_task"
          ? debtPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount
          : null;
      const relatedAccountId = isToDebtAccount ? (entry.toAccountId ?? "") : (entry.accountId ?? "");
      const relatedDebtDirection =
        debtDirectionByAccountId.get(relatedAccountId) ??
        ((selectedDebtRow?.net ?? 0) >= 0 ? "receivable" : "payable");
      const inferredDirection = relatedDebtDirection ?? ((selectedDebtRow?.net ?? 0) >= 0 ? "receivable" : "payable");
      const debtEditMode =
        entry.source === "debt_borrow_in"
          ? ("borrow_in" as const)
          : entry.source === "debt_lend_out"
            ? ("lend_out" as const)
            : entry.source === "debt_collect_in"
              ? ("collect_in" as const)
              : entry.source === "debt_prepay_out"
                ? ("prepay_out" as const)
                : entry.source === "debt_repay_out" || entry.source === "scheduled_task"
                  ? ("repay_out" as const)
                  : isToDebtAccount
                    ? (inferredDirection === "receivable" ? ("lend_out" as const) : ("repay_out" as const))
                    : (inferredDirection === "receivable" ? ("collect_in" as const) : ("borrow_in" as const));
      const transferActionLabel =
        entry.source === "debt_borrow_in"
          ? "借入"
          : entry.source === "debt_repay_out"
            ? "还款"
            : entry.source === "debt_prepay_out"
              ? "提前还款"
            : entry.source === "debt_lend_out"
              ? "借出"
              : entry.source === "debt_collect_in"
                ? "收回"
                : debtActionLabel({
                    direction: inferredDirection,
                    isDebtAccountFromSide: !isToDebtAccount,
                  });
      const entryDate = entryDisplayDate(entry);
      const entryDateKey = entryDate.toISOString().slice(0, 10);
      const defaultRecalculateStartDate =
        selectedRepaymentPlan &&
        (entry.regularInvestPlanId
          ? entry.regularInvestPlanId === selectedRepaymentPlan.id
          : selectedDebtAccountIds.has(relatedAccountId))
          ? formatDateUtc(
              entry.regularInvestPlanId
                ? calcNextScheduledRunDate(
                    entryDate,
                    selectedRepaymentPlan.intervalUnit,
                    selectedRepaymentPlan.intervalValue,
                    selectedRepaymentPlan.executionDay,
                    false,
                  )
                : calcInitialScheduledRunDate(
                    entryDate,
                    selectedRepaymentPlan.intervalUnit,
                    selectedRepaymentPlan.intervalValue,
                    selectedRepaymentPlan.executionDay,
                    false,
                  ),
            )
          : null;
      return {
        id: entry.id,
        date: entryDateKey,
        typeLabel: entry.type === TransactionType.transfer ? transferActionLabel : (entry.categoryName || formatType(entry.type)),
        relatedAccountLabel: debtAccountLabelById.get(relatedAccountId) ?? "-",
        note: entry.note ?? "",
        amount: displayAmount,
        principal: displayAmount,
        interest: interestAmount,
        paymentTotal,
        balance: debtBalanceByEntryId.get(entry.id) ?? 0,
        debtEdit:
          entry.type === TransactionType.transfer
            ? {
                editEntryId: entry.id,
                mode: debtEditMode,
                defaultDebtAccountId: isToDebtAccount ? (entry.toAccountId ?? "") : (entry.accountId ?? ""),
                defaultCashAccountId: isToDebtAccount ? (entry.accountId ?? "") : (entry.toAccountId ?? ""),
                defaultDate: entryDateKey,
                defaultPrincipal: Math.abs(displayAmount),
                defaultInterest: interestAmount,
                defaultPenalty: Math.abs(toNumber(entry.debtFeeAmount)),
                defaultRecalculateStartDate,
                defaultPrepayStrategy: entry.source === "debt_prepay_out"
                  ? parseLoanPrepayStrategy(entry.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
                  : undefined,
              }
            : undefined,
        edit:
          entry.type === TransactionType.transfer
            ? {
                type: "transfer" as const,
                date: entryDisplayDate(entry).toISOString().slice(0, 10),
                amount: Math.abs(amount),
                note: entry.note ?? "",
                fromAccountId: entry.accountId ?? "",
                toAccountId: entry.toAccountId ?? "",
              }
            : {
                type: entry.type === TransactionType.income ? "income" as const : "expense" as const,
                date: entryDisplayDate(entry).toISOString().slice(0, 10),
                amount: Math.abs(amount),
                note: entry.note ?? "",
                accountId: entry.accountId ?? "",
                categoryId: entry.categoryId ?? "",
              },
      };
    });

  if (selectedDebtRow && selectedRepaymentPlan) {
    const paidPrincipalEntries = [...filteredDebtPrincipalEntries]
      .sort((a, b) => compareDetailEntriesAsc(a, b))
      .filter((entry) => {
      const amount = toNumber(entry.amount);
      const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
      if (displayAmount <= 0) return false;
        const source = String(entry.source ?? "");
        return (
          source === "debt_repay_out" ||
          source === "debt_prepay_out" ||
          source === "scheduled_task" ||
          (entry.regularInvestPlanId ? selectedLoanRepaymentPlanIds.has(entry.regularInvestPlanId) : false)
        );
      });
    let paidRepaymentPeriod = 0;
    for (const entry of paidPrincipalEntries) {
      const displayAmount = debtPrincipalForAccountSide(entry, selectedDebtAccountIds);
      const interestAmount = Math.abs(toNumber(entry.debtInterestAmount)) + (debtInterestByPrincipalKey.get(debtPrincipalKey(entry)) ?? 0);
      const feeAmount = Math.abs(toNumber(entry.debtFeeAmount)) + (debtFeeByPrincipalKey.get(debtPrincipalKey(entry)) ?? 0);
      const isPrepayment = entry.source === "debt_prepay_out";
      if (!isPrepayment) paidRepaymentPeriod += 1;
      repaymentScheduleRows.push({
        rowType: "payment",
        status: "paid",
        eventType: isPrepayment ? "prepayment" : "repayment",
        period: isPrepayment ? 0 : paidRepaymentPeriod,
        date: entryDisplayDate(entry).toISOString().slice(0, 10),
        payment: debtPaymentTotal(entry, interestAmount, feeAmount) || Math.abs(displayAmount) + interestAmount + feeAmount,
        principal: Math.abs(displayAmount),
        interest: interestAmount,
        remainingPrincipal: Math.abs(debtBalanceByEntryId.get(entry.id) ?? 0),
        annualRate: null,
      });
    }

    const existingRateRows = new Set(
      repaymentScheduleRows
        .filter((row) => row.rowType === "rate_adjustment")
        .map((row) => row.date),
    );
    const nextRunDateKey = selectedRepaymentPlan.nextRunDate ? formatDateUtc(selectedRepaymentPlan.nextRunDate) : "";
    for (const adjustment of normalizeLoanRateAdjustments(selectedDebtRow.loanRateAdjustments)) {
      if (existingRateRows.has(adjustment.effectiveDate)) continue;
      repaymentScheduleRows.push({
        rowType: "rate_adjustment",
        status: nextRunDateKey && adjustment.effectiveDate >= nextRunDateKey ? "planned" : "paid",
        eventType: "rate_adjustment",
        period: 0,
        date: adjustment.effectiveDate,
        payment: 0,
        principal: 0,
        interest: 0,
        remainingPrincipal: getDebtRemainingPrincipalBeforeDate(adjustment.effectiveDate),
        annualRate: adjustment.annualRate,
      });
    }
    repaymentScheduleRows.sort((a, b) => {
      const byDate = a.date.localeCompare(b.date);
      if (byDate !== 0) return byDate;
      const rank = (row: (typeof repaymentScheduleRows)[number]) =>
        row.rowType === "rate_adjustment" ? 0 : row.status === "paid" ? 1 : 2;
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return a.period - b.period;
    });
  }

  // 查询最近使用的资金账户
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

  const billScope = selectedAccount
    ? {
        OR: [
          { accountId: { in: billAccountIds } },
          { toAccountId: { in: billAccountIds } },
          ...legacyNames.map((n) => ({ accountName: n })),
        ],
      }
    : undefined;

  const creditBillNow = new Date();
  const todayUtcStart = new Date(Date.UTC(creditBillNow.getUTCFullYear(), creditBillNow.getUTCMonth(), creditBillNow.getUTCDate()));
  const creditBillSummaryLogicUpdatedAt = new Date(Date.UTC(2026, 6, 12, 13, 0, 0));
  const persistedCyclesInitial = isBillAccount && selectedAccount
    ? await prisma.creditCardCycle.findMany({
        where: { accountId: billStorageAccountId },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  const billOverrides = isBillAccount && selectedAccount
    ? await prisma.billOverride.findMany({
        where: { accountId: billStorageAccountId },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  const persistedCycleByMonth = new Map(persistedCyclesInitial.map((cycle) => [cycle.statementMonth, cycle]));
  const latestBillTxUpdatedAt = isBillAccount && selectedAccount && billScope
    ? await prisma.txRecord.findFirst({
        where: { AND: [billScope] },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      })
    : null;
  const activeBillTxCount = isBillAccount && selectedAccount && billScope
    ? await prisma.txRecord.count({
        where: { AND: [billScope, { deletedAt: null }] },
      })
    : 0;
  const latestCycleUpdatedAt = persistedCyclesInitial.reduce<Date | null>(
    (latest, cycle) => (!latest || cycle.updatedAt > latest ? cycle.updatedAt : latest),
    null,
  );
  const latestOverrideUpdatedAt = billOverrides.reduce<Date | null>(
    (latest, override) => (!latest || override.updatedAt > latest ? override.updatedAt : latest),
    null,
  );
  const creditCycleCacheStale = !!(
    isBillAccount &&
    selectedAccount &&
    (
      persistedCyclesInitial.length === 0 ||
      (
        activeBillTxCount === 0 &&
        persistedCyclesInitial.some((cycle) =>
          toNumber(cycle.expenseAbs) !== 0 ||
          toNumber(cycle.income) !== 0 ||
          toNumber(cycle.paid) !== 0 ||
          toNumber(cycle.rawBill) !== 0 ||
          toNumber(cycle.effectiveBill) !== 0 ||
          toNumber(cycle.cumulativeRemain) !== 0 ||
          toNumber(cycle.cumulativeOverpaid) !== 0
        )
      ) ||
      !latestCycleUpdatedAt ||
      latestCycleUpdatedAt < creditBillSummaryLogicUpdatedAt ||
      latestCycleUpdatedAt < todayUtcStart ||
      (!!latestBillTxUpdatedAt?.updatedAt && latestBillTxUpdatedAt.updatedAt > latestCycleUpdatedAt) ||
      (!!latestOverrideUpdatedAt && latestOverrideUpdatedAt > latestCycleUpdatedAt)
    )
  );

  const availableBillMonths =
    isBillAccount && selectedAccount
      ? (!creditCycleCacheStale && persistedCyclesInitial.length > 0
          ? persistedCyclesInitial.map((cycle) => cycle.statementMonth)
          : await prisma.txRecord
          .groupBy({
            by: ["statementMonth"],
            where: {
              statementMonth: { not: null },
              deletedAt: null,
              AND: [...(billScope ? [billScope] : [])],
            },
            _count: { _all: true },
            orderBy: { statementMonth: "desc" },
          })
          .then((rows) => rows.map((r) => r.statementMonth).filter((m): m is string => !!m)))
      : [];

  const showAllCreditBillDetails = billMonthParam === "all";
  const selectedBillMonth = !showAllCreditBillDetails && /^(\d{4})-(\d{2})$/.test(billMonthParam) ? billMonthParam : "";

  const creditCardBill =
    isBillAccount && selectedAccount?.billingDay
      ? await (async () => {
          const base = selectedBillMonth
            ? (() => {
                const persisted = persistedCycleByMonth.get(selectedBillMonth);
                if (persisted) {
                  const today = new Date(Date.UTC(creditBillNow.getUTCFullYear(), creditBillNow.getUTCMonth(), creditBillNow.getUTCDate()));
                  return {
                    start: persisted.periodStart,
                    end: persisted.periodEnd,
                    due: persisted.dueDate,
                    today,
                    isCurrentCycle: today >= persisted.periodStart && today < addDaysUtc(persisted.periodEnd, 1),
                  };
                }
                return cycleForStatementMonth(selectedBillMonth, selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null, creditBillNow);
              })()
            : creditCardCycle(creditBillNow, selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null);
          if (!base) return null;

          const { start, end, due, today, isCurrentCycle } = base;
          const repayEnd = due && due.getTime() < today.getTime() ? due : today;
          const statementMonth = selectedBillMonth || toStatementMonth(end, selectedAccount.billingDay ?? 1);
          const cachedCycle = !creditCycleCacheStale
            ? persistedCyclesInitial.find((cycle) => cycle.statementMonth === statementMonth)
            : null;
          if (cachedCycle) {
            return {
              start: cachedCycle.periodStart,
              end: cachedCycle.periodEnd,
              due: cachedCycle.dueDate,
              repayEnd,
              bill: Number(cachedCycle.rawBill),
              paid: Number(cachedCycle.paid),
              remain: Number(cachedCycle.cumulativeRemain),
              overpaid: Number(cachedCycle.cumulativeOverpaid),
              statementMonth,
              isCurrentCycle: cachedCycle.isCurrentCycle,
            };
          }

          const cycleMatch = {
            OR: statementMonth
              ? [
                  { statementMonth, deletedAt: null },
                  {
                    statementMonth: null,
                    date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null,
                  },
                ]
              : [{ date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null }],
          };
          const repaymentMatch = {
            amount: { lt: 0 },
            toAccountId: { in: billAccountIds },
            type: TransactionType.transfer,
            deletedAt: null,
            date: { gte: addDaysUtc(end, 1), lt: addDaysUtc(repayEnd, 1) },
          };
          const cycleTransferInMatch = {
            toAccountId: { in: billAccountIds },
            amount: { lt: 0 },
            type: TransactionType.transfer,
            deletedAt: null,
            date: { gte: start, lt: addDaysUtc(end, 1) },
          };
          const cycleTransferOutMatch = {
            accountId: { in: billAccountIds },
            amount: { lt: 0 },
            type: TransactionType.transfer,
            deletedAt: null,
          };
          const [expenseAgg, incomeAgg, cycleTransferInAgg, cycleTransferOutAgg, paidAgg] = await Promise.all([
            prisma.txRecord.aggregate({
              where: {
                AND: [cycleMatch, ...(billScope ? [billScope] : []), { type: TransactionType.expense }],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [cycleMatch, ...(billScope ? [billScope] : []), { type: TransactionType.income }],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [cycleTransferInMatch, ...(billScope ? [billScope] : [])],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [cycleMatch, ...(billScope ? [billScope] : []), cycleTransferOutMatch],
              },
              _sum: { amount: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [repaymentMatch, ...(billScope ? [billScope] : [])],
              },
              _sum: { amount: true },
            }),
          ]);

          const cycleOutflow = toNumber(expenseAgg._sum.amount ?? 0) + toNumber(cycleTransferOutAgg._sum.amount ?? 0);
          const netCycle = cycleOutflow + toNumber(incomeAgg._sum.amount ?? 0);
          const bill = Math.max(0, -netCycle);
          const income = Math.max(0, toNumber(incomeAgg._sum.amount ?? 0)) + Math.max(0, -toNumber(cycleTransferInAgg._sum.amount ?? 0));
          const paid = Math.max(0, -toNumber(paidAgg._sum.amount ?? 0));
          const remainRaw = bill - paid;
          const remain = Math.max(0, remainRaw);
          const overpaid = Math.max(0, -remainRaw);

          return { start, end, due, repayEnd, bill, paid, remain, overpaid, income, statementMonth, isCurrentCycle };
        })()
      : null;

  const currentStatementMonth = (() => {
    if (!isBillAccount || !selectedAccount?.billingDay) return "";
    const base = creditCardCycle(creditBillNow, selectedAccount.billingDay ?? 1, selectedAccount.repaymentDay ?? null);
    if (!base) return "";
    return toStatementMonth(base.end, selectedAccount.billingDay ?? 1);
  })();

  const settledBillMonth = (() => {
    if (!currentStatementMonth) return "";
    const m = currentStatementMonth.match(/^(\d{4})-(\d{2})$/);
    if (!m) return "";
    const y = Number(m[1]);
    const monthIndex = Number(m[2]) - 1;
    const d = new Date(Date.UTC(y, monthIndex - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

  const lastRepayToAccountId = await (async () => {
    if (!isBillAccount || !selectedAccount) return undefined;
    const lastEntry = await prisma.txRecord.findFirst({
      where: {
        accountId: selectedAccount.id,
        type: TransactionType.transfer,
        amount: { gt: 0 },
      },
      orderBy: { date: "desc" },
      take: 1,
    });
    if (!lastEntry) return undefined;
    return lastEntry.toAccountId ?? undefined;
  })();

  const lastRepayFromAccountId = await (async () => {
    if (!isBillAccount || !selectedAccount) return undefined;
    const lastEntry = await prisma.txRecord.findFirst({
      where: {
        accountId: selectedAccount.id,
        type: TransactionType.transfer,
        amount: { gt: 0 },
      },
      orderBy: { date: "desc" },
      take: 1,
    });
    if (!lastEntry) return undefined;
    return lastEntry.toAccountId ?? undefined;
  })();

  const billMonthsForList = (() => {
    const months = new Set<string>();
    for (const m of availableBillMonths) months.add(m);
    if (currentStatementMonth) months.add(currentStatementMonth);
    if (selectedBillMonth) months.add(selectedBillMonth);

    if (months.size > 0 && !hideZeroBills) {
      const sorted = Array.from(months).sort((a, b) => a.localeCompare(b));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const [ey, em] = earliest.split("-").map(Number);
      const [ly, lm] = latest.split("-").map(Number);
      for (let y = ey; y <= ly; y++) {
        const startM = y === ey ? em : 1;
        const endM = y === ly ? lm : 12;
        for (let m = startM; m <= endM; m++) {
          months.add(`${y}-${String(m).padStart(2, "0")}`);
        }
      }
    }

    const sortedMonths = Array.from(months).sort((a, b) => b.localeCompare(a));
    const limitedMonths = sortedMonths.slice(0, billMonthsLimit);
    if (showRecentBillCycles && selectedBillMonth && !limitedMonths.includes(selectedBillMonth)) {
      limitedMonths.push(selectedBillMonth);
    }
    return limitedMonths;
  })();

  const billMonthsForCumulative = (() => {
    const merged = new Set<string>();
    if (currentStatementMonth) merged.add(currentStatementMonth);
    if (selectedBillMonth) merged.add(selectedBillMonth);
    for (const m of availableBillMonths) merged.add(m);

    const arr = Array.from(merged).sort((a, b) => a.localeCompare(b));
    if (arr.length === 0) return arr;
    const [ey, em] = arr[0]!.split("-").map(Number);
    const [ly, lm] = arr[arr.length - 1]!.split("-").map(Number);
    const full: string[] = [];
    for (let y = ey; y <= ly; y++) {
      const startM = y === ey ? em : 1;
      const endM = y === ly ? lm : 12;
      for (let m = startM; m <= endM; m++) {
        full.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    }
    return full;
  })();

  const creditCycleDefinitions = (() => {
    const definitions: Array<{
      month: string;
      start: Date;
      end: Date;
      endExclusive: Date;
      due: Date | null;
      isCurrentCycle: boolean;
    }> = [];
    const account = selectedAccount;
    if (!isBillAccount || !account?.billingDay) return definitions;

    for (const month of billMonthsForCumulative) {
      const persisted = persistedCycleByMonth.get(month);
      const base = persisted
        ? (() => {
            const today = new Date(Date.UTC(
              creditBillNow.getUTCFullYear(),
              creditBillNow.getUTCMonth(),
              creditBillNow.getUTCDate(),
            ));
            return {
              start: persisted.periodStart,
              end: persisted.periodEnd,
              due: persisted.dueDate,
              isCurrentCycle: today >= persisted.periodStart && today < addDaysUtc(persisted.periodEnd, 1),
            };
          })()
        : cycleForStatementMonth(
            month,
            account.billingDay,
            account.repaymentDay ?? null,
            creditBillNow,
          );
      if (!base) continue;
      definitions.push({
        month,
        start: base.start,
        end: base.end,
        endExclusive: addDaysUtc(base.end, 1),
        due: base.due,
        isCurrentCycle: base.isCurrentCycle,
      });
    }
    return definitions;
  })();

  const creditCycleActivityRows =
    creditCycleCacheStale &&
    isBillAccount &&
    selectedAccount &&
    billScope &&
    creditCycleDefinitions.length > 0
      ? await (() => {
          const rangeStart = creditCycleDefinitions.reduce(
            (earliest, cycle) => cycle.start < earliest ? cycle.start : earliest,
            creditCycleDefinitions[0]!.start,
          );
          const rangeEndExclusive = creditCycleDefinitions.reduce(
            (latest, cycle) => cycle.endExclusive > latest ? cycle.endExclusive : latest,
            creditCycleDefinitions[0]!.endExclusive,
          );
          const statementMonths = creditCycleDefinitions.map((cycle) => cycle.month);
          return prisma.txRecord.findMany({
            where: {
              AND: [
                billScope,
                { deletedAt: null },
                {
                  OR: [
                    {
                      type: { in: [TransactionType.expense, TransactionType.income] },
                      statementMonth: { in: statementMonths },
                    },
                    {
                      type: { in: [TransactionType.expense, TransactionType.income] },
                      statementMonth: null,
                      date: { gte: rangeStart, lt: rangeEndExclusive },
                    },
                    {
                      type: TransactionType.transfer,
                      toAccountId: { in: billAccountIds },
                      amount: { lt: 0 },
                      date: { gte: rangeStart, lt: rangeEndExclusive },
                    },
                    {
                      type: TransactionType.transfer,
                      accountId: { in: billAccountIds },
                      amount: { lt: 0 },
                      OR: [
                        { statementMonth: { in: statementMonths } },
                        {
                          statementMonth: null,
                          date: { gte: rangeStart, lt: rangeEndExclusive },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            select: {
              statementMonth: true,
              date: true,
              type: true,
              amount: true,
              accountId: true,
              toAccountId: true,
            },
          });
        })()
      : [];

  const creditCycleActivityByMonth = (() => {
    const totals = new Map(
      creditCycleDefinitions.map((cycle) => [
        cycle.month,
        { expense: 0, income: 0, transferIn: 0, transferOut: 0 },
      ]),
    );
    const cycleByMonth = new Map(creditCycleDefinitions.map((cycle) => [cycle.month, cycle]));
    const findMonthByDate = (date: Date) => {
      const timestamp = date.getTime();
      return creditCycleDefinitions.find(
        (cycle) => timestamp >= cycle.start.getTime() && timestamp < cycle.endExclusive.getTime(),
      )?.month;
    };

    for (const row of creditCycleActivityRows) {
      const amount = toNumber(row.amount);
      if (row.type === TransactionType.expense || row.type === TransactionType.income) {
        const explicitMonth = row.statementMonth && cycleByMonth.has(row.statementMonth)
          ? row.statementMonth
          : null;
        const month = explicitMonth ?? findMonthByDate(row.date);
        if (!month) continue;
        const monthTotals = totals.get(month);
        if (!monthTotals) continue;
        if (row.type === TransactionType.expense) monthTotals.expense += amount;
        else monthTotals.income += amount;
        continue;
      }

      if (
        row.type === TransactionType.transfer &&
        billAccountIdSet.has(row.toAccountId ?? "") &&
        amount < 0
      ) {
        const month = findMonthByDate(row.date);
        if (!month) continue;
        const monthTotals = totals.get(month);
        if (monthTotals) monthTotals.transferIn += amount;
      }

      if (
        row.type === TransactionType.transfer &&
        billAccountIdSet.has(row.accountId) &&
        amount < 0
      ) {
        const explicitMonth = row.statementMonth && cycleByMonth.has(row.statementMonth)
          ? row.statementMonth
          : null;
        const month = explicitMonth ?? findMonthByDate(row.date);
        if (!month) continue;
        const monthTotals = totals.get(month);
        if (monthTotals) monthTotals.transferOut += amount;
      }
    }
    return totals;
  })();

  const persistedBillSummariesAll = persistedCyclesInitial.map((cycle) => ({
    month: cycle.statementMonth,
    start: cycle.periodStart,
    end: cycle.periodEnd,
    due: cycle.dueDate,
    bill: Number(cycle.rawBill),
    paid: Number(cycle.paid),
    remain: Number(cycle.cumulativeRemain),
    overpaid: Number(cycle.cumulativeOverpaid),
    expenseAbs: Number(cycle.expenseAbs),
    income: Number(cycle.income),
    isCurrentCycle: cycle.isCurrentCycle,
  }));

  const billSummariesAll =
    !creditCycleCacheStale
      ? persistedBillSummariesAll.filter((summary) => billMonthsForCumulative.includes(summary.month))
      : isBillAccount && selectedAccount?.billingDay && creditCycleDefinitions.length
      ? creditCycleDefinitions.map(({ month, start, end, due, isCurrentCycle }) => {
          const activity = creditCycleActivityByMonth.get(month) ?? {
            expense: 0,
            income: 0,
            transferIn: 0,
            transferOut: 0,
          };
          const outflow = activity.expense + activity.transferOut;
          const expenseAbs = Math.max(0, -outflow);
          const income = Math.max(0, activity.income) + Math.max(0, -activity.transferIn);
          const bill = Math.max(0, -(outflow + activity.income));
          return {
            month,
            start,
            end,
            due,
            bill,
            paid: 0,
            remain: bill,
            overpaid: 0,
            expenseAbs,
            income,
            isCurrentCycle,
          };
        })
      : [];

  const billSummariesAllWithNextCyclePaid = (() => {
    const incomeByMonth = new Map(billSummariesAll.map((summary) => [summary.month, summary.income]));
    return billSummariesAll.map((summary) => {
      const [yearText, monthText] = summary.month.split("-");
      const year = Number(yearText);
      const month = Number(monthText);
      if (!Number.isFinite(year) || !Number.isFinite(month)) return summary;
      const nextDate = new Date(Date.UTC(year, month, 1));
      const nextMonth = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}`;
      return {
        ...summary,
        paid: incomeByMonth.get(nextMonth) ?? 0,
      };
    });
  })();

  const billSummaryByMonth = new Map(billSummariesAllWithNextCyclePaid.map((s) => [s.month, s]));

  const billSummaries = fillMissingCreditBillSummaries({
    months: billMonthsForList,
    summaryByMonth: billSummaryByMonth,
    billingDay: selectedAccount?.billingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    now: creditBillNow,
  });

  const cachedOverrideByMonth = new Map<string, number>(
    billOverrides
      .filter((override) => !!override.statementMonth)
      .map((override) => [override.statementMonth, Number(override.amount)]),
  );
  const cachedEffectiveBillByMonth = new Map<string, number>(
    persistedCyclesInitial.map((cycle) => [cycle.statementMonth, Number(cycle.effectiveBill)]),
  );
  const cachedCumulativeByMonth = new Map<string, { cumulativeRemain: number; cumulativeOverpaid: number }>(
    persistedCyclesInitial.map((cycle) => [
      cycle.statementMonth,
      {
        cumulativeRemain: Number(cycle.cumulativeRemain),
        cumulativeOverpaid: Number(cycle.cumulativeOverpaid),
      },
    ]),
  );
  const creditCascade = !creditCycleCacheStale
    ? {
        overrideByMonth: cachedOverrideByMonth,
        allMonthsForCascade: persistedCyclesInitial
          .filter((cycle) => billMonthsForCumulative.includes(cycle.statementMonth))
          .sort((a, b) => a.statementMonth.localeCompare(b.statementMonth))
          .map((cycle) => ({
            month: cycle.statementMonth,
            bill: Number(cycle.rawBill),
            billDelta: Number(cycle.expenseAbs) - Number(cycle.income),
            paid: Number(cycle.paid),
          })),
        effectiveBillByMonth: cachedEffectiveBillByMonth,
        cumulativeByMonth: cachedCumulativeByMonth,
      }
    : computeCreditBillCascade({
        monthsForCascade: billMonthsForCumulative,
        summaryByMonth: billSummaryByMonth,
        overrides: billOverrides.map((override) => ({
          statementMonth: override.statementMonth,
          amount: Number(override.amount),
        })),
      });
  const {
    overrideByMonth,
    allMonthsForCascade,
    effectiveBillByMonth,
    cumulativeByMonth,
  } = creditCascade;
  const creditCardCyclePersistRows = buildCreditCardCyclePersistRows({
    billingDay: selectedAccount?.billingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    months: allMonthsForCascade,
    summaryByMonth: billSummaryByMonth,
    effectiveBillByMonth,
    cumulativeByMonth,
    overrideByMonth,
    now: creditBillNow,
  });

  if (creditCycleCacheStale && isBillAccount && selectedAccount) {
    await prisma.$transaction(async (tx) => {
      await tx.creditCardCycle.deleteMany({
        where: { accountId: billStorageAccountId },
      });
      if (creditCardCyclePersistRows.length === 0) return;
      await tx.creditCardCycle.createMany({
        data: creditCardCyclePersistRows.map((row) => ({
          accountId: billStorageAccountId,
          statementMonth: row.statementMonth,
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
          dueDate: row.dueDate,
          expenseAbs: String(row.expenseAbs),
          income: String(row.income),
          paid: String(row.paid),
          rawBill: String(row.rawBill),
          effectiveBill: String(row.effectiveBill),
          cumulativeRemain: String(row.cumulativeRemain),
          cumulativeOverpaid: String(row.cumulativeOverpaid),
          isCurrentCycle: row.isCurrentCycle,
          isLocked: row.isLocked,
          lockSource: row.lockSource,
        })),
      });
    });
  }

  const billSummariesWithCumulative = mergeCreditBillSummariesWithCascade(
    billSummaries,
    effectiveBillByMonth,
    cumulativeByMonth,
  );

  const displayBillRows = (() => {
    return billSummariesWithCumulative
      .filter((s) => hideZeroBills ? !(s.expenseAbs === 0 && s.income === 0 && s.bill === 0 && s.paid === 0 && !s.isCurrentCycle) : true)
      .filter((s) => hideSettledBills ? !(s.paid >= s.effectiveBill && s.effectiveBill > 0 && !s.isCurrentCycle) : true);
  })();

  const billListPageSize = 12;
  const totalPages = Math.ceil(displayBillRows.length / billListPageSize);
  const currentPage = Math.min(billPage, totalPages || 1);
  const creditBillSummaryRows: CreditBillSummaryRow[] = displayBillRows.map((s) => ({
    month: s.month,
    periodStart: ymdUtc(s.start),
    periodEnd: ymdUtc(s.end),
    dueDate: s.due ? ymdUtc(s.due) : "",
    periodLabel: `${mdUtcDots(s.start)} ~ ${mdUtcDots(s.end)}`,
    dueLabel: s.due ? ymdUtc(s.due) : "-",
    expenseAbs: s.expenseAbs,
    income: s.income,
    paid: s.paid,
    effectiveBill: s.effectiveBill,
    isCurrentCycle: s.isCurrentCycle,
    hasOverride: billOverrides.some((o) => o.statementMonth === s.month),
  }));

  const creditBillMonth = creditCardBill?.statementMonth ?? "";
  const selectedCreditBillMonth = showAllCreditBillDetails ? "" : (selectedBillMonth || creditBillMonth);

  const creditBillBalanceValue = (() => {
    if (!currentStatementMonth) return (creditCardBill?.remain ?? 0) - (creditCardBill?.overpaid ?? 0);
    const cum = cumulativeByMonth.get(currentStatementMonth);
    if (cum) return cum.cumulativeRemain - cum.cumulativeOverpaid;
    const effective = effectiveBillByMonth.get(currentStatementMonth);
    if (effective !== undefined) return effective;
    return (creditCardBill?.remain ?? 0) - (creditCardBill?.overpaid ?? 0);
  })();

  const selectedAccountBalanceValue = selectedAccount
    ? isPureInvestmentAccount(selectedAccount)
      ? investBalByAccountId.get(selectedAccount.id)?.marketValue ?? toNumber(selectedAccount.balance)
      : selectedAccount.kind === AccountKind.bank_credit
        ? creditBillBalanceValue
        : cashDisplayBalanceByAccountId.get(selectedAccount.id) ?? toNumber(selectedAccount.balance)
    : 0;

  const creditCardBillDetails =
    view === "bill" && !showAllCreditBillDetails && creditCardBill && isBillAccount
      ? await (async () => {
          const { start, end } = creditCardBill;
          const statementMonth = creditCardBill.statementMonth ?? null;
          const cycleMatch = {
            type: { in: [TransactionType.expense, TransactionType.income, TransactionType.transfer, TransactionType.investment] },
            deletedAt: null,
            OR: statementMonth
              ? [
                  { statementMonth, deletedAt: null },
                  {
                    statementMonth: null,
                    date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null,
                  },
                ]
              : [{ date: { gte: start, lt: addDaysUtc(end, 1) }, deletedAt: null }],
          };
          const cycleEntries = await prisma.txRecord.findMany({
            where: {
              AND: [cycleMatch, ...(billScope ? [billScope] : [])],
            },
            include: {
              EntryTag: { include: { Tag: true } },
              account: { include: { Institution: { select: { name: true } } } },
              toAccount: { include: { Institution: { select: { name: true } } } },
            },
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: 500,
          });
          const details: DetailEntry[] = cycleEntries.map((e) => ({
            id: e.id,
            date: toYmdOrNull(e.date) ?? "",
            postedAt: toDateOnlyLocalOrNull(e.postedAt),
            createdAt: toIsoOrNull(e.createdAt),
            dayOrder: e.dayOrder ?? 0,
            amount: toNumber(e.type === TransactionType.transfer && billAccountIdSet.has(e.toAccountId ?? "") ? Math.abs(toNumber(e.amount)) : e.amount),
            runningBalance: null,
            type: e.type,
            categoryId: e.categoryId,
            categoryName:
              e.type === TransactionType.expense || e.type === TransactionType.income
                ? e.categoryId
                  ? categoryLabels.get(e.categoryId) ?? e.categoryName ?? "未分类"
                  : e.categoryName ?? "未分类"
                : isCreditCardRepaymentTransfer(e)
                  ? "还款"
                  : e.categoryName,
            accountId: e.accountId,
            accountName: e.accountName,
            accountKind: e.account?.kind ?? null,
            accountDebtDirection: e.account?.debtDirection ?? null,
            counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
            counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
            toAccountId: e.toAccountId,
            toAccountName: e.toAccountName,
            toAccountKind: e.toAccount?.kind ?? null,
            toAccountDebtDirection: e.toAccount?.debtDirection ?? null,
            note: e.note,
            toNote: e.toNote,
            fundSubtype: e.fundSubtype,
            fundCode: e.fundCode,
            fundName: e.fundName,
            wealthProductId: e.wealthProductId ?? null,
            source: e.source,
            insuranceProductId: e.insuranceProductId ?? null,
            debtPrincipalAmount: e.debtPrincipalAmount != null ? toNumber(e.debtPrincipalAmount) : null,
            debtInterestAmount: e.debtInterestAmount != null ? toNumber(e.debtInterestAmount) : null,
            debtFeeAmount: e.debtFeeAmount != null ? toNumber(e.debtFeeAmount) : null,
            depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
            depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,
            fundProductType: e.fundProductType,
            metalTypeId: e.metalTypeId ?? null,
            metalTypeName: e.metalTypeName ?? null,
            metalUnitId: e.metalUnitId ?? null,
            metalUnitName: e.metalUnitName ?? null,
            metalQuantity: e.metalQuantity != null ? toNumber(e.metalQuantity) : null,
            metalUnitPrice: e.metalUnitPrice != null ? toNumber(e.metalUnitPrice) : null,
            metalFee: e.metalFee != null ? toNumber(e.metalFee) : null,
            fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
            fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
            fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
            fundConfirmDate: toIsoOrNull(e.fundConfirmDate),
            fundArrivalDate: toIsoOrNull(e.fundArrivalDate),
            fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
            entryTags: (e.EntryTag || []).map((et: any) => ({
              tagId: et.tagId,
              Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
            })),
          }));
          return { cycleEntries, details };
        })()
      : null;

  const investDataParams = JSON.stringify({
    fundSortParam,
    fundSortDirParam,
    fundPageSize,
    fundPage,
    fundCodeParam,
  });
  const investDataHidFilter = JSON.stringify(hidFilter);
  const investmoneyData = view === "investmoney" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const investwealthData = view === "investwealth" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
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

  // 定投计划数据加载
  const regularInvestData = viewParam === "regularinvest" && accountId && selectedAccount
    ? await (async () => {
        const plans = await prisma.regularInvestPlan.findMany({
          where: { accountId, ...hidFilter },
          orderBy: { nextRunDate: "asc" },
        });
        return { plans };
      })()
    : null;

  const baseQuery = new URLSearchParams();
  if (accountId) baseQuery.set("accountId", accountId);
  else if (accountName) baseQuery.set("account", accountName);
  const withDetailParams = (mutate?: (q: URLSearchParams) => void) => {
    const q = new URLSearchParams(baseQuery);
    q.set("view", "detail");
    q.set("pageSize", String(pageSize));
    if (!detailAll) q.set("detailPage", String(safeDetailPage));
    else q.set("detailAll", "1");
    (Object.keys(detailColumnFilters) as DetailFilterColumn[]).forEach((column) => {
      const value = serializeDetailFilterValues(detailColumnFilters[column]);
      if (value) q.set(DETAIL_FILTER_PARAM_BY_COLUMN[column], value);
    });
    if (detailDateFrom) q.set("detailDateFrom", detailDateFrom);
    if (detailDateTo) q.set("detailDateTo", detailDateTo);
    if (detailInFrom) q.set("detailInFrom", detailInFrom);
    if (detailInTo) q.set("detailInTo", detailInTo);
    if (detailOutFrom) q.set("detailOutFrom", detailOutFrom);
    if (detailOutTo) q.set("detailOutTo", detailOutTo);
    mutate?.(q);
    return `/?${q.toString()}`;
  };
  const renderDetailFilterHeader = (column: DetailFilterColumn, label: string, className: string) => {
    const activeValues = detailColumnFilters[column];
    const options = detailFilterOptions[column];
    const hasDateRange = column === "date" && !!(detailDateFrom || detailDateTo);
    const active = activeValues.length > 0 || hasDateRange;
    return (
      <th className={className}>
        {column === "date" ? (() => {
          const clearHref = active ? withDetailParams((q) => {
            q.delete(DETAIL_FILTER_PARAM_BY_COLUMN.date);
            q.delete("detailDateFrom");
            q.delete("detailDateTo");
            q.set("detailPage", "1");
          }) : null;
          const current = new URLSearchParams(withDetailParams().slice(2));
          current.delete(DETAIL_FILTER_PARAM_BY_COLUMN.date);
          current.delete("detailDateFrom");
          current.delete("detailDateTo");
          current.set("detailPage", "1");
          const hiddenInputs = Array.from(current.entries()).map(([k, v]) => ({ name: k, value: v }));
          const badgeText = hasDateRange ? "范围" : (activeValues.length > 0 ? String(activeValues.length) : null);
          return (
            <LinkDateRangeFilter
              label={label}
              from={detailDateFrom}
              to={detailDateTo}
              badgeText={badgeText}
              clearHref={clearHref}
              hiddenInputs={hiddenInputs}
            />
          );
        })() : (() => {
          const clearHref = active ? withDetailParams((q) => { q.delete(DETAIL_FILTER_PARAM_BY_COLUMN[column]); q.set("detailPage", "1"); }) : null;
          const items = options.map((value) => {
            const nextValues = activeValues.includes(value) ? activeValues.filter((v) => v !== value) : [...activeValues, value];
            const href = withDetailParams((q) => {
              const serialized = serializeDetailFilterValues(nextValues);
              if (serialized) q.set(DETAIL_FILTER_PARAM_BY_COLUMN[column], serialized);
              else q.delete(DETAIL_FILTER_PARAM_BY_COLUMN[column]);
              q.set("detailPage", "1");
            });
            return { value, href, checked: activeValues.includes(value) };
          });
          const badgeText = activeValues.length > 0 ? String(activeValues.length) : null;
          return (
            <LinkTableColumnFilter
              label={label}
              badgeText={badgeText}
              items={items}
              clearHref={clearHref}
            />
          );
        })()}
      </th>
    );
  };

  const renderFundSortHeader = (
    viewName: "investmoney" | "investfund",
    sortKey: string,
    label: string,
    className: string,
    selectedFundCode?: string,
  ) => {
    const defaultSortKey = showCleared ? "clearedDate" : "marketValue";
    const active = fundSortParam === sortKey || (!fundSortParam && sortKey === defaultSortKey);
    const nextDir = active && fundSortDirParam === "desc" ? "asc" : "desc";
    const q = new URLSearchParams(baseQuery);
    q.set("view", viewName);
    q.set("fundSort", sortKey);
    q.set("fundSortDir", nextDir);
    q.set("fundPageSize", String(fundPageSize));
    if (selectedFundCode) q.set("fundCode", selectedFundCode);
    if (showCleared) q.set("showCleared", "1");
    const justify = className.includes("text-left") ? "justify-start" : "justify-end";
    return (
      <th className={className}>
        <Link href={`/?${q.toString()}`} className={`inline-flex items-center gap-1 hover:text-blue-700 ${justify} ${active ? "text-blue-700" : ""}`} title={`按${label}${nextDir === "asc" ? "正序" : "倒序"}排列`}>
          <span>{label}</span>
          {active ? <span className="text-[10px]">{fundSortDirParam === "asc" ? "↑" : "↓"}</span> : <span className="text-[10px] text-slate-300">↕</span>}
        </Link>
      </th>
    );
  };

  // Convert filtered entries to serializable format for client-side detail paging.
  const allDetailEntries: DetailEntry[] = (filteredEntries2 || []).map((e) => ({
    id: e.id,
    date: entryDisplayDate(e).toISOString().slice(0, 10),
    postedAt: toDateOnlyLocalOrNull(e.postedAt),
    createdAt: toIsoOrNull(e.createdAt),
    dayOrder: e.dayOrder ?? 0,
    amount: toNumber(e.amount),
    runningBalance: balanceByEntryId.get(e.id) ?? null,
    type: e.type,
    categoryId: e.categoryId,
    categoryName: e.categoryName,
    accountId: e.accountId,
    accountName: e.accountName,
    accountKind: e.account?.kind ?? null,
    accountDebtDirection: e.account?.debtDirection ?? null,
    counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
    counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
    toAccountId: e.toAccountId,
    toAccountName: e.toAccountName,
    toAccountKind: e.toAccount?.kind ?? null,
    toAccountDebtDirection: e.toAccount?.debtDirection ?? null,
    note: e.note,
    toNote: e.toNote,
    fundSubtype: e.fundSubtype,
    fundCode: e.fundCode,
    fundName: e.fundName,
    wealthProductId: e.wealthProductId ?? null,
    source: e.source,
    insuranceProductId: e.insuranceProductId ?? null,
    debtPrincipalAmount: e.debtPrincipalAmount != null ? toNumber(e.debtPrincipalAmount) : null,
    debtInterestAmount: e.debtInterestAmount != null ? toNumber(e.debtInterestAmount) : null,
    debtFeeAmount: e.debtFeeAmount != null ? toNumber(e.debtFeeAmount) : null,
    depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
    depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,
    fundProductType: e.fundProductType,
    metalTypeId: e.metalTypeId ?? null,
    metalTypeName: e.metalTypeName ?? null,
    metalUnitId: e.metalUnitId ?? null,
    metalUnitName: e.metalUnitName ?? null,
    metalQuantity: e.metalQuantity != null ? toNumber(e.metalQuantity) : null,
    metalUnitPrice: e.metalUnitPrice != null ? toNumber(e.metalUnitPrice) : null,
    metalFee: e.metalFee != null ? toNumber(e.metalFee) : null,
    fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
    fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
    fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
    fundConfirmDate: toIsoOrNull(e.fundConfirmDate),
    fundArrivalDate: toIsoOrNull(e.fundArrivalDate),
    fundSourceEntryId: e.fundSourceEntryId ?? null,
    fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
    entryTags: (e.EntryTag || []).map((et: any) => ({
      tagId: et.tagId,
      Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
    })),
  }));
  const pagedDetailEntries: DetailEntry[] = detailAll
    ? allDetailEntries
    : allDetailEntries.slice((safeDetailPage - 1) * pageSize, safeDetailPage * pageSize);
  const creditBillDetailEntries = showAllCreditBillDetails
    ? allDetailEntries
    : (creditCardBillDetails?.details ?? []);
  const creditBillDetailTitle = showAllCreditBillDetails
    ? "信用卡全部明细"
    : creditCardBill?.statementMonth
      ? `账单明细 (${creditCardBill.statementMonth})`
      : "账单明细";

  const depositEntries =
    view === "deposit"
      ? (pagedDetailEntries || []).map((entry) => {
          const isRedeemEntry = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
          const cashAccountLabel = isRedeemEntry ? (entry.toAccountName ?? "") : (entry.accountName ?? "");
          return {
            id: entry.id,
            date: entry.date,
            typeLabel: entry.fundSubtype === "redeem" ? "取出" : "存入",
            fundName: entry.fundName ?? entry.fundCode ?? "",
            maturityDate: entry.fundArrivalDate ? entry.fundArrivalDate.slice(0, 10) : null,
            cashAccountLabel,
            note: entry.note ?? "",
            amount: entry.toAccountId === accountId ? Math.abs(entry.fundArrivalAmount ?? entry.amount) : entry.amount,
            edit: {
              type: "investment" as const,
              date: entry.date,
              amount: Math.abs(entry.amount),
              note: entry.note ?? "",
              accountId: isRedeemEntry ? (entry.accountId ?? "") : (entry.toAccountId ?? ""),
              cashAccountId: isRedeemEntry ? (entry.toAccountId ?? "") : (entry.accountId ?? ""),
              fundName: entry.fundName ?? undefined,
              fundNav: entry.fundNav ?? undefined,
              depositAnnualRate:
                entry.depositAnnualRate != null
                  ? toNumber(entry.depositAnnualRate)
                  : entry.fundNav ?? undefined,
              depositInterest:
                entry.depositInterest != null
                  ? toNumber(entry.depositInterest)
                  : undefined,
              depositSourceEntryId: entry.depositSourceEntryId ?? undefined,
              fundArrivalDate: entry.fundArrivalDate ?? undefined,
              fundProductType: "deposit",
              fundSubtype: entry.fundSubtype ?? "buy",
            },
          };
        })
      : [];

  const insuranceEntries =
    view === "insurance"
      ? (allDetailEntries || [])
          .filter((entry) => entry.source === "insurance")
          .map((entry) => {
            const isRedeemEntry = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
            const cashAccountLabel = isRedeemEntry ? (entry.toAccountName ?? "") : (entry.accountName ?? "");
            const amount = isRedeemEntry ? Math.abs(toNumber(entry.amount)) : -Math.abs(toNumber(entry.amount));
            return {
              id: entry.id,
              date: entry.date,
              typeLabel: isRedeemEntry ? "赎回" : "投保",
              productName: entry.fundName ?? "",
              cashAccountLabel,
              cashAccountId: isRedeemEntry ? (entry.toAccountId ?? null) : (entry.accountId ?? null),
              note: entry.note ?? "",
              amount,
              coverageAmount:
                (entry as { coverageAmount?: number | null }).coverageAmount ?? null,
              paymentTermYears:
                (entry as { paymentTermYears?: number | null }).paymentTermYears ?? null,
              edit: {
                type: "investment" as const,
                date: entry.date,
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
          const balance = relatedEntries.reduce((sum, entry) => sum + entry.amount, 0);
          const totalPremium = relatedEntries
            .filter((entry) => entry.amount < 0)
            .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
          const coverageAmount = Number(product.coverageAmount ?? 0);
          return {
            id: product.id,
            label: product.name,
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
                ? "已满期"
                : product.status === "surrendered"
                  ? "已退保"
                  : product.status === "lapsed"
                    ? "已失效"
                    : "保障中",
            status: product.status,
            frequencyLabel:
              product.premiumFrequencyMonths === 1
                ? "每月"
                : product.premiumFrequencyMonths === 3
                  ? "每季"
                  : product.premiumFrequencyMonths === 6
                    ? "每半年"
                    : product.premiumFrequencyMonths === 12
                      ? "每年"
                      : product.premiumFrequencyMonths === 999999
                        ? "趸交"
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

  const allDepositAccounts = accounts.filter((account) => isDepositAccount(account));
  const allDepositAccountIds = allDepositAccounts.map((account) => account.id);
  const allDepositEntries =
    allDepositAccountIds.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            ...hid,
            deletedAt: null,
            fundProductType: "deposit",
            OR: [
              { accountId: { in: allDepositAccountIds } },
              { toAccountId: { in: allDepositAccountIds } },
            ],
          },
          select: {
            id: true,
            date: true,
            createdAt: true,
            deletedAt: true,
            type: true,
            accountId: true,
            accountName: true,
            toAccountId: true,
            toAccountName: true,
            amount: true,
            fundCode: true,
            fundName: true,
            fundProductType: true,
            fundSubtype: true,
            fundNav: true,
            fundConfirmDate: true,
            fundArrivalDate: true,
            fundArrivalAmount: true,
            depositAnnualRate: true,
            depositInterest: true,
            depositSourceEntryId: true,
            source: true,
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 5000,
        })
      : [];

  const allWealthAccounts = investmentAccountOptions.filter((account) => account.investProductType === "wealth");
  const allWealthAccountIds = allWealthAccounts.map((account) => account.id);
  const allWealthEntries =
    allWealthAccountIds.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            ...hid,
            deletedAt: null,
            fundProductType: "wealth",
            OR: [
              { accountId: { in: allWealthAccountIds } },
              { toAccountId: { in: allWealthAccountIds } },
            ],
          },
          select: {
            id: true,
            date: true,
            createdAt: true,
            deletedAt: true,
            accountId: true,
            accountName: true,
            toAccountId: true,
            toAccountName: true,
            amount: true,
            fundName: true,
            fundProductType: true,
            fundSubtype: true,
            fundArrivalAmount: true,
            depositAnnualRate: true,
            depositInterest: true,
            wealthProductId: true,
            WealthProduct: {
              select: {
                id: true,
                name: true,
                shortName: true,
                annualRate: true,
                termDays: true,
              },
            },
          },
          orderBy: [{ date: "asc" }, { createdAt: "asc" }],
          take: 5000,
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
      annualRate: number | null;
      termDays: number | null;
      firstDate: string;
      movements: Array<{ date: string; delta: number }>;
    }>();

    for (const entry of sourceEntryPool) {
      if (entry.fundProductType !== "wealth" || entry.deletedAt) continue;
      const amountValue = toNumber(entry.amount);
      const isRedeemEntry =
        entry.fundSubtype === "redeem" ||
        entry.fundSubtype === "switch_out" ||
        (amountValue > 0 && allWealthAccountIds.includes(entry.accountId ?? "") && entry.fundSubtype !== "dividend_cash");
      const isDividendEntry = entry.fundSubtype === "dividend_cash";
      const wealthAccountId = (isRedeemEntry ? entry.accountId : entry.toAccountId) ?? "";
      if (!wealthAccountId || !allWealthAccountIds.includes(wealthAccountId)) continue;

      const productName = entry.WealthProduct?.name ?? entry.fundName ?? "未命名理财";
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
        ? -Math.max(0, Math.abs(amountValue) - Math.max(0, toNumber(entry.depositInterest)))
        : isDividendEntry
          ? 0
          : Math.abs(toNumber(entry.fundArrivalAmount ?? entry.amount));
      const movementDate = toYmdOrNull(entry.date) ?? "";

      if (existing) {
        existing.remainingAmount += principalDelta;
        if (principalDelta !== 0 && movementDate) {
          existing.movements.push({ date: movementDate, delta: Number(principalDelta.toFixed(2)) });
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
          wealthAccountLabel: accountNameById.get(wealthAccountId) ?? entry.toAccountName ?? entry.accountName ?? "理财账户",
          remainingAmount: principalDelta,
          annualRate,
          termDays: entry.WealthProduct?.termDays ?? null,
          firstDate: movementDate,
          movements: principalDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(principalDelta.toFixed(2)) }] : [],
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
          holding.annualRate != null ? `年化 ${holding.annualRate}%` : "",
          holding.termDays ? `${holding.termDays}天` : "",
          `可赎回 ${formatMoney(holding.remainingAmount)}`,
        ].filter(Boolean).join(" · "),
        fundName: holding.fundName,
        wealthProductId: holding.wealthProductId,
        wealthAccountId: holding.wealthAccountId,
        wealthAccountLabel: holding.wealthAccountLabel,
        remainingAmount: Number(holding.remainingAmount.toFixed(2)),
        annualRate: holding.annualRate,
        termDays: holding.termDays,
        firstDate: holding.firstDate,
        movements: holding.movements,
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
      const fundName = (entry.fundName ?? entry.fundCode ?? "").trim() || "未命名存款";
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
      const depositAccountName = accountNameById.get(depositAccountId) ?? entry.toAccountName ?? entry.accountName ?? "定期存款";
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
            lot.maturityDate ? `到期 ${lot.maturityDate}` : "",
            lot.remainingAmount > 0.0001 ? `可取 ${formatMoney(lot.remainingAmount)}` : "已结清",
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
    for (const entry of entries) {
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
  const depositViewBalance = depositLots.reduce((sum, lot) => sum + lot.remainingAmount, 0);
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
              <span className="page-title">{selectedAccountLabel || "全部账户"}</span>
              {view === "debt" ? (
                <span className={`tabular-nums font-semibold ${pnlCls(totalDebtReceivable - totalDebtPayable)}`}>
                  {formatMoney(totalDebtReceivable - totalDebtPayable)}
                </span>
              ) : !selectedAccount ? (
                <LiveAccountBalance mode="total" initialValue={totalNetWorthValue} isRedUp={isRedUp} />
              ) : currentInvestData ? (
                <span className={`tabular-nums font-semibold ${pnlCls(currentInvestData.totalMarketValue)}`}>{formatMoney(currentInvestData.totalMarketValue)}</span>
              ) : view === "deposit" && selectedAccount ? (
                <span className={`tabular-nums font-semibold ${pnlCls(depositViewBalance)}`}>{formatMoney(depositViewBalance)}</span>
              ) : (
                <LiveAccountBalance
                  mode="account"
                  accountId={selectedAccount.id}
                  initialValue={selectedAccountBalanceValue}
                  isRedUp={isRedUp}
                  semantic={selectedAccount.kind === AccountKind.bank_credit ? "liability" : "default"}
                  displayMultiplier={selectedAccount.kind === AccountKind.bank_credit ? -1 : 1}
                />
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <UnifiedEntryLauncher
                defaultAction={
                  isDepositView
                    ? "deposit"
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
                              ? "transfer"
                              : "transaction"
                }
                context={{
                  defaultAccountId: selectedAccount?.id ?? accountId ?? "",
                  defaultCashAccountId: defaultCashAccountForSelectedInstitution,
                  defaultTransferFromAccountId: isBillAccount ? (lastRepayFromAccountId ?? cashAccountList[0]?.id ?? "") : (selectedAccount?.id ?? accountId ?? ""),
                  defaultTransferToAccountId: isBillAccount ? (selectedAccount?.id ?? accountId ?? "") : "",
                  defaultInvestmentAccountId: defaultFundInvestmentAccountId,
                  defaultMetalAccountId: defaultMetalInvestmentAccountId,
                  defaultWealthAccountId: defaultWealthAccountForSelectedInstitution,
                  defaultDepositAccountId: isDepositView ? defaultDepositAccountForSelectedInstitution : "",
                  defaultDepositSubtype: isDepositView && globalOpenDepositLots.length > 0 ? "redeem" : "buy",
                  defaultInsuranceAccountId: isInsuranceView ? (selectedAccount?.id ?? "") : "",
                  defaultDebtAccountId: selectedDebtRow?.accountIds?.[0] ?? "",
                  defaultDebtInstitutionId: selectedDebtObjectValue,
                  defaultScheduledTaskType:
                    view === "regularinvest"
                      ? "fund_regular_invest"
                      : isInsuranceView
                        ? "insurance_premium"
                        : "fund_regular_invest",
                }}
                actions={[
                  { key: "transaction", label: "收支记账" },
                  { key: "advance", label: "代付" },
                  { key: "transfer", label: isBillAccount ? "信用卡还款" : "转账" },
                  { key: "investment", label: "开放式基金 / 货币基金" },
                  { key: "metal", label: "贵金属" },
                  { key: "wealth", label: "银行理财" },
                  { key: "deposit", label: "存款" },
                  { key: "insurance", label: "保险" },
                  { key: "debt", label: "往来款", disabled: cashAccountList.length === 0 },
                  { key: "regular-task", label: "计划任务" },
                ]}
              />
              <>
              <TransactionFormModal
                accounts={spendingAccountOptions} transferAccounts={accountOptions}
                accountSSOptions={spendingAccountSSOptions} transferAccountSSOptions={allAccountSSOptions}
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
              <InvestmentFormModal
                mode="create"
                hideTrigger
                accountId={defaultInvestmentCreateAccountId}
                accountProductType={selectedAccount && isPureInvestmentAccount(selectedAccount) ? selectedAccount.investProductType ?? null : null}
                defaults={{
                  fundCode: currentInvestData?.selectedFundCode ?? undefined,
                  fundName: currentInvestData?.positions.find(p => p.fundCode === currentInvestData?.selectedFundCode)?.name ?? undefined,
                  fundUnits: currentInvestData?.positions.find(p => p.fundCode === currentInvestData?.selectedFundCode)?.units ?? undefined,
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
                  subLabel: account.Counterparty?.name ? "往来对象" : account.Institution?.name ? "机构往来" : "借入/借出",
                  institutionId: account.institutionId ?? null,
                  counterpartyId: account.counterpartyId ?? null,
                  institutionType: account.Institution?.type ?? account.Counterparty?.type ?? null,
                  isInstitutionLoan: !!account.institutionId,
                  debtDirection: account.debtDirection ?? null,
                }))}
                cashAccounts={cashAccountList}
                debtObjectOptions={debtObjectOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                nestedFieldData={nestedFieldData}
                defaultDebtAccountId={selectedDebtRow?.accountIds?.[0] ?? ""}
                defaultDebtInstitutionId={selectedDebtObjectValue}
                defaultCashAccountId={cashAccountList[0]?.id ?? ""}
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
                      <div className="text-sm font-semibold text-amber-900">这张信用卡还没设置账单日</div>
                      <div className="mt-1 text-xs leading-5 text-amber-800">
                        这不是“所有人”筛选的问题。信用卡账单明细要先按账单日划分周期；当前账户还没有账单日，所以系统暂时无法计算账单，也不会显示对应明细。
                      </div>
                      <div className="mt-2 text-xs text-amber-700">
                        请先到“账户管理”里补上这张卡的账单日，保存后再回到这里查看。
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
                  {billSummariesWithCumulative.length > 0 ? (
                    <CreditBillSummaryTable
                      accountId={selectedAccount?.id ?? ""}
                      accountName={selectedAccount?.name ?? ""}
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
                      暂无账单记录
                    </div>
                  )}

                  <BasicDetailSelectionProvider resetKey={`${selectedAccount?.id ?? ""}:${selectedCreditBillMonth || "all"}:credit-bill-detail`}>
                    <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
                      <BasicDetailBatchDeleteMessage />
                      <DetailViewClient
                        accountId={selectedAccount?.id ?? ""}
                        isInvestAccount={false}
                        initialEntries={creditBillDetailEntries}
                        accountOptions={accountOptions}
                        categoryOptions={categoryBatchReplaceOptions}
                        investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                        compactRows
                        storageKey="mmh_credit_bill_detail_table_v1"
                        resetKey={`${selectedAccount?.id ?? ""}:${selectedCreditBillMonth || "all"}:credit-bill-detail`}
                        refreshOnGlobalEvent
                        toolbarMode="custom"
                        toolbarTitle={creditBillDetailTitle}
                        toolbarRightContent={
                          !showAllCreditBillDetails && creditCardBill ? (
                            <div key="credit-bill-toolbar-period" className="flex min-w-0 items-center gap-3 text-xs text-slate-500 tabular-nums">
                              <span className="hidden whitespace-nowrap md:inline">
                                周期：{mdUtcDots(creditCardBill.start)} ~ {mdUtcDots(creditCardBill.end)} · {creditCardBill.isCurrentCycle ? "未出账单" : "本期账单"}
                              </span>
                              <span className="whitespace-nowrap text-slate-600">共 {creditBillDetailEntries.length} 条</span>
                              <Link href="/batch-import" className="flex h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600" title="导入信用卡账单记录">
                                <Upload className="h-3 w-3" />导入
                              </Link>
                            </div>
                          ) : (
                            <div key="credit-bill-toolbar-all" className="flex min-w-0 items-center gap-3 text-xs text-slate-500 tabular-nums">
                              <span className="whitespace-nowrap text-slate-600">共 {creditBillDetailEntries.length} 条</span>
                              <Link href="/batch-import" className="flex h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600" title="导入信用卡账单记录">
                                <Upload className="h-3 w-3" />导入
                              </Link>
                            </div>
                          )
                        }
                        emptyText="暂无记录"
                      />
                    </div>
                  </BasicDetailSelectionProvider>
                </div>
              </div>
            </div>
          ) : view === "debt" ? (
            <DebtShell
              rows={debtRows.map((row) => ({
                key: row.key,
                name: row.name,
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
                nextRepaymentDate: row.nextRepaymentDate,
                nextRepaymentPrincipal: row.nextRepaymentPrincipal,
                nextRepaymentInterest: row.nextRepaymentInterest,
                nextRepaymentCashAccountId: row.nextRepaymentCashAccountId,
                loanRateAdjustments: row.loanRateAdjustments,
                payable: row.payable,
                receivable: row.receivable,
                net: row.net,
                accountCount: row.accountCount,
              }))}
              selectedKey={selectedDebtKey}
              entries={debtDetailEntries}
              repaymentScheduleRows={repaymentScheduleRows}
              totalPayable={totalDebtPayable}
              totalReceivable={totalDebtReceivable}
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
                  subLabel: "家庭成员",
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
              initialFundCode={investwealthData.selectedFundCode}
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
                  entries={allDetailEntries}
                  originalCount={entries.length}
                  hasDetailFilters={hasDetailFilters}
                  initialPage={safeDetailPage}
                  initialPageSize={pageSize}
                  initialDetailAll={detailAll}
                  normalExportHref={normalExportHref}
                  normalExportFilename={normalExportFilename}
                  accountOptions={accountOptions.map((a) => ({ id: a.id, label: a.label, title: a.hoverTitle }))}
                  categoryOptions={categoryBatchReplaceOptions}
                  investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                  compactRows={selectedAccount?.kind === AccountKind.bank_debit}
                  showBalanceReconcile={
                    selectedAccount?.kind === AccountKind.cash ||
                    selectedAccount?.kind === AccountKind.bank_debit ||
                    selectedAccount?.kind === AccountKind.ewallet
                  }
                  accountLabel={selectedAccountLabel}
                  currentBalance={selectedAccountBalanceValue}
                />
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
    );
  }
