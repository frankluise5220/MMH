"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, DatabaseZap } from "lucide-react";

import type { InvestmentProfitMissingNav } from "@/lib/server/investment-profit-report";

function compactDateRange(items: InvestmentProfitMissingNav[]) {
  const dates = items.map((item) => item.date).sort();
  if (dates.length === 0) return "";
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  return first === last ? first : `${first} 至 ${last}`;
}

function uniqueMissingNavs(items: InvestmentProfitMissingNav[]) {
  const byKey = new Map<string, InvestmentProfitMissingNav>();
  for (const item of items) {
    const fundCode = item.fundCode.trim();
    if (!fundCode || !item.date) continue;
    const key = `${fundCode}|${item.date}`;
    if (!byKey.has(key)) byKey.set(key, { ...item, fundCode });
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.fundCode.localeCompare(b.fundCode, "zh-Hans-CN"),
  );
}

function navKey(item: Pick<InvestmentProfitMissingNav, "fundCode" | "date">) {
  return `${item.fundCode.trim()}|${item.date}`;
}

export function MissingFundNavPrompt({
  items,
  className = "",
}: {
  items: InvestmentProfitMissingNav[];
  className?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const incoming = useMemo(() => {
    const values = uniqueMissingNavs(items);
    return { signature: values.map(navKey).join(","), values };
  }, [items]);
  const [missingItems, setMissingItems] = useState(incoming.values);
  const lastAppliedSignatureRef = useRef(incoming.signature);
  const fundCount = useMemo(() => new Set(missingItems.map((item) => item.fundCode)).size, [missingItems]);
  const rangeLabel = compactDateRange(missingItems);

  useEffect(() => {
    if (lastAppliedSignatureRef.current === incoming.signature) return;
    lastAppliedSignatureRef.current = incoming.signature;
    setMissingItems(incoming.values);
    setMessage("");
  }, [incoming.signature, incoming.values]);

  if (missingItems.length === 0) return null;

  async function refreshMissingNavs() {
    const ok = window.confirm(`发现 ${fundCount} 只基金共 ${missingItems.length} 个净值日期缺失，是否现在获取？`);
    if (!ok) return;
    setMessage("");
    startTransition(async () => {
      try {
        const res = await fetch("/api/v1/fund/nav/missing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: missingItems.map((item) => ({ fundCode: item.fundCode, date: item.date })),
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          window.alert(data.error ?? "获取缺失净值失败");
          return;
        }
        const unresolvedItems = Array.isArray(data.unresolvedItems)
          ? uniqueMissingNavs(data.unresolvedItems)
          : [];
        const resolvedItems = Array.isArray(data.resolvedItems)
          ? uniqueMissingNavs(data.resolvedItems)
          : [];

        setMissingItems([]);
        if (unresolvedItems.length > 0 && resolvedItems.length === 0 && (data.written ?? 0) === 0) {
          window.alert(`本次没有获取到公开净值；${unresolvedItems.length} 个日期可能尚未披露或不是该基金交易日。`);
        }
        window.dispatchEvent(new CustomEvent("mmh:fund:nav-cache-updated", { detail: data }));
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "获取缺失净值失败");
      }
    });
  }

  return (
    <div
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs text-amber-900 ${className}`}
      title={`持仓基金有 ${missingItems.length} 个净值日期缺失，范围 ${rangeLabel}，${fundCount} 只基金。当前市值收益可能沿用了上一可用净值。${message ? ` ${message}` : ""}`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="font-medium tabular-nums">缺净值 {missingItems.length}</span>
      <span className="hidden max-w-48 truncate text-amber-700 xl:inline">
        {fundCount}只 · {rangeLabel}
      </span>
      <button
        type="button"
        onClick={refreshMissingNavs}
        disabled={isPending}
        className="ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-white px-2 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
      >
        <DatabaseZap className={`h-3 w-3 ${isPending ? "animate-pulse" : ""}`} />
        {isPending ? "获取中" : "获取"}
      </button>
    </div>
  );
}
