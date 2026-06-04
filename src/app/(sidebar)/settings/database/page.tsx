"use client";

import { useState, useEffect } from "react";

export default function DatabaseSettingsPage() {
  const [status, setStatus] = useState<"checking" | "running" | "stopped">("checking");
  const [loading, setLoading] = useState(false);
  const port = 49152;

  useEffect(() => {
    checkStatus();
  }, []);

  async function checkStatus() {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      setStatus(res.ok ? "running" : "stopped");
    } catch {
      setStatus("stopped");
    }
  }

  async function start() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/settings/prisma-studio", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setStatus("running");
      } else {
        alert(data.error || "启动失败");
      }
    } catch {
      alert("启动失败");
    } finally {
      setLoading(false);
    }
  }

  async function stop() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/settings/prisma-studio", { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setStatus("stopped");
      } else {
        alert(data.error || "停止失败");
      }
    } catch {
      alert("停止失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">数据库管理</h2>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">Prisma Studio</div>
            <div className="text-xs text-slate-500 mt-0.5">
              端口 {port}
              {status === "running" && (
                <>
                  {" "}| <a href={`http://127.0.0.1:${port}/`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">打开</a>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded ${
              status === "running" ? "bg-emerald-50 text-emerald-700" :
              status === "stopped" ? "bg-slate-100 text-slate-500" :
              "bg-amber-50 text-amber-600"
            }`}>
              {status === "running" ? "运行中" : status === "stopped" ? "已停止" : "检测中..."}
            </span>
            {status === "running" ? (
              <button onClick={stop} disabled={loading}
                className="h-8 px-3 rounded-md border border-red-200 bg-white text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">
                停止
              </button>
            ) : status === "stopped" ? (
              <button onClick={start} disabled={loading}
                className="h-8 px-3 rounded-md border border-blue-200 bg-white text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                启动
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}