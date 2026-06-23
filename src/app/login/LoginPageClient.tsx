"use client";

import { useEffect, useState } from "react";
import { getHouseholdDisplayName } from "@/lib/household-display";

type HouseholdChoice = {
  id: string;
  name: string;
};

type AuthVerifyResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  households?: HouseholdChoice[];
};

type PasswordStatusResponse = {
  ok: boolean;
  hasPassword: boolean;
  passwordResetEnabled?: boolean;
  users?: { id: string; name: string }[];
};

type ResetStep = "request" | "confirm";

export function LoginPageClient({ householdName }: { householdName: string | null }) {
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [systemUsers, setSystemUsers] = useState<{ id: string; name: string }[]>([]);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [householdChoices, setHouseholdChoices] = useState<HouseholdChoice[]>([]);
  const [pendingLogin, setPendingLogin] = useState<{ username: string; password: string } | null>(null);

  const [setupUsername, setSetupUsername] = useState("admin");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [showReset, setShowReset] = useState(false);
  const [resetStep, setResetStep] = useState<ResetStep>("request");
  const [resetUsername, setResetUsername] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetInfo, setResetInfo] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const currentHouseholdDisplayName = getHouseholdDisplayName({ name: householdName });

  useEffect(() => {
    fetch("/api/v1/auth/password-status")
      .then((res) => res.json() as Promise<PasswordStatusResponse>)
      .then((data) => {
        if (data.ok) {
          setMode(data.hasPassword ? "login" : "setup");
          setSystemUsers(data.users ?? []);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
          if ((data.users?.length ?? 0) > 0) {
            setUsername(data.users![0]!.name);
          }
        }
        if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("reset") === "1") {
          setShowReset(true);
        }
      })
      .catch(() => {
        setMode("setup");
      })
      .finally(() => {
        setChecking(false);
      });
  }, []);

  async function verifyLogin(params: { username: string; password: string; householdId?: string }) {
    const res = await fetch("/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    return res.json() as Promise<AuthVerifyResponse>;
  }

  async function handleLogin() {
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    if (!trimmedUsername) { setError("请输入用户名"); return; }
    if (!trimmedPassword) { setError("请输入密码"); return; }

    setLoading(true);
    setError("");
    setHouseholdChoices([]);
    setPendingLogin(null);

    try {
      const data = await verifyLogin({ username: trimmedUsername, password: trimmedPassword });
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      if (data.code === "AMBIGUOUS_USER" && data.households?.length) {
        setPendingLogin({ username: trimmedUsername, password: trimmedPassword });
        setHouseholdChoices(data.households);
        setError(data.error ?? "该用户名存在于多个账簿，请选择账簿");
        return;
      }
      setError(data.error ?? "登录失败");
    } catch {
      setError("验证失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function handleHouseholdChoice(householdId: string) {
    const credentials = pendingLogin ?? { username: username.trim(), password: password.trim() };
    if (!credentials.username) { setError("请输入用户名"); return; }
    if (!credentials.password) { setError("请输入密码"); return; }

    setLoading(true);
    setError("");
    try {
      const data = await verifyLogin({ ...credentials, householdId });
      if (data.ok) {
        window.location.href = "/";
        return;
      }
      setError(data.error ?? "登录失败");
    } catch {
      setError("验证失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  function cancelHouseholdChoice() {
    setHouseholdChoices([]);
    setPendingLogin(null);
    setError("");
  }

  async function handleSetup() {
    const trimmedUsername = setupUsername.trim();
    const trimmedPassword = newPassword.trim();
    if (!trimmedUsername) { setError("请输入用户名"); return; }
    if (!trimmedPassword) { setError("请输入密码"); return; }
    if (trimmedPassword !== confirmPassword.trim()) { setError("两次输入的密码不一致"); return; }

    setLoading(true);
    setError("");
    try {
      const setupRes = await fetch("/api/v1/auth/password-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: trimmedPassword, username: trimmedUsername }),
      });
      const setupData = await setupRes.json() as { ok: boolean; error?: string };
      if (!setupData.ok) {
        setError(setupData.error ?? "设置失败");
        return;
      }

      const loginData = await verifyLogin({ username: trimmedUsername, password: trimmedPassword });
      if (loginData.ok) {
        window.location.href = "/";
        return;
      }
      setError(loginData.error ?? "登录失败");
    } catch {
      setError("设置失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetRequest() {
    if (!resetUsername.trim()) { setResetError("请输入用户名"); return; }
    if (!resetEmail.trim()) { setResetError("请输入找回邮箱"); return; }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: resetUsername.trim(), email: resetEmail.trim() }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; message?: string } | null;
      if (!data?.ok) {
        setResetError(data?.error ?? "发送失败");
        return;
      }
      setResetInfo(data.message ?? "如果该用户已绑定邮箱，将收到一封验证码邮件。");
      setResetStep("confirm");
    } catch {
      setResetError("发送失败，请稍后重试");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleResetConfirm() {
    if (!resetUsername.trim()) { setResetError("请输入用户名"); return; }
    if (!resetCode.trim()) { setResetError("请输入验证码"); return; }
    if (!resetNewPassword.trim()) { setResetError("请输入新密码"); return; }
    if (resetNewPassword.trim() !== resetConfirmPassword.trim()) {
      setResetError("两次输入的密码不一致");
      return;
    }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: resetUsername.trim(),
          code: resetCode.trim(),
          newPassword: resetNewPassword.trim(),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) {
        setResetError(data?.error ?? "重置失败");
        return;
      }
      setResetInfo("密码已重置，请返回登录。");
      setResetStep("request");
      setShowReset(false);
      setPassword(resetNewPassword.trim());
      setUsername(resetUsername.trim());
    } catch {
      setResetError("重置失败，请稍后重试");
    } finally {
      setResetLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="p-6 text-center text-sm text-slate-500">加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-200 bg-slate-50 px-6 py-5">
          {householdName && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">账簿</div>}
          <div className="flex items-center justify-between">
            <div className="text-base font-semibold text-slate-800">{householdName ? currentHouseholdDisplayName : "MMH"}</div>
            <button
              type="button"
              onClick={() => { window.location.href = "/"; }}
              className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="返回首页"
            >
              返回
            </button>
          </div>
          {mode === "login" && <div className="mt-1 text-xs text-slate-500">输入用户名和密码以继续</div>}
          {mode === "setup" && <div className="mt-1 text-xs text-slate-500">首次使用，请设置管理员账户</div>}
        </div>

        {mode === "login" && (
          <div className="space-y-4 p-6">
            {!showReset && (
              <>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">用户名</div>
                  {systemUsers.length > 0 ? (
                    <select
                      value={username}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        cancelHouseholdChoice();
                      }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {systemUsers.map((user) => (
                        <option key={user.id} value={user.name}>{user.name}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={username}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        cancelHouseholdChoice();
                      }}
                      type="text"
                      autoComplete="username"
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      placeholder="输入用户名"
                    />
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">密码</div>
                  <input
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      cancelHouseholdChoice();
                    }}
                    type="password"
                    autoComplete="current-password"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder="输入密码"
                    autoFocus
                    onKeyDown={(event) => { if (event.key === "Enter") void handleLogin(); }}
                  />
                </div>

                {householdChoices.length > 0 && (
                  <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">选择账簿</div>
                      <div className="mt-1 text-xs text-slate-500">多个账簿使用了这个用户名，请选择要进入的账簿后继续验证密码。</div>
                    </div>
                    <div className="space-y-2">
                      {householdChoices.map((household) => (
                        <button
                          key={household.id}
                          type="button"
                          className="w-full rounded-lg border border-blue-100 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                          disabled={loading}
                          onClick={() => void handleHouseholdChoice(household.id)}
                        >
                          {getHouseholdDisplayName(household)}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="text-xs text-slate-500 hover:text-slate-700"
                      disabled={loading}
                      onClick={cancelHouseholdChoice}
                    >
                      重新输入用户名
                    </button>
                  </div>
                )}

                {error && <div className="text-sm text-red-600">{error}</div>}
                {passwordResetEnabled && (
                  <button
                    type="button"
                    className="text-xs text-slate-500 transition-colors hover:text-blue-700"
                    onClick={() => {
                      setShowReset(true);
                      setResetUsername(username);
                      cancelHouseholdChoice();
                    }}
                  >
                    忘记密码？通过邮箱找回
                  </button>
                )}
                <button
                  type="button"
                  className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={loading}
                  onClick={() => void handleLogin()}
                >
                  {loading ? "验证中..." : "进入"}
                </button>
              </>
            )}

            {passwordResetEnabled && (
              <button
                type="button"
                className="w-full text-xs text-slate-500 hover:text-slate-700"
                onClick={() => {
                  setShowReset(!showReset);
                  setResetStep("request");
                  setResetError("");
                  setResetInfo("");
                }}
                disabled={loading || resetLoading}
              >
                {showReset ? "收起找回密码" : "忘记密码？"}
              </button>
            )}

            {showReset && (
              <div className="space-y-3 border-t border-slate-100 pt-2">
                <div className="text-xs font-medium text-slate-600">找回密码</div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">用户名</div>
                  <input
                    value={resetUsername}
                    onChange={(event) => setResetUsername(event.target.value)}
                    type="text"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    placeholder="输入用户名"
                  />
                </div>
                {resetStep === "request" && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">找回邮箱</div>
                    <input
                      value={resetEmail}
                      onChange={(event) => setResetEmail(event.target.value)}
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
                        value={resetCode}
                        onChange={(event) => setResetCode(event.target.value)}
                        type="text"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder="邮箱中收到的验证码"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">新密码</div>
                      <input
                        value={resetNewPassword}
                        onChange={(event) => setResetNewPassword(event.target.value)}
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder="输入新密码"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">确认新密码</div>
                      <input
                        value={resetConfirmPassword}
                        onChange={(event) => setResetConfirmPassword(event.target.value)}
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
                    onClick={() => void handleResetRequest()}
                  >
                    {resetLoading ? "发送中..." : "发送验证码"}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="h-9 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                      disabled={resetLoading}
                      onClick={() => void handleResetConfirm()}
                    >
                      {resetLoading ? "提交中..." : "重置密码"}
                    </button>
                    <button
                      type="button"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                      disabled={resetLoading}
                      onClick={() => {
                        setResetStep("request");
                        setResetError("");
                        setResetInfo("");
                      }}
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
          <div className="space-y-4 p-6">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">用户名</div>
              <input
                value={setupUsername}
                onChange={(event) => setSetupUsername(event.target.value)}
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="例如：admin 或张四"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">设置密码</div>
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="输入密码"
                onKeyDown={(event) => { if (event.key === "Enter") void handleSetup(); }}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">确认密码</div>
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="再次输入密码"
                onKeyDown={(event) => { if (event.key === "Enter") void handleSetup(); }}
              />
            </div>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
              onClick={() => void handleSetup()}
            >
              {loading ? "设置中..." : "设置并进入"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
