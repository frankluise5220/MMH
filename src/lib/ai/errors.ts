/**
 * AI failure surface: one classifier, one timeout wrapper, one payload shape.
 *
 * Why this exists: every AI call used to surface the provider's raw body to the
 * user (`LLM_CALL_FAILED: LLM 调用失败 (401): {"error":{"message":"Incorrect API
 * key provided..."}}`). That tells a household user nothing they can act on.
 *
 * Contract:
 *   - `detail` is for server logs only and MUST NOT be sent to the browser —
 *     provider error bodies can echo back part of the API key.
 *   - `messageKey` / `actionKey` are i18n keys; the client renders them with `t()`
 *     so the same failure reads naturally in every supported language.
 *   - `fallbackMessage` is a plain Chinese sentence for callers that do not run
 *     the i18n layer (MCP agents, older clients, curl).
 */

export type AiFailureCode =
  | "AI_AUTH_FAILED"
  | "AI_MODEL_NOT_FOUND"
  | "AI_RATE_LIMITED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_TIMEOUT"
  | "AI_UNREACHABLE"
  | "AI_BAD_REQUEST"
  | "AI_SERVER_ERROR"
  | "AI_EMPTY_RESPONSE"
  | "AI_UNKNOWN";

export type AiFailure = {
  code: AiFailureCode;
  /** HTTP status of the provider response, when there was one. */
  status?: number;
  messageKey: string;
  actionKey?: string;
  /** Plain Chinese sentence; safe to return to non-i18n callers. */
  fallbackMessage: string;
  /** Provider body / exception text. Server logs only. */
  detail?: string;
};

const QUOTA_PATTERN = /insufficient[_ ]?quota|quota|balance|billing|额度|余额|欠费/i;
const MODEL_PATTERN = /model[_ ]?not[_ ]?found|no such model|invalid model|does not exist|模型不存在|模型名称/i;
const NETWORK_PATTERN = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|fetch failed|network error|socket hang up/i;

function base(code: AiFailureCode, messageKey: string, fallbackMessage: string, actionKey?: string): AiFailure {
  return { code, messageKey, fallbackMessage, actionKey };
}

/**
 * Turn any provider failure (HTTP status + body, or a thrown fetch error) into a
 * stable, user-readable failure. Never throws.
 */
