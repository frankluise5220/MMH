"use client";

import { useEffect, useState } from "react";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { useI18n } from "@/lib/i18n";
import { getProductIntro } from "@/lib/product-intro";
import { MmhLogo } from "@/components/MmhLogo";
import { withBasePath } from "@/lib/base-path";

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
};

type PasswordStatusResponse = {
  ok: boolean;
  hasPassword: boolean;
  needsInitialLedgerSetup?: boolean;
  /** Whether the current fnOS gateway user owns a ledger user. */
  fnosBound?: boolean;
  passwordResetEnabled?: boolean;
  users?: LoginUserChoice[];
};

type LoginUserChoice = {
  id: string;
  name: string;
  email?: string | null;
  hasPassword?: boolean;
  role?: string;
  isSystem?: boolean;
  registrationPrincipalId?: string | null;
  householdId?: string | null;
  householdName?: string | null;
};

type CreateLedgerResponse = {
  ok: boolean;
  code?: string;
  error?: string;
  households?: HouseholdChoice[];
};

/**
 * fnOS unified-gateway identity, forwarded by fnOS when this app runs behind
 * the gateway (X-Trim-* headers). Absent on Docker / Synology / direct access,
 * which keeps the fnOS login mode hidden there.
 */
export type FnosGatewayUser = {
  uid: string;
  username: string | null;
  isAdmin: boolean;
};

type ResetStep = "request" | "confirm";
type LoginMode = "login" | "create";

const SYSTEM_LOGIN_SCOPE_ID = "__system__";

// Shared control style for the login/create forms. Kept in one place so the
// per-card forms cannot drift apart visually as they get edited independently.
const LOGIN_INPUT_CLASS =
  "h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100";

// 文件卡片式页签：抽成独立组件（src/app/login/FolderTabs.tsx）。
// 本文件用其导出的纯函数（folderTabClass / folderTabPanelClass / FOLDER_TAB_STRIP），
// 登录方式页签与建账方式页签共用；<FolderTabs> 组件本身供外部页面直接复用。
import { folderTabClass, folderTabPanelClass, FOLDER_TAB_STRIP } from "./FolderTabs";

function getLoginUserScopeId(user: LoginUserChoice) {
  return user.householdId ?? SYSTEM_LOGIN_SCOPE_ID;
}

function getInitialLoginSelection(users: LoginUserChoice[]) {
  // The default ledger must be derived from the full user list, never from the
  // "has a local password" subset. A fnOS-gateway deployment creates its admin
  // with no password hash at all, so filtering on `hasPassword` left
  // `selectedHouseholdId` as an empty string while the ledger dropdown still
  // listed every ledger: the <select> rendered a ledger that the state did not
  // actually hold, and submitting reported "select a ledger" for a ledger the
  // user could plainly see selected.
  const ledgerUser = users.find((user) => !!user.householdId) ?? users[0] ?? null;
  const scopeId = ledgerUser ? getLoginUserScopeId(ledgerUser) : "";
  // The pre-selected *user* still prefers a local account: it is only used to
  // prefill the local username field, which MMH / fnOS sign-in ignores.
  const user = users.find((candidate) => candidate.hasPassword === true && getLoginUserScopeId(candidate) === scopeId) ?? null;
  return { scopeId, user };
}

