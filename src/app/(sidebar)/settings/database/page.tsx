"use client";

import { useState, useEffect } from "react";

const DEFAULT_ORIGINS_LABEL = "默认白名单（不可编辑）：局域网 IP + localhost";

export default function DatabaseSettingsPage() {
  const [status, setStatus] = useState<"checking" | "running" | "stopped">("checking");
  const [loading, setLoading] = useState(false);
  const port = 49152;
  const [origins, setOrigins] = useState<string[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");

  useEffect(() => {
    checkStatus();
    loadOrigins();
  }, []);

  async function checkStatus() {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      setStatus(res.ok ? "running" : "stopped");
    } catch {
      setStatus("stopped");
    }
  }

  async function loadOrigins() {
    setOriginsLoading(true);
    try {
      const res = await fetch("/api/v1/settings/system?key=allowed_dev_origins");
      const data = await res.json();
      if (data.ok && data.value) {
        setOrigins((JSON.parse(data.value) as string[]).map(e => e.includes(":") ? e.split(":")[0] : e));
      } else {
        setOrigins([]);
      }
    } catch {
      setOrigins([]);
    } finally {
      setOriginsLoading(false);
    }
  }

  async function saveOrigins(list: string[]) {
    try {
      await fetch("/api/v1/settings/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "allowed_dev_origins", value: JSON.stringify(list) }),
      });
    } catch {
      alert("保存失败");
    }
  }

  async function addOrigin() {
    const raw = newOrigin.trim();
    if (!raw) return;
    // 自动去掉端口，只保留 hostname（proxy 比对时不含端口）
    const val = raw.includes(":") ? raw.split(":")[0] : raw;
    if (origins.includes(val)) {
      setNewOrigin("");
      return;
    }
    const next = [...origins, val];
    setOrigins(next);
    setNewOrigin("");
    await saveOrigins(next);
  }

  async function removeOrigin(idx: number) {
    const next = origins.filter((_, i) => i !== idx);
    setOrigins(next);
    await saveOrigins(next);
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

      {/* 访问白名单 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-800">访问白名单</div>
        <div className="text-xs text-slate-500 mt-0.5">{DEFAULT_ORIGINS_LABEL}</div>
        <div className="text-xs text-slate-500">添加允许访问本系统的域名或 IP（不含端口，端口由访问地址自带），不在白名单内的来源将被拒绝（403）</div>

        <div className="mt-3 space-y-1.5">
          {origins.map((o, i) => (
            <div key={o} className="flex items-center gap-2">
              <span className="text-sm text-slate-700">{o}</span>
              <button onClick={() => removeOrigin(i)}
                className="text-xs text-red-500 hover:text-red-700 hover:underline">删除</button>
            </div>
          ))}
          {origins.length === 0 && !originsLoading && (
            <div className="text-xs text-slate-400">暂无自定义白名单条目</div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            type="text"
            value={newOrigin}
            onChange={(e) => setNewOrigin(e.target.value)}
            placeholder="域名或 IP（不含端口），如 wiseme.floatingice.win"
            className="h-8 px-2 rounded-md border border-slate-200 text-sm text-slate-700 w-48 focus:border-blue-300 focus:outline-none"
            onKeyDown={(e) => { if (e.key === "Enter") addOrigin(); }}
          />
          <button onClick={addOrigin}
            className="h-8 px-3 rounded-md border border-blue-200 bg-white text-sm text-blue-600 hover:bg-blue-50">
            添加
          </button>
        </div>
      </div>
    </div>
  );
}