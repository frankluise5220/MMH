"use client";

import { ChevronDown, ChevronRight, HandCoins, Percent, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountTypeQuickEdit, type AccountQuickEditValue } from "./AccountTypeQuickEdit";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSortState } from "./AdvancedDataTable";
import { DateStepper } from "./DateStepper";
import { DebitBalanceReconcileButton } from "./DebitBalanceReconcileButton";
import { dispatchEntryEdit, EntryRowActions } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchDeleteMessage,
  BasicDetailBatchReplaceButton,
  BasicDetailSelectionProvider,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
  type BasicDetailBatchCategoryOption,
} from "./BasicDetailSelection";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageLprSpreadFromDiscount,
  MORTGAGE_BASE_BENCHMARK_RATE,
  MORTGAGE_LPR_CONVERSION_BASE_RATE,
} from "@/lib/loan-lpr";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";

type DebtRow = {
  key: string;
  name: string;
  objectType: string;
  objectName: string;
  itemName: string;
  accountId: string;
  institutionId: string;
  counterpartyId: string;
  itemType: string;
  repaymentMethod: string;
  repaymentCycle: string;
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
};

type DebtEntry = {
  id: string;
  date: string;
  typeLabel: string;
  relatedAccountLabel: string;
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
  debtEdit?: {
    editEntryId: string;
    mode: "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
    defaultDebtAccountId: string;
    defaultCashAccountId: string;
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
    defaultFirstRepaymentDate?: string | null;
    defaultAutoDebit?: boolean | null;
    defaultAutoDebitFirstDate?: string | null;
    defaultLoanRateAdjustments?: Array<{ effectiveDate: string; annualRate: number }>;
    dialogType?: "debt" | "loan";
  };
  edit?: {
    type: "expense" | "income" | "advance" | "transfer" | "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    categoryId?: string;
    counterpartyInstitutionId?: string;
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
};

type AccountOption = { id: string; label: string; title?: string | null; hoverTitle?: string | null };

const EMPTY_ACCOUNT_EDIT_DATA: AccountQuickEditValue[] = [];

function amountClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "strongMuted");
}

function formatRate(value: number | null, language: string) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

const SETTLED_DEBT_EPSILON = 0.005;

function isSettledDebtRow(row: DebtRow) {
  return Math.abs(row.net) < SETTLED_DEBT_EPSILON && row.payable + row.receivable < SETTLED_DEBT_EPSILON;
}

