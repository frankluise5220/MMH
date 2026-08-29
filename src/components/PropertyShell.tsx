"use client";

import { Boxes, Paperclip, Pencil, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { FixedAssetEditModal, type FixedAssetEditMeta, type FixedAssetEditValue } from "@/components/FixedAssetEditModal";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";
import { EntryAttachmentWindow } from "@/components/EntryAttachmentWindow";
import { EntryRowActions } from "@/components/EntryRowActions";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatCurrencyMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";

type PropertyPosition = {
  fundCode: string;
  accountId?: string | null;
  propertyAssetId?: string | null;
  assetType?: string | null;
  propertyType?: string | null;
  address?: string | null;
  attributes?: Record<string, unknown> | null;
  purchasePrice?: number | null;
  note?: string | null;
  name: string;
  holdingDate: string;
  cost: number;
  marketValue: number;
  navDate: string;
  floatingPnL: number;
  floatingPnLRate: number;
};

type FixedAssetTransaction = {
  id: string;
  accountId?: string | null;
  toAccountId?: string | null;
  date: string;
  amount?: number | null;
  accountName?: string | null;
  cashAccountId?: string | null;
  toAccountName?: string | null;
  propertyAssetId?: string | null;
  assetType?: string | null;
  propertyAction?: string | null;
  propertySettlementDate?: string | null;
  settlementDate?: string | null;
  propertyTax?: number | null;
  tax?: number | null;
  fundFee?: number | null;
  fee?: number | null;
  realizedProfit?: number | null;
  note?: string | null;
};

type Props = {
  accountId: string;
  currency: string;
  baseCurrency: string;
  positions: PropertyPosition[];
  entries: FixedAssetTransaction[];
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
};

function rate(value: number) {
  return formatPercent(value);
}

function actionLabel(t: (key: string) => string, action: string | null | undefined) {
  if (action === "purchase") return t("propertyForm.action.purchase");
  if (action === "improvement") return t("propertyForm.action.improvement");
  if (action === "sale") return t("propertyForm.action.sale");
  return action || "-";
}

function assetTypeLabel(t: (key: string) => string, assetType: string | null | undefined) {
  const type = assetType || "property";
  return t(`fixedAsset.type.${type}`);
}

function assetDetailText(position: PropertyPosition) {
  const type = position.assetType || "property";
  const attrs = position.attributes ?? {};
  if (type === "property") {
    const parts = [position.address, position.propertyType].filter((v) => v && String(v).trim());
    return parts.join(" · ") || "-";
  }
  if (type === "vehicle") {
    const parts = [attrs.plateNo, attrs.brandModel].filter((v) => v != null && String(v).trim());
    return parts.join(" · ") || "-";
  }
  if (type === "equipment" || type === "furniture") {
    const parts = [attrs.brand, attrs.model].filter((v) => v != null && String(v).trim());
    return parts.join(" · ") || "-";
  }
  if (type === "collectible") {
    const parts = [attrs.category, attrs.origin].filter((v) => v != null && String(v).trim());
    return parts.join(" · ") || "-";
  }
  return "-";
}

export function PropertyShell({
  accountId,
  currency,
  baseCurrency,
  positions,
  entries,
  totalMarketValue,
  totalCost,
  isRedUp,
}: Props) {
  const { t } = useI18n();
  const displayCurrency = currency || baseCurrency || "CNY";
  const floatingPnL = totalMarketValue - totalCost;
  const floatingRate = totalCost > 0 ? floatingPnL / totalCost : 0;
  const pnlCls = useCallback((value: number) => pnlClassFromRedUp(value, isRedUp), [isRedUp]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [editValue, setEditValue] = useState<FixedAssetEditValue | null>(null);
  const [editMeta, setEditMeta] = useState<FixedAssetEditMeta | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [attachmentViewEntryId, setAttachmentViewEntryId] = useState<string | null>(null);
  const [transactionPage, setTransactionPage] = useState(1);
  const [transactionPageSize] = useState(20);

  const selectedPosition = useMemo(
    () => positions.find((position) => (position.propertyAssetId ?? position.fundCode) === selectedAssetId) ?? null,
    [positions, selectedAssetId],
  );
  const selectedEntries = useMemo(
    () => selectedAssetId
      ? entries.filter((entry) => (entry.propertyAssetId ?? "") === selectedAssetId)
      : [],
    [entries, selectedAssetId],
  );

  useEffect(() => {
    setTransactionPage(1);
  }, [selectedAssetId]);

  function selectPosition(position: PropertyPosition) {
    const assetId = position.propertyAssetId ?? position.fundCode;
    setSelectedAssetId((current) => (current === assetId ? "" : assetId));
  }

  function buildPropertyEditEvent(entry: FixedAssetTransaction) {
    const amount = Number(entry.amount ?? 0);
    const isCashIn = amount >= 0;
    return {
      name: "mmh:transaction:edit",
      detail: {
        requestId: "property-edit-" + Date.now(),
        entryId: entry.id,
        type: isCashIn ? "income" : "expense",
        date: entry.date?.slice(0, 10) ?? "",
        postedAt: entry.date ?? "",
        // Keep the stored sign; the transaction dialog converts expense/income display amounts.
        amount,
        note: entry.note ?? "",
        // Sale income edits receive money in the cash account; purchases/improvements spend from it.
        accountId: (isCashIn ? entry.toAccountId ?? entry.accountId : entry.accountId) ?? "",
        accountName: (isCashIn ? entry.toAccountName : entry.accountName) ?? "",
        accountLabel: (isCashIn ? entry.toAccountName : entry.accountName) ?? "",
        hasFundDetail: false,
        // Purchases/improvements are fixed-asset expenses: keep the toggle on and prefill the linked account/asset.
        fixedAssetLinked: !isCashIn,
        fixedAssetAccountId: isCashIn ? "" : (entry.toAccountId ?? ""),
        fixedAssetAssetId: isCashIn ? "" : (entry.propertyAssetId ?? ""),
      },
    };
  }

  function openFixedAssetEdit(position: PropertyPosition) {
    const assetId = position.propertyAssetId ?? position.fundCode;
    setEditValue({
      id: assetId,
      name: position.name,
      assetType: normalizeFixedAssetType(position.assetType),
      propertyType: position.propertyType ?? "",
      address: position.address ?? "",
      attributes: (position.attributes ?? {}) as Record<string, unknown>,
      purchaseDate: position.holdingDate || "",
      purchasePrice: position.purchasePrice != null ? String(position.purchasePrice) : "",
      note: position.note ?? "",
    });
    setEditMeta({
      accountName: position.name,
      marketValue: position.marketValue,
      cost: position.cost,
    });
  }

  async function saveFixedAssetEdit(next: FixedAssetEditValue) {
    setSavingEdit(true);
    try {
      const response = await fetch("/api/v1/properties", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyAssetId: next.id,
          name: next.name.trim(),
          assetType: next.assetType,
          propertyType: next.propertyType.trim() || undefined,
          address: next.address.trim() || undefined,
          attributes: next.attributes ?? undefined,
          purchaseDate: next.purchaseDate.trim() || undefined,
          purchasePrice: next.purchasePrice.trim() || undefined,
          note: next.note.trim() || undefined,
        }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("fixedAssetEdit.saveFailed"));
      }
      setEditValue(null);
      setEditMeta(null);
      dispatchFinanceDataChanged({ reason: "fixed-asset-save", accountIds: [accountId] });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("fixedAssetEdit.saveFailed"));
    } finally {
      setSavingEdit(false);
    }
  }

  const positionColumns = useMemo<AdvancedDataTableColumn<PropertyPosition>[]>(() => [
    {
      key: "asset",
      label: t("settings.accounts.name"),
      width: 240,
      minWidth: 160,
      headerClassName: "text-left",
      className: "px-4",
      sortValue: (position) => position.name,
      filterText: (position) => position.name,
      render: (position) => {
        const assetId = position.propertyAssetId ?? position.fundCode;
        const selected = assetId === selectedAssetId;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <Boxes className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className={`truncate text-xs font-medium ${selected ? "text-blue-700" : "text-slate-700"}`} title={position.name}>
                {position.name}
              </div>
              <div className="truncate text-[11px] text-slate-400">{assetId}</div>
            </div>
          </div>
        );
      },
    },
    {
      key: "assetType",
      label: t("fixedAssetEdit.assetType"),
      width: 96,
      minWidth: 80,
      sortValue: (position) => assetTypeLabel(t, position.assetType),
      filterText: (position) => assetTypeLabel(t, position.assetType),
      render: (position) => <span className="text-xs text-slate-600">{assetTypeLabel(t, position.assetType)}</span>,
    },
    {
      key: "assetDetail",
      label: t("propertyShell.column.detail"),
      width: 200,
      minWidth: 140,
      sortValue: (position) => assetDetailText(position),
      filterText: (position) => assetDetailText(position),
      truncate: true,
      cellTitle: (position) => assetDetailText(position),
      render: (position) => <span className="text-xs text-slate-600">{assetDetailText(position)}</span>,
    },
    {
      key: "holdingDate",
      label: t("propertyShell.column.purchaseDate"),
      width: 112,
      minWidth: 88,
      className: "tabular-nums text-slate-600",
      sortValue: (position) => position.holdingDate,
      filterKind: "dateRange",
      filterText: (position) => position.holdingDate,
      render: (position) => position.holdingDate || "-",
    },
    {
      key: "cost",
      label: t("propertyShell.column.cost"),
      width: 124,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.cost),
      filterNumber: (position) => position.cost,
      sortValue: (position) => position.cost,
      render: (position) => formatCurrencyMoney(position.cost, displayCurrency),
    },
    {
      key: "marketValue",
      label: t("propertyShell.column.marketValue"),
      width: 124,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.marketValue),
      filterNumber: (position) => position.marketValue,
      sortValue: (position) => position.marketValue,
      render: (position) => <span className={pnlCls(position.marketValue)}>{formatCurrencyMoney(position.marketValue, displayCurrency)}</span>,
    },
    {
      key: "valuationDate",
      label: t("propertyShell.column.valuationDate"),
      width: 112,
      minWidth: 88,
      className: "tabular-nums text-slate-600",
      sortValue: (position) => position.navDate,
      filterKind: "dateRange",
      filterText: (position) => position.navDate,
      render: (position) => position.navDate || "-",
    },
    {
      key: "floatingPnL",
      label: t("propertyShell.floatingPnL"),
      width: 124,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.floatingPnL),
      filterNumber: (position) => position.floatingPnL,
      sortValue: (position) => position.floatingPnL,
      render: (position) => <span className={pnlCls(position.floatingPnL)}>{formatCurrencyMoney(position.floatingPnL, displayCurrency)}</span>,
    },
    {
      key: "floatingRate",
      label: t("stockHoldingReport.colFloatingPnLRate"),
      width: 96,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.floatingPnLRate),
      filterNumber: (position) => position.floatingPnLRate,
      sortValue: (position) => position.floatingPnLRate,
      render: (position) => <span className={pnlCls(position.floatingPnLRate)}>{rate(position.floatingPnLRate)}</span>,
    },
    {
      key: "actions",
      label: t("detail.column.actions"),
      width: 112,
      minWidth: 96,
      align: "right",
      render: (position) => {
        const assetId = position.propertyAssetId ?? position.fundCode;
        return (
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openFixedAssetEdit(position);
              }}
              title={t("fixedAssetEdit.editButton")}
              aria-label={t("fixedAssetEdit.editButton")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 hover:text-blue-600"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                window.dispatchEvent(new CustomEvent("mmh:property:valuation", {
                  detail: {
                    defaultPropertyAccountId: position.accountId ?? accountId,
                    propertyAssetId: assetId,
                    propertyName: position.name,
                    currentMarketValue: position.marketValue,
                  },
                }));
              }}
              className="secondary-button h-7 gap-1 px-2 text-xs"
            >
              <RefreshCcw className="h-3.5 w-3.5" />
              {t("propertyShell.updateValuation")}
            </button>
          </div>
        );
      },
    },
  ], [accountId, displayCurrency, pnlCls, selectedAssetId, t]);

  const positionSummaryRow = useMemo(() => {
    if (positions.length === 0) return undefined;
    return {
      cells: {
        asset: t("debtShell.summaryRow"),
        cost: <span className="tabular-nums text-slate-800">{formatCurrencyMoney(totalCost, displayCurrency)}</span>,
        marketValue: <span className={`tabular-nums ${pnlCls(totalMarketValue)}`}>{formatCurrencyMoney(totalMarketValue, displayCurrency)}</span>,
        floatingPnL: <span className={`tabular-nums ${pnlCls(floatingPnL)}`}>{formatCurrencyMoney(floatingPnL, displayCurrency)}</span>,
        floatingRate: <span className={`tabular-nums ${pnlCls(floatingRate)}`}>{rate(floatingRate)}</span>,
      },
    };
  }, [displayCurrency, floatingPnL, floatingRate, pnlCls, positions.length, t, totalCost, totalMarketValue]);

  const transactionColumns = useMemo<AdvancedDataTableColumn<FixedAssetTransaction>[]>(() => [
    {
      key: "date",
      label: t("propertyForm.dateTransaction"),
      width: 108,
      minWidth: 92,
      filterKind: "dateRange",
      filterText: (entry) => entry.date,
      sortValue: (entry) => entry.date,
      render: (entry) => <span className="whitespace-nowrap text-xs tabular-nums text-slate-700">{entry.date || "-"}</span>,
    },
    {
      key: "action",
      label: t("depositShell.colAction"),
      width: 104,
      minWidth: 88,
      filterText: (entry) => actionLabel(t, entry.propertyAction),
      sortValue: (entry) => actionLabel(t, entry.propertyAction),
      render: (entry) => <span className="text-xs text-slate-700">{actionLabel(t, entry.propertyAction)}</span>,
    },
    {
      key: "cashAccount",
      label: t("depositShell.colCashAccount"),
      width: 180,
      minWidth: 120,
      filterText: (entry) => entry.propertyAction === "sale" ? entry.toAccountName ?? "" : entry.accountName ?? "",
      sortValue: (entry) => entry.propertyAction === "sale" ? entry.toAccountName ?? "" : entry.accountName ?? "",
      truncate: true,
      cellTitle: (entry) => entry.propertyAction === "sale" ? entry.toAccountName ?? "" : entry.accountName ?? "",
      render: (entry) => {
        const value = entry.propertyAction === "sale" ? entry.toAccountName : entry.accountName;
        return value ? <span className="text-xs text-slate-700">{value}</span> : <span className="text-slate-300">-</span>;
      },
    },
    {
      key: "amount",
      label: t("depositShell.colAmount"),
      width: 124,
      minWidth: 96,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (entry) => entry.amount == null ? null : String(entry.amount),
      filterNumber: (entry) => entry.amount == null ? null : Number(entry.amount),
      sortValue: (entry) => entry.amount == null ? null : Number(entry.amount),
      render: (entry) => {
        const value = Number(entry.amount ?? 0);
        return <span className={`text-xs tabular-nums ${pnlCls(value)}`}>{formatCurrencyMoney(value, displayCurrency)}</span>;
      },
    },
    {
      key: "note",
      label: t("detail.column.remark"),
      width: 180,
      minWidth: 120,
      filterText: (entry) => entry.note ?? "",
      sortValue: (entry) => entry.note ?? "",
      truncate: true,
      cellTitle: (entry) => entry.note ?? "",
      render: (entry) => entry.note ? <span className="text-xs text-slate-600">{entry.note}</span> : <span className="text-slate-300">-</span>,
    },
  ], [displayCurrency, pnlCls, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey={`mmh:fixed-asset-shell:${accountId || "all"}:split-height`}
        hasLowerPane={Boolean(selectedPosition)}
        defaultUpperHeight={360}
        separatorLabel={t("propertyShell.resizeLabel")}
        separatorTitle={t("propertyShell.resizeTitle")}
        stackOnMobile
      >
        <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 justify-end border-b border-slate-200 px-4 py-3">
            <div className="grid grid-cols-3 gap-6 text-right text-xs">
              <div>
                <div className="text-slate-500">{t("propertyShell.marketValue")}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatCurrencyMoney(totalMarketValue, displayCurrency)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">{t("propertyShell.totalCost")}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatCurrencyMoney(totalCost, displayCurrency)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">{t("propertyShell.floatingPnL")}</div>
                <div className={`mt-1 text-sm font-semibold tabular-nums ${pnlCls(floatingPnL)}`}>
                  {formatCurrencyMoney(floatingPnL, displayCurrency)} · {rate(floatingRate)}
                </div>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <AdvancedDataTable
              storageKey="mmh_fixed_asset_positions_advanced_v1"
              columns={positionColumns}
              rows={positions}
              rowKey={(position, index) => position.propertyAssetId ?? position.fundCode ?? String(index)}
              emptyText={t("propertyShell.emptyTitle")}
              minTableWidth={1240}
              rowClassName={(position) => {
                const assetId = position.propertyAssetId ?? position.fundCode;
                const selected = assetId === selectedAssetId;
                return `cursor-pointer ${selected ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
              }}
              onRowClick={selectPosition}
              onRowDoubleClick={openFixedAssetEdit}
              showFilters={false}
              fillHeight
              compactRows
              toolbarMode="none"
              draggableRows={false}
              sortable
              defaultSort={{ key: "marketValue", direction: "desc" }}
              summaryRow={positionSummaryRow}
            />
          </div>
        </div>

        {selectedPosition ? (
          <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
            <div className="panel-header h-12 shrink-0">
              <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-800">
                <span>{t("propertyShell.transactionDetails")}</span>
                <span className="truncate text-xs font-normal text-slate-500">{selectedPosition.name}</span>
                <span className="text-xs font-normal text-slate-400">{t("propertyShell.transactionCount", { count: selectedEntries.length })}</span>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <AdvancedDataTable
                storageKey="mmh_fixed_asset_transaction_details_v1"
                resetKey={`${accountId}:${selectedAssetId}`}
                columns={transactionColumns}
                rows={selectedEntries}
                rowKey={(entry) => entry.id}
                emptyText={t("propertyShell.emptyTransactions")}
                minTableWidth={980}
                fillHeight
                compactRows
                toolbarMode="none"
                showFilters
                onRowDoubleClick={(entry) => {
                  const event = buildPropertyEditEvent(entry);
                  window.dispatchEvent(new CustomEvent(event.name, { detail: event.detail }));
                }}
                rowActions={(entry) => (
                  <>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setAttachmentViewEntryId(entry.id);
                      }}
                      title={t("attachments.title")}
                      aria-label={t("attachments.title")}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-amber-200 bg-white text-amber-600 transition-colors hover:border-amber-300 hover:bg-amber-50"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </button>
                    <EntryRowActions entryId={entry.id} customEditEvent={buildPropertyEditEvent(entry)} />
                  </>
                )}
                rowActionsWidth={112}
                rowActionsMinWidth={92}
                pagination={{ page: transactionPage, pageSize: transactionPageSize, onPageChange: setTransactionPage }}
                sortable
                defaultSort={{ key: "date", direction: "desc" }}
              />
            </div>
          </div>
        ) : null}
      </ResizableVerticalSplit>

      <FixedAssetEditModal
        open={!!editValue}
        saving={savingEdit}
        value={editValue}
        meta={editMeta}
        onClose={() => {
          if (savingEdit) return;
          setEditValue(null);
          setEditMeta(null);
        }}
        onChange={setEditValue}
        onSaved={saveFixedAssetEdit}
      />

      <EntryAttachmentWindow
        open={attachmentViewEntryId != null}
        entryId={attachmentViewEntryId}
        onClose={() => setAttachmentViewEntryId(null)}
      />
    </div>
  );
}
