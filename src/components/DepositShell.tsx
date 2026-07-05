"use client";

import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Landmark } from "lucide-react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "./AdvancedDataTable";
import { EntryRowActions } from "./EntryRowActions";
import { formatMoney } from "@/lib/format";

type DepositEntry = {
  id: string;
  date: string;
  typeLabel: string;
  fundName: string;
  maturityDate?: string | null;
  cashAccountLabel: string;
  note: string;
  amount: number;
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

function amountClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function stopRowClick(event: React.MouseEvent) {
  event.stopPropagation();
}

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
    if (!window.confirm(`确认删除选中的 ${selectedEntryIds.size} 条明细吗？`)) return;
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

  const lotColumns = useMemo<AdvancedDataTableColumn<DepositLot>[]>(() => [
    {
      key: "product",
      label: "产品",
      width: 260,
      minWidth: 160,
      filterText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.fundName}>{lot.fundName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">定期存款</span>
        </div>
      ),
    },
    { key: "startDate", label: "存入日期", width: 110, minWidth: 84, hideable: true, filterText: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: "到期日", width: 110, minWidth: 84, hideable: true, filterText: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "originalAmount", label: "存入金额", width: 120, minWidth: 86, align: "right", hideable: true, render: (lot) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(lot.originalAmount)}</span> },
    { key: "remainingAmount", label: "剩余余额", width: 120, minWidth: 86, align: "right", render: (lot) => <span className={`font-semibold tabular-nums ${amountClass(lot.remainingAmount)}`}>{formatMoney(lot.remainingAmount)}</span> },
    { key: "annualRate", label: "年化利率", width: 100, minWidth: 72, align: "right", hideable: true, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
    { key: "status", label: "状态", width: 90, minWidth: 70, hideable: true, filterText: (lot) => lot.status === "open" ? "持有中" : "已取回", render: (lot) => lot.status === "open" ? "持有中" : "已取回" },
  ], []);

  const entryColumns = useMemo<AdvancedDataTableColumn<DepositEntry>[]>(() => [
    { key: "date", label: "日期", width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "action", label: "动作", width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "product", label: "产品", width: 190, minWidth: 120, filterText: (entry) => entry.fundName, render: (entry) => <span className="truncate text-slate-700" title={entry.fundName}>{entry.fundName || "-"}</span> },
    { key: "maturityDate", label: "到期日", width: 110, minWidth: 84, hideable: true, filterText: (entry) => entry.maturityDate ?? "", render: (entry) => <span className="tabular-nums text-slate-600">{entry.maturityDate || "-"}</span> },
    { key: "cashAccount", label: "资金账户", width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, render: (entry) => <span className="truncate text-slate-600" title={entry.cashAccountLabel}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: "备注", width: 240, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: "金额",
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
    <div className="min-h-0 flex-1 overflow-auto bg-transparent p-4 md:p-5">
      <div className="space-y-4">
        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-600" />
              存款持仓
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot ? `已选中 ${selectedLot.fundName}，下方仅显示这笔存单相关记录` : `${institutionName || accountLabel} 下的全部存款持仓`}
            </div>
          </div>
          <AdvancedDataTable
            storageKey="mmh_deposit_lots_table_v1"
            columns={lotColumns}
            rows={lots}
            rowKey={(lot) => lot.id}
            minTableWidth={920}
            emptyText="暂无存款持仓"
            showFilters={false}
            onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
            rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
          />
        </section>

        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-blue-500" />
              存款明细
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot ? `当前显示 ${visibleEntries.length} 条关联记录` : "请先选择上方存款持仓"}
            </div>
          </div>
          <AdvancedDataTable
            storageKey="mmh_deposit_entries_table_v1"
            columns={entryColumns}
            rows={visibleEntries}
            rowKey={(entry) => entry.id}
            minTableWidth={980}
            emptyText={selectedLot ? "这笔存单暂时没有关联明细" : "请先选择上方存款持仓"}
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