export function LoginPageClient({ householdName, fnosGatewayUser }: { householdName: string | null; fnosGatewayUser?: FnosGatewayUser | null }) {
  const [mode, setMode] = useState<LoginMode>("login");
  // Start in the checking state so the login form only renders after the
  // password-status check resolves. Otherwise the form briefly shows without
  // the book/user rows (2 rows) and then re-renders with them (3 rows),
  // making the layout appear to flip between two different rule sets.
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [username, setUsername] = useState("");
  const [selectedHouseholdId, setSelectedHouseholdId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [password, setPassword] = useState("");
  const [loginMode, setLoginMode] = useState<"local" | "mmh" | "fnos">("local");
  const [loginCredentials, setLoginCredentials] = useState({
    local: { username: "", password: "", userId: "" },
    mmh: { username: "", password: "", userId: "" },
  });
  const [fnosEmail, setFnosEmail] = useState("");
  const [pendingFnos, setPendingFnos] = useState(false);
  const [systemUsers, setSystemUsers] = useState<LoginUserChoice[]>([]);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  const [householdChoices, setHouseholdChoices] = useState<HouseholdChoice[]>([]);
  const [pendingLogin, setPendingLogin] = useState<{ username: string; password: string; authMode?: "local" | "mmh" } | null>(null);
  const [initialLedgerSetup, setInitialLedgerSetup] = useState(false);

  const [createMethod, setCreateMethod] = useState<"invite" | "existing">("invite");
  const [createAuthMode, setCreateAuthMode] = useState<"local" | "mmh" | "fnos">("local");
  // The MMH card has two shapes, mirroring the login tab: the default "sign in
  // with an existing MMH identity" form, and an opt-in "create an MMH user"
  // signup form for people who do not have one yet.
  const [createMmhMode, setCreateMmhMode] = useState<"login" | "register">("login");
  const [createMmhPassword, setCreateMmhPassword] = useState("");
  const [createInviteCode, setCreateInviteCode] = useState("");
  const [createLedgerName, setCreateLedgerName] = useState("");
  const [createAdminName, setCreateAdminName] = useState("");
  const [createAdminEmail, setCreateAdminEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createExistingUserId, setCreateExistingUserId] = useState("");
  const [createExistingPassword, setCreateExistingPassword] = useState("");
  const [createConfirmPassword, setCreateConfirmPassword] = useState("");

  function resetCreateLedgerForm() {
    setCreateMethod("invite");
    setCreateAuthMode(fnosGatewayUser ? "fnos" : "local");
    setCreateMmhMode("login");
    setCreateMmhPassword("");
    setCreateInviteCode("");
    setCreateLedgerName("");
    setCreateAdminName("");
    setCreateAdminEmail("");
    setCreatePassword("");
    setCreateExistingUserId("");
    setCreateExistingPassword("");
    setCreateConfirmPassword("");
  }

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
  const [resetHouseholdId, setResetHouseholdId] = useState("");
  const [resetHouseholdChoices, setResetHouseholdChoices] = useState<HouseholdChoice[]>([]);

  const [registerEmail, setRegisterEmail] = useState("");
  const [registerCodeSent, setRegisterCodeSent] = useState(false);
  const [registerCode, setRegisterCode] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerMmhPassword, setRegisterMmhPassword] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerInfo, setRegisterInfo] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerInviteMode, setRegisterInviteMode] = useState(false);

  // MMH membership password reset (separate from the ledger-local password reset).
  const [showMmhReset, setShowMmhReset] = useState(false);
  const [mmhResetEmail, setMmhResetEmail] = useState("");
  const [mmhResetCode, setMmhResetCode] = useState("");
  const [mmhResetNewPassword, setMmhResetNewPassword] = useState("");
  const [mmhResetConfirmPassword, setMmhResetConfirmPassword] = useState("");
  const [mmhResetCodeSent, setMmhResetCodeSent] = useState(false);
  const [mmhResetInfo, setMmhResetInfo] = useState("");
  const [mmhResetError, setMmhResetError] = useState("");
  const [mmhResetLoading, setMmhResetLoading] = useState(false);
  const { t } = useI18n();
  // Stable primitive so the status effect does not re-run on object identity.
  const hasFnosGateway = Boolean(fnosGatewayUser);
  const currentHouseholdDisplayName = getHouseholdDisplayName({ name: householdName }, t("login.defaultBook"));
  const productIntro = getProductIntro(t);
  const loginHouseholdChoices = getLoginHouseholdChoices();
  // 页签顺序：本地账户 → MMH 用户 →（有网关头时）飞牛账户。
  // 内容板的左上圆角要按「活动页签是不是第一个」决定是否去掉，见 folderTabPanelClass。
  const loginTabOrder: Array<"local" | "mmh" | "fnos"> = fnosGatewayUser ? ["local", "mmh", "fnos"] : ["local", "mmh"];
  const localLoginUsers = systemUsers.filter((user) => user.hasPassword === true);
  const selectedHouseholdUsers = selectedHouseholdId
    ? localLoginUsers.filter((user) => getLoginUserScopeId(user) === selectedHouseholdId)
    : [];
  // MMH sign-in verifies the email + membership password against the central
  // registration service, never against a ledger-local hash — so `hasPassword`
  // must not gate this list. Requiring it hid every MMH identity that had not
  // set a local ledger password (which is exactly what an MMH-created ledger
  // admin has).
  const mmhUserChoices = systemUsers.filter((user) => user.registrationPrincipalId && user.email);
  // The local tab is dead when the *selected* ledger has no local account: the
  // account has to be created inside the ledger, by someone who can already get in.
  const localTabUnavailable = loginMode === "local" && selectedHouseholdUsers.length === 0;

  function maskEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    const atIndex = normalized.indexOf("@");
    if (atIndex <= 0 || atIndex === normalized.length - 1) return normalized;
    const localPart = normalized.slice(0, atIndex);
    const domain = normalized.slice(atIndex + 1);
    const visibleLocal = localPart.length <= 2 ? localPart.slice(0, 1) : localPart.slice(0, 2);
    return `${visibleLocal}***@${domain}`;
  }

  function getLoginUserLabel(user: LoginUserChoice) {
    if (user.email) return `${user.name}(${maskEmail(user.email)})`;
    return user.isSystem ? `${user.name} · ${t("login.systemUserBadge")}` : user.name;
  }

  function getMmhUserLabel(user: LoginUserChoice) {
    if (!user.email) return user.name;
    return `${maskEmail(user.email)}(${user.name})`;
  }

  function updateLoginCredentialField(field: "username" | "password", value: string) {
    const credentialMode = loginMode === "mmh" ? "mmh" : "local";
    setLoginCredentials((current) => ({
      ...current,
        [credentialMode]: {
          ...current[credentialMode],
          [field]: value,
          ...(field === "username" ? { userId: "" } : {}),
        },
    }));
  }

  function selectMmhUser(userId: string) {
    const user = mmhUserChoices.find((item) => item.id === userId) ?? null;
    if (!user || !user.email) return;
    setSelectedUserId("");
    setUsername(user.email);
    setPassword(loginCredentials.mmh.password);
    setLoginCredentials((current) => ({
      ...current,
      mmh: { ...current.mmh, username: user.email ?? "", userId: user.id },
    }));
    cancelHouseholdChoice();
  }

  function getLoginHouseholdChoices() {
    const seen = new Set<string>();
    const choices: HouseholdChoice[] = [];
    for (const user of systemUsers) {
      const id = getLoginUserScopeId(user);
      if (seen.has(id)) continue;
      seen.add(id);
      choices.push({
        id,
        name: user.householdId
          ? getHouseholdDisplayName({ id: user.householdId, name: user.householdName }, t("login.defaultBook"))
          : t("login.systemScope"),
      });
    }
    return choices;
  }

  function selectLoginHousehold(scopeId: string) {
    const user = systemUsers.find((item) => getLoginUserScopeId(item) === scopeId) ?? null;
    setSelectedHouseholdId(scopeId);
    setSelectedUserId(user?.id ?? "");
    setUsername(user?.name ?? "");
    cancelHouseholdChoice();
  }

  function getSelectedLoginUser() {
    const user = systemUsers.find((item) => item.id === selectedUserId) ?? null;
    if (!user) return null;
    if (selectedHouseholdId && getLoginUserScopeId(user) !== selectedHouseholdId) return null;
    return user;
  }

  function switchLoginMode(mode: "local" | "mmh" | "fnos") {
    if (loginMode === "local" || loginMode === "mmh") {
      const currentCredentialMode = loginMode;
      setLoginCredentials((current) => ({
        ...current,
        [currentCredentialMode]: {
          ...current[currentCredentialMode],
          username,
          password,
          ...(currentCredentialMode === "mmh" ? { userId: current.mmh.userId } : {}),
        },
      }));
    }
    setLoginMode(mode);
    setError("");
    setHouseholdChoices([]);
    setPendingLogin(null);
    setPendingFnos(false);
    if (mode === "mmh") {
      const credentials = loginCredentials.mmh;
      const defaultMmhUser = mmhUserChoices.find((user) => user.id === credentials.userId) ?? mmhUserChoices[0];
      const nextUsername = credentials.username || defaultMmhUser?.email || "";
      setSelectedUserId("");
      setUsername(nextUsername);
      setPassword(credentials.password);
      if (!credentials.userId && defaultMmhUser?.email) {
        setLoginCredentials((current) => ({
          ...current,
          mmh: { ...current.mmh, username: nextUsername, userId: defaultMmhUser.id },
        }));
      }
    } else if (mode === "fnos") {
      setSelectedUserId("");
      setUsername("");
      setPassword("");
      if (!selectedHouseholdId && loginHouseholdChoices.length > 0) {
        const initial = getInitialLoginSelection(systemUsers);
        setSelectedHouseholdId(initial.scopeId);
      }
    } else {
      const credentials = loginCredentials.local;
      const initial = getInitialLoginSelection(systemUsers);
      setSelectedHouseholdId(initial.scopeId);
      const nextUserId = credentials.userId || initial.user?.id || "";
      const nextUser = systemUsers.find((user) => user.id === nextUserId) ?? initial.user;
      setSelectedUserId(nextUserId);
      setUsername(credentials.username || nextUser?.name || "");
      setPassword(credentials.password);
    }
  }

  function openPasswordReset() {
    setResetStep("request");
    setResetInfo("");
    setResetEmail("");
    setResetHouseholdId("");
    setResetHouseholdChoices([]);
    if (!passwordResetEnabled) {
      setResetError(t("login.reset.mailNotConfigured"));
      setShowReset(true);
      setResetUsername(getSelectedLoginUser()?.name ?? username);
      cancelHouseholdChoice();
      return;
    }
    setResetError("");
    setShowReset(true);
    setResetUsername(getSelectedLoginUser()?.name ?? username);
    cancelHouseholdChoice();
  }

  useEffect(() => {
    const controller = new AbortController();
    // Generous timeout: a slow first compile or cold API route must not
    // silently degrade the login form into a book-less two-row layout.
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    let mounted = true;

    void fetch("/api/v1/auth/password-status", { signal: controller.signal })
      .then((res) => res.json() as Promise<PasswordStatusResponse>)
      .then((data) => {
        if (!mounted) return;
        if (data.ok) {
          const needsInitialLedgerSetup = data.needsInitialLedgerSetup === true;
          const users = data.users ?? [];
          setInitialLedgerSetup(needsInitialLedgerSetup);
          // `hasPassword` is a global flag: "some user somewhere has a password
          // hash". A deployment whose users are all credential-free (an admin
          // created with a fnOS gateway identity stores no password hash) is
          // already initialised, so it must open the normal sign-in screen — the
          // user signs in with the identity they already hold.
          // Only a completely empty deployment goes to ledger creation; there is
          // no third "set the first administrator password" screen any more.
          setMode(needsInitialLedgerSetup ? "create" : "login");
          if (hasFnosGateway && needsInitialLedgerSetup) {
            setCreateAuthMode("fnos");
          }
          // Behind the fnOS gateway, passwordless login is the primary way in,
          // so open on that tab — but only when the gateway user actually owns a
          // ledger user, otherwise the tab is a dead end. Note this does NOT
          // depend on `hasPassword`: once a fnOS admin binds a local password
          // (which sensitive operations require), the fnOS tab must stay the
          // default rather than demoting passwordless login.
          if (hasFnosGateway && (data.fnosBound || !data.hasPassword)) {
            setLoginMode("fnos");
          }
          setSystemUsers(users);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
          const initialSelection = getInitialLoginSelection(users);
          setSelectedHouseholdId(initialSelection.scopeId);
          const initialUser = initialSelection.user;
          if (initialUser) {
            setSelectedUserId(initialUser.id);
            setUsername(initialUser.name);
            setLoginCredentials((current) => ({
              ...current,
              local: { ...current.local, username: initialUser.name ?? "", userId: initialUser.id },
            }));
          } else {
            setSelectedUserId("");
            setUsername("");
          }
          // A password exists but no user list came back (degraded status):
          // never silently render a login form without the ledger row.
          if (users.length === 0 && data.hasPassword && !needsInitialLedgerSetup) {
            setError(t("login.error.statusCheckFailed"));
          }
        } else {
          setMode("login");
          setInitialLedgerSetup(false);
          setSystemUsers([]);
          setSelectedHouseholdId("");
          setSelectedUserId("");
          setPasswordResetEnabled(false);
          setError(t("login.error.statusCheckFailed"));
        }
        if (typeof window !== "undefined" && new URL(window.location.href).searchParams.get("reset") === "1") {
          setShowReset(true);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setMode("login");
        setInitialLedgerSetup(false);
        setSystemUsers([]);
        setSelectedHouseholdId("");
        setSelectedUserId("");
        setPasswordResetEnabled(false);
        setError(t("login.error.statusCheckFailed"));
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
  }, [t, hasFnosGateway]);

  // Leaving the MMH card resets it to the default "sign in with an existing MMH
  // identity" shape, so switching local → MMH → local → MMH does not reopen on
  // the signup form the user abandoned.
  useEffect(() => {
    if (createAuthMode !== "mmh") setCreateMmhMode("login");
  }, [createAuthMode]);

  async function verifyLogin(params: { userId?: string; username?: string; password: string; householdId?: string; authMode?: "local" | "mmh" }) {
    const res = await fetch("/api/v1/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await res.json().catch(() => null) as AuthVerifyResponse | null
      : null;
    if (!data) {
      return {
        ok: false,
        error: res.ok ? t("login.error.responseInvalid") : t("login.error.apiStatus", { status: res.status }),
      };
    }
    if (!res.ok && !data.error) {
      return { ...data, error: t("login.error.failedStatus", { status: res.status }) };
    }
    return data;
  }

  /**
   * The central registration service answers in English with machine codes.
   * "no MMH user for this email" is the one people hit most often, and it needs
   * to point at the signup entry instead of reading like a hard failure.
   */
  function mmhErrorText(code: string | undefined, fallback: string | undefined, fallbackKey: string) {
    if (code === "PRINCIPAL_NOT_FOUND") return t("login.error.mmhAccountNotFound");
    return fallback ?? t(fallbackKey);
  }

  async function handleLogin() {
    const selectedUser = loginMode === "local" ? getSelectedLoginUser() : null;
    const selectedScopeId = loginMode === "local" && selectedHouseholdId && selectedHouseholdId !== SYSTEM_LOGIN_SCOPE_ID
      ? selectedHouseholdId
      : "";
    const trimmedUsername = (loginMode === "mmh" ? username : selectedUser?.name ?? username).trim();
    const trimmedPassword = password.trim();
    // A local account belongs to exactly one ledger, so the ledger has to be
    // chosen first. MMH sign-in carries its own account identity and resolves
    // the ledger server-side, so it must not be blocked by this check.
    if (loginMode === "local" && loginHouseholdChoices.length > 0 && !selectedHouseholdId) { setError(t("login.error.bookRequired")); return; }
    if (!trimmedUsername) { setError(t("login.error.usernameRequired")); return; }
    if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }

    setLoading(true);
    setError("");
    setHouseholdChoices([]);
    setPendingLogin(null);

    try {
      const data = await verifyLogin({
        ...(selectedUser ? { userId: selectedUser.id } : loginMode === "mmh" && loginCredentials.mmh.userId ? { userId: loginCredentials.mmh.userId } : {}),
        username: trimmedUsername,
        ...(selectedScopeId ? { householdId: selectedScopeId } : {}),
        password: trimmedPassword,
        authMode: loginMode === "mmh" ? "mmh" : "local",
      });
      if (data.ok) {
        window.location.href = withBasePath("/");
        return;
      }
      if (data.code === "AMBIGUOUS_USER" && data.households?.length) {
        setPendingLogin({ username: trimmedUsername, password: trimmedPassword, authMode: loginMode === "mmh" ? "mmh" : "local" });
        setHouseholdChoices(data.households);
        setError(data.error ?? t("login.error.ambiguousUser"));
        return;
      }
      setError(mmhErrorText(data.code, data.error, "login.error.loginFailed"));
    } catch {
      setError(t("login.error.verifyRetry"));
    } finally {
      setLoading(false);
    }
  }

  async function handleHouseholdChoice(householdId: string) {
    const credentials = pendingLogin ?? { username: username.trim(), password: password.trim() };
    if (!credentials.username) { setError(t("login.error.usernameRequired")); return; }
    if (!credentials.password) { setError(t("login.error.passwordRequired")); return; }

    setLoading(true);
    setError("");
    try {
      const data = await verifyLogin({ ...credentials, householdId, authMode: credentials.authMode ?? "local" });
      if (data.ok) {
        window.location.href = withBasePath("/");
        return;
      }
      setError(data.error ?? t("login.error.loginFailed"));
    } catch {
      setError(t("login.error.verifyRetry"));
    } finally {
      setLoading(false);
    }
  }

  function cancelHouseholdChoice() {
    setHouseholdChoices([]);
    setPendingLogin(null);
    setPendingFnos(false);
    setError("");
  }

  async function handleFnosLogin(householdId?: string) {
    // Resolved server-side from X-Trim-Userid. The ledger picker belongs to the
    // local/MMH tabs: forwarding its value here made a UID that is bound in
    // several ledgers fail with FNOS_USER_NOT_BOUND, merely because the form had
    // pre-selected a ledger that this UID happens not to be bound in. Only an
    // explicit pick (the AMBIGUOUS_USER card) carries a ledger.
    const scopeId = householdId ?? "";
    setLoading(true);
    setError("");
    setHouseholdChoices([]);
    setPendingFnos(false);
    try {
      const res = await fetch("/api/v1/auth/fnos-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(scopeId && scopeId !== SYSTEM_LOGIN_SCOPE_ID ? { householdId: scopeId } : {}),
          ...(fnosEmail.trim() ? { email: fnosEmail.trim() } : {}),
        }),
      });
      const contentType = res.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? await res.json().catch(() => null) as AuthVerifyResponse | null
        : null;
      if (!data) { setError(t("login.error.loginFailed")); return; }
      if (data.ok) { window.location.href = withBasePath("/"); return; }
      if (data.code === "AMBIGUOUS_USER" && data.households?.length) {
        setHouseholdChoices(data.households);
        setPendingFnos(true);
        setError(data.error ?? t("login.error.ambiguousUser"));
        return;
      }
      setError(data.error ?? t("login.error.loginFailed"));
    } catch {
      setError(t("login.error.verifyRetry"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateLedger() {
    const trimmedInviteCode = createInviteCode.trim();
    const trimmedLedgerName = createLedgerName.trim();
    const trimmedAdminName = createAdminName.trim();
    const trimmedAdminEmail = createAdminEmail.trim();
    const trimmedPassword = createPassword.trim();
    const trimmedConfirmPassword = createConfirmPassword.trim();
    const trimmedMmhPassword = createMmhPassword.trim();
    if (!initialLedgerSetup && createMethod === "invite" && !trimmedInviteCode) { setError(t("login.error.inviteRequired")); return; }
    if (!trimmedLedgerName) { setError(t("login.error.ledgerNameRequired")); return; }
    if (createMethod === "existing") {
      // Existing-account creation reuses the current login credentials below.
    } else if (createAuthMode === "local") {
      if (!trimmedAdminName) { setError(t("login.error.adminUsernameRequired")); return; }
      if (!initialLedgerSetup && !trimmedAdminEmail) { setError(t("login.error.adminEmailRequired")); return; }
      if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }
      if (trimmedPassword !== trimmedConfirmPassword) { setError(t("login.error.passwordMismatch")); return; }
    } else if (createAuthMode === "mmh") {
      // Signing in with an existing MMH identity: the email is the account and
      // the password is the MMH membership password, verified by the central
      // registration service on the server.
      if (!trimmedAdminEmail) { setError(t("login.error.adminEmailRequired")); return; }
      if (!trimmedMmhPassword) { setError(t("login.error.mmhPasswordRequired")); return; }
    }

    setLoading(true);
    setError("");
    try {
      if (createMethod === "existing") {
        const selectedExistingUser = createAuthMode === "mmh"
          ? mmhUserChoices.find((user) => user.id === createExistingUserId) ?? mmhUserChoices[0]
          : selectedHouseholdUsers.find((user) => user.id === createExistingUserId) ?? selectedHouseholdUsers[0];
        const credentials = createAuthMode === "mmh" ? loginCredentials.mmh : loginCredentials.local;
        const existingUsername = createAuthMode === "mmh"
          ? selectedExistingUser?.email ?? credentials.username
          : selectedExistingUser?.name ?? credentials.username;
        const existingUserId = selectedExistingUser?.id ?? credentials.userId;
        let adminName = selectedExistingUser?.name ?? existingUsername.trim();
        let adminEmail = selectedExistingUser?.email ?? undefined;
        let adminPassword: string | undefined;

        if (createAuthMode === "fnos") {
          if (!fnosGatewayUser?.uid) { setError(t("login.error.loginFailed")); return; }
          const fnosRes = await fetch("/api/v1/auth/fnos-verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const fnosData = await fnosRes.json().catch(() => null) as { ok: boolean; error?: string } | null;
          if (!fnosRes.ok || !fnosData?.ok) {
            setError(fnosData?.error ?? t("login.error.loginFailed"));
            return;
          }
          adminName = fnosGatewayUser.username ?? fnosGatewayUser.uid;
          adminPassword = undefined;
        } else {
          const existingPassword = createExistingPassword.trim() || credentials.password.trim();
          if (!existingUsername.trim()) { setError(t("login.error.usernameRequired")); return; }
          if (!existingPassword) { setError(t("login.error.passwordRequired")); return; }
          const verifyData = await verifyLogin({
            ...(createAuthMode === "local" && existingUserId ? { userId: existingUserId } : {}),
            username: existingUsername.trim(),
            password: existingPassword,
            // MMH accounts are verified against the central registration service
            // with the membership password, never against a local ledger hash.
            authMode: createAuthMode === "mmh" ? "mmh" : "local",
          });
          if (!verifyData.ok) {
            setError(mmhErrorText(verifyData.code, verifyData.error, "login.error.loginFailed"));
            return;
          }
          adminPassword = existingPassword;
        }

        const createRes = await fetch("/api/v1/households", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedLedgerName,
            adminName,
            adminEmail,
            ...(adminPassword ? { adminPassword } : {}),
            ...(createAuthMode === "fnos" ? { fnosUid: fnosGatewayUser?.uid } : {}),
          }),
        });
        const createData = await createRes.json().catch(() => null) as CreateLedgerResponse | null;
        if (!createRes.ok || !createData?.ok) {
          setError(createData?.error ?? t("login.error.createFailed"));
          return;
        }
      } else {
        const createRes = await fetch("/api/v1/auth/create-ledger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(initialLedgerSetup ? {} : { inviteCode: trimmedInviteCode }),
            name: trimmedLedgerName,
            authMode: createAuthMode,
            adminName: createAuthMode === "fnos"
              ? (fnosGatewayUser?.username ?? fnosGatewayUser?.uid ?? "admin")
              : createAuthMode === "mmh"
                ? (trimmedAdminName || trimmedAdminEmail.split("@")[0] || "admin")
                : trimmedAdminName,
            adminEmail: trimmedAdminEmail || undefined,
            // Only the local mode stores a ledger-local admin password. The MMH
            // mode authenticates an existing membership identity instead, and the
            // fnOS mode is vouched for by the gateway.
            adminPassword: createAuthMode === "local" ? trimmedPassword : "",
            ...(createAuthMode === "mmh" ? { mmhPassword: trimmedMmhPassword } : {}),
            ...(createAuthMode === "fnos" && fnosGatewayUser ? { fnosUid: fnosGatewayUser.uid } : {}),
          }),
        });
        const createData = await createRes.json().catch(() => null) as CreateLedgerResponse | null;
        if (!createRes.ok || !createData?.ok) {
          setError(mmhErrorText(createData?.code, createData?.error, "login.error.createFailed"));
          return;
        }
      }
      window.location.href = withBasePath("/");
    } catch {
      setError(t("login.error.createRetry"));
    } finally {
      setLoading(false);
    }
  }

  async function handleResetRequest(selectedHouseholdId = resetHouseholdId) {
    if (!resetUsername.trim()) { setResetError(t("login.error.usernameRequired")); return; }
    if (!resetEmail.trim()) { setResetError(t("login.reset.emailRequired")); return; }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: resetUsername.trim(),
          email: resetEmail.trim(),
          ...(selectedHouseholdId ? { householdId: selectedHouseholdId } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as AuthVerifyResponse | null;
      if (!data?.ok) {
        if (data?.code === "AMBIGUOUS_USER" && data.households?.length) {
          setResetHouseholdChoices(data.households);
          setResetError(data.error ?? t("login.reset.ambiguousUserEmail"));
          return;
        }
        setResetError(data?.error ?? t("login.reset.sendFailed"));
        return;
      }
      setResetHouseholdId(data.householdId ?? selectedHouseholdId ?? "");
      setResetHouseholdChoices([]);
      if (previewOnly) {
        setResetEmailHint(data.maskedEmailHint ?? "");
        setResetInfo(data.message ?? t("login.reset.completeEmail"));
        return;
      }
      setResetInfo(data.message ?? t("login.reset.codeSent"));
      setResetStep("confirm");
    } catch {
      setResetError(t("login.reset.sendRetry"));
    } finally {
      setResetLoading(false);
    }
  }

  async function handleResetConfirm(selectedHouseholdId = resetHouseholdId) {
    if (!resetUsername.trim()) { setResetError(t("login.error.usernameRequired")); return; }
    if (!resetCode.trim()) { setResetError(t("login.reset.codeRequired")); return; }
    if (!resetNewPassword.trim()) { setResetError(t("login.reset.newPasswordRequired")); return; }
    if (resetNewPassword.trim() !== resetConfirmPassword.trim()) {
      setResetError(t("login.error.passwordMismatch"));
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
          setResetError(data.error ?? t("login.reset.ambiguousCode"));
          return;
        }
        setResetError(data?.error ?? t("login.reset.failed"));
        return;
      }
      setResetInfo(t("login.reset.done"));
      setResetStep("request");
      setShowReset(false);
      setResetHouseholdId("");
      setResetHouseholdChoices([]);
      setPassword(resetNewPassword.trim());
      setUsername(resetUsername.trim());
    } catch {
      setResetError(t("login.reset.retry"));
    } finally {
      setResetLoading(false);
    }
  }

  async function handleRegisterSendCode(inviteMode = registerInviteMode) {
    const email = registerEmail.trim();
    if (!email) { setRegisterError(t("login.register.error.emailRequired")); return; }
    if (inviteMode && !createInviteCode.trim()) { setRegisterError(t("login.error.inviteRequired")); return; }
    if (inviteMode && !createLedgerName.trim()) { setRegisterError(t("login.error.ledgerNameRequired")); return; }

    setRegisterLoading(true);
    setRegisterError("");
    setRegisterInfo("");
    try {
      const res = await fetch("/api/v1/auth/register/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          ...(inviteMode ? { inviteCode: createInviteCode.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok: boolean; code?: string; error?: string } | null;
      if (!data?.ok) {
        setRegisterError(
          data?.code === "DUPLICATE_EMAIL"
            ? t("login.register.error.emailTaken")
            : data?.error ?? t("login.register.error.sendFailed"),
        );
        return;
      }
      setRegisterCodeSent(true);
      setRegisterInfo(t("login.register.codeSent", { email }));
    } catch {
      setRegisterError(t("login.register.error.sendFailed"));
    } finally {
      setRegisterLoading(false);
    }
  }

  async function handleRegisterConfirm(inviteMode = registerInviteMode) {
    const email = registerEmail.trim();
    const code = registerCode.trim();
    const password = registerPassword.trim();
    const mmhPassword = registerMmhPassword.trim();
    if (!email) { setRegisterError(t("login.register.error.emailRequired")); return; }
    if (!code) { setRegisterError(t("login.register.error.codeRequired")); return; }
    if (password.length < 6) { setRegisterError(t("login.register.error.passwordRequired")); return; }
    if (mmhPassword.length < 6) { setRegisterError(t("login.register.error.mmhPasswordRequired")); return; }
    if (inviteMode && !createInviteCode.trim()) { setRegisterError(t("login.error.inviteRequired")); return; }
    if (inviteMode && !createLedgerName.trim()) { setRegisterError(t("login.error.ledgerNameRequired")); return; }

    setRegisterLoading(true);
    setRegisterError("");
    setRegisterInfo("");
    try {
      const res = await fetch("/api/v1/auth/register/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          code,
          password,
          mmhPassword,
          ...(registerName.trim() ? { name: registerName.trim() } : {}),
          ...(inviteMode
            ? { inviteCode: createInviteCode.trim(), ledgerName: createLedgerName.trim() }
            : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok: boolean; code?: string; error?: string } | null;
      if (!data?.ok) {
        setRegisterError(
          data?.code === "INVALID_OR_EXPIRED_CODE"
            ? t("login.register.error.invalidCode")
            : data?.code === "DUPLICATE_EMAIL"
              ? t("login.register.error.emailTaken")
              : data?.error ?? t("login.register.error.failed"),
        );
        return;
      }
      window.location.href = withBasePath("/");
    } catch {
      setRegisterError(t("login.register.error.failed"));
    } finally {
      setRegisterLoading(false);
    }
  }

  async function handleMmhResetSendCode() {
    const email = mmhResetEmail.trim();
    if (!email) { setMmhResetError(t("login.register.error.emailRequired")); return; }
    setMmhResetLoading(true);
    setMmhResetError("");
    setMmhResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/mmh-password-reset/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null) as { ok: boolean; code?: string; error?: string } | null;
      if (!data?.ok) {
        setMmhResetError(data?.error ?? t("login.register.error.sendFailed"));
        return;
      }
      setMmhResetCodeSent(true);
      setMmhResetInfo(t("login.register.codeSent", { email }));
    } catch {
      setMmhResetError(t("login.register.error.sendFailed"));
    } finally {
      setMmhResetLoading(false);
    }
  }

  async function handleMmhResetConfirm() {
    const email = mmhResetEmail.trim();
    const code = mmhResetCode.trim();
    const newPassword = mmhResetNewPassword.trim();
    const confirmPassword = mmhResetConfirmPassword.trim();
    if (!email) { setMmhResetError(t("login.register.error.emailRequired")); return; }
    if (!code) { setMmhResetError(t("login.register.error.codeRequired")); return; }
    if (newPassword.length < 8) { setMmhResetError(t("login.mmhReset.error.passwordTooShort")); return; }
    if (newPassword !== confirmPassword) { setMmhResetError(t("login.error.passwordMismatch")); return; }

    setMmhResetLoading(true);
    setMmhResetError("");
    setMmhResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/mmh-password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, newPassword }),
      });
      const data = await res.json().catch(() => null) as { ok: boolean; code?: string; error?: string } | null;
      if (!data?.ok) {
        setMmhResetError(
          data?.code === "INVALID_OR_EXPIRED_CODE"
            ? t("login.register.error.invalidCode")
            : data?.error ?? t("login.mmhReset.error.failed"),
        );
        return;
      }
      setMmhResetInfo(t("login.mmhReset.success"));
      setShowMmhReset(false);
      setMmhResetEmail("");
      setMmhResetCode("");
      setMmhResetNewPassword("");
      setMmhResetConfirmPassword("");
      setMmhResetCodeSent(false);
    } catch {
      setMmhResetError(t("login.mmhReset.error.failed"));
    } finally {
      setMmhResetLoading(false);
    }
  }

  /**
   * The MMH block inside the ledger-creation form.
   *
   * Two shapes, mirroring how an MMH identity actually works: the account is
   * global and may already exist, so the default is "sign in with it" — email +
   * membership password, verified server-side against the central registration
   * service. Only someone who does not have one yet opts into the signup shape
   * through the secondary "create an MMH user" link.
   */
  function renderMmhCreateFields(inviteMode: boolean) {
    if (createMmhMode === "register") {
      return (
        <div className="space-y-3 border-t border-slate-200 pt-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-600">{t("login.register.email")}</div>
            <input
              value={registerEmail}
              onChange={(event) => {
                setRegisterEmail(event.target.value);
                setRegisterCodeSent(false);
                setRegisterCode("");
                setRegisterError("");
                setRegisterInfo("");
              }}
              type="email"
              autoComplete="email"
              className={LOGIN_INPUT_CLASS}
              placeholder={t("login.register.emailPlaceholder")}
            />
          </div>
          {registerCodeSent && (
            <>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("login.register.code")}</div>
                <input value={registerCode} onChange={(event) => setRegisterCode(event.target.value)} type="text" autoComplete="one-time-code" className={LOGIN_INPUT_CLASS} placeholder={t("login.register.codePlaceholder")} />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("login.register.password")}</div>
                <input value={registerPassword} onChange={(event) => setRegisterPassword(event.target.value)} type="password" autoComplete="new-password" className={LOGIN_INPUT_CLASS} placeholder={t("login.passwordPlaceholder")} />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("login.register.mmhPassword")}</div>
                <input value={registerMmhPassword} onChange={(event) => setRegisterMmhPassword(event.target.value)} type="password" autoComplete="new-password" className={LOGIN_INPUT_CLASS} placeholder={t("login.register.mmhPasswordPlaceholder")} />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("login.register.name")}</div>
                <input value={registerName} onChange={(event) => setRegisterName(event.target.value)} type="text" autoComplete="username" className={LOGIN_INPUT_CLASS} placeholder={t("login.register.namePlaceholder")} />
              </div>
            </>
          )}
          {registerInfo && <div className="text-xs text-slate-600">{registerInfo}</div>}
          {registerError && <div className="text-xs text-red-600">{registerError}</div>}
          {!registerCodeSent ? (
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={registerLoading}
              onClick={() => { setRegisterInviteMode(inviteMode); void handleRegisterSendCode(inviteMode); }}
            >
              {registerLoading ? t("login.verifying") : t("login.register.sendCode")}
            </button>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={registerLoading}
                onClick={() => { setRegisterInviteMode(inviteMode); void handleRegisterConfirm(inviteMode); }}
              >
                {registerLoading ? t("login.register.submitting") : t("login.register.submitCreate")}
              </button>
              <button
                type="button"
                className="h-10 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={registerLoading}
                onClick={() => { setRegisterInviteMode(inviteMode); void handleRegisterSendCode(inviteMode); }}
              >
                {t("login.register.resend")}
              </button>
            </div>
          )}
          <button
            type="button"
            className="w-full text-xs text-slate-500 hover:text-slate-700"
            onClick={() => { setCreateMmhMode("login"); setRegisterError(""); setRegisterInfo(""); }}
          >
            {t("login.backToMmhLogin")}
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-3 border-t border-slate-200 pt-3">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">{t("login.mmhAccount")}</div>
          <input
            value={createAdminEmail}
            onChange={(event) => setCreateAdminEmail(event.target.value)}
            type="email"
            autoComplete="email"
            className={LOGIN_INPUT_CLASS}
            placeholder={t("login.mmhAccountPlaceholder")}
          />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">{t("login.mmhPassword")}</div>
          <input
            value={createMmhPassword}
            onChange={(event) => setCreateMmhPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            className={LOGIN_INPUT_CLASS}
            placeholder={t("login.mmhPasswordPlaceholder")}
            onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }}
          />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">{t("login.register.name")}</div>
          <input
            value={createAdminName}
            onChange={(event) => setCreateAdminName(event.target.value)}
            type="text"
            autoComplete="username"
            className={LOGIN_INPUT_CLASS}
            placeholder={t("login.register.namePlaceholder")}
          />
        </div>
        <button
          type="button"
          className="w-full text-xs text-slate-500 hover:text-slate-700"
          onClick={() => setCreateMmhMode("register")}
        >
          {t("login.createMmhUser")}
        </button>
      </div>
    );
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
      <div className="grid h-[min(46rem,calc(100vh-2rem))] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/16 bg-white/92 shadow-[0_24px_80px_rgba(15,23,42,0.34)] backdrop-blur-xl lg:grid-cols-[minmax(0,1fr)_390px]">
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
            <div className="mt-6 grid grid-cols-3 gap-2">
              {productIntro.highlights.map((item) => (
                <span key={item} className="rounded-lg border border-white/12 bg-white/[0.08] px-2 py-2 text-center text-[11px] leading-4 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm">
                  {item}
                </span>
              ))}
            </div>
          </div>
        </section>

        <div className="flex min-h-0 min-w-0 flex-col">
        <div className="shrink-0 border-b border-slate-200/70 bg-white/72 px-6 py-5 shadow-[inset_0_-1px_0_rgba(148,163,184,0.14)] backdrop-blur">
          {householdName && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("login.book")}</div>}
          <div className="flex items-center">
            <div className="flex min-w-0 items-center gap-2">
              <MmhLogo size={40} />
              <div className="min-w-0">
                <div className="truncate text-base font-semibold text-slate-800">{householdName ? currentHouseholdDisplayName : "MoneyMoneyHome"}</div>
                {!householdName && <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-400">{t("login.productTagline")}</div>}
              </div>
            </div>
          </div>
          {mode === "login" && <div className="mt-1 text-xs text-slate-500">{t("login.continueHint")}</div>}
          {mode === "create" && (
            <div className="mt-1 text-xs text-slate-500">
              {initialLedgerSetup ? t("login.initialCreateHint") : t("login.createHint")}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "login" && (
          <div className="space-y-4 p-6">
            {/* The ledger picker is for local / MMH sign-in. The fnOS tab resolves
                its ledger from the gateway UID server-side, so showing it there
                only invited a choice that could not help (and could mislead). */}
            {!showReset && loginMode !== "fnos" && loginHouseholdChoices.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("login.book")}</div>
                <select
                  value={selectedHouseholdId}
                  onChange={(event) => selectLoginHousehold(event.target.value)}
                  className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                  autoFocus
                >
                  {loginHouseholdChoices.map((household) => (
                    <option key={household.id} value={household.id}>{household.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* 登录方式 = 文件卡片页签；卡片内容 = 用户名 / 密码 / 忘记密码 / 进入账簿 */}
            {/* 重置密码是登录表单的子态：此时收起页签条，也不再留出 pt-10 的页签高度，
                否则点了页签看起来毫无反应（switchLoginMode 不改 showReset）。 */}
            <div className={showReset ? "relative" : "relative pt-10"}>
              {!showReset && (
              <div className={FOLDER_TAB_STRIP}>
                <button
                  type="button"
                  onClick={() => switchLoginMode("local")}
                  className={folderTabClass(loginMode === "local", loginTabOrder.indexOf("local") === loginTabOrder.length - 1)}
                >
                  {t("login.mode.local")}
                </button>
                <button
                  type="button"
                  onClick={() => switchLoginMode("mmh")}
                  className={folderTabClass(loginMode === "mmh", loginTabOrder.indexOf("mmh") === loginTabOrder.length - 1)}
                >
                  {t("login.mode.mmh")}
                </button>
                {fnosGatewayUser ? (
                  <button
                    type="button"
                    onClick={() => switchLoginMode("fnos")}
                    className={folderTabClass(loginMode === "fnos", loginTabOrder.indexOf("fnos") === loginTabOrder.length - 1)}
                  >
                    {t("login.fnosLogin")}
                  </button>
                ) : null}
              </div>
              )}

              <div className={`${folderTabPanelClass(loginTabOrder.indexOf(loginMode), loginTabOrder.length)} space-y-4`}>
                {!showReset && (
                  <form
                    id="mmh-login-form"
                    action={withBasePath("/login")}
                    method="post"
                    className="space-y-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (loginMode === "fnos") void handleFnosLogin();
                      else void handleLogin();
                    }}
                  >
                {loginMode === "fnos" && fnosGatewayUser ? (
                <div className="space-y-3">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {t("login.fnosUser", { user: fnosGatewayUser.username ?? fnosGatewayUser.uid })}
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("login.fnosEmailOptional")}</div>
                    <input
                      value={fnosEmail}
                      onChange={(event) => {
                        setFnosEmail(event.target.value);
                        cancelHouseholdChoice();
                      }}
                      type="email"
                      autoComplete="email"
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      placeholder={t("login.fnosEmailPlaceholder")}
                    />
                    <div className="text-[11px] text-slate-500">{t("login.fnosEmailHint")}</div>
                  </div>
                </div>
                ) : loginMode === "local" ? (
                <div className="space-y-1">
                  {selectedHouseholdUsers.length > 0 ? (
                    <select
                      id="login-username"
                      name="username"
                      value={selectedUserId}
                      onChange={(event) => {
                        const user = selectedHouseholdUsers.find((item) => item.id === event.target.value);
                        setSelectedUserId(user?.id ?? "");
                        setUsername(user?.name ?? "");
                        setLoginCredentials((current) => ({
                          ...current,
                          local: { ...current.local, username: user?.name ?? "", userId: user?.id ?? "" },
                        }));
                        cancelHouseholdChoice();
                      }}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {selectedHouseholdUsers.map((user) => (
                        <option key={user.id} value={user.id}>{getLoginUserLabel(user)}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-3">
                      <div className="text-sm font-semibold text-slate-800">{t("login.noLocalUsersTitle")}</div>
                      <div className="text-xs leading-5 text-slate-600">{t("login.noLocalUsers")}</div>
                    </div>
                  )}
                </div>
                ) : (
                <div className="space-y-1">
                  {mmhUserChoices.length > 0 ? (
                    <select
                      id="login-username"
                      name="username"
                      autoComplete="username"
                      value={loginCredentials.mmh.userId || ""}
                      onChange={(event) => selectMmhUser(event.target.value)}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {mmhUserChoices.map((user) => (
                        <option key={user.id} value={user.id}>{getMmhUserLabel(user)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="login-username"
                      name="username"
                      value={username}
                      onChange={(event) => {
                        setSelectedUserId("");
                        setUsername(event.target.value);
                        updateLoginCredentialField("username", event.target.value);
                        cancelHouseholdChoice();
                      }}
                      type="email"
                      autoComplete="username"
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      placeholder={t("login.mmhAccountPlaceholder")}
                    />
                  )}
                </div>
                )}

                {/* No password field when the ledger has no local account at all:
                    showing one invited people to type a password that could never
                    be checked. The block above already explains what to do. */}
                {loginMode !== "fnos" && !localTabUnavailable && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
                    <input
                      id="login-password"
                      name="password"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        updateLoginCredentialField("password", event.target.value);
                        cancelHouseholdChoice();
                      }}
                    type="password"
                    autoComplete="current-password"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={loginMode === "mmh" ? t("login.mmhPasswordPlaceholder") : t("login.passwordPlaceholder")}
                    autoFocus={loginHouseholdChoices.length === 0}
                  />
                </div>
                )}

                {loginMode === "mmh" && (
                  <button
                    type="button"
                    className="text-xs text-slate-500 hover:text-slate-700"
                    disabled={loading || mmhResetLoading}
                    onClick={() => {
                      if (showMmhReset) {
                        setShowMmhReset(false);
                        setMmhResetError("");
                        setMmhResetInfo("");
                        return;
                      }
                      setShowMmhReset(true);
                      setShowReset(false);
                    }}
                  >
                    {showMmhReset ? t("common.collapse") : t("login.mmhReset.forgot")}
                  </button>
                )}

                {householdChoices.length > 0 && (
                  <div className="space-y-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{t("login.chooseBook")}</div>
                      <div className="mt-1 text-xs text-slate-500">{t("login.ambiguousBookHint")}</div>
                    </div>
                    <div className="space-y-2">
                      {householdChoices.map((household) => (
                        <button
                          key={household.id}
                          type="button"
                          className="w-full rounded-lg border border-blue-100 bg-white px-3 py-2 text-left text-sm text-slate-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50"
                          disabled={loading}
                          onClick={() => { if (pendingFnos) void handleFnosLogin(household.id); else void handleHouseholdChoice(household.id); }}
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
                      {t("login.reenterUsername")}
                    </button>
                  </div>
                )}

                {error && <div className="text-sm text-red-600">{error}</div>}
                {loginMode === "fnos" ? (
                  <button
                    type="submit"
                    className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={loading}
                  >
                    {loading ? t("login.verifying") : t("login.fnosEnter")}
                  </button>
                ) : localTabUnavailable ? null : (
                  <button
                    type="submit"
                    className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={loading}
                  >
                    {loading ? t("login.verifying") : t("login.enter")}
                  </button>
                )}
                </form>
              )}

            {showMmhReset && (
              <div className="space-y-3">
                <div className="text-xs font-medium text-slate-600">{t("login.mmhReset.title")}</div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.register.email")}</div>
                  <input
                    value={mmhResetEmail}
                    onChange={(event) => { setMmhResetEmail(event.target.value); setMmhResetCodeSent(false); setMmhResetCode(""); setMmhResetError(""); setMmhResetInfo(""); }}
                    type="email"
                    autoComplete="email"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.register.emailPlaceholder")}
                  />
                </div>
                {mmhResetCodeSent && (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.register.code")}</div>
                      <input value={mmhResetCode} onChange={(event) => setMmhResetCode(event.target.value)} type="text" autoComplete="one-time-code" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" placeholder={t("login.register.codePlaceholder")} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.mmhReset.newPassword")}</div>
                      <input value={mmhResetNewPassword} onChange={(event) => setMmhResetNewPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" placeholder={t("login.passwordPlaceholder")} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div>
                      <input value={mmhResetConfirmPassword} onChange={(event) => setMmhResetConfirmPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" placeholder={t("login.confirmPassword")} />
                    </div>
                  </>
                )}
                {mmhResetInfo && <div className="text-xs text-slate-600">{mmhResetInfo}</div>}
                {mmhResetError && <div className="text-xs text-red-600">{mmhResetError}</div>}
                {!mmhResetCodeSent ? (
                  <button type="button" className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={mmhResetLoading} onClick={() => void handleMmhResetSendCode()}>
                    {mmhResetLoading ? t("login.verifying") : t("login.register.sendCode")}
                  </button>
                ) : (
                  <button type="button" className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={mmhResetLoading} onClick={() => void handleMmhResetConfirm()}>
                    {mmhResetLoading ? t("login.register.submitting") : t("login.mmhReset.submit")}
                  </button>
                )}
              </div>
            )}

            {showReset && (
              <div className="space-y-3">
                <div className="text-xs font-medium text-slate-600">{t("login.reset.title")}</div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
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
                    placeholder={t("login.usernamePlaceholder")}
                  />
                </div>
                {resetStep === "request" && (
                  resetEmailHint ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.emailLabel")}</div>
                      <div className="text-[11px] text-slate-500">{t("login.reset.emailHint", { hint: resetEmailHint })}</div>
                      <input
                        value={resetEmail}
                        onChange={(event) => {
                          setResetEmail(event.target.value);
                          setResetHouseholdChoices([]);
                        }}
                        type="email"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.emailPlaceholder")}
                      />
                    </div>
                  ) : null
                )}
                {resetStep === "confirm" && (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.code")}</div>
                      <input
                        value={resetCode}
                        onChange={(event) => setResetCode(event.target.value)}
                        type="text"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.codePlaceholder")}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.newPassword")}</div>
                      <input
                        value={resetNewPassword}
                        onChange={(event) => setResetNewPassword(event.target.value)}
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.newPasswordPlaceholder")}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.reset.confirmNewPassword")}</div>
                      <input
                        value={resetConfirmPassword}
                        onChange={(event) => setResetConfirmPassword(event.target.value)}
                        type="password"
                        className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.reset.confirmNewPasswordPlaceholder")}
                      />
                    </div>
                  </>
                )}
                {resetHouseholdChoices.length > 0 && (
                  <div className="space-y-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3">
                    <div className="text-xs text-slate-500">{t("login.reset.chooseBookHint")}</div>
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
                      {resetLoading ? t("login.reset.processing") : resetEmailHint ? t("login.reset.sendCode") : t("login.reset.nextStep")}
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
                        {t("login.reenterUsername")}
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
                      {resetLoading ? t("login.reset.submitting") : t("login.reset.resetPassword")}
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
                      {t("login.reset.backStep")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 忘记密码 / 收起：始终排在卡片内容之后。
                重置态下若留在表单上方，会被卡片顶边衬成「卡片标题」，观感突兀。
                账簿没有本地账户时也没有可找回的本地密码，一并收起。 */}
            {!localTabUnavailable && (
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
            )}
              </div>
            </div>
          </div>
        )}

        {mode === "create" && (
          <div className="space-y-4 p-6">
            {!initialLedgerSetup && (
              <div className="relative pt-10">
                <div className={FOLDER_TAB_STRIP}>
                  <button
                    type="button"
                    onClick={() => setCreateMethod("invite")}
                    className={folderTabClass(createMethod === "invite", false, "min")}
                  >
                    邀请码创建
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateMethod("existing")}
                    className={folderTabClass(createMethod === "existing", true, "min")}
                  >
                    已有用户验证
                  </button>
                </div>
                <div className={`${folderTabPanelClass(createMethod === "invite" ? 0 : 1, 2)} space-y-4`}>
                {createMethod === "invite" ? (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.inviteCode")}</div>
                      <input
                        value={createInviteCode}
                        onChange={(event) => setCreateInviteCode(event.target.value)}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 font-mono text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                        placeholder={t("login.invitePlaceholder")}
                        autoFocus
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.ledgerName")}</div>
                      <input
                        value={createLedgerName}
                        onChange={(event) => setCreateLedgerName(event.target.value)}
                        type="text"
                        autoComplete="organization"
                        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.ledgerNamePlaceholder")}
                      />
                    </div>
                    <div className="space-y-3 border-t border-slate-200 pt-3">
                      <div className="text-xs font-medium text-slate-600">{t("login.createUser")}</div>
                      <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
                        <button type="button" onClick={() => setCreateAuthMode("local")} className={createAuthMode === "local" ? "flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-2 py-1.5 text-xs text-slate-500"}>{t("login.mode.local")}</button>
                        <button type="button" onClick={() => setCreateAuthMode("mmh")} className={createAuthMode === "mmh" ? "flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-2 py-1.5 text-xs text-slate-500"}>{t("login.mode.mmh")}</button>
                        {fnosGatewayUser ? <button type="button" onClick={() => setCreateAuthMode("fnos")} className={createAuthMode === "fnos" ? "flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-2 py-1.5 text-xs text-slate-500"}>{t("login.authModeFnos")}</button> : null}
                      </div>
                      {createAuthMode === "fnos" ? (
                        <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                          {t("login.fnosUser", { user: fnosGatewayUser?.username ?? fnosGatewayUser?.uid ?? "" })}
                        </div>
                      ) : createAuthMode === "mmh" ? (
                        renderMmhCreateFields(true)
                      ) : (
                        <div className="space-y-3 border-t border-slate-200 pt-3">
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">{t("login.adminUsername")}</div>
                            <input value={createAdminName} onChange={(event) => setCreateAdminName(event.target.value)} type="text" autoComplete="username" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.adminUsernamePlaceholder")} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">{initialLedgerSetup ? t("login.adminEmailOptional") : t("login.adminEmail")}</div>
                            <input value={createAdminEmail} onChange={(event) => setCreateAdminEmail(event.target.value)} type="email" autoComplete="email" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.adminEmailPlaceholder")} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
                            <input value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.passwordPlaceholder")} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div>
                            <input value={createConfirmPassword} onChange={(event) => setCreateConfirmPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.confirmPassword")} onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }} />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.ledgerName")}</div>
                      <input
                        value={createLedgerName}
                        onChange={(event) => setCreateLedgerName(event.target.value)}
                        type="text"
                        autoComplete="organization"
                        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        placeholder={t("login.ledgerNamePlaceholder")}
                      />
                    </div>
                    <div className="space-y-3 border-t border-slate-200 pt-3">
                      <div className="text-xs text-slate-500">使用已有账户验证创建权限。</div>
                    <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
                      <button
                        type="button"
                        onClick={() => {
                          const user = selectedHouseholdUsers[0];
                          setCreateAuthMode("local");
                          setCreateExistingUserId(user?.id ?? "");
                        }}
                        className={createAuthMode === "local" ? "flex-1 rounded-md bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-3 py-1.5 text-xs text-slate-500"}
                      >
                        {t("login.mode.local")}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setCreateAuthMode("mmh"); setCreateExistingUserId(mmhUserChoices[0]?.id ?? ""); }}
                        className={createAuthMode === "mmh" ? "flex-1 rounded-md bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-3 py-1.5 text-xs text-slate-500"}
                      >
                        {t("login.mode.mmh")}
                      </button>
                      {fnosGatewayUser ? (
                        <button
                          type="button"
                          onClick={() => setCreateAuthMode("fnos")}
                          className={createAuthMode === "fnos" ? "flex-1 rounded-md bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-3 py-1.5 text-xs text-slate-500"}
                        >
                          {t("login.authModeFnos")}
                        </button>
                      ) : null}
                    </div>
                    {createAuthMode === "fnos" ? (
                      <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                        {t("login.fnosUser", { user: fnosGatewayUser?.username ?? fnosGatewayUser?.uid ?? "" })}
                      </div>
                    ) : createAuthMode === "mmh" && mmhUserChoices.length > 0 ? (
                      <select
                        value={createExistingUserId}
                        onChange={(event) => {
                          const user = mmhUserChoices.find((item) => item.id === event.target.value);
                          setCreateExistingUserId(user?.id ?? "");
                        }}
                        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      >
                        {mmhUserChoices.map((user) => (
                          <option key={user.id} value={user.id}>{getMmhUserLabel(user)}</option>
                        ))}
                      </select>
                    ) : createAuthMode === "local" && selectedHouseholdUsers.length > 0 ? (
                      <select
                        value={createExistingUserId}
                        onChange={(event) => {
                          const user = selectedHouseholdUsers.find((item) => item.id === event.target.value);
                          setCreateExistingUserId(user?.id ?? "");
                        }}
                        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      >
                        {selectedHouseholdUsers.map((user) => (
                          <option key={user.id} value={user.id}>{getLoginUserLabel(user)}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                        当前登录账户
                      </div>
                    )}
                    {createAuthMode !== "fnos" && (
                      <div className="space-y-1 border-t border-slate-200 pt-3">
                        <div className="text-xs font-medium text-slate-600">验证密码</div>
                        <input
                          value={createExistingPassword}
                          onChange={(event) => setCreateExistingPassword(event.target.value)}
                          type="password"
                          autoComplete="current-password"
                          className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                          placeholder={t("login.passwordPlaceholder")}
                          onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }}
                        />
                      </div>
                    )}
                  </div>
                </>
                )}
              </div>
              </div>
            )}
            {initialLedgerSetup ? (
              <>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.ledgerName")}</div>
                  <input
                    value={createLedgerName}
                    onChange={(event) => setCreateLedgerName(event.target.value)}
                    type="text"
                    autoComplete="organization"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.ledgerNamePlaceholder")}
                    autoFocus
                  />
                </div>
                <div className="space-y-3 border-t border-slate-200 pt-3">
                  <div className="text-xs font-medium text-slate-600">{t("login.createUser")}</div>
                  <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
                    <button type="button" onClick={() => setCreateAuthMode("local")} className={createAuthMode === "local" ? "flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-2 py-1.5 text-xs text-slate-500"}>{t("login.mode.local")}</button>
                    <button type="button" onClick={() => setCreateAuthMode("mmh")} className={createAuthMode === "mmh" ? "flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-2 py-1.5 text-xs text-slate-500"}>{t("login.mode.mmh")}</button>
                    {fnosGatewayUser ? <button type="button" onClick={() => setCreateAuthMode("fnos")} className={createAuthMode === "fnos" ? "flex-1 rounded-md bg-slate-100 px-2 py-1.5 text-xs font-medium text-slate-800" : "flex-1 rounded-md px-2 py-1.5 text-xs text-slate-500"}>{t("login.authModeFnos")}</button> : null}
                  </div>
                </div>
                {createAuthMode === "fnos" ? (
                  <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                    {t("login.fnosUser", { user: fnosGatewayUser?.username ?? fnosGatewayUser?.uid ?? "" })}
                  </div>
                ) : createAuthMode === "mmh" ? (
                  renderMmhCreateFields(false)
                ) : (
                  <div className="space-y-3 border-t border-slate-200 pt-3">
                    <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.adminUsername")}</div><input value={createAdminName} onChange={(event) => setCreateAdminName(event.target.value)} type="text" autoComplete="username" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.adminUsernamePlaceholder")} /></div>
                    <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.adminEmailOptional")}</div><input value={createAdminEmail} onChange={(event) => setCreateAdminEmail(event.target.value)} type="email" autoComplete="email" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.adminEmailPlaceholder")} /></div>
                    <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.password")}</div><input value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.passwordPlaceholder")} /></div>
                    <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div><input value={createConfirmPassword} onChange={(event) => setCreateConfirmPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.confirmPassword")} onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }} /></div>
                  </div>
                )}
              </>
            ) : createMethod === "existing" ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                新账簿管理员将使用当前验证账户：{createAuthMode === "mmh" ? (mmhUserChoices.find((user) => user.id === createExistingUserId)?.email ?? loginCredentials.mmh.username) : createAuthMode === "fnos" ? (fnosGatewayUser?.username ?? fnosGatewayUser?.uid ?? "") : (selectedHouseholdUsers.find((user) => user.id === createExistingUserId)?.name ?? loginCredentials.local.username)}
              </div>
            ) : null}
            {error && <div className="text-sm text-red-600">{error}</div>}
            {/* The MMH signup shape owns its own submit button ("register and
                create the ledger"); every other shape submits the form here. */}
            {!(createMethod === "invite" && createAuthMode === "mmh" && createMmhMode === "register") && (
              <button
                type="button"
                className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={loading || registerLoading}
                onClick={() => void handleCreateLedger()}
              >
                {loading ? t("login.creating") : t("login.createAndEnter")}
              </button>
            )}
            {!initialLedgerSetup && (
              <button
                type="button"
                className="h-10 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                disabled={loading}
                onClick={() => {
                  setError("");
                  setResetError("");
                  setResetInfo("");
                  setShowReset(false);
                  resetCreateLedgerForm();
                  setRegisterInviteMode(false);
                  setRegisterEmail("");
                  setRegisterCode("");
                  setRegisterCodeSent(false);
                  setRegisterPassword("");
                  setRegisterMmhPassword("");
                  setRegisterName("");
                  setRegisterInfo("");
                  setRegisterError("");
                  setMode("login");
                }}
              >
                {t("login.backToLogin")}
              </button>
            )}
          </div>
        )}

        {mode === "login" && !showReset && (
          <div className="px-6 pb-6 -mt-2 space-y-2">
            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              disabled={loading}
              onClick={() => {
                setError("");
                setResetError("");
                setResetInfo("");
                setShowReset(false);
                resetCreateLedgerForm();
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
    </div>
  );
}
