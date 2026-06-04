"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";

export function FixLinkageButton({ accountId }: { accountId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function fix() {
    if (loading) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/v1/fund/fix-linkage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult(data.message);
      } else {
        setResult(data.error ?? "修复失败");
      }
    } catch (e) {
      setResult(e instanceof Error ? e.message : "修复失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={fix}
        disabled={loading}
        title="修复资金联动：扫描已有基金记录，将有资金账户但无联动流水的记录补建转账"
        className="flex items-center gap-1 h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-500 hover:text-blue-600 hover:border-blue-200 disabled:opacity-50"
      >
        <Link2 className="w-3 h-3" />
        {loading ? "修复中…" : "修复联动"}
      </button>
      {result && (
        <span className="text-[10px] text-slate-500 max-w-[160px] truncate">{result}</span>
      )}
    </div>
  );
}
