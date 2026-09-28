"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Coins, Landmark, Repeat, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSummaryRow } from "./AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "./BatchReplacePopoverButton";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import { DepositPayInterestModal, type PayInterestLotInfo } from "./DepositPayInterestModal";
import { DepositRenewModal, type RenewLotInfo } from "./DepositRenewModal";
import { DetailTablePaginationControls } from "./DetailTablePaginationControls";
import { EntryRowActions } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import {
  isPeriodicDepositInterestPayout,
  parseDepositInterestPayout,
} from "@/lib/deposit-interest-payout";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type DepositEntry = {
  id: string;
  date: string;
  typeLabel: string;
  fundName: string;
  maturityDate?: string | null;
  cashAccountLabel: string;
  note: string;
  amount: number;
  balance?: number | null;
  depositSourceEntryId?: string | null;
  businessTransactionId?: string | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  edit?: {
    type: "investment" | "expense" | "income" | "transfer";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    cashAccountId?: string;
    fundName?: string;
    fundArrivalDate?: string | null;
    fundProductType?: string;
    fundSubtype?: string;
    categoryId?: string;
    categoryName?: string;
    toAccountId?: string;
    toAccountName?: string;
    source?: string | null;
  };
};

type DepositLot = {
  id: string;
  label: string;
  fundName: string;
  subLabel?: string;
  startDate?: string | null;
  maturityDate?: string | null;
  maturityAction?: string | null;
  interestPayoutFrequency?: string | null;
  originalAmount: number;
  remainingAmount: number;
  annualRate?: number | null;
  expectedInterest?: number | null;
  takenInterest?: number | null;
  status: "open" | "closed";
  depositAccountId?: string;
  depositAccountLabel?: string;
  relatedEntryIds?: string[];
};

type DepositBatchField = "date" | "cashAccountId" | "amount" | "remark";

type LotTab = "held" | "expired";

const DEPOSIT_ENTRY_COLUMN_SETTINGS_EVENT = "mmh:deposit-entries:column-settings";

