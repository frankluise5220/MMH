"use client";

import { useState } from "react";

export type ModelEntry = {
  id: string;
  name: string;
  channelId: string;
  channelName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  category?: string;
  supportsVision?: boolean;
};

export const CHANNEL_TYPES = [
  { id: "openai", label: "OpenAI", modelsUrl: "/v1/models" },
  { id: "anthropic", label: "Anthropic", modelsUrl: "/v1/models" },
  { id: "deepseek", label: "DeepSeek", modelsUrl: "/v1/models" },
  { id: "qwen", label: "通义千问", modelsUrl: "/v1/models" },
  { id: "local", label: "本地 / LocalAI", modelsUrl: "/v1/models" },
  { id: "ollama", label: "Ollama", modelsUrl: "/api/tags" },
  { id: "custom", label: "自定义兼容接口", modelsUrl: "/v1/models" },
];

export function genId() { return Math.random().toString(36).slice(2, 10); }

export function detectModelInfo(id: string) {
  const lower = id.toLowerCase();
  const supportsVision = /gpt-4o|vision|qwen[-_]?vl|glm-4v|internvl|llava|pix|multimodal|mm/.test(lower);
  const category = supportsVision ? "vision"
    : /embed|embedding/.test(lower) ? "embedding"
    : /whisper|audio|tts|speech|transcrib/.test(lower) ? "audio"
    : /dall|image|sdxl|stable[-_ ]diffusion|flux/.test(lower) ? "image"
    : "text";
  return { id, category, supportsVision };
}

export function categoryLabel(category: string) {
  if (category === "vision") return "识图";
  if (category === "embedding") return "向量";
  if (category === "audio") return "语音";
  if (category === "image") return "图像";
  return "文本";
}

export async function fetchModelsForChannel(baseUrl: string, apiKey: string, modelsUrl: string) {
  if (!baseUrl) return [];
  const res = await fetch("/api/v1/ai/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, apiKey, modelsUrl }),
  });
  const data = await res.json() as { ok: boolean; models?: string[]; modelInfos?: Array<{ id: string; category: string; supportsVision: boolean }> };
  if (!data.ok) throw new Error((data as any).error ?? "获取模型失败");
  if (Array.isArray(data.modelInfos) && data.modelInfos.length) return data.modelInfos;
  if (Array.isArray(data.models) && data.models.length) return data.models.map(m => detectModelInfo(m));
  return [];
}

type ModelInfo = ReturnType<typeof detectModelInfo>;

/**
 * 新增/修改模型共用弹窗
 * - initial 为空 = 新增流程（先配置渠道 → 获取模型 → 选择）
 * - initial 有值 = 编辑流程（显示当前配置，可更换模型）
 */
export function ModelModal({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ModelEntry;
  onSave: (entry: ModelEntry) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<"config" | "models">("config");
  const [channelName, setChannelName] = useState(initial?.name ?? "");
  const [channelType, setChannelType] = useState(initial?.channelId ?? "openai");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [modelList, setModelList] = useState<ModelInfo[]>(
    initial?.model ? [{ id: initial.model, category: initial.category ?? detectModelInfo(initial.model).category, supportsVision: initial.supportsVision ?? detectModelInfo(initial.model).supportsVision }] : []
  );
  const [selectedModel, setSelectedModel] = useState(initial?.model ?? "");
  const currentType = CHANNEL_TYPES.find(t => t.id === channelType) ?? CHANNEL_TYPES[0];

  async function handleFetch() {
    if (!baseUrl.trim()) { setError("请先填写 Base URL"); return; }
    if (channelType !== "ollama" && !apiKey.trim()) { setError("请先填写 API Key"); return; }
    setFetching(true); setError("");
    try {
      const models = await fetchModelsForChannel(baseUrl.trim(), apiKey.trim(), currentType.modelsUrl);
      if (models.length === 0) { setError("未获取到模型，请检查 URL 和 Key"); setFetching(false); return; }
      setModelList(models); setSelectedModel(models[0]?.id ?? ""); setStep("models");
    } catch (e) {
      setError(`获取失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally { setFetching(false); }
  }

  function handleConfirm() {
    if (!selectedModel) return;
    const name = channelName.trim() || selectedModel;
    const info = modelList.find(m => m.id === selectedModel) ?? detectModelInfo(selectedModel);
    onSave({
      id: initial?.id ?? genId(), name, channelId: channelType, channelName: name,
      baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: selectedModel,
      category: info.category, supportsVision: info.supportsVision,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">
            {step === "config" ? (initial ? "编辑模型" : "添加模型") : "选择模型"}
          </div>
        </div>
        <div className="p-5 space-y-4">
          {step === "config" ? (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">渠道名称</label>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="给这个模型配置起个名字（可选）" value={channelName} onChange={e => setChannelName(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">接口类型</label>
                <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={channelType} onChange={e => { setChannelType(e.target.value); if (e.target.value === "ollama") setBaseUrl("http://localhost:11434"); }}>
                  {CHANNEL_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Base URL</label>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="https://api.openai.com/v1" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">{channelType === "ollama" ? "API Key（可选）" : "API Key"}</label>
                <input type="password" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder={channelType === "ollama" ? "本地 Ollama 通常不需要" : "sk-..."} value={apiKey} onChange={e => setApiKey(e.target.value)} />
              </div>
              {initial && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">模型</label>
                  <div className="flex gap-2">
                    <input className="h-9 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none" value={selectedModel || initial.model || ""} readOnly />
                    <button className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={handleFetch} disabled={fetching}>{fetching ? "获取中…" : "更换"}</button>
                  </div>
                </div>
              )}
              {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">{error}</div>}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={onCancel}>取消</button>
                {initial ? (
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700" onClick={handleConfirm} disabled={!selectedModel}>保存</button>
                ) : (
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={handleFetch} disabled={fetching}>{fetching ? "获取中…" : "获取模型"}</button>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">选择模型（{modelList.length} 个可用）</label>
                <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                  {modelList.map(m => (
                    <option key={m.id} value={m.id}>{m.id}{m.supportsVision ? "（识图）" : ""}〔{categoryLabel(m.category)}〕</option>
                  ))}
                </select>
              </div>
              {modelList.length <= 20 && (
                <div className="max-h-48 overflow-auto rounded-md border border-slate-200">
                  {modelList.map(m => (
                    <div key={m.id} className={`px-3 py-2 text-sm cursor-pointer flex items-center justify-between ${m.id === selectedModel ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                      onClick={() => setSelectedModel(m.id)}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{m.id}</div>
                        <div className="mt-0.5 text-[11px] text-slate-500 flex items-center gap-2">
                          <span>{categoryLabel(m.category)}</span>
                          {m.supportsVision ? <span className="text-emerald-700">识图</span> : <span>不识图</span>}
                        </div>
                      </div>
                      {m.id === selectedModel && <span className="text-blue-500 text-xs shrink-0 ml-2">✓</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => setStep("config")}>上一步</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={handleConfirm} disabled={!selectedModel}>{initial ? "确认保存" : "确认添加"}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
