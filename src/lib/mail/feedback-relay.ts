import type { MailAttachment } from "@/lib/mail/types";

const DEFAULT_FEEDBACK_RELAY_URL = "https://feedback.floatingice.win/v1/feedback";
const RELAY_TIMEOUT_MS = 30_000;

export type FeedbackRelayResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      error: string;
      status: number;
      retryAfterSeconds?: number;
    };

/**
 * Resolves the project feedback relay endpoint.
 *
 * An unset variable uses the built-in public relay. Setting the variable to an
 * empty string disables the relay fallback for private deployments.
 */
export function getFeedbackRelayUrl(): string | null {
  const configured = process.env.MMH_FEEDBACK_RELAY_URL;
  if (configured !== undefined) {
    return configured.trim() || null;
  }
  return DEFAULT_FEEDBACK_RELAY_URL;
}

/** Sends already-rendered feedback through the project-owned relay. */
export async function sendFeedbackByRelay(params: {
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  installationId: string;
  attachments?: MailAttachment[];
}): Promise<FeedbackRelayResult> {
  const relayUrl = getFeedbackRelayUrl();
  if (!relayUrl) {
    return {
      ok: false,
      code: "RELAY_DISABLED",
      error: "Feedback relay is disabled.",
      status: 503,
    };
  }

  const form = new FormData();
  form.set("subject", params.subject);
  form.set("text", params.text);
  if (params.html) form.set("html", params.html);
  if (params.replyTo) form.set("replyTo", params.replyTo);

  for (const attachment of params.attachments ?? []) {
    const bytes = new Uint8Array(attachment.content);
    form.append(
      "attachments",
      new Blob([bytes], { type: attachment.contentType }),
      attachment.filename,
    );
  }

  try {
    const response = await fetch(relayUrl, {
      method: "POST",
      headers: {
        "x-mmh-installation-id": params.installationId,
      },
      body: form,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => null) as {
      ok?: boolean;
      code?: string;
      error?: string;
      retryAfterSeconds?: number;
    } | null;

    if (response.ok && data?.ok) return { ok: true };
    return {
      ok: false,
      code: data?.code || "RELAY_FAILED",
      error: data?.error || `Feedback relay returned HTTP ${response.status}.`,
      status: response.status,
      retryAfterSeconds: data?.retryAfterSeconds,
    };
  } catch (error) {
    return {
      ok: false,
      code: "RELAY_UNAVAILABLE",
      error: error instanceof Error ? error.message : "Feedback relay is unavailable.",
      status: 502,
    };
  }
}
