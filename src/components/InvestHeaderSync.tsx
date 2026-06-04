"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function InvestHeaderSync() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleSync() {
    if (loading) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/v1/fund/sync-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "all" }),
      });
      const data = await res.json();

      if (data.ok) {
        setMessage(data.message ?? `已同步 ${data.synced} 支基金`);
        setTimeout(() => router.refresh(), 500);
      } else {
        setMessage(`同步失败：${data.error}`);
      }
    } catch (e) {
      setMessage(`同步失败：${e instanceof Error ? e.message : "网络错误"}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleSync}
        disabled={loading}
        className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? "同步中..." : "同步持仓"}
      </button>
      {message && (
        <span className="text-xs text-slate-500">{message}</span>
      )}
    </div>
  );
}
