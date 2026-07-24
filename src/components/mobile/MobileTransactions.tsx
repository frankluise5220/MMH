"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, MoreHorizontal, Pencil, ReceiptText, Trash2, TrendingUp } from "lucide-react";
import { formatMoneyYuan } from "@/lib/format";

export type MobileTransactionRow = {
  id: string;
  date: string;
  amount: number;
  type: string;
  categoryName: string;
  accountName: string;
  toAccountName: string;
  note: string;
  flowAmount?: number;
};

type Filter = "all" | "expense" | "income" | "transfer" | "investment";

type AccountSummary = {
  title: string;
  subtitle: string;
  balance: number;
  balanceLabel: string;
  backHref?: string;
};

export function MobileTransactions({ entries, accountSummary }: { entries: MobileTransactionRow[]; accountSummary?: AccountSummary }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (filter !== "all" && entry.type !== filter) return false;
      if (!needle) return true;
      return [entry.categoryName, entry.accountName, entry.toAccountName, entry.note].some((value) => value.toLowerCase().includes(needle));
    });
  }, [entries, filter, query]);

  const grouped = useMemo(() => {
    const result = new Map<string, MobileTransactionRow[]>();
    for (const entry of filteredEntries) {
      const current = result.get(entry.date) ?? [];
      current.push(entry);
      result.set(entry.date, current);
    }
    return Array.from(result.entries());
  }, [filteredEntries]);

  async function deleteEntry(id: string) {
    if (!window.confirm("确认删除这条流水吗？")) return;
    const response = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      window.alert(result?.error ?? "删除失败");
      return;
    }
    window.location.reload();
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      {accountSummary ? (
        <section className="bg-white px-3 pb-3 pt-2">
          <div className="flex h-9 items-center gap-1">
            {accountSummary.backHref ? (
              <Link href={accountSummary.backHref} className="flex h-9 w-9 items-center justify-center text-slate-500" aria-label="返回账户">
                <ArrowLeft size={19} />
              </Link>
            ) : null}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-900">{accountSummary.title}</div>
              <div className="truncate text-[11px] text-slate-500">{accountSummary.subtitle}</div>
            </div>
          </div>
          <div className="mt-2 rounded-lg bg-indigo-600 px-4 py-3 text-white shadow-sm">
            <div className="text-xs text-indigo-100">{accountSummary.balanceLabel}</div>
            <div className="mt-1 break-all text-2xl font-bold tabular-nums">{formatMoneyYuan(accountSummary.balance)}</div>
          </div>
        </section>
      ) : null}
      <div className="sticky top-0 z-20 border-b border-slate-200 bg-slate-50/95 px-3 pb-2 pt-2 backdrop-blur">
        <div className="relative">
          <ReceiptText className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17} />
          <input className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-indigo-400" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索分类、账户或备注" />
        </div>
        <div className="mt-2 flex gap-1 overflow-x-auto pb-0.5">
          {(["all", "expense", "income", "transfer", "investment"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={`h-9 shrink-0 rounded-full px-3 text-xs font-semibold ${filter === value ? "bg-indigo-600 text-white" : "bg-white text-slate-600"}`}>
              {value === "all" ? "全部" : value === "expense" ? "支出" : value === "income" ? "收入" : value === "transfer" ? "转账" : "投资"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 py-2 pb-6">
        <div className="flex min-h-9 items-center justify-between px-1">
          <h1 className="text-sm font-semibold text-slate-900">最近流水</h1>
          <span className="text-xs tabular-nums text-slate-500">{filteredEntries.length} 笔</span>
        </div>
        {grouped.map(([date, rows]) => (
          <section key={date} className="mb-3">
            <div className="flex items-center justify-between px-1 py-1.5">
              <span className="text-xs font-semibold text-slate-600">{formatDateLabel(date)}</span>
              <span className="text-[11px] text-slate-400">{rows.length} 笔</span>
            </div>
            <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              {rows.map((entry) => (
                <article key={entry.id} className="relative flex min-h-[72px] items-center gap-3 px-3 py-2.5">
                  <TransactionIcon type={entry.type} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-slate-900">{entry.categoryName || typeLabel(entry.type)}</span>
                      {entry.type === "transfer" ? <ArrowLeftRight size={13} className="shrink-0 text-blue-500" /> : null}
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-500">
                      {entry.type === "transfer" ? `${entry.accountName} -> ${entry.toAccountName}` : entry.accountName}
                      {entry.note ? ` · ${entry.note}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={`text-sm font-semibold tabular-nums ${amountClass(entry.type)}`}>{formatSignedAmount(entry)}</div>
                    <button type="button" onClick={() => setMenuId(menuId === entry.id ? null : entry.id)} className="mt-1 flex h-7 w-full items-center justify-end text-slate-400" aria-label="更多操作">
                      <MoreHorizontal size={17} />
                    </button>
                  </div>
                  {menuId === entry.id ? (
                    <div className="absolute right-2 top-12 z-10 flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                      <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent("mmh:mobile-transaction:edit", { detail: { entryId: entry.id } })); setMenuId(null); }} className="flex h-10 items-center gap-1.5 px-3 text-xs text-slate-700"><Pencil size={14} />编辑</button>
                      <button type="button" onClick={() => deleteEntry(entry.id)} className="flex h-10 items-center gap-1.5 border-l border-slate-100 px-3 text-xs text-red-600"><Trash2 size={14} />删除</button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))}
        {filteredEntries.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-12 text-center text-sm text-slate-500">没有匹配的流水</div> : null}
      </div>
    </div>
  );
}

function TransactionIcon({ type }: { type: string }) {
  const config = type === "expense"
    ? { icon: ArrowDownLeft, className: "bg-rose-50 text-rose-600" }
    : type === "income"
      ? { icon: ArrowUpRight, className: "bg-emerald-50 text-emerald-600" }
      : type === "investment"
        ? { icon: TrendingUp, className: "bg-amber-50 text-amber-700" }
        : { icon: ArrowLeftRight, className: "bg-blue-50 text-blue-600" };
  const Icon = config.icon;
  return <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${config.className}`}><Icon size={19} /></span>;
}

function formatDateLabel(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]}`;
}

function formatSignedAmount(entry: MobileTransactionRow) {
  if (entry.flowAmount != null) {
    const amount = formatMoneyYuan(Math.abs(entry.flowAmount));
    return `${entry.flowAmount >= 0 ? "+" : "-"}${amount}`;
  }
  const amount = formatMoneyYuan(Math.abs(entry.amount));
  if (entry.type === "income") return `+${amount}`;
  if (entry.type === "expense") return `-${amount}`;
  return amount;
}

function amountClass(type: string) {
  if (type === "income") return "text-emerald-600";
  if (type === "expense") return "text-rose-600";
  return "text-slate-900";
}

function typeLabel(type: string) {
  if (type === "income") return "收入";
  if (type === "expense") return "支出";
  if (type === "transfer") return "转账";
  if (type === "investment") return "投资";
  return type || "流水";
}
