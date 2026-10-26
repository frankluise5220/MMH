"use client";

import { useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type MouseEvent } from "react";
import { Paperclip } from "lucide-react";
import { formatDateDisplay, formatDateUtc as localDateKey, toNumber, todayDateBusinessYmd } from "@/lib/date-utils";
import { formatCurrencyMoney } from "@/lib/format";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { dispatchEntryEdit, EntryRowActions, type EditPayload } from "./EntryRowActions";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableDropPosition } from "./AdvancedDataTable";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import { EntryAttachmentWindow } from "./EntryAttachmentWindow";
import { BasicDetailBatchDeleteButton,
  BasicDetailBatchReconcileButton,
  BasicDetailBatchReplaceButton,
  BasicDetailReconcileLockButton,
  type BasicDetailBatchCategoryOption,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
} from "./BasicDetailSelection";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { useI18n } from "@/lib/i18n";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, effectiveAmountForAccount, getBalanceReconcileTarget, isReconciledEntry } from "@/lib/balance-reconcile";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate, getDetailEntryTradeDate } from "@/lib/detail-entry-order";
import { removeEntriesAndUpdateRunningBalances } from "@/lib/detail-running-balance";
import { rebaseRunningBalancesAfterSameDayReorder, startOfDayRunningBalanceSeed } from "@/lib/entry-reorder";
import { buildLiabilityActivityEditEvent, inferLiabilityMode, isLiabilityActivityEntry, type LiabilityMode } from "@/lib/liability-entry-edit";
import { resolveAccountProductType, resolveEntryProductType, toBusinessLinkType } from "@/lib/entry-product-type";
import { parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { withBasePath } from "@/lib/base-path";
import {
  ENTRY_ORIGIN_AI_IMPORT,
  ENTRY_ORIGIN_EMAIL_IMPORT,
  ENTRY_ORIGIN_EXCEL_IMPORT,
  ENTRY_ORIGIN_MANUAL,
  ENTRY_ORIGIN_SCHEDULED_TASK,
  isCreditCardRepaymentTransfer,
  isFundBuyRefundCashLeg,
  isLicensedInsuranceEntry,
  isRegularInvestRefundEntry,
  TRANSACTION_SOURCE_INSURANCE,
} from "@/lib/transaction-semantics";
import { normalizeSettlementTransferCategoryName } from "@/lib/settlement-category-name";
import { advanceDialogAmount } from "@/lib/advance-transfer";
import {
  normalizeDetailPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
} from "@/lib/detail-pagination-preference";
import { parseImportAccountId } from "@/lib/account-import-match";
import { formatAccountTableLabel, formatAccountTableTitle } from "@/lib/account-display";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { APP_PREFS_EVENT, getDateDisplayFormatPreference, getDetailDateBackgroundPreference, getTimeZonePreference, type DateDisplayFormat } from "@/lib/client/appPreferences";
import { readAccountDisplaySettings } from "@/lib/client/account-display-settings";
import { cashLedgerFlowAccountId, isAllCashDetailScope } from "@/lib/all-cash-entries";

const LEGACY_BASIC_DETAIL_STORAGE_KEY = "mmh_basic_detail_table_v1";

function basicDetailTableStorageKey(accountId: string) {
  return `${LEGACY_BASIC_DETAIL_STORAGE_KEY}:${accountId || "none"}`;
}

/** Copy shared column widths/hidden columns onto the per-account key once. Sort/filters stay per-account. */
function migrateLegacyBasicDetailLayout(storageKey: string) {
  if (typeof window === "undefined") return;
  if (!storageKey.startsWith(`${LEGACY_BASIC_DETAIL_STORAGE_KEY}:`)) return;
  const marker = `${storageKey}:layout-migrated`;
  try {
    if (window.localStorage.getItem(marker) === "1") return;
    for (const suffix of [":widths", ":hidden:v2", ":hidden"] as const) {
      const dest = `${storageKey}${suffix}`;
      if (window.localStorage.getItem(dest) != null) continue;
      const src = window.localStorage.getItem(`${LEGACY_BASIC_DETAIL_STORAGE_KEY}${suffix}`);
      if (src != null) window.localStorage.setItem(dest, src);
    }
    window.localStorage.setItem(marker, "1");
  } catch {
    // localStorage may be unavailable; table still works with defaults.
  }
}

/**
 * 「全部收支记录」的「已实现收益」列默认可见。
 *
 * 列定义里 `defaultHidden: false` 只对没有存档的浏览器生效；老存档（该列上线初期
 * 被隐藏过 / 用户手动隐藏过）会一直压着它。这里按 scope 一次性把指定列从隐藏存档
 * 里剔除，之后用户再隐藏照常生效（marker 保证只跑一次）。
 */
function promoteDefaultVisibleColumns(storageKey: string, keys: readonly string[]) {
  if (typeof window === "undefined") return;
  if (!storageKey.startsWith(`${LEGACY_BASIC_DETAIL_STORAGE_KEY}:`)) return;
  const hiddenKey = `${storageKey}:hidden:v2`;
  const marker = `${storageKey}:default-visible-promoted`;
  try {
    if (window.localStorage.getItem(marker) === "1") return;
    const raw = window.localStorage.getItem(hiddenKey);
    if (raw != null) {
      const hidden = JSON.parse(raw);
      if (Array.isArray(hidden)) {
        const next = hidden.filter((key) => !keys.includes(key));
        if (next.length !== hidden.length) {
          window.localStorage.setItem(hiddenKey, JSON.stringify(next));
        }
      }
    }
    window.localStorage.setItem(marker, "1");
  } catch {
    // localStorage may be unavailable; table still works with defaults.
  }
}

/** 审计列「创建来源」：TxRecord.entryOrigin 的取值 → i18n key。 */
const ENTRY_ORIGIN_LABEL_KEYS: Record<string, string> = {
  [ENTRY_ORIGIN_MANUAL]: "detail.entryOrigin.manual",
  [ENTRY_ORIGIN_AI_IMPORT]: "detail.entryOrigin.ai_import",
  [ENTRY_ORIGIN_EXCEL_IMPORT]: "detail.entryOrigin.excel_import",
  [ENTRY_ORIGIN_SCHEDULED_TASK]: "detail.entryOrigin.scheduled_task",
  [ENTRY_ORIGIN_EMAIL_IMPORT]: "detail.entryOrigin.email_import",
};

/** 空值按「手工录入」（DB 默认值）处理；未知取值直接显示原始标记，避免误标成手工。 */
function entryOriginDisplayLabel(
  origin: string | null | undefined,
  t: (key: string) => string,
): string {
  const raw = origin?.trim() || ENTRY_ORIGIN_MANUAL;
  const key = ENTRY_ORIGIN_LABEL_KEYS[raw];
  return key ? t(key) : raw;
}

/**
 * 审计时间（创建 / 最后修改）：日期部分跟随用户的日期显示格式，再补上本地时分秒，
 * 便于区分同一天内的多次修改。无值或无法解析时返回空串。
 */
function formatEntryAuditTimestamp(
  value: string | null | undefined,
  format: DateDisplayFormat,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return formatDateDisplay(value, format);
  // 纯日期串（没有时间部分）沿用字符串口径，避免 UTC 解析造成日期偏移。
  if (!/[T\s]\d{1,2}:\d{2}/.test(raw)) return formatDateDisplay(value, format);
  const dateText = formatDateDisplay(date, format);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${dateText} ${hh}:${mm}:${ss}`;
}

/**
 * 审计列（创建时间 / 最后修改时间）的筛选与排序键：本地 `YYYY-MM-DD HH:mm:ss`。
 *
 * 刻意不跟随用户的日期显示格式：列筛选是按字符串比较的（`dateRange` 取前 10 位当日期比较），
 * 显示格式换成 `2026/10/21` 之后就比不出大小；排序同理，需要定长、可直接比较的键。
 */
function entryAuditSortKey(value: string | Date | null | undefined): string {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(String(value).trim());
  if (!Number.isFinite(date.getTime())) return String(value);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${localDateKey(date)} ${hh}:${mm}:${ss}`;
}

/* Types */

export type DetailEntry = {
  id: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  stockTransactionId?: string | null;
  stockTransaction?: {
    id: string;
    stockAccountId: string;
    cashAccountId?: string | null;
    securityId?: string | null;
    market: string;
    stockCode: string;
    stockName?: string | null;
    action: string;
    tradeDate: string;
    settleDate?: string | null;
    grossAmount?: number | null;
    netAmount?: number | null;
    quantity?: number | null;
    price?: number | null;
    brokerTradeId?: string | null;
    note?: string | null;
  } | null;
  date: string;
  postedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** 创建来源：manual / ai_import / excel_import / scheduled_task / email_import */
  entryOrigin?: string | null;
  dayOrder?: number | null;
  amount: number;
  /**
   * 记账真值（TxRecord.amount）。报表下钻会把 `amount` 换成展示口径
   * （如赎回本金不计收支时置 0），编辑窗必须拿这个原值，否则取出本金 /
   * 到账金额会空（2026-10-17 存款取出编辑报障）。
   */
  bookAmount?: number | null;
  currency?: string | null;
  /**
   * 报表口径的展示值（本位币折算）：报表下钻的合计按本位币统计，
   * 明细也必须同口径显示，否则会出现「合计是人民币、明细行标着 $」的矛盾。
   * 只在报表下钻（`loadReportDetailEntries`）里填充；账户明细页保持原币。
   */
  displayAmount?: number | null;
  displayRealizedProfit?: number | null;
  displayCurrency?: string | null;
  runningBalance?: number | null;
  /** 对账锁定：非空 = 该记录已对账，不可删除 / 修改（编辑窗只读）。 */
  reconciledAt?: string | null;
  /** 对账时钉住的本行事后余额；非空即在余额折叠里充当锚点（等价「余额校准」）。 */
  reconciledBalance?: number | null;
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  accountKind?: string | null;
  accountLiabilityDirection?: string | null;
  accountIsSettlementAccount?: boolean | null;
  accountInstitutionName?: string | null;
  counterpartyInstitutionId?: string | null;
  counterpartyInstitutionName?: string | null;
  originalCurrency?: string | null;
  originalAmount?: number | null;
  locationId?: string | null;
  locationName?: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  toAccountKind?: string | null;
  toAccountLiabilityDirection?: string | null;
  toAccountIsSettlementAccount?: boolean | null;
  toAccountInstitutionName?: string | null;
  note: string | null;
  businessNote?: string | null;
  toNote?: string | null;
  fundSubtype: string | null;
  fundCode: string | null;
  fundName: string | null;
  wealthProductId?: string | null;
  depositProductId?: string | null;
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
  principalAmount?: number | null;
  interestAmount?: number | null;
  feeAmount?: number | null;
  realizedProfit?: number | null;
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
  relatedAccountId?: string | null;
  relatedAccountName?: string | null;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType?: string | null;
    url?: string | null;
  }>;
  entryTags: Array<{
    tagId: string;
    Tag: { name: string; color: string } | null;
  }>;
};

