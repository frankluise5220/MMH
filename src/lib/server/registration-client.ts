/**
 * Client for the external mmh-registration service.
 *
 * The mmh-registration service is a standalone Node process that issues the
 * global, platform-independent principalId for MMH. It is intentionally kept
 * separate from the MMH app: it does not authenticate MMH users and does not
 * store ledger data. This module only needs to create a principal plus an
 * email login identity so the local user can be tied to a central identity.
 *
 * API contract (verified against the deployed service):
 *   POST {baseUrl}/v1/registrations
 *     body: { displayName?, identity?:{ provider, issuer?, subject, displayName? },
 *             installation?:{ platform, deviceName?, publicKey } }
 *     -> 201 { ok:true, data:{ principalId, identityId, installationId, createdAt } }
 *     -> error { ok:false, code, error } (401 UNAUTHORIZED, 400 VALIDATION_ERROR,
 *        409 IDENTITY_ALREADY_BOUND / INSTALLATION_ALREADY_BOUND, ...)
 * All /v1 endpoints require `Authorization: Bearer <token>`.
 */

import "@/lib/net/prefer-ipv4";

/**
 * The registration service answers in English with machine codes. Map the
 * user-facing ones to Chinese so the MMH UI never leaks raw English — the code
 * is the stable contract, the message is presentation. Anything not mapped
 * falls back to the caller's own localized copy, never the raw English string.
 */
const REGISTRATION_ERROR_MESSAGES: Record<string, string> = {
  PRINCIPAL_NOT_FOUND: "该邮箱未注册 MMH 账户",
  IDENTITY_ALREADY_BOUND: "该邮箱已注册 MMH 账户",
  INVALID_CREDENTIALS: "邮箱或密码错误",
  PASSWORD_NOT_SET: "该账户尚未设置密码",
  PRINCIPAL_DISABLED: "该账户已被禁用",
  INSTALLATION_ALREADY_BOUND: "该设备已注册",
};

/** Localizes a registration-service error code to Chinese, else returns null. */
export function localizeRegistrationError(code: string | undefined): string | null {
  if (!code) return null;
  return REGISTRATION_ERROR_MESSAGES[code] ?? null;
}

export interface RegistrationConfig {
  baseUrl: string;
  apiToken: string;
}

export function getRegistrationConfig(): RegistrationConfig {
  const baseUrl = (process.env.MMH_REGISTRATION_API_URL ?? "").trim().replace(/\/+$/, "");
  const apiToken = (process.env.MMH_REGISTRATION_API_TOKEN ?? "").trim();
  return { baseUrl, apiToken };
}

/** True only when both the URL and the bearer token are configured. */
export function isRegistrationConfigured(): boolean {
  const { baseUrl, apiToken } = getRegistrationConfig();
  return baseUrl.length > 0 && apiToken.length > 0;
}

export interface RegisterEmailPrincipalResult {
  ok: boolean;
  principalId?: string;
  identityId?: string | null;
  createdAt?: string;
  status?: number;
  code?: string;
  error?: string;
}

/**
 * Creates a principal with an email login identity in the registration service.
 *
 * The identity uses provider="email", issuer="mmh", subject=<email>, so the
 * same email can only be bound once across all MMH deployments that share the
 * registration service.
 */
export async function registerEmailPrincipal(params: {
  displayName?: string | null;
  email: string;
}): Promise<RegisterEmailPrincipalResult> {
  const { baseUrl, apiToken } = getRegistrationConfig();
  if (!baseUrl || !apiToken) {
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_NOT_CONFIGURED",
      error: "The registration service is not configured on this server.",
    };
  }

  const body = {
    displayName: params.displayName?.trim() || null,
    identity: {
      provider: "email",
      issuer: "mmh",
      subject: params.email.trim().toLowerCase(),
      displayName: params.displayName?.trim() || null,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/registrations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const timedOut = error instanceof Error && error.name === "AbortError";
    const detail = error instanceof Error && error.message && error.message !== "fetch failed"
      ? ` (${error.message})`
      : "";
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_SERVICE_UNREACHABLE",
      error: timedOut
        ? "The MMH registration service timed out after 8 seconds. Check DNS, HTTPS egress, and proxy settings."
        : `The MMH registration service is unreachable${detail}. Check DNS, HTTPS egress, and proxy settings.`,
    };
  }
  clearTimeout(timeout);

  interface RegistrationPayload {
    ok?: boolean;
    data?: { principalId?: string; identityId?: string; createdAt?: string };
    code?: string;
    error?: string;
  }

  let payload: RegistrationPayload | null = null;
  try {
    const raw = (await response.json()) as unknown;
    if (raw && typeof raw === "object") payload = raw as RegistrationPayload;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : "REGISTRATION_SERVICE_ERROR",
      error: localizeRegistrationError(typeof payload?.code === "string" ? payload.code : undefined)
        ?? (typeof payload?.error === "string" ? payload.error : `Registration service returned HTTP ${response.status}.`),
    };
  }

  return {
    ok: true,
    principalId: typeof payload.data?.principalId === "string" ? payload.data.principalId : undefined,
    identityId: typeof payload.data?.identityId === "string" ? payload.data.identityId : null,
    createdAt: typeof payload.data?.createdAt === "string" ? payload.data.createdAt : undefined,
  };
}

