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
    return {
      ok: false,
      status: 503,
      code: "REGISTRATION_SERVICE_UNREACHABLE",
      error: timedOut
        ? "The registration service timed out."
        : "The registration service is unreachable.",
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
      error: typeof payload?.error === "string" ? payload.error : `Registration service returned HTTP ${response.status}.`,
    };
  }

  return {
    ok: true,
    principalId: typeof payload.data?.principalId === "string" ? payload.data.principalId : undefined,
    identityId: typeof payload.data?.identityId === "string" ? payload.data.identityId : null,
    createdAt: typeof payload.data?.createdAt === "string" ? payload.data.createdAt : undefined,
  };
}
