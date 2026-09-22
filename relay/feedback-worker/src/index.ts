const RATE_LIMIT_SECONDS = 30 * 60;
const MAX_ATTACHMENT_COUNT = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = MAX_ATTACHMENT_COUNT * MAX_ATTACHMENT_BYTES;
const ALLOWED_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DEFAULT_FEEDBACK_FROM = "mmh@floatingice.win";
const DEFAULT_FEEDBACK_TO = "mmh@floatingice.win";

type Env = {
  FEEDBACK_RATE_LIMITER: DurableObjectNamespace;
  RESEND_API_KEY?: string;
  FEEDBACK_FROM?: string;
  FEEDBACK_TO?: string;
};

type RateRecord = {
  sentAt: number;
  reservationId: string;
};

type RateDecision =
  | { allowed: true; reservationId: string }
  | { allowed: false; retryAfterSeconds: number };

type FeedbackAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

type FeedbackPayload = {
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  attachments: FeedbackAttachment[];
};

class RelayRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class FeedbackRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/consume") {
      return this.consume();
    }
    if (request.method === "POST" && url.pathname === "/release") {
      return this.release(request);
    }
    return json({ ok: false, code: "NOT_FOUND", error: "Not found." }, 404);
  }

  private async consume(): Promise<Response> {
    const now = Date.now();
    const last = await this.state.storage.get<RateRecord>("last");
    const windowMs = RATE_LIMIT_SECONDS * 1000;

    if (last && now - last.sentAt < windowMs) {
      return json({
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((last.sentAt + windowMs - now) / 1000)),
      });
    }

    const reservationId = crypto.randomUUID();
    await this.state.storage.put("last", { sentAt: now, reservationId } satisfies RateRecord);
    return json({ allowed: true, reservationId });
  }

  private async release(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { reservationId?: string } | null;
    const reservationId = String(body?.reservationId ?? "").trim();
    const last = await this.state.storage.get<RateRecord>("last");
    if (last && reservationId && last.reservationId === reservationId) {
      await this.state.storage.delete("last");
    }
    return json({ ok: true });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, data: { service: "mmh-feedback-relay" } });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/feedback") {
      return json({ ok: false, code: "NOT_FOUND", error: "Not found." }, 404);
    }

    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return json({ ok: false, code: "RELAY_NOT_CONFIGURED", error: "Feedback relay is not configured." }, 503);
    }

    const installationId = (request.headers.get("x-mmh-installation-id") ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(installationId)) {
      return json({ ok: false, code: "INVALID_INSTALLATION_ID", error: "A valid installation ID is required." }, 400);
    }

    let payload: FeedbackPayload;
    try {
      payload = await parseFeedbackPayload(request);
    } catch (error) {
      if (error instanceof RelayRequestError) {
        return json({ ok: false, code: error.code, error: error.message }, error.status);
      }
      return json({ ok: false, code: "INVALID_REQUEST", error: "The feedback request could not be read." }, 400);
    }

    let rateDecision: RateDecision;
    try {
      rateDecision = await consumeRateLimit(env, installationId);
    } catch (error) {
      console.error("Feedback rate limiter failed", error);
      return json({ ok: false, code: "RATE_LIMIT_UNAVAILABLE", error: "Feedback relay is temporarily unavailable." }, 503);
    }

    if (!rateDecision.allowed) {
      return json(
        {
          ok: false,
          code: "RATE_LIMITED",
          error: "Feedback can be submitted once every 30 minutes.",
          retryAfterSeconds: rateDecision.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(rateDecision.retryAfterSeconds) },
      );
    }

    const sendResult = await sendWithResend(env, apiKey, installationId, payload);
    if (!sendResult.ok) {
      await releaseRateLimit(env, installationId, rateDecision.reservationId);
      return json({ ok: false, code: "SEND_FAILED", error: sendResult.error }, sendResult.status);
    }

    return json({ ok: true });
  },
};

