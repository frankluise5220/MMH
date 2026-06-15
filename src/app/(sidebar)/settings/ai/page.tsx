"use client";

import { useState, useEffect } from "react";
import { CHANNEL_TYPES, getModelsUrl } from "@/lib/ai/config";

type ModelEntry = {
  id: string;
  name: string;
  channelId: string;
  channelType: string;
  channelName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  category?: string;
  supportsVision?: boolean;
};

const MODELS_KEY = "wiseme_ai_models";
const ACTIVE_MODEL_KEY = "wiseme_ai_active_model";

function genId() { return Math.random().toString(36).slice(2, 10); }

function detectModelInfo(id: string) {
  const lower = id.toLowerCase();
  const supportsVision = /gpt-4o|vision|qwen[-_]?vl|glm-4v|internvl|llava|pix|multimodal|mm/.test(lower);
  const category = supportsVision ? "vision"
    : /embed|embedding/.test(lower) ? "embedding"
    : /whisper|audio|tts|speech|transcrib/.test(lower) ? "audio"
    : /dall|image|sdxl|stable[-_ ]diffusion|flux/.test(lower) ? "image"
    : "text";
  return { id, category, supportsVision };
}

function categoryLabel(category: string) {
  if (category === "vision") return "识图";
  if (category === "embedding") return "向量";
  if (category === "audio") return "语音";
  if (category === "image") return "图像";
  return "文本";
}

function loadModels(): ModelEntry[] {
  try { const raw = localStorage.getItem(MODELS_KEY); if (raw) return JSON.parse(raw); } catch {}
  return [];
}
function saveModels(models: ModelEntry[]) {
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(models)); } catch {}
}
function loadActiveModel(): string {
  try { return localStorage.getItem(ACTIVE_MODEL_KEY) ?? ""; } catch { return ""; }
}
function saveActiveModel(name: string) {
  try { localStorage.setItem(ACTIVE_MODEL_KEY, name); } catch {}
}

