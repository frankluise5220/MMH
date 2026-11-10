"use client";

import { useMemo } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { formatCurrencyMoney, formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

/**
 * 股票视图 › 逆回购 页签的存单表。
 *
 * 逆回购只有一个动作（借出），到期自动回款，所以这张表里没有「回款」按钮：
 * 用户看到的是「这笔钱借出去多少、年化多少、哪一天回来、已经回来多少」。
 * 数据结构与 `loadRepoShellData().lots` 同构（字段名一致，可直接透传）。
 */
export type RepoLotRow = {
  id: string;
  name: string;
  code: string | null;
  termDays: number | null;
  annualRate: number | null;
  principal: number;
  startDate: string | null;
  maturityDate: string | null;
  clearedDate: string | null;
  occupiedDays: number | null;
  remainingDays: number | null;
  fee: number | null;
  expectedInterest: number | null;
  actualInterest: number | null;
  realizedProfit: number;
  status: "open" | "closed";
};

/** 股票视图「逆回购」页签的数据包（`loadRepoShellData` 去掉明细行后的部分）。 */
export type StockRepoPanelData = {
  lots: RepoLotRow[];
  totalPrincipal: number;
  totalExpectedInterest: number;
  totalRealizedProfit: number;
  openCount: number;
};

type Props = {
  rows: RepoLotRow[];
  currency: string;
  minTableWidth?: number;
};

function dash(value: string | null | undefined) {
  return value ? <span className="text-slate-700">{value}</span> : <span className="text-slate-300">-</span>;
}

export function RepoLotsTable({ rows, currency, minTableWidth = 1080 }: Props) {
  const { t } = useI18n();

  const columns = useMemo<AdvancedDataTableColumn<RepoLotRow>[]>(() => [
    {
      key: "product",
      label: t("repoShell.colProduct"),
      width: 220,
      minWidth: 150,
      headerClassName: "text-left",
      className: "px-4",
      sortValue: (row) => `${row.code ?? ""} ${row.name}`,
      filterText: (row) => `${row.code ?? ""} ${row.name}`,
      render: (row) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-slate-800">{row.name || "-"}</span>
          <span className="truncate font-mono text-[11px] tabular-nums text-slate-400">
            {row.code ?? "-"}
            {row.termDays ? ` · ${row.termDays}${t("repoShell.dayUnit")}` : ""}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      label: t("stockPanel.repoColStatus"),
      width: 96,
      minWidth: 80,
      headerClassName: "text-left",
      sortValue: (row) => (row.status === "open" ? 0 : 1),
      filterText: (row) =>
        row.status === "closed"
          ? t("stockPanel.repoStatusClosed")
          : (row.remainingDays ?? 0) < 0
            ? t("repoShell.overdue")
            : t("stockPanel.repoStatusOpen"),
      render: (row) => {
        if (row.status === "closed") {
          return (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
              {t("stockPanel.repoStatusClosed")}
            </span>
          );
        }
        if ((row.remainingDays ?? 0) < 0) {
          return (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">
              {t("repoShell.overdue")}
            </span>
          );
        }
        return (
          <span className="rounded bg-cyan-50 px-1.5 py-0.5 text-[11px] text-cyan-700">
            {t("stockPanel.repoStatusOpen")}
          </span>
        );
      },
    },
    {
      key: "startDate",
      label: t("repoShell.colLendDate"),
      width: 106,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      sortValue: (row) => row.startDate ?? "",
      filterText: (row) => row.startDate,
      render: (row) => dash(row.startDate),
    },
    {
      key: "maturityDate",
      label: t("repoShell.colMaturityDate"),
      width: 106,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      sortValue: (row) => row.maturityDate ?? "",
      filterText: (row) => row.maturityDate,
      render: (row) => dash(row.maturityDate),
    },
    {
      key: "clearedDate",
      label: t("repoShell.colClearedDate"),
      width: 106,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      sortValue: (row) => row.clearedDate ?? "",
      filterText: (row) => row.clearedDate,
      render: (row) => dash(row.clearedDate),
    },
    {
      key: "occupiedDays",
      label: t("repoShell.colOccupiedDays"),
      width: 96,
      minWidth: 80,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => (row.occupiedDays == null ? null : String(row.occupiedDays)),
      filterNumber: (row) => row.occupiedDays,
      sortValue: (row) => row.occupiedDays,
      render: (row) =>
        row.occupiedDays == null ? <span className="text-slate-300">-</span> : <span className="text-slate-700">{row.occupiedDays}</span>,
    },
    {
      key: "annualRate",
      label: t("repoShell.colAnnualRate"),
      width: 96,
      minWidth: 78,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => (row.annualRate == null ? null : String(row.annualRate)),
      filterNumber: (row) => row.annualRate,
      sortValue: (row) => row.annualRate,
      render: (row) =>
        row.annualRate == null ? <span className="text-slate-300">-</span> : <span className="text-slate-700">{row.annualRate.toFixed(3)}%</span>,
    },
    {
      key: "principal",
      label: t("repoShell.colPrincipal"),
      width: 128,
      minWidth: 96,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => String(row.principal),
      filterNumber: (row) => row.principal,
      sortValue: (row) => row.principal,
      render: (row) => <span className="text-slate-800">{formatCurrencyMoney(row.principal, currency)}</span>,
    },
    {
      key: "expectedInterest",
      label: t("repoShell.colExpectedInterest"),
      width: 120,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => (row.expectedInterest == null ? null : String(row.expectedInterest)),
      filterNumber: (row) => row.expectedInterest,
      sortValue: (row) => row.expectedInterest,
      render: (row) =>
        row.expectedInterest == null ? (
          <span className="text-slate-300">-</span>
        ) : (
          <span className="text-slate-600">{formatMoney(row.expectedInterest)}</span>
        ),
    },
    {
      key: "fee",
      label: t("repoShell.colFee"),
      width: 96,
      minWidth: 80,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => (row.fee == null ? null : String(row.fee)),
      filterNumber: (row) => row.fee,
      sortValue: (row) => row.fee,
      render: (row) => (row.fee == null ? <span className="text-slate-300">-</span> : <span className="text-slate-500">{formatMoney(row.fee)}</span>),
    },
    {
      key: "actualInterest",
      label: t("repoShell.colActualInterest"),
      width: 120,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => (row.actualInterest == null ? null : String(row.actualInterest)),
      filterNumber: (row) => row.actualInterest,
      sortValue: (row) => row.actualInterest,
      render: (row) =>
        row.actualInterest == null ? (
          <span className="text-slate-300">-</span>
        ) : (
          <span className="text-slate-600">{formatMoney(row.actualInterest)}</span>
        ),
    },
    {
      key: "realizedProfit",
      label: t("repoShell.colRealizedProfit"),
      width: 120,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (row) => String(row.realizedProfit),
      filterNumber: (row) => row.realizedProfit,
      sortValue: (row) => row.realizedProfit,
      render: (row) => (
        <span className={`tabular-nums ${row.realizedProfit > 0 ? "text-emerald-600" : row.realizedProfit < 0 ? "text-rose-600" : "text-slate-500"}`}>
          {formatMoney(row.realizedProfit)}
        </span>
      ),
    },
  ], [currency, t]);

  const summaryRow = useMemo(() => {
    if (rows.length === 0) return undefined;
    const openRows = rows.filter((row) => row.status === "open");
    const principal = openRows.reduce((sum, row) => sum + row.principal, 0);
    const expected = openRows.reduce((sum, row) => sum + (row.expectedInterest ?? 0), 0);
    const realized = rows.reduce((sum, row) => sum + row.realizedProfit, 0);
    return {
      cells: {
        product: t("liabilityShell.summaryRow"),
        status: (
          <span className="tabular-nums text-slate-800">
            {t("stockPanel.repoCountSummary", { open: openRows.length, total: rows.length })}
          </span>
        ),
        principal: <span className="tabular-nums text-slate-800">{formatCurrencyMoney(principal, currency)}</span>,
        expectedInterest: <span className="tabular-nums text-slate-600">{formatMoney(expected)}</span>,
        realizedProfit: (
          <span className={`tabular-nums ${realized > 0 ? "text-emerald-600" : realized < 0 ? "text-rose-600" : "text-slate-500"}`}>
            {formatMoney(realized)}
          </span>
        ),
      },
    };
  }, [currency, rows, t]);

  return (
    <AdvancedDataTable
      storageKey="mmh_stock_shell_repo_lots_advanced_v1"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      emptyText={t("stockPanel.repoEmpty")}
      minTableWidth={minTableWidth}
      showFilters={false}
      fillHeight
      toolbarMode="none"
      draggableRows={false}
      summaryRow={summaryRow}
      summaryRowPlacement="footer"
    />
  );
}
