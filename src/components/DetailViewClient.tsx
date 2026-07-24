"use client";

import { useCallback, useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { dispatchEntryEdit, EntryRowActions, type EditPayload } from "./EntryRowActions";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableDropPosition } from "./AdvancedDataTable";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchReplaceButton,
  type BasicDetailBatchCategoryOption,
  useBasicDetailSelection,
} from "./BasicDetailSelection";
import { useI18n } from "@/lib/i18n";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, applyBalanceReconcileEntry, effectiveAmountForAccount, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT, LEGACY_FINANCE_REFRESH_EVENT } from "@/lib/client/refresh";
import { isCreditCardRepaymentTransfer } from "@/lib/transaction-semantics";
import { normalizeSettlementTransferCategoryName } from "@/lib/default-categories";
import { advanceDialogAmount } from "@/lib/advance-transfer";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import {
  decodeDetailPaginationPreference,
  detailPaginationCookieName,
  normalizeDetailPage,
  normalizeDetailPageSize,
} from "@/lib/detail-pagination-preference";
import { parseImportAccountId } from "@/lib/account-import-match";

/* Types */

export type DetailEntry = {
  id: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  date: string;
  postedAt?: string | null;
  createdAt?: string | null;
  dayOrder?: number | null;
  amount: number;
  runningBalance?: number | null;
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  accountKind?: string | null;
  accountDebtDirection?: string | null;
  accountIsSettlementDebt?: boolean | null;
  accountInstitutionName?: string | null;
  counterpartyInstitutionId?: string | null;
  counterpartyInstitutionName?: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
  toAccountIsSettlementDebt?: boolean | null;
  toAccountInstitutionName?: string | null;
  note: string | null;
  businessNote?: string | null;
  toNote?: string | null;
  fundSubtype: string | null;
  fundCode: string | null;
  fundName: string | null;
  wealthProductId?: string | null;
  source: string | null;
  fundProductType: string | null;
  metalTypeId?: string | null;
  metalTypeName?: string | null;
  metalUnitId?: string | null;
  metalUnitName?: string | null;
  metalQuantity?: number | null;
  metalUnitPrice?: number | null;
  metalFee?: number | null;
  insuranceProductId?: string | null;
  insuranceAction?: string | null;
  insuranceProductName?: string | null;
  debtPrincipalAmount?: number | null;
  debtInterestAmount?: number | null;
  debtFeeAmount?: number | null;
  cashAccountId?: string | null;
  coverageAmount?: number | null;
  paymentTermYears?: number | null;
  fundUnits: number | null;
  fundNav: number | null;
  depositAnnualRate?: number | null;
  depositInterest?: number | null;
  depositSourceEntryId?: string | null;
  fundFee: number | null;
  fundConfirmDate: string | null;
  fundArrivalDate: string | null;
  fundSourceEntryId?: string | null;
  fundArrivalAmount: number | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  entryTags: Array<{
    tagId: string;
    Tag: { name: string; color: string } | null;
  }>;
};