function makeDraftId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatRateDraftValue(value: number) {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function hasActiveDebtFilters(filters: Partial<Record<string, string[]>>) {
  return Object.values(filters).some((values) => (values?.length ?? 0) > 0);
}

function debtRowMatchesFilters(
  row: DebtRow,
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<DebtRow>[],
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

function compareDebtSortValues(
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

function collectDebtChildrenByParentKey(rows: DebtRow[]) {
  const childrenByParentKey = new Map<string, DebtRow[]>();
  for (const row of rows) {
    if (!row.parentKey) continue;
    const children = childrenByParentKey.get(row.parentKey) ?? [];
    children.push(row);
    childrenByParentKey.set(row.parentKey, children);
  }
  return childrenByParentKey;
}

function buildDebtTreeRows(
  rows: DebtRow[],
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<DebtRow>[],
  expandedKeys: ReadonlySet<string>,
) {
  const filtersActive = hasActiveDebtFilters(filters);
  const childrenByParentKey = collectDebtChildrenByParentKey(rows);
  const output: DebtRow[] = [];

  for (const row of rows) {
    if (row.parentKey) continue;
    const children = childrenByParentKey.get(row.key) ?? [];
    if (!row.isGroup) {
      if (!filtersActive || debtRowMatchesFilters(row, filters, columns)) output.push(row);
      continue;
    }

    if (!filtersActive) {
      output.push(row);
      if (expandedKeys.has(row.key)) output.push(...children);
      continue;
    }

    const rowMatches = debtRowMatchesFilters(row, filters, columns);
    const matchingChildren = children.filter((child) => debtRowMatchesFilters(child, filters, columns));
    if (!rowMatches && matchingChildren.length === 0) continue;
    output.push(row);
    output.push(...(rowMatches ? children : matchingChildren));
  }

  return output;
}

function sortDebtTreeRows(
  rows: DebtRow[],
  sortState: AdvancedDataTableSortState | null,
  columns: AdvancedDataTableColumn<DebtRow>[],
) {
  if (!sortState) return rows;
  const column = columns.find((item) => item.key === sortState.key);
  const readValue = column?.sortValue ?? column?.filterText;
  if (!readValue) return rows;

  const direction = sortState.direction === "asc" ? 1 : -1;
  const originalIndexByKey = new Map(rows.map((row, index) => [row.key, index]));
  const compareRows = (left: DebtRow, right: DebtRow) => {
    const compared = compareDebtSortValues(readValue(left), readValue(right));
    if (compared !== 0) return compared * direction;
    return (originalIndexByKey.get(left.key) ?? 0) - (originalIndexByKey.get(right.key) ?? 0);
  };
  const childrenByParentKey = collectDebtChildrenByParentKey(rows);
  const sortedRows: DebtRow[] = [];
  const topRows = rows.filter((row) => !row.parentKey).sort(compareRows);
  for (const row of topRows) {
    sortedRows.push(row);
    const children = childrenByParentKey.get(row.key);
    if (children?.length) sortedRows.push(...[...children].sort(compareRows));
  }
  return sortedRows;
}

export function DebtShell({
  rows,
  selectedKey,
  entries,
  repaymentScheduleRows,
  summaryRemainingTotal,
  isRedUp,
  accountOptions,
  categoryOptions,
  accountEditData = EMPTY_ACCOUNT_EDIT_DATA,
}: {
  rows: DebtRow[];
  selectedKey: string;
  entries: DebtEntry[];
  repaymentScheduleRows: RepaymentScheduleRow[];
  summaryRemainingTotal: number;
  totalPayable: number;
  totalReceivable: number;
  isRedUp: boolean;
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  accountEditData?: AccountQuickEditValue[];
}) {
  const router = useRouter();
  const { t, language } = useI18n();
  const [detailTab, setDetailTab] = useState<"entries" | "schedule">("entries");
  const [showPaidScheduleRows, setShowPaidScheduleRows] = useState(false);
  const [rateCardOpen, setRateCardOpen] = useState(false);
  const [rateSaving, setRateSaving] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<RateAdjustmentDraft[]>([]);
  const [lprDiscount, setLprDiscount] = useState("");
  const [recalcOpen, setRecalcOpen] = useState(false);
  const [recalcStartDate, setRecalcStartDate] = useState("");
  const [recalcSaving, setRecalcSaving] = useState(false);
  const [showSettledRows, setShowSettledRows] = useState(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    return selected ? isSettledDebtRow(selected) : false;
  });
  const [expandedDebtRowKeys, setExpandedDebtRowKeys] = useState<Set<string>>(() => new Set());
  const [editingDebtAccount, setEditingDebtAccount] = useState<AccountQuickEditValue | null>(null);
  const [accountEditOpenSignal, setAccountEditOpenSignal] = useState(0);
  const rowClickTimerRef = useRef<number | null>(null);
  const baseRows = useMemo(
    () => showSettledRows ? rows : rows.filter((row) => !isSettledDebtRow(row)),
    [rows, showSettledRows],
  );
  const childrenByParentKey = useMemo(() => collectDebtChildrenByParentKey(baseRows), [baseRows]);
  const safeAccountEditData = Array.isArray(accountEditData) ? accountEditData : EMPTY_ACCOUNT_EDIT_DATA;
  const accountEditDataById = useMemo(
    () => new Map(safeAccountEditData.map((account) => [account.id, account])),
    [safeAccountEditData],
  );
  const selectedRow =
    baseRows.find((row) => row.key === selectedKey) ??
    rows.find((row) => row.key === selectedKey) ??
    null;
  const remainingTotalLabel = selectedRow?.objectType === "银行贷款"
    ? t("debtShell.remainingTotal.payable")
    : selectedRow?.objectType === "银行应收"
      ? t("debtShell.remainingTotal.receivable")
      : t("debtShell.remainingTotal.both");
  const settledCount = rows.filter((row) => !row.parentKey && isSettledDebtRow(row)).length;
  const isSelectedBankLoan = !!selectedRow && !selectedRow.isGroup && selectedRow.isLoan === true;
  const canRepaySelectedRow = !!selectedRow && !selectedRow.isGroup && selectedRow.net < -SETTLED_DEBT_EPSILON;
  const canReconcileSelectedRow = !!selectedRow && !selectedRow.isGroup && !!selectedRow.accountId;
  const canAdjustRateSelectedRow = isSelectedBankLoan && canRepaySelectedRow && !!selectedRow?.accountId;
  const canRecalculateSelectedRow = isSelectedBankLoan && canRepaySelectedRow && !!selectedRow?.accountId && !!selectedRow?.remainingRuns;
  const filterDebtRows = useCallback((
    tableRows: DebtRow[],
    filters: Partial<Record<string, string[]>>,
    columns: AdvancedDataTableColumn<DebtRow>[],
  ) => buildDebtTreeRows(tableRows, filters, columns, expandedDebtRowKeys), [expandedDebtRowKeys]);
  const sortDebtRows = useCallback((
    tableRows: DebtRow[],
    sortState: AdvancedDataTableSortState | null,
    columns: AdvancedDataTableColumn<DebtRow>[],
  ) => sortDebtTreeRows(tableRows, sortState, columns), []);
  const toggleDebtRowExpanded = useCallback((rowKey: string) => {
    setExpandedDebtRowKeys((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);
  const visibleRepaymentScheduleRows = useMemo(
    () => showPaidScheduleRows ? repaymentScheduleRows : repaymentScheduleRows.filter((row) => row.status !== "paid"),
    [repaymentScheduleRows, showPaidScheduleRows],
  );
  const debtRowSummary = useMemo(() => {
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
    if (selected && isSettledDebtRow(selected)) {
      setShowSettledRows(true);
    }
  }, [rows, selectedKey]);

  useEffect(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    if (!selected?.parentKey) return;
    setExpandedDebtRowKeys((current) => {
      if (current.has(selected.parentKey ?? "")) return current;
      const next = new Set(current);
      next.add(selected.parentKey ?? "");
      return next;
    });
  }, [rows, selectedKey]);

  useEffect(() => {
    if (!isSelectedBankLoan && detailTab === "schedule") {
      setDetailTab("entries");
    }
  }, [detailTab, isSelectedBankLoan]);

  function openDebtRow(row: DebtRow) {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
    }
    rowClickTimerRef.current = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("view", "debt");
      params.set("debtPerson", row.key);
      router.push(`/?${params.toString()}`, { scroll: false });
      rowClickTimerRef.current = null;
    }, 360);
  }

  function openDebtAccountProperties(row: DebtRow) {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
      rowClickTimerRef.current = null;
    }
    if (row.isGroup) {
      toggleDebtRowExpanded(row.key);
      return;
    }
    const account = row.accountId ? accountEditDataById.get(row.accountId) : null;
    if (!account) return;
    setEditingDebtAccount(account);
    setAccountEditOpenSignal((value) => value + 1);
  }

  function openRateAdjustment(row: DebtRow) {
    if (!row.accountId) return;
    const generatedDrafts = row.loanRateAdjustments.length === 0 && row.mortgageLprDiscount != null && row.mortgageLprDiscount > 0
      ? buildMortgageLprRateAdjustments({
          discount: row.mortgageLprDiscount,
          throughDate: new Date().toISOString().slice(0, 10),
          fromDate: row.loanStartDate || undefined,
          includeUnchanged: true,
          basis: "lpr_quote",
        }).map((item) => ({
          id: makeDraftId(),
          effectiveDate: item.effectiveDate,
          annualRate: formatRateDraftValue(item.annualRate),
        }))
      : [];
    const drafts = row.loanRateAdjustments.length > 0
      ? row.loanRateAdjustments.map((item) => ({
          id: makeDraftId(),
          effectiveDate: item.effectiveDate,
          annualRate: String(item.annualRate),
        }))
      : generatedDrafts.length > 0
        ? generatedDrafts
      : [{
          id: makeDraftId(),
          effectiveDate: new Date().toISOString().slice(0, 10),
          annualRate: row.annualRate == null ? "" : String(row.annualRate),
        }];
    setRateDrafts(drafts);
    setLprDiscount(row.mortgageLprDiscount == null ? "" : String(row.mortgageLprDiscount));
    setRateCardOpen(true);
  }

  function addRateDraft() {
    setRateDrafts((items) => [
      ...items,
      { id: makeDraftId(), effectiveDate: new Date().toISOString().slice(0, 10), annualRate: "" },
    ]);
  }

  function updateRateDraft(id: string, patch: Partial<RateAdjustmentDraft>) {
    setRateDrafts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function deleteRateDraft(id: string) {
    setRateDrafts((items) => items.filter((item) => item.id !== id));
  }

  function generateLprRateDrafts() {
    const rawDiscount = lprDiscount.trim();
    const discount = rawDiscount ? Number(rawDiscount) : 1;
    if (!Number.isFinite(discount) || discount <= 0) {
      window.alert(t("debtShell.alert.lprDiscountInvalid"));
      return;
    }
    if (!rawDiscount) setLprDiscount("1");
    const adjustments = buildMortgageLprRateAdjustments({
      discount,
      throughDate: new Date().toISOString().slice(0, 10),
      fromDate: selectedRow?.loanStartDate || undefined,
      includeUnchanged: true,
      basis: "lpr_quote",
    });
    if (adjustments.length === 0) {
      window.alert(t("debtShell.alert.lprNoAdjustments"));
      return;
    }
    setRateDrafts(adjustments.map((item) => ({
      id: makeDraftId(),
      effectiveDate: item.effectiveDate,
      annualRate: formatRateDraftValue(item.annualRate),
    })));
  }

  async function saveRateAdjustments() {
    if (!selectedRow?.accountId || rateSaving) return;
    const adjustments = rateDrafts
      .filter((item) => item.effectiveDate.trim() || item.annualRate.trim())
      .map((item) => ({
        effectiveDate: item.effectiveDate.trim(),
        annualRate: Number(item.annualRate),
      }));
    const duplicateDates = new Set<string>();
    for (const item of adjustments) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) || !Number.isFinite(item.annualRate) || item.annualRate <= 0) {
        window.alert(t("debtShell.alert.rateDraftInvalid"));
        return;
      }
      if (duplicateDates.has(item.effectiveDate)) {
        window.alert(t("debtShell.alert.rateDraftDuplicateDate", { date: item.effectiveDate }));
        return;
      }
      duplicateDates.add(item.effectiveDate);
    }

    setRateSaving(true);
    try {
      const response = await fetch("/api/v1/loan-rate-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedRow.accountId,
          adjustments,
          mortgageLprDiscount: lprDiscount.trim() ? Number(lprDiscount.trim()) : null,
          loanStartDate: selectedRow.loanStartDate || null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("debtShell.error.saveRateAdjustmentsFailed"));
        return;
      }
      setRateCardOpen(false);
      dispatchFinanceDataChanged({ reason: "loan-rate-adjustment", accountIds: [selectedRow.accountId] });
    } finally {
      setRateSaving(false);
    }
  }

  async function recalculateRepaymentPlan() {
    if (!selectedRow?.accountId || recalcSaving) return;
    if (
      recalcStartDate &&
      selectedRow.nextRepaymentDate &&
      recalcStartDate < selectedRow.nextRepaymentDate
    ) {
      const confirmed = await showConfirmDialog({
        title: t("debtShell.recalc.confirmTitle"),
        message: t("debtShell.recalc.confirmMessage"),
      });
      if (!confirmed) return;
    }
    setRecalcSaving(true);
    try {
      const response = await fetch("/api/v1/loan-repayment/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedRow.accountId,
          startDate: recalcStartDate,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("debtShell.error.recalculateFailed"));
        return;
      }
      window.alert(formatLoanRecalculateSuccessMessage(data.data));
      setRecalcOpen(false);
      dispatchFinanceDataChanged({ reason: "loan-repayment-recalculate", accountIds: [selectedRow.accountId] });
    } finally {
      setRecalcSaving(false);
    }
  }

  function openRecalculateDialog(row: DebtRow) {
    setRecalcStartDate(row.nextRepaymentDate || new Date().toISOString().slice(0, 10));
    setRecalcOpen(true);
  }

  const rowColumns = useMemo<AdvancedDataTableColumn<DebtRow>[]>(() => [
    {
      key: "objectType",
      label: t("debtShell.colObjectType"),
      width: 112,
      minWidth: 84,
      filterText: (row) => row.objectType,
      sortValue: (row) => row.objectType,
      render: (row) => (
        <span className={amountClass(row.net, isRedUp)}>
          {row.objectType}
        </span>
      ),
    },
    {
      key: "objectName",
      label: t("debtShell.colObject"),
      width: 180,
      minWidth: 120,
      filterText: (row) => row.objectName,
      sortValue: (row) => row.objectName,
      render: (row) => {
        const childCount = row.isGroup ? childrenByParentKey.get(row.key)?.length ?? 0 : 0;
        const expanded = expandedDebtRowKeys.has(row.key);
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
                  toggleDebtRowExpanded(row.key);
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
    {
      key: "itemName",
      label: t("debtShell.colItem"),
      width: 190,
      minWidth: 120,
      filterText: (row) => row.itemName,
      sortValue: (row) => row.itemName,
      render: (row) => (
        <span className={`block truncate ${row.isGroup ? "font-medium text-slate-800" : "text-slate-700"}`} title={row.name}>
          {row.itemName || "-"}
        </span>
      ),
    },
    {
      key: "itemType",
      label: t("debtShell.colItemType"),
      width: 150,
      minWidth: 110,
      filterText: (row) => row.itemType,
      sortValue: (row) => row.itemType,
      render: (row) => <span className={amountClass(row.net, isRedUp)}>{row.itemType}</span>,
    },
    {
      key: "repaymentMethod",
      label: t("debtShell.colRepaymentMethod"),
      width: 140,
      minWidth: 100,
      hideable: true,
      filterText: (row) => row.repaymentMethod || "-",
      sortValue: (row) => row.repaymentMethod || "",
      render: (row) => <span className="text-slate-600">{row.repaymentMethod || "-"}</span>,
    },
    {
      key: "annualRate",
      label: t("debtShell.colAnnualRate"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      sortValue: (row) => row.annualRate,
      render: (row) => <span className="tabular-nums text-slate-600">{formatRate(row.annualRate, language)}</span>,
    },
    {
      key: "remainingRuns",
      label: t("debtShell.colRemainingRuns"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      sortValue: (row) => row.remainingRuns,
      render: (row) => <span className="tabular-nums text-slate-600">{row.remainingRuns == null ? "-" : row.remainingRuns}</span>,
    },
    {
      key: "paidPrincipal",
      label: t("debtShell.colPaidPrincipal"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.paidPrincipal),
      render: (row) => <span className="tabular-nums text-emerald-700">{formatMoney(Math.abs(row.paidPrincipal))}</span>,
    },
    {
      key: "paidInterest",
      label: t("debtShell.colPaidInterest"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.paidInterest),
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.paidInterest))}</span>,
    },
    {
      key: "remainingInterest",
      label: t("debtShell.colRemainingInterest"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.remainingInterest),
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.remainingInterest))}</span>,
    },
    {
      key: "remainingPrincipal",
      label: t("debtShell.colRemainingPrincipal"),
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
  ], [t, language, isRedUp, remainingTotalLabel, childrenByParentKey, expandedDebtRowKeys, toggleDebtRowExpanded]);

  const entryColumns = useMemo<AdvancedDataTableColumn<DebtEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "type", label: t("debtShell.colType"), width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "relatedAccount", label: t("debtShell.colCashAccount"), width: 160, minWidth: 100, filterText: (entry) => entry.relatedAccountLabel, render: (entry) => <span className="block truncate text-slate-600" title={entry.relatedAccountLabel}>{entry.relatedAccountLabel || "-"}</span> },
    {
      key: "outflow",
      label: t("detail.column.outflow"),
      width: 110,
      minWidth: 86,
      align: "right",
      render: (entry) => (
        <span className="font-semibold tabular-nums text-rose-700">
          {entry.principal < 0 ? formatMoney(Math.abs(entry.principal)) : "-"}
        </span>
      ),
    },
    {
      key: "inflow",
      label: t("detail.column.inflow"),
      width: 110,
      minWidth: 86,
      align: "right",
      render: (entry) => (
        <span className="font-semibold tabular-nums text-emerald-700">
          {entry.principal > 0 ? formatMoney(entry.principal) : "-"}
        </span>
      ),
    },
    {
      key: "interest",
      label: t("debtShell.colInterest"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      render: (entry) => <span className="tabular-nums text-amber-700">{entry.interest ? formatMoney(entry.interest) : "-"}</span>,
    },
    {
      key: "paymentTotal",
      label: isSelectedBankLoan ? t("debtShell.colPaymentTotalLoan") : t("debtShell.colPaymentTotalInflow"),
      width: 120,
      minWidth: 92,
      align: "right",
      hideable: true,
      filterText: (entry) => entry.paymentTotal == null ? "-" : entry.paymentTotal.toFixed(2),
      render: (entry) => (
        <span className="font-semibold tabular-nums text-slate-700">
          {entry.paymentTotal == null ? "-" : formatMoney(entry.paymentTotal)}
        </span>
      ),
    },
    { key: "balance", label: t("debtShell.colBalance"), width: 130, minWidth: 92, align: "right", render: (entry) => <span className={`font-semibold tabular-nums ${amountClass(entry.balance, isRedUp)}`}>{formatMoney(entry.balance)}</span> },
    { key: "note", label: t("detail.column.remark"), width: 260, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
  ], [t, isRedUp, isSelectedBankLoan]);

  const repaymentScheduleColumns = useMemo<AdvancedDataTableColumn<RepaymentScheduleRow>[]>(() => [
    {
      key: "status",
      label: t("debtShell.colStatus"),
      width: 82,
      minWidth: 64,
      filterText: (row) => row.rowType === "rate_adjustment" ? t("debtShell.rateAdjustment") : row.status === "paid" ? t("debtShell.paid") : t("debtShell.planned"),
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="text-blue-700">{t("debtShell.rate")}</span>
        : row.status === "paid"
          ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{t("debtShell.paid")}</span>
          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{t("debtShell.planned")}</span>,
    },
    {
      key: "eventType",
      label: t("debtShell.colType"),
      width: 100,
      minWidth: 78,
      filterText: (row) => row.rowType === "rate_adjustment" ? t("debtShell.rateAdjustment") : row.eventType === "prepayment" ? t("debtShell.prepayment") : t("debtShell.repayment"),
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="font-medium text-blue-700">{t("debtShell.rateAdjustment")}</span>
        : row.eventType === "prepayment"
          ? <span className="font-medium text-amber-700">{t("debtShell.prepayment")}</span>
          : <span className="text-slate-700">{t("debtShell.repayment")}</span>,
    },
    { key: "period", label: t("debtShell.colPeriod"), width: 80, minWidth: 64, align: "right", render: (row) => row.rowType === "rate_adjustment" || row.eventType === "prepayment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-slate-700">{row.period}</span> },
    { key: "date", label: t("detail.column.date"), width: 110, minWidth: 86, filterText: (row) => row.date, render: (row) => <span className="tabular-nums text-slate-700">{row.date}</span> },
    { key: "principal", label: t("debtShell.colPrincipal"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="tabular-nums text-blue-700">{formatRate(row.annualRate, language)}</span> : <span className="tabular-nums text-emerald-700">{formatMoney(row.principal)}</span> },
    { key: "interest", label: t("debtShell.colInterest"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-amber-700">{formatMoney(row.interest)}</span> },
    { key: "payment", label: t("debtShell.colPayment"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="font-medium text-blue-700">{t("debtShell.rateAdjustment")}</span> : <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.payment)}</span> },
    { key: "remainingPrincipal", label: t("debtShell.colRemainingPrincipal"), width: 140, minWidth: 104, align: "right", render: (row) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.remainingPrincipal)}</span> },
  ], [t, language]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      {editingDebtAccount ? (
        <AccountTypeQuickEdit
          account={editingDebtAccount}
          accountLabel={editingDebtAccount.name}
          openSignal={accountEditOpenSignal}
          showTrigger={false}
        />
      ) : null}
      <ResizableVerticalSplit
        storageKey="mmh:debt:split-height"
        hasLowerPane={!!selectedRow}
        defaultUpperHeight={360}
        separatorLabel={t("debtShell.resizeLabel")}
        separatorTitle={t("debtShell.resizeTitle")}
      >
        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <AdvancedDataTable
            storageKey="mmh_debt_rows_table_v1"
            columns={rowColumns}
            rows={baseRows}
            rowKey={(row) => row.key}
            minTableWidth={1040}
            emptyText={t("debtShell.emptyRows")}
            fillHeight
            filterRows={filterDebtRows}
            sortRows={sortDebtRows}
            toolbarTitle={(
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <HandCoins className="h-4 w-4 text-amber-500" />
                {t("debtShell.title")}
              </span>
            )}
            toolbarRightContent={(
              <div className="flex items-center gap-3">
                {canReconcileSelectedRow ? (
                  <DebitBalanceReconcileButton
                    accountId={selectedRow.accountId}
                    accountLabel={selectedRow.name}
                    currentBalance={selectedRow.net}
                  />
                ) : null}
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={showSettledRows}
                    onChange={(event) => setShowSettledRows(event.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  {t("debtShell.showSettledRows")}{settledCount > 0 ? `(${settledCount})` : ""}
                </label>
                <div className="text-xs text-slate-400">{t("debtShell.inflowOutflowHint")}</div>
              </div>
            )}
            onRowClick={(row) => openDebtRow(row)}
            onRowDoubleClick={(row) => openDebtAccountProperties(row)}
            rowClassName={(row) => {
              if (row.key === (selectedRow?.key ?? "")) return "cursor-pointer bg-blue-50 hover:bg-blue-50";
              if (row.parentKey) return "cursor-pointer bg-slate-50/70 hover:bg-slate-100";
              return "cursor-pointer hover:bg-slate-50";
            }}
            summaryRow={{
              rowClassName: "bg-slate-50",
              cellClassName: "py-2.5",
              cells: {
                name: <span className="font-semibold tracking-[0.08em] text-slate-500">{t("debtShell.summaryRow")}</span>,
                paidPrincipal: <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(debtRowSummary.paidPrincipal)}</span>,
                paidInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(debtRowSummary.paidInterest)}</span>,
                remainingInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(debtRowSummary.remainingInterest)}</span>,
                remainingPrincipal: <span className="font-semibold tabular-nums text-slate-700">{formatMoney(debtRowSummary.remainingPrincipal)}</span>,
                remainingTotal: <span className="font-semibold tabular-nums text-slate-700">{formatMoney(debtRowSummary.remainingTotal)}</span>,
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
                  {t("debtShell.tabEntries")}
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTab("schedule")}
                  className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "schedule" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  {t("debtShell.tabSchedule")}
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
                    title={canAdjustRateSelectedRow ? t("debtShell.rateAdjust.title") : t("debtShell.rateAdjust.disabledTitle")}
                  >
                    <Percent className="h-3.5 w-3.5" />
                    {t("debtShell.rateAdjustment")}
                  </button>
                  <button
                    type="button"
                    disabled={!canRecalculateSelectedRow}
                    onClick={() => selectedRow && openRecalculateDialog(selectedRow)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                    title={canRecalculateSelectedRow ? t("debtShell.recalc.title") : t("debtShell.recalc.disabledTitle")}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("debtShell.recalc")}
                  </button>
                </>
              ) : null}
            </div>
          </div> : null}

          {!selectedRow ? (
            <div className="flex min-h-0 flex-1 items-center justify-center border-t border-slate-100 bg-slate-50/60 px-4 text-sm text-slate-500">
              {t("debtShell.selectRowFirst")}
            </div>
          ) : detailTab === "entries" || !isSelectedBankLoan ? (
            <BasicDetailSelectionProvider resetKey={`debt-entries:${selectedRow.key}`}>
              <BasicDetailBatchDeleteMessage />
              <DebtEntriesTable
                accountOptions={accountOptions}
                categoryOptions={categoryOptions}
                contextAccountId={selectedRow.accountId}
                columns={entryColumns}
                entries={entries}
              />
            </BasicDetailSelectionProvider>
          ) : (
            <AdvancedDataTable
              storageKey="mmh_debt_repayment_schedule_table_v1"
              columns={repaymentScheduleColumns}
              rows={visibleRepaymentScheduleRows}
              rowKey={(row) => `${row.status ?? ""}:${row.eventType ?? ""}:${row.rowType}:${row.period}:${row.date}:${row.annualRate ?? ""}`}
              minTableWidth={920}
              emptyText={t("debtShell.emptySchedule")}
              fillHeight
              toolbarMode="custom"
              toolbarLeftContent={(
                <span>
                  {showPaidScheduleRows
                    ? t("debtShell.scheduleVisibleCount", { visible: visibleRepaymentScheduleRows.length, total: repaymentScheduleRows.length })
                    : t("debtShell.scheduleUnpaidCount", { count: visibleRepaymentScheduleRows.length })}
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
                  {t("debtShell.showPaid")}
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
          <div className="app-modal-backdrop z-50">
            <div className="app-modal-panel max-w-2xl">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{t("debtShell.rateAdjustment")}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedRow?.name ?? t("debtShell.currentLoan")}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setRateCardOpen(false)}
                  className="secondary-button h-8 px-2"
                  disabled={rateSaving}
                >
                  {t("table.close")}
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                  {t("debtShell.rateAdjust.hint")}
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-700">{t("debtShell.lpr.title")}</div>
                      <div className="mt-0.5 text-[11px] leading-5 text-slate-500">
                        {t("debtShell.lpr.hint", {
                          baseBenchmark: MORTGAGE_BASE_BENCHMARK_RATE.toFixed(2),
                          conversionBase: MORTGAGE_LPR_CONVERSION_BASE_RATE.toFixed(2),
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_92px] gap-2">
                    <div className="space-y-1">
                      <div className="form-label">{t("debtShell.lpr.discountLabel")}</div>
                      <input
                        value={lprDiscount}
                        onChange={(event) => setLprDiscount(event.target.value)}
                        inputMode="decimal"
                        placeholder={t("debtShell.lpr.discountPlaceholder")}
                        className="form-input"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("debtShell.lpr.spreadLabel")}</div>
                      <input
                        value={(() => {
                          const discount = Number(lprDiscount.trim());
                          return Number.isFinite(discount) && discount > 0
                            ? `${calcMortgageLprSpreadFromDiscount(discount).toFixed(3).replace(/\.?0+$/, "")}%`
                            : "";
                        })()}
                        readOnly
                        placeholder={t("debtShell.lpr.autoCalculated")}
                        className="form-input bg-white/70 text-slate-500"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={generateLprRateDrafts}
                        className="inline-flex h-9 w-full items-center justify-center rounded-full border border-blue-600 bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-200 disabled:text-slate-500"
                        disabled={rateSaving}
                      >
                        {t("debtShell.lpr.generate")}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 px-1 text-xs font-medium text-slate-500">
                    <div>{t("debtShell.rateAdjust.effectiveDate")}</div>
                    <div>{t("debtShell.rateAdjust.annualRateLabel")}</div>
                    <div className="text-right" aria-label="Action buttons" />
                  </div>
                  <div className="max-h-[230px] space-y-2 overflow-y-auto pr-1">
                    {rateDrafts.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                        {t("debtShell.rateAdjust.empty")}
                      </div>
                    ) : rateDrafts.map((item) => (
                      <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2">
                        <DateStepper
                          value={item.effectiveDate}
                          onChange={(value) => updateRateDraft(item.id, { effectiveDate: value })}
                        />
                        <input
                          value={item.annualRate}
                          onChange={(event) => updateRateDraft(item.id, { annualRate: event.target.value })}
                          inputMode="decimal"
                          placeholder={t("debtShell.rateAdjust.annualRatePlaceholder")}
                          className="form-input"
                        />
                        <button
                          type="button"
                          onClick={() => deleteRateDraft(item.id)}
                          className="secondary-button h-9 px-2 text-rose-600 hover:bg-rose-50"
                          disabled={rateSaving}
                        >
                          {t("common.delete")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    onClick={addRateDraft}
                    className="secondary-button h-9 px-3"
                    disabled={rateSaving}
                  >
                    {t("debtShell.rateAdjust.addRow")}
                  </button>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setRateCardOpen(false)}
                      className="secondary-button h-9 px-3"
                      disabled={rateSaving}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void saveRateAdjustments(); }}
                      className="primary-button h-9 px-3"
                      disabled={rateSaving}
                    >
                      {rateSaving ? t("debtShell.saving") : t("debtShell.saveRateAdjustments")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {recalcOpen ? (
          <div className="app-modal-backdrop z-50">
            <div className="app-modal-panel max-w-lg">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{t("debtShell.recalc.confirmTitle")}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedRow?.name ?? t("debtShell.currentLoan")}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setRecalcOpen(false)}
                  className="secondary-button h-8 px-2"
                  disabled={recalcSaving}
                >
                  {t("table.close")}
                </button>
              </div>

              <div className="space-y-3 p-4 text-sm text-slate-700">
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {t("debtShell.recalc.hint")}
                </div>

                <div className="space-y-1 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="form-label">{t("debtShell.recalc.startDateLabel")}</div>
                  <DateStepper value={recalcStartDate} onChange={setRecalcStartDate} />
                  <div className="text-[11px] text-slate-500">
                    {t("debtShell.recalc.startDateHint")}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs leading-5 text-slate-600">
                  {t("debtShell.recalc.methodHint")}
                </div>

                <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <div>
                    <div className="text-slate-400">{t("debtShell.recalc.currentRemainingPrincipal")}</div>
                    <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{formatMoney(Math.abs(selectedRow?.net ?? 0))}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">{t("debtShell.recalc.currentRemainingRuns")}</div>
                    <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{selectedRow?.remainingRuns ?? "-"}</div>
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    className="secondary-button h-9 px-3"
                    onClick={() => setRecalcOpen(false)}
                    disabled={recalcSaving}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="primary-button h-9 px-3"
                    onClick={() => { void recalculateRepaymentPlan(); }}
                    disabled={recalcSaving}
                  >
                    {recalcSaving ? t("debtShell.recalc.saving") : t("debtShell.recalc.confirmAndRebuild")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
  );
}

function DebtEntriesTable({
  accountOptions,
  categoryOptions,
  contextAccountId,
  columns,
  entries,
}: {
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  contextAccountId?: string | null;
  columns: AdvancedDataTableColumn<DebtEntry>[];
  entries: DebtEntry[];
}) {
  const { t } = useI18n();
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const currentEntryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  usePruneBasicDetailSelection(currentEntryIds);
  const normalizedAccountOptions = useMemo(
    () => accountOptions.map((account) => ({
      id: account.id,
      label: account.label,
      title: account.title ?? account.hoverTitle ?? undefined,
    })),
    [accountOptions],
  );
  const getCustomEditEvent = (entry: DebtEntry) => entry.balanceReconcileEdit
    ? { name: "mmh:balance-reconcile:edit", detail: entry.balanceReconcileEdit }
    : entry.debtEdit
      ? { name: entry.debtEdit.dialogType === "loan" ? "mmh:loan:create" : "mmh:debt:create", detail: entry.debtEdit }
      : undefined;

  return (
    <AdvancedDataTable
      storageKey="mmh_debt_entries_table_v1"
      resetKey={`debt-entries:${contextAccountId ?? "all"}`}
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1240}
      emptyText={t("debtShell.emptyEntries")}
      fillHeight
      toolbarTitle={t("debtShell.tabEntries")}
      toolbarRightContent={<span className="text-xs text-slate-500">{t("debtShell.entryCount", { count: entries.length })}</span>}
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
        <EntryRowActions
          entryId={entry.id}
          edit={entry.edit}
          customEditEvent={getCustomEditEvent(entry)}
        />
      )}
      rowActionsWidth={92}
      rowActionsMinWidth={76}
      batchActionSlot={(
        <>
          <BasicDetailBatchReplaceButton
            accountOptions={normalizedAccountOptions}
            categoryOptions={categoryOptions}
            contextAccountId={contextAccountId}
          />
          <BasicDetailBatchDeleteButton recordLabel={t("debtShell.recordLabel")} />
        </>
      )}
    />
  );
}