function cssEscape(value: string) {
  const escape = typeof window !== "undefined" ? window.CSS?.escape : undefined;
  return escape ? escape(value) : value.replace(/["\\]/g, "\\$&");
}

function EntryAttachmentIndicator({
  entry,
  onClick,
  asButton = true,
}: {
  entry: DetailEntry;
  onClick: () => void;
  asButton?: boolean;
}) {
  const attachments = entry.attachments ?? [];
  if (attachments.length === 0) return null;
  const names = attachments.map((item) => item.name).join("、");
  const content = <Paperclip className="h-3.5 w-3.5" />;
  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    onClick();
  };
  // Boxed style consistent with the adjacent row action icons (BusinessLinkActionButton,
  // EntryRowActions): visible border, white background, amber accent for attachments.
  const className =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded border border-amber-200 bg-white text-amber-600 transition-colors hover:border-amber-300 hover:bg-amber-50";
  // The mobile entry row is itself a <button>, so the indicator must not render a nested
  // button there (invalid HTML and a React hydration error). Render a span instead.
  if (!asButton) {
    return (
      <span title={names} onClick={handleClick} className={className}>
        {content}
      </span>
    );
  }
  return (
    <button type="button" title={names} onClick={handleClick} className={className}>
      {content}
    </button>
  );
}

function buildBasicEntryEditPayload(entry: DetailEntry, currentAccountId?: string | null) {
  // Settlement side of an advance entry (legacy rows use kind=loan).
  const isAdvanceReturn = entry.source === "advance" && (entry.accountKind === "loan" || entry.accountKind === "settlement");
  const numericAmount = toNumber(entry.amount);
  const dialogAmount = entry.type === "transfer" && entry.source !== "advance"
    ? Math.abs(numericAmount)
    : advanceDialogAmount({ amount: numericAmount, accountKind: entry.accountKind, source: entry.source });
  return {
    id: entry.id,
    transactionId: entry.id,
    date: (entry.date ?? "").slice(0, 10),
    postedAt: entry.postedAt ?? null,
    type: (entry.source === "advance" ? "advance" : entry.source === "fx_conversion" ? "fx" : entry.type) as EditPayload["type"],
    amount: dialogAmount,
    note: displayDetailRemark(entry, currentAccountId),
    toNote: entry.toNote ?? "",
    // 当前就在转账的对方（转入）账户里：备注框显示的是第二备注，保存也只写第二备注。
    noteTarget: entry.type === "transfer" && currentAccountId && entry.toAccountId === currentAccountId
      ? "toNote" as const
      : "" as const,
    categoryId: entry.categoryId ?? undefined,
    categoryName: entry.categoryName ?? undefined,
    accountId: (isAdvanceReturn ? entry.toAccountId : entry.accountId) ?? undefined,
    accountName: (isAdvanceReturn ? entry.toAccountName : entry.accountName) ?? undefined,
    advanceAccountId: entry.source === "advance"
      ? ((isAdvanceReturn ? entry.accountId : entry.toAccountId) ?? undefined)
      : undefined,
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? undefined,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? undefined,
    originalCurrency: entry.originalCurrency ?? null,
    originalAmount: entry.originalAmount != null ? toNumber(entry.originalAmount) : null,
    locationId: entry.locationId ?? undefined,
    locationName: entry.locationName ?? undefined,
    fromAccountId: entry.type === "transfer" ? entry.accountId ?? undefined : undefined,
    fromAccountName: entry.type === "transfer" ? entry.accountName ?? undefined : undefined,
    toAccountId: entry.toAccountId ?? undefined,
    toAccountName: entry.toAccountName ?? undefined,
    tagIds: entry.entryTags?.map((item) => item.tagId) ?? [],
    currency: entry.currency ?? null,
    tags: entry.entryTags?.map((item) => ({
      id: item.tagId,
      name: item.Tag?.name ?? "",
      color: item.Tag?.color ?? null,
    })) ?? [],
  };
}


type DetailAccountOption = {
  id: string;
  label: string;
  listLabel?: string | null;
  selectorLabel?: string | null;
  fullLabel?: string | null;
  title?: string | null;
  hoverTitle?: string | null;
  tableHoverTitle?: string | null;
  kind?: string | null;
  liabilityDirection?: string | null;
  numberMasked?: string | null;
  isSettlementAccount?: boolean | null;
};

/* Helpers */

function shouldShowBusinessLinkStatus(entry: DetailEntry) {
  const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
  // Transfers are ordinary money movements (including deposit/bond interest payouts);
  // touching an investment account does not make them linkable business entries.
  return hasBusinessLink || entry.type === "investment";
}

function formatType(type: string, t: (key: string) => string) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return type;
}

function propertyIncomeExpenseType(entry: DetailEntry): "income" | "expense" | null {
  if (entry.type === "income" || entry.type === "expense") return entry.type;
  const amount = toNumber(entry.amount);
  if (amount > 0) return "income";
  if (amount < 0) return "expense";
  return null;
}

function entryCurrency(entry: { currency?: string | null; displayCurrency?: string | null }) {
  // 报表下钻会带 `displayCurrency`（本位币折算口径）；账户明细页没有该字段，仍用原币。
  return String(entry.displayCurrency ?? entry.currency ?? "CNY").trim().toUpperCase() || "CNY";
}

// Small provenance badge next to the amount: the original settlement amount in
// its own currency (e.g. "USD 100") when the bank posted a different local amount.
function entryOriginalAmountBadge(entry: DetailEntry) {
  const currency = String(entry.originalCurrency ?? "").trim().toUpperCase();
  const amount = entry.originalAmount == null ? null : toNumber(entry.originalAmount);
  if (!currency || currency === entryCurrency(entry) || amount == null || Math.abs(amount) < 0.005) return null;
  return (
    <span className="ml-1 text-[10px] font-normal text-slate-400">
      {currency} {formatCurrencyMoney(Math.abs(amount), currency).replace(/^\D+/, "")}
    </span>
  );
}

function formatEntryCurrencyMoney(amount: number, entry: { currency?: string | null; displayCurrency?: string | null }) {
  const currency = entryCurrency(entry);
  return formatCurrencyMoney(amount, currency);
}

/** 报表下钻的金额是折算后的本位币值；没有 displayAmount 时回退原币金额。 */
function entryDisplayAbsAmount(entry: DetailEntry, fallbackAbsAmount: number) {
  return entry.displayAmount == null ? fallbackAbsAmount : Math.abs(toNumber(entry.displayAmount));
}

function formatSelectedAmountsByCurrency(amounts: Map<string, number>) {
  return Array.from(amounts.entries())
    .sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB))
    .map(([currency, amount]) => formatCurrencyMoney(amount, currency))
    .join(" + ");
}

function isCreditCardRepaymentDisplayEntry(entry: DetailEntry) {
  if (entry.accountIsSettlementAccount || entry.toAccountIsSettlementAccount) return false;
  if (entry.accountKind === "loan" || entry.toAccountKind === "loan") return false;
  return isCreditCardRepaymentTransfer(entry);
}

function bankLiabilityTransferLabel(entry: DetailEntry, mode: LiabilityMode | null, t: (key: string) => string) {
  const involvesBankLoan =
    (entry.accountKind === "loan" && !entry.accountIsSettlementAccount) ||
    (entry.toAccountKind === "loan" && !entry.toAccountIsSettlementAccount);
  if (!involvesBankLoan) return null;
  if (entry.source === "liability_financed_purchase") return t("txForm.installment");
  if (mode === "borrow_in") return t("detailView.loanDisbursement");
  if (mode === "repay_out") return t("detailView.loanRepayment");
  if (mode === "prepay_out") return t("detailView.loanPrepayment");
  if (mode === "lend_out") return t("detailView.bankLending");
  if (mode === "collect_in") return t("detailView.bankCollection");
  return systemCategoryLabel(entry.categoryName, t) || t("detailView.bankLoan");
}

