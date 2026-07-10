"use client";

import { useEffect, useState } from "react";
import { getHouseholdDisplayName } from "@/lib/household-display";
import {
  APP_PREFS_EVENT,
  getDisplayLanguagePreference,
  type DisplayLanguage,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";
import { getProductIntro } from "@/lib/product-intro";
import { MmhLogo } from "@/components/MmhLogo";

type HouseholdChoice = {
  id: string;
  name: string;
};

type AuthVerifyResponse = {
  ok: boolean;
  error?: string;
  code?: string;
  households?: HouseholdChoice[];
  householdId?: string | null;
  message?: string;
  maskedEmailHint?: string | null;
};

type PasswordStatusResponse = {
  ok: boolean;
  hasPassword: boolean;
  passwordResetEnabled?: boolean;
  users?: { id: string; name: string }[];
};

type CreateLedgerResponse = {
  ok: boolean;
  error?: string;
};

type ResetStep = "request" | "confirm";
type LoginMode = "login" | "setup" | "create";

export function LoginPageClient({ householdName }: { householdName: string | null }) {
  const [mode, setMode] = useState<LoginMode>("login");
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [displayLanguage, setDisplayLanguage] = useState<DisplayLanguage>("zh-CN");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [systemUsers, setSystemUsers] = useState<{ id: string; name: string }[]>([]);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [householdChoices, setHouseholdChoices] = useState<HouseholdChoice[]>([]);
  const [pendingLogin, setPendingLogin] = useState<{ username: string; password: string } | null>(null);

  const [setupUsername, setSetupUsername] = useState("admin");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [createInviteCode, setCreateInviteCode] = useState("");
  const [createLedgerName, setCreateLedgerName] = useState("");
  const [createAdminName, setCreateAdminName] = useState("admin");
  const [createAdminEmail, setCreateAdminEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createConfirmPassword, setCreateConfirmPassword] = useState("");

  const [showReset, setShowReset] = useState(false);
  const [resetStep, setResetStep] = useState<ResetStep>("request");
  const [resetUsername, setResetUsername] = useState("");
  const [resetEmail, setResetEmail] = useState("");
  const [resetEmailHint, setResetEmailHint] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetInfo, setResetInfo] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetHouseholdId, setResetHouseholdId] = useState("");
  const [resetHouseholdChoices, setResetHouseholdChoices] = useState<HouseholdChoice[]>([]);
  const { t } = useI18n();
  const currentHouseholdDisplayName = getHouseholdDisplayName({ name: householdName });
  const productIntro = getProductIntro(displayLanguage);

  function openPasswordReset() {
    setResetStep("request");
    setResetInfo("");
    setResetEmail("");
    setResetEmailHint("");
    setResetHouseholdId("");
    setResetHouseholdChoices([]);
    if (!passwordResetEnabled) {
      setResetError("当前未配置可用的发件服务，无法发送密码找回验证码。请先在系统设置里配置 SMTP 或 Resend。");
      setShowReset(true);
      setResetUsername(username);
      cancelHouseholdChoice();
      return;
    }
    setResetError("");
    setShowReset(true);
    setResetUsername(username);
    cancelHouseholdChoice();
  }

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 5000);
    let mounted = true;

    void fetch("/api/v1/auth/password-status", { signal: controller.signal })
      .then((res) => res.json() as Promise<PasswordStatusResponse>)
      .then((data) => {
        if (!mounted) return;
        if (data.ok) {
          setMode(data.hasPassword ? "login" : "setup");
          setSystemUsers(data.users ?? []);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
          const firstUser = data.users?.[0];
          if (firstUser) {
            setUsername(firstUser.name);
          }
        } else {
          setMode("login");
          setSystemUsers([]);
          setPasswordResetEnabled(false);
        }
        if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("reset") === "1") {
          setShowReset(true);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setMode("login");
        setSystemUsers([]);
        setPasswordResetEnabled(false);
      })
      .finally(() => {
        window.clearTimeout(timeoutId);
        if (mounted) {
          setChecking(false);
        }
      });

    return () => {
      mounted = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    function syncLanguagePreference() {
      setDisplayLanguage(getDisplayLanguagePreference());
    }
    syncLanguagePreference();
    window.addEventListener(APP_PREFS_EVENT, syncLanguagePreference);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncLanguagePreference);
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

  async function handleCreateLedger() {
    const trimmedInviteCode = createInviteCode.trim();
    const trimmedLedgerName = createLedgerName.trim();
    const trimmedAdminName = createAdminName.trim() || "admin";
    const trimmedAdminEmail = createAdminEmail.trim();
    const trimmedPassword = createPassword.trim();
    const trimmedConfirmPassword = createConfirmPassword.trim();
    if (!trimmedInviteCode) { setError("请输入邀请码"); return; }
    if (!trimmedLedgerName) { setError("请输入账簿名"); return; }
    if (!trimmedAdminName) { setError("请输入管理员用户名"); return; }
    if (!trimmedAdminEmail) { setError("请输入管理员邮箱"); return; }
    if (!trimmedPassword) { setError("请输入密码"); return; }
    if (trimmedPassword !== trimmedConfirmPassword) { setError("两次输入的密码不一致"); return; }

    setLoading(true);
    setError("");
    try {
      const createRes = await fetch("/api/v1/auth/create-ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteCode: trimmedInviteCode,
          name: trimmedLedgerName,
          adminName: trimmedAdminName,
          adminEmail: trimmedAdminEmail,
          adminPassword: trimmedPassword,
        }),
      });
      const createData = await createRes.json().catch(() => null) as CreateLedgerResponse | null;
      if (!createRes.ok || !createData?.ok) {
        setError(createData?.error ?? "创建账簿失败");
        return;
      }
      window.location.href = "/";
    } catch {
      setError("创建账簿失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetRequest(selectedHouseholdId = resetHouseholdId) {
    if (!resetUsername.trim()) { setResetError("请输入用户名"); return; }
    const previewOnly = !resetEmailHint;
    if (!previewOnly && !resetEmail.trim()) { setResetError("请输入绑定邮箱"); return; }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: resetUsername.trim(),
          ...(previewOnly ? { preview: true } : { email: resetEmail.trim() }),
          ...(selectedHouseholdId ? { householdId: selectedHouseholdId } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as AuthVerifyResponse | null;
      if (!data?.ok) {
        if (data?.code === "AMBIGUOUS_USER" && data.households?.length) {
          setResetHouseholdChoices(data.households);
          setResetError(data.error ?? "该用户名和邮箱匹配多个账簿，请选择账簿");
          return;
        }
        setResetError(data?.error ?? "发送失败");
        return;
      }
      setResetHouseholdId(data.householdId ?? selectedHouseholdId ?? "");
      setResetHouseholdChoices([]);
      if (previewOnly) {
        setResetEmailHint(data.maskedEmailHint ?? "");
        setResetInfo(data.message ?? "请补全绑定邮箱后发送验证码。");
        return;
      }
      setResetInfo(data.message ?? "验证码邮件已发送，请检查邮箱收件箱或垃圾邮件。");
      setResetStep("confirm");
    } catch {
      setResetError("发送失败，请稍后重试");
    } finally {
      setResetLoading(false);
    }
  }

  async function handleResetConfirm(selectedHouseholdId = resetHouseholdId) {
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
          ...(selectedHouseholdId ? { householdId: selectedHouseholdId } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as AuthVerifyResponse | null;
      if (!data?.ok) {
        if (data?.code === "AMBIGUOUS_USER" && data.households?.length) {
          setResetHouseholdChoices(data.households);
          setResetError(data.error ?? "该验证码匹配多个账簿，请选择账簿");
          return;
        }
        setResetError(data?.error ?? "重置失败");
        return;
      }
      setResetInfo("密码已重置，请返回登录。");
      setResetStep("request");
      setShowReset(false);
      setResetHouseholdId("");
      setResetHouseholdChoices([]);
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
          <div className="p-6 text-center text-sm text-slate-500">{t("common.loading")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/58 p-4 backdrop-blur-sm">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-white/16 bg-white/92 shadow-[0_24px_80px_rgba(15,23,42,0.34)] backdrop-blur-xl lg:grid-cols-[minmax(0,1fr)_390px]">
        <section className="relative hidden overflow-hidden bg-slate-950 px-8 py-8 text-white lg:block">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-blue-400/20 blur-3xl" />
          <div className="absolute -bottom-16 left-8 h-56 w-56 rounded-full bg-emerald-300/15 blur-3xl" />
          <div className="relative">
            <h1 className="mt-4 text-3xl font-semibold leading-tight">{productIntro.title}</h1>
            <div className="mt-2 text-sm text-amber-100">{productIntro.mantra}</div>
            <p className="mt-5 text-base leading-7 text-slate-100">{productIntro.lead}</p>
            <div className="mt-6 space-y-4 text-sm leading-7 text-slate-300">
              {productIntro.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <div className="mt-7 grid grid-cols-2 gap-2">
              {productIntro.highlights.map((item) => (
                <span key={item} className="rounded-xl border border-white/12 bg-white/[0.08] px-3 py-2 text-xs leading-5 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm">
                  {item}
                </span>
              ))}
            </div>
          </div>
        </section>

        <div className="min-w-0">
        <div className="border-b border-slate-200/70 bg-white/72 px-6 py-5 shadow-[inset_0_-1px_0_rgba(148,163,184,0.14)] backdrop-blur">
          {householdName && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("login.book")}</div>}
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <MmhLogo size={40} />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-slate-800">{householdName ? currentHouseholdDisplayName : "MoneyMoneyHome"}</div>
                {!householdName && <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-400">Family Finance</div>}
              </div>
            </div>
            <button
              type="button"
              onClick={() => { window.location.href = "/"; }}
              className="rounded-full border border-slate-200/80 bg-white/80 px-3 py-1 text-xs text-slate-500 shadow-sm hover:border-slate-300 hover:bg-white hover:text-slate-700"
              title={t("login.backHome")}
            >
              {t("login.backHome")}
            </button>
          </div>
          {mode === "login" && <div className="mt-1 text-xs text-slate-500">{t("login.continueHint")}</div>}
          {mode === "setup" && <div className="mt-1 text-xs text-slate-500">{t("login.setupHint")}</div>}
          {mode === "create" && <div className="mt-1 text-xs text-slate-500">{t("login.createHint")}</div>}
        </div>

        {mode === "login" && (
          <div className="space-y-4 p-6">
            {!showReset && (
              <>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
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
                      placeholder={t("login.usernamePlaceholder")}
                    />
                  )}
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
                  <input
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      cancelHouseholdChoice();
                    }}
                    type="password"
                    autoComplete="current-password"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.passwordPlaceholder")}
                    autoFocus
                    onKeyDown={(event) => { if (event.key === "Enter") void handleLogin(); }}
                  />
                </div>

                {householdChoices.length > 0 && (
                  <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">选择账簿</div>
                      <div className="mt-1 text-xs text-slate-500">这个用户名和密码匹配多个账簿，请选择要进入的账簿。</div>
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
                <button
                  type="button"
                  className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={loading}
                  onClick={() => void handleLogin()}
                >
                  {loading ? t("login.verifying") : t("login.enter")}
                </button>
              </>
            )}

            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              onClick={() => {
                if (showReset) {
                  setShowReset(false);
                  setResetStep("request");
                  setResetError("");
                  setResetInfo("");
                  return;
                }
                openPasswordReset();
              }}
              disabled={loading || resetLoading}
            >
              {showReset ? t("common.collapse") : t("login.forgotPassword")}
            </button>

            {showReset && (
              <div className="space-y-3 border-t border-slate-100 pt-2">
                <div className="text-xs font-medium text-slate-600">找回密码</div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">用户名</div>
                  <input
                    value={resetUsername}
                    onChange={(event) => {
                      setResetUsername(event.target.value);
                      setResetEmail("");
                      setResetEmailHint("");
                      setResetHouseholdId("");
                      setResetHouseholdChoices([]);
                    }}
                    type="text"
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    placeholder="输入用户名"
                  />
                </div>
                {resetStep === "request" && (
                  resetEmailHint ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">补全绑定邮箱</div>
                      <div className="text-[11px] text-slate-500">请根据提示补全完整邮箱：{resetEmailHint}</div>
                      <input
                        value={resetEmail}
                        onChange={(event) => {
                          setResetEmail(event.target.value);
                          setResetHouseholdChoices([]);
                        }}
                        type="email"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder="输入完整绑定邮箱"
                      />
                    </div>
                  ) : null
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
                {resetHouseholdChoices.length > 0 && (
                  <div className="space-y-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div className="text-xs text-slate-500">请选择要找回密码的账簿。</div>
                    {resetHouseholdChoices.map((household) => (
                      <button
                        key={household.id}
                        type="button"
                        className="w-full rounded-lg border border-blue-100 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                        disabled={resetLoading}
                        onClick={() => {
                          setResetHouseholdId(household.id);
                          if (resetStep === "request") {
                            void handleResetRequest(household.id);
                          } else {
                            void handleResetConfirm(household.id);
                          }
                        }}
                      >
                        {getHouseholdDisplayName(household)}
                      </button>
                    ))}
                  </div>
                )}
                {resetError && <div className="text-sm text-red-600">{resetError}</div>}
                {resetInfo && <div className="text-sm text-slate-600">{resetInfo}</div>}
                {resetStep === "request" ? (
                  <div className="space-y-2">
                    <button
                      type="button"
                      className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      disabled={resetLoading}
                      onClick={() => void handleResetRequest()}
                    >
                      {resetLoading ? "处理中..." : resetEmailHint ? "发送验证码" : "下一步"}
                    </button>
                    {resetEmailHint ? (
                      <button
                        type="button"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        disabled={resetLoading}
                        onClick={() => {
                          setResetEmail("");
                          setResetEmailHint("");
                          setResetError("");
                          setResetInfo("");
                          setResetHouseholdChoices([]);
                        }}
                      >
                        重新输入用户名
                      </button>
                    ) : null}
                  </div>
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

        {mode === "create" && (
          <div className="space-y-4 p-6">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">邀请码</div>
              <input
                value={createInviteCode}
                onChange={(event) => setCreateInviteCode(event.target.value)}
                type="password"
                autoComplete="off"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="输入新建账簿邀请码"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">账簿名</div>
              <input
                value={createLedgerName}
                onChange={(event) => setCreateLedgerName(event.target.value)}
                type="text"
                autoComplete="organization"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="输入新账簿名"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">管理员用户名</div>
              <input
                value={createAdminName}
                onChange={(event) => setCreateAdminName(event.target.value)}
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="输入管理员用户名"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">管理员邮箱</div>
              <input
                value={createAdminEmail}
                onChange={(event) => setCreateAdminEmail(event.target.value)}
                type="email"
                autoComplete="email"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="用于找回密码"
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
              <input
                value={createPassword}
                onChange={(event) => setCreatePassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.passwordPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div>
              <input
                value={createConfirmPassword}
                onChange={(event) => setCreateConfirmPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.confirmPassword")}
                onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }}
              />
            </div>
            {error && <div className="text-sm text-red-600">{error}</div>}
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
              onClick={() => void handleCreateLedger()}
            >
              {loading ? t("login.creating") : t("login.createAndEnter")}
            </button>
            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              disabled={loading}
              onClick={() => {
                setError("");
                setResetError("");
                setResetInfo("");
                setShowReset(false);
                setCreateInviteCode("");
                setCreateLedgerName("");
                setCreateAdminName("admin");
                setCreateAdminEmail("");
                setCreatePassword("");
                setCreateConfirmPassword("");
                setMode("login");
              }}
            >
              {t("login.enter")}
            </button>
          </div>
        )}

        {mode === "setup" && (
          <div className="space-y-4 p-6">
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
              <input
                value={setupUsername}
                onChange={(event) => setSetupUsername(event.target.value)}
                type="text"
                autoComplete="username"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder="admin"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.setupPassword")}</div>
              <input
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.passwordPlaceholder")}
                onKeyDown={(event) => { if (event.key === "Enter") void handleSetup(); }}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div>
              <input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.confirmPassword")}
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
              {loading ? t("login.setting") : t("login.setupAndEnter")}
            </button>
          </div>
        )}

        {mode === "login" && !showReset && (
          <div className="px-6 pb-6 -mt-2">
            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              disabled={loading}
              onClick={() => {
                setError("");
                setResetError("");
                setResetInfo("");
                setShowReset(false);
                setCreateInviteCode("");
                setCreateLedgerName("");
                setCreateAdminName("admin");
                setCreateAdminEmail("");
                setCreatePassword("");
                setCreateConfirmPassword("");
                setMode("create");
              }}
            >
              {t("login.createAccount")}
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
