import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { joinBaseUrl } from "@/lib/http";
import { normalizeAiApiMode } from "@/lib/ai/config";
import { buildResponsesRequestBody, extractResponsesText } from "@/lib/ai/responses";
import {
  AiTransportError,
  aiFailureFromResponse,
  aiFailurePayload,
  aiFetch,
  classifyAiFailure,
  describeAiFailureForLog,
} from "@/lib/ai/errors";

export const runtime = "nodejs";

/**
 * POST /api/v1/ai/test — "does this configuration actually work?"
 *
 * The settings page could only probe `/v1/models`, which can succeed while the
 * chat endpoint still fails (wrong key scope, out of quota, gateway that only
 * proxies model lists). This sends one minimal completion with a hard 15s
 * ceiling, so the answer is about the same request the AI panel will make.
 *
 * Always answers 200 with `ok: true|false`: the caller renders the i18n keys,
 * and a failed probe is a normal outcome, not a transport error.
 */
const BodySchema = z.object({
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().trim().max(4096).optional(),
  model: z.string().trim().min(1).max(200),
  apiMode: z.string().trim().max(20).optional(),
  channelType: z.string().trim().max(50).optional(),
});

const TEST_TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "AI_BAD_REQUEST", messageKey: "aiError.badRequest", error: "服务地址或模型不能为空" },
      { status: 400 },
    );
  }

  const { baseUrl, apiKey, model, channelType } = parsed.data;
  const apiMode = normalizeAiApiMode(parsed.data.apiMode);
  const isOllama = channelType === "ollama";

  let url: string;
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    url = joinBaseUrl(
      baseUrl,
      isOllama ? "/api/chat" : apiMode === "responses" ? "/v1/responses" : "/v1/chat/completions",
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: "AI_UNREACHABLE", messageKey: "aiError.unreachable", error: "AI 服务地址无效，请使用 http:// 或 https:// 开头的地址" },
      { status: 200 },
    );
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = (apiKey ?? "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const message = { role: "user" as const, content: "ping" };
  const body = isOllama
    ? { model, stream: false, messages: [message], options: { num_predict: 1 } }
    : apiMode === "responses"
      ? buildResponsesRequestBody({ modelName: model, userMessage: "ping", maxOutputTokens: 16 })
      : { model, messages: [message], max_tokens: 16, temperature: 0 };

  const startedAt = Date.now();
  try {
    const res = await aiFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs: TEST_TIMEOUT_MS });
    if (!res.ok) {
      const failure = await aiFailureFromResponse(res);
      console.warn(describeAiFailureForLog(failure, "ai/test"));
      return NextResponse.json(aiFailurePayload(failure), { status: 200 });
    }
    const data = (await res.json().catch(() => null)) as
      | { message?: { content?: string | null }; response?: string | null; choices?: Array<{ message?: { content?: string | null } }> }
      | null;
    // A 2xx with a parseable body proves the whole chain works; the content may be
    // empty because we deliberately cap the completion length.
    const text = isOllama
      ? data?.message?.content ?? data?.response ?? ""
      : apiMode === "responses"
        ? extractResponsesText(data)
        : data?.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({
      ok: true,
      model,
      latencyMs: Date.now() - startedAt,
      contentLength: text.length,
    });
  } catch (error) {
    const failure = error instanceof AiTransportError ? error.failure : classifyAiFailure({ error });
    console.warn(describeAiFailureForLog(failure, "ai/test"));
    return NextResponse.json(aiFailurePayload(failure), { status: 200 });
  }
}
