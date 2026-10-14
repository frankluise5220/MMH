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
  /** Masked bound email, e.g. "j***@gmail.com" (local password recovery). */
  maskedEmail?: string | null;
};

type PasswordStatusResponse = {
  ok: boolean;
  hasPassword: boolean;
  needsInitialLedgerSetup?: boolean;
  /** Whether the current fnOS gateway user owns a ledger user. */
  fnosBound?: boolean;
  /**
   * Household ids the current fnOS gateway user is bound in; `null` entries mean
   * the bound user sits in the system scope. Used to decide whether the ledger
   * chosen in the picker may be entered with fnOS passwordless login.
   */
  fnosHouseholdIds?: Array<string | null>;
  /**
   * Ledger users the current fnOS gateway identity is bound to. Lets the fnOS
   * tab name the LEDGER user it signs in as, so it matches the local and MMH tabs.
   */
  fnosBoundUsers?: Array<{ id: string; name: string; fnosUid: string | null; householdId: string | null }>;
  passwordResetEnabled?: boolean;
  /**
   * Whether MMH membership sign-in is available on this deployment (the server
   * has a usable registration service). Absent means "unknown" — an older or
   * degraded status response — and the MMH tab stays visible rather than
   * hiding a working entry point.
   */
  mmhEnabled?: boolean;
  users?: LoginUserChoice[];
};

