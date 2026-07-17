"use client";

import { useState } from "react";
import { Plus, TrendingUp } from "lucide-react";
import { DateStepper } from "./DateStepper";

type HoldingItem = {
  fundCode: string;
  name: string;
  navDate?: string;
  nav?: number;
};

export function AddNavButton({
  accountId,
  positions = [],
  defaultFundCode,
  trigger = "text",
}: {
  accountId: string;
  positions?: HoldingItem[];
  defaultFundCode?: string;
  trigger?: "text" | "icon";
}) {
  const defaultHolding = positions.find((p) => p.fundCode === defaultFundCode) ?? (positions.length === 1 ? positions[0] : null);
  const [open, setOpen] = useState(false);
  const [fundCode, setFundCode] = useState(defaultHolding?.fundCode ?? "");
  const [date, setDate] = useState(defaultHolding?.navDate ?? new Date().toISOString().slice(0, 10));
  const [nav, setNav] = useState("");
  const [loading, setLoading] = useState(false);

  // Sort holdings by navDate ASC (oldest NAV first) so funds needing most updates appear first
  const sortedHoldings = [...positions].sort((a, b) => {
    const ad = a.navDate || "";
    const bd = b.navDate || "";
    if (ad && bd) return ad.localeCompare(bd);
    if (ad) return -1;
    if (bd) return 1;
    return a.fundCode.localeCompare(b.fundCode);
  });

  // When selecting a holding, pre-fill date to its navDate (if available)
  function selectHolding(code: string) {
    setFundCode(code);
    const h = positions.find(p => p.fundCode === code);
    if (h?.navDate) setDate(h.navDate);
  }

  function openDialog() {
    if (defaultHolding) {
      setFundCode(defaultHolding.fundCode);
      setDate(defaultHolding.navDate ?? new Date().toISOString().slice(0, 10));
    }
    setOpen(true);
  }

  async function onSubmit() {
    if (!fundCode.trim() || !nav.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/v1/fund/nav", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundCode: fundCode.trim(), date, nav: parseFloat(nav) }),
      });
      const data = await res.json();
      if (data.ok) {
        setOpen(false);
        setFundCode("");
        setNav("");
        window.dispatchEvent(new Event("mmh:fund:refresh"));
      } else {
        window.alert(data.error ?? "添加失败");
      }
    } catch { window.alert("网络错误"); }
    finally { setLoading(false); }
  }

  if (!open) {
    if (trigger === "icon") {
      return (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            openDialog();
          }}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
          title="手动添加基金净值"
        >
          <TrendingUp className="w-3.5 h-3.5" />
        </button>
      );
    }

    return (
      <button onClick={() => setOpen(true)}
        className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-1"
        title="手动添加净值">
        <Plus className="w-3.5 h-3.5" />
        添加净值
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">手动添加净值</div>
          <button onClick={() => setOpen(false)} className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">关闭</button>
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">基金代码</div>
            {sortedHoldings.length > 0 ? (
              <div className="relative max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-inner">
                {sortedHoldings.map(h => (
                  <button key={h.fundCode} type="button"
                    onClick={() => selectHolding(h.fundCode)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 border-b border-slate-50 last:border-b-0 ${fundCode === h.fundCode ? "bg-blue-50 text-blue-700" : "text-slate-700"}`}>
                    <span className="font-medium">{h.fundCode}</span>{" "}
                    <span className="text-slate-600">{h.name}</span>
                    {h.navDate && <span className="ml-1 text-slate-400 text-xs">({h.navDate})</span>}
                  </button>
                ))}
              </div>
            ) : (
              <input value={fundCode} onChange={e => setFundCode(e.target.value)} placeholder="6位代码"
                className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
            )}
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">净值日期</div>
            <DateStepper value={date} onChange={setDate}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">单位净值</div>
            <input inputMode="decimal" value={nav} onChange={e => setNav(e.target.value)} placeholder="1.2345"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
          </div>
          <div className="flex justify-end pt-1">
            <button onClick={onSubmit} disabled={loading || !fundCode.trim() || !nav.trim()}
              className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
              {loading ? "保存中…" : "添加"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
