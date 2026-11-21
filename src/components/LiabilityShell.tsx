"use client";
import { ModalLayer } from "@/components/ModalLayer";

import { Check, ChevronDown, ChevronRight, HandCoins, Pencil, Percent, ReceiptText, RefreshCw, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountTypeQuickEdit, type AccountQuickEditValue, type LoanQuickEditValue } from "./AccountTypeQuickEdit";
import { AdvancedDataTable, ROW_ACTION_BUTTON_BOX_CLASS, type AdvancedDataTableColumn, type AdvancedDataTableSortState } from "./AdvancedDataTable";
import { DateStepper } from "./DateStepper";
import { DebitBalanceReconcileButton } from "./DebitBalanceReconcileButton";
import { dispatchEntryEdit, EntryRowActions } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchDeleteMessage,
  BasicDetailBatchReplaceButton,
  BasicDetailConvertWatcher,
  BasicDetailSelectionProvider,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
  type BasicDetailBatchCategoryOption,
} from "./BasicDetailSelection";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import {
  dispatchFinanceDataChanged,
  financeChangeTouchesEntries,
  FINANCE_DATA_CHANGED_EVENT,
  type FinanceDataChangedDetail,
} from "@/lib/client/refresh";
import { useEntryReconcileState } from "@/lib/client/use-entry-reconcile-state";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageLprSpreadFromDiscount,
  getLatestFiveYearLpr,
  MORTGAGE_BASE_BENCHMARK_RATE,
  MORTGAGE_LPR_CONVERSION_BASE_RATE,
} from "@/lib/loan-lpr";
import { calcLoanScheduledAmount, roundLoanMoney } from "@/lib/loan-repayment";
import { formatDateDisplay, todayDateLocalYmd } from "@/lib/date-utils";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";
import { resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";

// 往来明细的批量修改字段 = 表格列里可改的那些，名称一一对应（2026-11-17 用户要求）：
// 日期 / 记账日 / 类型 / 金额 / 往来款账户 / 对手账户 / 分类 / 标签 / 追加标签 / 备注。
// 「资金流向」只读：方向由金额正负决定（填负数＝调换方向），不再单独给字段。
// 表上没有「机构」列，这个字段在往来表里也一并去掉，避免改了却看不到。
const batchReplaceFields: BatchReplaceField[] = [
  "date",
  "postedAt",
  "type",
  "amount",
  "liabilityAccount",
  "counterpartyAccount",
  "categoryId",
  "tagId",
  "appendTagId",
  "remark",
];

type LiabilityRow = {
  key: string;
  name: string;
  objectType: string;
  objectName: string;
  itemName: string;
  accountId: string;
  institutionId: string;
  counterpartyId: string;
  /** Counterparty flag: only flagged objects expose the reimbursement entry. */
  counterpartyReimbursementEnabled: boolean;
  itemType: string;
  repaymentMethod: string;
  repaymentCycle: string;
  baseAnnualRate: number | null;
  annualRate: number | null;
  mortgageLprDiscount: number | null;
  loanStartDate: string;
  remainingRuns: number | null;
  paidPrincipal: number;
  paidInterest: number;
  remainingPrincipal: number;
  remainingInterest: number;
  remainingTotal: number;
  nextRepaymentDate: string;
  nextRepaymentPrincipal: number | null;
  nextRepaymentInterest: number | null;
  nextRepaymentCashAccountId: string;
  loanRateAdjustments: Array<{ effectiveDate: string; annualRate: number }>;
  payable: number;
  receivable: number;
  net: number;
  accountCount: number;
  parentKey?: string | null;
  depth?: number;
  isGroup?: boolean;
  isLoan?: boolean;
  isConsumerLoan?: boolean | null;
  loanType?: LoanTypeValue | null;
};

/** 往来款行的报销进度三步：已填报（建单关联）→ 已审核（审批金额确认）→ 已回款（打款完成）。 */
const REIMBURSEMENT_STAGES = ["submitted", "approved", "paid"] as const;
type ReimbursementStage = (typeof REIMBURSEMENT_STAGES)[number];
const REIMBURSEMENT_STAGE_INDEX: Record<ReimbursementStage, number> = {
  submitted: 0,
  approved: 1,
  paid: 2,
};

type LiabilityEntry = {
  id: string;
  date: string;
  typeLabel: string;
  collateralLabel?: string | null;
  /** 「往来款账户」：本行的往来款那一侧（贷款视图是贷款账户）；空串＝余额校准这类没有账户的行。 */
  liabilityAccountLabel: string;
  liabilityAccountTitle?: string;
  /** 「对手账户」：另一端（资金账户 / 对方账户）。 */
  counterpartyAccountLabel: string;
  counterpartyAccountTitle?: string;
  /** 「资金流向」：流出侧 → 流入侧，两端用短名（「姜爷爷 → 付斌」）。 */
  flowFromLabel: string;
  flowFromTitle?: string;
  flowToLabel: string;
  flowToTitle?: string;
  /** 两端账户：流出侧恒在前、流入侧在后（空串＝这类行没有两端账户，如余额校准）。 */
  fromAccountLabel: string;
  fromAccountTitle?: string;
  toAccountLabel: string;
  toAccountTitle?: string;
  /** 分类列：与批量修改的「分类」同一名称。 */
  categoryLabel: string;
  /** 标签列：与批量修改的「标签」同一名称。 */
  tagLabels: string[];
  /** 记账日（可隐藏列）；批量修改的「记账日」写它。 */
  postedAt: string | null;
  /** 已被报销单关联：明细行显示报销进度三步标识，悬停看到单据标题。 */
  reimbursementLink?: { id: string; title: string; stage: ReimbursementStage } | null;
  note: string;
  amount: number;
  principal: number;
  interest: number;
  paymentTotal: number | null;
  balance: number;
  balanceReconcileEdit?: {
    entryId: string;
    accountId: string;
    accountName: string;
    date: string;
    amount: number;
  };
  liabilityEdit?: {
    editEntryId: string;
    mode: "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
    defaultLiabilityAccountId: string;
    defaultLiabilityAccountName?: string | null;
    defaultCashAccountId: string;
    defaultAutoDebitCashAccountId?: string;
    defaultFixedAssetAccountId?: string;
    defaultFixedAssetAssetId?: string;
    defaultDate: string;
    defaultPrincipal: number;
    defaultInterest: number;
    defaultNote?: string | null;
    defaultPenalty?: number;
    defaultRecalculateStartDate?: string | null;
    defaultPrepayStrategy?: string;
    defaultLoanFundingMode?: "cash_disbursement" | "financed_purchase";
    defaultRepaymentMethod?: string | null;
    defaultAnnualRate?: number | null;
    defaultMortgageLprDiscount?: number | null;
    defaultRepaymentIntervalMonths?: number | null;
    defaultLoanTotalRuns?: number | null;
    defaultFirstBillDate?: string | null;
    defaultFirstRepaymentDate?: string | null;
    defaultAutoDebit?: boolean | null;
    defaultAutoDebitFirstDate?: string | null;
    defaultLoanRateAdjustments?: Array<{ effectiveDate: string; annualRate: number }>;
    defaultTagIds?: string[] | null;
    dialogType?: "settlement" | "loan";
  };
  edit?: {
    type: "expense" | "income" | "advance" | "transfer" | "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    categoryId?: string;
    counterpartyInstitutionId?: string;
    advanceAccountId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  };
};

type RepaymentScheduleRow = {
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
};

type RateAdjustmentDraft = {
  id: string;
  effectiveDate: string;
  annualRate: string;
  originalEffectiveDate?: string | null;
  originalAnnualRate?: number | null;
  isEditing?: boolean;
  isInitial?: boolean;
};

type LoanRebuildPreview = {
  startRunDate: string;
  lastRemainingDate: string | null;
  updateCount: number;
  extrasCount: number;
  preservedAmount: number | null;
  lastRemainingPayment?: number | null;
  effectiveAnnualRate: number | null;
  balanceStart: number;
  remainingRuns: number | null;
  totalRuns: number | null;
  recalcAtStart: boolean;
  prepaymentInStartPeriod: boolean;
  repaymentMethod: string | null;
  intervalMonths: number | null;
  previewPayment: number;
  previewPrincipal: number;
  previewInterest: number;
};

type AccountOption = { id: string; label: string; title?: string | null; hoverTitle?: string | null };

const EMPTY_ACCOUNT_EDIT_DATA: AccountQuickEditValue[] = [];

function accountLoanType(account: Pick<AccountQuickEditValue, "loanType" | "isConsumerLoan"> | null | undefined): LoanTypeValue {
  return resolveLoanTypeValue(account?.loanType, account?.isConsumerLoan);
}

function amountClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "strongMuted");
}

