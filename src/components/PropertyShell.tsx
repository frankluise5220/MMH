"use client";

import { Boxes, RefreshCcw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";
import { formatCurrencyMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

type PropertyPosition = {
  fundCode: string;
  accountId?: string | null;
  propertyAssetId?: string | null;
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
  date: string;
  amount?: number | null;
  accountName?: string | null;
  toAccountName?: string | null;
  propertyAssetId?: string | null;
  propertyAction?: string | null;
  propertySettlementDate?: string | null;
  propertyTax?: number | null;
  fundFee?: number | null;
  realizedProfit?: number | null;
  note?: string | null;
};

type Props = {
  accountId: string;
  defaultCashAccountId?: string;
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

export function PropertyShell({
  accountId,
  defaultCashAccountId = "",
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

  function openFixedAssetExpense(position: PropertyPosition) {
    const assetId = position.propertyAssetId ?? position.fundCode;
    const fixedAssetAccountId = position.accountId ?? accountId;
    setSelectedAssetId(assetId);
    window.dispatchEvent(new CustomEvent("mmh:create-transaction:open", {
      detail: {
        requestId: `fixed-asset-expense-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        source: "fixed-asset",
        item: { type: "expense", remark: position.name },
        lockedType: "expense",
        defaultAccountId: defaultCashAccountId,
        fixedAssetAccountId,
        fixedAssetAssetId: assetId,
        fixedAssetRequired: true,
        lockFixedAsset: true,
      },
    }));
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
      key: "fee",
      label: t("txForm.fee"),
      width: 96,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (entry) => entry.fundFee == null ? null : String(entry.fundFee),
      filterNumber: (entry) => entry.fundFee == null ? null : Number(entry.fundFee),
      sortValue: (entry) => entry.fundFee == null ? null : Number(entry.fundFee),
      render: (entry) => <span className="text-xs tabular-nums text-slate-600">{entry.fundFee == null ? "-" : formatCurrencyMoney(Number(entry.fundFee), displayCurrency)}</span>,
    },
    {
      key: "tax",
      label: t("propertyForm.tax"),
      width: 96,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (entry) => entry.propertyTax == null ? null : String(entry.propertyTax),
      filterNumber: (entry) => entry.propertyTax == null ? null : Number(entry.propertyTax),
      sortValue: (entry) => entry.propertyTax == null ? null : Number(entry.propertyTax),
      render: (entry) => <span className="text-xs tabular-nums text-slate-600">{entry.propertyTax == null ? "-" : formatCurrencyMoney(Number(entry.propertyTax), displayCurrency)}</span>,
    },
    {
      key: "settlementDate",
      label: t("propertyForm.settlementDate"),
      width: 108,
      minWidth: 92,
      filterKind: "dateRange",
      filterText: (entry) => entry.propertySettlementDate || null,
      sortValue: (entry) => entry.propertySettlementDate || null,
      render: (entry) => <span className="whitespace-nowrap text-xs tabular-nums text-slate-600">{entry.propertySettlementDate || "-"}</span>,
    },
    {
      key: "realizedProfit",
      label: t("stockHoldingReport.colRealized"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (entry) => entry.realizedProfit == null ? null : String(entry.realizedProfit),
      filterNumber: (entry) => entry.realizedProfit == null ? null : Number(entry.realizedProfit),
      sortValue: (entry) => entry.realizedProfit == null ? null : Number(entry.realizedProfit),
      render: (entry) => entry.realizedProfit == null
        ? <span className="text-xs text-slate-300">-</span>
        : <span className={`text-xs tabular-nums ${pnlCls(Number(entry.realizedProfit))}`}>{formatCurrencyMoney(Number(entry.realizedProfit), displayCurrency)}</span>,
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
              minTableWidth={920}
              rowClassName={(position) => {
                const assetId = position.propertyAssetId ?? position.fundCode;
                const selected = assetId === selectedAssetId;
                return `cursor-pointer ${selected ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
              }}
              onRowClick={openFixedAssetExpense}
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
                sortable
                defaultSort={{ key: "date", direction: "desc" }}
              />
            </div>
          </div>
        ) : null}
      </ResizableVerticalSplit>
    </div>
  );
}
