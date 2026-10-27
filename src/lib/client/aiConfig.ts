"use client";

export const AI_CONFIG_CHANGED_EVENT = "mmh:ai-config:changed";

export function dispatchAiConfigChanged() {
  window.dispatchEvent(new Event(AI_CONFIG_CHANGED_EVENT));
}

/**
 * 当前选中模型的本地镜像 key。
 *
 * 真值在数据库（`AiModel.active`），这里只是给首屏同步读完用的缓存：
 * 写缓存时必须同时写库（`PUT /api/v1/settings/ai-config`，`activeModelId`），
 * 否则下一次 `reloadModels` 会用库里的旧值把这个缓存覆盖回去。
 */
export const AI_ACTIVE_MODEL_KEY = "mmh_ai_active_model";

export function loadActiveModel(): string {
  try {
    return localStorage.getItem(AI_ACTIVE_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveActiveModel(name: string) {
  try {
    localStorage.setItem(AI_ACTIVE_MODEL_KEY, name);
  } catch {}
}