function formatRate(value: number | null, language: string) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// 由执行利率反推折扣：LPR 时代 = (利率 − LPR + 4.8) / 4.9；早期基准利率时代 = 利率 / 4.9
function inferRowLprDiscount(effectiveDate: string, annualRate: number): number | null {
  const rate = Number(annualRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const lpr = getLatestFiveYearLpr(effectiveDate);
  const discount = lpr
    ? (rate - lpr.fiveYearRate + MORTGAGE_LPR_CONVERSION_BASE_RATE) / MORTGAGE_BASE_BENCHMARK_RATE
    : rate / MORTGAGE_BASE_BENCHMARK_RATE;
  return Number.isFinite(discount) && discount > 0 && discount <= 2
    ? Math.round(discount * 10000) / 10000
    : null;
}

function formatDiscountValue(discount: number) {
  return discount.toFixed(4).replace(/\.?0+$/, "");
}

const SETTLED_LIABILITY_EPSILON = 0.005;
/** 「显示已还完」勾选状态的本地记忆键（纯设备视图状态，不进 HouseholdPreference）。 */
const SHOW_SETTLED_ROWS_STORAGE_KEY = "mmh:liability:showSettledRows";

function isSettledLiabilityRow(row: LiabilityRow) {
  return Math.abs(row.net) < SETTLED_LIABILITY_EPSILON && row.payable + row.receivable < SETTLED_LIABILITY_EPSILON;
}

function shouldShowUnpaidScheduleRow(row: RepaymentScheduleRow, todayKey: string) {
  if (row.status === "paid") return false;
  if (row.date < todayKey) return false;
  return true;
}

// 条数口径：只统计真实还款期数；利率调整行、提前还款事件行不计数。
function isScheduleRepaymentPeriodRow(row: RepaymentScheduleRow) {
  return row.rowType === "payment" && row.eventType === "repayment";
}

function repaymentScheduleRowKey(row: RepaymentScheduleRow) {
  return `${row.status ?? ""}:${row.eventType ?? ""}:${row.rowType}:${row.period}:${row.date}:${row.annualRate ?? ""}`;
}

function makeDraftId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatRateDraftValue(value: number) {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function rateDraftAnnualRateNumber(value: string) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const rate = Number(text);
  return Number.isFinite(rate) ? rate : null;
}

function makeRateDraft(
  effectiveDate: string,
  annualRate: number,
  options: Pick<RateAdjustmentDraft, "isEditing" | "isInitial"> = {},
): RateAdjustmentDraft {
  return {
    id: makeDraftId(),
    effectiveDate,
    annualRate: formatRateDraftValue(annualRate),
    originalEffectiveDate: effectiveDate,
    originalAnnualRate: annualRate,
    ...options,
  };
}

// 房贷/消费贷共用的利率调整草稿构建：
// - 空表 + 房贷折扣：先按折扣生成 LPR 历史（含放款日行）；
// - 空表：起始利率行 = 放款日（或今天）+ 初始利率；
// - 已有行：按日期升序原样映射，首行恒视为起始利率行（isInitial：日期锁定、不可删）。
function buildLoanRateDrafts(row: LiabilityRow, options: { todayKey: string; generateFromLprDiscount: boolean }) {
  if (
    options.generateFromLprDiscount &&
    row.loanRateAdjustments.length === 0 &&
    row.mortgageLprDiscount != null && row.mortgageLprDiscount > 0
  ) {
    const generated = buildMortgageLprRateAdjustments({
      discount: row.mortgageLprDiscount,
      throughDate: options.todayKey,
      fromDate: row.loanStartDate || undefined,
    }).map((item) => makeRateDraft(item.effectiveDate, item.annualRate));
    if (generated.length > 0) {
      generated[0] = { ...generated[0], isInitial: true };
      return generated;
    }
  }

  const loanDate = row.loanStartDate || row.loanRateAdjustments[0]?.effectiveDate || options.todayKey;
  if (row.loanRateAdjustments.length === 0) {
    return [makeRateDraft(loanDate, row.baseAnnualRate ?? row.annualRate ?? 0, { isInitial: true })];
  }
  const drafts = row.loanRateAdjustments.map((item) => makeRateDraft(item.effectiveDate, item.annualRate));
  if (drafts.length > 0) drafts[0] = { ...drafts[0], isInitial: true };
  return drafts;
}

function getSimpleLoanRateChangedStartDate(originalDrafts: RateAdjustmentDraft[], currentDrafts: RateAdjustmentDraft[]) {
  const normalize = (items: RateAdjustmentDraft[]) => items
    .map((item) => ({
      effectiveDate: item.effectiveDate.trim(),
      annualRate: rateDraftAnnualRateNumber(item.annualRate),
    }))
    .filter((item): item is { effectiveDate: string; annualRate: number } => (
      /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && item.annualRate != null
    ));
  const originalByDate = new Map(normalize(originalDrafts).map((item) => [item.effectiveDate, item.annualRate] as const));
  const currentByDate = new Map(normalize(currentDrafts).map((item) => [item.effectiveDate, item.annualRate] as const));
  const changedDates: string[] = [];

  for (const [date, originalRate] of originalByDate) {
    const currentRate = currentByDate.get(date);
    if (currentRate == null || Math.abs(currentRate - originalRate) >= 0.0005) changedDates.push(date);
  }
  for (const date of currentByDate.keys()) {
    if (!originalByDate.has(date)) changedDates.push(date);
  }

  return changedDates.sort((a, b) => a.localeCompare(b))[0] ?? null;
}

function hasActiveLiabilityFilters(filters: Partial<Record<string, string[]>>) {
  return Object.values(filters).some((values) => (values?.length ?? 0) > 0);
}

function liabilityRowMatchesFilters(
  row: LiabilityRow,
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<LiabilityRow>[],
) {
  for (const [key, values] of Object.entries(filters)) {
    if ((values?.length ?? 0) === 0) continue;
    const column = columns.find((item) => item.key === key);
    if (!column?.filterText) continue;
    const value = column.filterText(row)?.trim() || "-";
    if (!values?.includes(value)) return false;
  }
  return true;
}

function compareLiabilitySortValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
) {
  const leftEmpty = left == null || left === "";
  const rightEmpty = right == null || right === "";
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }
  return typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function collectLiabilityChildrenByParentKey(rows: LiabilityRow[]) {
  const childrenByParentKey = new Map<string, LiabilityRow[]>();
  for (const row of rows) {
    if (!row.parentKey) continue;
    const children = childrenByParentKey.get(row.parentKey) ?? [];
    children.push(row);
    childrenByParentKey.set(row.parentKey, children);
  }
  return childrenByParentKey;
}

function buildLiabilityTreeRows(
  rows: LiabilityRow[],
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<LiabilityRow>[],
  expandedKeys: ReadonlySet<string>,
) {
  const filtersActive = hasActiveLiabilityFilters(filters);
  const childrenByParentKey = collectLiabilityChildrenByParentKey(rows);
  const output: LiabilityRow[] = [];

  for (const row of rows) {
    if (row.parentKey) continue;
    const children = childrenByParentKey.get(row.key) ?? [];
    if (!row.isGroup) {
      if (!filtersActive || liabilityRowMatchesFilters(row, filters, columns)) output.push(row);
      continue;
    }

    if (!filtersActive) {
      output.push(row);
      if (expandedKeys.has(row.key)) output.push(...children);
      continue;
    }

    const rowMatches = liabilityRowMatchesFilters(row, filters, columns);
    const matchingChildren = children.filter((child) => liabilityRowMatchesFilters(child, filters, columns));
    if (!rowMatches && matchingChildren.length === 0) continue;
    output.push(row);
    output.push(...(rowMatches ? children : matchingChildren));
  }

  return output;
}

function sortLiabilityTreeRows(
  rows: LiabilityRow[],
  sortState: AdvancedDataTableSortState | null,
  columns: AdvancedDataTableColumn<LiabilityRow>[],
) {
  if (!sortState) return rows;
  const column = columns.find((item) => item.key === sortState.key);
  const readValue = column?.sortValue ?? column?.filterText;
  if (!readValue) return rows;

  const direction = sortState.direction === "asc" ? 1 : -1;
  const originalIndexByKey = new Map(rows.map((row, index) => [row.key, index]));
  const compareRows = (left: LiabilityRow, right: LiabilityRow) => {
    const compared = compareLiabilitySortValues(readValue(left), readValue(right));
    if (compared !== 0) return compared * direction;
    return (originalIndexByKey.get(left.key) ?? 0) - (originalIndexByKey.get(right.key) ?? 0);
  };
  const childrenByParentKey = collectLiabilityChildrenByParentKey(rows);
  const sortedRows: LiabilityRow[] = [];
  const topRows = rows.filter((row) => !row.parentKey).sort(compareRows);
  for (const row of topRows) {
    sortedRows.push(row);
    const children = childrenByParentKey.get(row.key);
    if (children?.length) sortedRows.push(...[...children].sort(compareRows));
  }
  return sortedRows;
}