export function DepositShell({
  accountLabel,
  institutionName,
  entries,
  lots,
  cashAccounts = [],
  renewAction,
  payInterestAction,
}: {
  accountLabel: string;
  institutionName?: string;
  entries: DepositEntry[];
  lots: DepositLot[];
  cashAccounts?: Array<{ id: string; label: string }>;
  renewAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  payInterestAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [lotTab, setLotTab] = useState<LotTab>("held");
  const [renewLot, setRenewLot] = useState<RenewLotInfo | null>(null);
  const [payInterestLot, setPayInterestLot] = useState<PayInterestLotInfo | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());
  const [entryPage, setEntryPage] = useState(1);
  const [entryPageSize, setEntryPageSize] = useState(40);
  const [entryRowCount, setEntryRowCount] = useState(0);
  const [entryAutoFit, setEntryAutoFit] = useState(true);

  const { t } = useI18n();
  const router = useRouter();
  const formatText = useCallback((key: string, values?: Record<string, string | number>) => {
    let text = t(key) as string;
    if (!values) return text;
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }, [t]);

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId],
  );

  const maturityActionLabel = useCallback(
    (action: string | null | undefined) => {
      if (action === "renew_principal") return t("deposit.maturityAction.renewPrincipal");
      if (action === "renew_principal_interest") return t("deposit.maturityAction.renewPrincipalInterest");
      return t("deposit.maturityAction.redeem");
    },
    [t],
  );

  const payoutFrequencyLabel = useCallback(
    (frequency: string | null | undefined) => {
      const parsed = parseDepositInterestPayout(frequency);
      if (parsed.kind !== "periodic") return t("deposit.payoutFrequency.maturity");
      const unitKey =
        parsed.unit === "week"
          ? "depositForm.termUnit.week"
          : parsed.unit === "year"
            ? "depositForm.termUnit.year"
            : "depositForm.termUnit.month";
      if (parsed.interval <= 1) {
        return parsed.unit === "week"
          ? t("deposit.payoutFrequency.weekly")
          : parsed.unit === "year"
            ? t("deposit.payoutFrequency.yearly")
            : t("deposit.payoutFrequency.monthly");
      }
      return t("deposit.payoutFrequency.everyN", {
        interval: String(parsed.interval),
        unit: t(unitKey),
      });
    },
    [t],
  );

  const openRenewModal = useCallback(
    (lot: DepositLot) => {
      if (!renewAction) return;
      setRenewLot({
        id: lot.id,
        fundName: lot.fundName,
        principal: lot.remainingAmount > 0 ? lot.remainingAmount : lot.originalAmount,
        annualRate: lot.annualRate ?? null,
        startDate: lot.startDate ?? null,
        maturityDate: lot.maturityDate ?? null,
        maturityAction: lot.maturityAction ?? null,
        interestPayoutFrequency: lot.interestPayoutFrequency ?? null,
        depositAccountLabel: lot.depositAccountLabel ?? "",
      });
    },
    [renewAction],
  );

  const openPayInterestModal = useCallback(
    (lot: DepositLot) => {
      if (!payInterestAction) return;
      setPayInterestLot({
        id: lot.id,
        fundName: lot.fundName,
        principal: lot.remainingAmount > 0 ? lot.remainingAmount : lot.originalAmount,
        annualRate: lot.annualRate ?? null,
        maturityDate: lot.maturityDate ?? null,
        interestPayoutFrequency: lot.interestPayoutFrequency ?? null,
      });
    },
    [payInterestAction],
  );

  /**
   * 存单行「取回」：直接打开存款弹窗的取出模式，并预选这张存单。
   *
   * 走的是与右上角入口相同的 `mmh:deposit:create` 事件链路（弹窗由记账页 /
   * DepositEntryHost 挂在同一页），只是多带一个 defaultRedeemLotId；
   * 弹窗收到后会把账户、金额（剩余本金）一并预填。
   */
  const openRedeemModal = useCallback((lot: DepositLot) => {
    window.dispatchEvent(
      new CustomEvent("mmh:deposit:create", {
        detail: {
          requestId: `deposit-redeem-${lot.id}-${Date.now()}`,
          defaultSubtype: "redeem",
          defaultRedeemLotId: lot.id,
          defaultDepositAccountId: lot.depositAccountId ?? "",
        },
      }),
    );
  }, []);

  const heldLots = useMemo(() => lots.filter((lot) => lot.status === "open"), [lots]);
  const expiredLots = useMemo(() => lots.filter((lot) => lot.status === "closed"), [lots]);
  const visibleLots = lotTab === "held" ? heldLots : expiredLots;

  function switchLotTab(tab: LotTab) {
    setLotTab(tab);
    setSelectedLotId(null);
  }

  const visibleEntries = useMemo(() => {
    if (!selectedLot) return entries;
    const relatedIds = new Set(selectedLot.relatedEntryIds ?? [selectedLot.id]);
    return entries.filter((entry) => relatedIds.has(entry.id));
  }, [entries, selectedLot]);

  useEffect(() => {
    setEntryPage(1);
  }, [selectedLotId]);

  // Prune selections that no longer exist after data refreshes.
  useEffect(() => {
    setSelectedEntryIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(visibleEntries.map((entry) => entry.id));
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleEntries]);

  // Refresh the server-rendered deposit view after any finance data change
  // (edits via EntryRowActions, batch operations, deposits created elsewhere).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean }>).detail;
      if (detail?.balanceChanged === false) return;
      router.refresh();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [router]);

  // Pagination state is owned here for the header controls; the actual slicing
  // happens INSIDE AdvancedDataTable (rows must be the FULL set, exactly like
  // StockHoldingsPanel — slicing here too would collapse ADT's pageCount to 1).
  const entryAll = entryPageSize === 0;
  const totalPages = Math.max(1, Math.ceil(entryRowCount / (entryPageSize > 0 ? entryPageSize : Math.max(1, entryRowCount))));
  const safePage = Math.min(entryPage, totalPages);

  // Auto-fit: the table reports how many rows fit the viewport; when auto mode
  // is on that count becomes the page size (the "自适应" option restores it).
  // Callback identity changes with autoFit / show-all so the table re-measures
  // once per mode switch, then stays frozen (same contract as BasicDetailPanel).
  const lastFitRowCountRef = useRef<number | null>(null);
  const handleRowsFitChange = useCallback((rowCount: number) => {
    lastFitRowCountRef.current = rowCount;
    if (!entryAutoFit || entryAll) return;
    setEntryPageSize((prev) => (prev === rowCount ? prev : rowCount));
  }, [entryAutoFit, entryAll]);

  const enableAutoFitEntryRows = useCallback(() => {
    setEntryAutoFit(true);
    if (!entryAll) {
      const fitCount = lastFitRowCountRef.current;
      if (fitCount != null && fitCount !== entryPageSize) setEntryPageSize(fitCount);
    }
    setEntryPage(1);
  }, [entryAll, entryPageSize]);

  const batchFields = useMemo<BatchReplaceFieldConfig<DepositBatchField>[]>(() => [
    { value: "date", label: t("detail.column.date"), kind: "date" },
    {
      value: "cashAccountId",
      label: t("txForm.cashAccount"),
      kind: "select",
      options: [{ value: "", label: t("fundShell.selectAccount") }, ...cashAccounts.map((account) => ({ value: account.id, label: account.label }))],
    },
    { value: "amount", label: t("txForm.amount"), kind: "number", placeholder: t("fundShell.batch.amountPlaceholder") },
    { value: "remark", label: t("detail.column.remark"), kind: "text", placeholder: t("stockPanel.batchNotePlaceholder"), allowEmpty: true },
  ], [cashAccounts, t]);

  async function applyBatch(field: DepositBatchField, value: string) {
    const ids = Array.from(selectedEntryIds);
    if (ids.length === 0) throw new Error(t("stockPanel.error.selectRowsFirst"));
    const entryById = new Map(visibleEntries.map((entry) => [entry.id, entry]));
    const updates = ids.map((id) => {
      if (field === "remark") return { id, remark: value };
      if (field === "cashAccountId") return { id, cashAccountId: value };
      if (field === "amount") return { id, amount: value };
      // date: the detail table renders income/expense rows as postedAt ?? date,
      // so sync postedAt as well or the visible date would not change.
      const rowType = entryById.get(id)?.edit?.type;
      return rowType === "income" || rowType === "expense" || rowType === "transfer"
        ? { id, date: value, postedAt: value }
        : { id, date: value };
    });
    const res = await fetch("/api/v1/entries/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: t("stockPanel.error.batchUpdateFailed") }));
    if (!res.ok || !data.ok) throw new Error(data.error ?? t("stockPanel.error.batchUpdateFailed"));
    setSelectedEntryIds(new Set());
    dispatchFinanceDataChanged({ reason: "deposit-batch-update" });
    return t("stockPanel.updatedCount", { count: data.updatedCount ?? 0 });
  }

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    const entryIds = Array.from(selectedEntryIds);
    const data = await deleteEntriesWithLinkedPrompt({
      entryIds,
      confirmMessage: formatText("depositShell.batchDeleteConfirm", { count: selectedEntryIds.size }),
      t,
    });
    if (!data.ok) {
      if (data.code === "DELETE_CANCELLED" || data.error === "已取消删除") return;
      window.alert(data?.error || t("depositShell.error.batchDeleteFailed"));
      return;
    }
    setSelectedEntryIds(new Set());
    const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
    dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
  }

  async function linkDepositCashFlow(entry: DepositEntry) {
    const id = String(entry.id ?? "").trim();
    if (!id || linkingIds.has(id)) return;
    const businessTransactionId = String(entry.businessTransactionId ?? "").trim();
    if (!businessTransactionId) {
      window.alert(t("depositShell.error.missingBusinessId"));
      return;
    }
    setLinkingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType: "deposit", businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("depositShell.error.linkFailed"));
      dispatchFinanceDataChanged({ reason: "deposit-link-cash-flow", entryIds: [data.data?.cashEntryId, id].filter(Boolean) });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("depositShell.error.linkFailed"));
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const heldLotColumns = useMemo<AdvancedDataTableColumn<DepositLot>[]>(() => [
    {
      key: "product",
      label: t("depositShell.colProduct"),
      width: 260,
      minWidth: 160,
      filterText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      filterSearchText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      sortValue: (lot) => lot.fundName,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.fundName}>{lot.fundName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{t("investment.product.deposit")}</span>
        </div>
      ),
    },
    { key: "startDate", label: t("depositShell.colStartDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "maturityAction", label: t("depositShell.colMaturityAction"), width: 130, minWidth: 96, hideable: true, filterText: (lot) => maturityActionLabel(lot.maturityAction), sortValue: (lot) => lot.maturityAction ?? "", render: (lot) => <span className="text-slate-600">{maturityActionLabel(lot.maturityAction)}</span> },
    { key: "interestPayoutFrequency", label: t("depositShell.colPayoutFrequency"), width: 110, minWidth: 88, hideable: true, filterText: (lot) => payoutFrequencyLabel(lot.interestPayoutFrequency), sortValue: (lot) => lot.interestPayoutFrequency ?? "", render: (lot) => <span className="text-slate-600">{payoutFrequencyLabel(lot.interestPayoutFrequency)}</span> },
    { key: "originalAmount", label: t("depositShell.colOriginalAmount"), width: 120, minWidth: 86, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.originalAmount), filterNumber: (lot) => lot.originalAmount, sortValue: (lot) => lot.originalAmount, render: (lot) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(lot.originalAmount)}</span> },
    { key: "expectedInterest", label: t("depositShell.colExpectedInterest"), width: 110, minWidth: 80, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.expectedInterest != null ? String(lot.expectedInterest) : null, filterNumber: (lot) => lot.expectedInterest ?? null, sortValue: (lot) => lot.expectedInterest ?? 0, render: (lot) => lot.expectedInterest != null ? <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(lot.expectedInterest)}</span> : <span className="tabular-nums text-slate-400">-</span> },
    { key: "takenInterest", label: t("depositShell.colTakenInterest"), width: 110, minWidth: 80, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.takenInterest != null && lot.takenInterest > 0 ? String(lot.takenInterest) : null, filterNumber: (lot) => lot.takenInterest ?? null, sortValue: (lot) => lot.takenInterest ?? 0, render: (lot) => lot.takenInterest != null && lot.takenInterest > 0 ? <span className="tabular-nums text-emerald-600">{formatMoney(lot.takenInterest)}</span> : <span className="tabular-nums text-slate-400">-</span> },
    { key: "annualRate", label: t("depositShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.annualRate != null ? String(lot.annualRate) : null, filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
  ], [maturityActionLabel, payoutFrequencyLabel, t]);

  const expiredLotColumns = useMemo<AdvancedDataTableColumn<DepositLot>[]>(() => [
    {
      key: "product",
      label: t("depositShell.colProduct"),
      width: 260,
      minWidth: 160,
      filterText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      filterSearchText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      sortValue: (lot) => lot.fundName,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.fundName}>{lot.fundName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{t("investment.product.deposit")}</span>
        </div>
      ),
    },
    { key: "startDate", label: t("depositShell.colStartDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "originalAmount", label: t("depositShell.colOriginalAmount"), width: 120, minWidth: 86, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.originalAmount), filterNumber: (lot) => lot.originalAmount, sortValue: (lot) => lot.originalAmount, render: (lot) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(lot.originalAmount)}</span> },
    { key: "annualRate", label: t("depositShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.annualRate != null ? String(lot.annualRate) : null, filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
  ], [t]);

  const lotColumns = lotTab === "held" ? heldLotColumns : expiredLotColumns;

  const lotsSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (visibleLots.length === 0) return undefined;
    const totalOriginalAmount = visibleLots.reduce((sum, lot) => sum + lot.originalAmount, 0);
    const cells: Record<string, ReactNode> = {
      product: <span className="font-semibold text-slate-800">{t("debtShell.summaryRow")}</span>,
      originalAmount: <span className="font-semibold tabular-nums text-slate-800">{formatMoney(totalOriginalAmount)}</span>,
    };
    if (lotTab === "held") {
      const totalExpectedInterest = visibleLots.reduce((sum, lot) => sum + (lot.expectedInterest ?? 0), 0);
      if (totalExpectedInterest > 0) {
        cells.expectedInterest = <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(totalExpectedInterest)}</span>;
      }
      const totalTakenInterest = visibleLots.reduce((sum, lot) => sum + (lot.takenInterest ?? 0), 0);
      if (totalTakenInterest > 0) {
        cells.takenInterest = <span className="font-semibold tabular-nums text-emerald-600">{formatMoney(totalTakenInterest)}</span>;
      }
    }
    return { cells, rowClassName: "bg-slate-50/80" };
  }, [lotTab, t, visibleLots]);

  const entryColumns = useMemo<AdvancedDataTableColumn<DepositEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterKind: "dateRange", filterText: (entry) => entry.date, sortValue: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "action", label: t("depositShell.colAction"), width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, sortValue: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "product", label: t("depositShell.colProduct"), width: 190, minWidth: 120, filterText: (entry) => entry.fundName, filterSearchText: (entry) => entry.fundName, sortValue: (entry) => entry.fundName, render: (entry) => <span className="truncate text-slate-700" title={entry.fundName}>{entry.fundName || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (entry) => entry.maturityDate ?? "", sortValue: (entry) => entry.maturityDate ?? "", render: (entry) => <span className="tabular-nums text-slate-600">{entry.maturityDate || "-"}</span> },
    { key: "cashAccount", label: t("depositShell.colCashAccount"), width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, filterSearchText: (entry) => entry.cashAccountLabel, sortValue: (entry) => entry.cashAccountLabel, render: (entry) => <span className="truncate text-slate-600" title={entry.cashAccountLabel}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: t("detail.column.remark"), width: 240, minWidth: 120, hideable: true, filterText: (entry) => entry.note, filterSearchText: (entry) => entry.note, sortValue: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: t("depositShell.colAmount"),
      width: 120,
      minWidth: 86,
      align: "right",
      filterKind: "numberRange",
      filterText: (entry) => String(entry.amount),
      filterNumber: (entry) => Math.abs(entry.amount),
      sortValue: (entry) => entry.amount,
      render: (entry) => (
        <span className={`inline-flex items-center justify-end gap-1 font-semibold tabular-nums ${amountClass(entry.amount)}`}>
          {entry.amount >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
          {formatMoney(entry.amount)}
        </span>
      ),
    },
    {
      key: "balance",
      label: t("detail.column.balance"),
      width: 120,
      minWidth: 90,
      hideable: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (entry) => (entry.balance != null ? String(entry.balance) : ""),
      filterNumber: (entry) => (entry.balance != null ? Math.abs(entry.balance) : undefined),
      sortValue: (entry) => entry.balance ?? 0,
      render: (entry) => (
        <span className="tabular-nums text-slate-700">
          {entry.balance != null ? formatMoney(entry.balance) : "-"}
        </span>
      ),
    },
  ], [t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey="mmh:deposit:split-height"
        hasLowerPane={!!selectedLot}
        defaultUpperHeight={360}
        separatorLabel={t("depositShell.resizeLabel")}
        separatorTitle={t("depositShell.resizeTitle")}
      >
        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-600" />
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => switchLotTab("held")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "held" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("depositShell.holdingsTitle")}
                </button>
                <button
                  type="button"
                  onClick={() => switchLotTab("expired")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "expired" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("depositShell.expiredTitle")}
                </button>
              </div>
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot
                ? formatText("depositShell.lotSelectedHint", { name: selectedLot.fundName })
                : lotTab === "held"
                  ? formatText("depositShell.allHoldingsHint", { scope: institutionName || accountLabel })
                  : formatText("depositShell.allExpiredHint", { scope: institutionName || accountLabel })}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_deposit_lots_table_v1"
              columns={lotColumns}
              rows={visibleLots}
              rowKey={(lot) => lot.id}
              minTableWidth={820}
              emptyText={lotTab === "held" ? t("depositShell.emptyHoldings") : t("depositShell.emptyExpired")}
              showFilters
              fillHeight
              toolbarMode="none"
              defaultSort={{ key: "originalAmount", direction: "desc" }}
              summaryRow={lotsSummaryRow}
              onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
              rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
              rowActions={lotTab === "held" ? (lot) => (
                <div className="flex items-center gap-1">
                  {payInterestAction && isPeriodicDepositInterestPayout(lot.interestPayoutFrequency) ? (
                    <button
                      type="button"
                      disabled={lot.status !== "open"}
                      onClick={(event) => {
                        event.stopPropagation();
                        openPayInterestModal(lot);
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title={t("deposit.payInterest.title")}
                      aria-label={t("deposit.payInterest.title")}
                    >
                      <Coins className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  {renewAction ? (
                    <button
                      type="button"
                      disabled={lot.status !== "open"}
                      onClick={(event) => {
                        event.stopPropagation();
                        openRenewModal(lot);
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title={t("deposit.renew.title")}
                      aria-label={t("deposit.renew.title")}
                    >
                      <Repeat className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={lot.status !== "open" || lot.remainingAmount <= 0.0001}
                    onClick={(event) => {
                      event.stopPropagation();
                      openRedeemModal(lot);
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
                    title={t("deposit.redeem.title")}
                    aria-label={t("deposit.redeem.title")}
                  >
                    <ArrowDownLeft className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : undefined}
              rowActionsWidth={116}
            />
          </div>
        </section>

        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-slate-800">
              {selectedEntryIds.size > 0 ? (
                <div className="flex shrink-0 items-center gap-1">
                  <BatchReplacePopoverButton
                    fields={batchFields}
                    targetCount={selectedEntryIds.size}
                    targetLabel={t("stockPanel.selected")}
                    buttonTitle={t("common.edit")}
                    buttonClassName="h-6 w-6 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"
                    onApply={applyBatch}
                  />
                  <button
                    type="button"
                    onClick={batchDeleteEntries}
                    disabled={selectedEntryIds.size === 0}
                    className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                    title={t("depositShell.deleteButton")}
                    aria-label={t("depositShell.deleteButton")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <span
                    className="h-6 rounded border border-blue-200 bg-blue-50 px-2 text-xs font-medium leading-6 tabular-nums text-blue-700"
                    title={t("fundShell.selectedTitle", { count: selectedEntryIds.size })}
                  >
                    {t("table.selectedCount", { count: selectedEntryIds.size })}
                  </span>
                  <span className="mx-1 h-4 w-px bg-slate-200" />
                </div>
              ) : null}
              <span className="flex h-6 shrink-0 items-center">{t("depositShell.entriesTitle")}</span>
              <span className="ml-2 shrink-0 text-xs font-normal text-slate-400">{selectedLot ? formatText("depositShell.entryCountHint", { count: visibleEntries.length }) : formatText("depositShell.allEntryCountHint", { count: visibleEntries.length })}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
              <span className="mx-1 h-4 w-px bg-slate-200" />
              <DetailTablePaginationControls
                pageSize={entryPageSize}
                detailAll={entryAll}
                safePage={safePage}
                totalPages={totalPages}
                canPrev={!entryAll && safePage > 1}
                canNext={!entryAll && safePage < totalPages}
                autoFit={entryAutoFit}
                onAutoFit={enableAutoFitEntryRows}
                onPageSizeChange={(nextPageSize) => { setEntryPageSize(nextPageSize); setEntryPage(1); }}
                onShowAll={() => { setEntryPageSize(0); setEntryPage(1); }}
                onPageChange={setEntryPage}
              />
              <span className="text-slate-300">|</span>
              <button
                type="button"
                data-advanced-table-column-settings
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  window.dispatchEvent(new CustomEvent(DEPOSIT_ENTRY_COLUMN_SETTINGS_EVENT, {
                    detail: { anchorRect: { right: rect.right, bottom: rect.bottom } },
                  }));
                }}
                className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                title={t("basicDetail.guide.columnSettings.title")}
                aria-label={t("basicDetail.guide.columnSettings.title")}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_deposit_entries_table_v2"
              columns={entryColumns}
              rows={visibleEntries}
              rowKey={(entry) => entry.id}
              minTableWidth={1020}
              emptyText={selectedLot ? t("depositShell.emptyRelatedEntries") : t("depositShell.emptyAllEntries")}
              fillHeight
              toolbarMode="none"
              columnVisibilityTriggerId={DEPOSIT_ENTRY_COLUMN_SETTINGS_EVENT}
              showColumnVisibilityButton={false}
              showFilters
              selectable
              selectOnRowClick
              selectAllScope="renderedRows"
              selectedKeys={selectedEntryIds}
              onSelectionChange={setSelectedEntryIds}
              rowActions={(entry) => {
                // 利息的收入/转账条目是普通分录，没有存款业务流可关联 —— 不显示关联图标。
                const isDepositBusinessEntry = !!entry.businessTransactionId;
                const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
                const labels = entry.businessLinkLabels ?? [];
                const title = hasBusinessLink
                  ? formatText("depositShell.linkedTitle", { labels: labels.join("、") || t("depositShell.businessRecord") })
                  : t("depositShell.unlinkedTitle");
                return (
                  <>
                    {isDepositBusinessEntry ? (
                      <BusinessLinkActionButton
                        active={hasBusinessLink}
                        title={title}
                        busy={linkingIds.has(entry.id)}
                        onClick={() => linkDepositCashFlow(entry)}
                      />
                    ) : null}
                    <EntryRowActions entryId={entry.id} edit={entry.edit} />
                  </>
                );
              }}
              rowActionsWidth={112}
              rowActionsMinWidth={92}
              pagination={{
                page: safePage,
                pageSize: entryPageSize,
                all: entryPageSize === 0,
                onPageChange: setEntryPage,
                onRowCountChange: setEntryRowCount,
              }}
              onRowsFitChange={entryAutoFit && !entryAll ? handleRowsFitChange : undefined}
            />
          </div>
        </section>
      </ResizableVerticalSplit>

      <DepositRenewModal
        open={!!renewLot}
        onClose={() => setRenewLot(null)}
        lot={renewLot}
        cashAccounts={cashAccounts}
        renewAction={renewAction ?? (async () => ({ ok: false as const, error: t("txForm.alert.saveFailed") }))}
      />

      <DepositPayInterestModal
        open={!!payInterestLot}
        onClose={() => setPayInterestLot(null)}
        lot={payInterestLot}
        cashAccounts={cashAccounts}
        payInterestAction={payInterestAction ?? (async () => ({ ok: false as const, error: t("txForm.alert.saveFailed") }))}
      />
    </div>
  );
}
