"use client";

import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";

export function NewLedgerSetupCheck() {
  const [show, setShow] = useState(false);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [adminName, setAdminName] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const checkedRef = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.startsWith("/settings")) {
      setChecking(false);
      return;
    }
    if (checkedRef.current) return;
    const run = () => {
      checkedRef.current = true;
      fetch("/api/v1/auth/household-password-status")
        .then(r => r.json() as Promise<{ ok: boolean; hasPassword: boolean; adminUser: { id: string; name: string } | null }>)
        .then(data => {
          if (data.ok && !data.hasPassword && data.adminUser) {
            setAdminName(data.adminUser.name);
            setShow(true);
          }
          setChecking(false);
        })
        .catch(() => {
          setChecking(false);
        });
    };

    const delayMs = pathname.startsWith("/settings") ? 2500 : 800;
    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const idleId = requestIdle(run, { timeout: delayMs });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(run, delayMs);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  function getSetupValues() {
    const container = dialogRef.current;
    if (!container) return { newPassword: "", confirmPassword: "" };
    const newPassword = (container.querySelector<HTMLInputElement>('input[data-field="newPassword"]')?.value ?? "").trim();
    const confirmPassword = (container.querySelector<HTMLInputElement>('input[data-field="confirmPassword"]')?.value ?? "").trim();
    return { newPassword, confirmPassword };
  }

  async function handleSetup() {
    const { newPassword, confirmPassword } = getSetupValues();
    if (!newPassword) { setError("请输入密码"); return; }
    if (newPassword !== confirmPassword) { setError("两次输入的密码不一致"); return; }

    setLoading(true);
    setError("");
    try {
      const setupRes = await fetch("/api/v1/auth/password-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword, username: adminName }),
      });
      const setupData = await setupRes.json() as { ok: boolean; error?: string };
      if (!setupData.ok) { setError(setupData.error ?? "设置失败"); setLoading(false); return; }

      const loginRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword, username: adminName }),
      });
      const loginData = await loginRes.json() as { ok: boolean; error?: string };
      if (loginData.ok) {
        window.location.reload();
      } else {
        setError(loginData.error ?? "登录失败");
      }
    } catch {
      setError("设置失败");
    } finally {
      setLoading(false);
    }
  }

  function handleSkip() {
    setShow(false);
  }

  if (checking || !show) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
          <div className="text-base font-semibold text-slate-800">新账簿初始化</div>
          <div className="mt-1 text-xs text-slate-500">
            为账簿管理员 <span className="font-semibold text-slate-700">{adminName}</span> 设置密码
          </div>
        </div>

        <div ref={dialogRef} className="p-6 space-y-4">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">设置密码</div>
            <input
              data-field="newPassword"
              type="password"
              autoComplete="new-password"
              className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
              placeholder="输入密码"
              autoFocus
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
          <button
            type="button"
            className="h-10 w-full rounded-md border border-slate-200 bg-white text-slate-600 text-sm hover:bg-slate-50"
            onClick={handleSkip}
          >
            跳过
          </button>
        </div>
      </div>
    </div>
  );
}
