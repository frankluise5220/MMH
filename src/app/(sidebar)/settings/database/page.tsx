"use client";

import { useState, useEffect } from "react";
import { Shield } from "lucide-react";

const DEFAULT_ORIGINS_LABEL = "默认白名单（不可编辑）：局域网 IP + localhost";

export default function DatabaseSettingsPage() {
  const [status, setStatus] = useState<"checking" | "running" | "stopped">("checking");
  const [loading, setLoading] = useState(false);
  const port = 49152;
  const [origins, setOrigins] = useState<string[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [originCheckEnabled, setOriginCheckEnabled] = useState(true);

  // 系统初始化
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [resetDbPassword, setResetDbPassword] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetting, setResetting] = useState(false);

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
      const [originsRes, checkRes] = await Promise.all([
        fetch("/api/v1/settings/system?key=allowed_dev_origins"),
        fetch("/api/v1/settings/system?key=origin_check_enabled"),
      ]);
      const originsData = await originsRes.json();
      const checkData = await checkRes.json();
      if (originsData.ok && originsData.value) {
        setOrigins((JSON.parse(originsData.value) as string[]).map(e => e.includes(":") ? e.split(":")[0] : e));
      } else {
        setOrigins([]);
      }
      if (checkData.ok && checkData.value !== undefined) {
        setOriginCheckEnabled(checkData.value !== "false");
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

  async function toggleOriginCheck(enabled: boolean) {
    setOriginCheckEnabled(enabled);
    await fetch("/api/v1/settings/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "origin_check_enabled", value: String(enabled) }),
    }).catch(() => {});
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

  async function handleFactoryReset() {
    if (resetConfirmText !== "系统初始化") {
      setResetError("请输入正确的确认文字");
      return;
    }
    if (!resetDbPassword.trim()) {
      setResetError("请输入数据库密码");
      return;
    }
    setResetting(true);
    setResetError("");
    try {
      // 先验证数据库密码
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetDbPassword, verifySystem: true }),
      });
      const vd = await verifyRes.json();
      if (!vd.ok) {
        setResetError(vd.error ?? "数据库密码错误");
        setResetting(false);
        return;
      }
      // 执行系统初始化
      const res = await fetch("/api/v1/settings/factory-reset", { method: "POST" });
      const d = await res.json();
      if (d.ok) {
        window.location.href = "/login";
      } else {
        setResetError(d.error ?? "操作失败");
      }
    } catch {
      setResetError("网络错误，请重试");
    } finally {
      setResetting(false);
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

      {/* 访问白名单 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">访问白名单</div>
            <div className="text-xs text-slate-500 mt-0.5">{DEFAULT_ORIGINS_LABEL}</div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" className="sr-only peer" checked={originCheckEnabled} onChange={(e) => toggleOriginCheck(e.target.checked)} />
            <div className="w-9 h-5 bg-slate-200 peer-checked:bg-blue-600 rounded-full peer transition-colors after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        {originCheckEnabled && (
          <>
        <div className="text-xs text-slate-500">添加允许访问本系统的域名或 IP（不含端口），不在白名单内的来源将被拒绝（403）</div>

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
            placeholder="域名或 IP（不含端口），如 mmh.floatingice.win"
            className="h-8 px-2 rounded-md border border-slate-200 text-sm text-slate-700 w-48 focus:border-blue-300 focus:outline-none"
            onKeyDown={(e) => { if (e.key === "Enter") addOrigin(); }}
          />
          <button onClick={addOrigin}
            className="h-8 px-3 rounded-md border border-blue-200 bg-white text-sm text-blue-600 hover:bg-blue-50">
            添加
          </button>
        </div>
          </>
        )}
      </div>

      {/* 系统初始化 */}
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="text-sm font-medium text-red-800">系统初始化</div>
        <div className="text-xs text-red-600 mt-0.5">
          此操作不可撤销，将删除所有数据（账簿、交易记录、账户、分类、用户等），恢复到第一次安装完成的状态。操作完成后需要重新创建账簿和管理员。
        </div>

        <div className="mt-3 space-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">
              请输入 <span className="font-bold text-red-700">系统初始化</span> 以确认操作
            </div>
            <input
              value={resetConfirmText}
              onChange={(e) => { setResetConfirmText(e.target.value); setResetError(""); }}
              className="h-9 w-64 rounded-md border border-red-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-red-100 focus:border-red-400"
              placeholder="系统初始化"
              autoComplete="off"
            />
          </div>

          <div className="pt-2 border-t border-red-100">
            <div className="flex items-center gap-1.5 mb-1">
              <Shield className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span className="text-xs font-medium text-amber-700">数据库密码验证</span>
            </div>
            <input
              type="password"
              value={resetDbPassword}
              onChange={(e) => { setResetDbPassword(e.target.value); setResetError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleFactoryReset(); }}
              className="h-9 w-64 rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-amber-100 focus:border-amber-400"
              placeholder="输入数据库密码"
              autoComplete="off"
            />
            <div className="mt-1 text-[10px] text-slate-400">系统初始化需要验证数据库密码</div>
          </div>

          {resetError && (
            <div className="text-sm text-red-600">{resetError}</div>
          )}

          <button
            type="button"
            onClick={handleFactoryReset}
            disabled={resetting || resetConfirmText !== "系统初始化" || !resetDbPassword.trim()}
            className="h-9 px-4 rounded-md bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50"
          >
            {resetting ? "执行中…" : "系统初始化"}
          </button>
        </div>
      </div>
    </div>
  );
}