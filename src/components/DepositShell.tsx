"use client";

import { useMemo, useState } from "react";
import { Landmark, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { EntryRowActions } from "./EntryRowActions";

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

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId],
  );

  const visibleEntries = useMemo(() => {
    if (!selectedLot) return entries;
    const relatedIds = new Set(selectedLot.relatedEntryIds ?? [selectedLot.id]);
    return entries.filter((entry) => relatedIds.has(entry.id));
  }, [entries, selectedLot]);

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-transparent p-4 md:p-5">
      <div className="space-y-4">
        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-600" />
              持仓
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot
                ? `已选中 ${selectedLot.fundName}，下方仅显示这笔存单相关记录`
                : `${institutionName || accountLabel} 下的全部存款持仓`}
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-[920px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="px-4 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">产品</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">存入日期</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">到期日</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">存入金额</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">剩余余额</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">年化利率</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">状态</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {lots.length > 0 ? (
                  lots.map((lot) => (
                    <tr
                      key={lot.id}
                      className={`cursor-pointer hover:bg-slate-50 ${selectedLotId === lot.id ? "bg-blue-50/70" : ""}`}
                      onClick={() => setSelectedLotId((current) => (current === lot.id ? null : lot.id))}
                    >
                      <td className="px-4 py-2 border-b border-slate-100 text-xs text-slate-700">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-slate-700">{lot.fundName}</span>
                          <span className="shrink-0 text-[11px] text-slate-400">定期存款</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600 tabular-nums">{lot.startDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600 tabular-nums">{lot.maturityDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs font-semibold tabular-nums text-slate-700">
                        {formatMoney(lot.originalAmount)}
                      </td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs font-semibold tabular-nums ${amountClass(lot.remainingAmount)}`}>
                        {formatMoney(lot.remainingAmount)}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right text-xs text-slate-600 tabular-nums">
                        {lot.annualRate != null ? `${lot.annualRate}%` : "-"}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">
                        {lot.status === "open" ? "持有中" : "已取回"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm text-slate-400" colSpan={7}>
                      暂无持仓
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-blue-500" />
              明细
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot
                ? `当前显示 ${visibleEntries.length} 条关联记录`
                : `显示全部存入与取出记录，共 ${entries.length} 条`}
            </div>
          </div>

          <div className="overflow-auto">
            <table className="min-w-[980px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="px-4 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">日期</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">动作</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">产品</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">到期日</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">资金账户</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">备注</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">金额</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">操作</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {visibleEntries.length > 0 ? (
                  visibleEntries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 border-b border-slate-100 text-xs text-slate-700 tabular-nums">{entry.date}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">{entry.typeLabel}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">{entry.fundName || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600 tabular-nums">{entry.maturityDate || "-"}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">{entry.cashAccountLabel || "-"}</td>
                      <td className="max-w-[320px] truncate px-3 py-2 border-b border-slate-100 text-xs text-slate-600" title={entry.note}>
                        {entry.note || "-"}
                      </td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs font-semibold tabular-nums ${amountClass(entry.amount)}`}>
                        <span className="inline-flex items-center gap-1">
                          {entry.amount >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                          {formatMoney(entry.amount)}
                        </span>
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right">
                        <EntryRowActions entryId={entry.id} edit={entry.edit} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-10 text-center text-sm text-slate-400" colSpan={8}>
                      {selectedLot ? "这笔存单暂时没有关联明细" : "暂无明细"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
