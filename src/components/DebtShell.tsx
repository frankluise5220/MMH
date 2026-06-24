import Link from "next/link";

import { ArrowDownLeft, ArrowUpRight, HandCoins, ListTree } from "lucide-react";

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
  const selectedRow = rows.find((row) => row.key === selectedKey) ?? rows[0] ?? null;
  const net = totalReceivable - totalPayable;

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

          <div className="overflow-auto">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3 border-b border-slate-200 px-4 py-2 text-[11px] font-semibold text-slate-500">
                <div>往来方</div>
                <div className="text-right">余额</div>
              </div>
              <div className="divide-y divide-slate-100">
                {rows.length > 0 ? (
                  <>
                    {rows.map((row) => {
                      const active = row.key === (selectedRow?.key ?? "");
                      const href = `/?view=debt&debtPerson=${encodeURIComponent(row.key)}`;
                      return (
                        <Link
                          key={row.key}
                          href={href}
                          className={`grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3 px-4 py-3 transition-colors ${
                            active ? "bg-blue-50" : "hover:bg-slate-50"
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-slate-800">{row.name}</div>
                          </div>
                          <div className={`text-right text-xs font-semibold tabular-nums ${amountClass(row.net)}`}>
                            {formatMoney(row.net)}
                          </div>
                        </Link>
                      );
                    })}
                    <div className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
                      <div className="min-w-0 pl-4 text-xs font-medium tracking-[0.08em] text-slate-500">汇总</div>
                      <div className={`text-right text-sm font-semibold tabular-nums ${amountClass(net)}`}>
                        {formatMoney(net)}
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">暂无债务/债权余额</div>
                )}
              </div>
            </div>
          </div>
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

          <div className="overflow-auto">
            <table className="min-w-[860px] w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th className="px-4 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">日期</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">类型</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">明细账户</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-left text-xs font-semibold text-slate-600">备注</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">变动</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">余额</th>
                  <th className="px-3 py-2 border-b border-slate-200 text-right text-xs font-semibold text-slate-600">操作</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {entries.length > 0 ? (
                  entries.map((entry) => (
                    <tr key={entry.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 border-b border-slate-100 text-xs text-slate-700 tabular-nums">{entry.date}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-700">{entry.typeLabel}</td>
                      <td className="px-3 py-2 border-b border-slate-100 text-xs text-slate-600">{entry.relatedAccountLabel}</td>
                      <td
                        className="max-w-[320px] truncate px-3 py-2 border-b border-slate-100 text-xs text-slate-600"
                        title={entry.note}
                      >
                        {entry.note || "-"}
                      </td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs font-semibold tabular-nums ${amountClass(entry.amount)}`}>
                        <span className="inline-flex items-center gap-1">
                          {entry.amount >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                          {formatMoney(entry.amount)}
                        </span>
                      </td>
                      <td className={`px-3 py-2 border-b border-slate-100 text-right text-xs font-semibold tabular-nums ${amountClass(entry.balance)}`}>
                        {formatMoney(entry.balance)}
                      </td>
                      <td className="px-3 py-2 border-b border-slate-100 text-right">
                        <EntryRowActions entryId={entry.id} edit={entry.edit} />
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="px-4 py-10 text-center text-sm text-slate-400" colSpan={7}>
                      暂无明细
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
