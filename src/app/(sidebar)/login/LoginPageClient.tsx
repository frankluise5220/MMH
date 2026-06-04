"use client";

import { useState, useRef, useEffect } from "react";

export function LoginPageClient() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"login" | "setup">("login");
  const loginRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/v1/auth/password-status")
      .then(r => r.json() as Promise<{ ok: boolean; hasPassword: boolean }>)
      .then(data => {
        if (data.ok) {
          setMode(data.hasPassword ? "login" : "setup");
        }
        setChecking(false);
      })
      .catch(() => {
        setMode("setup");
        setChecking(false);
      });
  }, []);

  function getLoginValues() {
    const container = loginRef.current;
    if (!container) return { username: "", password: "" };
    const username = (container.querySelector<HTMLInputElement>('input[data-field="username"]')?.value ?? "").trim();
    const password = (container.querySelector<HTMLInputElement>('input[data-field="password"]')?.value ?? "").trim();
    return { username, password };
  }

  function getSetupValues() {
    const container = setupRef.current;
    if (!container) return { username: "", newPassword: "", confirmPassword: "" };
    const username = (container.querySelector<HTMLInputElement>('input[data-field="username"]')?.value ?? "").trim();
    const newPassword = (container.querySelector<HTMLInputElement>('input[data-field="newPassword"]')?.value ?? "").trim();
    const confirmPassword = (container.querySelector<HTMLInputElement>('input[data-field="confirmPassword"]')?.value ?? "").trim();
    return { username, newPassword, confirmPassword };
  }

  async function handleLogin() {
    const { username, password } = getLoginValues();
    if (!username) { setError("请输入用户名"); return; }
    if (!password) { setError("请输入密码"); return; }

    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, username }),
      });
      const data = await res.json() as { ok: boolean; error?: string };
      if (data.ok) {
        window.location.href = "/";
      } else {
        setError(data.error ?? "密码错误");
      }
    } catch {
      setError("验证失败");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetup() {
    const { username, newPassword, confirmPassword } = getSetupValues();
    if (!username) { setError("请输入用户名"); return; }
    if (!newPassword) { setError("请输入密码"); return; }
    if (newPassword !== confirmPassword) { setError("两次输入的密码不一致"); return; }

    setLoading(true);
    setError("");
    try {
      const setupRes = await fetch("/api/v1/auth/password-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword, username }),
      });
      const setupData = await setupRes.json() as { ok: boolean; error?: string };
      if (!setupData.ok) { setError(setupData.error ?? "设置失败"); return; }

      const loginRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword, username }),
      });
      const loginData = await loginRes.json() as { ok: boolean; error?: string };
      if (loginData.ok) {
        window.location.href = "/";
      } else {
        setError(loginData.error ?? "登录失败");
      }
    } catch {
      setError("设置失败");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
          <div className="p-6 text-center text-sm text-slate-500">加载中…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
          <div className="text-base font-semibold text-slate-800">WiseMe</div>
          {mode === "login" && (
            <div className="mt-1 text-xs text-slate-500">输入用户名和密码以继续</div>
          )}
          {mode === "setup" && (
            <div className="mt-1 text-xs text-slate-500">首次使用，请设置管理员账户</div>
          )}
        </div>

        {mode === "login" && (
          <div ref={loginRef} className="p-6 space-y-4">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">用户名</div>
              <input
                data-field="username"
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                placeholder="输入用户名"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">密码</div>
              <input
                data-field="password"
                type="password"
                autoComplete="current-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                placeholder="输入密码"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") handleLogin(); }}
              />
            </div>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
              onClick={handleLogin}
            >
              {loading ? "验证中…" : "进入"}
            </button>
          </div>
        )}

        {mode === "setup" && (
          <div ref={setupRef} className="p-6 space-y-4">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">用户名</div>
              <input
                data-field="username"
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                defaultValue="admin"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">设置密码</div>
              <input
                data-field="newPassword"
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                placeholder="输入密码"
                onKeyDown={(e) => { if (e.key === "Enter") handleSetup(); }}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">确认密码</div>
              <input
                data-field="confirmPassword"
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                placeholder="再次输入密码"
                onKeyDown={(e) => { if (e.key === "Enter") handleSetup(); }}
              />
            </div>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
              onClick={handleSetup}
            >
              {loading ? "设置中…" : "设置并进入"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}