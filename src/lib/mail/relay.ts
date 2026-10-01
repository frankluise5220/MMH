/**
 * Client for the self-hosted verification-code mail relay.
 *
 * The MMH app cannot reliably reach api.resend.com from some deployments
 * (TLS/proxy egress gets reset), so it sends a minimal payload to the project's
 * own mail server, which relays it through the local Postfix.
 *
 * Security boundary (do NOT relax):
 *   - Only the verification-code use case is sent. The payload carries the
 *     recipient, the code, and the expiry; it never carries a password, an SMTP
 *     credential, or arbitrary subject/body/HTML.
 *   - Auth is an independent relay token (not the admin back-office cookie).
 */

export interface MailRelayConfig {
  url: string;
  token: string;
}

export function getMailRelayConfig(): MailRelayConfig {
  const url = (process.env.MMH_MAIL_RELAY_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.MMH_MAIL_RELAY_TOKEN ?? "").trim();
  return { url, token };
}

export function isMailRelayConfigured(): boolean {
  const { url, token } = getMailRelayConfig();
  return url.length > 0 && token.length > 0;
}

export type RelaySendResult = { ok: boolean; error?: string };

/**
 * Sends a verification code through the relay. Returns { ok: false } with a
 * descriptive error when the relay is unreachable or rejects the request.
 */
export async function sendVerificationCodeByRelay(params: {
  to: string;
  code: string;
  expiresMinutes: number;
}): Promise<RelaySendResult> {
  const { url, token } = getMailRelayConfig();
  if (!url || !token) {
    return { ok: false, error: "Mail relay is not configured on this server." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response: Response;
  try {
    response = await fetch(`${url}/api/mmh/relay/send-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: params.to,
        code: params.code,
        expiresMinutes: params.expiresMinutes,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const timedOut = error instanceof Error && error.name === "AbortError";
    const detail = error instanceof Error && error.message && error.message !== "fetch failed"
      ? `（${error.message}）`
      : "";
    return {
      ok: false,
      error: timedOut
        ? "连接邮件中继超时（15 秒）。请检查 MMH 到邮件中继服务器的 DNS、HTTPS 出站和代理配置。"
        : `连接邮件中继失败${detail}。请检查 MMH 到邮件中继服务器的 DNS、HTTPS 出站和代理配置。`,
    };
  }
  clearTimeout(timeout);

  let payload: { ok?: boolean; error?: string } | null = null;
  try {
    const raw = (await response.json()) as unknown;
    if (raw && typeof raw === "object") payload = raw as { ok?: boolean; error?: string };
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      error: typeof payload?.error === "string" && payload.error
        ? payload.error
        : `邮件中继返回 HTTP ${response.status}。`,
    };
  }

  return { ok: true };
}