function cssEscape(value: string) {
  const escape = typeof window !== "undefined" ? window.CSS?.escape : undefined;
  return escape ? escape(value) : value.replace(/["\\]/g, "\\$&");
}

function buildBasicEntryEditPayload(entry: DetailEntry) {
  const isAdvanceReturn = entry.source === "advance" && entry.accountKind === "loan";
  const numericAmount = toNumber(entry.amount);
  const dialogAmount = entry.type === "transfer" && entry.source !== "advance"
    ? Math.abs(numericAmount)
    : advanceDialogAmount({ amount: numericAmount, accountKind: entry.accountKind, source: entry.source });
  return {
    id: entry.id,
    transactionId: entry.id,
    date: (entry.date ?? "").slice(0, 10),
    postedAt: entry.postedAt ?? null,
    type: (entry.source === "advance" ? "advance" : entry.type) as EditPayload["type"],
    amount: dialogAmount,
    note: entry.note ?? "",
    toNote: entry.toNote ?? "",
    categoryId: entry.categoryId ?? undefined,
    categoryName: entry.categoryName ?? undefined,
    accountId: (isAdvanceReturn ? entry.toAccountId : entry.accountId) ?? undefined,
    accountName: (isAdvanceReturn ? entry.toAccountName : entry.accountName) ?? undefined,
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? undefined,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? undefined,
    fromAccountId: entry.type === "transfer" ? entry.accountId ?? undefined : undefined,
    toAccountId: entry.toAccountId ?? undefined,
    toAccountName: entry.toAccountName ?? undefined,
    tagIds: entry.entryTags?.map((item) => item.tagId) ?? [],
  };
}

function runningBalanceContribution(entry: DetailEntry, accountId: string) {
  return applyBalanceReconcileEntry(0, entry, accountId);
}

function canRecalculateRunningBalanceFromLoadedEntries(entries: DetailEntry[], accountId: string) {
  const ascEntries = [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
  const firstEntry = ascEntries[0];
  if (!firstEntry || firstEntry.runningBalance == null) return false;
  return Math.abs(toNumber(firstEntry.runningBalance) - runningBalanceContribution(firstEntry, accountId)) < 0.005;
}

function recalculateLoadedRunningBalances(entries: DetailEntry[], accountId: string) {
  const runningBalanceById = new Map<string, number>();
  let runningBalance = 0;
  for (const entry of [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId))) {
    runningBalance = applyBalanceReconcileEntry(runningBalance, entry, accountId);
    runningBalanceById.set(entry.id, runningBalance);
  }
  return entries.map((entry) => ({ ...entry, runningBalance: runningBalanceById.get(entry.id) ?? entry.runningBalance ?? null }));
}

function removeEntriesAndUpdateRunningBalances(entries: DetailEntry[], deletedSet: Set<string>, accountId: string) {
  const deletedEntries = entries.filter((entry) => deletedSet.has(entry.id));
  if (deletedEntries.length === 0) return entries;
  const remainingEntries = entries.filter((entry) => !deletedSet.has(entry.id));
  if (canRecalculateRunningBalanceFromLoadedEntries(remainingEntries, accountId)) {
    return recalculateLoadedRunningBalances(remainingEntries, accountId);
  }
  if (deletedEntries.some((entry) => getBalanceReconcileTarget(entry) != null)) return remainingEntries;
  return remainingEntries.map((entry) => {
    if (entry.runningBalance == null) return entry;
    const adjustment = deletedEntries.reduce((sum, deletedEntry) => (
      compareDetailEntriesAsc(deletedEntry, entry, accountId) < 0
        ? sum + runningBalanceContribution(deletedEntry, accountId)
        : sum
    ), 0);
    return adjustment === 0
      ? entry
      : { ...entry, runningBalance: toNumber(entry.runningBalance) - adjustment };
  });
}

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type DetailAccountOption = {
  id: string;
  label: string;
  fullLabel?: string | null;
  title?: string | null;
  kind?: string | null;
  debtDirection?: string | null;
  numberMasked?: string | null;
};

/* Helpers */

function shouldShowBusinessLinkStatus(entry: DetailEntry) {
  const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
  const hasInvestmentSide = entry.accountKind === "investment" || entry.toAccountKind === "investment";
  return hasBusinessLink || entry.type === "investment" || (entry.type === "transfer" && hasInvestmentSide);
}

function subtypeLabelInfo(
  subtype: string | null | undefined,
  source: string | null | undefined,
  t: (key: string) => string,
): { label: string; cls: string; textCls?: string } | { label: string } | null {
  if (!subtype) return null;
  if (source === "deposit" || source === "deposit_manual") {
    const depositLabels: Record<string, { label: string; cls: string }> = {
      buy: { label: t("deposit.subtype.buy"), cls: "bg-blue-50 text-blue-600" },
      redeem: { label: t("deposit.subtype.redeem"), cls: "bg-amber-50 text-amber-600" },
    };
    const deposit = depositLabels[subtype];
    if (deposit) return deposit;
  }
  if (source === "insurance") {
    const insuranceLabels: Record<string, { label: string; cls: string }> = {
      buy: { label: "保险续期", cls: "bg-blue-50 text-blue-600" },
      redeem: { label: "保险回款", cls: "bg-emerald-50 text-emerald-600" },
      switch_out: { label: "保险回款", cls: "bg-emerald-50 text-emerald-600" },
    };
    const insurance = insuranceLabels[subtype];
    if (insurance) return insurance;
  }
  const baseLabels: Record<string, { label: string; cls: string }> = {
    buy: { label: t("fund.subtype.buy"), cls: "bg-blue-50 text-blue-600" },
    redeem: { label: t("fund.subtype.redeem"), cls: "bg-amber-50 text-amber-600" },
    switch_out: { label: t("fund.subtype.switch_out"), cls: "bg-purple-50 text-purple-600" },
    dividend_cash: { label: t("fund.subtype.dividend_cash"), cls: "bg-emerald-50 text-emerald-600" },
    dividend_reinvest: { label: t("fund.subtype.dividend_reinvest"), cls: "bg-emerald-50 text-emerald-600" },
    buy_failed: { label: t("fund.subtype.buy_failed"), cls: "bg-red-50 text-red-600" },
  };
  const base = baseLabels[subtype];
  if (!base) return base;
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

function formatType(type: string, t: (key: string) => string) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return type;
}

function isCreditCardRepaymentDisplayEntry(entry: DetailEntry) {
  if (entry.accountIsSettlementDebt || entry.toAccountIsSettlementDebt) return false;
  if (entry.accountKind === "loan" || entry.toAccountKind === "loan") return false;
  return isCreditCardRepaymentTransfer(entry);
}

function debtModeFromSource(source: string, note?: string | null): DebtMode | null {
  if (source === "debt_borrow_in") return "borrow_in";
  if (source === "debt_financed_purchase") return "borrow_in";
  if (source === "debt_lend_out") return "lend_out";
  if (source === "debt_repay_out") return "repay_out";
  if (source === "debt_prepay_out") return "prepay_out";
  if (source === "debt_collect_in") return "collect_in";
  if (source === "scheduled_task" && String(note ?? "").includes("还贷款")) return "repay_out";
  return null;
}

function inferDebtMode(
  entry: {
    type: string;
    source: string | null;
    note?: string | null;
    accountKind?: string | null;
    accountDebtDirection?: string | null;
    toAccountKind?: string | null;
    toAccountDebtDirection?: string | null;
  },
  accountById?: Map<string, DetailAccountOption>,
): DebtMode | null {
  if (entry.type !== "transfer") return null;
  if (entry.source === "advance") return null;
  const sourceMode = debtModeFromSource(String(entry.source ?? ""), entry.note);
  if (sourceMode) return sourceMode;
  const sourceAccount = accountById?.get((entry as { accountId?: string | null }).accountId ?? "");
  const targetAccount = accountById?.get((entry as { toAccountId?: string | null }).toAccountId ?? "");
  const sourceKind = entry.accountKind ?? sourceAccount?.kind ?? null;
  const targetKind = entry.toAccountKind ?? targetAccount?.kind ?? null;
  const sourceDirection = entry.accountDebtDirection ?? sourceAccount?.debtDirection ?? null;
  const targetDirection = entry.toAccountDebtDirection ?? targetAccount?.debtDirection ?? null;
  if (sourceKind === "loan") return sourceDirection === "receivable" ? "collect_in" : "borrow_in";
  if (targetKind === "loan") return targetDirection === "receivable" ? "lend_out" : "repay_out";
  return null;
}

function isDebtActivityEntry(entry: {
  type: string;
  source: string | null;
  note: string | null;
  accountKind?: string | null;
  accountDebtDirection?: string | null;
  accountIsSettlementDebt?: boolean | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
  toAccountIsSettlementDebt?: boolean | null;
}, accountById?: Map<string, DetailAccountOption>) {
  if (entry.type !== "transfer") return false;
  return inferDebtMode(entry, accountById) != null;
}

function bankDebtTransferLabel(entry: DetailEntry, mode: DebtMode | null) {
  const involvesBankDebt =
    (entry.accountKind === "loan" && !entry.accountIsSettlementDebt) ||
    (entry.toAccountKind === "loan" && !entry.toAccountIsSettlementDebt);
  if (!involvesBankDebt) return null;
  if (entry.source === "debt_financed_purchase") return "消费分期";
  if (mode === "borrow_in") return "贷款发放";
  if (mode === "repay_out") return "贷款还款";
  if (mode === "prepay_out") return "提前还款";
  if (mode === "lend_out") return "银行放款";
  if (mode === "collect_in") return "银行收回";
  return entry.categoryName || "银行贷款";
}

function debtCategoryLabel(entry: DetailEntry, accountById?: Map<string, DetailAccountOption>) {
  if (!isDebtActivityEntry(entry, accountById)) return null;
  const mode = inferDebtMode(entry, accountById);
  const bankLabel = bankDebtTransferLabel(entry, mode);
  if (bankLabel) return bankLabel;
  return normalizeSettlementTransferCategoryName(entry.categoryName);
}

function displaySecondRemark(entry: { toNote?: string | null }) {
  return parseLoanPrepayStrategy(entry.toNote) ? "" : (entry.toNote ?? "");
}

function displayDetailRemark(entry: DetailEntry, currentAccountId?: string) {
  if (entry.source === "insurance") return getInsuranceDetailNote(entry);
  if (entry.type === "transfer" && currentAccountId && entry.toAccountId === currentAccountId) {
    return (displaySecondRemark(entry).trim() || (entry.note ?? "").trim());
  }
  return (entry.note ?? "").trim();
}

function readCookieValue(name: string) {
  if (typeof document === "undefined") return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? match[1] : null;
}

function readDetailPaginationSnapshot(accountId: string) {
  const key = detailPaginationCookieName(accountId);
  const stored = typeof window === "undefined"
    ? null
    : decodeDetailPaginationPreference(window.sessionStorage.getItem(key));
  return stored ?? decodeDetailPaginationPreference(readCookieValue(key));
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function detailEntryDayKey(entry: DetailEntry, accountId: string) {
  return localDateKey(getDetailEntryDisplayDate(entry, accountId));
}

function canManuallyReorderDetailEntry(entry: DetailEntry) {
  return getBalanceReconcileTarget(entry) == null;
}

function reorderEntriesToTarget(entries: DetailEntry[], sourceId: string, targetId: string, position: AdvancedDataTableDropPosition) {
  const sourceIndex = entries.findIndex((entry) => entry.id === sourceId);
  const targetIndex = entries.findIndex((entry) => entry.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return entries;
  const next = [...entries];
  const [moving] = next.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((entry) => entry.id === targetId);
  if (targetIndexAfterRemoval < 0) return entries;
  next.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
  if (next.every((entry, index) => entry.id === entries[index]?.id)) return entries;
  return next;
}

function applyServerEntryOrder(entries: DetailEntry[], orderedEntryIds: string[]) {
  if (orderedEntryIds.length === 0) return entries;
  const orderedIdSet = new Set(orderedEntryIds);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const orderedEntries = orderedEntryIds
    .map((id) => entryById.get(id))
    .filter((entry): entry is DetailEntry => !!entry);
  if (orderedEntries.length === 0) return entries;

  let orderedIndex = 0;
  let changed = false;
  const next = entries.map((entry) => {
    if (!orderedIdSet.has(entry.id)) return entry;
    const replacement = orderedEntries[orderedIndex++] ?? entry;
    if (replacement.id !== entry.id) changed = true;
    return replacement;
  });
  return changed ? next : entries;
}

function applyServerRunningBalances(entries: DetailEntry[], runningBalances?: Record<string, number>) {
  if (!runningBalances) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    const runningBalance = runningBalances[entry.id];
    if (runningBalance == null) return entry;
    if (entry.runningBalance != null && Math.abs(toNumber(entry.runningBalance) - runningBalance) < 0.005) return entry;
    changed = true;
    return { ...entry, runningBalance };
  });
  return changed ? next : entries;
}

type ReorderResponse = {
  ok?: boolean;
  changed?: boolean;
  orderedEntryIds?: string[];
  runningBalances?: Record<string, number>;
  error?: string;
};

function activityLabel(type: string, fundSubtype: string | null, source: string | null, t: (key: string) => string, balanceTarget: number | null = null): string {
  if (balanceTarget != null && source === BALANCE_INITIALIZATION_SOURCE) return "初始";
  if (source === BALANCE_RECONCILE_SOURCE) return "校准";
  if (source === "insurance") {
    return fundSubtype === "redeem" || fundSubtype === "switch_out" ? "保险回款" : "保险支出";
  }
  if (source === "advance") return "代付";
  if (type === "investment" && (source === "deposit" || source === "deposit_manual")) return "存款";
  return formatType(type, t);
}

function investmentCategoryLabel(
  entry: DetailEntry,
  entryFundProductType: string | null | undefined,
): string {
  if (entry.source === "insurance") return getInsuranceDetailCategoryName(entry);
  if (entry.categoryName) return entry.categoryName;
  const subtype = String(entry.fundSubtype ?? "");
  const source = String(entry.source ?? "");
  const productType = entryFundProductType ?? null;
  if (productType === "deposit") {
    if (subtype === "redeem") return "存款取出";
    if (subtype === "buy") return "存款存入";
  }
  if (productType === "wealth") {
    if (subtype === "redeem") return "理财赎回";
    if (subtype === "buy_failed" && source === "regular_invest_refund") return "买入退回";
    if (subtype === "buy_failed") return "买入失败";
    if (subtype === "buy") return "理财买入";
  }
  if (productType === "metal") {
    if (subtype === "redeem") return "贵金属卖出";
    if (subtype === "buy") return "贵金属买入";
  }
  if (productType === "fund" || productType === "money" || !productType) {
    if (subtype === "buy" && source === "regular_invest") return "基金定投";
    if (subtype === "buy" && source === "dividend") return "红利转投";
    if (subtype === "redeem") return "基金赎回";
    if (subtype === "dividend_cash") return "现金分红";
    if (subtype === "dividend_reinvest") return "分红再投资";
    if (subtype === "buy_failed" && source === "regular_invest_refund") return "买入退回";
    if (subtype === "buy_failed") return "买入失败";
    if (subtype === "buy") return "基金买入";
  }
  return "";
}

function investmentActionLabel(
  entry: DetailEntry,
  entryFundProductType: string | null | undefined,
  t: (key: string) => string,
): string {
  if (entry.source === "insurance") return getInsuranceDetailCategoryName(entry);
  const productType = entryFundProductType ?? null;
  const subtype = String(entry.fundSubtype ?? "");
  const source = String(entry.source ?? "");

  if (!subtype) return entry.categoryName ?? "";

  if (productType === "deposit") {
    if (subtype === "redeem") return "存款取出";
    if (subtype === "buy") return "存款存入";
  }

  if (productType === "wealth") {
    if (subtype === "redeem") return "理财赎回";
    if (subtype === "buy_failed" && source === "regular_invest_refund") return "买入退回";
    if (subtype === "buy_failed") return "买入失败";
    if (subtype === "buy") return "理财买入";
  }

  if (productType === "metal") {
    if (subtype === "redeem") return "贵金属卖出";
    if (subtype === "buy") return "贵金属买入";
  }

  if (productType === "fund" || productType === "money" || !productType) {
    if (subtype === "buy" && source === "regular_invest") return "基金定投";
    if (subtype === "buy" && source === "dividend") return "红利转投";
    if (subtype === "redeem") return "基金赎回";
    if (subtype === "dividend_cash") return "现金分红";
    if (subtype === "dividend_reinvest") return "分红再投资";
    if (subtype === "buy_failed" && source === "regular_invest_refund") return "买入退回";
    if (subtype === "buy_failed") return "买入失败";
    if (subtype === "buy") return "基金买入";
  }

  const info = subtypeLabelInfo(subtype, entry.source, t);
  return info?.label ?? entry.categoryName ?? "";
}

/* Component */

export function DetailViewClient({
  accountId,
  initialEntries,
  accountOptions,
  categoryOptions = [],
  investmentProductTypeByAccountId,
  compactRows = false,
  storageKey = "mmh_basic_detail_table_v1",
  refreshOnGlobalEvent = true,
  toolbarMode = "default",
  toolbarTitle,
  toolbarRightContent,
  resetKey,
  emptyText = "暂无记录",
  draggableRows = true,
  allowInvestmentEdit = true,
  showAccountColumn = false,
  accountColumnLabel = "账户",
  accountColumnMode = "account",
  accountColumnDefaultHidden = false,
  relatedAccountDefaultHidden = false,
  showRunningBalance = true,
  runningBalanceDefaultHidden = false,
  enableAccountNavigation = false,
  focusEntryId,
  reorderAccountIds,
  sortable = true,
}: {
  accountId: string;
  isInvestAccount: boolean;
  initialEntries: DetailEntry[];
  accountOptions: DetailAccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  storageKey?: string;
  refreshOnGlobalEvent?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarTitle?: ReactNode;
  toolbarRightContent?: ReactNode;
  resetKey?: string;
  emptyText?: string;
  draggableRows?: boolean;
  allowInvestmentEdit?: boolean;
  showAccountColumn?: boolean;
  accountColumnLabel?: string;
  accountColumnMode?: "account" | "cardLast4";
  accountColumnDefaultHidden?: boolean;
  relatedAccountDefaultHidden?: boolean;
  showRunningBalance?: boolean;
  runningBalanceDefaultHidden?: boolean;
  enableAccountNavigation?: boolean;
  focusEntryId?: string;
  reorderAccountIds?: string[];
  sortable?: boolean;
}) {
  const { t } = useI18n();
  const accountOptionById = useMemo(
    () => new Map(accountOptions.map((option) => [option.id, option])),
    [accountOptions],
  );
  const accountDisplayFallback = useCallback((accountId?: string | null, fallback?: string | null) => {
    const byId = accountId ? accountOptionById.get(accountId) : undefined;
    if (byId) {
      const fullLabel = byId.fullLabel?.trim() || byId.label;
      return { label: fullLabel, title: byId.title ?? fullLabel };
    }
    const raw = String(fallback ?? "").trim();
    if (!raw) return { label: "", title: "" };
    const encodedId = parseImportAccountId(raw);
    const directId = encodedId || (/^cm[a-z0-9]{8,}$/i.test(raw) ? raw : "");
    const byFallbackId = directId ? accountOptionById.get(directId) : undefined;
    if (byFallbackId) return { label: byFallbackId.label, title: byFallbackId.title ?? byFallbackId.label };
    return { label: raw, title: raw };
  }, [accountOptionById]);
  const accountColumnScopeIds = useMemo(
    () => new Set((reorderAccountIds?.length ? reorderAccountIds : [accountId]).filter(Boolean)),
    [accountId, reorderAccountIds],
  );
  const accountColumnTarget = useCallback((entry: DetailEntry) => {
    if (accountColumnMode === "cardLast4") {
      if (entry.accountId && accountColumnScopeIds.has(entry.accountId)) {
        return { id: entry.accountId, name: entry.accountName };
      }
      if (entry.toAccountId && accountColumnScopeIds.has(entry.toAccountId)) {
        return { id: entry.toAccountId, name: entry.toAccountName };
      }
    }
    return { id: entry.accountId, name: entry.accountName };
  }, [accountColumnMode, accountColumnScopeIds]);
  const accountColumnDisplayFallback = useCallback((entry: DetailEntry) => {
    const target = accountColumnTarget(entry);
    if (accountColumnMode === "cardLast4") {
      const option = target.id ? accountOptionById.get(target.id) : undefined;
      const last4 = option?.numberMasked?.trim();
      if (last4) {
        const title = option?.title ?? option?.fullLabel ?? option?.label ?? last4;
        return { id: target.id, label: last4, title };
      }
    }
    return { id: target.id, ...accountDisplayFallback(target.id, target.name) };
  }, [accountColumnMode, accountColumnTarget, accountDisplayFallback, accountOptionById]);
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const [refreshedEntries, setRefreshedEntries] = useState<{ accountId: string; entries: DetailEntry[] } | null>(null);
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());
  const entries = refreshedEntries?.accountId === accountId ? refreshedEntries.entries : initialEntries;
  const linkDetailCashFlow = useCallback(async (entry: DetailEntry) => {
    const id = String(entry.id ?? "").trim();
    if (!id || linkingIds.has(id)) return;
    const businessTransactionId = String(entry.businessTransactionId ?? "").trim();
    const businessType =
      entry.fundProductType === "wealth"
        ? "wealth"
        : entry.fundProductType === "deposit"
          ? "deposit"
          : entry.fundProductType === "metal"
            ? "metal"
            : entry.insuranceProductId || entry.insuranceAction || entry.source === "insurance"
              ? "insurance"
              : entry.fundProductType === "fund" || entry.fundCode
                ? "fund"
                : null;
    if (!businessType) {
      window.alert("这条记录缺少可自动建立关联的业务类型");
      return;
    }
    if (!businessTransactionId) {
      window.alert("这条记录缺少业务记录 ID，无法自动建立关联");
      return;
    }
    setLinkingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType, businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? "建立关联失败");
      dispatchFinanceDataChanged({ reason: "detail-link-cash-flow", entryIds: [data.data?.cashEntryId, id].filter(Boolean) });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "建立关联失败");
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [linkingIds]);
  const navigateToAccountEntry = useCallback((targetAccountId: string | null | undefined, entry: DetailEntry) => {
    const target = String(targetAccountId ?? "").trim();
    if (!enableAccountNavigation || !target) return;
    const params = new URLSearchParams({
      accountId: target,
      view: "detail",
      pageSize: "40",
      focusEntryId: entry.id,
    });
    window.location.assign(`/?${params.toString()}`);
  }, [enableAccountNavigation]);

  const renderNavigableAccountLabel = useCallback((
    entry: DetailEntry,
    targetAccountId: string | null | undefined,
    label: string | null | undefined,
    title: string | null | undefined,
    className: string,
  ) => {
    const text = label || "";
    if (!enableAccountNavigation || !targetAccountId) {
      return <span className={className} title={title ?? ""}>{text || <span className="text-slate-300">-</span>}</span>;
    }
    return (
      <span
        data-row-double-click-ignore
        className={`${className} cursor-zoom-in decoration-dotted underline-offset-4 hover:underline`}
        title={`${title || text}（双击打开该账户明细并定位此记录）`}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          navigateToAccountEntry(targetAccountId, entry);
        }}
      >
        {text || <span className="text-slate-300">-</span>}
      </span>
    );
  }, [enableAccountNavigation, navigateToAccountEntry]);

  useEffect(() => {
    const target = String(focusEntryId ?? "").trim();
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-advanced-row-key="${cssEscape(target)}"]`);
      row?.scrollIntoView({ block: "center", inline: "nearest" });
      const url = new URL(window.location.href);
      if (url.searchParams.get("focusEntryId") === target) {
        url.searchParams.delete("focusEntryId");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries, focusEntryId]);

  const linkedInvestmentCandidateEntries = useMemo(
    () => entries
      .filter((entry) => entry.type === "investment" && entry.fundCode && entry.fundSubtype)
      .map((entry) => ({
        id: entry.id,
        date: (entry.date ?? "").slice(0, 10),
        createdAt: entry.createdAt ?? null,
        fundConfirmDate: entry.fundConfirmDate?.slice(0, 10) ?? null,
        fundArrivalDate: entry.fundArrivalDate?.slice(0, 10) ?? null,
        fundSourceEntryId: entry.fundSourceEntryId ?? null,
        fundCode: entry.fundCode ?? "",
        fundSubtype: entry.fundSubtype ?? "",
        fundUnits: entry.fundUnits != null ? toNumber(entry.fundUnits) : null,
        source: entry.source ?? null,
        accountId: entry.accountId,
        toAccountId: entry.toAccountId,
        amount: toNumber(entry.amount),
      })),
    [entries],
  );
  const buildEntryEditRequest = useCallback((e: DetailEntry): {
    edit?: Omit<EditPayload, "entryId">;
    customEditEvent?: { name: string; detail: Record<string, unknown> };
  } => {
    const dateStr = (e.date ?? "").slice(0, 10);
    const amount = toNumber(e.amount);
    const linkedBusinessLabels = e.businessLinkLabels ?? [];
    const linkedFundProductType = linkedBusinessLabels.includes("理财交易")
      ? "wealth"
      : linkedBusinessLabels.includes("存款交易")
        ? "deposit"
        : linkedBusinessLabels.includes("贵金属交易")
          ? "metal"
          : linkedBusinessLabels.includes("基金交易")
            ? "fund"
            : null;
    const entryFundProductType =
      e.fundProductType ??
      linkedFundProductType ??
      (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
      (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
      null;
    const isRedeemEditEntry =
      e.fundSubtype === "redeem" ||
      e.fundSubtype === "switch_out" ||
      (e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund");
    const targetInvestmentEditEntryId =
      e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund" && e.fundSourceEntryId
        ? e.fundSourceEntryId
        : e.id;
    const investmentEditPayload =
      e.type !== "investment" || !allowInvestmentEdit
        ? undefined
        : {
            targetEntryId: targetInvestmentEditEntryId,
            transactionId: e.id,
            cashEntryId: e.cashEntryId ?? e.id,
            businessTransactionId: e.businessTransactionId ?? null,
            date: dateStr,
            confirmDate: e.fundConfirmDate?.slice(0, 10),
            type: e.type,
            amount,
            note: entryFundProductType === "wealth" ? e.businessNote ?? "" : e.note ?? "",
            fundCode: e.fundCode ?? undefined,
            fundName: e.fundName ?? undefined,
            wealthProductId: e.wealthProductId ?? null,
            insuranceProductId: e.insuranceProductId ?? null,
            insuranceAction: e.insuranceAction === "premium" || e.insuranceAction === "additional_premium" || e.insuranceAction === "refund" ? e.insuranceAction : undefined,
            insuranceProductName: e.insuranceProductName ?? undefined,
            fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : undefined,
            fundNav: e.fundNav != null ? toNumber(e.fundNav) : undefined,
            depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : undefined,
            depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : undefined,
            depositSourceEntryId: e.depositSourceEntryId ?? null,
            fundFee: e.fundFee != null ? toNumber(e.fundFee) : undefined,
            fundProductType: entryFundProductType ?? undefined,
            metalTypeId: e.metalTypeId ?? null,
            metalTypeName: e.metalTypeName ?? null,
            metalUnitId: e.metalUnitId ?? null,
            metalUnitName: e.metalUnitName ?? null,
            metalQuantity: e.metalQuantity ?? null,
            metalUnitPrice: e.metalUnitPrice ?? null,
            metalFee: e.metalFee ?? null,
            fundSubtype: e.fundSubtype ?? undefined,
            source: e.source,
            accountId: e.accountId ?? undefined,
            toAccountId: e.toAccountId ?? undefined,
            cashAccountId: (isRedeemEditEntry ? e.toAccountId : e.accountId) ?? undefined,
            toAccountName: e.toAccountName ?? undefined,
            fundArrivalDate: e.fundArrivalDate?.slice(0, 10),
            fundSourceEntryId: e.fundSourceEntryId ?? null,
            fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
            linkedCandidateEntries: linkedInvestmentCandidateEntries,
          } satisfies Omit<EditPayload, "entryId">;

    const balanceReconcileTarget = getBalanceReconcileTarget(e);
    const balanceReconcileEditEvent = balanceReconcileTarget == null || (e.source !== BALANCE_RECONCILE_SOURCE && e.source !== BALANCE_INITIALIZATION_SOURCE) ? undefined : {
      name: "mmh:balance-reconcile:edit",
      detail: {
        entryId: e.id,
        accountId: e.accountId,
        accountName: e.accountName,
        date: dateStr,
        amount: balanceReconcileTarget,
        source: e.source,
      },
    };
    const debtMode = inferDebtMode(e, accountOptionById);
    const isDebtActivity = isDebtActivityEntry(e, accountOptionById);
    const debtPrincipalAmount = e.debtPrincipalAmount == null ? Math.abs(toNumber(e.amount)) : toNumber(e.debtPrincipalAmount);
    const debtInterestAmount = Math.abs(toNumber(e.debtInterestAmount ?? 0));
    const debtFeeAmount = Math.abs(toNumber(e.debtFeeAmount ?? 0));
    const isDebtAccountFromSide = debtMode === "borrow_in" || debtMode === "collect_in";
    const debtAccountIdForEdit = isDebtAccountFromSide ? (e.accountId ?? "") : (e.toAccountId ?? "");
    const cashAccountIdForEdit = isDebtAccountFromSide ? (e.toAccountId ?? "") : (e.accountId ?? "");
    const debtEditEvent =
      !balanceReconcileEditEvent && isDebtActivity && debtMode
        ? {
            name: "mmh:debt:create",
            detail: {
              editEntryId: e.id,
              mode: debtMode,
              defaultDebtAccountId: debtAccountIdForEdit,
              defaultCashAccountId: cashAccountIdForEdit,
              defaultLoanFundingMode: e.source === "debt_financed_purchase" ? "financed_purchase" : "cash_disbursement",
              defaultDate: dateStr,
              defaultPrincipal: debtPrincipalAmount,
              defaultInterest: debtInterestAmount,
              defaultPenalty: debtFeeAmount,
              defaultPrepayStrategy: e.source === "debt_prepay_out"
                ? parseLoanPrepayStrategy(e.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
                : undefined,
            },
          }
        : undefined;

    if (balanceReconcileEditEvent || debtEditEvent) return { customEditEvent: balanceReconcileEditEvent ?? debtEditEvent };
    return { edit: e.type === "investment" ? investmentEditPayload : buildBasicEntryEditPayload(e) };
  }, [accountOptionById, allowInvestmentEdit, investmentProductTypeByAccountId, linkedInvestmentCandidateEntries]);
  const colorScheme =
    typeof document === "undefined"
      ? "red_up_green_down"
      : getColorSchemeFromCookie(document.cookie ?? null);
  const inflowCls = pnlColor(1, colorScheme);
  const outflowCls = pnlColor(-1, colorScheme);
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const detailRefreshSeqRef = useRef(0);
  const lastResetKeyRef = useRef<string | undefined>(resetKey);

  const persistEntryReorder = useCallback(async (payload: { entryId: string; targetEntryId: string; targetPosition: AdvancedDataTableDropPosition }) => {
    const res = await fetch("/api/v1/transactions/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, accountIds: reorderAccountIds, ...payload }),
    });
    const data = (await res.json().catch(() => null)) as ReorderResponse | null;
    if (!data?.ok) {
      throw new Error(data?.error ?? "调整顺序失败");
    }
    return data;
  }, [accountId, reorderAccountIds]);

  const canDropDetailEntry = useCallback((source: DetailEntry, target: DetailEntry, position?: AdvancedDataTableDropPosition) => {
    void position;
    return (
    canManuallyReorderDetailEntry(source) &&
    canManuallyReorderDetailEntry(target) &&
    detailEntryDayKey(source, accountId) === detailEntryDayKey(target, accountId)
    );
  }, [accountId]);

  const reorderEntryByDrag = useCallback(async (source: DetailEntry, target: DetailEntry, position: AdvancedDataTableDropPosition) => {
    if (source.id === target.id) return;
    if (!canManuallyReorderDetailEntry(source) || !canManuallyReorderDetailEntry(target)) return;
    if (detailEntryDayKey(source, accountId) !== detailEntryDayKey(target, accountId)) {
      window.alert("只能在同一天记录内拖动调整顺序");
      return;
    }
    if (!canDropDetailEntry(source, target, position)) return;
    const previousEntries = entries;
    const nextEntries = reorderEntriesToTarget(entries, source.id, target.id, position);
    if (nextEntries === entries) return;
    detailRefreshSeqRef.current += 1;
    setRefreshedEntries({ accountId, entries: nextEntries });
    try {
      const data = await persistEntryReorder({ entryId: source.id, targetEntryId: target.id, targetPosition: position });
      if (data.orderedEntryIds?.length || data.runningBalances) {
        setRefreshedEntries((current) => {
          const currentEntries = current?.accountId === accountId ? current.entries : nextEntries;
          const orderedEntries = applyServerEntryOrder(currentEntries, data.orderedEntryIds ?? []);
          return { accountId, entries: applyServerRunningBalances(orderedEntries, data.runningBalances) };
        });
      }
    } catch (error) {
      setRefreshedEntries({ accountId, entries: previousEntries });
      window.alert(error instanceof Error ? error.message : "调整顺序失败");
    }
  }, [accountId, canDropDetailEntry, entries, persistEntryReorder]);

  useEffect(() => {
    setRefreshedEntries((current) => (current?.accountId === accountId ? current : null));
  }, [accountId]);

  useEffect(() => {
    if (resetKey == null) return;
    if (lastResetKeyRef.current === resetKey) return;
    lastResetKeyRef.current = resetKey;
    setRefreshedEntries(null);
    setSelection(new Set());
  }, [resetKey, setSelection]);

  // Listen for financial data changes → re-fetch from detail API
  useEffect(() => {
    if (!refreshOnGlobalEvent) return;
    const handler = (event: Event) => {
      const deletedEntryIds = (event as CustomEvent<{ deletedEntryIds?: string[] }>).detail?.deletedEntryIds ?? [];
      if (deletedEntryIds.length > 0) {
        const deletedSet = new Set(deletedEntryIds);
        detailRefreshSeqRef.current += 1;
        setRefreshedEntries((current) => {
          const currentEntries = current?.accountId === accountId ? current.entries : entries;
          return { accountId, entries: removeEntriesAndUpdateRunningBalances(currentEntries, deletedSet, accountId) };
        });
        setSelection(new Set());
        return;
      }
      const url = new URL(window.location.href);
      const storedPagination = readDetailPaginationSnapshot(accountId);
      const detailAll = url.searchParams.has("detailAll")
        ? url.searchParams.get("detailAll") === "1"
        : storedPagination?.detailAll ?? false;
      const detailPage = normalizeDetailPage(
        url.searchParams.get("detailPage") ?? storedPagination?.detailPage ?? 1,
      );
      const pageSize = normalizeDetailPageSize(
        url.searchParams.get("pageSize") ?? storedPagination?.pageSize ?? 20,
      );
      const params = new URLSearchParams({
        accountId,
        page: detailAll ? "1" : String(detailPage),
        pageSize: detailAll ? "5000" : String(pageSize),
      });
      const seq = ++detailRefreshSeqRef.current;
      fetch(`/api/v1/transactions/detail?${params.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (seq !== detailRefreshSeqRef.current) return;
          if (data?.ok && Array.isArray(data?.data?.entries)) {
            setRefreshedEntries({ accountId, entries: data.data.entries });
            setSelection(new Set());
          }
        })
        .catch(() => {});
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    window.addEventListener(LEGACY_FINANCE_REFRESH_EVENT, handler);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
      window.removeEventListener(LEGACY_FINANCE_REFRESH_EVENT, handler);
    };
  }, [accountId, entries, refreshOnGlobalEvent, setSelection]);

  const columns = useMemo<AdvancedDataTableColumn<DetailEntry>[]>(() => [
    {
      key: "date",
      label: t("detail.column.date"),
      width: 96,
      minWidth: 78,
      filterKind: "dateRange",
      filterText: (e) => (e.date ?? "").slice(0, 10),
      render: (e) => <span className="tabular-nums text-slate-600">{(e.date ?? "").slice(0, 10)}</span>,
    },
    ...(showAccountColumn ? [{
      key: "account",
      label: accountColumnLabel,
      width: accountColumnMode === "cardLast4" ? 82 : 190,
      minWidth: accountColumnMode === "cardLast4" ? 64 : 110,
      hideable: true,
      defaultHidden: accountColumnDefaultHidden,
      filterText: (e: DetailEntry) => accountColumnDisplayFallback(e).label,
      filterTitle: (e: DetailEntry) => accountColumnDisplayFallback(e).title,
      filterSearchText: (e: DetailEntry) => {
        const option = accountColumnDisplayFallback(e);
        return [option.label, option.title, e.accountName, e.toAccountName].filter(Boolean).join(" ");
      },
      render: (e: DetailEntry) => {
        const option = accountColumnDisplayFallback(e);
        const text = option.label;
        const title = option.title;
        return renderNavigableAccountLabel(e, option.id, text, title, "block truncate text-slate-600");
      },
    } satisfies AdvancedDataTableColumn<DetailEntry>] : []),
    {
      key: "postedAt",
      label: t("detail.column.postedAt"),
      width: 132,
      minWidth: 110,
      hideable: true,
      filterKind: "dateRange",
      filterText: (e) => (e.postedAt ?? "").slice(0, 10),
      render: (e) => (
        <span className="tabular-nums text-slate-500">
          {e.postedAt ? e.postedAt.slice(0, 10) : ""}
        </span>
      ),
    },
    {
      key: "inflow",
      label: t("detail.column.inflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      filterText: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount > 0 ? t("detail.column.inflow") : "";
      },
      sortValue: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount > 0 ? amount : null;
      },
      render: (e) => {
        const effectiveAmount = effectiveAmountForAccount(e, accountId);
        const inflow = effectiveAmount > 0 ? effectiveAmount : null;
        return <span className={`tabular-nums ${inflow !== null ? inflowCls : "text-slate-700"}`}>{inflow !== null ? formatMoney(inflow) : ""}</span>;
      },
    },
    {
      key: "outflow",
      label: t("detail.column.outflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      filterText: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount < 0 ? t("detail.column.outflow") : "";
      },
      sortValue: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount < 0 ? -amount : null;
      },
      render: (e) => {
        const effectiveAmount = effectiveAmountForAccount(e, accountId);
        const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
        return <span className={`tabular-nums ${outflow !== null ? outflowCls : "text-slate-700"}`}>{outflow !== null ? formatMoney(outflow) : ""}</span>;
      },
    },
    {
      key: "type",
      label: "收支大类",
      width: 96,
      minWidth: 74,
      filterText: (e) => {
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        if (isDebtActivityEntry(e, accountOptionById)) return t("transaction.type.transfer");
        if (e.type === "investment") return "投资";
        const balanceTarget = getBalanceReconcileTarget(e);
        return activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
      },
      render: (e) => {
        const isDebtActivity = isDebtActivityEntry(e, accountOptionById);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const balanceTarget = getBalanceReconcileTarget(e);
        const actLabel = isDebtActivity
          ? t("transaction.type.transfer")
          : e.type === "investment"
          ? "投资"
          : activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
        return (
          <>
            {balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE ? (
              <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600">
                初始
              </span>
            ) : e.source === BALANCE_RECONCILE_SOURCE ? (
              <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700">
                校准
              </span>
            ) : (
              <span className="text-xs text-slate-700">{actLabel}</span>
            )}
          </>
        );
      },
    },
    {
      key: "category",
      label: t("detail.column.category"),
      width: 140,
      minWidth: 90,
      filterText: (e) => {
        const debtLabel = debtCategoryLabel(e, accountOptionById);
        if (debtLabel) return debtLabel;
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        return e.type === "investment"
          ? investmentCategoryLabel(e, entryFundProductType)
          : isCreditCardRepaymentDisplayEntry(e)
            ? t("transaction.category.creditCardRepayment")
          : getInsuranceDetailCategoryName(e);
      },
      render: (e) => {
        const debtLabel = debtCategoryLabel(e, accountOptionById);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const text = debtLabel ?? (e.type === "investment"
          ? investmentCategoryLabel(e, entryFundProductType)
          : isCreditCardRepaymentDisplayEntry(e)
            ? t("transaction.category.creditCardRepayment")
          : getInsuranceDetailCategoryName(e));
        return <span className="block truncate text-slate-500" title={text}>{text || <span className="text-slate-300">-</span>}</span>;
      },
    },
    {
      key: "counterpartyInstitution",
      label: t("detail.column.counterparty"),
      width: 140,
      minWidth: 96,
      hideable: true,
      defaultHidden: true,
      filterText: (e) => e.counterpartyInstitutionName ?? "",
      render: (e) => <span className="block truncate text-slate-500" title={e.counterpartyInstitutionName ?? ""}>{e.counterpartyInstitutionName || <span className="text-slate-300">-</span>}</span>,
    },
    {
      key: "related",
      label: t("detail.column.relatedAccount"),
      width: 190,
      minWidth: 100,
      hideable: true,
      defaultHidden: relatedAccountDefaultHidden,
      filterText: (e) => {
        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccount = accountDisplayFallback(e.accountId, e.accountName);
        const targetAccount = e.toAccountId ? accountDisplayFallback(e.toAccountId, e.toAccountName) : null;
        return isToAccount ? sourceAccount.label : targetAccount?.label ?? "";
      },
      filterTitle: (e) => {
        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccount = accountDisplayFallback(e.accountId, e.accountName);
        const targetAccount = e.toAccountId ? accountDisplayFallback(e.toAccountId, e.toAccountName) : null;
        return isToAccount ? sourceAccount.title : targetAccount?.title ?? "";
      },
      filterSearchText: (e) => {
        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccount = accountDisplayFallback(e.accountId, e.accountName);
        const targetAccount = e.toAccountId ? accountDisplayFallback(e.toAccountId, e.toAccountName) : null;
        const selected = isToAccount ? sourceAccount : targetAccount;
        return [
          selected?.label,
          selected?.title,
          isToAccount ? e.accountName : e.toAccountName,
        ].filter(Boolean).join(" ");
      },
      render: (e) => {
        const isToAccount = !!accountId && e.toAccountId === accountId;
        const sourceAccount = accountDisplayFallback(e.accountId, e.accountName);
        const targetAccount = e.toAccountId ? accountDisplayFallback(e.toAccountId, e.toAccountName) : null;
        const sourceAccountLabel = sourceAccount.label;
        const targetAccountLabel = targetAccount?.label ?? null;
        const relatedAccountLabel = isToAccount ? sourceAccountLabel : targetAccountLabel;
        const relatedAccountTitle = isToAccount ? sourceAccount.title : targetAccount?.title ?? "";
        const relatedAccountId = isToAccount ? e.accountId : e.toAccountId;
        return renderNavigableAccountLabel(e, relatedAccountId, relatedAccountLabel, relatedAccountTitle, "block truncate text-slate-500");
      },
    },
    ...(showRunningBalance ? [{
      key: "balance",
      label: t("detail.column.balance"),
      width: 110,
      minWidth: 82,
      align: "right" as const,
      hideable: true,
      defaultHidden: runningBalanceDefaultHidden,
      render: (e: DetailEntry) => <span className="text-xs tabular-nums text-slate-700">{e.runningBalance != null ? formatMoney(toNumber(e.runningBalance)) : ""}</span>,
    } satisfies AdvancedDataTableColumn<DetailEntry>] : []),
    {
      key: "tags",
      label: t("detail.column.tags"),
      width: 150,
      minWidth: 90,
      hideable: true,
      filterText: (e) => e.entryTags?.map((et) => et.Tag?.name ?? "").join(" ") ?? "",
      render: (e) => e.entryTags && e.entryTags.length > 0 ? (
        <span className="inline-flex flex-wrap gap-0.5">
          {e.entryTags.map((et) => {
            const c = et.Tag?.color || "#3B82F6";
            return (
              <span
                key={et.tagId}
                className="rounded-full border px-1 py-0.5 text-[10px] leading-none"
                style={{ backgroundColor: c + "18", color: c, borderColor: c + "60" }}
              >
                {et.Tag?.name}
              </span>
            );
          })}
        </span>
      ) : null,
    },
    {
      key: "remark",
      label: t("detail.column.remark"),
      width: 220,
      minWidth: 120,
      hideable: true,
      filterText: (e) => displayDetailRemark(e, accountId),
      render: (e) => {
        const text = displayDetailRemark(e, accountId);
        return <span className="block truncate text-slate-500" title={text}>{text}</span>;
      },
    },
    { key: "attachment", label: t("detail.column.attachment"), width: 60, minWidth: 46, align: "center", hideable: true, render: () => <span className="text-slate-400" /> },
  ], [accountColumnDefaultHidden, accountColumnDisplayFallback, accountColumnLabel, accountColumnMode, accountDisplayFallback, accountId, accountOptionById, inflowCls, investmentProductTypeByAccountId, outflowCls, relatedAccountDefaultHidden, renderNavigableAccountLabel, runningBalanceDefaultHidden, showAccountColumn, showRunningBalance, t]);

  const customToolbarLeft = toolbarMode === "custom" ? (
    <div className="flex min-w-0 items-center gap-2">
      {toolbarTitle ? <div className="text-sm font-semibold text-slate-800">{toolbarTitle}</div> : null}
      {selectedCount > 0 ? <span className="text-xs text-slate-500">{tf("detail.selectedCount", { count: selectedCount })}</span> : null}
      {selectedCount > 0 ? <BasicDetailBatchReplaceButton accountOptions={accountOptions} categoryOptions={categoryOptions} contextAccountId={accountId} /> : null}
      {selectedCount > 0 ? <BasicDetailBatchDeleteButton /> : null}
    </div>
  ) : undefined;
  const tableResetKey = resetKey ?? `${accountId}:detail-table`;
  const mobileGroups = useMemo(() => {
    const groups: Array<{ date: string; entries: DetailEntry[] }> = [];
    for (const entry of entries) {
      const date = (entry.date ?? "").slice(0, 10) || "未设置日期";
      const current = groups[groups.length - 1];
      if (current?.date === date) current.entries.push(entry);
      else groups.push({ date, entries: [entry] });
    }
    return groups;
  }, [entries]);

  return (
    <>
    <div className="h-full overflow-y-auto bg-slate-100 md:hidden">
      {mobileGroups.length > 0 ? (
        <div className="pb-4">
          {mobileGroups.map((group, groupIndex) => (
            <section key={`${group.date}:${group.entries[0]?.id ?? groupIndex}`}>
              <div className="sticky top-0 z-10 border-y border-slate-200 bg-slate-100/96 px-3 py-1.5 text-xs font-semibold text-slate-500 backdrop-blur">
                {group.date}
              </div>
              <div className="divide-y divide-slate-100 bg-white">
                {group.entries.map((entry) => {
                  const effectiveAmount = effectiveAmountForAccount(entry, accountId);
                  const entryFundProductType =
                    entry.fundProductType ??
                    (entry.toAccountId ? investmentProductTypeByAccountId[entry.toAccountId] : undefined) ??
                    (entry.accountId ? investmentProductTypeByAccountId[entry.accountId] : undefined) ??
                    null;
                  const category = (
                    debtCategoryLabel(entry, accountOptionById) ?? (entry.type === "investment"
                      ? investmentCategoryLabel(entry, entryFundProductType)
                      : getInsuranceDetailCategoryName(entry))
                  ) || "未分类";
                  const note = displayDetailRemark(entry, accountId);
                  const counterpart = entry.type === "transfer"
                    ? (entry.accountId === accountId ? entry.toAccountName : entry.accountName)
                    : entry.fundName || note;
                  const { edit, customEditEvent } = buildEntryEditRequest(entry);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        if (!edit && !customEditEvent) return;
                        dispatchEntryEdit({ entryId: entry.id, edit, customEditEvent });
                      }}
                      className="flex min-h-[68px] w-full items-center gap-3 px-3 py-2.5 text-left"
                    >
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${effectiveAmount >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                        {entry.type === "transfer" ? "转" : entry.type === "investment" ? "投" : effectiveAmount >= 0 ? "收" : "支"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-900">{category}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{counterpart || note || "无备注"}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-sm font-semibold tabular-nums ${effectiveAmount >= 0 ? inflowCls : outflowCls}`}>
                          {effectiveAmount >= 0 ? "+" : "-"}{formatMoney(Math.abs(effectiveAmount))}
                        </span>
                        {showRunningBalance && entry.runningBalance != null ? (
                          <span className="mt-0.5 block text-[11px] tabular-nums text-slate-400">余额 {formatMoney(toNumber(entry.runningBalance))}</span>
                        ) : null}
                      </span>
                      <span className="text-slate-300">›</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-slate-400">{emptyText === "暂无记录" ? t("detail.empty") : emptyText}</div>
      )}
    </div>
    <div className="hidden h-full md:block">
    <AdvancedDataTable
      storageKey={storageKey}
      resetKey={tableResetKey}
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1160}
      emptyText={emptyText === "暂无记录" ? t("detail.empty") : emptyText}
      selectable
      selectOnRowClick
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      onRowDoubleClick={(entry) => {
        const { edit, customEditEvent } = buildEntryEditRequest(entry);
        if (!edit && !customEditEvent) return;
        dispatchEntryEdit({ entryId: entry.id, edit, customEditEvent });
      }}
      draggableRows={draggableRows}
      rowDragDisabled={(entry) => !canManuallyReorderDetailEntry(entry)}
      rowDropAllowed={(source, target, _sourceIndex, _targetIndex, position) => canDropDetailEntry(source, target, position)}
      onRowReorder={(source, target, _sourceIndex, _targetIndex, position) => reorderEntryByDrag(source, target, position)}
      rowActions={(entry) => {
        const { edit, customEditEvent } = buildEntryEditRequest(entry);
        const linkLabels = entry.businessLinkLabels ?? [];
        const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
        const linkTitle = hasBusinessLink
          ? `已关联：${linkLabels.join("、") || "业务记录"}`
          : "未关联，点击建立资金侧关联";
        return (
          <>
            {shouldShowBusinessLinkStatus(entry) ? (
              <BusinessLinkActionButton
                active={hasBusinessLink}
                title={linkTitle}
                busy={linkingIds.has(entry.id)}
                onClick={() => linkDetailCashFlow(entry)}
              />
            ) : null}
            <EntryRowActions
              entryId={entry.id}
              edit={edit}
              customEditEvent={customEditEvent}
            />
          </>
        );
      }}
      rowActionsWidth={112}
      rowActionsMinWidth={92}
      batchActionSlot={toolbarMode === "default" ? (
        <>
          <BasicDetailBatchReplaceButton accountOptions={accountOptions} categoryOptions={categoryOptions} contextAccountId={accountId} />
          <BasicDetailBatchDeleteButton />
        </>
      ) : undefined}
      rowClassName={(entry) => entry.id === focusEntryId
        ? "bg-amber-50 ring-1 ring-inset ring-amber-300 hover:bg-amber-50"
        : "hover:bg-blue-50/40"}
      fillHeight
      compactRows={compactRows}
      toolbarMode={toolbarMode}
      toolbarLeftContent={customToolbarLeft}
      toolbarRightContent={toolbarRightContent}
      sortable={sortable}
    />
    </div>
    </>
  );
}
