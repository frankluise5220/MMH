"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, ChevronLeft, Send, X, Wand2, ImagePlus, Plus, Settings, ChevronDown, Sparkles, Trash2, Eye, Pencil } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { CHANNEL_TYPES, getModelsUrl } from "@/lib/ai/config";

/* ---- Types ---- */

type ParsedItemMeta = {
  institutionName?: string;
  cardNumberMasked?: string;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
};

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
  _meta?: ParsedItemMeta;
};

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; trace?: string[]; error?: string };

type ImportConfirmItem = {
  key: string;
  item: ParsedItem;
  ready: boolean;
  missingFields: string[];
};

type UpdatePreview = {
  operationType: string;
  action: string;
  targetField: string;
  oldValue?: string;
  newValue?: string;
  scopeFields: Array<{ label: string; value: string }>;
};

type ConfirmDialog = {
  kind: "delete" | "restore" | "update";
  count: number;
  label: string;
  payload: Record<string, unknown>;
  tip: string;
  targets?: Array<{ id?: string; transactionId?: string; date: string; accountName: string; amount: number; remark: string; type?: string }>;
  preview?: UpdatePreview;
};

type ImportConfirmDialog = {
  items: ImportConfirmItem[];
  selectedKeys: Set<string>;
  selectAll: boolean;
};

type CorrectionSkill = {
  keyword: string;
  account?: string;
  counterparty?: string;
  category?: string;
  remark?: string;
  type?: string;
};

/* ---- Constants & Helpers ---- */

const SKILLS_KEY = "mmh_ai_skills";
const PANEL_COLLAPSED_KEY = "mmh_ai_panel_collapsed";

function loadSkills(): CorrectionSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function applySkills(items: ParsedItem[], rawText: string): ParsedItem[] {
  const skills = loadSkills();
  if (skills.length === 0) return items;
  return items.map((item) => {
    const combined = `${item.rawText} ${item.counterparty ?? ""} ${item.remark ?? ""}`.toLowerCase();
    for (const skill of skills) {
      if (combined.includes(skill.keyword.toLowerCase())) {
        return {
          ...item,
          account: item.account || skill.account,
          counterparty: item.counterparty || skill.counterparty,
          category: item.category || skill.category,
          remark: item.remark || skill.remark,
          type: (skill.type as ParsedItem["type"]) || item.type,
        };
      }
    }
    return item;
  });
}

function isRowReadyForImport(item: ParsedItem) {
  const amountAbs = Math.abs(item.amount ?? 0);
  if (!Number.isFinite(amountAbs) || amountAbs <= 0) return false;
  if (item.type === "transfer") return !!(item.fromAccount?.trim() && item.toAccount?.trim());
  if (!item.account?.trim() && !item._meta?.institutionName) return false;
  return true;
}

function getMissingFields(item: ParsedItem): string[] {
  const missing: string[] = [];
  if (!item.date?.trim()) missing.push("日期");
  if (!(item.amount > 0)) missing.push("金额");
  if (item.type === "transfer") {
    if (!item.fromAccount?.trim()) missing.push("转出账户");
    if (!item.toAccount?.trim()) missing.push("转入账户");
  } else {
    if (!item.account?.trim()) missing.push("账户");
  }
  return missing;
}

function normalizeItemForImport(item: ParsedItem): ParsedItem {
  return {
    rawText: item.rawText,
    type: item.type,
    date: item.date?.trim() || undefined,
    amount: Math.abs(item.amount ?? 0) || 0,
    account: item.account?.trim() || undefined,
    fromAccount: item.fromAccount?.trim() || undefined,
    toAccount: item.toAccount?.trim() || undefined,
    category: item.category?.trim() || undefined,
    remark: item.remark?.trim() || undefined,
    counterparty: item.counterparty?.trim() || undefined,
    _meta: item._meta ? {
      institutionName: item._meta.institutionName?.trim() || undefined,
      cardNumberMasked: item._meta.cardNumberMasked?.trim() || undefined,
      creditLimit: item._meta.creditLimit,
      billingDay: item._meta.billingDay,
      repaymentDay: item._meta.repaymentDay,
    } : undefined,
  };
}

/* ---- Component ---- */