export interface VerifyEmailPrincipalResult {
  ok: boolean;
  principalId?: string;
  status?: number;
  code?: string;
  error?: string;
}

async function postRegistrationAuth(
  endpoint: "verify" | "set-password",
  params: { email: string; password: string },
): Promise<VerifyEmailPrincipalResult> {
  const { baseUrl, apiToken } = getRegistrationConfig();
  if (!baseUrl || !apiToken) {
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_NOT_CONFIGURED",
      error: "The registration service is not configured on this server.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/auth/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        email: params.email.trim().toLowerCase(),
        password: params.password,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_SERVICE_UNREACHABLE",
      error: timedOut
        ? "The MMH registration service timed out after 8 seconds. Check DNS, HTTPS egress, and proxy settings."
        : "The MMH registration service is unreachable. Check DNS, HTTPS egress, and proxy settings.",
    };
  }
  clearTimeout(timeout);

  interface AuthPayload {
    ok?: boolean;
    data?: { principalId?: string };
    code?: string;
    error?: string;
  }

  let payload: AuthPayload | null = null;
  try {
    const raw = (await response.json()) as unknown;
    if (raw && typeof raw === "object") payload = raw as AuthPayload;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : "REGISTRATION_SERVICE_ERROR",
      error: localizeRegistrationError(typeof payload?.code === "string" ? payload.code : undefined)
        ?? (typeof payload?.error === "string" ? payload.error : `Registration service returned HTTP ${response.status}.`),
    };
  }

  return {
    ok: true,
    principalId: typeof payload.data?.principalId === "string" ? payload.data.principalId : undefined,
  };
}

/**
 * Verifies an email + password against the central MMH registration service and
 * returns the principalId when the credentials are correct. This is the only
 * authoritative way to bind an existing MMH membership account — the password
 * is never compared against a local ledger password hash.
 */
export async function verifyEmailPrincipal(params: {
  email: string;
  password: string;
}): Promise<VerifyEmailPrincipalResult> {
  return postRegistrationAuth("verify", params);
}

/**
 * Sets (or rotates) the password for an existing email-bound MMH principal.
 * Used when an MMH account is first bound, or to reset a forgotten password
 * after an out-of-band verification.
 */
export async function setEmailPrincipalPassword(params: {
  email: string;
  password: string;
}): Promise<VerifyEmailPrincipalResult> {
  return postRegistrationAuth("set-password", params);
}

export type RegistrationCodePurpose = "registration" | "password-reset";

export interface RegistrationCodeResult {
  ok: boolean;
  status?: number;
  code?: string;
  error?: string;
}

async function postRegistrationCode(
  endpoint: "send-code" | "verify-code",
  params: { email: string; purpose: RegistrationCodePurpose; code?: string },
): Promise<RegistrationCodeResult> {
  const { baseUrl, apiToken } = getRegistrationConfig();
  if (!baseUrl || !apiToken) {
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_NOT_CONFIGURED",
      error: "The registration service is not configured on this server.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/auth/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        email: params.email.trim().toLowerCase(),
        purpose: params.purpose,
        ...(params.code ? { code: params.code } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_SERVICE_UNREACHABLE",
      error: timedOut
        ? "The MMH registration service timed out after 8 seconds. Check DNS, HTTPS egress, and proxy settings."
        : "The MMH registration service is unreachable. Check DNS, HTTPS egress, and proxy settings.",
    };
  }
  clearTimeout(timeout);

  interface CodePayload {
    ok?: boolean;
    code?: string;
    error?: string;
  }

  let payload: CodePayload | null = null;
  try {
    const raw = (await response.json()) as unknown;
    if (raw && typeof raw === "object") payload = raw as CodePayload;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      status: response.status,
      code: typeof payload?.code === "string" ? payload.code : "REGISTRATION_SERVICE_ERROR",
      error: localizeRegistrationError(typeof payload?.code === "string" ? payload.code : undefined)
        ?? (typeof payload?.error === "string" ? payload.error : `Registration service returned HTTP ${response.status}.`),
    };
  }

  return { ok: true };
}

/**
 * Asks the registration service to generate and deliver a verification code to
 * `email`. The code is generated, stored (hashed), and emailed entirely by the
 * registration service through its local Postfix — the MMH app never sees the
 * plaintext code and no longer mints or sends these emails itself.
 */
export async function sendRegistrationCode(params: {
  email: string;
  purpose: RegistrationCodePurpose;
}): Promise<RegistrationCodeResult> {
  return postRegistrationCode("send-code", params);
}

/**
 * Verifies a code against the registration service. On success the code is
 * consumed (single-use); the MMH app only learns pass/fail, never the code.
 */
export async function verifyRegistrationCode(params: {
  email: string;
  purpose: RegistrationCodePurpose;
  code: string;
}): Promise<RegistrationCodeResult> {
  return postRegistrationCode("verify-code", params);
}
