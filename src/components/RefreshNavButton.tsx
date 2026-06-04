"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function RefreshNavButton({
  accountId,
  symbols,
}: {
  accountId: string;
  symbols: string[];
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function refresh() {
    if (loading || symbols.length === 0) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/v1/fund/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, symbols }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult(data.message);
      } else {
        setResult(data.error ?? "刷新失败");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      router.refresh();
    } catch (e) {
      setResult(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result && <span className="text-xs text-slate-500">{result}</span>}
      <button
        type="button"
        onClick={refresh}
        disabled={loading || symbols.length === 0}
        className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-1 disabled:opacity-50"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? "获取中…" : "获取净值"}
      </button>
    </div>
  );
}