async function parseFeedbackPayload(request: Request): Promise<FeedbackPayload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new RelayRequestError("INVALID_CONTENT_TYPE", 415, "Multipart form data is required.");
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    throw new RelayRequestError("INVALID_REQUEST", 400, "The feedback request could not be read.");
  }

  const subject = readText(form.get("subject"), 240);
  const text = readText(form.get("text"), 20_000);
  const html = readText(form.get("html"), 60_000) || `<pre>${escapeHtml(text)}</pre>`;
  const replyTo = normalizeReplyTo(form.get("replyTo"));
  if (!subject) {
    throw new RelayRequestError("MISSING_SUBJECT", 400, "A subject is required.");
  }
  if (!text) {
    throw new RelayRequestError("MISSING_CONTENT", 400, "Feedback content is required.");
  }

  const files = form.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);
  if (files.length > MAX_ATTACHMENT_COUNT) {
    throw new RelayRequestError("TOO_MANY_ATTACHMENTS", 400, `Attach at most ${MAX_ATTACHMENT_COUNT} images.`);
  }

  let totalBytes = 0;
  const attachments: FeedbackAttachment[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      throw new RelayRequestError("ATTACHMENT_TYPE_NOT_ALLOWED", 415, "Only JPG, PNG, and WebP images can be attached.");
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw new RelayRequestError("ATTACHMENT_TOO_LARGE", 413, "Each image must be 5 MB or smaller.");
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new RelayRequestError("ATTACHMENTS_TOO_LARGE", 413, "The total attachment size is too large.");
    }

    attachments.push({
      filename: safeAttachmentName(file.name, index),
      content: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      contentType: file.type,
    });
  }

  return { subject, text, html, replyTo, attachments };
}

async function consumeRateLimit(env: Env, installationId: string): Promise<RateDecision> {
  const id = env.FEEDBACK_RATE_LIMITER.idFromName(installationId);
  const stub = env.FEEDBACK_RATE_LIMITER.get(id);
  const response = await stub.fetch("https://rate-limit/consume", { method: "POST" });
  if (!response.ok) throw new Error(`Rate limiter returned HTTP ${response.status}.`);
  return await response.json() as RateDecision;
}

async function releaseRateLimit(env: Env, installationId: string, reservationId: string) {
  try {
    const id = env.FEEDBACK_RATE_LIMITER.idFromName(installationId);
    const stub = env.FEEDBACK_RATE_LIMITER.get(id);
    await stub.fetch("https://rate-limit/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId }),
    });
  } catch (error) {
    console.warn("Failed to release feedback rate-limit reservation", error);
  }
}

async function sendWithResend(
  env: Env,
  apiKey: string,
  installationId: string,
  payload: FeedbackPayload,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const recipients = parseRecipients(env.FEEDBACK_TO?.trim() || DEFAULT_FEEDBACK_TO);
  if (recipients.length === 0) {
    return { ok: false, status: 503, error: "Feedback relay recipient is not configured." };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": `mmh-feedback-${installationId}-${Math.floor(Date.now() / (RATE_LIMIT_SECONDS * 1000))}`,
    },
    body: JSON.stringify({
      from: env.FEEDBACK_FROM?.trim() || DEFAULT_FEEDBACK_FROM,
      to: recipients,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      reply_to: payload.replyTo,
      attachments: payload.attachments.length > 0 ? payload.attachments : undefined,
    }),
  });

  const data = await response.json().catch(() => null) as {
    message?: string;
    name?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    return { ok: false, status: 502, error: normalizeResendError(data, response.status) };
  }
  return { ok: true };
}

function normalizeResendError(
  input: { message?: string; name?: string; error?: string } | null,
  status: number,
) {
  const raw = (input?.message || input?.error || "").trim();
  const lower = raw.toLowerCase();
  if (status === 401 || lower.includes("api key is invalid") || lower.includes("invalid api key")) {
    return "Resend API key is invalid.";
  }
  if (status === 403 || lower.includes("domain") || lower.includes("from")) {
    return "The Resend sender or domain is not authorized.";
  }
  return raw || `Resend returned HTTP ${status}.`;
}

function parseRecipients(value: string | undefined): string[] {
  const recipients = (value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item));
  return [...new Set(recipients)];
}

function normalizeReplyTo(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().slice(0, 320);
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate) ? candidate : undefined;
}

function readText(value: FormDataEntryValue | null, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function safeAttachmentName(name: string, index: number): string {
  const cleaned = name.trim().replace(/[\r\n]/g, "").replace(/[\\/]/g, "_").slice(0, 180);
  return cleaned || `feedback-image-${index + 1}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