export function classifyAiFailure(input: {
  status?: number;
  body?: string;
  error?: unknown;
  timedOut?: boolean;
  /** Extra context appended to `detail`. Server log only. */
  detail?: string;
}): AiFailure {
  const body = (input.body ?? "").slice(0, 2000);
  const errorText = input.error instanceof Error ? `${input.error.name}: ${input.error.message}` : String(input.error ?? "");
  // AI SDK errors (APICallError) carry the provider status on the error itself,
  // so a `generateObject` throw can still be classified as 401 / 429 / 404.
  const errorRecord = input.error as { status?: unknown; statusCode?: unknown } | null;
  const derivedStatus =
    typeof errorRecord?.statusCode === "number"
      ? errorRecord.statusCode
      : typeof errorRecord?.status === "number"
        ? errorRecord.status
        : undefined;
  const status = input.status ?? derivedStatus;
  const detail = [input.detail ?? "", status ? `status=${status}` : "", body, errorText]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 2000);

  if (input.timedOut) {
    return {
      ...base(
        "AI_TIMEOUT",
        "aiError.timeout",
        "AI 服务长时间没有响应，已停止等待。",
        "aiError.action.retryLater",
      ),
      status,
      detail,
    };
  }

  if (status === 401 || status === 403) {
    return {
      ...base(
        "AI_AUTH_FAILED",
        "aiError.auth",
        "AI 服务的 API Key 无效或没有权限，请在设置里重新填写。",
        "aiError.action.openSettings",
      ),
      status,
      detail,
    };
  }

  if (status === 402 || (status !== undefined && QUOTA_PATTERN.test(body))) {
    return {
      ...base(
        "AI_QUOTA_EXCEEDED",
        "aiError.quota",
        "AI 服务账户额度不足，请检查服务商余额。",
        "aiError.action.openSettings",
      ),
      status,
      detail,
    };
  }

  if (status === 429) {
    return {
      ...base(
        "AI_RATE_LIMITED",
        "aiError.rateLimit",
        "AI 服务提示请求过于频繁，请稍后再试或换一个模型。",
        "aiError.action.retryLater",
      ),
      status,
      detail,
    };
  }

  if (status === 404 || MODEL_PATTERN.test(body)) {
    return {
      ...base(
        "AI_MODEL_NOT_FOUND",
        "aiError.modelNotFound",
        "指定的模型不存在，请重新获取模型列表后再选一次。",
        "aiError.action.refreshModels",
      ),
      status,
      detail,
    };
  }

  if (status === 400 || status === 422) {
    return {
      ...base(
        "AI_BAD_REQUEST",
        "aiError.badRequest",
        "AI 服务拒绝了这次请求，请检查模型名称与服务配置。",
        "aiError.action.openSettings",
      ),
      status,
      detail,
    };
  }

  if (status !== undefined && status >= 500) {
    return {
      ...base(
        "AI_SERVER_ERROR",
        "aiError.server",
        "AI 服务暂时不可用，请稍后重试。",
        "aiError.action.retryLater",
      ),
      status,
      detail,
    };
  }

  if (NETWORK_PATTERN.test(errorText)) {
    return {
      ...base(
        "AI_UNREACHABLE",
        "aiError.unreachable",
        "连不上 AI 服务地址，请检查地址、网络或服务是否已启动。",
        "aiError.action.checkNetwork",
      ),
      status,
      detail,
    };
  }

  return {
    ...base("AI_UNKNOWN", "aiError.unknown", "AI 调用失败，请稍后重试。", "aiError.action.retryLater"),
    status,
    detail,
  };
}

export class AiTransportError extends Error {
  readonly failure: AiFailure;

  constructor(failure: AiFailure) {
    super(failure.detail || failure.code);
    this.name = "AiTransportError";
    this.failure = failure;
  }
}

/** Default ceilings. A hung local Ollama must not spin the panel forever. */
export const AI_TIMEOUT_MS = {
  classify: 20_000,
  chat: 60_000,
  models: 10_000,
} as const;

function timeoutFor(kind: keyof typeof AI_TIMEOUT_MS): number {
  const override = Number(process.env.MMH_AI_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) return override;
  return AI_TIMEOUT_MS[kind];
}

/**
 * `fetch` with a hard timeout.
 *
 * Throws `AiTransportError` on timeout / network failure; a non-2xx response is
 * returned as-is so the caller can read the body and classify it with
 * `aiFailureFromResponse`.
 */
export async function aiFetch(
  url: string,
  init: RequestInit,
  options: { timeout?: keyof typeof AI_TIMEOUT_MS; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? timeoutFor(options.timeout ?? "chat");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new AiTransportError(
        classifyAiFailure({ timedOut: true, detail: `timeout ${timeoutMs}ms ${url}` }),
      );
    }
    // Caller-initiated aborts stay caller-initiated (component unmount etc).
    if (options.signal?.aborted) throw error;
    throw new AiTransportError(classifyAiFailure({ error }));
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function aiFailureFromResponse(response: Response): Promise<AiFailure> {
  const body = await response.text().catch(() => "");
  return classifyAiFailure({ status: response.status, body });
}

/**
 * Wire format returned to the browser. Deliberately excludes `detail`.
 */
export function aiFailurePayload(failure: AiFailure): {
  ok: false;
  code: AiFailureCode;
  error: string;
  messageKey: string;
  actionKey?: string;
} {
  return {
    ok: false,
    code: failure.code,
    error: failure.fallbackMessage,
    messageKey: failure.messageKey,
    ...(failure.actionKey ? { actionKey: failure.actionKey } : {}),
  };
}

export function describeAiFailureForLog(failure: AiFailure, context: string): string {
  return `[ai] ${context} -> ${failure.code}${failure.status ? ` (${failure.status})` : ""}: ${failure.detail ?? ""}`;
}
