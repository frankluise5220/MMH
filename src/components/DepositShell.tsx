"use client";

import { useCallback, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Landmark } from "lucide-react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "./AdvancedDataTable";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import { EntryRowActions } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { amountToneClass as amountClass } from "@/lib/client/colors";
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
  businessTransactionId?: string | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  edit?: {
    type: "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    cashAccountId?: string;
    fundName?: string;
    fundArrivalDate?: string | null;
    fundProductType?: string;
    fundSubtype?: string;
  };
};

type DepositLot = {
  id: string;
  label: string;
  fundName: string;
  subLabel?: string;
  startDate?: string | null;
  maturityDate?: string | null;
  originalAmount: number;
  remainingAmount: number;
  annualRate?: number | null;
  status: "open" | "closed";
  depositAccountId?: string;
  depositAccountLabel?: string;
  relatedEntryIds?: string[];
};

export function DepositShell({
  accountLabel,
  institutionName,
  entries,
  lots,
}: {
  accountLabel: string;
  institutionName?: string;
  entries: DepositEntry[];
  lots: DepositLot[];
}) {
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());

  const { t } = useI18n();
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

  const visibleEntries = useMemo(() => {
    if (!selectedLot) return [];
    const relatedIds = new Set(selectedLot.relatedEntryIds ?? [selectedLot.id]);
    return entries.filter((entry) => relatedIds.has(entry.id));
  }, [entries, selectedLot]);

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    const entryIds = Array.from(selectedEntryIds);
    const data = await deleteEntriesWithLinkedPrompt({
      entryIds,
      confirmMessage: formatText("depositShell.batchDeleteConfirm", { count: selectedEntryIds.size }),
    });
    if (!data.ok) {
      if (data.error === "已取消删除") return;
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

  const lotColumns = useMemo<AdvancedDataTableColumn<DepositLot>[]>(() => [
    {
      key: "product",
      label: t("depositShell.colProduct"),
      width: 260,
      minWidth: 160,
      filterText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.fundName}>{lot.fundName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{t("investment.product.deposit")}</span>
        </div>
      ),
    },
    { key: "startDate", label: t("depositShell.colStartDate"), width: 110, minWidth: 84, hideable: true, filterText: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterText: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "originalAmount", label: t("depositShell.colOriginalAmount"), width: 120, minWidth: 86, align: "right", hideable: true, render: (lot) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(lot.originalAmount)}</span> },
    { key: "remainingAmount", label: t("depositShell.colRemainingAmount"), width: 120, minWidth: 86, align: "right", render: (lot) => <span className={`font-semibold tabular-nums ${amountClass(lot.remainingAmount)}`}>{formatMoney(lot.remainingAmount)}</span> },
    { key: "annualRate", label: t("depositShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "status", label: t("depositShell.colStatus"), width: 90, minWidth: 70, hideable: true, filterText: (lot) => lot.status === "open" ? t("depositShell.status.open") : t("depositShell.status.closed"), render: (lot) => lot.status === "open" ? t("depositShell.status.open") : t("depositShell.status.closed") },
  ], [t]);

  const entryColumns = useMemo<AdvancedDataTableColumn<DepositEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "action", label: t("depositShell.colAction"), width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "product", label: t("depositShell.colProduct"), width: 190, minWidth: 120, filterText: (entry) => entry.fundName, render: (entry) => <span className="truncate text-slate-700" title={entry.fundName}>{entry.fundName || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterText: (entry) => entry.maturityDate ?? "", render: (entry) => <span className="tabular-nums text-slate-600">{entry.maturityDate || "-"}</span> },
    { key: "cashAccount", label: t("depositShell.colCashAccount"), width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, render: (entry) => <span className="truncate text-slate-600" title={entry.cashAccountLabel}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: t("detail.column.remark"), width: 240, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: t("depositShell.colAmount"),
      width: 120,
      minWidth: 86,
      align: "right",
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
        storageKey="mmh:deposit:split-height"
        hasLowerPane={!!selectedLot}
        defaultUpperHeight={360}
        separatorLabel={t("depositShell.resizeLabel")}
        separatorTitle={t("depositShell.resizeTitle")}
      >
        <section className="panel-surface flex min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-600" />
              {t("depositShell.holdingsTitle")}
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot ? formatText("depositShell.lotSelectedHint", { name: selectedLot.fundName }) : formatText("depositShell.allHoldingsHint", { scope: institutionName || accountLabel })}
            </div>
          </div>
          <AdvancedDataTable
            storageKey="mmh_deposit_lots_table_v1"
            columns={lotColumns}
            rows={lots}
            rowKey={(lot) => lot.id}
            minTableWidth={920}
            emptyText={t("depositShell.emptyHoldings")}
            showFilters={false}
            fillHeight
            onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
            rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
          />
        </section>

        <section className="panel-surface flex min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-blue-500" />
              {t("depositShell.entriesTitle")}
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot ? formatText("depositShell.entryCountHint", { count: visibleEntries.length }) : t("depositShell.selectLotFirst")}
            </div>
          </div>
          <AdvancedDataTable
            storageKey="mmh_deposit_entries_table_v1"
            columns={entryColumns}
            rows={visibleEntries}
            rowKey={(entry) => entry.id}
            minTableWidth={1020}
            emptyText={selectedLot ? t("depositShell.emptyRelatedEntries") : t("depositShell.selectLotFirst")}
            fillHeight
            selectable
            selectedKeys={selectedEntryIds}
            onSelectionChange={setSelectedEntryIds}
            rowActions={(entry) => {
              const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
              const labels = entry.businessLinkLabels ?? [];
              const title = hasBusinessLink
                ? formatText("depositShell.linkedTitle", { labels: labels.join("、") || t("depositShell.businessRecord") })
                : t("depositShell.unlinkedTitle");
              return (
                <>
                  <BusinessLinkActionButton
                    active={hasBusinessLink}
                    title={title}
                    busy={linkingIds.has(entry.id)}
                    onClick={() => linkDepositCashFlow(entry)}
                  />
                  <EntryRowActions entryId={entry.id} edit={entry.edit} />
                </>
              );
            }}
            rowActionsWidth={112}
            rowActionsMinWidth={92}
            batchActions={[
              { label: t("depositShell.batchDelete"), title: t("depositShell.deleteButton"), ariaLabel: t("depositShell.deleteButton"), tone: "danger", onClick: batchDeleteEntries },
            ]}
          />
        </section>
      </ResizableVerticalSplit>
    </div>
  );
}
