// Shared model capability detection.
//
// Three call sites used to carry their own copy of the "does this model read
// images" heuristic:
//   1. the AI settings page (src/app/(sidebar)/settings/ai/client.tsx)
//   2. GET/POST /api/v1/ai/models
//   3. the /api/v1/ai/chat vision gate (src/lib/ai/client.ts)
// They drifted apart: (1) and (2) accept `glm-4v-*`, but (3) did not, so a model
// the settings page happily stored as vision-capable was rejected at upload time
// with VISION_NOT_SUPPORTED. Keep a single source of truth here.

export type ModelCategory = "vision" | "embedding" | "audio" | "image" | "text";

/** Substrings that only appear in vision-capable model families. */
const VISION_MODEL_KEYWORDS = [
  "gpt-4o",
  "gpt-4-turbo",
  "gpt-4-vision",
  "claude-3",
  "claude-3.5",
  "claude-3.7",
  "gemini-1.5",
  "gemini-2",
  "gemini-pro-vision",
  "qwen-vl",
  "qwen_vl",
  "qwen2-vl",
  "glm-4v",
  "internvl",
  "llava",
  "pixtral",
  "pix",
  "multimodal",
  "vision",
  "gemma3",
];

/** Provider-declared capabilities, when the model list API returns them. */
function declaresVision(raw: unknown): boolean {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj) return false;
  const capabilities =
    obj.capabilities && typeof obj.capabilities === "object"
      ? (obj.capabilities as Record<string, unknown>)
      : null;
  if (capabilities?.vision === true || capabilities?.image === true || capabilities?.multimodal === true) {
    return true;
  }
  const modalities = Array.isArray(obj.modalities) ? (obj.modalities as unknown[]) : null;
  return !!modalities && modalities.some((m) => typeof m === "string" && /image|vision|multimodal/i.test(m));
}

/**
 * Name-based heuristic, used when the provider declares nothing.
 * Deliberately permissive: a false positive only costs one failed call, while a
 * false negative blocks a model the user explicitly configured.
 */
export function modelNameSupportsVision(modelName: string): boolean {
  const lower = (modelName ?? "").toLowerCase();
  if (!lower) return false;
  if (VISION_MODEL_KEYWORDS.some((keyword) => lower.includes(keyword))) return true;
  // Short suffixes that only show up in vision families: qwen-vl, deepseek-vl2, gemma(mm)...
  return lower.includes("vl") || lower.includes("mm");
}

export function modelSupportsVision(modelName: string, raw?: unknown): boolean {
  return declaresVision(raw) || modelNameSupportsVision(modelName);
}

export function detectModelCategory(modelName: string, raw?: unknown): ModelCategory {
  if (modelSupportsVision(modelName, raw)) return "vision";
  const lower = (modelName ?? "").toLowerCase();
  if (/embed|embedding/.test(lower)) return "embedding";
  if (/whisper|audio|tts|speech|transcrib/.test(lower)) return "audio";
  if (/dall|image|sdxl|stable[-_ ]diffusion|flux/.test(lower)) return "image";
  return "text";
}

export function detectModelInfo(
  id: string,
  raw?: unknown,
): { id: string; category: string; supportsVision: boolean } {
  return { id, category: detectModelCategory(id, raw), supportsVision: modelSupportsVision(id, raw) };
}
