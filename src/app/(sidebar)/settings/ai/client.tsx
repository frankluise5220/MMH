"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsPageHeader,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { CHANNEL_TYPES, getModelsUrl } from "@/lib/ai/config";
import { parseBaseUrl, buildBaseUrl, PROTOCOL_OPTIONS, PORT_SUGGESTIONS, PATH_PLACEHOLDER } from "@/lib/urlInput";
import type { ParsedUrl } from "@/lib/urlInput";

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

export type InitialAiChannel = {
  id: string;
  name: string;
  channelType: string;
  baseUrl: string;
  apiKey: string;
  AiModel: Array<{ id: string; name: string | null; model: string; vision: boolean; active: boolean }>;
};

const MODELS_KEY = "mmh_ai_models";
const ACTIVE_MODEL_KEY = "mmh_ai_active_model";

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

function buildModelsFromServer(channels: InitialAiChannel[]): ModelEntry[] {
  const merged: ModelEntry[] = [];
  for (const ch of channels) {
    for (const m of ch.AiModel ?? []) {
      const info = detectModelInfo(m.model);
      merged.push({
        id: m.id,
        name: m.name || m.model,
        channelId: ch.id,
        channelType: ch.channelType || "custom",
        channelName: ch.name,
        baseUrl: ch.baseUrl,
        apiKey: ch.apiKey ?? "",
        model: m.model,
        category: info.category,
        supportsVision: m.vision || info.supportsVision,
      });
    }
  }
  return merged;
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

function UrlInputGroup({
  value,
  onChange,
}: {
  value: ParsedUrl;
  onChange: (next: ParsedUrl) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={value.protocol}
          onChange={e => onChange({ ...value, protocol: e.target.value })}
          className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm outline-none shrink-0"
        >
          {PROTOCOL_OPTIONS.map(op => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
        <span className="text-slate-300 text-sm font-mono">://</span>
        <input
          value={value.host}
          onChange={e => onChange({ ...value, host: e.target.value })}
          placeholder="api.example.com"
          className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
        <span className="text-slate-300 text-sm font-mono">:</span>
        <input
          value={value.port}
          onChange={e => onChange({ ...value, port: e.target.value })}
          type="number"
          placeholder="端口"
          list="port-suggestions"
          className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2.5 text-sm outline-none font-mono"
        />
        <datalist id="port-suggestions">
          {PORT_SUGGESTIONS.filter(s => s.value).map(s => (
            <option key={s.value} value={s.value}>{s.label} ({s.description})</option>
          ))}
        </datalist>
      </div>
      <div>
        <input
          value={value.path}
          onChange={e => onChange({ ...value, path: e.target.value })}
          placeholder={PATH_PLACEHOLDER}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
      </div>
    </div>
  );
}

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
  const [urlParts, setUrlParts] = useState<ParsedUrl>(parseBaseUrl(initial?.baseUrl));
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [modelList, setModelList] = useState<ModelInfo[]>(
    initial?.model ? [{ id: initial.model, category: initial.category ?? detectModelInfo(initial.model).category, supportsVision: initial.supportsVision ?? detectModelInfo(initial.model).supportsVision }] : []
  );
  const [selectedModel, setSelectedModel] = useState(initial?.model ?? "");

  const currentBaseUrl = buildBaseUrl(urlParts);

  async function handleFetch() {
    if (!currentBaseUrl) { setError("请先填写地址和域名"); return; }
    if (channelType !== "ollama" && !apiKey.trim()) { setError("请先填写 API Key"); return; }
    setFetching(true); setError("");
    try {
      const models = await fetchModelsForChannel(currentBaseUrl, apiKey.trim(), getModelsUrl(channelType));
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
      baseUrl: currentBaseUrl, apiKey: apiKey.trim(), model: selectedModel,
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
                <label className="block text-xs font-medium text-slate-600 mb-1.5">渠道类型</label>
                <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={channelType} onChange={e => { setChannelType(e.target.value); if (e.target.value === "ollama" && !urlParts.host) { setUrlParts({ protocol: "http:", host: "localhost", port: "11434", path: "" }); } }}>
                  {CHANNEL_TYPES.map(t => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">服务地址</label>
                <UrlInputGroup value={urlParts} onChange={setUrlParts} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">API Key</label>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  type="password" placeholder="sk-..." value={apiKey} onChange={e => setApiKey(e.target.value)} />
                {channelType === "ollama" && <p className="text-[11px] text-slate-400 mt-1">Ollama 无需 API Key</p>}
              </div>
              {error && <div className="text-xs text-red-600">{error}</div>}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  onClick={onCancel}>取消</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  onClick={handleFetch} disabled={fetching}>
                  {fetching ? "获取中…" : "获取模型"}
                </button>
              </div>
            </>
          ) : (
            <>
              <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                {modelList.map(m => (
                  <option key={m.id} value={m.id}>{m.id}{m.supportsVision ? "（识图）" : ""}</option>
                ))}
              </select>
              {modelList.length <= 20 && (
                <div className="max-h-40 overflow-auto">
                  {modelList.map(m => (
                    <div key={m.id} className={`px-3 py-2 text-sm cursor-pointer ${m.id === selectedModel ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                      onClick={() => setSelectedModel(m.id)}>
                      <span className="truncate">{m.id}</span>
                      <span className="text-[11px] text-slate-500 ml-2">{categoryLabel(m.category)}</span>
                      {m.supportsVision && <span className="text-[11px] text-emerald-700 ml-1">识图</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  onClick={() => { setStep("config"); }}>返回</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  onClick={handleConfirm} disabled={!selectedModel}>
                  {initial ? "保存" : "添加"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AISettingsClient({
  initialChannels,
  initialActiveModelId,
}: {
  initialChannels: InitialAiChannel[];
  initialActiveModelId: string | null;
}) {
  const [pageReady, setPageReady] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModel, setActiveModel] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);
  const [quickAdd, setQuickAdd] = useState<ModelEntry | null>(null);
  const [quickFetching, setQuickFetching] = useState(false);
  const [quickModelList, setQuickModelList] = useState<ModelInfo[]>([]);
  const [quickSelected, setQuickSelected] = useState("");

  useEffect(() => {
    const serverModels = buildModelsFromServer(initialChannels);
    const nextModels = serverModels.length > 0 || initialChannels.length > 0 ? serverModels : loadModels();
    setModels(nextModels);
    saveModels(nextModels);

    const activeEntry = nextModels.find((item) => item.id === initialActiveModelId);
    const nextActive = activeEntry?.name ?? loadActiveModel();
    setActiveModel(nextActive);
    if (nextActive) saveActiveModel(nextActive);
    setPageReady(true);
  }, [initialActiveModelId, initialChannels]);

  useEffect(() => {
    if (!pageReady) return;
    saveModels(models);
  }, [models, pageReady]);

  useEffect(() => {
    if (!pageReady) return;
    const handler = () => {
      setModels(loadModels());
      setActiveModel(loadActiveModel());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [pageReady]);

  function handleAddModel(entry: ModelEntry) {
    if (models.some(m => m.id !== entry.id && m.model === entry.model && m.channelName === entry.channelName)) {
      alert("该渠道下已存在相同的模型选择");
      return;
    }
    const idx = models.findIndex(m => m.id === entry.id);
    let next: ModelEntry[];
    if (idx >= 0) {
      next = [...models]; next[idx] = entry;
    } else {
      next = [...models, entry];
    }
    setModels(next);
    setShowModal(false);
    setEditingModel(null);

    syncToServer(entry);
  }

  async function syncToServer(entry: ModelEntry) {
    try {
      await fetch("/api/v1/settings/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: entry.channelName || entry.name, channelType: entry.channelType || "custom", baseUrl: entry.baseUrl, apiKey: entry.apiKey }),
      });
    } catch {}
  }

  function handleRemoveModel(id: string) {
    const entry = models.find(m => m.id === id);
    if (!entry) return;
    setModels(prev => prev.filter(m => m.id !== id));
    if (activeModel === entry.name) {
      const remaining = models.filter(m => m.id !== id);
      const nextActive = remaining[0]?.name ?? "";
      saveActiveModel(nextActive);
      setActiveModel(nextActive);
    }
  }

  function handleSetDefault(name: string) {
    saveActiveModel(name);
    setActiveModel(name);
  }

  function handleQuickAdd(base: ModelEntry) {
    setQuickAdd(base);
    setQuickFetching(true);
    setQuickModelList([]);
    setQuickSelected("");

    const modelsUrl = getModelsUrl(base.channelType);
    fetchModelsForChannel(base.baseUrl, base.apiKey ?? "", modelsUrl)
      .then(list => {
        setQuickModelList(list);
        setQuickSelected(list[0]?.id ?? "");
      })
      .catch(() => {})
      .finally(() => setQuickFetching(false));
  }

  function confirmQuickAdd() {
    if (!quickSelected || !quickAdd) return;
    const existing = models.find(m =>
      m.model === quickSelected &&
      (m.channelName || m.name) === (quickAdd.channelName || quickAdd.name),
    );
    if (existing) {
      handleSetDefault(existing.name || existing.model);
      setQuickAdd(null);
      return;
    }
    const info = quickModelList.find(m => m.id === quickSelected) ?? detectModelInfo(quickSelected);
    const entry = {
      id: genId(),
      name: quickSelected,
      channelId: "",
      channelType: quickAdd.channelType,
      channelName: quickAdd.channelName || quickAdd.name,
      baseUrl: quickAdd.baseUrl,
      apiKey: quickAdd.apiKey ?? "",
      model: quickSelected,
      category: info.category,
      supportsVision: info.supportsVision,
    };
    handleAddModel(entry);
    handleSetDefault(entry.name);
    setQuickAdd(null);
  }

  if (!pageReady) {
    return <div className="text-sm text-slate-400">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="AI 模型管理"
        description="管理 AI 渠道和模型，设置默认使用的模型。"
        count={models.length}
        actions={
          <SettingsPrimaryAddButton onClick={() => { setEditingModel(null); setShowModal(true); }}>
            新渠道
          </SettingsPrimaryAddButton>
        }
      />

      <SettingsTable minWidth={860} maxWidth="full">
        <thead className="sticky top-0 z-10">
          <tr>
            <SettingsTh>模型</SettingsTh>
            <SettingsTh>渠道</SettingsTh>
            <SettingsTh>类型</SettingsTh>
            <SettingsTh>状态</SettingsTh>
            <SettingsTh align="right">操作</SettingsTh>
          </tr>
        </thead>
        <tbody>
          {models.length > 0 ? models.map((m) => {
            const name = m.name || m.model;
            const isActive = activeModel === name;
            const info = detectModelInfo(m.model);
            const category = m.category ?? info.category;
            const supportsVision = m.supportsVision ?? info.supportsVision;
            return (
              <tr key={m.id} className={isActive ? "bg-blue-50/60 hover:bg-blue-50" : "hover:bg-slate-50"}>
                <SettingsTd className="text-sm">
                  <div className="min-w-0">
                    <div className={`truncate font-medium ${isActive ? "text-blue-700" : "text-slate-800"}`}>{name}</div>
                    {m.model !== name ? <div className="mt-0.5 truncate text-[11px] text-slate-400">{m.model}</div> : null}
                  </div>
                </SettingsTd>
                <SettingsTd>
                  <div className="min-w-0">
                    <div className="truncate text-xs text-slate-600">{m.channelName || m.channelId}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400">{m.channelType}</div>
                  </div>
                </SettingsTd>
                <SettingsTd>{categoryLabel(category)}</SettingsTd>
                <SettingsTd>
                  <div className="flex flex-wrap gap-1.5">
                    {supportsVision ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">识图</span> : null}
                    {isActive ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700">默认</span> : null}
                    {!supportsVision && !isActive ? <span className="text-xs text-slate-400">-</span> : null}
                  </div>
                </SettingsTd>
                <SettingsTd align="right">
                  <SettingsRowActions>
                    <SettingsActionButton
                      label="切换模型"
                      icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
                      onClick={() => handleQuickAdd(m)}
                    />
                    {!isActive ? (
                      <SettingsActionButton
                        label="设为默认模型"
                        variant="defaultMark"
                        onClick={() => handleSetDefault(name)}
                      />
                    ) : null}
                    <SettingsActionButton
                      label="编辑模型"
                      variant="edit"
                      onClick={() => { setEditingModel(m); setShowModal(true); }}
                    />
                    <SettingsActionButton
                      label="删除模型"
                      variant="delete"
                      onClick={() => handleRemoveModel(m.id)}
                    />
                  </SettingsRowActions>
                </SettingsTd>
              </tr>
            );
          }) : (
            <SettingsEmptyRow colSpan={5}>
              <button className="text-blue-600 hover:text-blue-700 text-xs" onClick={() => setShowModal(true)}>
                添加第一个模型
              </button>
            </SettingsEmptyRow>
          )}
        </tbody>
      </SettingsTable>

      {/* 快速添加弹窗 */}
      {quickAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">切换 {quickAdd.channelName || quickAdd.channelId} 模型</div>
            </div>
            <div className="p-5 space-y-3">
              {quickFetching ? (
                <div className="text-sm text-slate-500 text-center py-4">获取模型中…</div>
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
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={confirmQuickAdd} disabled={!quickSelected}>确认切换</button>
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