export function AIPanel({ defaultAccountName }: { defaultAccountName?: string }) {
  const router = useRouter();
  const chatEndRef = useRef<HTMLDivElement>(null);

  /* State */
  const [mounted, setMounted] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "粘贴账单文本或输入指令，我会帮你解析、导入、查询或修改记录。" },
  ]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsedState] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [importConfirmDialog, setImportConfirmDialog] = useState<ImportConfirmDialog | null>(null);

  const [activeModel, setActiveModel] = useState(() => {
    try { return localStorage.getItem("mmh_ai_active_model") ?? ""; } catch { return ""; }
  });
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [modelConfigs, setModelConfigs] = useState<Record<string, { baseUrl: string; apiKey: string; model: string }>>({});
  const [modelIdsByName, setModelIdsByName] = useState<Record<string, string>>({});
  const [modelsLoading, setModelsLoading] = useState(true);

  /* Auto-scroll chat */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  /* Init: load collapsed state + models */
  useEffect(() => {
    try {
      if (localStorage.getItem(PANEL_COLLAPSED_KEY) === "1") setCollapsedState(true);
    } catch { /* ignore */ }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    reloadModels();
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    function onFocus() { reloadModels(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [mounted]);

  function setCollapsedPersist(next: boolean) {
    setCollapsedState(next);
    try { localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
  }

  /* ---- Models ---- */

  async function loadModelsFromDB() {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json();
      if (!data.ok || !data.channels) return null;
      const models: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model: string }> = [];
      for (const ch of data.channels) {
        for (const m of ch.AiModel) {
          models.push({ id: m.id, name: m.name || m.model, baseUrl: ch.baseUrl, apiKey: ch.apiKey ?? "", model: m.model });
        }
      }
      if (models.length === 0) return null;
      const names = models.map((m) => m.name).filter(Boolean);
      const configs: Record<string, { baseUrl: string; apiKey: string; model: string }> = {};
      const idsByName: Record<string, string> = {};
      for (const m of models) {
        if (!m.name) continue;
        configs[m.name] = { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model };
        idsByName[m.name] = m.id;
      }
      const activeModelFromDB = models.find((m) => m.id === data.activeModelId);
      const active = activeModelFromDB?.name ?? names[0] ?? "";
      return { names, configs, idsByName, active };
    } catch { return null; }
  }

  function reloadModels() {
    loadModelsFromDB().then((dbResult) => {
      setModelsLoading(false);
      if (dbResult && dbResult.names.length > 0) {
        setModelNames(dbResult.names);
        setModelConfigs(dbResult.configs);
        setModelIdsByName(dbResult.idsByName);
        setActiveModel((current) => {
          const saved = current || localStorage.getItem("mmh_ai_active_model") || "";
          const next = saved && dbResult.configs[saved] ? saved : dbResult.active;
          try { localStorage.setItem("mmh_ai_active_model", next); } catch { /* ignore */ }
          return next;
        });
      }
    });
  }

  /* ---- API Calls ---- */

  function getFundContext(): { fundCode: string; accountId?: string } | null {
    try {
      const q = new URLSearchParams(window.location.search);
      const view = q.get("view");
      if (view !== "investfund" && view !== "investmoney") return null;
      const fundCode = q.get("fundCode");
      if (!fundCode) return null;
      return { fundCode, accountId: q.get("accountId") ?? undefined };
    } catch { return null; }
  }

  async function parseStatement(payload: { text?: string; imageDataUrl?: string; accountName?: string }) {
    const cfg = modelConfigs[activeModel];
    const fundContext = getFundContext();
    const res = await fetch("/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        baseUrl: cfg?.baseUrl?.trim() || undefined,
        apiKey: cfg?.apiKey?.trim() || undefined,
        modelName: cfg?.model || undefined,
        fundContext: fundContext || undefined,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "解析失败");
    return data;
  }

  async function importItems(items: ParsedItem[]) {
    const defaultAcc = (defaultAccountName ?? "").trim();
    const res = await fetch("/api/v1/ai/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, defaultAccountName: defaultAcc || undefined }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "导入失败");
    return data;
  }

  /* ---- Handlers ---- */

  async function onSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const parsed = await parseStatement({ text });

      if ("operation" in parsed && parsed.operation === "delete") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "delete", label: "确认删除记录", count: parsed.deletedCount, payload: { sourceText: text }, tip: `将删除 ${parsed.deletedCount} 条记录`, targets: parsed.targets ?? [] });
          setMessages((m) => [...m, { role: "assistant", text: `命中 ${parsed.deletedCount} 条记录，请确认。`, trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: `已删除 ${parsed.deletedCount} 条记录。`, trace: parsed.trace }]);
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "restore") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "restore", label: "确认恢复记录", count: parsed.restoredCount, payload: { sourceText: text }, tip: `将恢复 ${parsed.restoredCount} 条记录`, targets: parsed.targets ?? [] });
          setMessages((m) => [...m, { role: "assistant", text: `命中 ${parsed.restoredCount} 条记录，请确认。`, trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: `已恢复 ${parsed.restoredCount} 条记录。`, trace: parsed.trace }]);
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "update") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "update", label: "批量修改预览", count: parsed.count, payload: { sourceText: text }, tip: `将修改 ${parsed.count} 条记录`, targets: parsed.targets ?? [], preview: parsed.preview });
          setMessages((m) => [...m, { role: "assistant", text: `命中 ${parsed.count} 条记录，请确认后再修改。`, trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: `已修改 ${parsed.updatedCount} 条记录。`, trace: parsed.trace }]);
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "stats") {
        setMessages((m) => [...m, { role: "assistant", text: `统计结果：${parsed.metric === "sum" ? "合计 ¥" + formatMoney(parsed.sum) : parsed.count + " 条"}`, trace: parsed.trace }]);
        return;
      }

      if (parsed.items) {
        const withSkills = applySkills(parsed.items, text);
        const allItems = withSkills.map(normalizeItemForImport);
        const importData = allItems.map((item, i) => ({
          key: `ai-${i}-${Date.now()}`,
          item,
          ready: isRowReadyForImport(item),
          missingFields: getMissingFields(item),
        }));
        setImportConfirmDialog({
          items: importData,
          selectedKeys: new Set(importData.filter(it => it.ready).map(it => it.key)),
          selectAll: importData.every(it => it.ready),
        });
        setMessages((m) => [...m, { role: "assistant", text: `识别到 ${allItems.length} 条记录，请核对后导入。`, trace: parsed.trace }]);
      } else if (parsed.operation) {
        setMessages((m) => [...m, { role: "assistant", text: `已执行：${parsed.operation}`, trace: parsed.trace }]);
        setTimeout(() => router.refresh(), 500);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `错误：${e.message}`, error: e.message }]);
    } finally { setLoading(false); }
  }

  async function onPickImage(file: File) {
    if (loading) return;
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text: `上传截图：${file.name}` }]);
    try {
      const reader = new FileReader();
      const imageDataUrl = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const parsed = await parseStatement({ imageDataUrl });
      if (parsed.items) {
        const allItems = parsed.items.map(normalizeItemForImport);
        const importData = allItems.map((item, i) => ({
          key: `img-${i}-${Date.now()}`,
          item,
          ready: isRowReadyForImport(item),
          missingFields: getMissingFields(item),
        }));
        setImportConfirmDialog({
          items: importData,
          selectedKeys: new Set(importData.filter(it => it.ready).map(it => it.key)),
          selectAll: importData.every(it => it.ready),
        });
        setMessages((m) => [...m, { role: "assistant", text: `识别到 ${allItems.length} 条记录。`, trace: parsed.trace }]);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `识别失败：${e.message}` }]);
    } finally { setLoading(false); }
  }

  async function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); await onPickImage(f); }
      }
    }
  }

  async function onConfirmBatchAction() {
    if (!confirmDialog || loading) return;
    setLoading(true);
    try {
      const src = String(confirmDialog.payload.sourceText ?? "").trim();
      const parsed = await parseStatement({ text: `${src}，确认执行` });
      if (parsed.ok) {
        setMessages((m) => [...m, { role: "assistant", text: `已确认执行：${parsed.deletedCount || parsed.restoredCount || parsed.updatedCount || 0} 条记录。`, trace: parsed.trace }]);
        setConfirmDialog(null);
        setTimeout(() => router.refresh(), 500);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `执行失败：${e.message}` }]);
    } finally { setLoading(false); }
  }

  async function onConfirmBatchImport() {
    if (!importConfirmDialog || loading) return;
    const selected = importConfirmDialog.items
      .filter(it => importConfirmDialog.selectedKeys.has(it.key))
      .map(it => it.item);
    if (!selected.length) return;
    setLoading(true);
    try {
      const result = await importItems(selected);
      setMessages((m) => [...m, { role: "assistant", text: `已导入 ${result.createdCount} 条记录。` }]);
      setImportConfirmDialog(null);
      setTimeout(() => router.refresh(), 500);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `导入失败：${e.message}` }]);
    } finally { setLoading(false); }
  }

  function toggleImportItem(key: string) {
    if (!importConfirmDialog) return;
    const nextKeys = new Set(importConfirmDialog.selectedKeys);
    if (nextKeys.has(key)) nextKeys.delete(key); else nextKeys.add(key);
    setImportConfirmDialog({ ...importConfirmDialog, selectedKeys: nextKeys, selectAll: nextKeys.size === importConfirmDialog.items.length });
  }

  function toggleImportAll() {
    if (!importConfirmDialog) return;
    const nextSelectAll = !importConfirmDialog.selectAll;
    const nextKeys = nextSelectAll
      ? new Set(importConfirmDialog.items.map(it => it.key))
      : new Set<string>();
    setImportConfirmDialog({ ...importConfirmDialog, selectedKeys: nextKeys, selectAll: nextSelectAll });
  }

  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [settingsView, setSettingsView] = useState(false);

  /* ---- Settings state ---- */
  type ChannelData = { id: string; name: string; channelType: string; baseUrl: string; apiKey: string; AiModel: Array<{ id: string; name: string; model: string; vision: boolean; active: boolean }> };
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [addChannelForm, setAddChannelForm] = useState<{ name: string; channelType: string; baseUrl: string; apiKey: string }>({ name: "", channelType: "deepseek", baseUrl: "", apiKey: "" });
  const [remoteModels, setRemoteModels] = useState<Array<{ id: string; category: string; supportsVision: boolean }>>([]);
  const [selectedRemoteModel, setSelectedRemoteModel] = useState("");
  const [newChannelId, setNewChannelId] = useState("");
  const [modelFetched, setModelFetched] = useState(false); // 是否已尝试获取过模型
  const [fetchingModels, setFetchingModels] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  /* ---- Edit model overlay ---- */
  const [editModelOverlay, setEditModelOverlay] = useState<null | {
    modelId: string;
    modelDbId: string;
    channelId: string;
    channelName: string;
    channelType: string;
    baseUrl: string;
    apiKey: string;
    modelName: string;
    vision: boolean;
  }>(null);

  function openEditModelOverlay(modelName: string) {
    const modelDbId = modelIdsByName[modelName];
    if (!modelDbId) return;
    for (const ch of channels) {
      const m = ch.AiModel.find((m) => m.id === modelDbId);
      if (m) {
        setEditModelOverlay({
          modelId: m.model,
          modelDbId: m.id,
          channelId: ch.id,
          channelName: ch.name,
          channelType: ch.channelType ?? "custom",
          baseUrl: ch.baseUrl,
          apiKey: ch.apiKey ?? "",
          modelName: m.name || m.model,
          vision: m.vision ?? false,
        });
        setModelDropdownOpen(false);
        return;
      }
    }
    loadChannelsFromDB().then(() => {
      setTimeout(() => {
        for (const ch of channels) {
          const m = ch.AiModel.find((m) => m.id === modelDbId);
          if (m) {
            setEditModelOverlay({
              modelId: m.model,
              modelDbId: m.id,
              channelId: ch.id,
              channelName: ch.name,
              channelType: ch.channelType ?? "custom",
              baseUrl: ch.baseUrl,
              apiKey: ch.apiKey ?? "",
              modelName: m.name || m.model,
              vision: m.vision ?? false,
            });
            return;
          }
        }
      }, 300);
    });
    setModelDropdownOpen(false);
  }

  async function saveEditModelOverlay() {
    if (!editModelOverlay) return;
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const chRes = await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: editModelOverlay.channelId,
          name: editModelOverlay.channelName,
          channelType: editModelOverlay.channelType,
          baseUrl: editModelOverlay.baseUrl,
          apiKey: editModelOverlay.apiKey,
        }),
      });
      const chData = await chRes.json();
      if (!chData.ok) throw new Error(chData.error ?? "更新渠道失败");

      const mRes = await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updateModelId: editModelOverlay.modelDbId,
          name: editModelOverlay.modelName,
          vision: editModelOverlay.vision,
        }),
      });
      const mData = await mRes.json();
      if (!mData.ok) throw new Error(mData.error ?? "更新模型失败");

      setEditModelOverlay(null);
      setSettingsError("");
      await loadChannelsFromDB();
      reloadModels();
    } catch (e: any) {
      setSettingsError(e.message);
    } finally { setSettingsLoading(false); }
  }

  async function loadChannelsFromDB() {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json();
      if (!data.ok) return;
      setChannels(data.channels ?? []);
      setActiveModelId(data.activeModelId ?? null);
    } catch { /* ignore */ }
  }

  async function fetchRemoteModels(baseUrl: string, apiKey: string, channelType: string) {
    const modelsUrl = getModelsUrl(channelType);
    const res = await fetch("/api/v1/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey, modelsUrl }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "获取模型失败");
    return data.modelInfos ?? data.models ?? [];
  }

  async function fetchModelsForAdd() {
    if (!addChannelForm.baseUrl.trim()) return;
    if (addChannelForm.channelType !== "ollama" && !addChannelForm.apiKey.trim()) return;
    setFetchingModels(true);
    setSettingsError("");
    setRemoteModels([]); // 清空旧列表，显示加载状态
    try {
      const modelsUrl = getModelsUrl(addChannelForm.channelType);
      const res = await fetch("/api/v1/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: addChannelForm.baseUrl.trim(), apiKey: addChannelForm.apiKey.trim(), modelsUrl }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "获取模型失败");
      const list: typeof remoteModels = data.modelInfos ?? data.models ?? [];
      setRemoteModels(list);
      setModelFetched(true);
      if (list.length > 0) setSelectedRemoteModel(list[0].id);
      else { setSelectedRemoteModel(""); }
    } catch (e: any) {
      setSettingsError(e.message);
      setModelFetched(true);
    } finally { setFetchingModels(false); }
  }

  /* ---- Auto-fetch models when URL/Key changes ---- */
  const prevFormRef = useRef(addChannelForm);
  useEffect(() => {
    const prev = prevFormRef.current;
    prevFormRef.current = addChannelForm;
    if (addChannelForm.baseUrl.trim() &&
        (addChannelForm.channelType === "ollama" || addChannelForm.apiKey.trim()) &&
        (prev.baseUrl !== addChannelForm.baseUrl || prev.apiKey !== addChannelForm.apiKey)) {
      fetchModelsForAdd();
    }
  }, [addChannelForm.baseUrl, addChannelForm.apiKey, addChannelForm.channelType]);

  async function handleAddChannelAndModel() {
    if (!selectedRemoteModel || !addChannelForm.baseUrl.trim()) return;
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const res = await fetch("/api/v1/settings/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addChannelForm.name, channelType: addChannelForm.channelType, baseUrl: addChannelForm.baseUrl, apiKey: addChannelForm.apiKey }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "添加失败");
      const chId = data.channel.id;
      const info = remoteModels.find(m => m.id === selectedRemoteModel);
      const mRes = await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedRemoteModel, name: addChannelForm.name || selectedRemoteModel, channelId: chId, vision: info?.supportsVision ?? false }),
      });
      const mData = await mRes.json();
      if (!mData.ok) throw new Error(mData.error ?? "添加模型失败");
      setAddChannelForm({ name: "", channelType: "deepseek", baseUrl: "", apiKey: "" });
      setRemoteModels([]);
      setSelectedRemoteModel("");
      setModelFetched(false);
      await loadChannelsFromDB();
      reloadModels();
    } catch (e: any) {
      setSettingsError(e.message);
    } finally { setSettingsLoading(false); }
  }

  async function handleDeleteModel(modelId: string) {
    setSettingsLoading(true);
    try {
      await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteModelId: modelId }),
      });
      await loadChannelsFromDB();
      reloadModels();
    } catch { /* ignore */ }
    finally { setSettingsLoading(false); }
  }

  async function handleDeleteChannel(channelId: string) {
    setSettingsLoading(true);
    try {
      await fetch(`/api/v1/settings/ai-config?id=${channelId}`, { method: "DELETE" });
      await loadChannelsFromDB();
      reloadModels();
    } catch { /* ignore */ }
    finally { setSettingsLoading(false); }
  }

  async function handleSetActiveModel(modelId: string) {
    try {
      await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeModelId: modelId }),
      });
      await loadChannelsFromDB();
      reloadModels();
    } catch { /* ignore */ }
  }

  /* ---- Collapsed View ---- */

  if (collapsed) {
    return (
      <aside className="w-12 bg-background border-l border-foreground/5 flex flex-col items-center py-4 shrink-0 transition-all duration-300">
        <button onClick={() => setCollapsedPersist(false)} className="w-8 h-8 rounded-lg bg-foreground text-background flex items-center justify-center hover:bg-foreground/80 transition-colors">
          <ChevronLeft size={16} />
        </button>
        <div className="mt-8 flex flex-col gap-4 items-center text-foreground/20">
          <Sparkles size={18} />
          <div className="text-[10px] font-bold tracking-widest" style={{ writingMode: "vertical-rl" }}>智能助手</div>
        </div>
      </aside>
    );
  }

  /* ---- Main Panel (Roo Code style) ---- */

  const activeModelDisplay = activeModel || "选择模型";

  return (
    <aside className="w-80 ai-panel-glass shrink-0 flex flex-col h-screen overflow-hidden transition-all duration-300 relative border-l border-foreground/5">

      {/* 头部：标题 + 模型选择 + 操作按钮 */}
      <div className="shrink-0 px-4 pt-4 pb-3 border-b border-foreground/5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-foreground rounded-xl flex items-center justify-center shadow-lg shadow-foreground/10 text-accent-clay">
              <Sparkles size={16} />
            </div>
            <div>
              <h5 className="font-heading text-base text-foreground leading-tight">记账助手</h5>
              <p className="text-[9px] font-bold text-foreground/30 tracking-wider">解析 · 导入 · 查询 · 修改</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => { setMessages([{ role: "assistant", text: "粘贴账单文本或输入指令，我会帮你解析、导入、查询或修改记录。" }]); }}
              className="w-7 h-7 rounded-md flex items-center justify-center text-foreground/40 hover:text-foreground hover:bg-foreground/5 transition-all"
              title="新对话"
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => { setSettingsView(true); loadChannelsFromDB(); }}
              className="w-7 h-7 rounded-md flex items-center justify-center text-foreground/40 hover:text-foreground hover:bg-foreground/5 transition-all"
              title="API 配置"
            >
              <Settings size={16} />
            </button>
            <button onClick={() => setCollapsedPersist(true)} className="w-7 h-7 rounded-md flex items-center justify-center text-foreground/40 hover:text-foreground hover:bg-foreground/5 transition-all" title="收起面板">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* 模型选择下拉 */}
        <div className="relative">
          {modelNames.length > 0 ? (
            <button
              onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              className="w-full flex items-center justify-between gap-2 py-2 px-3 rounded-xl bg-surface-white/70 border border-foreground/5 text-[11px] text-foreground/60 hover:bg-surface-white transition-all shadow-sm"
            >
              <span className="font-bold truncate">{activeModelDisplay}</span>
              <ChevronDown size={14} className="text-foreground/30 shrink-0" />
            </button>
          ) : (
            <button
              onClick={() => { setSettingsView(true); loadChannelsFromDB(); }}
              className="w-full flex items-center justify-between gap-2 py-2 px-3 rounded-xl bg-surface-white/70 border border-foreground/5 text-[11px] text-foreground/40 hover:bg-surface-white transition-all shadow-sm"
            >
              <span>{modelsLoading ? "加载中…" : "未配置模型，点击设置"}</span>
              <Settings size={12} className="shrink-0" />
            </button>
          )}

          {/* 模型下拉弹出 */}
          {modelDropdownOpen && modelNames.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-surface-white border border-foreground/10 rounded-xl shadow-lg overflow-hidden">
              <div className="max-h-[220px] overflow-y-auto py-1">
                {modelNames.map((name) => {
                  const isActive = name === activeModel;
                  return (
                    <div key={name} className={`flex items-center justify-between gap-2 px-3 py-2 transition-all hover:bg-accent-green/10 ${
                      isActive ? "bg-accent-green/5" : ""
                    }`}>
                      <button
                        onClick={() => {
                          setActiveModel(name);
                          try { localStorage.setItem("mmh_ai_active_model", name); } catch { /* ignore */ }
                          setModelDropdownOpen(false);
                        }}
                        className={`text-[11px] truncate min-w-0 flex-1 text-left ${isActive ? "font-bold text-accent-green" : "text-foreground/70"}`}
                      >
                        {isActive ? name + " ✓" : name}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => { loadChannelsFromDB(); openEditModelOverlay(name); }}
                          className="w-5 h-5 rounded flex items-center justify-center text-foreground/20 hover:text-foreground/50 hover:bg-foreground/10 transition-all"
                          title="编辑模型"
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          onClick={() => { const id = modelIdsByName[name]; if (id) { handleDeleteModel(id); setModelDropdownOpen(false); } }}
                          className="w-5 h-5 rounded flex items-center justify-center text-foreground/20 hover:text-red-500 hover:bg-red-50 transition-all"
                          title="删除模型"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-foreground/5">
                <button
                  onClick={() => { setModelDropdownOpen(false); setSettingsView(true); loadChannelsFromDB(); }}
                  className="w-full px-3 py-2.5 text-[11px] text-left text-foreground/40 hover:bg-foreground/5 transition-all flex items-center gap-1.5"
                >
                  <Settings size={10} /> 管理模型
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 编辑模型覆盖层 */}
      {editModelOverlay && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
          <div className="flex items-center justify-between px-5 py-4 border-b border-foreground/5 shrink-0">
            <h6 className="font-heading text-base text-foreground">编辑模型</h6>
            <button onClick={() => { setEditModelOverlay(null); setSettingsError(""); }} className="text-foreground/20 hover:text-foreground transition-colors">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">
            <div className="space-y-3">
              {/* 渠道信息 */}
              <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm">
                <div className="text-[10px] font-bold text-foreground/30 mb-3 tracking-wider">渠道配置</div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">渠道名称</label>
                    <input
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.channelName}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, channelName: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">接口类型</label>
                    <select
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.channelType}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, channelType: e.target.value } : null)}
                    >
                      {CHANNEL_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">Base URL</label>
                    <input
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.baseUrl}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, baseUrl: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">API Key</label>
                    <input
                      type="password"
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.apiKey}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, apiKey: e.target.value } : null)}
                    />
                  </div>
                </div>
              </div>

              {/* 模型信息 */}
              <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm">
                <div className="text-[10px] font-bold text-foreground/30 mb-3 tracking-wider">模型配置</div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">显示名称</label>
                    <input
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.modelName}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, modelName: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">模型 ID</label>
                    <div className="h-10 rounded-xl bg-foreground/5 border border-foreground/5 px-4 text-sm text-foreground/50 flex items-center">
                      {editModelOverlay.modelId}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-sm text-foreground/60">支持识图</span>
                    <button
                      onClick={() => setEditModelOverlay(o => o ? { ...o, vision: !o.vision } : null)}
                      className={`w-8 h-5 rounded-full transition-all ${editModelOverlay.vision ? "bg-accent-green" : "bg-foreground/10"}`}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white shadow transition-all ${editModelOverlay.vision ? "ml-4" : "ml-0"}`} />
                    </button>
                  </div>
                </div>
              </div>

              {settingsError && <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</div>}
            </div>
          </div>
          <div className="px-5 py-4 border-t border-foreground/5 shrink-0 flex gap-3">
            <button onClick={() => { setEditModelOverlay(null); setSettingsError(""); }} className="flex-1 py-3 bg-background border border-foreground/10 text-foreground rounded-xl font-bold text-sm hover:bg-foreground/5 transition-colors">
              关闭
            </button>
            <button onClick={saveEditModelOverlay} disabled={settingsLoading} className="flex-[2] py-3 bg-foreground text-background rounded-xl font-bold text-sm shadow-lg disabled:opacity-30 active:scale-95 transition-transform">
              {settingsLoading ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}

      {/* API 配置覆盖层对话框 */}
      {settingsView && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
          {/* 对话框头部 */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-foreground/5 shrink-0">
            <h6 className="font-heading text-base text-foreground">API 配置</h6>
            <button onClick={() => { setSettingsView(false); }} className="text-foreground/20 hover:text-foreground transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* 对话框内容 */}
          <div className="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">

            {/* 渠道 & 模型列表 */}
            {channels.length > 0 && (
              <div className="space-y-4 mb-4">
                {channels.map((ch) => (
                  <div key={ch.id} className="rounded-xl border border-foreground/5 bg-surface-white p-4 shadow-sm">
                    {/* 渠道头部 */}
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-foreground">{ch.name}</div>
                        <div className="mt-0.5 text-[10px] text-foreground/30 truncate">{ch.baseUrl}</div>
                      </div>
                      <button onClick={() => handleDeleteChannel(ch.id)} className="w-7 h-7 rounded-lg flex items-center justify-center text-foreground/20 hover:text-red-500 hover:bg-red-50 transition-all" title="删除渠道">
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* 模型列表 */}
                    {ch.AiModel.length > 0 ? (
                      <div className="space-y-2">
                        {ch.AiModel.map((m) => (
                          <div key={m.id} className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg border border-foreground/5 bg-background/30 hover:bg-foreground/5 transition-all">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-medium text-foreground truncate">{m.name || m.model}</span>
                              {m.vision && <Eye size={12} className="text-accent-green shrink-0" />}
                              {m.active && <span className="text-[10px] bg-accent-green/10 text-accent-green px-2 py-0.5 rounded-full shrink-0 font-bold">活跃</span>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {!m.active && (
                                <button onClick={() => handleSetActiveModel(m.id)} className="text-[10px] text-foreground/30 hover:text-accent-green font-bold transition-colors px-2 py-1 rounded-lg hover:bg-accent-green/10">
                                  设为活跃
                                </button>
                              )}
                              <button onClick={() => handleDeleteModel(m.id)} className="w-6 h-6 rounded-lg flex items-center justify-center text-foreground/20 hover:text-red-500 hover:bg-red-50 transition-all">
                                <X size={12} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-foreground/30 py-3 text-center">暂无模型</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* 添加渠道 - 单步表单 */}
            <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm space-y-3">
              <div className="text-sm font-bold text-foreground">添加渠道</div>

              {/* 基础配置 */}
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">渠道名称（可选）</label>
                  <input
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    placeholder="可留空，以模型名填充"
                    value={addChannelForm.name}
                    onChange={(e) => setAddChannelForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">接口类型</label>
                  <select
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    value={addChannelForm.channelType}
                    onChange={(e) => {
                      const ct = e.target.value;
                      const preset = ct === "ollama" ? "http://localhost:11434" : ct === "deepseek" ? "https://api.deepseek.com/v1" : ct === "openai" ? "https://api.openai.com/v1" : ct === "anthropic" ? "https://api.anthropic.com" : ct === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "";
                      setAddChannelForm(f => ({ ...f, channelType: ct, baseUrl: preset || f.baseUrl }));
                      setModelFetched(false);
                      setRemoteModels([]);
                    }}
                  >
                    {CHANNEL_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">Base URL</label>
                  <input
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    placeholder="https://api.deepseek.com/v1"
                    value={addChannelForm.baseUrl}
                    onChange={(e) => { setAddChannelForm(f => ({ ...f, baseUrl: e.target.value })); setModelFetched(false); setRemoteModels([]); }}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">API Key {addChannelForm.channelType === "ollama" ? "（可选）" : ""}</label>
                  <input
                    type="password"
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    placeholder={addChannelForm.channelType === "ollama" ? "本地通常不需要" : "sk-..."}
                    value={addChannelForm.apiKey}
                    onChange={(e) => { setAddChannelForm(f => ({ ...f, apiKey: e.target.value })); setModelFetched(false); setRemoteModels([]); }}
                  />
                </div>
              </div>

              {/* 错误提示 */}
              {/* 模型选择区 - Key 填好后始终显示 */}
              {(addChannelForm.channelType === "ollama" || addChannelForm.apiKey.trim()) && addChannelForm.baseUrl.trim() ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-bold text-foreground/30">选择模型</label>
                    {fetchingModels && <span className="text-[10px] text-accent-green animate-pulse">获取中…</span>}
                    {remoteModels.length > 0 && !fetchingModels && <span className="text-[10px] text-foreground/30">{remoteModels.length} 个模型</span>}
                  </div>

                  {fetchingModels ? (
                    <div className="flex items-center gap-2 py-4 text-[11px] text-foreground/30 justify-center">
                      <Wand2 size={12} className="animate-spin text-accent-green" /> 正在获取模型列表…
                    </div>
                  ) : remoteModels.length > 0 ? (
                    <div className="max-h-[140px] overflow-y-auto rounded-xl border border-foreground/5">
                      {remoteModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setSelectedRemoteModel(m.id)}
                          className={`w-full px-3 py-2 text-sm text-left flex items-center justify-between transition-all ${
                            m.id === selectedRemoteModel ? "bg-accent-green/10 text-accent-green font-bold" : "text-foreground/60 hover:bg-foreground/5"
                          }`}
                        >
                          <span className="truncate">{m.id}</span>
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            {m.supportsVision && <span className="text-[10px] text-accent-green">识图</span>}
                            {m.id === selectedRemoteModel && <span className="text-accent-green text-xs">✓</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {settingsError && (
                        <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</div>
                      )}
                      <button
                        onClick={fetchModelsForAdd}
                        className="w-full py-2 rounded-xl border border-dashed border-foreground/10 text-[11px] font-bold text-foreground/40 hover:text-foreground hover:border-foreground/20 transition-all"
                      >
                        {settingsError ? "重试获取模型" : "点此获取模型"}
                      </button>
                      <div>
                        <label className="block text-[10px] font-bold text-foreground/30 mb-1">或手动输入模型 ID</label>
                        <input
                          className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                          placeholder="例如 deepseek-chat"
                          value={selectedRemoteModel}
                          onChange={(e) => setSelectedRemoteModel(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-foreground/30 py-2 text-center">
                  {addChannelForm.baseUrl.trim() ? "请填写 API Key 后自动获取模型" : "请先填写 URL 和 Key"}
                </div>
              )}

              {settingsError && <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</div>}

              {/* 底部按钮 */}
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setSettingsView(false); setAddChannelForm({ name: "", channelType: "deepseek", baseUrl: "", apiKey: "" }); setRemoteModels([]); setSelectedRemoteModel(""); setModelFetched(false); setSettingsError(""); }} className="flex-1 py-2.5 bg-background border border-foreground/10 text-foreground/60 rounded-xl font-bold text-xs hover:bg-foreground/5 transition-colors">
                  取消
                </button>
                <button
                  onClick={remoteModels.length > 0 ? handleAddChannelAndModel : fetchModelsForAdd}
                  disabled={settingsLoading || fetchingModels || !addChannelForm.baseUrl.trim() || (addChannelForm.channelType !== "ollama" && !addChannelForm.apiKey.trim()) || (remoteModels.length > 0 && !selectedRemoteModel)}
                  className="flex-[2] py-2.5 bg-foreground text-background rounded-xl font-bold text-xs shadow-lg disabled:opacity-30 active:scale-95 transition-transform"
                >
                  {settingsLoading ? "添加中…" : remoteModels.length > 0 ? `添加 ${selectedRemoteModel || ""}` : "获取模型"}
                </button>
              </div>
            </div>
          </div>

          {/* 底部添加按钮已合并到表单中，此处不再单独显示 */}
        </div>
      )}

      {!settingsView && (
      <>
      {/* 聊天区 — 主体 */}
      <div className="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar space-y-3">
        {messages.map((m, idx) => (
          <div key={idx} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"} gap-1`}>
            {m.role === "assistant" && m.trace && (
              <div className="text-[9px] font-mono text-foreground/30 bg-foreground/5 p-2 rounded-lg w-full border border-foreground/5">
                {m.trace.slice(0, 3).map((t, i) => <div key={i} className="truncate">› {t}</div>)}
              </div>
            )}
            <div className={`px-3 py-2 rounded-2xl text-sm shadow-sm transition-all ${
              m.role === "user"
                ? "bg-foreground text-background rounded-tr-none max-w-[85%]"
                : "bg-surface-white text-foreground rounded-tl-none border border-foreground/5 max-w-[90%]"
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-[11px] text-foreground/30 px-2">
            <Wand2 size={12} className="animate-spin text-accent-green" /> 正在解析...
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* 确认对话框覆盖层 */}
      {(confirmDialog || importConfirmDialog) && (
        <div className="absolute inset-0 z-40 bg-background/95 backdrop-blur-md p-6 flex flex-col animate-in fade-in duration-300">
          <div className="flex justify-between items-center mb-6">
            <h6 className="font-heading text-lg text-foreground">{confirmDialog?.label ?? "确认导入"}</h6>
            <button onClick={() => { setConfirmDialog(null); setImportConfirmDialog(null); }} className="text-foreground/20 hover:text-foreground transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 mb-6">
            {/* 批量修改预览 */}
            {confirmDialog?.kind === "update" && (
              <>
                <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold text-foreground/35 tracking-wider">操作类型</div>
                      <div className="mt-1 text-sm font-bold">{confirmDialog.preview?.operationType ?? "批量修改"} · {confirmDialog.preview?.action ?? "字段修改"}</div>
                    </div>
                    <div className="rounded-full bg-accent-green/10 px-3 py-1 text-[10px] font-bold text-accent-green">{confirmDialog.count} 条</div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                    {(confirmDialog.preview?.scopeFields ?? []).map((field) => (
                      <div key={field.label} className="rounded-lg bg-background/60 p-2">
                        <div className="text-foreground/35">{field.label}</div>
                        <div className="mt-1 truncate font-bold text-foreground" title={field.value}>{field.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 rounded-lg bg-foreground/5 p-3 text-[10px]">
                    <div className="text-foreground/40">修改字段</div>
                    <div className="mt-1 font-bold text-foreground">{confirmDialog.preview?.targetField ?? "账户"}</div>
                    <div className="mt-1 text-foreground/60">
                      {confirmDialog.preview?.oldValue ?? "原值"} → <span className="font-bold text-accent-green">{confirmDialog.preview?.newValue ?? "新值"}</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-[10px] font-bold text-foreground/35 tracking-wider">操作记录预览</div>
                  {(confirmDialog.targets ?? []).map((t, i) => (
                    <div key={t.transactionId ?? t.id ?? i} className="rounded-lg border border-foreground/5 bg-surface-white p-3 text-[10px] text-foreground">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-foreground/50">{t.date}</span>
                        <span className="font-bold text-accent-green">¥{formatMoney(Math.abs(t.amount || 0))}</span>
                      </div>
                      <div className="mt-1 truncate font-bold" title={t.accountName}>{t.accountName}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-foreground/45">
                        <span>{t.type ?? "记录"}</span>
                        <span className="truncate" title={t.remark}>{t.remark || "无备注"}</span>
                      </div>
                    </div>
                  ))}
                  {confirmDialog.count > (confirmDialog.targets?.length ?? 0) && (
                    <div className="rounded-lg border border-dashed border-foreground/10 p-3 text-center text-[10px] text-foreground/40">
                      还有 {confirmDialog.count - (confirmDialog.targets?.length ?? 0)} 条将在确认后一起修改
                    </div>
                  )}
                </div>
              </>
            )}

            {/* 删除/恢复确认 */}
            {confirmDialog?.kind !== "update" && confirmDialog?.targets && (
              confirmDialog.targets.map((t, i) => (
                <div key={i} className="p-3 bg-surface-white rounded-lg border border-foreground/5 text-[11px] flex justify-between text-foreground">
                  <span>{t.date}</span>
                  <span className="font-bold text-accent-green">¥{formatMoney(Math.abs(t.amount || 0))}</span>
                </div>
              ))
            )}

            {/* 导入确认 - 勾选列表 */}
            {importConfirmDialog && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <button onClick={toggleImportAll} className="flex items-center gap-2 text-[11px] font-bold text-foreground/60 hover:text-foreground transition-colors">
                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                      importConfirmDialog.selectAll ? "bg-accent-green border-accent-green text-background" : "border-foreground/20"
                    }`}>
                      {importConfirmDialog.selectAll && <span className="text-[9px]">✓</span>}
                    </span>
                    全选
                  </button>
                  <span className="text-[10px] text-foreground/40">
                    已选 {importConfirmDialog.selectedKeys.size}/{importConfirmDialog.items.length}
                  </span>
                </div>
                {importConfirmDialog.items.map((it) => {
                  const selected = importConfirmDialog.selectedKeys.has(it.key);
                  return (
                    <div key={it.key} className={`p-3 rounded-lg border text-[11px] flex items-start gap-3 transition-all ${
                      selected ? "bg-surface-white border-foreground/10 text-foreground" : "bg-background/50 border-foreground/5 text-foreground/40"
                    }`}>
                      <button onClick={() => toggleImportItem(it.key)} className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                        selected ? "bg-accent-green border-accent-green text-background" : "border-foreground/20"
                      }`}>
                        {selected && <span className="text-[9px]">✓</span>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono">{it.item.date ?? "无日期"}</span>
                          <span className="font-bold text-accent-green shrink-0">¥{formatMoney(it.item.amount)}</span>
                        </div>
                        <div className="mt-1 truncate">{it.item.account ?? it.item.fromAccount ?? "无账户"}</div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-foreground/50">
                          <span>{it.item.type === "transfer" ? "转账" : it.item.type === "income" ? "收入" : it.item.type === "investment" ? "投资" : "支出"}</span>
                          <span className="truncate">{it.item.remark ?? it.item.counterparty ?? ""}</span>
                        </div>
                        {!it.ready && it.missingFields.length > 0 && (
                          <div className="mt-1 text-[9px] text-red-400/80">缺少：{it.missingFields.join("、")}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={() => { setConfirmDialog(null); setImportConfirmDialog(null); }} className="flex-1 py-3 bg-background border border-foreground/10 text-foreground rounded-xl font-bold text-sm transition-colors hover:bg-foreground/5">
              取消
            </button>
            <button
              onClick={confirmDialog ? onConfirmBatchAction : onConfirmBatchImport}
              disabled={!!importConfirmDialog && importConfirmDialog.selectedKeys.size === 0}
              className="flex-[2] py-3 bg-foreground text-background rounded-xl font-bold text-sm shadow-xl active:scale-95 transition-transform disabled:opacity-30"
            >
              确认执行
            </button>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 px-4 pb-4 pt-3 border-t border-foreground/5">

        {/* 输入框 + 发送按钮 */}
        <div className="relative">
          <input
            className="w-full pl-3 pr-10 py-2.5 bg-background/50 rounded-xl outline-none text-sm placeholder-foreground/20 border border-transparent focus:border-accent-green/30 focus:bg-surface-white transition-all font-medium text-foreground"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            onPaste={onPaste}
            placeholder="输入指令或粘贴账单..."
          />
          <button
            onClick={onSend}
            disabled={loading || !input.trim()}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 bg-foreground text-background rounded-lg flex items-center justify-center hover:bg-accent-green transition-all duration-300 disabled:opacity-20"
          >
            <Send size={14} />
          </button>
        </div>

        {/* 底部操作按钮 */}
        <div className="flex items-center gap-2 mt-2">
          <label className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[10px] font-bold text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 transition-all cursor-pointer">
            <ImagePlus size={12} /> 图片
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); e.target.value = ""; }} />
          </label>
        </div>
      </div>
      </>
      )}
    </aside>
  );
}
