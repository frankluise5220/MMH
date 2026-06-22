"use client";

import { useState } from "react";
import { Wand2, Loader2 } from "lucide-react";
import { formatMoney } from "@/lib/format";

type Props = { accountId: string; fundCode?: string };

export function BatchEditButton({ accountId, fundCode }: Props) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);

  async function doPreview() {
    if (!prompt.trim() || loading) return;
    setLoading(true); setError(""); setPreview(null);
    try {
      const res = await fetch("/api/v1/entries/batch-edit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, accountId: accountId || undefined, fundCode }),
      });
      const data = await res.json();
      if (data.ok) setPreview(data.preview);
      else setError(data.error);
    } catch { setError("请求失败"); }
    setLoading(false);
  }

  async function doApply() {
    if (!prompt.trim() || applying) return;
    setApplying(true);
    try {
      const res = await fetch("/api/v1/entries/batch-edit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, accountId: accountId || undefined, fundCode, apply: true }),
      });
      const data = await res.json();
      if (data.ok) {
        setOpen(false);
        window.dispatchEvent(new Event("mmh:fund:refresh"));
      }
      else setError(data.error);
    } catch { setError("执行失败"); }
    setApplying(false);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="h-8 px-2.5 rounded-md border border-purple-200 bg-purple-50 text-purple-700 text-xs hover:bg-purple-100 flex items-center gap-1.5">
        <Wand2 className="h-3.5 w-3.5" />AI 批量
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35">
          <div className="w-full max-w-lg rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">AI 批量修改</div>
              <button onClick={() => { setOpen(false); setPreview(null); setError(""); }}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">关闭</button>
            </div>
            <div className="p-4 space-y-3">
              <div className="text-xs text-slate-500 space-y-1">
                <div>输入修改指令（日期范围 + 目标修改）：</div>
                <code className="text-purple-600 bg-purple-50 px-1 rounded text-[11px]">2025年1月到3月 改成004011</code>
                <code className="text-purple-600 bg-purple-50 px-1 rounded text-[11px] ml-1">2025-01到2025-03 基金改成014982</code>
              </div>
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
                placeholder="输入修改指令…"
                className="w-full h-20 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none resize-none"
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doPreview(); } }} />
              {error && <div className="text-xs text-red-500">{error}</div>}
              {preview && (
                <div className="border border-purple-100 rounded-lg bg-purple-50/30 p-3 space-y-2">
                  <div className="text-xs text-slate-700">
                    匹配 <span className="font-semibold text-purple-700">{preview.count}</span> 条记录
                    {preview.changes?.fundCode && <span className="ml-1">→ 改为基金 <span className="font-semibold text-purple-700">{preview.changes.fundCode}</span></span>}
                  </div>
                  {preview.samples.length > 0 && (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {preview.samples.map((s: any) => (
                        <div key={s.id} className="text-xs text-slate-600 flex items-center gap-2">
                          <span className="tabular-nums w-20 shrink-0">{s.date}</span>
                          <span className="tabular-nums w-16 text-right shrink-0">{formatMoney(Math.abs(s.amount))}</span>
                          <span className="text-slate-400 shrink-0 w-16">{s.fundCode || "-"}</span>
                          <span className="text-slate-400 truncate">{s.note || ""}</span>
                        </div>
                      ))}
                      {preview.count > 10 && <div className="text-[10px] text-slate-400">… 还有 {preview.count - 10} 条</div>}
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={doPreview} disabled={loading || !prompt.trim()}
                  className="h-9 px-4 rounded-md border border-purple-200 bg-purple-50 text-purple-700 text-sm hover:bg-purple-100 disabled:opacity-50 flex items-center gap-1">
                  {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}预览
                </button>
                {preview && preview.count > 0 && (
                  <button type="button" onClick={doApply} disabled={applying}
                    className="h-9 px-4 rounded-md bg-purple-600 text-white text-sm hover:bg-purple-700 disabled:opacity-50">
                    {applying ? "执行中…" : `确认修改 ${preview.count} 条`}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
