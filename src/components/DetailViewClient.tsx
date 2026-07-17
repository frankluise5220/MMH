"use client";

import { useCallback, useState, useEffect, useMemo, useRef, type ReactNode } from "react";
import { toNumber } from "@/lib/date-utils";
import { formatMoney } from "@/lib/format";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { dispatchEntryEdit, EntryRowActions, type EditPayload } from "./EntryRowActions";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableDropPosition } from "./AdvancedDataTable";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchReplaceButton,
  type BasicDetailBatchCategoryOption,
  useBasicDetailSelection,
} from "./BasicDetailSelection";
import { useI18n } from "@/lib/i18n";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, effectiveAmountForAccount, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT, LEGACY_FINANCE_REFRESH_EVENT } from "@/lib/client/refresh";
import { isCreditCardRepaymentTransfer } from "@/lib/transaction-semantics";
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
  accountInstitutionName?: string | null;
  counterpartyInstitutionId?: string | null;
  counterpartyInstitutionName?: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
  toAccountInstitutionName?: string | null;
  note: string | null;
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

function buildBasicEntryEditPayload(entry: DetailEntry) {
  return {
    id: entry.id,
    transactionId: entry.id,
    date: (entry.date ?? "").slice(0, 10),
    postedAt: entry.postedAt ?? null,
    type: (entry.source === "advance" ? "advance" : entry.type) as EditPayload["type"],
    amount: toNumber(entry.amount),
    note: entry.note ?? "",
    toNote: entry.toNote ?? "",
    categoryId: entry.categoryId ?? undefined,
    categoryName: entry.categoryName ?? undefined,
    accountId: entry.accountId ?? undefined,
    accountName: entry.accountName ?? undefined,
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? undefined,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? undefined,
    fromAccountId: entry.type === "transfer" ? entry.accountId ?? undefined : undefined,
    toAccountId: entry.toAccountId ?? undefined,
    toAccountName: entry.toAccountName ?? undefined,
    tagIds: entry.entryTags?.map((item) => item.tagId) ?? [],
  };
}

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type DetailAccountOption = { id: string; label: string; fullLabel?: string | null; title?: string | null; kind?: string | null; debtDirection?: string | null };

/* Helpers */

function BusinessLinkHeaderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="mx-auto h-3.5 w-3.5">
      <path
        d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function BusinessLinkStatusIcon({ active, title }: { active: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={[
        "inline-flex h-4 w-4 items-center justify-center rounded-full border",
        active
          ? "border-sky-300 bg-sky-100 text-sky-700 shadow-[0_0_0_2px_rgba(14,165,233,0.08)]"
          : "border-slate-200 bg-transparent text-slate-300",
      ].join(" ")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-2.5 w-2.5">
        <path
          d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    </span>
  );
}

function shouldShowBusinessLinkStatus(entry: DetailEntry) {
  return entry.type === "investment";
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

function debtActivityLabel(entry: {
  type: string;
  source: string | null;
  note: string | null;
  accountKind?: string | null;
  accountDebtDirection?: string | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
}) {
  const source = String(entry.source ?? "");
  if (source === "debt_borrow_in") return "借入";
  if (source === "debt_financed_purchase") return "消费分期";
  if (source === "debt_lend_out") return "借出";
  if (source === "debt_prepay_out") return "提前还款";
  if (source === "debt_collect_in") return "收回";
  if (source === "scheduled_task" && String(entry.note ?? "").includes("还贷款")) return "贷款还款";
  if (source === "debt_repay_out") return "还款";
  if (inferDebtMode(entry)) return "往来款";
  return null;
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
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
}, accountById?: Map<string, DetailAccountOption>) {
  if (entry.type !== "transfer") return false;
  return inferDebtMode(entry, accountById) != null;
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

type ReorderResponse = {
  ok?: boolean;
  changed?: boolean;
  orderedEntryIds?: string[];
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
  showRunningBalance = true,
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
  showRunningBalance?: boolean;
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
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const [refreshedEntries, setRefreshedEntries] = useState<{ accountId: string; entries: DetailEntry[] } | null>(null);
  const entries = refreshedEntries?.accountId === accountId ? refreshedEntries.entries : initialEntries;
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
    const entryFundProductType =
      e.fundProductType ??
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
            date: dateStr,
            confirmDate: e.fundConfirmDate?.slice(0, 10),
            type: e.type,
            amount,
            note: e.note ?? "",
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
    const debtPrincipalAmount = Math.abs(toNumber(e.debtPrincipalAmount ?? e.amount));
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
      body: JSON.stringify({ accountId, ...payload }),
    });
    const data = (await res.json().catch(() => null)) as ReorderResponse | null;
    if (!data?.ok) {
      throw new Error(data?.error ?? "调整顺序失败");
    }
    return data;
  }, [accountId]);

  const canDropDetailEntry = useCallback((source: DetailEntry, target: DetailEntry, position: AdvancedDataTableDropPosition) => (
    canManuallyReorderDetailEntry(source) &&
    canManuallyReorderDetailEntry(target) &&
    detailEntryDayKey(source, accountId) === detailEntryDayKey(target, accountId) &&
    reorderEntriesToTarget(entries, source.id, target.id, position) !== entries
  ), [accountId, entries]);

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
      if (data.orderedEntryIds?.length) {
        setRefreshedEntries((current) => {
          const currentEntries = current?.accountId === accountId ? current.entries : nextEntries;
          return { accountId, entries: applyServerEntryOrder(currentEntries, data.orderedEntryIds ?? []) };
        });
      }
      dispatchFinanceDataChanged({ reason: "entry-reorder", accountIds: [accountId], entryIds: [source.id] });
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
        setRefreshedEntries({ accountId, entries: entries.filter((entry) => !deletedSet.has(entry.id)) });
        setSelection(new Set());
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
        const debtLabel = debtActivityLabel(e);
        if (debtLabel) return t("transaction.type.transfer");
        if (e.type === "investment") return "投资";
        const balanceTarget = getBalanceReconcileTarget(e);
        return activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
      },
      render: (e) => {
        const debtLabel = debtActivityLabel(e);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const balanceTarget = getBalanceReconcileTarget(e);
        const actLabel = debtLabel
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
        const debtLabel = debtActivityLabel(e);
        if (debtLabel) return debtLabel;
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        return e.type === "investment"
          ? investmentCategoryLabel(e, entryFundProductType)
          : isCreditCardRepaymentTransfer(e)
            ? t("transaction.category.creditCardRepayment")
          : getInsuranceDetailCategoryName(e);
      },
      render: (e) => {
        const debtLabel = debtActivityLabel(e);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const text = debtLabel ?? (e.type === "investment"
          ? investmentCategoryLabel(e, entryFundProductType)
          : isCreditCardRepaymentTransfer(e)
            ? t("transaction.category.creditCardRepayment")
          : getInsuranceDetailCategoryName(e));
        return <span className="block truncate text-slate-500" title={text}>{text || <span className="text-slate-300">-</span>}</span>;
      },
    },
    ...(showAccountColumn ? [{
      key: "account",
      label: "账户",
      width: 190,
      minWidth: 110,
      filterText: (e: DetailEntry) => accountDisplayFallback(e.accountId, e.accountName).label,
      filterTitle: (e: DetailEntry) => accountDisplayFallback(e.accountId, e.accountName).title,
      filterSearchText: (e: DetailEntry) => {
        const option = accountDisplayFallback(e.accountId, e.accountName);
        return [option.label, option.title, e.accountName].filter(Boolean).join(" ");
      },
      render: (e: DetailEntry) => {
        const option = accountDisplayFallback(e.accountId, e.accountName);
        const text = option.label;
        const title = option.title;
        return <span className="block truncate text-slate-600" title={title}>{text || <span className="text-slate-300">-</span>}</span>;
      },
    } satisfies AdvancedDataTableColumn<DetailEntry>] : []),
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
        return <span className="block truncate text-slate-500" title={relatedAccountTitle}>{relatedAccountLabel ?? <span className="text-slate-300">-</span>}</span>;
      },
    },
    ...(showRunningBalance ? [{
      key: "balance",
      label: t("detail.column.balance"),
      width: 110,
      minWidth: 82,
      align: "right" as const,
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
    {
      key: "actions",
      label: t("detail.column.actions"),
      width: 110,
      minWidth: 90,
      align: "right",
      render: (e) => {
        const { edit, customEditEvent } = buildEntryEditRequest(e);

        return (
          <div className="flex justify-end items-center gap-1" onClick={(event) => event.stopPropagation()}>
            {(shouldShowBusinessLinkStatus(e)) ? (() => { const linkLabels = e.businessLinkLabels ?? []; const hasBusinessLink = (e.businessLinkCount ?? 0) > 0; const title = hasBusinessLink ? `已关联：${linkLabels.join("、") || "业务记录"}` : "未关联业务记录"; return <BusinessLinkStatusIcon active={hasBusinessLink} title={title} />; })() : null}
            <EntryRowActions
              entryId={e.id}
              edit={edit}
              customEditEvent={customEditEvent}
            />
          </div>
        );
      },
    },
  ], [accountDisplayFallback, accountId, buildEntryEditRequest, inflowCls, outflowCls, showAccountColumn, showRunningBalance, t]);

  const customToolbarLeft = toolbarMode === "custom" ? (
    <div className="flex min-w-0 items-center gap-2">
      {toolbarTitle ? <div className="text-sm font-semibold text-slate-800">{toolbarTitle}</div> : null}
      {selectedCount > 0 ? <span className="text-xs text-slate-500">{tf("detail.selectedCount", { count: selectedCount })}</span> : null}
      {selectedCount > 0 ? <BasicDetailBatchReplaceButton accountOptions={accountOptions} categoryOptions={categoryOptions} contextAccountId={accountId} /> : null}
      {selectedCount > 0 ? <BasicDetailBatchDeleteButton /> : null}
    </div>
  ) : undefined;
  const tableResetKey = resetKey ?? `${accountId}:detail-table`;
  return (
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
      batchActionSlot={toolbarMode === "default" ? (
        <>
          <BasicDetailBatchReplaceButton accountOptions={accountOptions} categoryOptions={categoryOptions} contextAccountId={accountId} />
          <BasicDetailBatchDeleteButton />
        </>
      ) : undefined}
      rowClassName={() => "hover:bg-blue-50/40"}
      fillHeight
      compactRows={compactRows}
      toolbarMode={toolbarMode}
      toolbarLeftContent={customToolbarLeft}
      toolbarRightContent={toolbarRightContent}
    />
  );
}