async function fetchModelsForChannel(baseUrl: string, apiKey: string, modelsUrl: string) {
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

function ModelModal({
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
  const [channelType, setChannelType] = useState(initial?.channelType ?? initial?.channelId ?? "openai");
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
      const models = await fetchModelsForChannel(baseUrl.trim(), apiKey.trim(), getModelsUrl(channelType));
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
      id: initial?.id ?? genId(), name, channelId: "", channelType,
      channelName: name,
      baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: selectedModel,
      category: info.category, supportsVision: info.supportsVision,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">
            {step === "config" ? (initial ? "编辑模型" : "添加模型 - 配置渠道") : (initial ? "编辑模型 - 选择模型" : "添加模型 - 选择模型")}
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

export default function AiModelsPage() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModel, setActiveModel] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);
  const [quickAdd, setQuickAdd] = useState<ModelEntry | null>(null); // + 号：用同渠道快速添加
  const [quickModelList, setQuickModelList] = useState<ModelInfo[]>([]);
  const [quickSelected, setQuickSelected] = useState("");
  const [quickFetching, setQuickFetching] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null); // 下拉菜单打开的模型 id

  useEffect(() => {
    setModels(loadModels());
    setActiveModel(loadActiveModel());
    syncModelsToDB();
  }, []);

  async function syncModelsToDB() {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json();
      const dbModelCount = (data.ok && data.channels) ? data.channels.reduce((s: number, c: any) => s + (c.AiModel?.length ?? 0), 0) : 0;
      const localModels = loadModels();
      if (localModels.length === 0 || dbModelCount >= localModels.length) return;
      const localActive = loadActiveModel();
      for (const m of localModels) {
        const chRes = await fetch("/api/v1/settings/ai-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: m.channelName || m.name, channelType: m.channelType || "custom", baseUrl: m.baseUrl, apiKey: m.apiKey }),
        });
        const chData = await chRes.json();
        if (!chData.ok || !chData.channel) continue;
        await fetch("/api/v1/settings/ai-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: m.model, name: m.name, channelId: chData.channel.id, vision: m.supportsVision || false }),
        });
        if ((m.name || m.model) === localActive) {
          const modelRes = await fetch("/api/v1/settings/ai-config");
          const modelData = await modelRes.json();
          const matchModel = modelData.channels?.flatMap((c: any) => c.AiModel).find((mm: any) => mm.model === m.model);
          if (matchModel) {
            await fetch("/api/v1/settings/ai-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ activeModelId: matchModel.id }),
            });
          }
        }
      }
    } catch { /* ignore */ }
  }

  function handleAddModel(entry: ModelEntry) {
    const existingIdx = models.findIndex(m => m.id === entry.id);
    const next = existingIdx >= 0
      ? models.map((m, i) => i === existingIdx ? entry : m)
      : [...models, entry];
    setModels(next); saveModels(next);
    if (!activeModel) { setActiveModel(entry.name || entry.model); saveActiveModel(entry.name || entry.model); }
    setShowModal(false);
  }

  function handleRemoveModel(id: string) {
    const removed = models.find(m => m.id === id);
    const next = models.filter(m => m.id !== id);
    setModels(next); saveModels(next);
    if (activeModel === (removed?.name || removed?.model)) {
      const fallback = next[0];
      const name = fallback?.name || fallback?.model || "";
      setActiveModel(name); saveActiveModel(name);
    }
    setMenuOpen(null);
  }

  function handleSetDefault(name: string) {
    setActiveModel(name); saveActiveModel(name);
    setMenuOpen(null);
  }

  // + 号：用同渠道快速添加模型
  async function handleQuickAdd(channel: ModelEntry) {
    setQuickAdd(channel); setQuickFetching(true); setQuickSelected("");
    try {
      const type = CHANNEL_TYPES.find(t => t.id === channel.channelId) ?? CHANNEL_TYPES[0];
      const modelsInfo = await fetchModelsForChannel(channel.baseUrl, channel.apiKey, type.modelsUrl);
      setQuickModelList(modelsInfo);
      setQuickSelected(modelsInfo[0]?.id ?? "");
    } catch {
      setQuickModelList([]);
    } finally {
      setQuickFetching(false);
    }
  }

  function confirmQuickAdd() {
    if (!quickAdd || !quickSelected) return;
    const info = quickModelList.find(m => m.id === quickSelected) ?? detectModelInfo(quickSelected);
    const entry: ModelEntry = {
      id: genId(),
      name: quickSelected,
      channelId: quickAdd.channelId,
      channelType: quickAdd.channelType || "custom",
      channelName: quickAdd.channelName,
      baseUrl: quickAdd.baseUrl,
      apiKey: quickAdd.apiKey,
      model: quickSelected,
      category: info.category,
      supportsVision: info.supportsVision,
    };
    const next = [...models, entry];
    setModels(next); saveModels(next);
    if (!activeModel) { setActiveModel(entry.name || entry.model); saveActiveModel(entry.name || entry.model); }
    setQuickAdd(null);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">AI 模型</h2>
          <p className="mt-1 text-xs text-slate-500">为每个模型配置独立的渠道。点击 + 号可基于同渠道快速添加新模型。</p>
        </div>
        <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
          onClick={() => { setEditingModel(null); setShowModal(true); }}>
          + 新渠道
        </button>
      </div>

      {models.length > 0 ? (
        <div className="flex flex-col gap-1.5 bg-white border border-slate-200 rounded-md p-3">
          {models.map((m) => {
            const name = m.name || m.model;
            const isActive = activeModel === name;
            const info = detectModelInfo(m.model);
            const category = m.category ?? info.category;
            const supportsVision = m.supportsVision ?? info.supportsVision;
            return (
              <div key={m.id} className={`flex items-center gap-2 h-10 px-3 rounded-md border ${isActive ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}>
                <span className={`flex-1 text-sm truncate ${isActive ? "text-blue-700 font-medium" : "text-slate-800"}`}>{name}</span>
                <span className="text-[11px] text-slate-400 shrink-0">{m.channelId}</span>
                <span className="text-[11px] text-slate-500 shrink-0">{categoryLabel(category)}</span>
                {supportsVision && <span className="text-[11px] text-emerald-700 shrink-0">识图</span>}
                {isActive && <span className="text-[11px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full shrink-0">默认</span>}
                {/* + 号：用同渠道添加 */}
                <button className="text-slate-400 hover:text-blue-600 shrink-0 text-sm font-bold" title="基于此渠道添加新模型"
                  onClick={() => handleQuickAdd(m)}>+</button>
                {/* 下拉菜单 */}
                <div className="relative shrink-0">
                  <button className="text-slate-400 hover:text-slate-600 text-xs" onClick={() => setMenuOpen(menuOpen === m.id ? null : m.id)}>⋮</button>
                  {menuOpen === m.id && (
                    <div className="absolute right-0 top-8 z-20 bg-white border border-slate-200 rounded-md shadow-lg py-1 min-w-[120px]">
                      {!isActive && (
                        <button className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-blue-50"
                          onClick={() => handleSetDefault(name)}>设为默认</button>
                      )}
                      <button className="w-full px-3 py-1.5 text-xs text-left text-slate-700 hover:bg-slate-50"
                        onClick={() => { setEditingModel(m); setShowModal(true); setMenuOpen(null); }}>编辑</button>
                      <button className="w-full px-3 py-1.5 text-xs text-left text-red-600 hover:bg-red-50"
                        onClick={() => handleRemoveModel(m.id)}>删除</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md bg-white">
          <span>暂无模型</span>
          <button className="mt-1 text-blue-600 hover:text-blue-700 text-xs" onClick={() => setShowModal(true)}>+ 添加第一个模型</button>
        </div>
      )}

      {/* 快速添加弹窗 */}
      {quickAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">从 {quickAdd.channelName || quickAdd.channelId} 添加新模型</div>
            </div>
            <div className="p-5 space-y-3">
              {quickFetching ? (
                <div className="text-sm text-slate-500 text-center py-4">获取模型列表中…</div>
              ) : quickModelList.length > 0 ? (
                <>
                  <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={quickSelected} onChange={e => setQuickSelected(e.target.value)}>
                    {quickModelList.map(m => (
                      <option key={m.id} value={m.id}>{m.id}{m.supportsVision ? "（识图）" : ""}</option>
                    ))}
                  </select>
                  {quickModelList.length <= 20 && (
                    <div className="max-h-40 overflow-auto rounded-md border border-slate-200">
                      {quickModelList.map(m => (
                        <div key={m.id} className={`px-3 py-2 text-sm cursor-pointer ${m.id === quickSelected ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                          onClick={() => setQuickSelected(m.id)}>
                          <span className="truncate">{m.id}</span>
                          <span className="text-[11px] text-slate-500 ml-2">{categoryLabel(m.category)}</span>
                          {m.supportsVision && <span className="text-[11px] text-emerald-700 ml-1">识图</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-red-600 text-center py-4">未获取到模型，请检查渠道配置</div>
              )}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => setQuickAdd(null)}>取消</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={confirmQuickAdd} disabled={!quickSelected}>确认添加</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <ModelModal
          initial={editingModel ?? undefined}
          onSave={handleAddModel}
          onCancel={() => { setShowModal(false); setEditingModel(null); }}
        />
      )}
    </div>
  );
}