export function LiabilityShell({
  rows,
  selectedKey,
  entries,
  repaymentScheduleRows,
  summaryRemainingTotal,
  isRedUp,
  accountOptions,
  categoryOptions,
  accountEditData = EMPTY_ACCOUNT_EDIT_DATA,
  selectedLoanType = null,
  loanEditAction,
}: {
  rows: LiabilityRow[];
  selectedKey: string;
  entries: LiabilityEntry[];
  repaymentScheduleRows: RepaymentScheduleRow[];
  summaryRemainingTotal: number;
  totalPayable: number;
  totalReceivable: number;
  isRedUp: boolean;
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  accountEditData?: AccountQuickEditValue[];
  selectedLoanType?: LoanTypeValue | null;
  loanEditAction: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
}) {
  const router = useRouter();
  const { t, language } = useI18n();
  const todayKey = todayDateLocalYmd();
  const [detailTab, setDetailTab] = useState<"entries" | "schedule">("entries");
  const [showPaidScheduleRows, setShowPaidScheduleRows] = useState(false);
  const [rateCardOpen, setRateCardOpen] = useState(false);
  const [rateSaving, setRateSaving] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<RateAdjustmentDraft[]>([]);
  const [rebuildDialog, setRebuildDialog] = useState<{ effectiveDate: string; preview: LoanRebuildPreview } | null>(null);
  const [rebuildRemainingRuns, setRebuildRemainingRuns] = useState("");
  const [rebuildBusy, setRebuildBusy] = useState(false);
  // 「显示已还完」是用户自己的视图开关，不该由选中行决定：以前只要选中的是已结清对象
  // 就会自动勾上，刷新后永远勾着（2026-11-17 用户报的）。默认收起，用户勾选后记在本机。
  const [showSettledRows, setShowSettledRows] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SHOW_SETTLED_ROWS_STORAGE_KEY);
      if (stored != null) setShowSettledRows(stored === "1");
    } catch {
      // 隐私模式下 localStorage 可能抛错，保持默认收起即可。
    }
  }, []);
  const [expandedLiabilityRowKeys, setExpandedLiabilityRowKeys] = useState<Set<string>>(() => new Set());
  const [editingLiabilityAccount, setEditingLiabilityAccount] = useState<AccountQuickEditValue | null>(null);
  const [editingLoanDetails, setEditingLoanDetails] = useState<LoanQuickEditValue | null>(null);
  const [accountEditOpenSignal, setAccountEditOpenSignal] = useState(0);
  const [pendingLoanEditAccountId, setPendingLoanEditAccountId] = useState<string | null>(null);
  /** 贷款账户「编辑」落到余额校准弹窗的一次性请求（见 openLiabilityAccountProperties）。 */
  const [pendingLoanReconcileEdit, setPendingLoanReconcileEdit] = useState<{
    accountId: string;
    entryId?: string;
    date?: string;
    amount?: number;
  } | null>(null);
  const rowClickTimerRef = useRef<number | null>(null);
  /** 最近一次在表格里自己点选的行；它不该触发「滚到选中行」。 */
  const selfSelectedRowKeyRef = useRef<string | null>(null);
  /** 需要把某一行滚进视口的一次性请求（键 + 递增 id，同一行也能再次请求）。 */
  const [rowScrollRequest, setRowScrollRequest] = useState<{ key: string; id: number } | null>(null);
  // 收起「显示已还完」时直接过滤掉已结清行；是否展开只由用户勾选决定，
  // 不再由选中的行反向改写这个开关（见上面的 showSettledRows 说明）。
  // 例外：点名选中的行始终保留——从设置页 / 侧边栏点一个余额为 0 的贷款账户进来时，
  // 行被滤掉会让页面回退到第一条往来款行（#30 第 3 条）。
  const baseRows = useMemo(
    () => (showSettledRows
      ? rows
      : rows.filter((row) => !isSettledLiabilityRow(row) || row.key === selectedKey)),
    [rows, selectedKey, showSettledRows],
  );
  const childrenByParentKey = useMemo(() => collectLiabilityChildrenByParentKey(baseRows), [baseRows]);
  const safeAccountEditData = Array.isArray(accountEditData) ? accountEditData : EMPTY_ACCOUNT_EDIT_DATA;
  const accountEditDataById = useMemo(
    () => new Map(safeAccountEditData.map((account) => [account.id, account])),
    [safeAccountEditData],
  );
  // Loan-only views switch table wording to loan-specific columns and hide item names.
  const displayedNonGroupRows = useMemo(() => baseRows.filter((row) => !row.isGroup), [baseRows]);
  const isLoanTableView = useMemo(
    () => !!selectedLoanType || (displayedNonGroupRows.length > 0 && displayedNonGroupRows.every((row) => row.isLoan === true)),
    [displayedNonGroupRows, selectedLoanType],
  );
  const loanViewType = useMemo<LoanTypeValue | null>(() => {
    if (selectedLoanType) return selectedLoanType;
    if (!isLoanTableView || displayedNonGroupRows.length === 0) return null;
    const firstLoanRow = displayedNonGroupRows[0];
    if (firstLoanRow.loanType) return firstLoanRow.loanType;
    const account = accountEditDataById.get(firstLoanRow.accountId);
    return accountLoanType(account);
  }, [accountEditDataById, displayedNonGroupRows, isLoanTableView, selectedLoanType]);
  const loanViewTypeLabel = loanViewType
    ? t(`loan.type.${loanViewType}`)
    : "";
  const selectedRow =
    baseRows.find((row) => row.key === selectedKey) ??
    rows.find((row) => row.key === selectedKey) ??
    null;
  const remainingTotalLabel = selectedLoanType || selectedRow?.objectType === "银行贷款"
    ? t("liabilityShell.remainingTotal.payable")
    : selectedRow?.objectType === "银行应收"
      ? t("liabilityShell.remainingTotal.receivable")
      : t("liabilityShell.remainingTotal.both");
  const settledCount = rows.filter((row) => !row.parentKey && isSettledLiabilityRow(row)).length;
  const isSelectedBankLoan = !!selectedRow && !selectedRow.isGroup && selectedRow.isLoan === true;
  const canRepaySelectedRow = !!selectedRow && !selectedRow.isGroup && selectedRow.net < -SETTLED_LIABILITY_EPSILON;
  const selectedRowLoanType = selectedRow?.loanType ?? null;
  // Collateral (抵押物) is a mortgage-loan-only field: the borrow dialog only
  // links collateral assets for loanType="mortgage" accounts.
  const isSelectedCollateralLoan = isSelectedBankLoan && selectedRowLoanType === "mortgage";
  const isSelectedConsumerLoan = selectedRowLoanType === "consumer" || selectedRow?.isConsumerLoan === true;
  const isSelectedMortgageLoan = isSelectedBankLoan && !isSelectedConsumerLoan && (
    selectedRowLoanType == null || selectedRowLoanType === "home"
  );
  const canAdjustRateSelectedRow = isSelectedBankLoan && canRepaySelectedRow && !!selectedRow?.accountId && (
    isSelectedMortgageLoan || isSelectedConsumerLoan
  );
  const filterLiabilityRows = useCallback((
    tableRows: LiabilityRow[],
    filters: Partial<Record<string, string[]>>,
    columns: AdvancedDataTableColumn<LiabilityRow>[],
  ) => buildLiabilityTreeRows(tableRows, filters, columns, expandedLiabilityRowKeys), [expandedLiabilityRowKeys]);
  const sortLiabilityRows = useCallback((
    tableRows: LiabilityRow[],
    sortState: AdvancedDataTableSortState | null,
    columns: AdvancedDataTableColumn<LiabilityRow>[],
  ) => sortLiabilityTreeRows(tableRows, sortState, columns), []);
  const toggleLiabilityRowExpanded = useCallback((rowKey: string) => {
    setExpandedLiabilityRowKeys((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);
  const visibleRepaymentScheduleRows = useMemo(
    () => showPaidScheduleRows
      ? repaymentScheduleRows
      : repaymentScheduleRows.filter((row) => shouldShowUnpaidScheduleRow(row, todayKey)),
    [repaymentScheduleRows, showPaidScheduleRows, todayKey],
  );
  const schedulePeriodCounts = useMemo(() => {
    let visible = 0;
    for (const row of visibleRepaymentScheduleRows) {
      if (isScheduleRepaymentPeriodRow(row)) visible += 1;
    }
    let total = 0;
    for (const row of repaymentScheduleRows) {
      if (isScheduleRepaymentPeriodRow(row)) total += 1;
    }
    return { visible, total };
  }, [repaymentScheduleRows, visibleRepaymentScheduleRows]);
  // 勾选“显示已还”后，把视口定位到当前月份的还款记录上。
  const repaymentScrollAnchorKey = useMemo(() => {
    if (!showPaidScheduleRows) return null;
    const periodRows = visibleRepaymentScheduleRows.filter(isScheduleRepaymentPeriodRow);
    if (periodRows.length === 0) return null;
    const monthPrefix = todayKey.slice(0, 7);
    const anchorRow = periodRows.find((row) => row.date.startsWith(monthPrefix))
      ?? periodRows.find((row) => row.date >= todayKey)
      ?? periodRows[periodRows.length - 1];
    return repaymentScheduleRowKey(anchorRow);
  }, [showPaidScheduleRows, todayKey, visibleRepaymentScheduleRows]);
  const liabilityRowSummary = useMemo(() => {
    const summaryRows = baseRows.filter((row) => !row.parentKey);
    const net = summaryRows.reduce((sum, row) => sum + row.net, 0);
    return {
      paidPrincipal: summaryRows.reduce((sum, row) => sum + Math.abs(row.paidPrincipal), 0),
      paidInterest: summaryRows.reduce((sum, row) => sum + Math.abs(row.paidInterest), 0),
      remainingPrincipal: Math.abs(net),
      remainingInterest: summaryRows.reduce((sum, row) => sum + Math.abs(row.remainingInterest), 0),
      remainingTotal: Math.abs(summaryRemainingTotal),
      net,
    };
  }, [baseRows, summaryRemainingTotal]);
  useEffect(() => {
    return () => {
      if (rowClickTimerRef.current) {
        window.clearTimeout(rowClickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    if (!selected?.parentKey) return;
    setExpandedLiabilityRowKeys((current) => {
      if (current.has(selected.parentKey ?? "")) return current;
      const next = new Set(current);
      next.add(selected.parentKey ?? "");
      return next;
    });
  }, [rows, selectedKey]);

  /**
   * 从别处带着 liabilityPerson 进来（费用报销的「返回至往来款」、侧边栏、账户设置页）时，
   * 把选中的那一行滚进视口并居中 —— 否则用户回到本页只看到表头和第一行，得自己去找。
   * 表内自己点出来的选中不滚（点的那行本来就在眼前，滚一下反而跳）。
   */
  useEffect(() => {
    if (!selectedKey) return;
    if (selfSelectedRowKeyRef.current === selectedKey) {
      selfSelectedRowKeyRef.current = null;
      return;
    }
    setRowScrollRequest((current) => ({ key: selectedKey, id: (current?.id ?? 0) + 1 }));
  }, [selectedKey]);

  useEffect(() => {
    if (!isSelectedBankLoan && detailTab === "schedule") {
      setDetailTab("entries");
    }
  }, [detailTab, isSelectedBankLoan]);

  /**
   * 往来款视图的行、余额和明细全部由 RSC（page.tsx）算好传进来，本组件没有自己的取数
   * 通道：记账 / 编辑 / 删除 / 转换之后只能让服务端重算一遍。少了这一步，转成支出后
   * 提示「原记录已删除」、明细表里那条还在、往来对象和顶部汇总也停在旧余额
   * （2026-11-17 用户报的就是这个）。
   */
  useEffect(() => {
    let timer: number | null = null;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail ?? {};
      // 行情 / 净值 / 开机巡检不改明细行，不用重算整页。
      if (!financeChangeTouchesEntries(detail)) return;
      const eventAccountIds = detail.accountIds ?? [];
      if (eventAccountIds.length > 0) {
        // 带了影响域就只认本页这些往来款 / 贷款账户，别因为别处记一笔就整页重取。
        const scope = new Set(rows.map((row) => row.accountId).filter(Boolean));
        if (!eventAccountIds.some((id) => scope.has(id))) return;
      }
      // 一次转换会连发两次事件（目标交易保存 + 删除原记录），合并成一次刷新。
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        router.refresh();
      }, 80);
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [router, rows]);

  const loanSetupEditForAccount = useCallback((accountId: string): LoanQuickEditValue | null => {
    const entry = entries
      .filter((item) => (
        item.liabilityEdit?.dialogType === "loan" &&
        item.liabilityEdit.mode === "borrow_in" &&
        item.liabilityEdit.defaultLiabilityAccountId === accountId
      ))
      .sort((left, right) => left.date.localeCompare(right.date))[0];
    if (!entry?.liabilityEdit) return null;
    const account = accountEditDataById.get(accountId);
    return {
      ...entry.liabilityEdit,
      mode: "borrow_in",
      dialogType: "loan",
      loanType: accountLoanType(account),
    };
  }, [accountEditDataById, entries]);

  /**
   * 贷款账户没有借款记录（例如新建账户时只填了初始余额）时，可编辑的只有那条余额初始化行。
   * 明细里它的编辑动作是 mmh:balance-reconcile:edit，放到余额校准按钮里统一处理。
   */
  const balanceReconcileEditForAccount = useCallback((accountId: string) => {
    const entry = entries.find((item) => item.balanceReconcileEdit?.accountId === accountId);
    return entry?.balanceReconcileEdit ?? null;
  }, [entries]);

  /** 打开余额校准弹窗：有余额初始化行就带着它一起填，没有就开空白的「校准当前余额」。 */
  const openLoanReconcileFor = useCallback((accountId: string) => {
    const reconcile = balanceReconcileEditForAccount(accountId);
    setPendingLoanReconcileEdit(
      reconcile
        ? { accountId: reconcile.accountId, entryId: reconcile.entryId, date: reconcile.date, amount: reconcile.amount }
        : { accountId, date: todayKey },
    );
  }, [balanceReconcileEditForAccount, todayKey]);

  useEffect(() => {
    if (!pendingLoanEditAccountId) return;
    // 明细行属于当前选中行；行还没切过来时 entries 还是上一行的，等选中行变了再判断。
    if (selectedRow?.accountId !== pendingLoanEditAccountId) return;
    const account = accountEditDataById.get(pendingLoanEditAccountId);
    if (!account) return;
    setPendingLoanEditAccountId(null);
    const detail = loanSetupEditForAccount(pendingLoanEditAccountId);
    if (detail) {
      setEditingLiabilityAccount(account);
      setEditingLoanDetails(detail);
      setAccountEditOpenSignal((value) => value + 1);
      return;
    }
    openLoanReconcileFor(pendingLoanEditAccountId);
  }, [
    accountEditDataById,
    loanSetupEditForAccount,
    openLoanReconcileFor,
    pendingLoanEditAccountId,
    selectedRow?.accountId,
  ]);

  const handleReconcileEditRequestHandled = useCallback(() => {
    setPendingLoanReconcileEdit(null);
  }, []);

  function openLiabilityRow(row: LiabilityRow) {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
    }
    selfSelectedRowKeyRef.current = row.key;
    rowClickTimerRef.current = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("view", "liability");
      params.set("liabilityPerson", row.key);
      router.push(`/?${params.toString()}`, { scroll: false });
      rowClickTimerRef.current = null;
    }, 360);
  }

  const openLiabilityAccountProperties = useCallback((row: LiabilityRow) => {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
      rowClickTimerRef.current = null;
    }
    if (row.isGroup) {
      toggleLiabilityRowExpanded(row.key);
      return;
    }
    if (row.isLoan && row.accountId) {
      const account = accountEditDataById.get(row.accountId);
      if (!account) return;
      const detail = loanSetupEditForAccount(row.accountId);
      if (detail) {
        setEditingLiabilityAccount(account);
        setEditingLoanDetails(detail);
        setAccountEditOpenSignal((value) => value + 1);
        return;
      }
      // 行已经选中：明细就在手边，直接开余额校准，不必再 push 一次同值 URL 等 RSC 回包。
      if (selectedRow?.accountId === row.accountId) {
        openLoanReconcileFor(row.accountId);
        return;
      }
      setPendingLoanEditAccountId(row.accountId);
      const params = new URLSearchParams(window.location.search);
      params.set("view", "liability");
      params.set("liabilityPerson", row.key);
      router.push(`/?${params.toString()}`, { scroll: false });
      return;
    }
    const account = row.accountId ? accountEditDataById.get(row.accountId) : null;
    if (!account) return;
    setEditingLiabilityAccount(account);
    setEditingLoanDetails(null);
    setAccountEditOpenSignal((value) => value + 1);
  }, [
    accountEditDataById,
    loanSetupEditForAccount,
    openLoanReconcileFor,
    router,
    selectedRow?.accountId,
    toggleLiabilityRowExpanded,
  ]);

  function openRateAdjustment(row: LiabilityRow) {
    if (!row.accountId) return;
    const rowLoanType = row.loanType ?? null;
    const isConsumerLoanRow = rowLoanType === "consumer" || row.isConsumerLoan === true;
    const isHomeLoanRow = row.isConsumerLoan !== true && (rowLoanType == null || rowLoanType === "home");
    if (!isHomeLoanRow && !isConsumerLoanRow) return;
    setRateDrafts(buildLoanRateDrafts(row, { todayKey, generateFromLprDiscount: isHomeLoanRow }));
    setRateCardOpen(true);
  }

  function addRateDraft() {
    setRateDrafts((items) => [
      ...items,
      {
        id: makeDraftId(),
        effectiveDate: todayKey,
        annualRate: "",
        originalEffectiveDate: null,
        originalAnnualRate: null,
        isEditing: true,
      },
    ]);
  }

  // 查询最新 5 年期 LPR：比表格里最新一行更新才新增一行，执行利率按折扣推算
  // （LPR + 加点，加点 = 4.9×折扣 − 4.8；折扣优先取借款备注里的值，否则由最后一行反推）。
  async function queryLatestLpr() {
    if (rateSaving) return;
    setRateSaving(true);
    try {
      const response = await fetch("/api/v1/loan-lpr/latest", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data.data?.date || !Number.isFinite(Number(data.data.rate))) {
        window.alert(data?.error || t("liabilityShell.rateAdjust.lprQueryFailed"));
        return;
      }
      const quoteDate: string = data.data.date;
      const lprRate: number = Number(data.data.rate);
      const latestRowDate = rateDrafts.reduce((max, item) => (
        item.effectiveDate.trim() > max ? item.effectiveDate.trim() : max
      ), "");
      if (quoteDate <= latestRowDate) {
        window.alert(t("liabilityShell.rateAdjust.lprUpToDate", { date: quoteDate }));
        return;
      }
      const lastFilled = [...rateDrafts].reverse().find((item) => (
        /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate.trim()) && rateDraftAnnualRateNumber(item.annualRate) != null
      ));
      const lastRowRate = lastFilled ? rateDraftAnnualRateNumber(lastFilled.annualRate) : null;
      const discount = selectedRow?.mortgageLprDiscount != null && selectedRow.mortgageLprDiscount > 0
        ? selectedRow.mortgageLprDiscount
        : (lastFilled && lastRowRate != null ? inferRowLprDiscount(lastFilled.effectiveDate, lastRowRate) : null);
      const annualRate = discount != null && discount > 0
        ? lprRate + calcMortgageLprSpreadFromDiscount(discount)
        : lprRate;
      setRateDrafts((prev) => [
        ...prev,
        {
          id: makeDraftId(),
          effectiveDate: quoteDate,
          annualRate: formatRateDraftValue(Math.round(annualRate * 1000) / 1000),
          originalEffectiveDate: null,
          originalAnnualRate: null,
          isEditing: false,
        },
      ]);
    } finally {
      setRateSaving(false);
    }
  }

  function updateRateDraft(id: string, patch: Partial<RateAdjustmentDraft>) {
    setRateDrafts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function deleteRateDraft(id: string) {
    setRateDrafts((items) => items.filter((item) => item.id !== id));
  }

  function saveRateDraftRow(id: string) {
    const target = rateDrafts.find((item) => item.id === id);
    if (!target) return;
    const effectiveDate = target.effectiveDate.trim();
    const annualRate = rateDraftAnnualRateNumber(target.annualRate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || annualRate == null || annualRate < 0) {
      window.alert(t("liabilityShell.alert.rateDraftInvalid"));
      return;
    }
    const duplicate = rateDrafts.some((item) => (
      item.id !== id &&
      (item.effectiveDate.trim() || item.annualRate.trim()) &&
      item.effectiveDate.trim() === effectiveDate
    ));
    if (duplicate) {
      window.alert(t("liabilityShell.alert.rateDraftDuplicateDate", { date: effectiveDate }));
      return;
    }
    updateRateDraft(id, {
      effectiveDate,
      annualRate: formatRateDraftValue(annualRate),
      isEditing: false,
    });
  }

  // 房贷/消费贷共用的利率调整草稿表：房贷多一列折扣，其余交互完全一致。
  function renderRateDraftsTable(options: { showDiscountColumn: boolean }) {
    const columnCount = options.showDiscountColumn ? 4 : 3;
    return (
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="max-h-[260px] overflow-y-auto">
          <table className="min-w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
              <tr>
                <th className={`${options.showDiscountColumn ? "w-[28%]" : "w-[38%]"} px-3 py-2 text-left`}>{t("liabilityShell.rateAdjust.effectiveDate")}</th>
                <th className={`${options.showDiscountColumn ? "w-[22%]" : "w-[32%]"} px-3 py-2 text-right`}>{t("liabilityShell.rateAdjust.annualRateLabel")}</th>
                {options.showDiscountColumn ? (
                  <th className="w-[16%] px-3 py-2 text-right">{t("liabilityShell.rateAdjust.discountLabel")}</th>
                ) : null}
                <th className={`${options.showDiscountColumn ? "w-[28%]" : "w-[30%]"} px-3 py-2 text-right`}>{t("detail.column.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rateDrafts.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="px-3 py-8 text-center text-sm text-slate-500">
                    {t("liabilityShell.rateAdjust.empty")}
                  </td>
                </tr>
              ) : rateDrafts.map((item) => {
                const draftRate = rateDraftAnnualRateNumber(item.annualRate);
                // 首行（放款日）利率 = 执行利率×折扣，不能由 LPR+加点反推，
                // 折扣列直接用贷款的 LPR 折扣；无折扣时退回按行反推。
                const draftDiscount = !options.showDiscountColumn || draftRate == null
                  ? null
                  : (item.isInitial && selectedRow?.mortgageLprDiscount != null
                      ? selectedRow.mortgageLprDiscount
                      : inferRowLprDiscount(item.effectiveDate, draftRate));
                return (
                  <tr key={item.id} className={item.isEditing ? "bg-amber-50/50" : item.isInitial ? "bg-blue-50/50" : "bg-white"}>
                    <td className="px-3 py-2 align-middle">
                      {item.isEditing && !item.isInitial ? (
                        <DateStepper
                          value={item.effectiveDate}
                          onChange={(value) => updateRateDraft(item.id, { effectiveDate: value })}
                        />
                      ) : (
                        <span className="tabular-nums text-slate-700">{item.effectiveDate}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right align-middle">
                      {item.isEditing ? (
                        <input
                          value={item.annualRate}
                          onChange={(event) => updateRateDraft(item.id, { annualRate: event.target.value })}
                          inputMode="decimal"
                          placeholder={t("liabilityShell.rateAdjust.annualRatePlaceholder")}
                          className="form-input text-right"
                        />
                      ) : (
                        <span className="tabular-nums text-slate-700">{formatRate(draftRate, language)}</span>
                      )}
                    </td>
                    {options.showDiscountColumn ? (
                      <td className="px-3 py-2 text-right align-middle text-xs tabular-nums text-slate-600" title={t("liabilityShell.rateAdjust.discountTitle")}>
                        {draftDiscount != null ? formatDiscountValue(draftDiscount) : "-"}
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-right align-middle">
                      <div className="inline-flex items-center gap-1.5">
                        {item.isEditing ? (
                          <button
                            type="button"
                            onClick={() => saveRateDraftRow(item.id)}
                            className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-emerald-600 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50`}
                            disabled={rateSaving}
                            title={t("common.save")}
                            aria-label={t("common.save")}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => updateRateDraft(item.id, { isEditing: true })}
                            className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50`}
                            disabled={rateSaving}
                            title={t("common.edit")}
                            aria-label={t("common.edit")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => { void openRebuildDialogForDate(item.effectiveDate); }}
                          className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50`}
                          disabled={rebuildBusy || rateSaving}
                          title={t("liabilityShell.rebuild.buttonTitle")}
                          aria-label={t("liabilityShell.recalc")}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRateDraft(item.id)}
                          className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50`}
                          disabled={rateSaving || item.isInitial}
                          title={item.isInitial ? t("liabilityShell.rateAdjust.initialDeleteDisabled") : t("common.delete")}
                          aria-label={t("common.delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  async function recalculateRepaymentPlanFromDate(accountId: string, startDate: string) {
    const response = await fetch("/api/v1/loan-repayment/recalculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, startDate }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      window.alert(data?.error || t("liabilityShell.error.recalculateFailed"));
      return;
    }
    window.alert(formatLoanRecalculateSuccessMessage(data.data));
    dispatchFinanceDataChanged({ reason: "loan-repayment-recalculate", accountIds: [accountId] });
  }

  async function openRebuildDialogForDate(effectiveDate: string) {
    const accountId = selectedRow?.accountId;
    if (!accountId || rebuildBusy || rateSaving) return;
    setRebuildBusy(true);
    try {
      const response = await fetch("/api/v1/loan-repayment/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          fromDate: effectiveDate,
          dryRun: true,
          ...(rebuildRemainingRuns.trim() ? { remainingRuns: Number.parseInt(rebuildRemainingRuns.trim(), 10) } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("liabilityShell.error.rebuildFailed"));
        return;
      }
      const preview = data.data as LoanRebuildPreview;
      setRebuildDialog({ effectiveDate, preview });
    } finally {
      setRebuildBusy(false);
    }
  }

  const rebuildPreviewRefreshRef = useRef<number | null>(null);
  function changeRebuildFromDate(nextDate: string) {
    if (!rebuildDialog) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate.trim())) return;
    setRebuildDialog((dialog) => dialog ? { ...dialog, effectiveDate: nextDate } : dialog);
    if (rebuildPreviewRefreshRef.current) window.clearTimeout(rebuildPreviewRefreshRef.current);
    const accountId = selectedRow?.accountId;
    if (!accountId) return;
    rebuildPreviewRefreshRef.current = window.setTimeout(() => {
      void (async () => {
        if (rebuildBusy) return;
        setRebuildBusy(true);
        try {
          const response = await fetch("/api/v1/loan-repayment/rebuild", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountId,
              fromDate: nextDate,
              dryRun: true,
              ...(rebuildRemainingRuns.trim() ? { remainingRuns: Number.parseInt(rebuildRemainingRuns.trim(), 10) } : {}),
            }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.ok) return;
          const preview = data.data as LoanRebuildPreview;
          setRebuildDialog((prev) => prev && prev.effectiveDate === nextDate ? { effectiveDate: nextDate, preview } : prev);
        } finally {
          setRebuildBusy(false);
        }
      })();
    }, 300);
  }

  async function confirmRebuild() {
    const dialog = rebuildDialog;
    const accountId = selectedRow?.accountId;
    if (!dialog || !accountId || rebuildBusy) return;
    const remainingRunsText = rebuildRemainingRuns.trim();
    let remainingRuns: number | null = null;
    if (remainingRunsText) {
      const parsed = Number.parseInt(remainingRunsText, 10);
      if (!Number.isFinite(parsed) || String(parsed) !== remainingRunsText || parsed < 1 || parsed > 600) {
        window.alert(t("liabilityShell.rebuild.invalidRemainingRuns"));
        return;
      }
      remainingRuns = parsed;
    }
    setRebuildBusy(true);
    try {
      const response = await fetch("/api/v1/loan-repayment/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          fromDate: dialog.effectiveDate,
          dryRun: false,
          ...(remainingRuns != null ? { remainingRuns } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("liabilityShell.error.rebuildFailed"));
        return;
      }
      window.alert(t("liabilityShell.rebuild.successMessage", {
        date: data.data.startRunDate,
        count: data.data.updateCount,
        payment: formatMoney(data.data.previewPayment ?? 0),
      }));
      setRebuildDialog(null);
      dispatchFinanceDataChanged({ reason: "loan-repayment-rebuild", accountIds: [accountId] });
    } finally {
      setRebuildBusy(false);
    }
  }

  const rebuildPreviewParts = useMemo(() => {
    const dialog = rebuildDialog;
    if (!dialog) return null;
    const preview = dialog.preview;
    const runsText = rebuildRemainingRuns.trim();
    const runs = runsText ? Number.parseInt(runsText, 10) : Number.NaN;
    if (
      preview.recalcAtStart &&
      !preview.prepaymentInStartPeriod &&
      Number.isFinite(runs) &&
      runs >= 1 &&
      preview.effectiveAnnualRate != null
    ) {
      const payment = calcLoanScheduledAmount({
        repaymentMethod: preview.repaymentMethod,
        annualRate: preview.effectiveAnnualRate,
        principal: preview.balanceStart,
        totalRuns: runs,
        intervalMonths: preview.intervalMonths ?? 1,
      });
      if (payment != null && payment > 0) {
        const intervalMonths = preview.intervalMonths ?? 1;
        const interest = roundLoanMoney((preview.balanceStart * (preview.effectiveAnnualRate / 100) / 12) * intervalMonths);
        return { payment, principal: Math.max(0, roundLoanMoney(payment - interest)), interest };
      }
    }
    return {
      payment: preview.previewPayment,
      principal: preview.previewPrincipal,
      interest: preview.previewInterest,
    };
  }, [rebuildDialog, rebuildRemainingRuns]);

  async function saveRateAdjustments() {
    if (!selectedRow?.accountId || rateSaving) return;
    const filledRateDrafts = rateDrafts
      .filter((item) => item.effectiveDate.trim() || item.annualRate.trim());
    const adjustments = filledRateDrafts
      .map((item) => ({
        effectiveDate: item.effectiveDate.trim(),
        annualRate: item.annualRate.trim() ? Number(item.annualRate) : Number.NaN,
      }));
    const duplicateDates = new Set<string>();
    for (const item of adjustments) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) || !Number.isFinite(item.annualRate) || item.annualRate < 0) {
        window.alert(t("liabilityShell.alert.rateDraftInvalid"));
        return;
      }
      if (duplicateDates.has(item.effectiveDate)) {
        window.alert(t("liabilityShell.alert.rateDraftDuplicateDate", { date: item.effectiveDate }));
        return;
      }
      duplicateDates.add(item.effectiveDate);
    }
    const changedStartDate = !isSelectedMortgageLoan
      ? getSimpleLoanRateChangedStartDate(buildLoanRateDrafts(selectedRow, { todayKey, generateFromLprDiscount: false }), filledRateDrafts)
      : null;

    setRateSaving(true);
    try {
      const response = await fetch("/api/v1/loan-rate-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedRow.accountId,
          adjustments,
          mortgageLprDiscount: isSelectedMortgageLoan && selectedRow?.mortgageLprDiscount != null
            ? selectedRow.mortgageLprDiscount
            : null,
          loanStartDate: selectedRow.loanStartDate || null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("liabilityShell.error.saveRateAdjustmentsFailed"));
        return;
      }
      setRateCardOpen(false);
      dispatchFinanceDataChanged({ reason: "loan-rate-adjustment", accountIds: [selectedRow.accountId] });
      if (changedStartDate) {
        const accepted = await showConfirmDialog({
          title: t("liabilityShell.rateAdjust.recalculateTitle"),
          message: t("liabilityShell.rateAdjust.recalculateMessage", { date: changedStartDate }),
          confirmLabel: t("liabilityShell.recalc.confirm"),
          cancelLabel: t("liabilityShell.recalc.skip"),
        });
        if (accepted) {
          await recalculateRepaymentPlanFromDate(selectedRow.accountId, changedStartDate);
        }
      }
    } finally {
      setRateSaving(false);
    }
  }

  const rowColumns = useMemo<AdvancedDataTableColumn<LiabilityRow>[]>(() => [
    {
      key: "objectType",
      label: isLoanTableView ? t("liabilityShell.colName") : t("liabilityShell.colObjectType"),
      width: isLoanTableView ? 180 : 112,
      minWidth: isLoanTableView ? 120 : 84,
      filterText: (row) => (isLoanTableView ? row.name : row.objectType),
      sortValue: (row) => (isLoanTableView ? row.name : row.objectType),
      render: (row) => (
        <span className={`block truncate ${amountClass(row.net, isRedUp)}`} title={isLoanTableView ? row.name : row.objectType}>
          {isLoanTableView ? row.name : row.objectType}
        </span>
      ),
    },
    {
      key: "objectName",
      label: isLoanTableView ? t("liabilityShell.colLoanInstitution") : t("liabilityShell.colObject"),
      width: 180,
      minWidth: 120,
      filterText: (row) => row.objectName,
      sortValue: (row) => row.objectName,
      render: (row) => {
        const childCount = row.isGroup ? childrenByParentKey.get(row.key)?.length ?? 0 : 0;
        const expanded = expandedLiabilityRowKeys.has(row.key);
        return (
          <span
            className={`flex min-w-0 items-center truncate text-sm ${row.isGroup ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}
            style={{ paddingLeft: `${Math.max(0, row.depth ?? 0) * 18}px` }}
            title={row.objectName || row.name}
          >
            {childCount > 0 ? (
              <button
                type="button"
                className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                title={t(expanded ? "common.collapse" : "common.expand")}
                aria-label={t(expanded ? "common.collapse" : "common.expand")}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleLiabilityRowExpanded(row.key);
                }}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            ) : row.depth ? (
              <span className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-300">└</span>
            ) : (
              <span className="mr-1 h-5 w-5 shrink-0" />
            )}
            <span className="truncate">{row.objectName || "-"}</span>
          </span>
        );
      },
    },
    ...(isLoanTableView
      ? []
      : [{
          key: "itemName",
          label: t("liabilityShell.colItem"),
          width: 190,
          minWidth: 120,
          filterText: (row) => row.itemName,
          sortValue: (row) => row.itemName,
          render: (row) => (
            <span className={`block truncate ${row.isGroup ? "font-medium text-slate-800" : "text-slate-700"}`} title={row.name}>
              {row.itemName || "-"}
            </span>
          ),
        }]),
    {
      key: "repaymentMethod",
      label: t("liabilityShell.colRepaymentMethod"),
      width: 140,
      minWidth: 100,
      hideable: true,
      filterText: (row) => row.repaymentMethod || "-",
      sortValue: (row) => row.repaymentMethod || "",
      render: (row) => <span className="text-slate-600">{row.repaymentMethod || "-"}</span>,
    },
    {
      key: "annualRate",
      label: t("liabilityShell.colAnnualRate"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      sortValue: (row) => row.annualRate,
      render: (row) => <span className="tabular-nums text-slate-600">{formatRate(row.annualRate, language)}</span>,
    },
    {
      key: "remainingRuns",
      label: t("liabilityShell.colRemainingRuns"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      sortValue: (row) => row.remainingRuns,
      render: (row) => <span className="tabular-nums text-slate-600">{row.remainingRuns == null ? "-" : row.remainingRuns}</span>,
    },
    {
      key: "paidPrincipal",
      label: t("liabilityShell.colPaidPrincipal"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.paidPrincipal),
      render: (row) => <span className="tabular-nums text-emerald-700">{formatMoney(Math.abs(row.paidPrincipal))}</span>,
    },
    {
      key: "paidInterest",
      label: t("liabilityShell.colPaidInterest"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.paidInterest),
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.paidInterest))}</span>,
    },
    {
      key: "remainingInterest",
      label: t("liabilityShell.colRemainingInterest"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.remainingInterest),
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.remainingInterest))}</span>,
    },
    {
      key: "remainingPrincipal",
      label: t("liabilityShell.colRemainingPrincipal"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.remainingPrincipal),
      render: (row) => <span className="tabular-nums text-slate-700">{formatMoney(Math.abs(row.remainingPrincipal))}</span>,
    },
    {
      key: "remainingTotal",
      label: remainingTotalLabel,
      width: 150,
      minWidth: 112,
      align: "right",
      sortValue: (row) => Math.abs(row.remainingTotal),
      render: (row) => <span className={`font-semibold tabular-nums ${amountClass(row.net, isRedUp)}`}>{formatMoney(Math.abs(row.remainingTotal))}</span>,
    },
    {
      key: "actions",
      label: t("detail.column.actions"),
      width: 64,
      minWidth: 56,
      align: "center",
      render: (row) => (
        <div className="flex items-center justify-center gap-1">
          {row.accountId ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openLiabilityAccountProperties(row);
              }}
              title={t("liabilityShell.editRow")}
              aria-label={t("liabilityShell.editRow")}
              className={`${ROW_ACTION_BUTTON_BOX_CLASS} border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-blue-600`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ),
    },
  ], [t, language, isRedUp, remainingTotalLabel, childrenByParentKey, expandedLiabilityRowKeys, toggleLiabilityRowExpanded, isLoanTableView, loanViewTypeLabel, openLiabilityAccountProperties]);

  const entryColumns = useMemo<AdvancedDataTableColumn<LiabilityEntry>[]>(() => {
    const columns: AdvancedDataTableColumn<LiabilityEntry>[] = [
      { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
      {
        key: "type",
        label: t("liabilityShell.colType"),
        width: 110,
        minWidth: 70,
        hideable: true,
        // 报销进度也参与筛选：搜「已审核」「已回款」能把这些行（含已走到该步的行）挑出来。
        // 进度标识本身画在操作栏（报销徽章按钮），类型列只保留类型文字。
        filterText: (entry) => {
          const link = entry.reimbursementLink;
          if (!link) return entry.typeLabel;
          const stageIndex = REIMBURSEMENT_STAGE_INDEX[link.stage];
          return `${entry.typeLabel} ${REIMBURSEMENT_STAGES.slice(0, stageIndex + 1).map((stage) => t(`liabilityShell.reimbursementStage.${stage}`)).join(" ")}`;
        },
        render: (entry) => <span className="block truncate text-slate-700">{entry.typeLabel}</span>,
      },
      {
        // 账户口径（2026-11-17 用户要求）：不再按「流出 / 流入」列账户——那是资金方向，
        // 借入与借出时往来款账户所在的一侧正好相反。表头固定成三列：
        // 往来款账户（本行往来款那一侧）→ 对手账户（另一端）→ 资金流向（谁 → 谁）。
        // 这三列的名称与批量修改里的字段一一对应。
        key: "liabilityAccount",
        label: isLoanTableView ? t("liabilityShell.colLoanAccount") : t("liabilityShell.colLiabilityAccount"),
        width: 160,
        minWidth: 96,
        hideable: true,
        filterText: (entry) => entry.liabilityAccountLabel,
        render: (entry) => (
          <span className="block truncate text-slate-700" title={entry.liabilityAccountTitle || undefined}>{entry.liabilityAccountLabel || "-"}</span>
        ),
      },
      {
        key: "counterpartyAccount",
        label: t("liabilityShell.colCounterpartyAccount"),
        width: 160,
        minWidth: 96,
        filterText: (entry) => entry.counterpartyAccountLabel,
        render: (entry) => (
          <span className="block truncate text-slate-600" title={entry.counterpartyAccountTitle || undefined}>{entry.counterpartyAccountLabel || "-"}</span>
        ),
      },
      {
        key: "flowDirection",
        label: t("liabilityShell.colFlowDirection"),
        width: 170,
        minWidth: 110,
        filterText: (entry) => `${entry.flowFromLabel} ${entry.flowToLabel}`,
        render: (entry) => {
          // 只有一端账户的行（收入/支出直接记在往来款账户上）就只显示那一端，不画箭头。
          const hasBoth = Boolean(entry.flowFromLabel && entry.flowToLabel);
          if (!hasBoth && !entry.flowFromLabel && !entry.flowToLabel) return <span className="text-slate-400">-</span>;
          const title = entry.flowFromTitle && entry.flowToTitle
            ? `${entry.flowFromTitle} → ${entry.flowToTitle}`
            : `${entry.flowFromLabel || entry.flowFromTitle || ""} → ${entry.flowToLabel || entry.flowToTitle || ""}`;
          if (!hasBoth) {
            return (
              <span className="block truncate text-slate-600" title={title.replace(" → ", "")}>
                {entry.flowFromLabel || entry.flowToLabel}
              </span>
            );
          }
          return (
            <span className="flex min-w-0 items-center gap-1 text-slate-600" title={title}>
              <span className="truncate">{entry.flowFromLabel}</span>
              <span className="shrink-0 text-slate-400">→</span>
              <span className="truncate">{entry.flowToLabel}</span>
            </span>
          );
        },
      },
    ];
    // 抵押物是抵押贷款专属字段：往来款/房贷/消费贷明细不展示该列。
    if (isSelectedCollateralLoan) {
      columns.push({
        key: "collateral",
        label: t("liabilityShell.colCollateral"),
        width: 140,
        minWidth: 100,
        hideable: true,
        filterText: (entry) => entry.collateralLabel ?? "",
        render: (entry) => <span className="block truncate text-slate-600" title={entry.collateralLabel ?? ""}>{entry.collateralLabel || "-"}</span>,
      });
    }
    columns.push(
      {
        key: "amount",
        // 金额列只放数值：方向已经在「资金流向」列（谁 → 谁）里说清楚了，
        // 有两端账户的行不再写正负号；没有两端账户的行（余额校准等）保留正负号。
        // 颜色跟「资金账户的现金走向」走（`principal` 就是现金视角：>0 钱流进资金账户、
        // <0 流出），即与明细页同一规则 —— 资金进来是红色（红涨绿跌时），
        // 并且跟随「红涨绿跌 / 绿涨红跌」设置，不再写死红绿（2026-11-17 用户裁定）。
        label: t("liabilityShell.colAmount"),
        width: 130,
        minWidth: 96,
        align: "right",
        // 金额表头筛选按「范围」（最小~最大）：取渲染出来的金额大小（绝对值），
        // 与资金流向列显示的值一致；无金额（principal=0，渲染为 "-"）的行不参与。
        // 排序仍按带符号值分组（见下方 sortValue），二者口径不同是刻意的。
        filterKind: "numberRange",
        filterText: (entry) => entry.principal === 0 ? "" : String(Math.abs(entry.principal)),
        filterNumber: (entry) => entry.principal === 0 ? null : Math.abs(entry.principal),
        // 排序按带符号的值：负数（钱流向往来款账户）与正数（流回资金账户）分组，
        // 而不是把两者折成同一个「金额大小」再排（2026-11-17 用户裁定）。
        sortValue: (entry) => entry.principal,
        render: (entry) => {
          if (entry.principal === 0) return <span className="text-slate-400">-</span>;
          const hasFlow = Boolean(entry.flowFromLabel && entry.flowToLabel);
          const magnitude = formatMoney(Math.abs(entry.principal));
          return (
            <span className={`font-semibold tabular-nums ${pnlClassFromRedUp(entry.principal, isRedUp, "strong")}`}>
              {hasFlow ? magnitude : `${entry.principal > 0 ? "+" : "-"}${magnitude}`}
            </span>
          );
        },
      },
      {
        key: "interest",
        label: t("liabilityShell.colInterest"),
        width: 110,
        minWidth: 80,
        align: "right",
        hideable: true,
        render: (entry) => <span className="tabular-nums text-amber-700">{entry.interest ? formatMoney(entry.interest) : "-"}</span>,
      },
      {
        key: "paymentTotal",
        label: isSelectedBankLoan ? t("liabilityShell.colPaymentTotalLoan") : t("liabilityShell.colPaymentTotalInflow"),
        width: 120,
        minWidth: 92,
        align: "right",
        hideable: true,
        filterText: (entry) => entry.paymentTotal == null ? "-" : entry.paymentTotal.toFixed(2),
        // 着色与金额列同一口径：往来款视图这一列是「收款合计」（钱流进资金账户）→ 红；
        // 贷款视图是「还款合计」（钱流出资金账户）→ 用 invert 取到流出色（绿）。
        render: (entry) => {
          if (entry.paymentTotal == null) return <span className="text-slate-400">-</span>;
          const total = entry.paymentTotal;
          return (
            <span className={`font-semibold tabular-nums ${total === 0 ? "text-slate-500" : pnlClassFromRedUp(total, isRedUp, "strong", isSelectedBankLoan)}`}>
              {formatMoney(total)}
            </span>
          );
        },
      },
      { key: "balance", label: t("liabilityShell.colBalance"), width: 130, minWidth: 92, align: "right", sortValue: (entry) => entry.balance, render: (entry) => <span className={`font-semibold tabular-nums ${amountClass(entry.balance, isRedUp)}`}>{formatMoney(entry.balance)}</span> },
      // 分类 / 标签 / 记账日三列：批量修改里能改这三项，就必须在表上看得见同名的一列，
      // 否则「能改的东西」和「显示的东西」对不上（2026-11-17 用户要求）。
      {
        key: "category",
        label: t("detail.column.category"),
        width: 140,
        minWidth: 96,
        hideable: true,
        filterText: (entry) => entry.categoryLabel,
        render: (entry) => <span className="block truncate text-slate-600" title={entry.categoryLabel}>{entry.categoryLabel || "-"}</span>,
      },
      {
        key: "tags",
        label: t("detail.column.tags"),
        width: 160,
        minWidth: 96,
        hideable: true,
        filterText: (entry) => entry.tagLabels.join(" "),
        render: (entry) => entry.tagLabels.length === 0
          ? <span className="text-slate-400">-</span>
          : (
            <span className="flex min-w-0 flex-wrap items-center gap-1" title={entry.tagLabels.join("、")}>
              {entry.tagLabels.map((label) => (
                <span key={label} className="max-w-[7rem] truncate rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{label}</span>
              ))}
            </span>
          ),
      },
      {
        key: "postedAt",
        label: t("detail.column.postedAt"),
        width: 100,
        minWidth: 80,
        hideable: true,
        defaultHidden: true,
        filterKind: "dateRange",
        filterText: (entry) => entry.postedAt ?? "",
        render: (entry) => <span className="tabular-nums text-slate-500">{entry.postedAt ? formatDateDisplay(entry.postedAt) : "-"}</span>,
      },
      { key: "note", label: t("detail.column.remark"), width: 260, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    );
    return columns;
  }, [t, isRedUp, isLoanTableView, isSelectedBankLoan, isSelectedCollateralLoan]);

  const repaymentScheduleColumns = useMemo<AdvancedDataTableColumn<RepaymentScheduleRow>[]>(() => [
    {
      key: "status",
      label: t("liabilityShell.colStatus"),
      width: 82,
      minWidth: 64,
      filterText: (row) => row.rowType === "rate_adjustment" ? t("liabilityShell.rateAdjustment") : row.status === "paid" ? t("liabilityShell.paid") : t("liabilityShell.planned"),
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="text-blue-700">{t("liabilityShell.rate")}</span>
        : row.status === "paid"
          ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{t("liabilityShell.paid")}</span>
          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{t("liabilityShell.planned")}</span>,
    },
    {
      key: "eventType",
      label: t("liabilityShell.colType"),
      width: 100,
      minWidth: 78,
      filterText: (row) => row.rowType === "rate_adjustment" ? t("liabilityShell.rateAdjustment") : row.eventType === "prepayment" ? t("liabilityShell.prepayment") : t("liabilityShell.repayment"),
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="font-medium text-blue-700">{t("liabilityShell.rateAdjustment")}</span>
        : row.eventType === "prepayment"
          ? <span className="font-medium text-amber-700">{t("liabilityShell.prepayment")}</span>
          : <span className="text-slate-700">{t("liabilityShell.repayment")}</span>,
    },
    { key: "period", label: t("liabilityShell.colPeriod"), width: 80, minWidth: 64, align: "right", render: (row) => row.rowType === "rate_adjustment" || row.eventType === "prepayment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-slate-700">{row.period}</span> },
    { key: "date", label: t("detail.column.date"), width: 110, minWidth: 86, filterText: (row) => row.date, render: (row) => <span className="tabular-nums text-slate-700">{row.date}</span> },
    { key: "principal", label: t("liabilityShell.colPrincipal"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="tabular-nums text-blue-700">{formatRate(row.annualRate, language)}</span> : <span className="tabular-nums text-emerald-700">{formatMoney(row.principal)}</span> },
    { key: "interest", label: t("liabilityShell.colInterest"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-amber-700">{formatMoney(row.interest)}</span> },
    { key: "payment", label: t("liabilityShell.colPayment"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="font-medium text-blue-700">{t("liabilityShell.rateAdjustment")}</span> : <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.payment)}</span> },
    { key: "remainingPrincipal", label: t("liabilityShell.colRemainingPrincipal"), width: 140, minWidth: 104, align: "right", render: (row) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.remainingPrincipal)}</span> },
  ], [t, language]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      {editingLiabilityAccount ? (
        <AccountTypeQuickEdit
          account={editingLiabilityAccount}
          accountLabel={editingLiabilityAccount.name}
          openSignal={accountEditOpenSignal}
          showTrigger={false}
          loanDetails={editingLoanDetails}
          loanEditAction={loanEditAction}
        />
      ) : null}
      <ResizableVerticalSplit
        storageKey="mmh:liability:split-height"
        hasLowerPane={!!selectedRow}
        defaultUpperHeight={360}
        separatorLabel={t("liabilityShell.resizeLabel")}
        separatorTitle={t("liabilityShell.resizeTitle")}
      >
        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <AdvancedDataTable
            storageKey="mmh_liability_rows_table_v1"
            columns={rowColumns}
            rows={baseRows}
            rowKey={(row) => row.key}
            minTableWidth={1040}
            emptyText={t("liabilityShell.emptyRows")}
            fillHeight
            scrollToRowKey={rowScrollRequest?.key ?? null}
            scrollToRowRequestId={rowScrollRequest?.id}
            filterRows={filterLiabilityRows}
            sortRows={sortLiabilityRows}
            toolbarTitle={(
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <HandCoins className="h-4 w-4 text-amber-500" />
                {isLoanTableView && loanViewTypeLabel ? loanViewTypeLabel : t("liabilityShell.title")}
              </span>
            )}
            toolbarRightContent={(
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={showSettledRows}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setShowSettledRows(next);
                    try {
                      window.localStorage.setItem(SHOW_SETTLED_ROWS_STORAGE_KEY, next ? "1" : "0");
                    } catch {
                      // 隐私模式下写不进去，本次会话内仍然生效。
                    }
                  }}
                  className="h-3.5 w-3.5 accent-blue-600"
                />
                {t("liabilityShell.showSettledRows")}{settledCount > 0 ? `(${settledCount})` : ""}
              </label>
            )}
            onRowClick={(row) => openLiabilityRow(row)}
            onRowDoubleClick={(row) => openLiabilityAccountProperties(row)}
            rowClassName={(row) => {
              if (row.key === (selectedRow?.key ?? "")) return "cursor-pointer bg-blue-50 hover:bg-blue-50";
              if (row.parentKey) return "cursor-pointer bg-slate-50/70 hover:bg-slate-100";
              return "cursor-pointer hover:bg-slate-50";
            }}
            summaryRow={{
              rowClassName: "bg-slate-50",
              cellClassName: "py-2.5",
              cells: {
                name: <span className="font-semibold tracking-[0.08em] text-slate-500">{t("liabilityShell.summaryRow")}</span>,
                paidPrincipal: <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(liabilityRowSummary.paidPrincipal)}</span>,
                paidInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(liabilityRowSummary.paidInterest)}</span>,
                remainingInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(liabilityRowSummary.remainingInterest)}</span>,
                remainingPrincipal: <span className="font-semibold tabular-nums text-slate-700">{formatMoney(liabilityRowSummary.remainingPrincipal)}</span>,
                remainingTotal: <span className="font-semibold tabular-nums text-slate-700">{formatMoney(liabilityRowSummary.remainingTotal)}</span>,
              },
            }}
          />
        </section>

        <section className="panel-surface flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          {isSelectedBankLoan ? <div className="panel-header">
            {isSelectedBankLoan ? (
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5">
                <button
                  type="button"
                  onClick={() => setDetailTab("entries")}
                  className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "entries" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  {t("liabilityShell.tabEntries")}
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTab("schedule")}
                  className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "schedule" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  {t("liabilityShell.tabSchedule")}
                </button>
              </div>
            ) : <div />}
            <div className="flex min-w-0 items-center gap-2">
              {isSelectedBankLoan ? (
                <>
                  <button
                    type="button"
                    disabled={!canAdjustRateSelectedRow}
                    onClick={() => selectedRow && openRateAdjustment(selectedRow)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                    title={canAdjustRateSelectedRow ? t("liabilityShell.rateAdjust.title") : t("liabilityShell.rateAdjust.disabledTitle")}
                  >
                    <Percent className="h-3.5 w-3.5" />
                    {t("liabilityShell.rateAdjustment")}
                  </button>
                </>
              ) : null}
            </div>
          </div> : null}

          {!selectedRow ? (
            <div className="flex min-h-0 flex-1 items-center justify-center border-t border-slate-100 bg-slate-50/60 px-4 text-sm text-slate-500">
              {t("liabilityShell.selectRowFirst")}
            </div>
          ) : detailTab === "entries" || !isSelectedBankLoan ? (
            <BasicDetailSelectionProvider resetKey={`liability-entries:${selectedRow.key}`}>
              <BasicDetailBatchDeleteMessage />
              {/* 转换成功后删除原记录：Watcher 必须在选中区之内常驻，不能跟着按钮卸载。 */}
              <BasicDetailConvertWatcher />
              <LiabilityEntriesTable
                accountOptions={accountOptions}
                categoryOptions={categoryOptions}
                contextAccountId={selectedRow.accountId}
                // 组合行没有单个 accountId，但它下面的每个往来款账户都在本页明细里：
                // 把这些账户一起交给批量接口，才能按「当前页面」判定每行哪一端是往来款账户。
                contextAccountIds={
                  selectedRow.isGroup
                    ? (childrenByParentKey.get(selectedRow.key) ?? []).map((child) => child.accountId).filter(Boolean)
                    : undefined
                }
                columns={entryColumns}
                entries={entries}
                isLoanTableView={isLoanTableView}
                loanType={accountLoanType(accountEditDataById.get(selectedRow.accountId))}
                toolbarActions={(
                  <>
                    {!selectedRow.isGroup && !selectedRow.isLoan && selectedRow.counterpartyId && selectedRow.counterpartyReimbursementEnabled ? (
                      <button
                        type="button"
                        onClick={() => router.push(`/reimbursements?accountId=${encodeURIComponent(selectedRow.accountId)}`)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
                        title={t("reimburse.modalTitle")}
                      >
                        <ReceiptText className="h-3.5 w-3.5" />
                        {t("reimburse.entry")}
                      </button>
                    ) : null}
                    {/*
                      贷款账户也要挂这个按钮：新建贷款账户时填的「初始余额」在明细里是一条
                      余额初始化行，它的编辑动作派发 mmh:balance-reconcile:edit，没有监听方
                      就点了没反应（2026-11-19 #30 第 2 条）。
                    */}
                    {!selectedRow.isGroup && selectedRow.accountId ? (
                      <DebitBalanceReconcileButton
                        accountId={selectedRow.accountId}
                        accountLabel={selectedRow.name}
                        currentBalance={selectedRow.net}
                        editRequest={
                          pendingLoanReconcileEdit?.accountId === selectedRow.accountId
                            ? pendingLoanReconcileEdit
                            : null
                        }
                        onEditRequestHandled={handleReconcileEditRequestHandled}
                      />
                    ) : null}
                  </>
                )}
              />
            </BasicDetailSelectionProvider>
          ) : (
            <AdvancedDataTable
              storageKey="mmh_liability_repayment_schedule_table_v1"
              columns={repaymentScheduleColumns}
              rows={visibleRepaymentScheduleRows}
              rowKey={repaymentScheduleRowKey}
              scrollToRowKey={repaymentScrollAnchorKey}
              minTableWidth={920}
              emptyText={t("liabilityShell.emptySchedule")}
              fillHeight
              toolbarMode="custom"
              toolbarLeftContent={(
                <span>
                  {showPaidScheduleRows
                    ? t("liabilityShell.scheduleVisibleCount", { visible: schedulePeriodCounts.visible, total: schedulePeriodCounts.total })
                    : t("liabilityShell.scheduleUnpaidCount", { count: schedulePeriodCounts.visible })}
                </span>
              )}
              toolbarRightContent={(
                <label className="flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={showPaidScheduleRows}
                    onChange={(event) => setShowPaidScheduleRows(event.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  {t("liabilityShell.showPaid")}
                </label>
              )}
              rowClassName={(row) => row.rowType === "rate_adjustment"
                ? "bg-blue-50 hover:bg-blue-50"
                : row.status === "paid"
                  ? "bg-emerald-50/40 hover:bg-emerald-50"
                  : ""}
            />
          )}
        </section>
      </ResizableVerticalSplit>

        {rateCardOpen ? (
          <ModalLayer className="app-modal-backdrop">
            <div className="app-modal-panel max-w-2xl">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{t("liabilityShell.rateAdjustment")}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedRow?.name ?? t("liabilityShell.currentLoan")}</div>
                </div>
                <button title={t("table.close")} aria-label={t("table.close")}
                  type="button"
                  onClick={() => setRateCardOpen(false)}
                  className="secondary-button inline-flex h-8 w-8 shrink-0 items-center justify-center px-0"
                  disabled={rateSaving}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                  {t(isSelectedMortgageLoan ? "liabilityShell.rateAdjust.hint" : "liabilityShell.rateAdjust.simpleHint")}
                </div>

                {renderRateDraftsTable({ showDiscountColumn: isSelectedMortgageLoan })}

                <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                  <div className="flex items-center gap-2">
                    {isSelectedMortgageLoan ? (
                      <button
                        type="button"
                        onClick={() => { void queryLatestLpr(); }}
                        className="secondary-button h-9 px-3"
                        disabled={rateSaving}
                        title={t("liabilityShell.rateAdjust.queryLprTitle")}
                      >
                        {t("liabilityShell.rateAdjust.queryLpr")}
                      </button>
                    ) : null}
                    {isSelectedMortgageLoan ? null : (
                      <button
                        type="button"
                        onClick={addRateDraft}
                        className="secondary-button h-9 px-3"
                        disabled={rateSaving}
                      >
                        {t("liabilityShell.rateAdjust.addRow")}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { void saveRateAdjustments(); }}
                    className="primary-button h-9 px-3"
                    disabled={rateSaving}
                  >
                    {rateSaving ? t("liabilityShell.saving") : t("liabilityShell.saveRateAdjustments")}
                  </button>
                </div>
              </div>
            </div>
          </ModalLayer>
        ) : null}

        {rebuildDialog ? (
          <ModalLayer className="app-modal-backdrop">
            <div className="app-modal-panel max-w-md">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{t("liabilityShell.rebuild.title")}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {t("liabilityShell.rebuild.subtitle", { date: rebuildDialog.effectiveDate })} · {selectedRow?.name ?? t("liabilityShell.currentLoan")}
                  </div>
                </div>
                <button title={t("table.close")} aria-label={t("table.close")}
                  type="button"
                  onClick={() => setRebuildDialog(null)}
                  className="secondary-button inline-flex h-8 w-8 shrink-0 items-center justify-center px-0"
                  disabled={rebuildBusy}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {t("liabilityShell.rebuild.intro", { count: rebuildDialog.preview.updateCount })}
                </div>

                <div className="space-y-1">
                  <div className="form-label">{t("liabilityShell.rebuild.startPeriod")}</div>
                  <DateStepper
                    value={rebuildDialog.effectiveDate}
                    onChange={(value) => changeRebuildFromDate(value)}
                  />
                  <div className="text-[11px] leading-5 text-slate-500">{t("liabilityShell.rebuild.startPeriodHint")}</div>
                </div>

                <div className="space-y-1 text-xs text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>{t("liabilityShell.rebuild.startPeriod")}</span>
                    <span className="tabular-nums text-slate-800">{rebuildDialog.preview.startRunDate}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("liabilityShell.rebuild.balanceStart")}</span>
                    <span className="tabular-nums text-slate-800">{formatMoney(rebuildDialog.preview.balanceStart)}</span>
                  </div>
                  {rebuildDialog.preview.effectiveAnnualRate != null ? (
                    <div className="flex items-center justify-between">
                      <span>{t("liabilityShell.rebuild.effectiveRate")}</span>
                      <span className="tabular-nums text-slate-800">{formatRate(rebuildDialog.preview.effectiveAnnualRate, language)}%</span>
                    </div>
                  ) : null}
                  {rebuildDialog.preview.preservedAmount != null && !rebuildDialog.preview.recalcAtStart ? (
                    <div className="flex items-center justify-between">
                      <span>{t("liabilityShell.rebuild.preservedAmount")}</span>
                      <span className="tabular-nums text-slate-800">
                        {formatMoney(rebuildDialog.preview.lastRemainingPayment ?? rebuildDialog.preview.preservedAmount)}
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <div className="form-label">{t("liabilityShell.rebuild.remainingRunsLabel")}</div>
                  <input
                    value={rebuildRemainingRuns}
                    onChange={(event) => setRebuildRemainingRuns(event.target.value)}
                    inputMode="numeric"
                    className="form-input"
                  />
                  <div className="text-[11px] leading-5 text-slate-500">{t("liabilityShell.rebuild.remainingRunsHint")}</div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">{t("liabilityShell.rebuild.newPaymentLabel")}</span>
                    <span className="text-sm font-semibold tabular-nums text-slate-900">{formatMoney(rebuildPreviewParts?.payment ?? rebuildDialog.preview.previewPayment)}</span>
                  </div>
                  <div className="mt-1 text-right text-[11px] tabular-nums text-slate-500">
                    {t("liabilityShell.rebuild.newPaymentDetail", {
                      principal: formatMoney(rebuildPreviewParts?.principal ?? rebuildDialog.preview.previewPrincipal),
                      interest: formatMoney(rebuildPreviewParts?.interest ?? rebuildDialog.preview.previewInterest),
                    })}
                  </div>
                  <div className="mt-1 text-[11px] leading-5 text-slate-500">
                    {rebuildDialog.preview.recalcAtStart
                      ? t("liabilityShell.rebuild.recalcNote")
                      : t("liabilityShell.rebuild.preserveNote")}
                  </div>
                </div>
              </div>

              <div className="modal-footer flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 p-4">
                <button
                  type="button"
                  onClick={() => setRebuildDialog(null)}
                  className="secondary-button h-9 px-3"
                  disabled={rebuildBusy}
                >
                  {t("liabilityShell.rebuild.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => { void confirmRebuild(); }}
                  className="primary-button h-9 px-3"
                  disabled={rebuildBusy}
                >
                  {rebuildBusy ? t("liabilityShell.rebuild.busy") : t("liabilityShell.rebuild.confirm")}
                </button>
              </div>
            </div>
          </ModalLayer>
        ) : null}

      </div>
  );
}

function LiabilityEntriesTable({
  accountOptions,
  categoryOptions,
  contextAccountId,
  contextAccountIds,
  columns,
  entries,
  isLoanTableView,
  loanType,
  toolbarActions,
}: {
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  contextAccountId?: string | null;
  /** 组合行的子账户：页面上下文可能是多个往来款账户。 */
  contextAccountIds?: string[];
  columns: AdvancedDataTableColumn<LiabilityEntry>[];
  entries: LiabilityEntry[];
  /** 贷款视图：表头叫「贷款账户」，批量字段也要跟着改名，两处才对得上。 */
  isLoanTableView?: boolean;
  loanType: LoanTypeValue;
  toolbarActions?: React.ReactNode;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const currentEntryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  usePruneBasicDetailSelection(currentEntryIds);
  // 负债明细行就是背后的现金流水：现金明细页锁定的记录，这里同样要显示锁并能就地解锁。
  const { isReconciled } = useEntryReconcileState(currentEntryIds);
  const normalizedAccountOptions = useMemo(
    () => accountOptions.map((account) => ({
      id: account.id,
      label: account.label,
      title: account.title ?? account.hoverTitle ?? undefined,
    })),
    [accountOptions],
  );
  const getCustomEditEvent = (entry: LiabilityEntry) => {
    if (entry.balanceReconcileEdit) {
      return { name: "mmh:balance-reconcile:edit", detail: { ...entry.balanceReconcileEdit } };
    }
    if (!entry.liabilityEdit) return undefined;
    const detail = entry.liabilityEdit.dialogType === "loan"
      ? { ...entry.liabilityEdit, loanType }
      : { ...entry.liabilityEdit };
    return {
      name: entry.liabilityEdit.dialogType === "loan" ? "mmh:loan:create" : "mmh:settlement:create",
      detail,
    };
  };

  return (
    <AdvancedDataTable
      storageKey="mmh_liability_entries_table_v1"
      resetKey={`liability-entries:${contextAccountId ?? "all"}`}
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1240}
      emptyText={t("liabilityShell.emptyEntries")}
      fillHeight
      toolbarTitle={t("liabilityShell.tabEntries")}
      toolbarRightContent={(
        <>
          {toolbarActions}
          <span className="text-xs text-slate-500">{t("liabilityShell.entryCount", { count: entries.length })}</span>
        </>
      )}
      selectable
      selectOnRowClick
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      onRowDoubleClick={(entry) => {
        const customEditEvent = getCustomEditEvent(entry);
        dispatchEntryEdit({
          entryId: entry.id,
          edit: entry.edit,
          customEditEvent,
        });
      }}
      rowClassName={() => "hover:bg-blue-50/40"}
      rowActions={(entry) => (
        <>
          {entry.reimbursementLink ? (
            <button
              type="button"
              onClick={() => {
                if (contextAccountId) {
                  router.push(`/reimbursements?accountId=${encodeURIComponent(contextAccountId)}`);
                }
              }}
              className="inline-flex h-6 shrink-0 items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium leading-4 text-emerald-700 transition hover:bg-emerald-100"
              title={`${t("liabilityShell.reimbursementLinkedHint", { title: entry.reimbursementLink.title })} · ${REIMBURSEMENT_STAGES.slice(0, REIMBURSEMENT_STAGE_INDEX[entry.reimbursementLink.stage] + 1).map((stage) => t(`liabilityShell.reimbursementStage.${stage}`)).join("›")}`}
              aria-label={t("reimburse.entry")}
            >
              {t(`liabilityShell.reimbursementStage.${entry.reimbursementLink.stage}`)}
            </button>
          ) : null}
          <EntryRowActions
            entryId={entry.id}
            edit={entry.edit}
            customEditEvent={getCustomEditEvent(entry)}
            reconciled={isReconciled(entry.id)}
          />
        </>
      )}
      rowActionsWidth={148}
      rowActionsMinWidth={124}
      batchActionSlot={(
        <>
          <BasicDetailBatchReplaceButton
            accountOptions={normalizedAccountOptions}
            categoryOptions={categoryOptions}
            contextAccountId={contextAccountId}
            contextAccountIds={contextAccountIds}
            // 字段名 = 表头名，一一对应（2026-11-17）。表里没有的列（如机构）不出现。
            fields={batchReplaceFields}
            // 贷款视图的表头是「贷款账户」，批量字段沿用同一个名字。
            fieldLabelOverrides={isLoanTableView ? { liabilityAccount: t("liabilityShell.colLoanAccount") } : undefined}
            // 本表金额的符号就是资金方向：负数会把这一行整体翻成反方向。
            fieldHintOverrides={{ amount: t("liabilityShell.batchAmountHint") }}
          />
          <BasicDetailBatchDeleteButton recordLabel={t("liabilityShell.recordLabel")} />
        </>
      )}
    />
  );
}
