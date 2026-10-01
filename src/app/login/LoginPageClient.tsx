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
  maskedEmailHint?: string | null;
};

type PasswordStatusResponse = {
  ok: boolean;
  hasPassword: boolean;
  needsInitialLedgerSetup?: boolean;
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
type LoginMode = "login" | "setup" | "create";

const SYSTEM_LOGIN_SCOPE_ID = "__system__";

function getLoginUserScopeId(user: LoginUserChoice) {
  return user.householdId ?? SYSTEM_LOGIN_SCOPE_ID;
}

function getInitialLoginSelection(users: LoginUserChoice[]) {
  const firstUser = users.find((user) => !!user.householdId) ?? users[0] ?? null;
  return {
    scopeId: firstUser ? getLoginUserScopeId(firstUser) : "",
    user: firstUser,
  };
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
  const [pendingLogin, setPendingLogin] = useState<{ username: string; password: string } | null>(null);
  const [initialLedgerSetup, setInitialLedgerSetup] = useState(false);

  const [setupUsername, setSetupUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [createMethod, setCreateMethod] = useState<"invite" | "existing">("invite");
  const [createAuthMode, setCreateAuthMode] = useState<"local" | "mmh" | "fnos">("local");
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
    setCreateAuthMode("local");
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
  const [resetEmailHint, setResetEmailHint] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetConfirmPassword, setResetConfirmPassword] = useState("");
  const [resetInfo, setResetInfo] = useState("");
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetHouseholdId, setResetHouseholdId] = useState("");
  const [resetHouseholdChoices, setResetHouseholdChoices] = useState<HouseholdChoice[]>([]);

  const [showRegister, setShowRegister] = useState(false);
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerCodeSent, setRegisterCodeSent] = useState(false);
  const [registerCode, setRegisterCode] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerName, setRegisterName] = useState("");
  const [registerInfo, setRegisterInfo] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerInviteMode, setRegisterInviteMode] = useState(false);
  const { t } = useI18n();
  const currentHouseholdDisplayName = getHouseholdDisplayName({ name: householdName }, t("login.defaultBook"));
  const productIntro = getProductIntro(t);
  const loginHouseholdChoices = getLoginHouseholdChoices();
  const selectedHouseholdUsers = selectedHouseholdId
    ? systemUsers.filter((user) => getLoginUserScopeId(user) === selectedHouseholdId)
    : [];
  const mmhUserChoices = systemUsers.filter((user) => user.isSystem && user.email && user.hasPassword);

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
    setResetEmailHint("");
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
          setMode(needsInitialLedgerSetup ? "create" : data.hasPassword ? "login" : "setup");
          setSystemUsers(users);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
          const initialSelection = getInitialLoginSelection(users);
          setSelectedHouseholdId(initialSelection.scopeId);
          if (initialSelection.user) {
            setSelectedUserId(initialSelection.user.id);
            setUsername(initialSelection.user.name);
            setLoginCredentials((current) => ({
              ...current,
              local: { ...current.local, username: initialSelection.user?.name ?? "", userId: initialSelection.user.id },
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
  }, [t]);

  async function verifyLogin(params: { userId?: string; username?: string; password: string; householdId?: string }) {
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

  async function handleLogin() {
    const selectedUser = loginMode === "local" ? getSelectedLoginUser() : null;
    const selectedScopeId = loginMode === "local" && selectedHouseholdId && selectedHouseholdId !== SYSTEM_LOGIN_SCOPE_ID
      ? selectedHouseholdId
      : "";
    const trimmedUsername = (loginMode === "mmh" ? username : selectedUser?.name ?? username).trim();
    const trimmedPassword = password.trim();
    if (loginHouseholdChoices.length > 0 && !selectedHouseholdId) { setError(t("login.error.bookRequired")); return; }
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
      });
      if (data.ok) {
        window.location.href = withBasePath("/");
        return;
      }
      if (data.code === "AMBIGUOUS_USER" && data.households?.length) {
        setPendingLogin({ username: trimmedUsername, password: trimmedPassword });
        setHouseholdChoices(data.households);
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

  async function handleHouseholdChoice(householdId: string) {
    const credentials = pendingLogin ?? { username: username.trim(), password: password.trim() };
    if (!credentials.username) { setError(t("login.error.usernameRequired")); return; }
    if (!credentials.password) { setError(t("login.error.passwordRequired")); return; }

    setLoading(true);
    setError("");
    try {
      const data = await verifyLogin({ ...credentials, householdId });
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
    const scopeId = householdId ?? selectedHouseholdId;
    if (loginHouseholdChoices.length > 0 && !scopeId) { setError(t("login.error.bookRequired")); return; }
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

  async function handleSetup() {
    const trimmedUsername = setupUsername.trim();
    const trimmedPassword = newPassword.trim();
    if (!trimmedUsername) { setError(t("login.error.usernameRequired")); return; }
    if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }
    if (trimmedPassword !== confirmPassword.trim()) { setError(t("login.error.passwordMismatch")); return; }

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
        setError(setupData.error ?? t("login.error.setupFailed"));
        return;
      }

      const loginData = await verifyLogin({ username: trimmedUsername, password: trimmedPassword });
      if (loginData.ok) {
        window.location.href = withBasePath("/");
        return;
      }
      setError(loginData.error ?? t("login.error.loginFailed"));
    } catch {
      setError(t("login.error.setupRetry"));
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
    if (!initialLedgerSetup && createMethod === "invite" && !trimmedInviteCode) { setError(t("login.error.inviteRequired")); return; }
    if (!trimmedLedgerName) { setError(t("login.error.ledgerNameRequired")); return; }
    if (createMethod === "existing") {
      // Existing-account creation reuses the current login credentials below.
    } else if (createAuthMode === "local") {
      if (!trimmedAdminName) { setError(t("login.error.adminUsernameRequired")); return; }
      if (!initialLedgerSetup && !trimmedAdminEmail) { setError(t("login.error.adminEmailRequired")); return; }
      if (!trimmedPassword) { setError(t("login.error.passwordRequired")); return; }
      if (trimmedPassword !== trimmedConfirmPassword) { setError(t("login.error.passwordMismatch")); return; }
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
            ...(existingUserId ? { userId: existingUserId } : {}),
            username: existingUsername.trim(),
            password: existingPassword,
          });
          if (!verifyData.ok) {
            setError(verifyData.error ?? t("login.error.loginFailed"));
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
            adminName: createAuthMode === "fnos" ? (fnosGatewayUser?.username ?? fnosGatewayUser?.uid ?? "admin") : trimmedAdminName,
            adminEmail: createAuthMode === "mmh" ? trimmedAdminEmail : trimmedAdminEmail || undefined,
            adminPassword: createAuthMode === "fnos" ? "" : trimmedPassword,
            ...(createAuthMode === "fnos" && fnosGatewayUser ? { fnosUid: fnosGatewayUser.uid } : {}),
          }),
        });
        const createData = await createRes.json().catch(() => null) as CreateLedgerResponse | null;
        if (!createRes.ok || !createData?.ok) {
          setError(createData?.error ?? t("login.error.createFailed"));
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
    const previewOnly = !resetEmailHint;
    if (!previewOnly && !resetEmail.trim()) { setResetError(t("login.reset.emailRequired")); return; }

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
    if (!email) { setRegisterError(t("login.register.error.emailRequired")); return; }
    if (!code) { setRegisterError(t("login.register.error.codeRequired")); return; }
    if (password.length < 6) { setRegisterError(t("login.register.error.passwordRequired")); return; }
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
          {mode === "setup" && <div className="mt-1 text-xs text-slate-500">{t("login.setupHint")}</div>}
          {mode === "create" && (
            <div className="mt-1 text-xs text-slate-500">
              {initialLedgerSetup ? t("login.initialCreateHint") : t("login.createHint")}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "login" && (
          <div className="space-y-4 p-6">
            {!showReset && !showRegister && (
              <>
                {loginHouseholdChoices.length > 0 && (
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
                <div className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                  <button
                    type="button"
                    onClick={() => switchLoginMode("local")}
                    className={loginMode === "local" ? "flex-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm" : "flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-slate-500"}
                  >
                    {t("login.mode.local")}
                  </button>
                  <button
                    type="button"
                    onClick={() => switchLoginMode("mmh")}
                    className={loginMode === "mmh" ? "flex-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm" : "flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-slate-500"}
                  >
                    {t("login.mode.mmh")}
                  </button>
                  {fnosGatewayUser ? (
                    <button
                      type="button"
                      onClick={() => switchLoginMode("fnos")}
                      className={loginMode === "fnos" ? "flex-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-800 shadow-sm" : "flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-slate-500"}
                    >
                      {t("login.fnosLogin")}
                    </button>
                  ) : null}
                </div>
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
                  <div className="text-xs font-medium text-slate-600">{t("login.username")}</div>
                  {selectedHouseholdUsers.length > 0 ? (
                    <select
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
                    <input
                      value={username}
                      onChange={(event) => {
                        setSelectedUserId("");
                        setUsername(event.target.value);
                        updateLoginCredentialField("username", event.target.value);
                        cancelHouseholdChoice();
                      }}
                      type="text"
                      autoComplete="username"
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                      placeholder={t("login.usernamePlaceholder")}
                    />
                  )}
                </div>
                ) : (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.mmhAccount")}</div>
                  {mmhUserChoices.length > 0 ? (
                    <select
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

                {loginMode !== "fnos" && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.password")}</div>
                    <input
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        updateLoginCredentialField("password", event.target.value);
                        cancelHouseholdChoice();
                      }}
                    type="password"
                    autoComplete="current-password"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.passwordPlaceholder")}
                    autoFocus={loginHouseholdChoices.length === 0}
                    onKeyDown={(event) => { if (event.key === "Enter") void handleLogin(); }}
                  />
                </div>
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
                    type="button"
                    className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={loading}
                    onClick={() => void handleFnosLogin()}
                  >
                    {loading ? t("login.verifying") : t("login.fnosEnter")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={loading}
                    onClick={() => void handleLogin()}
                  >
                    {loading ? t("login.verifying") : t("login.enter")}
                  </button>
                )}
              </>
            )}

            {!showRegister && (
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

            {showReset && (
              <div className="space-y-3 border-t border-slate-100 pt-2">
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
          </div>
        )}

        {showRegister && (
          <div className="space-y-4 p-6">
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
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                placeholder={t("login.register.emailPlaceholder")}
                autoFocus
              />
            </div>
            {registerCodeSent && (
              <>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.register.code")}</div>
                  <input
                    value={registerCode}
                    onChange={(event) => {
                      setRegisterCode(event.target.value);
                      setRegisterError("");
                    }}
                    type="text"
                    autoComplete="one-time-code"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.register.codePlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.register.password")}</div>
                  <input
                    value={registerPassword}
                    onChange={(event) => {
                      setRegisterPassword(event.target.value);
                      setRegisterError("");
                    }}
                    type="password"
                    autoComplete="new-password"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.passwordPlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("login.register.name")}</div>
                  <input
                    value={registerName}
                    onChange={(event) => setRegisterName(event.target.value)}
                    type="text"
                    autoComplete="username"
                    className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    placeholder={t("login.register.namePlaceholder")}
                  />
                </div>
              </>
            )}
            {registerInfo && <div className="text-sm text-slate-600">{registerInfo}</div>}
            {registerError && <div className="text-sm text-red-600">{registerError}</div>}
            {!registerCodeSent ? (
              <button
                type="button"
                className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                disabled={registerLoading}
                onClick={() => void handleRegisterSendCode()}
              >
                {registerLoading ? t("login.verifying") : t("login.register.sendCode")}
              </button>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                  disabled={registerLoading}
                  onClick={() => void handleRegisterConfirm()}
                >
                  {registerLoading ? t("login.register.submitting") : t("login.register.submit")}
                </button>
                <button
                  type="button"
                  className="h-10 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  disabled={registerLoading}
                  onClick={() => void handleRegisterSendCode()}
                >
                  {t("login.register.resend")}
                </button>
              </div>
            )}
            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              disabled={registerLoading}
              onClick={() => {
                setShowRegister(false);
                setRegisterError("");
                setRegisterInfo("");
              }}
            >
              {t("login.register.back")}
            </button>
          </div>
        )}

        {mode === "create" && !showRegister && (
          <div className="space-y-4 p-6">
            {!initialLedgerSetup && (
              <div className="relative pt-10">
                <div className="absolute inset-x-3 top-0 z-10 flex items-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCreateMethod("invite")}
                    className={createMethod === "invite"
                      ? "relative z-30 -mb-px min-w-[7.5rem] rounded-t-[10px] border border-b-0 border-slate-300 bg-[#fbfaf7] px-4 py-2.5 text-xs font-semibold text-slate-800 shadow-[0_-3px_10px_rgba(15,23,42,0.10)]"
                      : "relative z-10 -mb-1 min-w-[7.5rem] rounded-t-[10px] border border-slate-300 bg-slate-200 px-4 py-2 text-xs font-medium text-slate-500 shadow-[0_2px_4px_rgba(15,23,42,0.08)] hover:-translate-y-0.5 hover:bg-slate-100"}
                  >
                    邀请码创建
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateMethod("existing")}
                    className={createMethod === "existing"
                      ? "relative z-30 -mb-px min-w-[7.5rem] rounded-t-[10px] border border-b-0 border-slate-300 bg-[#fbfaf7] px-4 py-2.5 text-xs font-semibold text-slate-800 shadow-[0_-3px_10px_rgba(15,23,42,0.10)]"
                      : "relative z-10 -mb-1 min-w-[7.5rem] rounded-t-[10px] border border-slate-300 bg-slate-200 px-4 py-2 text-xs font-medium text-slate-500 shadow-[0_2px_4px_rgba(15,23,42,0.08)] hover:-translate-y-0.5 hover:bg-slate-100"}
                  >
                    已有用户验证
                  </button>
                </div>
                <div className="relative z-20 rounded-xl border border-slate-300 bg-[#fbfaf7] p-4 shadow-[0_10px_24px_rgba(15,23,42,0.10)] ring-1 ring-white">
                {createMethod === "invite" ? (
                  <>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.inviteCode")}</div>
                      <input
                        value={createInviteCode}
                        onChange={(event) => setCreateInviteCode(event.target.value)}
                        type="password"
                        autoComplete="off"
                        className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
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
                              className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                              placeholder={t("login.register.emailPlaceholder")}
                            />
                          </div>
                          {registerCodeSent && (
                            <>
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-slate-600">{t("login.register.code")}</div>
                                <input value={registerCode} onChange={(event) => setRegisterCode(event.target.value)} type="text" autoComplete="one-time-code" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.register.codePlaceholder")} />
                              </div>
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-slate-600">{t("login.register.password")}</div>
                                <input value={registerPassword} onChange={(event) => setRegisterPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.passwordPlaceholder")} />
                              </div>
                              <div className="space-y-1">
                                <div className="text-xs font-medium text-slate-600">{t("login.register.name")}</div>
                                <input value={registerName} onChange={(event) => setRegisterName(event.target.value)} type="text" autoComplete="username" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" placeholder={t("login.register.namePlaceholder")} />
                              </div>
                            </>
                          )}
                          {registerInfo && <div className="text-xs text-slate-600">{registerInfo}</div>}
                          {registerError && <div className="text-xs text-red-600">{registerError}</div>}
                          {!registerCodeSent ? (
                              <button type="button" className="h-9 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={registerLoading} onClick={() => { setRegisterInviteMode(true); void handleRegisterSendCode(true); }}>
                              {registerLoading ? t("login.verifying") : t("login.register.sendCode")}
                            </button>
                          ) : (
                            <div className="space-y-2">
                              <button type="button" className="h-9 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={registerLoading} onClick={() => { setRegisterInviteMode(true); void handleRegisterConfirm(true); }}>
                                {registerLoading ? t("login.register.submitting") : t("login.register.submit")}
                              </button>
                              <button type="button" className="h-9 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50" disabled={registerLoading} onClick={() => { setRegisterInviteMode(true); void handleRegisterSendCode(true); }}>
                                {t("login.register.resend")}
                              </button>
                            </div>
                          )}
                        </div>
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
                  <div className="space-y-3 border-t border-slate-200 pt-3">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("login.register.email")}</div>
                      <input value={registerEmail} onChange={(event) => { setRegisterEmail(event.target.value); setRegisterCodeSent(false); setRegisterCode(""); setRegisterError(""); setRegisterInfo(""); }} type="email" autoComplete="email" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.register.emailPlaceholder")} />
                    </div>
                    {registerCodeSent && (
                      <>
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.register.code")}</div><input value={registerCode} onChange={(event) => setRegisterCode(event.target.value)} type="text" autoComplete="one-time-code" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.register.codePlaceholder")} /></div>
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.register.password")}</div><input value={registerPassword} onChange={(event) => setRegisterPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.passwordPlaceholder")} /></div>
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.register.name")}</div><input value={registerName} onChange={(event) => setRegisterName(event.target.value)} type="text" autoComplete="username" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.register.namePlaceholder")} /></div>
                      </>
                    )}
                    {registerInfo && <div className="text-xs text-slate-600">{registerInfo}</div>}
                    {registerError && <div className="text-xs text-red-600">{registerError}</div>}
                    {!registerCodeSent ? <button type="button" className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={registerLoading} onClick={() => void handleRegisterSendCode(false)}>{registerLoading ? t("login.verifying") : t("login.register.sendCode")}</button> : <button type="button" className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={registerLoading} onClick={() => void handleRegisterConfirm(false)}>{registerLoading ? t("login.register.submitting") : t("login.register.submit")}</button>}
                  </div>
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
            {(createMethod !== "invite" || createAuthMode !== "mmh") && (
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
                placeholder={t("login.adminUsernamePlaceholder")}
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

        {mode === "login" && !showReset && !showRegister && (
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
