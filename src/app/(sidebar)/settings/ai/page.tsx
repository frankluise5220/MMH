"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { copyToClipboard } from "@/lib/client/clipboard";

type ModelEntry = {
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

type ModelInfo = {
  id: string;
  category: string;
  supportsVision: boolean;
};

type Channel = {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
};

type ExtAccessKey = {
  id: string;
  name: string;
  key: string;
  createdAt?: string;
};

type ManagedUser = {
  id: string;
  name: string;
  role: string;
  isSystem?: boolean;
  hasPassword?: boolean;
  createdAt?: string;
};

type FundQueryApiRecord = {
  id: string;
  code: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  priority: number;
  isActive: boolean;
};

const CHANNEL_TYPES = [
  { id: "openai", label: "OpenAI", modelsUrl: "/v1/models" },
  { id: "anthropic", label: "Anthropic", modelsUrl: "/v1/models" },
  { id: "deepseek", label: "DeepSeek", modelsUrl: "/v1/models" },
  { id: "qwen", label: "通义千问", modelsUrl: "/v1/models" },
  { id: "local", label: "本地 / LocalAI", modelsUrl: "/v1/models" },
  { id: "ollama", label: "Ollama", modelsUrl: "/api/tags" },
  { id: "custom", label: "自定义兼容接口", modelsUrl: "/v1/models" },
];

const PROVIDER_KEY = "wiseme_provider_key";
const MODELS_KEY = "wiseme_ai_models";
const CHANNELS_KEY = "wiseme_ai_channels";
const ACTIVE_MODEL_KEY = "wiseme_ai_active_model";

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function generateRandomKey(length = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "";
  for (let i = 0; i < length; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

function loadChannels(): Channel[] {
  try {
    const raw = localStorage.getItem(CHANNELS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveChannels(channels: Channel[]) {
  try { localStorage.setItem(CHANNELS_KEY, JSON.stringify(channels)); } catch { /* ignore */ }
}

function loadModels(): ModelEntry[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveModels(models: ModelEntry[]) {
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(models)); } catch { /* ignore */ }
}

function loadActiveModel(): string {
  try { return localStorage.getItem(ACTIVE_MODEL_KEY) ?? ""; } catch { return ""; }
}

function saveActiveModel(name: string) {
  try { localStorage.setItem(ACTIVE_MODEL_KEY, name); } catch { /* ignore */ }
}

function loadExtKeys(): ExtAccessKey[] {
  return [];
}

function saveExtKeys(keys: ExtAccessKey[]) {
  // 已迁移到 DB API
}

async function fetchExtKeys(): Promise<ExtAccessKey[]> {
  try {
    const res = await fetch("/api/v1/settings/access-keys");
    const data = await res.json();
    if (data.ok && Array.isArray(data.keys)) return data.keys;
  } catch { /* ignore */ }
  return [];
}

async function createExtKey(name: string, key: string): Promise<ExtAccessKey | null> {
  try {
    const res = await fetch("/api/v1/settings/access-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, key }),
    });
    const data = await res.json();
    if (data.ok && data.key) return data.key as ExtAccessKey;
  } catch { /* ignore */ }
  return null;
}

async function deleteExtKey(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/settings/access-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    return data.ok === true;
  } catch { return false; }
}

function detectModelInfo(id: string): ModelInfo {
  const lower = id.toLowerCase();
  const supportsVision = /gpt-4o|vision|qwen[-_]?vl|glm-4v|internvl|llava|pix|multimodal|mm/.test(lower);
  const category = supportsVision
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

function categoryLabel(category: string) {
  if (category === "vision") return "识图";
  if (category === "embedding") return "向量";
  if (category === "audio") return "语音";
  if (category === "image") return "图像";
  return "文本";
}

async function fetchModelsForChannel(
  baseUrl: string,
  apiKey: string,
  modelsUrl: string,
): Promise<ModelInfo[]> {
  if (!baseUrl) return [];
  try {
    const res = await fetch("/api/v1/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey, modelsUrl }),
    });
    const data = await res.json() as { ok: boolean; models?: string[]; modelInfos?: ModelInfo[]; error?: string };
    if (!data.ok) {
      throw new Error(data.error ?? "获取模型失败");
    }
    if (Array.isArray(data.modelInfos) && data.modelInfos.length) return data.modelInfos;
    if (Array.isArray(data.models) && data.models.length) return data.models.map((m) => detectModelInfo(m));
    return [];
  } catch (e) {
    throw e;
  }
}

function UserModal({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ManagedUser;
  onSave: (data: { name: string; role: string; password?: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [role, setRole] = useState(initial?.role ?? "user");
  const [password, setPassword] = useState("");
  const isSystemUser = initial?.isSystem ?? false;
  const hasExistingPassword = initial?.hasPassword ?? false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">
            {initial ? "编辑用户" : "添加用户"}
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">用户名</label>
            <input
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder="输入用户名"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">角色</label>
            <select
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:opacity-60 disabled:bg-slate-50"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={isSystemUser}
            >
              <option value="admin">管理员 (admin)</option>
              <option value="user">普通用户 (user)</option>
            </select>
            {isSystemUser && <div className="mt-1 text-[11px] text-slate-500">系统管理员角色不可更改</div>}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1.5">
              {initial ? (hasExistingPassword ? "修改密码（留空则不修改）" : "设置密码") : "密码"}
            </label>
            <input
              type="password"
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
              placeholder={initial ? (hasExistingPassword ? "留空则不修改" : "设置密码") : "设置密码"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={onCancel}>取消</button>
            <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={() => { if (name.trim()) onSave({ name: name.trim(), role, password: password.trim() || undefined }); }} disabled={!name.trim()}>
              {initial ? "保存" : "添加"}
            </button>
          </div>
        </div>
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
  const [channelType, setChannelType] = useState(initial?.channelId ?? "openai");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [modelList, setModelList] = useState<ModelInfo[]>(
    initial && initial.model
      ? [
          {
            id: initial.model,
            category: initial.category ?? detectModelInfo(initial.model).category,
            supportsVision: initial.supportsVision ?? detectModelInfo(initial.model).supportsVision,
          },
        ]
      : [],
  );
  const [selectedModel, setSelectedModel] = useState(initial?.model ?? "");

  const currentType = CHANNEL_TYPES.find((t) => t.id === channelType) ?? CHANNEL_TYPES[0];

  function handleTypeChange(id: string) {
    const t = CHANNEL_TYPES.find((x) => x.id === id);
    setChannelType(id);
    if (t && t.id !== "custom") setBaseUrl(t.label.includes("Ollama") ? "http://localhost:11434" : "");
  }

  async function handleFetch() {
    if (!baseUrl.trim()) { setError("请先填写 Base URL"); return; }
    if (channelType !== "ollama" && !apiKey.trim()) { setError("请先填写 API Key"); return; }
    setFetching(true);
    setError("");
    try {
      const models = await fetchModelsForChannel(baseUrl.trim(), apiKey.trim(), currentType.modelsUrl);
      if (models.length === 0) { setError("未获取到模型，请检查 URL 和 Key 是否正确"); setFetching(false); return; }
      setModelList(models);
      setSelectedModel(models[0]?.id ?? "");
      setStep("models");
    } catch (e) {
      setError(`获取失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setFetching(false);
    }
  }

  function handleConfirm() {
    if (!selectedModel) return;
    const name = channelName.trim() || selectedModel;
    const info = modelList.find((m) => m.id === selectedModel) ?? detectModelInfo(selectedModel);
    onSave({
      id: initial?.id ?? genId(),
      name,
      channelId: channelType,
      channelName: name,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: selectedModel,
      category: info.category,
      supportsVision: info.supportsVision,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">
            {step === "config"
              ? initial
                ? "编辑模型"
                : "添加模型 - 配置渠道"
              : initial
                ? `编辑模型 - 选择模型（${baseUrl}）`
                : `添加模型 - 选择模型（${baseUrl}）`}
          </div>
        </div>

        <div className="p-5 space-y-4">
          {step === "config" ? (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">渠道名称</label>
                <input
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="给这个模型配置起个名字（可选）"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">接口类型</label>
                <select
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={channelType}
                  onChange={(e) => handleTypeChange(e.target.value)}
                >
                  {CHANNEL_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Base URL</label>
                <input
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder="https://api.openai.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">{channelType === "ollama" ? "API Key（可选）" : "API Key"}</label>
                <input
                  type="password"
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder={channelType === "ollama" ? "本地 Ollama 通常不需要" : "sk-..."}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              {initial ? (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">模型</label>
                  <div className="flex gap-2">
                    <input
                      className="h-9 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none text-slate-700"
                      value={selectedModel || initial.model || ""}
                      readOnly
                    />
                    <button
                      className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      onClick={handleFetch}
                      disabled={fetching}
                    >
                      {fetching ? "获取中…" : "更换"}
                    </button>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">修改模型需要重新获取一次模型列表。</div>
                </div>
              ) : null}
              {error && <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">{error}</div>}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={onCancel}>取消</button>
                {initial ? (
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700" onClick={handleConfirm} disabled={!selectedModel}>保存</button>
                ) : (
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={handleFetch} disabled={fetching}>
                    {fetching ? "获取中…" : "获取模型"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">选择模型（{modelList.length} 个可用）</label>
                <select
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                >
                  {modelList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.supportsVision ? "（识图）" : ""}〔{categoryLabel(m.category)}〕
                    </option>
                  ))}
                </select>
              </div>
              {modelList.length <= 20 && (
                <div className="max-h-48 overflow-auto rounded-md border border-slate-200">
                  {modelList.map((m) => (
                    <div
                      key={m.id}
                      className={`px-3 py-2 text-sm cursor-pointer flex items-center justify-between ${m.id === selectedModel ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                      onClick={() => setSelectedModel(m.id)}
                    >
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

export default function SettingsAiPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModel, setActiveModel] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);
  const [extKeyName, setExtKeyName] = useState("");
  const [extKey, setExtKey] = useState("");
  const [extKeys, setExtKeys] = useState<ExtAccessKey[]>([]);
  const [extSaved, setExtSaved] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [showKeyIds, setShowKeyIds] = useState<Set<string>>(new Set());
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [showUserModal, setShowUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<ManagedUser | null>(null);
  const [fundApis, setFundApis] = useState<FundQueryApiRecord[]>([]);
  const [editingFundApiId, setEditingFundApiId] = useState<string | null>(null);
  const [fundApiForm, setFundApiForm] = useState<Partial<FundQueryApiRecord>>({});
  const [showAddFundApi, setShowAddFundApi] = useState(false);

  useEffect(() => {
    setChannels(loadChannels());
    setModels(loadModels());
    setActiveModel(loadActiveModel());
    fetchExtKeys().then((keys) => setExtKeys(keys));
    fetchUsers();
    fetchFundApis();
    syncModelsToDB();
  }, []);

  async function syncModelsToDB() {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json();
      // Always sync if DB has fewer models than localStorage
      const dbModelCount = (data.ok && data.channels)
        ? data.channels.reduce((s: number, c: any) => s + (c.AiModel?.length ?? 0), 0)
        : 0;

      const localChannels = loadChannels();
      const localModels = loadModels();
      const localActive = loadActiveModel();
      if (localModels.length === 0) return;
      if (dbModelCount >= localModels.length) return;

      for (const ch of localChannels) {
        const chRes = await fetch("/api/v1/settings/ai-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: ch.name, baseUrl: ch.baseUrl, apiKey: ch.apiKey }),
        });
        const chData = await chRes.json();
        if (!chData.ok || !chData.channel) continue;
        const chId = chData.channel.id;
        const chModels = localModels.filter((m) => m.channelId === ch.id);
        for (const m of chModels) {
          const isActive = (m.name || m.model) === localActive;
          await fetch("/api/v1/settings/ai-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: m.model, name: m.name, channelId: chId, vision: m.supportsVision || false }),
          });
          if (isActive) {
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
      }
      console.log("Models synced to DB");
    } catch (e) {
      console.log("Sync failed:", e instanceof Error ? e.message : "unknown");
    }
  }

  function handleAddModel(entry: ModelEntry) {
    const entryWithChannel = {
      ...entry,
      name: entry.name || entry.model,
    };
    const existingIdx = models.findIndex((m) => m.id === entry.id);
    let next: ModelEntry[];
    if (existingIdx >= 0) {
      next = [...models];
      next[existingIdx] = entryWithChannel;
    } else {
      next = [...models, entryWithChannel];
    }
    setModels(next);
    saveModels(next);
    if (!activeModel) {
      setActiveModel(entryWithChannel.name || entryWithChannel.model);
      saveActiveModel(entryWithChannel.name || entryWithChannel.model);
    }
    setShowModal(false);
  }

  function handleRemoveModel(id: string) {
    const removed = models.find((m) => m.id === id);
    const next = models.filter((m) => m.id !== id);
    setModels(next);
    saveModels(next);
    if (activeModel === (removed?.name || removed?.model)) {
      const fallback = next[0];
      const name = fallback?.name || fallback?.model || "";
      setActiveModel(name);
      saveActiveModel(name);
    }
  }

  function handleSetDefault(name: string) {
    setActiveModel(name);
    saveActiveModel(name);
  }

  function handleChannelRemove(id: string) {
    const next = channels.filter((c) => c.id !== id);
    setChannels(next);
    saveChannels(next);
  }

  function handleExtSave() {
    const name = extKeyName.trim();
    const key = extKey.trim();
    if (!name || !key) return;
    createExtKey(name, key).then((created) => {
      if (created) {
        setExtKeys((prev) => [...prev, created]);
        setExtKeyName("");
        setExtKey("");
        setExtSaved(true);
        setTimeout(() => setExtSaved(false), 2000);
      }
    });
  }

  function handleExtDelete(id: string) {
    deleteExtKey(id).then((ok) => {
      if (ok) setExtKeys((prev) => prev.filter((k) => k.id !== id));
    });
  }

  async function fetchUsers() {
    try {
      const res = await fetch("/api/v1/settings/users");
      const data = await res.json();
      if (data.ok && Array.isArray(data.users)) setUsers(data.users);
    } catch { /* ignore */ }
  }

  async function handleUserSave(data: { name: string; role: string; password?: string }) {
    try {
      const url = "/api/v1/settings/users";
      const body = editingUser
        ? { id: editingUser.id, name: data.name, role: data.role, password: data.password }
        : data;
      const res = await fetch(url, {
        method: editingUser ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let result: { ok?: boolean; error?: string };
      try { result = await res.json(); } catch { result = { ok: false, error: `服务器错误 (${res.status})` }; }
      if (result.ok) {
        await fetchUsers();
        setShowUserModal(false);
        setEditingUser(null);
      } else {
        window.alert(result.error || (editingUser ? "更新失败" : "添加失败"));
      }
    } catch { window.alert(editingUser ? "更新失败" : "添加失败"); }
  }

  async function handleUserDelete(id: string) {
    try {
      const res = await fetch(`/api/v1/settings/users?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await res.json();
      if (result.ok) {
        await fetchUsers();
      } else {
        window.alert(result.error || "删除失败");
      }
    } catch { window.alert("删除失败"); }
  }

  async function fetchFundApis() {
    try {
      const res = await fetch("/api/v1/settings/fund-query-api");
      const data = await res.json();
      if (data.ok && Array.isArray(data.apis)) setFundApis(data.apis);
    } catch { /* ignore */ }
  }

  async function handleFundApiSave() {
    if (editingFundApiId) {
      try {
        const res = await fetch("/api/v1/settings/fund-query-api", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingFundApiId, ...fundApiForm }),
        });
        const data = await res.json();
        if (data.ok) {
          await fetchFundApis();
          setEditingFundApiId(null);
        } else {
          window.alert(data.error || "保存失败");
        }
      } catch { window.alert("保存失败"); }
    }
  }

  async function handleFundApiAdd() {
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fundApiForm),
      });
      const data = await res.json();
      if (data.ok) {
        await fetchFundApis();
        setShowAddFundApi(false);
        setFundApiForm({});
      } else {
        window.alert(data.error || "添加失败");
      }
    } catch { window.alert("添加失败"); }
  }

  async function handleFundApiDelete(id: string) {
    try {
      const res = await fetch(`/api/v1/settings/fund-query-api?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        await fetchFundApis();
      } else {
        window.alert(data.error || "删除失败");
      }
    } catch { window.alert("删除失败"); }
  }

  async function handleFundApiToggleActive(api: FundQueryApiRecord) {
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: api.id, isActive: !api.isActive }),
      });
      const data = await res.json();
      if (data.ok) await fetchFundApis();
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <div>
              <div className="text-sm font-semibold text-slate-800">模型配置</div>
              <div className="mt-1 text-xs text-slate-500">为每个模型配置独立的渠道（类型/URL/Key），获取后从列表选择。</div>
            </div>
            <button
              className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0 ml-4"
              onClick={() => { setEditingModel(null); setShowModal(true); }}
            >
              + 添加模型
            </button>
          </div>

          <div className="p-4">
            {models.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {models.map((m) => {
                  const name = (m as unknown as { name?: string }).name || m.model;
                  const isActive = activeModel === name;
                  const info = detectModelInfo(m.model);
                  const category = m.category ?? info.category;
                  const supportsVision = m.supportsVision ?? info.supportsVision;
                  return (
                    <div key={m.id} className={`flex items-center gap-2 h-10 px-3 rounded-md border ${isActive ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white"}`}>
                      <span className="flex-1 text-sm text-slate-800 truncate">{name}</span>
                      <span className="text-xs text-slate-400 shrink-0">{m.channelId}</span>
                      <span className="text-xs text-slate-500 shrink-0">〔{categoryLabel(category)}〕</span>
                      <span className={`text-xs shrink-0 ${supportsVision ? "text-emerald-700" : "text-slate-400"}`}>
                        {supportsVision ? "识图" : "不识图"}
                      </span>
                      {isActive
                        ? <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full shrink-0">使用中</span>
                        : <button className="text-xs text-blue-600 hover:text-blue-700 shrink-0" onClick={() => handleSetDefault(name)}>设为默认</button>
                      }
                      <button className="text-slate-400 hover:text-blue-600 shrink-0 text-xs" onClick={() => { setEditingModel(m); setShowModal(true); }}>编辑</button>
                      <button className="text-slate-400 hover:text-red-500 shrink-0 text-xs" onClick={() => handleRemoveModel(m.id)}>删除</button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md">
                <span>暂无模型</span>
                <button className="mt-1 text-blue-600 hover:text-blue-700 text-xs" onClick={() => setShowModal(true)}>+ 添加第一个模型</button>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <div>
              <div className="text-sm font-semibold text-slate-800">用户管理</div>
              <div className="mt-1 text-xs text-slate-500">管理系统用户，设置角色权限。</div>
            </div>
            <button
              className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0 ml-4"
              onClick={() => { setEditingUser(null); setShowUserModal(true); }}
            >
              + 添加用户
            </button>
          </div>
          <div className="p-4">
            {users.length > 0 ? (
              <div className="border border-slate-200 rounded-md overflow-hidden">
                <div className="divide-y divide-slate-100">
                  {users.map((u) => (
                    <div key={u.id} className="px-3 py-2 flex items-center gap-2">
                      <span className="text-sm text-slate-800 flex-1 truncate">{u.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${u.role === "admin" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}>
                        {u.role === "admin" ? "管理员" : "用户"}
                      </span>
                      {u.isSystem && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 shrink-0">系统</span>}
                      <button className="text-xs text-slate-400 hover:text-blue-600 shrink-0" onClick={() => { setEditingUser(u); setShowUserModal(true); }}>编辑</button>
                      {!u.isSystem && <button className="text-xs text-slate-400 hover:text-red-500 shrink-0" onClick={() => handleUserDelete(u.id)}>删除</button>}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md">
                <span>暂无用户</span>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <div>
              <div className="text-sm font-semibold text-slate-800">API Key</div>
              <div className="mt-1 text-xs text-slate-500">
                用于第三方 Agent 访问本系统的认证密钥。
              </div>
            </div>
            <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0 ml-4" onClick={() => { const key = generateRandomKey(); setExtKeyName(""); setExtKey(key); setShowApiKeyModal(true); }}>+ 新增 Key</button>
          </div>
          <div className="p-4 space-y-3">
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <div className="px-3 py-2 text-xs text-slate-500 bg-slate-50">已创建 Key 列表</div>
              <div className="divide-y divide-slate-100">
                {extKeys.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-slate-400">暂无 Key</div>
                ) : extKeys.map((k) => (
                  <div key={k.id} className="px-3 py-2 flex items-center gap-2">
                    <span className="text-sm text-slate-800 flex-1 truncate">{k.name}</span>
                    <span className="text-xs text-slate-400 flex-1 truncate">{showKeyIds.has(k.id) ? (k.key ?? "") : "••••••••"}</span>
                    <button className="text-xs text-slate-500 hover:text-blue-600" onClick={() => setShowKeyIds((prev) => { const next = new Set(prev); next.has(k.id) ? next.delete(k.id) : next.add(k.id); return next; })}>{showKeyIds.has(k.id) ? "隐藏" : "显示"}</button>
                    {showKeyIds.has(k.id) && <button className="text-xs text-slate-500 hover:text-blue-600" onClick={() => copyToClipboard(k.key ?? "")}>复制</button>}
                    <button className="text-xs text-red-500 hover:text-red-600" onClick={() => handleExtDelete(k.id)}>删除</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
            <div>
              <div className="text-sm font-semibold text-slate-800">基金查询 API</div>
              <div className="mt-1 text-xs text-slate-500">管理基金净值查询接口。地址含 <code className="bg-slate-100 px-1 rounded text-[11px]">{"{date}"}</code> 支持历史净值查询；优先级越小越先执行。</div>
            </div>
            <button
              className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0 ml-4"
              onClick={() => { setFundApiForm({ name: "", baseUrl: "", apiKey: "", priority: 0, isActive: true }); setShowAddFundApi(true); }}
            >
              + 添加 API
            </button>
          </div>
          <div className="p-4">
            {fundApis.length > 0 ? (
              <div className="space-y-2">
                {fundApis.map((api) => (
                  <div key={api.id}
                    className={`rounded-lg border p-4 ${api.isActive ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-60"}`}
                  >
                    {editingFundApiId === api.id ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">名称</div>
                            <input value={fundApiForm.name ?? ""} onChange={e => setFundApiForm(f => ({ ...f, name: e.target.value }))}
                              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                          </div>
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">优先级</div>
                            <input type="number" value={fundApiForm.priority ?? 0} onChange={e => setFundApiForm(f => ({ ...f, priority: Number(e.target.value) }))}
                              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">请求地址</div>
                          <input value={fundApiForm.baseUrl ?? ""} onChange={e => setFundApiForm(f => ({ ...f, baseUrl: e.target.value }))}
                            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono" />
                        </div>
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">API Key（可选）</div>
                          <input value={fundApiForm.apiKey ?? ""} onChange={e => setFundApiForm(f => ({ ...f, apiKey: e.target.value }))}
                            className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button onClick={() => setEditingFundApiId(null)}
                            className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">取消</button>
                          <button onClick={handleFundApiSave}
                            className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700">保存</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-800">{api.name}</span>
                            <span className="text-[10px] text-slate-400 font-mono">{api.code}</span>
                            <span className="text-[10px] text-slate-400">优先级:{api.priority}</span>
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{api.baseUrl}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-4">
                          <button onClick={() => handleFundApiToggleActive(api)}
                            className={`text-xs px-2 py-0.5 rounded ${api.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                            {api.isActive ? "启用" : "停用"}
                          </button>
                          <button onClick={() => { setEditingFundApiId(api.id); setFundApiForm({ name: api.name, baseUrl: api.baseUrl, apiKey: api.apiKey, priority: api.priority, isActive: api.isActive }); }}
                            className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50">编辑</button>
                          <button onClick={() => handleFundApiDelete(api.id)}
                            className="text-xs text-red-500 hover:text-red-600">删除</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md">
                <span>暂无基金查询 API</span>
              </div>
            )}
          </div>
        </div>

        {showAddFundApi && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
                <div className="text-sm font-semibold text-slate-800">添加基金查询 API</div>
              </div>
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">名称</label>
                    <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      value={fundApiForm.name ?? ""} onChange={e => setFundApiForm(f => ({ ...f, name: e.target.value }))} autoFocus />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">优先级</label>
                    <input type="number" className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                      value={fundApiForm.priority ?? 0} onChange={e => setFundApiForm(f => ({ ...f, priority: Number(e.target.value) }))} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">请求地址</label>
                  <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
                    value={fundApiForm.baseUrl ?? ""} onChange={e => setFundApiForm(f => ({ ...f, baseUrl: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">API Key（可选）</label>
                  <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    value={fundApiForm.apiKey ?? ""} onChange={e => setFundApiForm(f => ({ ...f, apiKey: e.target.value }))} />
                </div>
                <div className="flex justify-end gap-2">
                  <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => { setShowAddFundApi(false); setFundApiForm({}); }}>取消</button>
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={handleFundApiAdd} disabled={!fundApiForm.name?.trim() || !fundApiForm.baseUrl?.trim()}>添加</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showModal && (
          <ModelModal
            initial={editingModel ?? undefined}
            onSave={(entry) => {
              handleAddModel(entry);
              setEditingModel(null);
            }}
            onCancel={() => { setShowModal(false); setEditingModel(null); }}
          />
        )}

        {showUserModal && (
          <UserModal
            initial={editingUser ?? undefined}
            onSave={handleUserSave}
            onCancel={() => { setShowUserModal(false); setEditingUser(null); }}
          />
        )}

        {showApiKeyModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
                <div className="text-sm font-semibold text-slate-800">新增 API Key</div>
              </div>
              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">名称</label>
                  <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={extKeyName} onChange={(e) => setExtKeyName(e.target.value)} placeholder="如：OpenClaw-Prod" autoFocus />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Key</label>
                  <div className="flex items-center gap-2">
                    <div className="h-9 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 overflow-hidden">{extKey}</div>
                    <button className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => copyToClipboard(extKey)}>复制</button>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">保存后可复制</div>
                </div>
                <div className="flex justify-end gap-2">
                  <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => setShowApiKeyModal(false)}>取消</button>
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={() => { handleExtSave(); setShowApiKeyModal(false); }} disabled={!extKeyName.trim()}>保存</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
  );
}
