import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function joinBaseUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith("/v1") && p.startsWith("/v1/")) return `${base}${p.slice(3)}`;
  if (base.endsWith("/v1") && p.startsWith("/api/")) return `${base.slice(0, -3)}${p}`;
  return `${base}${p}`;
}

function detectModelInfo(id: string, raw: unknown) {
  const lower = id.toLowerCase();
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const capabilities = obj && typeof obj.capabilities === "object" ? (obj.capabilities as Record<string, unknown>) : null;
  const modalities = obj && Array.isArray(obj.modalities) ? (obj.modalities as unknown[]) : null;

  const supportsVision =
    (capabilities?.vision === true ||
      capabilities?.image === true ||
      capabilities?.multimodal === true ||
      (Array.isArray(modalities) &&
        modalities.some((m) => typeof m === "string" && /image|vision|multimodal/i.test(m)))) ||
    /gpt-4o|vision|qwen[-_]?vl|glm-4v|internvl|llava|pix|multimodal|mm/.test(lower);

  const category =
    supportsVision
      ? "vision"
      : /embed|embedding/.test(lower)
        ? "embedding"
        : /whisper|audio|tts|speech|transcrib/.test(lower)
          ? "audio"
          : /dall|image|sdxl|stable[-_ ]diffusion|flux/.test(lower)
            ? "image"
            : "text";

  return { id, category, supportsVision };
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { baseUrl?: string; apiKey?: string; modelsUrl?: string };
  const { baseUrl, apiKey, modelsUrl } = body;

  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "缺少 baseUrl" }, { status: 400 });
  }

  const cleanUrl = baseUrl.replace(/\/$/, "");
  const suffix = modelsUrl || "/v1/models";
  const url = joinBaseUrl(cleanUrl, suffix);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const key = (apiKey ?? "").trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return NextResponse.json(
        { ok: false, error: `HTTP ${response.status}: ${text}` },
        { status: response.status },
      );
    }

    const data = await response.json() as Record<string, unknown>;
    const raw: unknown[] = Array.isArray(data.data) ? data.data
      : Array.isArray(data.models) ? data.models as unknown[]
      : Array.isArray(data) ? data as unknown[]
      : [];

    const modelInfos = raw
      .map((m) => {
        if (typeof m === "string") return detectModelInfo(m, m);
        const obj = m as Record<string, unknown>;
        const id = String(obj.id ?? obj.name ?? "").trim();
        if (!id) return null;
        return detectModelInfo(id, m);
      })
      .filter((x): x is { id: string; category: string; supportsVision: boolean } => !!x);

    const models = modelInfos.map((m) => m.id);

    return NextResponse.json({ ok: true, models, modelInfos });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "请求失败" },
      { status: 500 },
    );
  }
}
