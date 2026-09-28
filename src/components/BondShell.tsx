"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Landmark, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSummaryRow } from "./AdvancedDataTable";
import { DetailTablePaginationControls } from "./DetailTablePaginationControls";
import { EntryRowActions, type EditPayload } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { parseDepositInterestPayout } from "@/lib/deposit-interest-payout";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

/**
 * 债券视图。
 *
 * 债券是「债单 + 票面利率 + 到期日 + 付息」模型，与基金的份额/净值模型不同，
 * 因此不复用 FundShell：这里只出现债券自己的口径——起息日、到期日、付息方式、
 * 票面利率、持仓本金、累计已付利息、预计利息、下次付息、已实现收益。
 */
export type BondShellLot = {
  id: string;
  name: string;
  /** 同一债单内的存单序号（按起息日排序，从 1 开始）—— 一张存单 = 一个持仓。 */
  certificateIndex: number;
  startDate: string | null;
  clearedDate: string | null;
  maturityDate: string | null;
  payoutFrequency: string | null;
  annualRate: number | null;
  principal: number;
  paidInterest: number;
  expectedInterest: number | null;
  nextPayoutDate: string | null;
  nextExpectedInterest: number | null;
  realizedProfit: number;
  status: "open" | "closed";
  relatedEntryIds: string[];
};

export type BondShellEntry = {
  id: string;
  date: string;
  typeLabel: string;
  bondName: string;
  arrivalDate?: string | null;
  cashAccountLabel: string;
  note: string;
  amount: number;
  businessTransactionId?: string | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  edit?: Omit<EditPayload, "entryId">;
};

type LotTab = "held" | "cleared";

const BOND_ENTRY_COLUMN_SETTINGS_EVENT = "mmh:bond-entries:column-settings";

