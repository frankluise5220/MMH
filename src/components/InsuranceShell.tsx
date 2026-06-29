"use client";

import { useMemo, useState } from "react";
import { Shield, ArrowDownLeft, ArrowUpRight } from "lucide-react";

import { formatMoney } from "@/lib/format";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "./AdvancedDataTable";
import { EntryRowActions } from "./EntryRowActions";

type InsuranceEntry = {
  id: string;
  date: string;
  typeLabel: string;
  productName: string;
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
    insuranceProductId?: string | null;
    fundName?: string;
    fundProductType?: string;
    fundSubtype?: string;
    source?: string | null;
  };
};

type InsuranceHolding = {
  id: string;
  label: string;
  startDate?: string | null;
  insuredUserName?: string;
  displayTypeLabel?: string;
  cashValueLabel?: string;
  cashValue?: number | null;
  coverageAmount?: number | null;
  totalPremium?: number | null;
  status?: string | null;
  statusLabel?: string;
  frequencyLabel?: string;
  paymentTermYears?: number | null;
  coverageTermYears?: number | null;
  relatedEntryIds: string[];
};

function amountClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function stopRowClick(event: React.MouseEvent) {
  event.stopPropagation();
}

export function InsuranceShell({
  accountLabel,
  institutionName,
  holdings,
  entries,
}: {
  accountLabel: string;
  institutionName?: string;
  holdings: InsuranceHolding[];
  entries: InsuranceEntry[];
}) {
  const [selectedHoldingId, setSelectedHoldingId] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [showActiveOnly, setShowActiveOnly] = useState(false);

  const visibleHoldings = useMemo(
    () => holdings
      .filter((holding) => holding.relatedEntryIds.length > 0)
      .filter((holding) => !showActiveOnly || holding.status === "active"),
    [holdings, showActiveOnly],
  );

  const selectedHolding = useMemo(
    () => visibleHoldings.find((holding) => holding.id === selectedHoldingId) ?? null,
    [selectedHoldingId, visibleHoldings],
  );

  const visibleEntries = useMemo(() => {
    if (!selectedHolding) return entries;
    const relatedIds = new Set(selectedHolding.relatedEntryIds);
    return entries.filter((entry) => relatedIds.has(entry.id));
  }, [entries, selectedHolding]);

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    if (!window.confirm(`确认删除选中的 ${selectedEntryIds.size} 条保险记录吗？`)) return;
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

  const holdingColumns = useMemo<AdvancedDataTableColumn<InsuranceHolding>[]>(() => [
    {
      key: "name",
      label: "保险名称",
      width: 240,
      minWidth: 150,
      filterText: (holding) => holding.label,
      render: (holding) => (
        <span className="block truncate font-medium text-slate-700" title={holding.label}>
          {holding.label}
        </span>
      ),
    },
    { key: "status", label: "状态", width: 96, minWidth: 72, hideable: true, filterText: (holding) => holding.statusLabel ?? "", render: (holding) => <span className="text-slate-600">{holding.statusLabel || "-"}</span> },
    { key: "startDate", label: "开始投保", width: 110, minWidth: 84, hideable: true, filterText: (holding) => holding.startDate ?? "", render: (holding) => <span className="tabular-nums text-slate-600">{holding.startDate || "-"}</span> },
    { key: "insuredUser", label: "被保险人", width: 110, minWidth: 82, hideable: true, filterText: (holding) => holding.insuredUserName ?? "", render: (holding) => <span className="truncate text-slate-600">{holding.insuredUserName || "-"}</span> },
    { key: "frequency", label: "缴费频率", width: 100, minWidth: 78, hideable: true, filterText: (holding) => holding.frequencyLabel ?? "", render: (holding) => <span className="text-slate-600">{holding.frequencyLabel || "-"}</span> },
    { key: "paymentTerm", label: "缴费年限", width: 96, minWidth: 74, align: "right", hideable: true, render: (holding) => <span className="tabular-nums text-slate-600">{holding.paymentTermYears != null ? `${holding.paymentTermYears} 年` : "-"}</span> },
    { key: "coverageTerm", label: "保障年限", width: 96, minWidth: 74, align: "right", hideable: true, render: (holding) => <span className="tabular-nums text-slate-600">{holding.coverageTermYears != null ? `${holding.coverageTermYears} 年` : "-"}</span> },
    { key: "totalPremium", label: "保费合计", width: 120, minWidth: 88, align: "right", render: (holding) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(holding.totalPremium ?? 0)}</span> },
    {
      key: "cashValue",
      label: "现金价值/余额",
      width: 140,
      minWidth: 100,
      align: "right",
      render: (holding) => (
        <div className={`font-semibold tabular-nums ${amountClass(holding.cashValue ?? 0)}`}>
          <div>{holding.cashValue != null ? formatMoney(holding.cashValue) : "-"}</div>
          <div className="text-[10px] font-normal text-slate-400">
            {[holding.displayTypeLabel, holding.cashValueLabel || "现金价值/余额"].filter(Boolean).join(" · ")}
          </div>
        </div>
      ),
    },
    { key: "coverageAmount", label: "保额", width: 120, minWidth: 88, align: "right", hideable: true, render: (holding) => <span className="font-semibold tabular-nums text-slate-700">{holding.coverageAmount != null ? formatMoney(holding.coverageAmount) : "-"}</span> },
  ], []);

  const entryColumns = useMemo<AdvancedDataTableColumn<InsuranceEntry>[]>(() => [
    { key: "date", label: "日期", width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    {
      key: "action",
      label: "动作",
      width: 90,
      minWidth: 70,
      filterText: (entry) => entry.typeLabel,
      render: (entry) => (
        <span className="inline-flex items-center gap-1 text-slate-700">
          {entry.amount >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
          {entry.typeLabel}
        </span>
      ),
    },
    { key: "product", label: "保险名称", width: 210, minWidth: 130, filterText: (entry) => entry.productName, render: (entry) => <span className="block truncate text-slate-700" title={entry.productName}>{entry.productName || "-"}</span> },
    { key: "cashAccount", label: "资金账户", width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, render: (entry) => <span className="block truncate text-slate-600" title={entry.cashAccountLabel}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: "备注", width: 260, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    { key: "amount", label: "金额", width: 120, minWidth: 86, align: "right", render: (entry) => <span className={`font-semibold tabular-nums ${amountClass(entry.amount)}`}>{formatMoney(entry.amount)}</span> },
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
              <Shield className="h-4 w-4 text-cyan-600" />
              保险持仓
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-slate-500">
                <input
                  type="checkbox"
                  checked={showActiveOnly}
                  onChange={(event) => {
                    setShowActiveOnly(event.target.checked);
                    setSelectedHoldingId(null);
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                仅保障中
              </label>
              <span>
                {selectedHolding
                  ? `已选中 ${selectedHolding.label}，下方只显示这份保险的记录`
                  : `${institutionName || accountLabel} 下的保险持仓 ${visibleHoldings.length}/${holdings.length}`}
              </span>
            </div>
          </div>

          <AdvancedDataTable
            storageKey="mmh_insurance_holdings_table_v1"
            columns={holdingColumns}
            rows={visibleHoldings}
            rowKey={(holding) => holding.id}
            minTableWidth={1240}
            emptyText="暂无保险持仓"
            showFilters={false}
            onRowClick={(holding) => setSelectedHoldingId((current) => (current === holding.id ? null : holding.id))}
            rowClassName={(holding) => `cursor-pointer ${selectedHoldingId === holding.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
          />
        </section>

        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Shield className="h-4 w-4 text-blue-500" />
              保险记录
            </div>
            <div className="text-xs text-slate-400">
              {selectedHolding ? `当前显示 ${visibleEntries.length} 条关联记录` : `显示全部记录，共 ${entries.length} 条`}
            </div>
          </div>

          <AdvancedDataTable
            storageKey="mmh_insurance_entries_table_v1"
            columns={entryColumns}
            rows={visibleEntries}
            rowKey={(entry) => entry.id}
            minTableWidth={920}
            emptyText={selectedHolding ? "这份保险暂时没有关联记录" : "暂无保险记录"}
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
