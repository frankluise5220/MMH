"use client";

import { ArrowDownLeft, ArrowUpRight, HandCoins, ListTree } from "lucide-react";
import { useMemo, useState } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "./AdvancedDataTable";
import { EntryRowActions } from "./EntryRowActions";
import { formatMoney } from "@/lib/format";

type DebtRow = {
  key: string;
  name: string;
  payable: number;
  receivable: number;
  net: number;
  accountCount: number;
};

type DebtEntry = {
  id: string;
  date: string;
  typeLabel: string;
  relatedAccountLabel: string;
  note: string;
  amount: number;
  balance: number;
  edit?: {
    type: "expense" | "income" | "transfer" | "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    categoryId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  };
};

function amountClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function stopRowClick(event: React.MouseEvent) {
  event.stopPropagation();
}

export function DebtShell({
  rows,
  selectedKey,
  entries,
  totalPayable,
  totalReceivable,
}: {
  rows: DebtRow[];
  selectedKey: string;
  entries: DebtEntry[];
  totalPayable: number;
  totalReceivable: number;
}) {
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const selectedRow = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;
  const net = totalReceivable - totalPayable;

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${selectedEntryIds.size} 条往来明细吗？`)) return;
    const response = await fetch("/api/v1/entries/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: Array.from(selectedEntryIds) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      window.alert(data?.error || "批量删除失败");
      return;
    }
    setSelectedEntryIds(new Set());
    window.dispatchEvent(new Event("mmh:fund:refresh"));
  }

  const rowColumns = useMemo<AdvancedDataTableColumn<DebtRow>[]>(() => [
    {
      key: "name",
      label: "往来方",
      width: 360,
      minWidth: 160,
      filterText: (row) => row.name,
      render: (row) => (
        <span className="block truncate text-sm font-semibold text-slate-800" title={row.name}>
          {row.name}
        </span>
      ),
    },
    {
      key: "net",
      label: "余额",
      width: 140,
      minWidth: 96,
      align: "right",
      render: (row) => <span className={`text-xs font-semibold tabular-nums ${amountClass(row.net)}`}>{formatMoney(row.net)}</span>,
    },
  ], []);

  const entryColumns = useMemo<AdvancedDataTableColumn<DebtEntry>[]>(() => [
    { key: "date", label: "日期", width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "type", label: "类型", width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "relatedAccount", label: "明细账户", width: 160, minWidth: 100, filterText: (entry) => entry.relatedAccountLabel, render: (entry) => <span className="block truncate text-slate-600" title={entry.relatedAccountLabel}>{entry.relatedAccountLabel || "-"}</span> },
    { key: "note", label: "备注", width: 260, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: "变动",
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
    { key: "balance", label: "余额", width: 120, minWidth: 86, align: "right", render: (entry) => <span className={`font-semibold tabular-nums ${amountClass(entry.balance)}`}>{formatMoney(entry.balance)}</span> },
    {
      key: "actions",
      label: "操作",
      width: 92,
      minWidth: 76,
      align: "right",
      render: (entry) => (
        <div onClick={stopRowClick}>
          <EntryRowActions entryId={entry.id} edit={entry.edit} />
        </div>
      ),
    },
  ], []);

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-transparent p-4 md:p-5">
      <div className="space-y-4">
        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <HandCoins className="h-4 w-4 text-amber-500" />
              往来款账户
            </div>
            <div className="text-xs text-slate-400">正数表示借出余额，负数表示借入余额</div>
          </div>

          <AdvancedDataTable
            storageKey="mmh_debt_rows_table_v1"
            columns={rowColumns}
            rows={rows}
            rowKey={(row) => row.key}
            minTableWidth={520}
            emptyText="暂无往来款余额"
            showFilters={false}
            onRowClick={(row) => {
              window.location.href = `/?view=debt&debtPerson=${encodeURIComponent(row.key)}`;
            }}
            rowClassName={(row) => `cursor-pointer ${row.key === (selectedRow?.key ?? "") ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
          />
          {rows.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)_140px] items-center gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
              <div className="min-w-0 pl-4 text-xs font-medium tracking-[0.08em] text-slate-500">汇总</div>
              <div className={`text-right text-sm font-semibold tabular-nums ${amountClass(net)}`}>
                {formatMoney(net)}
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex min-w-0 items-start gap-2">
              <ListTree className="mt-0.5 h-4 w-4 text-cyan-500" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">
                  {selectedRow?.name ?? "未选择对象"} 明细
                </div>
              </div>
            </div>
          </div>

          <AdvancedDataTable
            storageKey="mmh_debt_entries_table_v1"
            columns={entryColumns}
            rows={entries}
            rowKey={(entry) => entry.id}
            minTableWidth={860}
            emptyText="暂无明细"
            selectable
            selectedKeys={selectedEntryIds}
            onSelectionChange={setSelectedEntryIds}
            batchActions={[
              { label: "批量删除", onClick: batchDeleteEntries },
              { label: "批量修改", onClick: () => window.alert("批量修改入口已接入，下一步会复用统一批量修改弹窗。") },
            ]}
          />
        </section>
      </div>
    </div>
  );
}