type LoginUserChoice = {
  id: string;
  name: string;
  /** fnOS UID bound to this ledger user, when the gateway identity matches. */
  fnosUid?: string | null;
  /** Editable local contact address. Never an MMH identity — see `mmhAddress`. */
  email?: string | null;
  /**
   * MMH membership address captured when the binding was made. The only field
   * that identifies the central account, and therefore the only one the MMH tab
   * may pre-fill or label with.
   */
  registrationEmail?: string | null;
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
import { folderTabClass, folderTabNeighbors, folderTabPanelClass, FOLDER_TAB_STRIP, FolderTabs } from "./FolderTabs";

function getLoginUserScopeId(user: LoginUserChoice) {
  return user.householdId ?? SYSTEM_LOGIN_SCOPE_ID;
}

/**
 * 当前网关注入的飞牛用户标识：用户名优先，数字 UID 兜底。
 * 用户名是用户在飞牛里实际登录的账号名（如 jsbyfubin），数字 UID 用户看不到，
 * 只在用户名缺失时才拿来兜底。
 */
function gatewayFnosName(user?: FnosGatewayUser | null): string {
  return user?.username?.trim() || user?.uid?.trim() || "";
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
  // Ledger users this fnOS gateway identity is bound to. The fnOS tab labels
  // itself with one of these so all three tabs name the same ledger user.
  const [fnosBoundUsers, setFnosBoundUsers] = useState<LoginUserChoice[]>([]);
  // Ledgers the forwarded fnOS identity is bound in (`null` = system scope).
  const [fnosHouseholdIds, setFnosHouseholdIds] = useState<Array<string | null>>([]);
  const [passwordResetEnabled, setPasswordResetEnabled] = useState(false);
  // Optimistic default: the MMH tab only disappears when the status response
  // explicitly reports the registration service as unavailable, so a failed or
  // older status response never hides a working sign-in method.
  const [mmhEnabled, setMmhEnabled] = useState(true);
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
  // Masked address the code was just sent to (e.g. "j***@gmail.com"). The user
  // never types the bound email: it is resolved server-side from the account.
  const [resetSentTo, setResetSentTo] = useState("");
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
  const [registerInfo, setRegisterInfo] = useState("");
  const [registerError, setRegisterError] = useState("");
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerInviteMode, setRegisterInviteMode] = useState(false);

  // MMH membership password reset (separate from the ledger-local password reset).
  const [showMmhReset, setShowMmhReset] = useState(false);
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
  // 内容板四角恒为 12px 圆角（不去任何圆角），见 folderTabPanelClass。
  // MMH 页签只在服务端确有注册服务时出现，否则它是个必然失败的死入口。
  const loginTabOrder: Array<"local" | "mmh" | "fnos"> = fnosGatewayUser
    ? mmhEnabled ? ["local", "mmh", "fnos"] : ["local", "fnos"]
    : mmhEnabled ? ["local", "mmh"] : ["local"];
  const localLoginUsers = systemUsers.filter((user) => user.hasPassword === true);
  const selectedHouseholdUsers = selectedHouseholdId
    ? localLoginUsers.filter((user) => getLoginUserScopeId(user) === selectedHouseholdId)
    : [];
  // MMH sign-in verifies the email + membership password against the central
  // registration service, never against a ledger-local hash — so `hasPassword`
  // must not gate this list. Requiring it hid every MMH identity that had not
  // set a local ledger password (which is exactly what an MMH-created ledger
  // admin has).
  const mmhUserChoices = systemUsers.filter((user) => user.registrationPrincipalId && mmhAddress(user));
  // The MMH tab gets the same "dead ledger" treatment as the local / fnOS tabs:
  // when the selected ledger links no MMH user, the card shows an amber notice
  // instead of letting the user type an email and password into MMH_USER_NOT_BOUND.
  const selectedHouseholdMmhUsers = selectedHouseholdId
    ? mmhUserChoices.filter((user) => getLoginUserScopeId(user) === selectedHouseholdId)
    : mmhUserChoices;
  // 「死账」判定与 local 页签对称：只看选中账簿有没有绑 MMH 用户，不看
  // 全局是否存在 MMH 用户。飞牛免密建账后整个系统可能一个 MMH 用户都没有，
  // 但 MMH 页签仍应变黄警示（否则会让人以为能直接邮箱+密码登录，而登录
  // 只能得到 MMH_USER_NOT_BOUND）。
  const mmhTabUnavailable =
    loginMode === "mmh" &&
    !!selectedHouseholdId &&
    selectedHouseholdMmhUsers.length === 0;
  // The local tab is dead when the *selected* ledger has no local account: the
  // account has to be created inside the ledger, by someone who can already get in.
  const localTabUnavailable = loginMode === "local" && selectedHouseholdUsers.length === 0;
  // Ledger scopes this fnOS identity may enter without a password. The id list
  // comes from the server; a `null` householdId is the system scope, exactly like
  // `getLoginUserScopeId` maps an unbound user.
  const fnosBoundScopes = new Set(fnosHouseholdIds.map((id) => id ?? SYSTEM_LOGIN_SCOPE_ID));
  // The fnOS tab has the same dead-ledger state as the local tab: picking a
  // ledger this fnOS account is not bound in cannot sign in, so the card warns
  // instead of offering a button that could only fail with FNOS_USER_NOT_BOUND.
  const fnosTabUnavailable = loginMode === "fnos" && !!selectedHouseholdId && !fnosBoundScopes.has(selectedHouseholdId);
  // The MMH membership password belongs to an *email* identity, and the card
  // already carries that email: either the account select (when the ledger knows
  // MMH identities) or the free-text email field. The reset panel must reuse it
  // instead of asking for the address a second time.
  const mmhResetAccount = getCurrentMmhEmail();
  // Pointing the card at a different account invalidates a code that was already
  // sent for the previous one, so the panel drops back to its first step.
  useEffect(() => {
    setMmhResetCodeSent(false);
    setMmhResetCode("");
    setMmhResetError("");
    setMmhResetInfo("");
  }, [mmhResetAccount]);
  // Same idea for the local tab: the account to recover is the one already
  // selected in this card, so it is derived live rather than kept in its own
  // state (the panel expands right below the form, and re-picking a user there
  // must be reflected here immediately).
  const resetAccount = (getSelectedLoginUser()?.name ?? username).trim();
  // Re-pointing the card at a different local account — another ledger, or
  // another user inside the same ledger — invalidates a code that was already
  // sent for the previous one, so the panel drops back to its first step. Same
  // rule as the MMH panel above.
  useEffect(() => {
    if (!showReset) return;
    setResetStep("request");
    setResetSentTo("");
    setResetError("");
    setResetInfo("");
  }, [showReset, resetAccount]);

  function maskEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    const atIndex = normalized.indexOf("@");
    if (atIndex <= 0 || atIndex === normalized.length - 1) return normalized;
    const localPart = normalized.slice(0, atIndex);
    const domain = normalized.slice(atIndex + 1);
    const visibleLocal = localPart.length <= 2 ? localPart.slice(0, 1) : localPart.slice(0, 2);
    return `${visibleLocal}***@${domain}`;
  }

  /**
   * One label shape for every sign-in tab, so the same ledger user reads the same
   * way whichever entry you come in through.
   *
   * The ledger user name leads, because that is the thing that is actually the
   * same across all three tabs — the credentials are not. What follows says which
   * credential this tab will actually check, which is the only thing that differs.
   * The old MMH label put the membership address first (`masked(name)`) while the
   * local one put it last (`name(masked)`), so the same person looked like two
   * different entries and there was nothing to match on when switching tabs.
   * Nothing else is appended: the local tab carries no marker at all, because a
   * role badge ("system user") says something about permissions the sign-in form
   * is not deciding, and it made the same name look like a different kind of
   * entry depending on which tab listed it.
   */
  function getLoginUserLabel(user: LoginUserChoice) {
    return user.name;
  }

  /** Same person, seen through the MMH entry: name first, then which credential. */
  function getMmhUserLabel(user: LoginUserChoice) {
    const address = mmhAddress(user);
    const suffix = address ? ` · ${maskEmail(address)}` : "";
    return `${getLoginUserLabel(user)}${suffix}`;
  }

  /**
   * The MMH identity an account row carries, or null when it has none.
   *
   * Deliberately NOT `email`: that column is the editable local contact field
   * (it is how the local account is found for password recovery), so using it
   * here made the MMH tab pre-fill and label sign-in entries with a local
   * contact address — after an email edit the tab pointed at an MMH account the
   * ledger had never heard of. A row with a binding but no recorded address is
   * no use as an MMH sign-in choice either: there is nothing to type.
   */
  function mmhAddress(user: LoginUserChoice): string {
    return user.registrationEmail?.trim() ?? "";
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
    const address = user ? mmhAddress(user) : "";
    if (!user || !address) return;
    setSelectedUserId("");
    setUsername(address);
    setPassword(loginCredentials.mmh.password);
    setLoginCredentials((current) => ({
      ...current,
      mmh: { ...current.mmh, username: address, userId: user.id },
    }));
    cancelHouseholdChoice();
  }

  /**
   * The MMH account the card is currently pointing at — the selected option of
   * the account select when the ledger knows MMH identities, otherwise whatever
   * email the user typed. Returns "" when nothing is chosen yet.
   */
  /**
   * The ledger user the fnOS gateway identity signs in as in the selected ledger.
   *
   * The gateway identity itself (`jsbyfubin`) is NOT a ledger user name, so
   * showing it alone made the fnOS tab look like a different person from the
   * local and MMH tabs for the same account. When this gateway identity is bound
   * to a ledger user here, show that user's name — the common label — and keep
   * the gateway name as the secondary fact.
   */
  function fnosLedgerUser(): LoginUserChoice | null {
    if (fnosBoundUsers.length === 0) return null;
    const match = selectedHouseholdId
      ? fnosBoundUsers.find((u) => getLoginUserScopeId(u) === selectedHouseholdId)
      : fnosBoundUsers[0];
    if (!match) return null;
    return { ...match, email: null, hasPassword: false, role: "user", isSystem: false };
  }

  /**
   * The account a new ledger's administrator is about to be created for, named
   * the way the credential actually works.
   *
   * MMH entries must be named by `registrationEmail` — the membership address —
   * never by `email`. Both fields exist on the same row, and reading `email`
   * showed the local contact address of the account while the picker right above
   * it showed the MMH one, so the same person appeared as two different accounts
   * in one dialog.
   */
  function existingCreateAdminAccountLabel(): string {
    if (createAuthMode === "mmh") {
      const selected = mmhUserChoices.find((user) => user.id === createExistingUserId) ?? mmhUserChoices[0];
      return (selected ? mmhAddress(selected) : "") || loginCredentials.mmh.username;
    }
    if (createAuthMode === "fnos") {
      return gatewayFnosName(fnosGatewayUser) ?? "";
    }
    const selected = selectedHouseholdUsers.find((user) => user.id === createExistingUserId) ?? selectedHouseholdUsers[0];
    return selected?.name ?? loginCredentials.local.username;
  }

  function getCurrentMmhEmail() {
    if (mmhUserChoices.length > 0) {
      const selected = mmhUserChoices.find((user) => user.id === loginCredentials.mmh.userId) ?? mmhUserChoices[0];
      const address = selected ? mmhAddress(selected) : "";
      if (address) return address;
    }
    return username.trim();
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
    // 两个页签共用一条「忘记密码」入口：切页签时必须把上一页签展开的重置面板
    // 收起来，否则本地面板会挂到 MMH 页签下面，文案与页面语义都对不上。
    setShowReset(false);
    setShowMmhReset(false);
    setResetError("");
    setResetInfo("");
    setMmhResetError("");
    setMmhResetInfo("");
    if (mode === "mmh") {
      const credentials = loginCredentials.mmh;
      const scopedMmhUsers = selectedHouseholdId
        ? mmhUserChoices.filter((user) => getLoginUserScopeId(user) === selectedHouseholdId)
        : mmhUserChoices;
      const defaultMmhUser = scopedMmhUsers.find((user) => user.id === credentials.userId) ?? scopedMmhUsers[0];
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
    setResetSentTo("");
    setResetHouseholdId("");
    setResetHouseholdChoices([]);
    if (!passwordResetEnabled) {
      setResetError(t("login.reset.mailNotConfigured"));
      setShowReset(true);
      cancelHouseholdChoice();
      return;
    }
    setResetError("");
    setShowReset(true);
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
          const openOnFnosTab = hasFnosGateway && (data.fnosBound === true || !data.hasPassword);
          if (openOnFnosTab) {
            setLoginMode("fnos");
          }
          setSystemUsers(users);
          setPasswordResetEnabled(data.passwordResetEnabled ?? false);
          // A deployment with no registration service cannot verify an MMH
          // membership password at all, so drop the tab instead of letting the
          // user type credentials that can only fail.
          const mmhAvailable = data.mmhEnabled !== false;
          setMmhEnabled(mmhAvailable);
          if (!mmhAvailable) {
            setLoginMode((current) => (current === "mmh" ? "local" : current));
            setCreateAuthMode((current) =>
              current === "mmh" ? (hasFnosGateway ? "fnos" : "local") : current,
            );
          }
          const boundHouseholdIds = data.fnosHouseholdIds ?? [];
          setFnosHouseholdIds(boundHouseholdIds);
          setFnosBoundUsers(
            (data.fnosBoundUsers ?? []).map((u) => ({
              ...u,
              email: null,
              hasPassword: false,
              role: "user",
              isSystem: false,
            })),
          );
          const boundScopes = new Set(boundHouseholdIds.map((id) => id ?? SYSTEM_LOGIN_SCOPE_ID));
          const initialSelection = getInitialLoginSelection(users);
          // The picker lists every ledger, and on the fnOS tab the chosen ledger
          // is the one the gateway identity is matched against. Opening on a
          // ledger this identity is not bound in would greet the user with the
          // "no fnOS access" notice on a screen that used to sign them straight
          // in, so land on a bound ledger when there is one.
          let initialScopeId = initialSelection.scopeId;
          if (openOnFnosTab && boundScopes.size > 0 && !boundScopes.has(initialScopeId)) {
            const boundUser = users.find((user) => boundScopes.has(getLoginUserScopeId(user)));
            if (boundUser) initialScopeId = getLoginUserScopeId(boundUser);
          }
          setSelectedHouseholdId(initialScopeId);
          // The prefilled local account only fits the ledger it was picked from;
          // a scope switch above must not leave a user from the previous ledger
          // selected (the local tab recomputes its own selection when entered).
          const initialUser = initialScopeId === initialSelection.scopeId ? initialSelection.user : null;
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
          setFnosHouseholdIds([]);
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
        setFnosHouseholdIds([]);
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
  //
  // Switching the ledger-creation entry does too: the signup shape only exists on
  // the entries that open a ledger, so arriving at "already have an account" while
  // the signup form is open would leave a form behind that must not be reachable
  // from there (and whose submit would be refused).
  useEffect(() => {
    if (createAuthMode !== "mmh" || createMethod === "existing") setCreateMmhMode("login");
  }, [createAuthMode, createMethod]);

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
   * The central registration service answers in English with machine codes,
   * and so do the local routes that refuse to call it. Map every code the MMH
   * flow can produce: "no MMH user for this email" is the one people hit most
   * often and needs to point at the signup entry instead of reading like a hard
   * failure, and the two service-availability codes must never surface as raw
   * English (they used to, which is how "The registration service is not
   * configured on this server." reached the login form).
   */
  function mmhErrorText(code: string | undefined, fallback: string | undefined, fallbackKey: string) {
    if (code === "PRINCIPAL_NOT_FOUND") return t("login.error.mmhAccountNotFound");
    if (code === "REGISTRATION_NOT_CONFIGURED") return t("login.error.mmhNotConfigured");
    if (code === "REGISTRATION_SERVICE_UNREACHABLE") return t("login.error.mmhServiceUnreachable");
    // The central account was verified but carries no principal id, so it
    // cannot be matched to a local user. Almost always a contract mismatch on
    // the service side, which the user cannot fix from the login form.
    if (code === "MMH_PRINCIPAL_MISSING") return t("login.error.mmhPrincipalMissing");
    // The central account exists and the password checked out, but this ledger's
    // binding still points at a principal id the service no longer recognises.
    if (code === "MMH_BINDING_STALE") return t("login.error.mmhBindingStale");
    // Not a member of this ledger. Said before any password check, because it
    // does not depend on one — an address this ledger never bound cannot be
    // logged into no matter what the central service answers.
    if (code === "MMH_USER_NOT_BOUND") return t("login.error.mmhNotBoundToLedger");
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
    // Resolved server-side from the gateway identity (X-Trim-Username, falling
    // back to X-Trim-Userid). The ledger picker's value IS forwarded: the fnOS
    // card hides its submit button whenever the picked ledger carries no binding
    // for this identity, so a submitted ledger is always one the identity is
    // bound in — an earlier version forwarded the ambient pre-selection without
    // that guard and made a multi-ledger identity fail with FNOS_USER_NOT_BOUND.
    // The AMBIGUOUS_USER card's explicit pick travels the same path.
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

  /**
   * The single submit entry point behind the fixed "create and enter" button.
   *
   * Every other shape of the creation card is submitted by `handleCreateLedger`.
   * The one exception is the MMH signup shape: it is a two-step flow of its own
   * (send a code, then confirm it) whose confirmation used to be an extra button
   * rendered inside the card. That button is gone, so the fixed button drives the
   * confirmation step instead of leaving the screen with two competing submits.
   */
  function submitCreateLedger() {
    if (createMethod === "invite" && createAuthMode === "mmh" && createMmhMode === "register") {
      void handleRegisterConfirm(true);
      return;
    }
    void handleCreateLedger();
  }

  /**
   * Leaves ledger creation for the sign-in card, clearing every piece of the
   * creation form on the way out — including the MMH signup panel, which holds
   * its own code/password state and would otherwise reopen half-filled the next
   * time this card is shown.
   */
  function backToLoginFromCreate() {
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
    setRegisterInfo("");
    setRegisterError("");
    setMode("login");
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
        // The credential being verified. For MMH this must be the membership
        // address (`registrationEmail`): that is the only address the central
        // registration service can answer about. `email` on the same row is the
        // local contact address of the ledger the user is already in, so verifying
        // with it asks the service about an account that generally is not the one
        // selected — and fails, or worse matches somebody else.
        const existingUsername = createAuthMode === "mmh"
          ? (selectedExistingUser ? mmhAddress(selectedExistingUser) : "") || credentials.username
          : selectedExistingUser?.name ?? credentials.username;
        const existingUserId = selectedExistingUser?.id ?? credentials.userId;
        let adminName = selectedExistingUser?.name ?? existingUsername.trim();
        // The new administrator's contact address. For an MMH identity that is the
        // membership address (`registrationEmail`) — `email` on the same row is the
        // local contacts field of the OTHER ledger, and using it here both named
        // the wrong account in the confirmation line and wrote a mismatched address
        // onto the new administrator.
        let adminEmail = createAuthMode === "mmh"
          ? (selectedExistingUser ? mmhAddress(selectedExistingUser) : "") || undefined
          : selectedExistingUser?.email ?? undefined;
        let adminPassword: string | undefined;

        if (createAuthMode === "fnos") {
          if (!gatewayFnosName(fnosGatewayUser)) { setError(t("login.error.loginFailed")); return; }
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
          adminName = gatewayFnosName(fnosGatewayUser);
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
            ...(createAuthMode === "fnos" ? { fnosUid: gatewayFnosName(fnosGatewayUser) } : {}),
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
              ? (gatewayFnosName(fnosGatewayUser) || "admin")
              : createAuthMode === "mmh"
                ? (trimmedAdminName || trimmedAdminEmail.split("@")[0] || "admin")
                : trimmedAdminName,
            adminEmail: trimmedAdminEmail || undefined,
            // Only the local mode stores a ledger-local admin password. The MMH
            // mode authenticates an existing membership identity instead, and the
            // fnOS mode is vouched for by the gateway.
            adminPassword: createAuthMode === "local" ? trimmedPassword : "",
            ...(createAuthMode === "mmh" ? { mmhPassword: trimmedMmhPassword } : {}),
            ...(createAuthMode === "fnos" && fnosGatewayUser ? { fnosUid: gatewayFnosName(fnosGatewayUser) } : {}),
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
    if (!resetAccount) { setResetError(t("login.error.usernameRequired")); return; }

    setResetLoading(true);
    setResetError("");
    setResetInfo("");
    try {
      const res = await fetch("/api/v1/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: resetAccount,
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
        // The account has no bound email, so there is nothing to send a code to.
        // Say so plainly instead of advancing to a step that can never complete.
        if (data?.code === "NO_BOUND_EMAIL") { setResetError(t("login.reset.noBoundEmail")); return; }
        if (data?.code === "RATE_LIMITED") { setResetError(t("login.reset.rateLimited")); return; }
        setResetError(data?.error ?? t("login.reset.sendFailed"));
        return;
      }
      setResetHouseholdId(data.householdId ?? selectedHouseholdId ?? "");
      setResetHouseholdChoices([]);
      setResetSentTo(data.maskedEmail ?? "");
      setResetStep("confirm");
    } catch {
      setResetError(t("login.reset.sendRetry"));
    } finally {
      setResetLoading(false);
    }
  }

  async function handleResetConfirm(selectedHouseholdId = resetHouseholdId) {
    if (!resetAccount) { setResetError(t("login.error.usernameRequired")); return; }
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
          username: resetAccount,
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
      setUsername(resetAccount);
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
            : mmhErrorText(data?.code, data?.error, "login.register.error.sendFailed"),
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
              : mmhErrorText(data?.code, data?.error, "login.register.error.failed"),
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
    const email = getCurrentMmhEmail();
    if (!email) { setMmhResetError(t("login.mmhReset.accountMissing")); return; }
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
        setMmhResetError(mmhErrorText(data?.code, data?.error, "login.register.error.sendFailed"));
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
    const email = getCurrentMmhEmail();
    const code = mmhResetCode.trim();
    const newPassword = mmhResetNewPassword.trim();
    const confirmPassword = mmhResetConfirmPassword.trim();
    if (!email) { setMmhResetError(t("login.mmhReset.accountMissing")); return; }
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
            : mmhErrorText(data?.code, data?.error, "login.mmhReset.error.failed"),
        );
        return;
      }
      setMmhResetInfo(t("login.mmhReset.success"));
      setShowMmhReset(false);
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
   * Always offers the "sign in with an existing MMH identity" shape — email +
   * membership password, verified server-side against the central registration
   * service. `allowSignup` additionally offers the signup shape, through the
   * secondary "create an MMH user" link.
   *
   * Only the entries that actually OPEN a ledger offer signup: the first-ledger
   * setup and the invite-code entry. "Already have an account" verification does
   * not, and its refusal is the point of the entry — it exists so somebody who
   * already belongs to another ledger can prove that and open a new one. Letting
   * it mint a brand-new MMH identity would contradict what the entry is for, and
   * it cannot work anyway: self-service signup is gated to an empty deployment
   * (`SIGNUP_CLOSED`), while this entry is only reachable once a ledger exists.
   */
  function renderMmhCreateFields(allowSignup: boolean) {
    if (allowSignup && createMmhMode === "register") {
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
            </>
          )}
          {registerInfo && <div className="text-xs text-slate-600">{registerInfo}</div>}
          {registerError && <div className="text-xs text-red-600">{registerError}</div>}
          {!registerCodeSent ? (
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={registerLoading}
              onClick={() => { setRegisterInviteMode(true); void handleRegisterSendCode(true); }}
            >
              {registerLoading ? t("login.verifying") : t("login.register.sendCode")}
            </button>
          ) : (
            /* No submit button here: confirmation is the card's fixed
               "create and enter" button, so this step only offers "resend". */
            <button
              type="button"
              className="h-10 w-full rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              disabled={registerLoading}
              onClick={() => { setRegisterInviteMode(true); void handleRegisterSendCode(true); }}
            >
              {t("login.register.resend")}
            </button>
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
        {allowSignup ? (
          <button
            type="button"
            className="w-full text-xs text-slate-500 hover:text-slate-700"
            onClick={() => setCreateMmhMode("register")}
          >
            {t("login.createMmhUser")}
          </button>
        ) : (
          <div className="text-[11px] leading-5 text-slate-500">{t("login.mmhSignupElsewhere")}</div>
        )}
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

        {/* The body scrolls; the action bar below is its sibling in this column,
            so "create and enter" stays put and is visible without scrolling
            however tall the form gets. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        {mode === "login" && (
          <div className="space-y-4 p-6">
            {/* The ledger picker belongs to every sign-in tab. A local account
                belongs to exactly one ledger, MMH resolves its ledger from the
                account, and on the fnOS tab the picked ledger is what the
                forwarded gateway identity is matched against — so the picker is
                shown there too, and the fnOS card warns when the picked ledger
                carries no fnOS binding for this identity. It must stay visible
                while the reset panel is open: the account being recovered is
                derived from the selected ledger's users, so hiding the picker
                left no way to point the reset at another one (leftover from when
                resetting replaced the whole card). */}
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

            {/* 登录方式 = 文件卡片页签；卡片内容 = 用户名 / 密码 / 忘记密码 / 进入账簿 */}
            {/* 重置密码不再是「另一张卡片」：它就在本卡片里、在「进入」下方就地展开，
                页签条与登录表单都保持可见，用户随时能收起或换页签。 */}
            <div className="relative pt-10">
              <div className={FOLDER_TAB_STRIP}>
                <button
                  type="button"
                  onClick={() => switchLoginMode("local")}
                  className={`${folderTabClass(
                    loginMode === "local",
                    loginTabOrder.indexOf("local") === loginTabOrder.length - 1,
                    "stretch",
                    loginTabOrder.indexOf("local") === 0,
                    folderTabNeighbors(loginTabOrder, "local", loginMode),
                  )}${localTabUnavailable ? " ft-tab-fillet-amber" : ""}`}
                >
                  <span className="relative block overflow-hidden whitespace-nowrap">{t("login.mode.local")}</span>
                </button>
                {mmhEnabled ? (
                  <button
                    type="button"
                    onClick={() => switchLoginMode("mmh")}
                    className={`${folderTabClass(
                      loginMode === "mmh",
                      loginTabOrder.indexOf("mmh") === loginTabOrder.length - 1,
                      "stretch",
                      loginTabOrder.indexOf("mmh") === 0,
                      folderTabNeighbors(loginTabOrder, "mmh", loginMode),
                    )}${mmhTabUnavailable ? " ft-tab-fillet-amber" : ""}`}
                  >
                    <span className="relative block overflow-hidden whitespace-nowrap">{t("login.mode.mmh")}</span>
                  </button>
                ) : null}
                {fnosGatewayUser ? (
                  <button
                    type="button"
                    onClick={() => switchLoginMode("fnos")}
                    className={`${folderTabClass(
                      loginMode === "fnos",
                      loginTabOrder.indexOf("fnos") === loginTabOrder.length - 1,
                      "stretch",
                      loginTabOrder.indexOf("fnos") === 0,
                      folderTabNeighbors(loginTabOrder, "fnos", loginMode),
                    )}${fnosTabUnavailable ? " ft-tab-fillet-amber" : ""}`}
                  >
                    <span className="relative block overflow-hidden whitespace-nowrap">{t("login.fnosLogin")}</span>
                  </button>
                ) : null}
              </div>

              <div className={`${folderTabPanelClass()} space-y-4`}>
                <form
                  id="mmh-login-form"
                  action={withBasePath("/login")}
                  method="post"
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (loginMode === "fnos") void handleFnosLogin(selectedHouseholdId);
                    else void handleLogin();
                  }}
                >
                {loginMode === "fnos" && fnosGatewayUser ? (
                <div className="space-y-3">
                  {/* Same label shape as the local and MMH tabs: the ledger user
                      name leads, the credential that will actually be checked
                      follows. The gateway account name is secondary — it is not a
                      ledger user, and putting it first is what made this tab look
                      like a different person. */}
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {fnosLedgerUser() ? (
                      <>
                        <div className="font-semibold text-slate-800">
                          {getLoginUserLabel(fnosLedgerUser()!)}
                          <span className="ml-1 font-normal text-slate-500">· {t("login.fnosPasswordlessBadge")}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {t("login.fnosUser", { user: gatewayFnosName(fnosGatewayUser) })}
                        </div>
                      </>
                    ) : (
                      <span>{t("login.fnosUser", { user: gatewayFnosName(fnosGatewayUser) })}</span>
                    )}
                  </div>
                  {/* Mirror of the local tab's "this ledger has no local account"
                      notice: the picked ledger exists but this fnOS account is
                      not bound in it, so there is nothing this card could check. */}
                  {fnosTabUnavailable ? (
                    <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-3">
                      <div className="text-sm font-semibold text-slate-800">{t("login.fnosNoLedgerTitle")}</div>
                      <div className="text-xs leading-5 text-slate-600">{t("login.fnosNoLedger")}</div>
                    </div>
                  ) : (
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
                  )}
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
                  {mmhTabUnavailable ? (
                    <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-3">
                      <div className="text-sm font-semibold text-slate-800">{t("login.mmhNoLedgerTitle")}</div>
                      <div className="text-xs leading-5 text-slate-600">{t("login.mmhNoLedger")}</div>
                    </div>
                  ) : selectedHouseholdMmhUsers.length > 0 ? (
                    <select
                      id="login-username"
                      name="username"
                      autoComplete="username"
                      value={loginCredentials.mmh.userId || ""}
                      onChange={(event) => selectMmhUser(event.target.value)}
                      className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                    >
                      {selectedHouseholdMmhUsers.map((user) => (
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

                {/* No password field when the ledger has no local account at all,
                    and none on the MMH tab when the ledger links no MMH user:
                    showing one invited people to type a password that could never
                    be checked. The amber notice above already explains what to do. */}
                {loginMode !== "fnos" && !localTabUnavailable && !mmhTabUnavailable && (
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
                  fnosTabUnavailable ? null : (
                    <button
                      type="submit"
                      className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                      disabled={loading}
                    >
                      {loading ? t("login.verifying") : t("login.fnosEnter")}
                    </button>
                  )
                ) : localTabUnavailable || mmhTabUnavailable ? null : (
                  <button
                    type="submit"
                    className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={loading}
                  >
                    {loading ? t("login.verifying") : t("login.enter")}
                  </button>
                )}
                </form>

            {showMmhReset && (
              <div className="space-y-3">
                <div className="text-xs font-medium text-slate-600">{t("login.mmhReset.title")}</div>
                {/* The account is already chosen at the top of the card (the
                    account select, or the email field when this ledger knows no
                    MMH identity yet), so the panel shows it read-only instead of
                    asking for the address a second time. */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  {mmhResetAccount
                    ? t("login.mmhReset.account", { email: mmhResetAccount })
                    : t("login.mmhReset.accountMissing")}
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
                  <button type="button" className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50" disabled={mmhResetLoading || !mmhResetAccount} onClick={() => void handleMmhResetSendCode()}>
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
                {/* The account is the one already selected in this card, exactly
                    like the MMH panel: showing it read-only beats asking for the
                    username a second time right below the form's own field. */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  {resetAccount
                    ? t("login.reset.account", { account: resetAccount })
                    : t("login.reset.accountMissing")}
                </div>
                {resetStep === "confirm" && (
                  <>
                    {/* The bound email is never typed: the server resolved it from
                        the account and mailed the code there, so this only tells
                        the user where to look (address shown masked). */}
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      {resetSentTo ? t("login.reset.sentTo", { email: resetSentTo }) : t("login.reset.codeSent")}
                    </div>
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
                      disabled={resetLoading || !resetAccount}
                      onClick={() => void handleResetRequest()}
                    >
                      {resetLoading ? t("login.reset.processing") : t("login.reset.sendCode")}
                    </button>
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

            {/* 忘记密码 / 收起：本地与 MMH 两个页签共用同一条入口 —— 同一个文案、
                同一个位置（都排在「进入」按钮下方）。飞牛页签不输入密码，账簿没有
                本地账户时也没有可找回的本地密码，账簿没绑 MMH 用户时同样没有可找回
                的 MMH 密码，这些情况都不显示。 */}
            {(loginMode === "mmh" && !mmhTabUnavailable) || (loginMode === "local" && !localTabUnavailable) ? (
            <button
              type="button"
              className="w-full text-xs text-slate-500 hover:text-slate-700"
              disabled={loading || resetLoading || mmhResetLoading}
              onClick={() => {
                if (loginMode === "mmh") {
                  if (showMmhReset) {
                    setShowMmhReset(false);
                    setMmhResetError("");
                    setMmhResetInfo("");
                    return;
                  }
                  setShowMmhReset(true);
                  setShowReset(false);
                  return;
                }
                if (showReset) {
                  setShowReset(false);
                  setResetStep("request");
                  setResetError("");
                  setResetInfo("");
                  return;
                }
                openPasswordReset();
              }}
            >
              {(loginMode === "mmh" ? showMmhReset : showReset) ? t("common.collapse") : t("login.forgotPassword")}
            </button>
            ) : null}
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
                    className={folderTabClass(createMethod === "invite", false, "stretch", true)}
                  >
                    <span className="relative block overflow-hidden whitespace-nowrap">邀请码创建</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreateMethod("existing")}
                    className={folderTabClass(createMethod === "existing", true, "stretch", false)}
                  >
                    <span className="relative block overflow-hidden whitespace-nowrap">已有用户验证</span>
                  </button>
                </div>
                <div className={`${folderTabPanelClass()} space-y-4`}>
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
                      <FolderTabs
                        tabs={[
                          { id: "local", label: t("login.mode.local") },
                          ...(mmhEnabled ? [{ id: "mmh", label: t("login.mode.mmh") }] : []),
                          ...(fnosGatewayUser ? [{ id: "fnos", label: t("login.authModeFnos") }] : []),
                        ]}
                        activeId={createAuthMode}
                        onChange={(id) => setCreateAuthMode(id as "local" | "mmh" | "fnos")}
                        variant="stretch"
                        panelClassName="space-y-3"
                      >
                        {createAuthMode === "fnos" ? (
                          <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                            {t("login.fnosUser", { user: gatewayFnosName(fnosGatewayUser) })}
                          </div>
                        ) : createAuthMode === "mmh" ? (
                          /* The invite-code entry opens a ledger, so it may create
                             the MMH account on the spot. */
                          renderMmhCreateFields(true)
                        ) : (
                          <div className="space-y-3">
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
                      </FolderTabs>
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
                      {/* 与「邀请码创建」分支的 createUser 选择器保持一致：同一组 local/mmh/fnos
                          用同一套 FT 卡片（文件卡片式页签），不再用旧的 segment 控件。 */}
                      <FolderTabs
                        tabs={[
                          { id: "local", label: t("login.mode.local") },
                          ...(mmhEnabled ? [{ id: "mmh", label: t("login.mode.mmh") }] : []),
                          ...(fnosGatewayUser ? [{ id: "fnos", label: t("login.authModeFnos") }] : []),
                        ]}
                        activeId={createAuthMode}
                        onChange={(id) => {
                          setCreateAuthMode(id as "local" | "mmh" | "fnos");
                          if (id === "local") setCreateExistingUserId(selectedHouseholdUsers[0]?.id ?? "");
                          else if (id === "mmh") setCreateExistingUserId(mmhUserChoices[0]?.id ?? "");
                        }}
                        variant="stretch"
                        panelClassName="space-y-3"
                      >
                        {createAuthMode === "fnos" ? (
                          <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                            {t("login.fnosUser", { user: gatewayFnosName(fnosGatewayUser) })}
                          </div>
                        ) : (
                          <>
                            {createAuthMode === "mmh" && mmhUserChoices.length > 0 ? (
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
                            {/* The password belongs to the identity picked right
                                above: choosing an account and proving it is one
                                step, so it stays inside the same card instead of
                                hanging below it as a separate block. */}
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
                          </>
                        )}
                      </FolderTabs>
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
                  <FolderTabs
                    tabs={[
                      { id: "local", label: t("login.mode.local") },
                      ...(mmhEnabled ? [{ id: "mmh", label: t("login.mode.mmh") }] : []),
                      ...(fnosGatewayUser ? [{ id: "fnos", label: t("login.authModeFnos") }] : []),
                    ]}
                    activeId={createAuthMode}
                    onChange={(id) => setCreateAuthMode(id as "local" | "mmh" | "fnos")}
                    variant="stretch"
                    panelClassName="space-y-3"
                  >
                    {createAuthMode === "fnos" ? (
                      <div className="rounded-md border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-500">
                        {t("login.fnosUser", { user: gatewayFnosName(fnosGatewayUser) })}
                      </div>
                    ) : createAuthMode === "mmh" ? (
                      renderMmhCreateFields(false)
                    ) : (
                      <div className="space-y-3">
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.adminUsername")}</div><input value={createAdminName} onChange={(event) => setCreateAdminName(event.target.value)} type="text" autoComplete="username" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.adminUsernamePlaceholder")} /></div>
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.adminEmailOptional")}</div><input value={createAdminEmail} onChange={(event) => setCreateAdminEmail(event.target.value)} type="email" autoComplete="email" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.adminEmailPlaceholder")} /></div>
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.password")}</div><input value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.passwordPlaceholder")} /></div>
                        <div className="space-y-1"><div className="text-xs font-medium text-slate-600">{t("login.confirmPassword")}</div><input value={createConfirmPassword} onChange={(event) => setCreateConfirmPassword(event.target.value)} type="password" autoComplete="new-password" className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none" placeholder={t("login.confirmPassword")} onKeyDown={(event) => { if (event.key === "Enter") void handleCreateLedger(); }} /></div>
                      </div>
                    )}
                  </FolderTabs>
                </div>
              </>
            ) : createMethod === "existing" ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                新账簿管理员将使用当前验证账户：{existingCreateAdminAccountLabel()}
              </div>
            ) : null}
            {error && <div className="text-sm text-red-600">{error}</div>}
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

        {/* The fixed action bar: sibling of the scrolling body, not part of it,
            so "create and enter" is on screen without scrolling however tall the
            form grows. It also no longer hides — it used to live inside the MMH
            tab's panel and vanish while that tab's signup shape was open (that
            shape carried its own submit button). `submitCreateLedger` dispatches
            to whichever flow the current shape needs, so this one button is
            always actionable. */}
        {mode === "create" && (
          <div className="shrink-0 space-y-3 border-t border-slate-200 bg-white/95 px-6 pb-6 pt-3">
            <button
              type="button"
              className="h-10 w-full rounded-md bg-blue-600 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              disabled={loading || registerLoading}
              onClick={() => void submitCreateLedger()}
            >
              {loading || registerLoading ? t("login.creating") : t("login.createAndEnter")}
            </button>
            {/* The way out sits under the primary action, not inside the
                scrolling body, so the two always appear together. Kept off the
                first-ledger setup: an empty deployment has no account to return
                to. */}
            {!initialLedgerSetup && (
              <button
                type="button"
                className="w-full text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50"
                disabled={loading}
                onClick={backToLoginFromCreate}
              >
                {t("login.backToLogin")}
              </button>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
