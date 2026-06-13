"use client";

import { useState, useRef, useEffect } from "react";

export function LoginPageClient({ householdName }: { householdName: string | null }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [systemUsers, setSystemUsers] = useState<any[]>([]);
  const [showReset, setShowReset] = useState(false);
  const [resetStep, setResetStep] = useState<"request" | "confirm">("request");
  const [resetInfo, setResetInfo] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const loginRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef<HTMLDivElement>(null);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/v1/auth/password-status")
      .then(r => r.json() as Promise<{ ok: boolean; hasPassword: boolean; passwordResetEnabled?: boolean; users?: any[] }>)
      .then(data => {
        if (data.ok) {
          setMode(data.hasPassword ? "login" : "setup");
          if (data.users) setSystemUsers(data.users);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
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
    const username = (container.querySelector<HTMLInputElement | HTMLSelectElement>('[data-field="username"]')?.value ?? "").trim();
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

  function getResetValues() {
    const container = loginRef.current;
    if (!container) return { username: "", email: "", code: "", newPassword: "", confirmPassword: "" };
    const username = (container.querySelector<HTMLInputElement>('input[data-field="resetUsername"]')?.value ?? "").trim();
    const email = (container.querySelector<HTMLInputElement>('input[data-field="resetEmail"]')?.value ?? "").trim();
    const code = (container.querySelector<HTMLInputElement>('input[data-field="resetCode"]')?.value ?? "").trim();
    const newPassword = (container.querySelector<HTMLInputElement>('input[data-field="resetNewPassword"]')?.value ?? "").trim();
    const confirmPassword = (container.querySelector<HTMLInputElement>('input[data-field="resetConfirmPassword"]')?.value ?? "").trim();
    return { username, email, code, newPassword, confirmPassword };
  }

  async function handleResetRequest() {
    const { username, email } = getResetValues();
    if (!username) { setResetError("请输入用户名"); return; }
    if (!email) { setResetError("请输入找回邮箱"); return; }
    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email }),
      });
      const data = await res.json().catch(() => null) as { ok: boolean; error?: string; message?: string } | null;
      if (!data?.ok) {
        setResetError(data?.error ?? "发送失败");
        return;
      }
      setResetInfo(data.message ?? "如果该用户已绑定邮箱，将收到一封验证码邮件。");
      setResetStep("confirm");
    } catch {
      setResetError("发送失败");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleResetConfirm() {
    const { username, code, newPassword, confirmPassword } = getResetValues();
    if (!username) { setResetError("请输入用户名"); return; }
    if (!code) { setResetError("请输入验证码"); return; }
    if (!newPassword) { setResetError("请输入新密码"); return; }
    if (newPassword !== confirmPassword) { setResetError("两次输入的密码不一致"); return; }
    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, code, newPassword }),
      });
      const data = await res.json().catch(() => null) as { ok: boolean; error?: string } | null;
      if (!data?.ok) {
        setResetError(data?.error ?? "重置失败");
        return;
      }
      setResetInfo("密码已重置，请返回登录。");
      setResetStep("request");
      setShowReset(false);
    } catch {
      setResetError("重置失败");
    } finally {
      setResetLoading(false);
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
          {householdName && (
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">账簿</div>
          )}
          <div className="flex items-center justify-between">
            <div className="text-base font-semibold text-slate-800">{householdName || "WiseMe"}</div>
            <button
              onClick={() => { window.location.href = "/"; }}
              className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded-md hover:bg-slate-100"
              title="返回首页"
            >
              返回
            </button>
          </div>
          {mode === "login" && (
            <div className="mt-1 text-xs text-slate-500">输入用户名和密码以继续</div>
          )}
          {mode === "setup" && (
            <div className="mt-1 text-xs text-slate-500">首次使用，请设置管理员账户</div>
          )}
        </div>

        {mode === "login" && (
          <div ref={loginRef} className="p-6 space-y-4">
            {!showReset && (
              <>
                <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">用户名</div>
              {systemUsers.length > 0 ? (
                <select
                  data-field="username"
                  className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                >
                  {systemUsers.map(u => (
                    <option key={u.id} value={u.name}>{u.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  data-field="username"
                  type="text"
                  autoComplete="username"
                  className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                  placeholder="输入用户名"
                />
              )}
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
              </>
            )}
            
            {passwordResetEnabled && (
              <button
                type="button"
                className="w-full text-xs text-slate-500 hover:text-slate-700"
                onClick={() => { setShowReset(!showReset); setResetStep("request"); setResetError(""); setResetInfo(""); }}
                disabled={loading || resetLoading}
              >
                {showReset ? "收起找回密码" : "忘记密码？"}
              </button>
            )}

            {showReset && (
              <div className="pt-2 border-t border-slate-100 space-y-3">
                <div className="text-xs font-medium text-slate-600">找回密码</div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">用户名</div>
                  <input
                    data-field="resetUsername"
                    type="text"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    placeholder="输入用户名"
                  />
                </div>
                {resetStep === "request" && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">找回邮箱</div>
                    <input
                      data-field="resetEmail"
                      type="email"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      placeholder="该用户绑定的邮箱"
                    />
                  </div>
                )}
                {resetStep === "confirm" && (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">验证码</div>
                      <input
                        data-field="resetCode"
                        type="text"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder="邮箱中收到的验证码"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">新密码</div>
                      <input
                        data-field="resetNewPassword"
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder="输入新密码"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">确认新密码</div>
                      <input
                        data-field="resetConfirmPassword"
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder="再次输入新密码"
                      />
                    </div>
                  </>
                )}
                {resetError && <div className="text-sm text-red-600">{resetError}</div>}
                {resetInfo && <div className="text-sm text-slate-600">{resetInfo}</div>}
                {resetStep === "request" ? (
                  <button
                    type="button"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    disabled={resetLoading}
                    onClick={handleResetRequest}
                  >
                    {resetLoading ? "发送中…" : "发送验证码"}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="h-9 w-full rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                      disabled={resetLoading}
                      onClick={handleResetConfirm}
                    >
                      {resetLoading ? "提交中…" : "重置密码"}
                    </button>
                    <button
                      type="button"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                      disabled={resetLoading}
                      onClick={() => { setResetStep("request"); setResetError(""); setResetInfo(""); }}
                    >
                      返回上一步
                    </button>
                  </div>
                )}
              </div>
            )}
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
