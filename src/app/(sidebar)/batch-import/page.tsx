"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
};

export default function BatchImportPage() {
  const router = useRouter();
  const [items, setItems] = useState<ParsedItem[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const data = sessionStorage.getItem("batchImportItems");
      return data ? JSON.parse(data) : [];
    } catch { return []; }
  });
  const [selected, setSelected] = useState<Set<number>>(new Set(items.map((_, i) => i)));
  const [drafts, setDrafts] = useState<Record<number, Partial<ParsedItem>>>({});
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  const toggleSelect = useCallback((idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => prev.size === items.length ? new Set() : new Set(items.map((_, i) => i)));
  }, [items.length]);

  const updateDraft = useCallback((idx: number, field: string, value: unknown) => {
    setDrafts((prev) => ({
      ...prev,
      [idx]: { ...prev[idx], [field]: value },
    }));
  }, []);

  const getItem = useCallback((idx: number): ParsedItem => {
    const item = items[idx];
    const draft = drafts[idx] ?? {};
    return {
      ...item,
      ...draft,
      date: draft.date ?? item.date ?? "",
      account: draft.account ?? item.account ?? "",
      amount: draft.amount ?? item.amount ?? 0,
      remark: draft.remark ?? item.remark ?? "",
      counterparty: draft.counterparty ?? item.counterparty ?? "",
    };
  }, [items, drafts]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    let success = 0;
    for (const idx of Array.from(selected)) {
      const item = getItem(idx);
      try {
        const res = await fetch("/api/v1/record/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entries: [{
              type: item.type,
              date: item.date || new Date().toISOString().slice(0, 10),
              amount: item.amount,
              account: item.account || undefined,
              remark: item.remark || undefined,
            }],
            accountName: item.account || undefined,
          }),
        });
        if (res.ok) success++;
      } catch { /* skip */ }
    }
    setImportedCount(success);
    setImporting(false);
    if (success > 0) {
      setTimeout(() => {
        sessionStorage.removeItem("batchImportItems");
        router.push("/");
      }, 1500);
    }
  }, [importing, selected, getItem, router]);

  const handleCancel = useCallback(() => {
    sessionStorage.removeItem("batchImportItems");
    router.back();
  }, [router]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <p className="text-slate-500">没有待导入的记录</p>
        <button onClick={handleCancel} className="px-4 py-2 bg-slate-200 rounded-md">返回</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-800">批量导入确认</h1>
          <span className="text-sm text-slate-500">
            已选 <span className="font-medium text-blue-600">{selected.size}</span> / {items.length} 条
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-md"
          >
            取消
          </button>
          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importing ? "导入中..." : `导入 ${selected.size} 条`}
          </button>
        </div>
      </div>

      {importedCount > 0 && (
        <div className="mx-4 mt-4 p-3 bg-green-50 border border-green-200 rounded-md text-green-700 text-sm">
          ✓ 已成功导入 {importedCount} 条记录，即将返回首页...
        </div>
      )}

      <div className="p-4">
        <div className="bg-white rounded-lg border border-slate-200 overflow-auto max-h-[60vh]">
          <table className="w-full text-sm border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="w-10 px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    checked={selected.size === items.length}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600"
                  />
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">日期</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">类型</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-slate-600">金额</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">账户</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">备注</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item, idx) => {
                const draft = drafts[idx] ?? {};
                const date = draft.date ?? item.date ?? "";
                const amount = draft.amount ?? item.amount ?? 0;
                const account = draft.account ?? item.account ?? "";
                const remark = draft.remark ?? item.remark ?? "";
                const type = draft.type ?? item.type ?? "expense";
                const isSelected = selected.has(idx);

                return (
                  <tr key={idx} className={isSelected ? "" : "opacity-50"}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(idx)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-600"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        value={date}
                        onChange={(e) => updateDraft(idx, "date", e.target.value)}
                        className="w-28 px-2 py-1 text-xs border border-slate-200 rounded-md focus:border-blue-400 focus:outline-none"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={type}
                        onChange={(e) => updateDraft(idx, "type", e.target.value)}
                        className="w-24 px-2 py-1 text-xs border border-slate-200 rounded-md focus:border-blue-400 focus:outline-none"
                      >
                        <option value="expense">支出</option>
                        <option value="income">收入</option>
                        <option value="transfer">转账</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => updateDraft(idx, "amount", parseFloat(e.target.value) || 0)}
                        className="w-24 px-2 py-1 text-xs text-right border border-slate-200 rounded-md focus:border-blue-400 focus:outline-none tabular-nums"
                        step="0.01"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={account}
                        onChange={(e) => updateDraft(idx, "account", e.target.value)}
                        placeholder="账户"
                        className="w-32 px-2 py-1 text-xs border border-slate-200 rounded-md focus:border-blue-400 focus:outline-none"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={remark}
                        onChange={(e) => updateDraft(idx, "remark", e.target.value)}
                        placeholder="备注"
                        className="w-40 px-2 py-1 text-xs border border-slate-200 rounded-md focus:border-blue-400 focus:outline-none"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}