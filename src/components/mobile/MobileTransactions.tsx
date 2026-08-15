"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, MoreHorizontal, Pencil, ReceiptText, Trash2, TrendingUp } from "lucide-react";
import { formatMoneyYuan } from "@/lib/format";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

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
  const [visibleEntries, setVisibleEntries] = useState(entries);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);
  const dragRef = useRef<{ id: string; startX: number; startY: number; active: boolean } | null>(null);

  useEffect(() => {
    setVisibleEntries(entries);
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleEntries.filter((entry) => {
      if (filter !== "all" && entry.type !== filter) return false;
      if (!needle) return true;
      return [entry.categoryName, entry.accountName, entry.toAccountName, entry.note].some((value) => (value ?? "").toLowerCase().includes(needle));
    });
  }, [visibleEntries, filter, query]);

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
    const confirmed = await showConfirmDialog({ title: "删除流水", message: "确认删除这条流水吗？", tone: "danger" });
    if (!confirmed) return;
    const response = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      window.alert(result?.error ?? "删除失败");
      return;
    }
    setVisibleEntries((current) => current.filter((entry) => entry.id !== id));
    if (expandedId === id) setExpandedId(null);
    if (menuId === id) setMenuId(null);
    if (swipedId === id) setSwipedId(null);
    dispatchFinanceDataChanged({ reason: "mobile-entry-delete", deletedEntryIds: [id], entryIds: [id] });
  }

  function beginCardPointer(entryId: string, event: PointerEvent<HTMLElement>) {
    if (isActionTarget(event.target)) return;
    dragRef.current = { id: entryId, startX: event.clientX, startY: event.clientY, active: false };
    setDragId(entryId);
    setDragX(0);
    setMenuId(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCardPointer(entryId: string, event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== entryId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.active && Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY)) drag.active = true;
    if (!drag.active) return;
    event.preventDefault();
    setDragX(Math.min(24, Math.max(-92, deltaX)));
  }

  function endCardPointer(entry: MobileTransactionRow, event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== entry.id) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    dragRef.current = null;
    setDragId(null);
    setDragX(0);

    if (drag.active) {
      if (deltaX < -44) setSwipedId(entry.id);
      else if (deltaX > 28) setSwipedId(null);
      return;
    }

    if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) {
      if (swipedId === entry.id) {
        setSwipedId(null);
      } else {
        setExpandedId((current) => (current === entry.id ? null : entry.id));
      }
    }
  }

  function cancelCardPointer() {
    dragRef.current = null;
    setDragId(null);
    setDragX(0);
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
              {rows.map((entry) => {
                const isExpanded = expandedId === entry.id;
                const translateX = dragId === entry.id
                  ? Math.min(0, dragX)
                  : swipedId === entry.id
                    ? -76
                    : 0;
                return (
                <div key={entry.id} className="relative overflow-hidden bg-white">
                  <button
                    type="button"
                    onClick={() => deleteEntry(entry.id)}
                    className="absolute inset-y-0 right-0 flex w-[76px] items-center justify-center bg-red-500 text-white"
                    aria-label="删除流水"
                  >
                    <Trash2 size={19} />
                  </button>
                  <article
                    className="relative min-h-[72px] bg-white px-3 py-2.5 transition-transform"
                    style={{ transform: `translateX(${translateX}px)`, touchAction: "pan-y" }}
                    onPointerDown={(event) => beginCardPointer(entry.id, event)}
                    onPointerMove={(event) => moveCardPointer(entry.id, event)}
                    onPointerUp={(event) => endCardPointer(entry, event)}
                    onPointerCancel={cancelCardPointer}
                  >
                    <div className="flex items-center gap-3">
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
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuId(menuId === entry.id ? null : entry.id);
                            setSwipedId(null);
                          }}
                          className="mt-1 flex h-7 w-full items-center justify-end text-slate-400"
                          aria-label="更多操作"
                          data-row-action="true"
                        >
                          <MoreHorizontal size={17} />
                        </button>
                      </div>
                    </div>
                    {isExpanded ? (
                      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        <DetailLine label="日期" value={entry.date} />
                        <DetailLine label="类型" value={typeLabel(entry.type)} />
                        <DetailLine label={entry.type === "transfer" ? "转出账户" : "账户"} value={entry.accountName || "未记录"} />
                        {entry.type === "transfer" ? <DetailLine label="转入账户" value={entry.toAccountName || "未记录"} /> : null}
                        <DetailLine label="分类" value={entry.categoryName || "未分类"} />
                        {entry.note ? <DetailLine label="备注" value={entry.note} /> : null}
                      </div>
                    ) : null}
                    {menuId === entry.id ? (
                      <div className="absolute right-2 top-12 z-10 flex overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg" data-row-action="true">
                        <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent("mmh:mobile-transaction:edit", { detail: { entryId: entry.id } })); setMenuId(null); setSwipedId(null); }} className="flex h-10 items-center gap-1.5 px-3 text-xs text-slate-700"><Pencil size={14} />编辑</button>
                        <button type="button" onClick={() => deleteEntry(entry.id)} className="flex h-10 items-center gap-1.5 border-l border-slate-100 px-3 text-xs text-red-600"><Trash2 size={14} />删除</button>
                      </div>
                    ) : null}
                  </article>
                </div>
                );
              })}
            </div>
          </section>
        ))}
        {filteredEntries.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-12 text-center text-sm text-slate-500">没有匹配的流水</div> : null}
      </div>
    </div>
  );
}

function isActionTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest("button,a,input,select,textarea,[data-row-action]");
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 py-1">
      <span className="text-slate-400">{label}</span>
      <span className="min-w-0 break-words text-slate-700">{value}</span>
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