export function BondShell({
  accountId,
  accountLabel,
  institutionName,
  lots,
  entries,
  totalPrincipal,
  totalPaidInterest,
  totalExpectedInterest,
}: {
  accountId: string;
  accountLabel: string;
  institutionName?: string;
  lots: BondShellLot[];
  entries: BondShellEntry[];
  totalPrincipal: number;
  totalPaidInterest: number;
  totalExpectedInterest: number;
}) {
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [lotTab, setLotTab] = useState<LotTab>("held");
  const [entryPage, setEntryPage] = useState(1);
  const [entryPageSize, setEntryPageSize] = useState(40);
  const [entryRowCount, setEntryRowCount] = useState(0);
  const [entryAutoFit, setEntryAutoFit] = useState(true);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());

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

  const payoutFrequencyLabel = useCallback((frequency: string | null | undefined) => {
    const parsed = parseDepositInterestPayout(frequency);
    if (parsed.kind !== "periodic") return t("bondShell.payout.maturity");
    const unitKey =
      parsed.unit === "week"
        ? "bondShell.unit.week"
        : parsed.unit === "year"
          ? "bondShell.unit.year"
          : "bondShell.unit.month";
    return formatText("bondShell.payout.everyN", {
      interval: String(parsed.interval),
      unit: t(unitKey),
    });
  }, [formatText, t]);

  const heldLots = useMemo(() => lots.filter((lot) => lot.status === "open"), [lots]);
  const clearedLots = useMemo(() => lots.filter((lot) => lot.status === "closed"), [lots]);
  const visibleLots = lotTab === "held" ? heldLots : clearedLots;

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId],
  );

  function switchLotTab(tab: LotTab) {
    setLotTab(tab);
    setSelectedLotId(null);
  }

  const visibleEntries = useMemo(() => {
    if (!selectedLot) return entries;
    const relatedIds = new Set(selectedLot.relatedEntryIds);
    return entries.filter((entry) => relatedIds.has(entry.id));
  }, [entries, selectedLot]);
  const visibleEntryIds = useMemo(() => visibleEntries.map((entry) => entry.id), [visibleEntries]);

  useEffect(() => {
    setEntryPage(1);
  }, [selectedLotId]);

  useEffect(() => {
    setSelectedEntryIds(new Set());
  }, [accountId]);

  useEffect(() => {
    setSelectedEntryIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(visibleEntryIds);
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [visibleEntryIds]);

  // 债券视图走服务端渲染 + router.refresh()，与存款视图同一刷新契约。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean }>).detail;
      if (detail?.balanceChanged === false) return;
      router.refresh();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [router]);

  const entryAll = entryPageSize === 0;
  const totalPages = Math.max(1, Math.ceil(entryRowCount / (entryPageSize > 0 ? entryPageSize : Math.max(1, entryRowCount))));
  const safePage = Math.min(entryPage, totalPages);

  // 自适应：表格回报视口能放几行，该行数即页大小（与 BasicDetailPanel 同一契约）。
  const handleRowsFitChange = useCallback((rowCount: number) => {
    if (!entryAutoFit || entryAll) return;
    setEntryPageSize((prev) => (prev === rowCount ? prev : rowCount));
  }, [entryAutoFit, entryAll]);

  const enableAutoFitEntryRows = useCallback(() => {
    setEntryAutoFit(true);
    setEntryPage(1);
  }, []);

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    const entryIds = Array.from(selectedEntryIds);
    const data = await deleteEntriesWithLinkedPrompt({
      entryIds,
      confirmMessage: t("basicDetailSelection.deleteConfirm", { count: entryIds.length, label: t("bondShell.entriesTitle") }),
      t,
    });
    if (!data.ok) {
      if (data.code === "DELETE_CANCELLED" || data.error === "已取消删除") return;
      window.alert(data.error || t("stockPanel.error.batchDeleteFailed"));
      return;
    }
    setSelectedEntryIds(new Set());
    const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
    dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
  }

  const moneyCell = useCallback((value: number | null, tone?: string) => (
    value == null
      ? <span className="tabular-nums text-slate-400">-</span>
      : <span className={`font-semibold tabular-nums ${tone ?? "text-slate-700"}`}>{formatMoney(value)}</span>
  ), []);

  const heldColumns = useMemo<AdvancedDataTableColumn<BondShellLot>[]>(() => [
    {
      key: "bond",
      label: t("bondShell.colBond"),
      width: 240,
      minWidth: 150,
      filterText: (lot) => lot.name,
      filterSearchText: (lot) => lot.name,
      sortValue: (lot) => lot.name,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.name}>{lot.name || "-"}</span>
          <span
            className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            title={t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          >
            {t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          </span>
        </div>
      ),
    },
    { key: "startDate", label: t("bondShell.colStartDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("bondShell.colMaturityDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "payoutFrequency", label: t("bondShell.colPayoutFrequency"), width: 128, minWidth: 96, hideable: true, filterText: (lot) => payoutFrequencyLabel(lot.payoutFrequency), sortValue: (lot) => lot.payoutFrequency ?? "", render: (lot) => <span className="text-slate-600">{payoutFrequencyLabel(lot.payoutFrequency)}</span> },
    { key: "annualRate", label: t("bondShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.annualRate != null ? String(lot.annualRate) : null), filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "principal", label: t("bondShell.colPrincipal"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.principal), filterNumber: (lot) => lot.principal, sortValue: (lot) => lot.principal, render: (lot) => moneyCell(lot.principal) },
    { key: "paidInterest", label: t("bondShell.colPaidInterest"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.paidInterest), filterNumber: (lot) => lot.paidInterest, sortValue: (lot) => lot.paidInterest, render: (lot) => (lot.paidInterest > 0 ? moneyCell(lot.paidInterest, "text-emerald-600") : moneyCell(null)) },
    { key: "expectedInterest", label: t("bondShell.colExpectedInterest"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.expectedInterest != null ? String(lot.expectedInterest) : null), filterNumber: (lot) => lot.expectedInterest ?? null, sortValue: (lot) => lot.expectedInterest ?? 0, render: (lot) => moneyCell(lot.expectedInterest, "text-emerald-700") },
    { key: "nextPayoutDate", label: t("bondShell.colNextPayout"), width: 116, minWidth: 88, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.nextPayoutDate ?? "", sortValue: (lot) => lot.nextPayoutDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.nextPayoutDate || "-"}</span> },
    { key: "realizedProfit", label: t("bondShell.colRealizedProfit"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.realizedProfit), filterNumber: (lot) => Math.abs(lot.realizedProfit), sortValue: (lot) => lot.realizedProfit, render: (lot) => (lot.realizedProfit !== 0 ? moneyCell(lot.realizedProfit, amountClass(lot.realizedProfit)) : moneyCell(null)) },
  ], [moneyCell, payoutFrequencyLabel, t]);

  const clearedColumns = useMemo<AdvancedDataTableColumn<BondShellLot>[]>(() => [
    {
      key: "bond",
      label: t("bondShell.colBond"),
      width: 240,
      minWidth: 150,
      filterText: (lot) => lot.name,
      filterSearchText: (lot) => lot.name,
      sortValue: (lot) => lot.name,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.name}>{lot.name || "-"}</span>
          <span
            className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
            title={t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          >
            {t("bondShell.certificateBadge", { index: lot.certificateIndex })}
          </span>
        </div>
      ),
    },
    { key: "startDate", label: t("bondShell.colStartDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "clearedDate", label: t("bondShell.colClearedDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.clearedDate ?? "", sortValue: (lot) => lot.clearedDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.clearedDate || "-"}</span> },
    { key: "annualRate", label: t("bondShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => (lot.annualRate != null ? String(lot.annualRate) : null), filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "paidInterest", label: t("bondShell.colPaidInterest"), width: 124, minWidth: 90, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.paidInterest), filterNumber: (lot) => lot.paidInterest, sortValue: (lot) => lot.paidInterest, render: (lot) => (lot.paidInterest > 0 ? moneyCell(lot.paidInterest, "text-emerald-600") : moneyCell(null)) },
    { key: "realizedProfit", label: t("bondShell.colRealizedProfit"), width: 120, minWidth: 88, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.realizedProfit), filterNumber: (lot) => Math.abs(lot.realizedProfit), sortValue: (lot) => lot.realizedProfit, render: (lot) => (lot.realizedProfit !== 0 ? moneyCell(lot.realizedProfit, amountClass(lot.realizedProfit)) : moneyCell(null)) },
  ], [moneyCell, t]);

  const lotColumns = lotTab === "held" ? heldColumns : clearedColumns;

  const lotsSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (visibleLots.length === 0) return undefined;
    const cells: Record<string, ReactNode> = {
      bond: <span className="font-semibold text-slate-800">{t("debtShell.summaryRow")}</span>,
    };
    if (lotTab === "held") {
      cells.principal = <span className="font-semibold tabular-nums text-slate-800">{formatMoney(totalPrincipal)}</span>;
      if (totalPaidInterest > 0) {
        cells.paidInterest = <span className="font-semibold tabular-nums text-emerald-600">{formatMoney(totalPaidInterest)}</span>;
      }
      if (totalExpectedInterest > 0) {
        cells.expectedInterest = <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(totalExpectedInterest)}</span>;
      }
    }
    return { cells, rowClassName: "bg-slate-50/80" };
  }, [lotTab, t, totalExpectedInterest, totalPaidInterest, totalPrincipal, visibleLots.length]);

  const entryColumns = useMemo<AdvancedDataTableColumn<BondShellEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterKind: "dateRange", filterText: (entry) => entry.date, sortValue: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "action", label: t("bondShell.colAction"), width: 96, minWidth: 72, filterText: (entry) => entry.typeLabel, sortValue: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "bond", label: t("bondShell.colBond"), width: 190, minWidth: 120, filterText: (entry) => entry.bondName, filterSearchText: (entry) => entry.bondName, sortValue: (entry) => entry.bondName, render: (entry) => <span className="truncate text-slate-700" title={entry.bondName}>{entry.bondName || "-"}</span> },
    { key: "arrivalDate", label: t("bondShell.colArrivalDate"), width: 108, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (entry) => entry.arrivalDate ?? "", sortValue: (entry) => entry.arrivalDate ?? "", render: (entry) => <span className="tabular-nums text-slate-600">{entry.arrivalDate || "-"}</span> },
    { key: "cashAccount", label: t("bondShell.colCashAccount"), width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, filterSearchText: (entry) => entry.cashAccountLabel, sortValue: (entry) => entry.cashAccountLabel, render: (entry) => <span className="truncate text-slate-600" title={entry.cashAccountLabel}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: t("detail.column.remark"), width: 220, minWidth: 120, hideable: true, filterText: (entry) => entry.note, filterSearchText: (entry) => entry.note, sortValue: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: t("bondShell.colAmount"),
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
  ], [t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey="mmh:bond:split-height"
        hasLowerPane
        defaultUpperHeight={360}
        separatorLabel={t("bondShell.resizeLabel")}
        separatorTitle={t("bondShell.resizeTitle")}
      >
        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-amber-600" />
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => switchLotTab("held")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "held" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("bondShell.holdingsTitle")}
                </button>
                <button
                  type="button"
                  onClick={() => switchLotTab("cleared")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "cleared" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("bondShell.clearedTitle")}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">
                {selectedLot
                  ? formatText("bondShell.lotSelectedHint", { name: selectedLot.name })
                  : lotTab === "held"
                    ? formatText("bondShell.holdingsHint", {
                        count: heldLots.length,
                        amount: formatMoney(totalPrincipal),
                        scope: institutionName || accountLabel,
                      })
                    : formatText("bondShell.clearedHint", { count: clearedLots.length })}
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <AdvancedDataTable
              storageKey="mmh_bond_lots_table_v1"
              columns={lotColumns}
              rows={visibleLots}
              rowKey={(lot) => lot.id}
              minTableWidth={1120}
              emptyText={lotTab === "held" ? t("bondShell.emptyHoldings") : t("bondShell.emptyCleared")}
              showFilters
              fillHeight
              toolbarMode="none"
              defaultSort={{ key: "principal", direction: "desc" }}
              summaryRow={lotsSummaryRow}
              onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
              rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
            />
          </div>
        </section>

        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-slate-800">
              {selectedEntryIds.size > 0 ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={batchDeleteEntries}
                    className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                    title={t("common.delete")}
                    aria-label={t("common.delete")}
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
              <span className="flex h-6 shrink-0 items-center">{t("bondShell.entriesTitle")}</span>
              <span className="ml-2 shrink-0 text-xs font-normal text-slate-400">
                {selectedLot
                  ? formatText("bondShell.entryCountHint", { count: visibleEntries.length })
                  : formatText("bondShell.allEntryCountHint", { count: visibleEntries.length })}
              </span>
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
                  window.dispatchEvent(new CustomEvent(BOND_ENTRY_COLUMN_SETTINGS_EVENT, {
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
              storageKey="mmh_bond_entries_table_v1"
              columns={entryColumns}
              rows={visibleEntries}
              rowKey={(entry) => entry.id}
              minTableWidth={1020}
              emptyText={selectedLot ? t("bondShell.emptyRelatedEntries") : t("bondShell.emptyEntries")}
              fillHeight
              toolbarMode="none"
              columnVisibilityTriggerId={BOND_ENTRY_COLUMN_SETTINGS_EVENT}
              showColumnVisibilityButton={false}
              showFilters
              selectable
              selectOnRowClick
              selectAllScope="renderedRows"
              selectedKeys={selectedEntryIds}
              onSelectionChange={setSelectedEntryIds}
              rowActions={(entry) => <EntryRowActions entryId={entry.id} edit={entry.edit} />}
              rowActionsWidth={84}
              rowActionsMinWidth={76}
              rowClassName={(entry) => (selectedEntryIds.has(entry.id) ? "bg-blue-50/70 hover:bg-blue-50/70" : "hover:bg-blue-50/40")}
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
    </div>
  );
}