function liabilityCategoryLabel(entry: DetailEntry, accountById: Map<string, DetailAccountOption> | undefined, t: (key: string) => string) {
  if (!isLiabilityActivityEntry(entry, accountById)) return null;
  const mode = inferLiabilityMode(entry, accountById);
  const bankLabel = bankLiabilityTransferLabel(entry, mode, t);
  if (bankLabel) return bankLabel;
  return systemCategoryLabel(normalizeSettlementTransferCategoryName(entry.categoryName), t);
}

function displaySecondRemark(entry: { toNote?: string | null }) {
  return parseLoanPrepayStrategy(entry.toNote) ? "" : (entry.toNote ?? "");
}

function displayDetailRemark(entry: DetailEntry, currentAccountId?: string | null) {
  if (isLicensedInsuranceEntry(entry)) return getInsuranceDetailNote(entry);
  if (entry.type === "transfer" && currentAccountId && entry.toAccountId === currentAccountId) {
    return (displaySecondRemark(entry).trim() || (entry.note ?? "").trim());
  }
  return (entry.note ?? "").trim();
}

function detailEntryDayKey(entry: DetailEntry, accountId: string) {
  return localDateKey(getDetailEntryDisplayDate(entry, accountId));
}

function canManuallyReorderDetailEntry(entry: DetailEntry) {
  return getBalanceReconcileTarget(entry) == null;
}

function batchCategoryTypeForEntry(entry: DetailEntry) {
  if (entry.type === "expense" || entry.type === "income" || entry.type === "investment") return entry.type;
  if (entry.source === "advance") return "advance";
  return "";
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
  if (balanceTarget != null && source === BALANCE_INITIALIZATION_SOURCE) return t("detailView.initialBalance");
  if (source === BALANCE_RECONCILE_SOURCE) return t("detailView.balanceReconcile");
  if (source === TRANSACTION_SOURCE_INSURANCE) {
    return fundSubtype === "redeem" || fundSubtype === "switch_out" ? t("detailView.insuranceRefund") : t("detailView.insuranceExpense");
  }
  if ((source === "advance" || source === "reimbursement") && type !== "expense") return t("txForm.advance");
  if (type === "investment" && (source === "deposit" || source === "deposit_manual")) return t("detailView.deposit");
  return formatType(type, t);
}

/**
 * Deposit business entries read as money movements + interest income in
 * account detail lists — never as "投资" (deposits are transfers; the interest
 * is produced by the deposit account and paid out to the funding account).
 */
function depositActivityLabel(fundSubtype: string | null, t: (key: string) => string): string {
  const subtype = String(fundSubtype ?? "");
  if (subtype === "dividend_cash" || subtype === "dividend_reinvest") return t("deposit.subtype.dividend");
  if (subtype === "redeem" || subtype === "switch_out") return t("detailView.depositWithdraw");
  if (subtype === "buy") return t("txForm.depositIn");
  return t("detailView.deposit");
}

function investmentCategoryLabel(
  entry: DetailEntry,
  entryFundProductType: string | null | undefined,
  t: (key: string) => string,
): string {
  if (isLicensedInsuranceEntry(entry)) return getInsuranceDetailCategoryName(entry);
  // 买入退款资金腿：`source` 才是权威标记。历史行可能把买入分类（基金买入 / 理财买入）
  // 存到了这条流水上，不能让它盖掉「买入退回」。
  if (isFundBuyRefundCashLeg(entry)) return t("detailView.buyRefund");
  if (entry.categoryName) return systemCategoryLabel(entry.categoryName, t);
  const subtype = String(entry.fundSubtype ?? "");
  const source = String(entry.source ?? "");
  const productType = entryFundProductType ?? null;
  if (productType === "deposit") {
    if (subtype === "redeem") return t("detailView.depositWithdraw");
    if (subtype === "buy") return t("txForm.depositIn");
    if (subtype === "dividend_cash" || subtype === "dividend_reinvest") return t("deposit.subtype.dividend");
  }
  if (productType === "wealth") {
    if (subtype === "redeem") return t("detailView.wealthRedeem");
    if (isRegularInvestRefundEntry({ fundSubtype: subtype, source })) return t("detailView.buyRefund");
    if (subtype === "buy_failed") return t("detailView.buyFailed");
    if (subtype === "buy") return t("detailView.wealthBuy");
  }
  if (productType === "bond") {
    if (subtype === "redeem") return t("bondForm.redeem");
    if (subtype === "dividend_cash") return t("bondForm.interestReceipt");
    if (subtype === "buy") return t("detailView.wealthBuy");
  }
  if (productType === "metal") {
    if (subtype === "redeem") return t("detailView.metalSell");
    if (subtype === "buy") return t("detailView.metalBuy");
  }
  if (productType === "fund" || productType === "money" || !productType) {
    if (subtype === "buy" && source === "regular_invest") return t("detailView.fundRegularInvest");
    if (subtype === "buy" && source === "dividend") return t("detailView.dividendInvest");
    if (subtype === "redeem") return t("detailView.fundRedeem");
    if (subtype === "dividend_cash") return t("detailView.dividendCash");
    if (subtype === "dividend_reinvest") return t("detailView.dividendReinvest");
    if (isRegularInvestRefundEntry({ fundSubtype: subtype, source })) return t("detailView.buyRefund");
    if (subtype === "buy_failed") return t("detailView.buyFailed");
    if (subtype === "buy") return t("detailView.fundBuy");
  }
  return "";
}

/* Component */

export function DetailViewClient({
  accountId,
  initialEntries,
  accountOptions,
  batchReplaceAccountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
  compactRows = false,
  storageKey: storageKeyProp,
  refreshOnGlobalEvent = true,
  toolbarMode = "default",
  toolbarTitle,
  toolbarRightContent,
  batchReplaceFields,
  resetKey,
  emptyText,
  draggableRows = true,
  allowInvestmentEdit = true,
  showAccountColumn = false,
  accountColumnLabel,
  accountColumnMode = "account",
  accountColumnDefaultHidden = false,
  relatedAccountDefaultHidden = false,
  showRunningBalance = true,
  runningBalanceDefaultHidden = false,
  enableAccountNavigation = false,
  focusEntryId,
  scrollToRowKey,
  reorderAccountIds,
  sortable = true,
  onDisplayRowsChange,
  onRowsFitChange,
  batchExtraActions,
  reconcileEnabled = false,
  reconcileContextAccountId,
  showDateRangeFilter = false,
  dateRange,
  onDateRangeChange,
  dateRangeBounds,
  dateRangeBoundsLoading = false,
  detailQueryRange,
  initialFilters,
}: {
  accountId: string;
  isInvestAccount: boolean;
  initialEntries: DetailEntry[];
  accountOptions: DetailAccountOption[];
  /** 批量替换账户下拉的选项；缺省时沿用 `accountOptions`。 */
  batchReplaceAccountOptions?: DetailAccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  storageKey?: string;
  refreshOnGlobalEvent?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarTitle?: ReactNode;
  toolbarRightContent?: ReactNode;
  batchReplaceFields?: BatchReplaceField[];
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
  scrollToRowKey?: string | null;
  reorderAccountIds?: string[];
  sortable?: boolean;
  onDisplayRowsChange?: (rows: DetailEntry[]) => void;
  onRowsFitChange?: (rows: number) => void;
  /** 表头时间筛选器（双滑块）。它是数据范围，独立于 `filters.date`。 */
  showDateRangeFilter?: boolean;
  /** 受控的时间范围（父层持有并负责按范围重取）。 */
  dateRange?: { from: string; to: string };
  onDateRangeChange?: (next: { from: string; to: string }) => void;
  /**
   * 当前生效的时间范围（`from~to`）。finance:changed 后的自动重取要带上它，
   * 否则一次入账事件就会把页面换回范围外的数据。
   */
  detailQueryRange?: string;
  /** 时间轴两端；由 `bounds=1` 接口给出全量边界（与筛选、范围都无关）。 */
  dateRangeBounds?: { min: string; max: string } | null;
  /** 时间轴两端还在取数（chip 照常显示，弹层提示读取中）。 */
  dateRangeBoundsLoading?: boolean;
  /** 挂载时的初始筛选（默认只看最近 5 年），仅作初值，不进 effect。 */
  initialFilters?: Partial<Record<string, string[]>>;
  /** Extra batch actions rendered next to the built-in replace/delete buttons.
   * Receives the exact rows the table is rendering, so selection keys always
   * resolve against the same array the user sees. */
  batchExtraActions?: (renderedEntries: DetailEntry[]) => ReactNode;
  /** 是否显示批量「对账」按钮：只在单账户、逐笔余额可见的明细视图里开启。 */
  reconcileEnabled?: boolean;
  /** 「对账」锁定余额时用的明细视图账户（多账户视图留空，按每行自己的账户算）。 */
  reconcileContextAccountId?: string | null;
}) {
  const { t } = useI18n();
  const storageKey = storageKeyProp ?? basicDetailTableStorageKey(accountId);
  // Run before the child table's useEffect reads localStorage: the parent
  // useLayoutEffect runs before the child useEffect.
  useLayoutEffect(() => {
    migrateLegacyBasicDetailLayout(storageKey);
    // 「已实现收益」在全部收支记录里默认显示（老存档可能压着它）。
    if (isAllCashDetailScope(accountId)) {
      promoteDefaultVisibleColumns(storageKey, ["profit"]);
    }
  }, [storageKey, accountId]);
  const [dateDisplayFormat, setDateDisplayFormat] = useState<DateDisplayFormat>("yyyy-mm-dd");
  const [detailDateBackground, setDetailDateBackground] = useState(false);

  useEffect(() => {
    const syncDisplayPreferences = () => {
      setDateDisplayFormat(getDateDisplayFormatPreference());
      setDetailDateBackground(getDetailDateBackgroundPreference());
    };
    syncDisplayPreferences();
    window.addEventListener(APP_PREFS_EVENT, syncDisplayPreferences);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncDisplayPreferences);
  }, []);
  const [attachmentViewEntryId, setAttachmentViewEntryId] = useState<string | null>(null);
  const resolvedEmptyText = emptyText ?? t("detail.empty");
  const resolvedAccountColumnLabel = accountColumnLabel ?? t("common.account");
  const accountOptionById = useMemo(
    () => new Map(accountOptions.map((option) => [option.id, option])),
    [accountOptions],
  );
  // 账户 → 业务产品类型。必须同时看 `kind`：新式存款账户是
  // `kind="deposit"` + `investProductType=NULL`，只看 investProductType
  // 会让存款流水推不出 deposit，落到基金编辑窗（同一笔记录两种窗口的根因）。
  const accountProductTypeById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveAccountProductType>>();
    for (const option of accountOptions) {
      map.set(option.id, resolveAccountProductType({
        kind: option.kind,
        investProductType: investmentProductTypeByAccountId[option.id] ?? null,
      }));
    }
    for (const [id, investProductType] of Object.entries(investmentProductTypeByAccountId)) {
      if (map.has(id)) continue;
      map.set(id, resolveAccountProductType({ investProductType }));
    }
    return map;
  }, [accountOptions, investmentProductTypeByAccountId]);
  /**
   * 明细行的业务产品类型（唯一推导入口）。
   * 分类列、类型列、编辑窗分流、关联业务按钮都必须走这里，否则同一行会
   * 「显示成存款取出、双击却打开基金窗」——即用户看到的两种窗口。
   */
  const entryProductTypeOf = useCallback((entry: DetailEntry) => resolveEntryProductType({
    fundProductType: entry.fundProductType,
    businessLinkLabels: entry.businessLinkLabels,
    toAccountProductType: entry.toAccountId ? accountProductTypeById.get(entry.toAccountId) ?? null : null,
    accountProductType: entry.accountId ? accountProductTypeById.get(entry.accountId) ?? null : null,
  }), [accountProductTypeById]);
  // 账户单元格的显示来源是 `accountOptions`（全量账户），批量替换可选的账户
  // 另有一套（通常只允许收支记账账户），两者不能混用。
  const resolvedBatchReplaceAccountOptions = batchReplaceAccountOptions ?? accountOptions;
  const accountDisplayFallback = useCallback((accountId?: string | null, fallback?: string | null) => {
    const byId = accountId ? accountOptionById.get(accountId) : undefined;
    if (byId) {
      const label = formatAccountTableLabel(byId, "", readAccountDisplaySettings());
      return { label, title: formatAccountTableTitle(byId, label, readAccountDisplaySettings()) };
    }
    const raw = String(fallback ?? "").trim();
    if (!raw) return { label: "", title: "" };
    const encodedId = parseImportAccountId(raw);
    const directId = encodedId || (/^cm[a-z0-9]{8,}$/i.test(raw) ? raw : "");
    const byFallbackId = directId ? accountOptionById.get(directId) : undefined;
    if (byFallbackId) {
      const label = formatAccountTableLabel(byFallbackId, "", readAccountDisplaySettings());
      return { label, title: formatAccountTableTitle(byFallbackId, label, readAccountDisplaySettings()) };
    }
    return { label: raw, title: raw };
  }, [accountOptionById]);
  const accountColumnScopeIds = useMemo(
    () => new Set((reorderAccountIds?.length ? reorderAccountIds : (isAllCashDetailScope(accountId) ? [] : [accountId])).filter(Boolean)),
    [accountId, reorderAccountIds],
  );
  // 当前明细账户的类别：贷款 / 往来款要走本金口径（与服务端 SQL 一致）。
  const selectedAccountKind = useMemo(() => accountOptionById.get(accountId)?.kind ?? null, [accountOptionById, accountId]);
  const flowAccountIdOf = useCallback((entry: { accountId?: string | null; toAccountId?: string | null }) => {
    if (isAllCashDetailScope(accountId) && accountColumnScopeIds.size > 0) {
      return cashLedgerFlowAccountId(entry, accountColumnScopeIds);
    }
    return accountId;
  }, [accountId, accountColumnScopeIds]);
  const accountColumnScopeIdList = useMemo(
    () => Array.from(accountColumnScopeIds),
    [accountColumnScopeIds],
  );
  /**
   * 全部交易记录里这一行以哪一侧作为「本行账户」：账户列显示它，金额按它的视角算，
   * 另一侧进「关联账户」列。
   *
   * 规则（2026-10-26 用户口径）：**只要一方是资金账户，资金账户就在前**。
   * - 转出方是往来款 / 贷款、转入方是借记卡（收回借款、放款到账）：账户列是借记卡，
   *   往来款退到「关联账户」——不能因为"钱是从往来款出去的"就把往来款摆在账户列。
   * - 两侧都是资金账户（普通转账、换汇）：付款方（金额为负的一侧）为账户列；
   *   换汇的正向行由转入方承担。
   * - 两侧都不是资金账户（基金 → 存款利息）：沿用原规则，以 `accountId` 为本行账户。
   */
  const primaryAccountTarget = useCallback((entry: DetailEntry) => {
    const accountIsCash = !!entry.accountId && accountColumnScopeIds.has(entry.accountId);
    const toIsCash = !!entry.toAccountId && accountColumnScopeIds.has(entry.toAccountId);
    if (toIsCash && !accountIsCash) {
      return { id: entry.toAccountId, name: entry.toAccountName };
    }
    if (entry.toAccountId && accountIsCash && toIsCash && toNumber(entry.amount) >= 0) {
      return { id: entry.toAccountId, name: entry.toAccountName };
    }
    return { id: entry.accountId, name: entry.accountName };
  }, [accountColumnScopeIds]);
  /**
   * 金额口径：按「本行账户」（`outflowAccountTarget`）的视角算流入 / 流出。
   *
   * 以前全部交易记录一律「有对手方就取负」，于是资金账户在转入方时会出现
   * 「账户是借记卡、金额却是流出」的矛盾；账户列、关联账户列、金额三处必须同口径。
   * 其它视图沿用账户视角金额（不变）。
   */
  const detailFlowAmountOf = useCallback((entry: DetailEntry) => {
    if (isAllCashDetailScope(accountId)) {
      return effectiveAmountForAccount(entry, primaryAccountTarget(entry).id);
    }
    return effectiveAmountForAccount(entry, flowAccountIdOf(entry));
  }, [accountId, flowAccountIdOf, primaryAccountTarget]);
  /**
   * 明细「账户」列属于哪一侧。
   * - 全部交易记录：资金账户那一侧（见 `primaryAccountTarget`）。
   * - 单账户明细（含信用卡账单）：当前账户就是本行账户（转入行也要认作当前账户）。
   */
  const entryViewAccountTarget = useCallback((entry: DetailEntry) => {
    if (isAllCashDetailScope(accountId) && accountColumnScopeIds.size > 0) {
      return primaryAccountTarget(entry);
    }
    if (accountId && accountColumnScopeIds.has(accountId)) {
      if (entry.accountId === accountId) return { id: entry.accountId, name: entry.accountName };
      if (entry.toAccountId === accountId) return { id: accountId, name: entry.toAccountName };
    }
    return { id: entry.accountId, name: entry.accountName };
  }, [accountColumnScopeIds, accountId, primaryAccountTarget]);
  /**
   * 「关联账户」= 账户列的另一侧：全部交易记录里通常是收入方 `toAccount`，
   * 换汇等反向行则是 `accountId`。旧逻辑按 scope 推断方向，而首页把全部资金
   * 账户都传进 scopeAccountIds，转账两侧都在 scope 内，会让同一账户显示两遍
   * （2026-10-23 报障）。
   */
  const relatedAccountTarget = useCallback((entry: DetailEntry) => {
    if (!entry.toAccountId && (entry.relatedAccountId || entry.relatedAccountName)) {
      return { id: entry.relatedAccountId ?? null, name: entry.relatedAccountName ?? null };
    }
    const own = entryViewAccountTarget(entry);
    if (entry.toAccountId && own.id !== entry.toAccountId) {
      return { id: entry.toAccountId, name: entry.toAccountName };
    }
    if (entry.accountId && own.id !== entry.accountId) {
      return { id: entry.accountId, name: entry.accountName };
    }
    return { id: null, name: null };
  }, [entryViewAccountTarget]);
  const accountColumnTarget = useCallback((entry: DetailEntry) => {
    if (accountColumnMode === "cardLast4") {
      if (entry.accountId && accountColumnScopeIds.has(entry.accountId)) {
        return { id: entry.accountId, name: entry.accountName };
      }
      if (entry.toAccountId && accountColumnScopeIds.has(entry.toAccountId)) {
        return { id: entry.toAccountId, name: entry.toAccountName };
      }
    }
    return entryViewAccountTarget(entry);
  }, [accountColumnMode, accountColumnScopeIds, entryViewAccountTarget]);
  const accountColumnDisplayFallback = useCallback((entry: DetailEntry) => {
    const target = accountColumnTarget(entry);
    if (accountColumnMode === "cardLast4") {
      const option = target.id ? accountOptionById.get(target.id) : undefined;
      const last4 = option?.numberMasked?.trim();
      if (last4) {
        const title = option?.title ?? option?.fullLabel ?? option?.label ?? last4;
        return { id: target.id, label: last4, title };
      }
      return {
        id: target.id,
        label: "-",
        title: option?.title ?? option?.fullLabel ?? option?.label ?? target.name ?? "",
      };
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
  const detailCategoryLabel = useCallback((entry: DetailEntry) => {
    const liabilityLabel = liabilityCategoryLabel(entry, accountOptionById, t);
    if (liabilityLabel) return liabilityLabel;
    const entryFundProductType = entryProductTypeOf(entry);
    if (entryFundProductType === "property" && entry.type === "investment") return systemCategoryLabel(entry.categoryName, t);
    if (entry.type === "investment") return investmentCategoryLabel(entry, entryFundProductType, t);
    if (isCreditCardRepaymentDisplayEntry(entry)) return t("transaction.category.creditCardRepayment");
    if (isLicensedInsuranceEntry(entry)) return getInsuranceDetailCategoryName(entry);
    const categoryLabel = systemCategoryLabel(entry.categoryName, t);
    if (categoryLabel) return categoryLabel;
    if (entry.type === "income" && entry.source === "advance") {
      return t("systemCategory.reimbursement");
    }
    return "";
  }, [accountOptionById, entryProductTypeOf, t]);
  const [refreshedEntries, setRefreshedEntries] = useState<{ accountId: string; entries: DetailEntry[] } | null>(null);
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());
  const entries = refreshedEntries?.accountId === accountId ? refreshedEntries.entries : initialEntries;
  const linkDetailCashFlow = useCallback(async (entry: DetailEntry) => {
    const id = String(entry.id ?? "").trim();
    if (!id || linkingIds.has(id)) return;
    const businessTransactionId = String(entry.businessTransactionId ?? "").trim();
    // 与编辑窗共用同一套产品类型推导：只看 `fundProductType` 时，历史记录
    // （该列几乎全为 NULL）会在这里报「缺少业务类型」，而编辑窗却已经能打开。
    const businessType = toBusinessLinkType(entryProductTypeOf(entry))
      ?? (entry.insuranceProductId || entry.insuranceAction || isLicensedInsuranceEntry(entry) ? "insurance" : null);
    if (!businessType) {
      window.alert(t("detailView.alert.missingBusinessType"));
      return;
    }
    if (!businessTransactionId) {
      window.alert(t("detailView.alert.missingBusinessId"));
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
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("detailView.alert.linkFailed"));
      dispatchFinanceDataChanged({ reason: "detail-link-cash-flow", entryIds: [data.data?.cashEntryId, id].filter(Boolean) });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("detailView.alert.linkFailed"));
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [entryProductTypeOf, linkingIds, t]);
  const navigateToAccountEntry = useCallback((targetAccountId: string | null | undefined, entry: DetailEntry) => {
    const target = String(targetAccountId ?? "").trim();
    if (!enableAccountNavigation || !target) return;
    const params = new URLSearchParams({
      accountId: target,
      view: "detail",
      pageSize: "40",
      focusEntryId: entry.id,
    });
    // 手写 URL 不会走 Next 的 basePath 重写：fnOS 网关下裸 "/?..." 落在网关
    // 根路径（那里没有 MMH 路由，飞牛回「这里暂时没有装入页面」）。
    window.location.assign(withBasePath(`/?${params.toString()}`));
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
        title={t("detailView.navigateAccountTitle", { name: title || text })}
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
    // 报表下钻把赎回本金抹成 0（本金不计收支），编辑窗必须用记账原值，
    // 否则取出本金 / 到账金额都是空的。
    const editAmount = amount === 0 && e.bookAmount != null ? toNumber(e.bookAmount) : amount;
    const linkedStockTransaction = e.stockTransaction ?? null;
    if (linkedStockTransaction || e.stockTransactionId) {
      if (!linkedStockTransaction) return {};
      return {
        customEditEvent: {
          name: "mmh:stock:edit",
          detail: {
            requestId: `edit-${linkedStockTransaction.id}-${Date.now()}`,
            transaction: {
              id: linkedStockTransaction.id,
              stockAccountId: linkedStockTransaction.stockAccountId,
              cashAccountId: linkedStockTransaction.cashAccountId ?? e.cashAccountId ?? e.accountId ?? null,
              securityId: linkedStockTransaction.securityId ?? null,
              market: linkedStockTransaction.market || "CN",
              stockCode: linkedStockTransaction.stockCode || "",
              stockName: linkedStockTransaction.stockName ?? null,
              action: linkedStockTransaction.action || "buy",
              tradeDate: linkedStockTransaction.tradeDate || dateStr,
              settleDate: linkedStockTransaction.settleDate ?? null,
              grossAmount: linkedStockTransaction.grossAmount ?? null,
              netAmount: linkedStockTransaction.netAmount ?? null,
              quantity: linkedStockTransaction.quantity ?? null,
              price: linkedStockTransaction.price ?? null,
              brokerTradeId: linkedStockTransaction.brokerTradeId ?? null,
              note: linkedStockTransaction.note ?? e.businessNote ?? e.note ?? null,
            },
          },
        },
      };
    }
    const entryFundProductType = entryProductTypeOf(e);
    const isRedeemEditEntry =
      e.fundSubtype === "redeem" ||
      e.fundSubtype === "switch_out" ||
      isRegularInvestRefundEntry(e) ||
      (e.type === "investment" &&
        !e.fundSubtype &&
        Boolean(e.toAccountId) &&
        entryFundProductType != null &&
        (e.accountId ? accountProductTypeById.get(e.accountId) ?? null : null) === entryFundProductType);
    const targetInvestmentEditEntryId =
      isRegularInvestRefundEntry(e) && e.fundSourceEntryId
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
            amount: editAmount,
            // 回填基金侧自己的备注（用户备注或「资金来源 X」）；资金侧备注是「基金买入 代码 名称」，不能拿来当基金备注。
            note: entryFundProductType === "wealth" ? e.businessNote ?? "" : e.businessNote ?? e.note ?? "",
            fundCode: e.fundCode ?? undefined,
            fundName: e.fundName ?? undefined,
            wealthProductId: e.wealthProductId ?? null,
            depositProductId: e.depositProductId ?? null,
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
            fundSubtype: e.fundSubtype ?? (isRedeemEditEntry ? "redeem" : undefined),
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
    const liabilityEditEvent = balanceReconcileEditEvent
      ? null
      : buildLiabilityActivityEditEvent({ ...e, date: dateStr }, accountOptionById);

    // 已「对账」锁定的记录：编辑窗只读（可查看，不可改）；服务端另有硬守卫。
    const reconciledReadOnly = isReconciledEntry(e);
    if (balanceReconcileEditEvent || liabilityEditEvent) {
      const customEvent = balanceReconcileEditEvent ?? liabilityEditEvent!;
      return { customEditEvent: { ...customEvent, detail: { ...customEvent.detail, reconciledReadOnly } } };
    }
    const baseEdit = e.type === "investment" ? investmentEditPayload : buildBasicEntryEditPayload(e, flowAccountIdOf(e));
    return { edit: baseEdit ? { ...baseEdit, reconciledReadOnly } : undefined };
  }, [accountId, accountOptionById, allowInvestmentEdit, entryProductTypeOf, flowAccountIdOf, linkedInvestmentCandidateEntries]);
  /**
   * 打开编辑窗。
   *
   * 明细列表返回的是瘦身行：产品 id、分期、金属、存款来源等只在编辑回填时用的
   * 字段已经不在列表响应里，所以点编辑要先按 id 取一次完整记录（单条约 2KB），
   * 再交给 `buildEntryEditRequest` 构造 payload。取失败时退回用行数据，基础编辑
   * 窗至少能打开。
   */
  const openEntryEditor = useCallback(async (entry: DetailEntry, reconciledReadOnly = false) => {
    let source = entry;
    try {
      const response = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(entry.id)}`);
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok && payload.data) {
        source = { ...entry, ...(payload.data as DetailEntry) };
      }
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== "AbortError") {
        console.error("Load entry detail before edit failed:", error);
      }
    }
    const { edit, customEditEvent } = buildEntryEditRequest(source);
    const nextEdit = edit ? { ...edit, reconciledReadOnly } : edit;
    const nextCustomEditEvent = customEditEvent
      ? { ...customEditEvent, detail: { ...customEditEvent.detail, reconciledReadOnly } }
      : undefined;
    if (!nextEdit && !nextCustomEditEvent) return;
    dispatchEntryEdit({ entryId: source.id, edit: nextEdit, customEditEvent: nextCustomEditEvent });
  }, [buildEntryEditRequest]);
  const colorScheme =
    typeof document === "undefined"
      ? "red_up_green_down"
      : getColorSchemeFromCookie(document.cookie ?? null);
  const inflowCls = pnlColor(1, colorScheme);
  const outflowCls = pnlColor(-1, colorScheme);
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  // 「对账」锁定余额时用的明细视图账户：单账户明细视图就是 accountId。
  const reconcileAccountId = reconcileContextAccountId ?? accountId;
  const currentEntryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const selectedFlowSummary = useMemo(() => {
    const inflowByCurrency = new Map<string, number>();
    const outflowByCurrency = new Map<string, number>();
    for (const entry of entries) {
      if (!selectedIds.has(entry.id)) continue;
      const amount = detailFlowAmountOf(entry);
      const currency = entryCurrency(entry);
      if (!inflowByCurrency.has(currency)) inflowByCurrency.set(currency, 0);
      if (!outflowByCurrency.has(currency)) outflowByCurrency.set(currency, 0);
      if (amount > 0) {
        inflowByCurrency.set(currency, (inflowByCurrency.get(currency) ?? 0) + amount);
      } else if (amount < 0) {
        outflowByCurrency.set(currency, (outflowByCurrency.get(currency) ?? 0) - amount);
      }
    }
    return {
      inflow: formatSelectedAmountsByCurrency(inflowByCurrency),
      outflow: formatSelectedAmountsByCurrency(outflowByCurrency),
    };
  }, [detailFlowAmountOf, entries, selectedIds]);
  const selectedCategoryTypes = useMemo(() => {
    const types = new Set<string>();
    for (const entry of entries) {
      if (!selectedIds.has(entry.id)) continue;
      const categoryType = batchCategoryTypeForEntry(entry);
      if (categoryType) types.add(categoryType);
    }
    return Array.from(types);
  }, [entries, selectedIds]);
  usePruneBasicDetailSelection(currentEntryIds);
  const detailRefreshSeqRef = useRef(0);
  const lastResetKeyRef = useRef<string | undefined>(resetKey);
  const entriesRef = useRef(entries);
  const reorderPersistChainRef = useRef(Promise.resolve());
  const reorderGenRef = useRef(0);
  const reorderAbortPersistRef = useRef(false);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const persistEntryReorder = useCallback(async (payload: { entryId: string; targetEntryId: string; targetPosition: AdvancedDataTableDropPosition }) => {
    const res = await fetch("/api/v1/transactions/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, accountIds: reorderAccountIds, ...payload }),
    });
    const data = (await res.json().catch(() => null)) as ReorderResponse | null;
    if (!data?.ok) {
      throw new Error(data?.error ?? t("detailView.alert.reorderFailed"));
    }
    return data;
  }, [accountId, reorderAccountIds, t]);

  const canDropDetailEntry = useCallback((source: DetailEntry, target: DetailEntry, position?: AdvancedDataTableDropPosition) => {
    void position;
    return (
    canManuallyReorderDetailEntry(source) &&
    canManuallyReorderDetailEntry(target) &&
    detailEntryDayKey(source, flowAccountIdOf(source)) === detailEntryDayKey(target, flowAccountIdOf(target))
    );
  }, [accountId, flowAccountIdOf]);

  const rowDropTargetAtEnd = useCallback((source: DetailEntry, sourceIndex: number, orderedRows: DetailEntry[]) => {
    const sourceDayKey = detailEntryDayKey(source, flowAccountIdOf(source));
    let targetIndex = -1;
    for (let index = 0; index < orderedRows.length; index += 1) {
      const candidate = orderedRows[index];
      if (detailEntryDayKey(candidate, flowAccountIdOf(candidate)) !== sourceDayKey) continue;
      if (!canDropDetailEntry(source, candidate, "after")) continue;
      targetIndex = index;
    }
    if (targetIndex < 0 || targetIndex === sourceIndex) return null;
    return { row: orderedRows[targetIndex], index: targetIndex };
  }, [accountId, canDropDetailEntry, flowAccountIdOf]);

  const reorderEntryByDrag = useCallback((source: DetailEntry, target: DetailEntry, position: AdvancedDataTableDropPosition) => {
    if (source.id === target.id) return;
    if (!canManuallyReorderDetailEntry(source) || !canManuallyReorderDetailEntry(target)) return;
    if (detailEntryDayKey(source, flowAccountIdOf(source)) !== detailEntryDayKey(target, flowAccountIdOf(target))) {
      window.alert(t("detailView.alert.reorderSameDayOnly"));
      return;
    }
    if (!canDropDetailEntry(source, target, position)) return;
    const previousEntries = entriesRef.current;
    const nextEntries = reorderEntriesToTarget(previousEntries, source.id, target.id, position);
    if (nextEntries === previousEntries) return;
    const dayKey = detailEntryDayKey(source, flowAccountIdOf(source));
    const seed = startOfDayRunningBalanceSeed(previousEntries, accountId, dayKey);
    const nextWithBalances = showRunningBalance
      ? rebaseRunningBalancesAfterSameDayReorder(nextEntries, accountId, dayKey, seed)
      : nextEntries;
    const gen = ++reorderGenRef.current;
    reorderAbortPersistRef.current = false;
    detailRefreshSeqRef.current += 1;
    entriesRef.current = nextWithBalances;
    setRefreshedEntries({ accountId, entries: nextWithBalances });
    reorderPersistChainRef.current = reorderPersistChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (reorderAbortPersistRef.current) return;
        const data = await persistEntryReorder({ entryId: source.id, targetEntryId: target.id, targetPosition: position });
        if (reorderAbortPersistRef.current) return;
        if (!data.orderedEntryIds?.length && !data.runningBalances) return;
        const currentEntries = entriesRef.current;
        const orderedEntries = applyServerEntryOrder(currentEntries, data.orderedEntryIds ?? []);
        const confirmed = showRunningBalance
          ? (data.runningBalances
            ? applyServerRunningBalances(orderedEntries, data.runningBalances)
            : rebaseRunningBalancesAfterSameDayReorder(orderedEntries, accountId, dayKey, seed))
          : orderedEntries;
        if (gen !== reorderGenRef.current) return;
        entriesRef.current = confirmed;
        setRefreshedEntries({ accountId, entries: confirmed });
      })
      .catch((error) => {
        reorderAbortPersistRef.current = true;
        entriesRef.current = previousEntries;
        setRefreshedEntries({ accountId, entries: previousEntries });
        window.alert(error instanceof Error ? error.message : t("detailView.alert.reorderFailed"));
      });
  }, [accountId, canDropDetailEntry, flowAccountIdOf, persistEntryReorder, showRunningBalance, t]);

  useEffect(() => {
    setRefreshedEntries((current) => (current?.accountId === accountId ? current : null));
  }, [accountId]);
  // refreshedEntries is a local snapshot from an event-triggered refetch. Once set,
  // it masks initialEntries until the account or resetKey changes. When the parent
  // (BasicDetailPanel) changes page or locates a date, it passes new data through
  // initialEntries. A changed pageEntries reference means the parent data changed,
  // so the snapshot must yield; otherwise it permanently masks the new page.
  const lastInitialEntriesRef = useRef(initialEntries);
  useEffect(() => {
    if (lastInitialEntriesRef.current === initialEntries) return;
    lastInitialEntriesRef.current = initialEntries;
    // Invalidate an in-flight event refetch; otherwise a late first-page
    // finance:changed response can overwrite the parent's newly loaded page.
    detailRefreshSeqRef.current += 1;
    setRefreshedEntries(null);
  }, [initialEntries]);

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
      const detail = (event as CustomEvent<{ accountIds?: string[]; deletedEntryIds?: string[] }>).detail ?? {};
      const eventAccountIds = detail.accountIds ?? [];
      if (
        eventAccountIds.length > 0
        && !eventAccountIds.includes(accountId)
        && !eventAccountIds.some((id) => accountColumnScopeIds.has(id))
      ) return;
      const deletedEntryIds = detail.deletedEntryIds ?? [];
      if (deletedEntryIds.length > 0) {
        const deletedSet = new Set(deletedEntryIds);
        detailRefreshSeqRef.current += 1;
        setRefreshedEntries((current) => {
          const currentEntries = current?.accountId === accountId ? current.entries : entries;
          const result = removeEntriesAndUpdateRunningBalances(
            currentEntries,
            deletedSet,
            accountId,
            selectedAccountKind,
            todayDateBusinessYmd(getTimeZonePreference()),
          );
          return { accountId, entries: result.entries };
        });
        setSelection(new Set());
        return;
      }
      const url = new URL(window.location.href);
      const storedPagination = readStoredDetailPreference(accountId);
      const detailPage = normalizeDetailPage(
        url.searchParams.get("detailPage") ?? storedPagination?.detailPage ?? 1,
      );
      const pageSize = normalizeDetailPageSize(
        url.searchParams.get("pageSize") ?? storedPagination?.pageSize ?? 20,
      );
      const seq = ++detailRefreshSeqRef.current;
      // 「全部」由父层（BasicDetailPanel + detail-all-store）持有整份数据，
      // 这里只负责分页视图的整页重取（父层在 detailAll 时不会打开本开关）。
      const params = new URLSearchParams({
        accountId,
        page: String(detailPage),
        pageSize: String(pageSize),
      });
      // 自动重取也要落在同一个时间范围里，否则一次入账事件就把范围外的行换回来。
      if (detailQueryRange) params.set("range", detailQueryRange);
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
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [accountColumnScopeIds, accountId, detailQueryRange, entries, refreshOnGlobalEvent, selectedAccountKind, setSelection, t]);

  const columns = useMemo<AdvancedDataTableColumn<DetailEntry>[]>(() => [
    {
      key: "date",
      label: t("detail.column.date"),
      // 与「入账日期」列同宽：两列显示的都是同格式日期（YYYY-MM-DD），
      // 原来 96/78 在列多时会被压缩到 minWidth 触发换行，132/110 与 postedAt 对齐。
      width: 132,
      minWidth: 110,
      filterKind: "dateRange",
      filterText: (e) => localDateKey(getDetailEntryDisplayDate(e, flowAccountIdOf(e))),
      sortValue: (e) => getDetailEntryDisplayDate(e, flowAccountIdOf(e)).getTime(),
      // The date column shows this side's transaction date. For expense /
      // income rows that is the raw `date` (the posting date has its own
      // column — do not display it here). An investment redemption's cash leg
      // is different: on the cash side the money only moves on the arrival
      // date, so the arrival date *is* the transaction date there, while the
      // investment side keeps the trade date. See getDetailEntryTradeDate.
      render: (e) => <span className="tabular-nums text-slate-600">{formatDateDisplay(getDetailEntryTradeDate(e, flowAccountIdOf(e)), dateDisplayFormat)}</span>,
    },
    ...(showAccountColumn ? [{
      key: "account",
      label: resolvedAccountColumnLabel,
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
          {e.postedAt ? formatDateDisplay(e.postedAt, dateDisplayFormat) : ""}
        </span>
      ),
    },
    {
      key: "inflow",
      label: t("detail.column.inflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      filterKind: "numberRange",
      filterText: (e) => {
        const amount = detailFlowAmountOf(e);
        return amount > 0 ? String(amount) : "";
      },
      filterNumber: (e) => {
        const amount = detailFlowAmountOf(e);
        return amount > 0 ? amount : null;
      },
      sortValue: (e) => {
        const amount = detailFlowAmountOf(e);
        return amount > 0 ? amount : null;
      },
      render: (e) => {
        const effectiveAmount = detailFlowAmountOf(e);
        const inflow = effectiveAmount > 0 ? effectiveAmount : null;
        return (
          <span className={`whitespace-nowrap tabular-nums ${inflow !== null ? inflowCls : "text-slate-700"}`}>
            {inflow !== null ? (
              <>
                {formatEntryCurrencyMoney(entryDisplayAbsAmount(e, inflow), e)}
                {entryOriginalAmountBadge(e)}
              </>
            ) : ""}
          </span>
        );
      },
    },
    {
      key: "outflow",
      label: t("detail.column.outflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      filterKind: "numberRange",
      filterText: (e) => {
        const amount = detailFlowAmountOf(e);
        return amount < 0 ? String(-amount) : "";
      },
      filterNumber: (e) => {
        const amount = detailFlowAmountOf(e);
        return amount < 0 ? -amount : null;
      },
      sortValue: (e) => {
        const amount = detailFlowAmountOf(e);
        return amount < 0 ? -amount : null;
      },
      render: (e) => {
        const effectiveAmount = detailFlowAmountOf(e);
        const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
        return (
          <span className={`whitespace-nowrap tabular-nums ${outflow !== null ? outflowCls : "text-slate-700"}`}>
            {outflow !== null ? (
              <>
                {formatEntryCurrencyMoney(entryDisplayAbsAmount(e, outflow), e)}
                {entryOriginalAmountBadge(e)}
              </>
            ) : ""}
          </span>
        );
      },
    },
    {
      key: "currency",
      label: t("detail.column.currency"),
      width: 68,
      minWidth: 54,
      hideable: true,
      filterText: (e) => entryCurrency(e),
      render: (e) => <span className="block truncate text-center font-medium tabular-nums text-slate-500">{entryCurrency(e)}</span>,
    },
    {
      key: "type",
      label: t("detailView.column.type"),
      width: 96,
      minWidth: 74,
      filterText: (e) => {
        const entryFundProductType = entryProductTypeOf(e);
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        if (isLiabilityActivityEntry(e, accountOptionById)) return t("transaction.type.transfer");
        if (entryFundProductType === "property" && e.type === "investment") {
          const ordinaryType = propertyIncomeExpenseType(e);
          if (ordinaryType) return formatType(ordinaryType, t);
        }
        if (e.type === "investment") {
          if (entryFundProductType === "deposit") return depositActivityLabel(e.fundSubtype, t);
          return t("transaction.type.investment");
        }
        const balanceTarget = getBalanceReconcileTarget(e);
        return activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
      },
      render: (e) => {
        const isLiabilityActivity = isLiabilityActivityEntry(e, accountOptionById);
        const entryFundProductType = entryProductTypeOf(e);
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const balanceTarget = getBalanceReconcileTarget(e);
        const ordinaryPropertyType = entryFundProductType === "property" && e.type === "investment" ? propertyIncomeExpenseType(e) : null;
        const actLabel = isLiabilityActivity
          ? t("transaction.type.transfer")
          : ordinaryPropertyType
            ? formatType(ordinaryPropertyType, t)
            : e.type === "investment"
              ? entryFundProductType === "deposit"
                ? depositActivityLabel(e.fundSubtype, t)
                : t("transaction.type.investment")
              : activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
        return (
          <>
            {balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE ? (
              <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600">
                {t("detailView.initialBalance")}
              </span>
            ) : e.source === BALANCE_RECONCILE_SOURCE ? (
              <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700">
                {t("detailView.balanceReconcile")}
              </span>
            ) : (
              <span className="text-slate-700">{actLabel}</span>
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
      filterText: (e) => detailCategoryLabel(e),
      render: (e) => {
        const text = detailCategoryLabel(e);
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
        const related = relatedAccountTarget(e);
        return accountDisplayFallback(related.id, related.name).label;
      },
      filterTitle: (e) => {
        const related = relatedAccountTarget(e);
        return accountDisplayFallback(related.id, related.name).title;
      },
      filterSearchText: (e) => {
        const related = relatedAccountTarget(e);
        const selected = accountDisplayFallback(related.id, related.name);
        return [
          selected.label,
          selected.title,
          related.name,
        ].filter(Boolean).join(" ");
      },
      render: (e) => {
        const related = relatedAccountTarget(e);
        const display = accountDisplayFallback(related.id, related.name);
        return renderNavigableAccountLabel(e, related.id, display.label, display.title, "block truncate text-slate-500");
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
      render: (e: DetailEntry) => <span className="whitespace-nowrap tabular-nums text-slate-700">{e.runningBalance != null ? formatEntryCurrencyMoney(toNumber(e.runningBalance), e) : ""}</span>,
    } satisfies AdvancedDataTableColumn<DetailEntry>] : []),
    {
      key: "profit",
      label: t("reports.stock.realizedProfit"),
      width: 110,
      minWidth: 82,
      align: "right" as const,
      hideable: true,
      defaultHidden: false,
      filterNumber: (e) => e.realizedProfit ?? null,
      sortValue: (e) => e.realizedProfit ?? null,
      render: (e: DetailEntry) => {
        // 报表下钻用折算后的本位币收益，与左侧合计同口径。
        const profit = e.displayRealizedProfit ?? e.realizedProfit;
        return <span className={`whitespace-nowrap tabular-nums ${profit == null ? "text-slate-300" : pnlColor(profit, colorScheme)}`}>{profit == null ? "" : formatEntryCurrencyMoney(profit, e)}</span>;
      },
    } satisfies AdvancedDataTableColumn<DetailEntry>,
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
      filterText: (e) => displayDetailRemark(e, flowAccountIdOf(e)),
      render: (e) => {
        const text = displayDetailRemark(e, flowAccountIdOf(e));
        return <span className="block truncate text-slate-500" title={text}>{text}</span>;
      },
    },
    // 审计列三项（创建时间 / 最后修改时间 / 创建来源）集中放在「表头设置」列表最下方，
    // 用紫色底色把这三项和普通数据列区分开（menuClassName 只影响设置列表项，不染表格）。
    // 都是 transient：默认隐藏，勾选只在当前表格一次性生效，不写进持久化配置。
    // 创建时间 / 最后修改时间可按日期范围筛选（点表头漏斗），筛选值用不随显示格式变化的
    // `YYYY-MM-DD HH:mm:ss` 键，顺带让这两列可以按时间排序（没有 sortValue 时表格用 filterText 排序）。
    {
      key: "createdAt",
      label: t("detail.column.createdAt"),
      width: 170,
      minWidth: 132,
      hideable: true,
      defaultHidden: true,
      transient: true,
      menuClassName: "bg-violet-50 hover:bg-violet-100",
      filterKind: "dateRange",
      filterText: (e) => entryAuditSortKey(e.createdAt),
      render: (e) => (
        <span className="whitespace-nowrap tabular-nums text-slate-500">
          {formatEntryAuditTimestamp(e.createdAt, dateDisplayFormat)}
        </span>
      ),
    },
    {
      key: "updatedAt",
      label: t("detail.column.updatedAt"),
      width: 170,
      minWidth: 132,
      hideable: true,
      defaultHidden: true,
      transient: true,
      menuClassName: "bg-violet-50 hover:bg-violet-100",
      filterKind: "dateRange",
      filterText: (e) => entryAuditSortKey(e.updatedAt),
      render: (e) => (
        <span className="whitespace-nowrap tabular-nums text-slate-500">
          {formatEntryAuditTimestamp(e.updatedAt, dateDisplayFormat)}
        </span>
      ),
    },
    {
      key: "entryOrigin",
      label: t("detail.column.entryOrigin"),
      width: 120,
      minWidth: 96,
      hideable: true,
      defaultHidden: true,
      transient: true,
      menuClassName: "bg-violet-50 hover:bg-violet-100",
      render: (e) => (
        <span className="whitespace-nowrap text-slate-500">
          {entryOriginDisplayLabel(e.entryOrigin, t)}
        </span>
      ),
    },
  ], [accountColumnDefaultHidden, accountColumnDisplayFallback, resolvedAccountColumnLabel, accountColumnMode, accountDisplayFallback, accountId, accountOptionById, dateDisplayFormat, detailCategoryLabel, detailFlowAmountOf, entryProductTypeOf, flowAccountIdOf, inflowCls, outflowCls, relatedAccountDefaultHidden, relatedAccountTarget, renderNavigableAccountLabel, runningBalanceDefaultHidden, showAccountColumn, showRunningBalance, t]);

  const customToolbarLeft = toolbarMode === "custom" ? (
    <div className="flex min-w-0 items-center gap-2">
      {selectedCount > 0 ? <BasicDetailBatchReplaceButton fields={batchReplaceFields} accountOptions={resolvedBatchReplaceAccountOptions} categoryOptions={categoryOptions} tagOptions={tagOptions} categoryTypes={selectedCategoryTypes} contextAccountId={accountId} contextAccountIds={accountColumnScopeIdList} /> : null}
      {selectedCount > 0 ? <BasicDetailBatchDeleteButton /> : null}
      {selectedCount > 0 && reconcileEnabled ? <BasicDetailBatchReconcileButton contextAccountId={reconcileAccountId} /> : null}
      {/* The reimbursement entry works both ways: with rows picked it pre-seeds the
          create form; without, it opens the account's reimbursement status hub. */}
      {batchExtraActions?.(entries)}
      {selectedCount > 0 ? <span className="text-xs font-medium text-slate-600">{tf("detail.selectedCount", { count: selectedCount })}</span> : null}
      {selectedCount > 0 ? <span className={`text-xs font-medium ${inflowCls}`}>{t("detail.column.inflow")} {selectedFlowSummary.inflow}</span> : null}
      {selectedCount > 0 ? <span className={`text-xs font-medium ${outflowCls}`}>{t("detail.column.outflow")} {selectedFlowSummary.outflow}</span> : null}
      {selectedCount === 0 && toolbarTitle ? <div className="text-sm font-semibold text-slate-800">{toolbarTitle}</div> : null}
    </div>
  ) : undefined;
  const tableResetKey = resetKey ?? `${accountId}:detail-table`;
  const mobileGroups = useMemo(() => {
    const groups: Array<{ date: string; entries: DetailEntry[] }> = [];
    for (const entry of entries) {
      const date = detailEntryDayKey(entry, flowAccountIdOf(entry)) || t("detailView.noDate");
      const current = groups[groups.length - 1];
      if (current?.date === date) current.entries.push(entry);
      else groups.push({ date, entries: [entry] });
    }
    return groups;
  }, [accountId, entries, flowAccountIdOf, t]);

  return (
    <>
    <div className="h-full overflow-y-auto bg-slate-100 md:hidden">
      {mobileGroups.length > 0 ? (
        <div className="pb-4">
          {mobileGroups.map((group, groupIndex) => (
            <section key={`${group.date}:${group.entries[0]?.id ?? groupIndex}`} className={detailDateBackground ? (groupIndex % 2 === 0 ? "bg-sky-50/30" : "bg-emerald-50/30") : undefined}>
              <div className="sticky top-0 z-10 border-y border-slate-200 bg-slate-100/96 px-3 py-1.5 text-xs font-semibold text-slate-500 backdrop-blur">
                {formatDateDisplay(group.date, dateDisplayFormat)}
              </div>
              <div className="divide-y divide-slate-100 bg-white">
                {group.entries.map((entry, entryIndex) => {
                  const effectiveAmount = detailFlowAmountOf(entry);
                  const category = detailCategoryLabel(entry) || t("txForm.uncategorized");
                  const note = displayDetailRemark(entry, flowAccountIdOf(entry));
                  const related = relatedAccountTarget(entry);
                  const relatedDisplay = accountDisplayFallback(related.id, related.name);
                  const counterpart = entry.type === "transfer"
                    ? relatedDisplay.label
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
                      className={`flex min-h-[68px] w-full items-center gap-3 px-3 py-2.5 text-left ${detailDateBackground ? (entryIndex % 2 === 0 ? "bg-white/70" : "bg-white/40") : ""}`}
                    >
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold ${effectiveAmount >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                        {(entry.source === "advance" || entry.source === "reimbursement") && entry.type !== "expense"
                          ? t("txForm.advance")
                          : entry.type === "transfer"
                          ? t("detailView.badgeTransfer")
                          : entry.type === "investment"
                            ? t("detailView.badgeInvestment")
                            : effectiveAmount >= 0
                              ? t("detailView.badgeIncome")
                              : t("detailView.badgeExpense")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-900">{category}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{counterpart || note || t("detailView.noNote")}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-sm font-semibold tabular-nums ${effectiveAmount >= 0 ? inflowCls : outflowCls}`}>
                          {effectiveAmount >= 0 ? "+" : "-"}{formatEntryCurrencyMoney(entryDisplayAbsAmount(entry, Math.abs(effectiveAmount)), entry)}
                        </span>
                        {showRunningBalance && entry.runningBalance != null ? (
                          <span className="mt-0.5 block text-[11px] tabular-nums text-slate-400">{t("detailView.runningBalance", { amount: formatEntryCurrencyMoney(toNumber(entry.runningBalance), entry) })}</span>
                        ) : null}
                      </span>
                      <EntryAttachmentIndicator entry={entry} asButton={false} onClick={() => setAttachmentViewEntryId(entry.id)} />
                      <BasicDetailReconcileLockButton
                        entryId={entry.id}
                        reconciled={isReconciledEntry(entry)}
                        contextAccountId={reconcileAccountId}
                        asButton={false}
                      />
                      <span className="text-slate-300">›</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-slate-400">{resolvedEmptyText}</div>
      )}
    </div>
    <div className="hidden h-full md:block">
    <AdvancedDataTable
      storageKey={storageKey}
      resetKey={tableResetKey}
      columns={columns}
      rows={entries}
      showDateRangeFilter={showDateRangeFilter}
      dateRange={dateRange}
      onDateRangeChange={onDateRangeChange}
      dateRangeBounds={dateRangeBounds}
      dateRangeBoundsLoading={dateRangeBoundsLoading}
      initialFilters={initialFilters}
      rowKey={(entry) => entry.id}
      minTableWidth={1160}
      emptyText={resolvedEmptyText}
      selectable
      selectOnRowClick
      selectAllScope="renderedRows"
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      onRowDoubleClick={(entry) => {
        void openEntryEditor(entry, isReconciledEntry(entry));
      }}
      draggableRows={draggableRows}
      rowDragDisabled={(entry) => !canManuallyReorderDetailEntry(entry)}
      rowDropAllowed={(source, target, _sourceIndex, _targetIndex, position) => canDropDetailEntry(source, target, position)}
      rowDropTargetAtEnd={rowDropTargetAtEnd}
      onRowReorder={(source, target, _sourceIndex, _targetIndex, position) => reorderEntryByDrag(source, target, position)}
      rowActions={(entry) => {
        const { edit, customEditEvent } = buildEntryEditRequest(entry);
        const linkLabels = entry.businessLinkLabels ?? [];
        const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
        const linkTitle = hasBusinessLink
          ? t("detailView.linkedLabel", { labels: linkLabels.join("、") || t("detailView.businessRecord") })
          : t("detailView.notLinked");
        return (
          <>
            <BasicDetailReconcileLockButton
              entryId={entry.id}
              reconciled={isReconciledEntry(entry)}
              contextAccountId={reconcileAccountId}
            />
            <EntryAttachmentIndicator entry={entry} onClick={() => setAttachmentViewEntryId(entry.id)} />
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
              onEditRequest={({ reconciledReadOnly }) => openEntryEditor(entry, reconciledReadOnly)}
            />
          </>
        );
      }}
      rowActionsWidth={128}
      rowActionsMinWidth={104}
      batchActionSlot={toolbarMode === "default" ? (
        <>
          <BasicDetailBatchReplaceButton fields={batchReplaceFields} accountOptions={resolvedBatchReplaceAccountOptions} categoryOptions={categoryOptions} tagOptions={tagOptions} categoryTypes={selectedCategoryTypes} contextAccountId={accountId} contextAccountIds={accountColumnScopeIdList} />
          <BasicDetailBatchDeleteButton />
          {reconcileEnabled ? <BasicDetailBatchReconcileButton contextAccountId={reconcileAccountId} /> : null}
          {batchExtraActions?.(entries)}
        </>
      ) : undefined}
      rowClassName={(entry) => entry.id === focusEntryId
        ? "bg-amber-50 ring-1 ring-inset ring-amber-300 hover:bg-amber-50"
        : "hover:bg-blue-50/40"}
      rowBackgroundEnabled={detailDateBackground}
      rowBackgroundGroupKey={(entry) => detailEntryDayKey(entry, flowAccountIdOf(entry))}
      fillHeight
      compactRows={compactRows}
      toolbarMode={toolbarMode}
      toolbarLeftContent={customToolbarLeft}
      toolbarRightContent={toolbarRightContent}
      showTableStateInCustomToolbar={toolbarMode === "custom"}
      sortable={sortable}
      sortRows={(rows, currentSort) => {
        // The date column sorts by the canonical detail comparator so the whole
        // list mirrors with the direction: asc = day asc AND within-day asc
        // (dayOrder/createdAt asc, balance anchors last), desc = identical to
        // the server's default order. Raw timestamps alone would tie inside a
        // day and keep the desc order even in asc view.
        if (currentSort?.key !== "date") return null;
        return [...rows].sort((a, b) =>
          currentSort.direction === "asc"
            ? compareDetailEntriesAsc(a, b, isAllCashDetailScope(accountId) ? undefined : accountId)
            : compareDetailEntriesDesc(a, b, isAllCashDetailScope(accountId) ? undefined : accountId),
        );
      }}
      onDisplayRowsChange={onDisplayRowsChange}
      onRowsFitChange={onRowsFitChange}
      scrollToRowKey={scrollToRowKey}
    />
    </div>
    <EntryAttachmentWindow
      open={attachmentViewEntryId != null}
      entryId={attachmentViewEntryId}
      onClose={() => setAttachmentViewEntryId(null)}
    />
    </>
  );
}
