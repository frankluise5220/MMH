"use client";

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Bot, BrainCircuit, ChevronRight, ChevronLeft, Mic, Send, FileText, X, Sparkles, Circle, Lightbulb, Wand2 } from "lucide-react";
import { formatMoney } from "@/lib/format";

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
  | {
      role: "assistant";
      text: string;
      trace?: string[];
      items?: ParsedItem[];
      duplicates?: Array<{ index: number; existingEntryId: string; existingDate: string; existingAmount: number; accountName: string }>;
      confirmAction?: {
        kind: "delete" | "restore" | "update";
        count: number;
        payload: Record<string, unknown>;
        tip: string;
      };
      error?: string;
    };

type DuplicateAction = {
  entryId: string;
  index: number;
  accountName: string;
  amount: number;
  date: string;
  action: "pending" | "deleting" | "deleted";
};

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

type CorrectionSkill = {
  keyword: string;
  account?: string;
  counterparty?: string;
  category?: string;
  remark?: string;
  type?: string;
};

const SKILLS_KEY = "wiseme_ai_skills";
const PANEL_COLLAPSED_KEY = "wiseme_ai_panel_collapsed";

function loadSkills(): CorrectionSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveSkills(skills: CorrectionSkill[]) {
  try { localStorage.setItem(SKILLS_KEY, JSON.stringify(skills)); } catch { /* ignore */ }
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

function extractKeyword(rawText: string): string {
  const m = rawText.match(/(?:在|从|到)(.{1,10})(?:吃|消费|花了|买了|转)/);
  if (m) return m[1]!;
  const short = rawText.slice(0, 50).replace(/\d+/g, "").trim();
  return short;
}

function isRowReadyForImport(item: ParsedItem) {
  const amountAbs = Math.abs(item.amount ?? 0);
  if (!Number.isFinite(amountAbs) || amountAbs <= 0) return false;
  if (item.type === "transfer") return !!(item.fromAccount?.trim() && item.toAccount?.trim());
  if (!item.account?.trim() && !item._meta?.institutionName) return false;
  return true;
}

function getMissingFields(item: ParsedItem): string[] {
  var missing: string[] = [];
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

export function AIPanel({ defaultAccountName, accountOptions = [] }: { defaultAccountName?: string; accountOptions?: Array<{ id: string; label: string }> }) {
  const router = useRouter();

  // Read fund context from URL when viewing a specific fund
  function getFundContext(): { fundCode: string; accountId?: string; cashAccountId?: string } | null {
    try {
      const q = new URLSearchParams(window.location.search);
      const view = q.get("view");
      if (view !== "investfund" && view !== "investmoney") return null;
      const fundCode = q.get("fundCode");
      if (!fundCode) return null;
      return { fundCode, accountId: q.get("accountId") ?? undefined };
    } catch { return null; }
  }

  const [mounted, setMounted] = useState(false);
  const [input, setInput] = useState("");
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: "把一整期账单文本粘贴进来，我会先解析为多条记录，你可以逐条导入或批量导入。",
    },
  ]);
  const [pendingItems, setPendingItems] = useState<ParsedItem[] | null>(null);
  const [pendingTrace, setPendingTrace] = useState<string[] | undefined>(undefined);
  const [pendingRaw, setPendingRaw] = useState<string>("");
  const hasPending = useMemo(() => (pendingItems?.length ?? 0) > 0, [pendingItems]);
  const [drafts, setDrafts] = useState<Record<number, ParsedItem>>({});
  const [confirmIndex, setConfirmIndex] = useState(0);
  const [confirmRequestId, setConfirmRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateAction[]>([]);
  const [pendingDuplicates, setPendingDuplicates] = useState<Array<{ index: number; existingEntryId: string; existingDate: string; existingAmount: number; accountName: string }>>([]);
  const [confirmDialog, setConfirmDialog] = useState<null | {
    kind: "delete" | "restore" | "update" | "batchInvest";
    count: number;
    label: string;
    payload: Record<string, unknown>;
    tip: string;
    targets?: Array<{ id?: string; transactionId?: string; date: string; accountName: string; amount: number; remark: string; type?: string }>;
    preview?: UpdatePreview;
  }>(null);
  const [batchUpdateDialog, setBatchUpdateDialog] = useState<null | {
    remarkKeyword: string;
    newAccountName: string;
    entries: Array<{ id: string; date: string; accountName: string; amount: number; remark: string; type?: string; fundSubtype?: string | null; fundCode?: string | null; fundName?: string | null }>;
    drafts: Record<string, { accountName?: string; remark?: string; type?: string }>;
    batchAccountName?: string;
    batchType?: string;
    fundLabel?: string;
    timeRangeLabel?: string;
    targetLabel?: string;
    updateTarget: "cashAccount" | "toAccount" | "account";
  }>(null);
  const [batchUpdateSelected, setBatchUpdateSelected] = useState<Set<string>>(new Set());
  const [batchUpdateSelectAll, setBatchUpdateSelectAll] = useState(true);
  const [importConfirmDialog, setImportConfirmDialog] = useState<null | {
    items: ImportConfirmItem[];
    selectedKeys: Set<string>;
    selectAll: boolean;
  }>(null);
  const [undoDeleteTargets, setUndoDeleteTargets] = useState<Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string }>>([]);
  const [accountResolveDialog, setAccountResolveDialog] = useState<null | { index: number; stage: "confirmCreate" | "pickExisting"; suggested: string; selected: string }>(null);
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(PANEL_COLLAPSED_KEY) === "1") {
        setCollapsedState(true);
      }
    } catch { /* ignore */ }
  }, []);

  function setCollapsedPersist(next: boolean) {
    setCollapsedState(next);
    try { localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
  }

  // Models loaded from DB only

  async function loadModelsFromDB() {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json();
      if (!data.ok || !data.channels) return null;
      const models: Array<{ id: string; name: string; channelId: string; channelName: string; baseUrl: string; apiKey: string; model: string; vision: boolean }> = [];
      for (const ch of data.channels) {
        for (const m of ch.AiModel) {
          models.push({
            id: m.id,
            name: m.name || m.model,
            channelId: ch.id,
            channelName: ch.name,
            baseUrl: ch.baseUrl,
            apiKey: ch.apiKey ?? "",
            model: m.model,
            vision: m.vision,
          });
        }
      }
      if (models.length === 0) return null;
      const names = models.map((m) => m.name || m.model).filter(Boolean);
      const configs: Record<string, { baseUrl: string; apiKey: string; model: string }> = {};
      for (const m of models) {
        const key = m.name || m.model;
        if (!key) continue;
        configs[key] = { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model };
      }
      const activeModelFromDB = models.find((m) => m.id === data.activeModelId);
      const active = activeModelFromDB ? (activeModelFromDB.name || activeModelFromDB.model) : names[0] ?? "";
      return { names, configs, active, models };
    } catch { return null; }
  }

  const [activeModel, setActiveModel] = useState(() => {
    try { return localStorage.getItem("wiseme_ai_active_model") ?? ""; } catch { return ""; }
  });
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [modelConfigs, setModelConfigs] = useState<Record<string, { baseUrl: string; apiKey: string; model: string }>>({});
  const [modelsLoading, setModelsLoading] = useState(true);
  const [skillMsg, setSkillMsg] = useState("");

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    reload();
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    function onFocus() { reload(); }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [mounted]);

  function reload() {
    loadModelsFromDB().then((dbResult) => {
      setModelsLoading(false);
      if (dbResult && dbResult.names.length > 0) {
        setModelNames(dbResult.names);
        setModelConfigs(dbResult.configs);
        setActiveModel((current) => {
          const saved = current || localStorage.getItem("wiseme_ai_active_model") || "";
          const next = saved && dbResult.configs[saved] ? saved : dbResult.active;
          try { localStorage.setItem("wiseme_ai_active_model", next); } catch { /* ignore */ }
          return next;
        });
      }
    });
  }

  const pendingRef = useRef<ParsedItem[] | null>(null);
  const confirmIndexRef = useRef(0);
  const confirmRequestIdRef = useRef<string | null>(null);

  useEffect(() => { pendingRef.current = pendingItems; }, [pendingItems]);
  useEffect(() => { confirmIndexRef.current = confirmIndex; }, [confirmIndex]);
  useEffect(() => { confirmRequestIdRef.current = confirmRequestId; }, [confirmRequestId]);

  function newRequestId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function openCreateTransactionWindow(index: number) {
    const items = pendingRef.current;
    const item = items?.[index];
    if (!item) return;
    const requestId = newRequestId();
    setConfirmRequestId(requestId);
    window.dispatchEvent(new CustomEvent("wiseme:create-transaction:open", { detail: { requestId, item } }));
  }

  useEffect(() => {
    function onCreated(ev: Event) {
      const detail = (ev as CustomEvent<{ requestId?: string }>).detail;
      const rid = detail?.requestId ?? "";
      if (!rid || rid !== confirmRequestIdRef.current) return;

      const items = pendingRef.current ?? [];
      const idx = confirmIndexRef.current;
      const nextItems = items.filter((_, i) => i !== idx);

      setPendingItems(nextItems.length ? nextItems : null);
      pendingRef.current = nextItems.length ? nextItems : null;
      setDrafts({});

      if (nextItems.length) {
        const nextIndex = Math.min(idx, nextItems.length - 1);
        setConfirmIndex(nextIndex);
        setTimeout(() => openCreateTransactionWindow(nextIndex), 0);
      } else {
        setConfirmIndex(0);
        setConfirmRequestId(null);
        setPendingRaw("");
        setPendingTrace(undefined);
        setDuplicates([]);
        setPendingDuplicates([]);
        const accName = (defaultAccountName ?? "").trim();
        const accountId = new URLSearchParams(window.location.search).get("accountId");
        const target = accName ? `/?accountName=${encodeURIComponent(accName)}` : accountId ? `/?accountId=${accountId}` : "/";
        setTimeout(() => { router.push(target); router.refresh(); }, 200);
      }
    }

    window.addEventListener("wiseme:create-transaction:success", onCreated as EventListener);
    return () => window.removeEventListener("wiseme:create-transaction:success", onCreated as EventListener);
  }, [defaultAccountName, router]);

  async function parseStatement(payload: { text?: string; imageDataUrl?: string; accountName?: string }) {
    let cfg: { baseUrl: string; apiKey: string; model: string } | undefined = modelConfigs[activeModel];
    const url = (cfg?.baseUrl ?? "").trim();
    const key = (cfg?.apiKey ?? "").trim();
    const fundContext = getFundContext();

    const res = await fetch("/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        baseUrl: url || undefined,
        apiKey: key || undefined,
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
          setMessages((m) => [...m, { role: "assistant", text: `⚠️ 命中 ${parsed.deletedCount} 条记录，请确认。`, trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已删除 ${parsed.deletedCount} 条记录。`, trace: parsed.trace }]);
        setTimeout(() => router.refresh(), 300);
        return;
      }
      
      if ("operation" in parsed && parsed.operation === "restore") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "restore", label: "确认恢复记录", count: parsed.restoredCount, payload: { sourceText: text }, tip: `将恢复 ${parsed.restoredCount} 条记录`, targets: parsed.targets ?? [] });
          setMessages((m) => [...m, { role: "assistant", text: `⚠️ 命中 ${parsed.restoredCount} 条记录，请确认。`, trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已恢复 ${parsed.restoredCount} 条记录。`, trace: parsed.trace }]);
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "update") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "update", label: "AI 批量修改预览", count: parsed.count, payload: { sourceText: text }, tip: `将修改 ${parsed.count} 条记录`, targets: parsed.targets ?? [], preview: parsed.preview });
          setMessages((m) => [...m, { role: "assistant", text: `⚠️ 命中 ${parsed.count} 条记录，请确认后再修改。`, trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已修改 ${parsed.updatedCount} 条记录。`, trace: parsed.trace }]);
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
          missingFields: getMissingFields(item)
        }));
        setImportConfirmDialog({ items: importData, selectedKeys: new Set(importData.filter(it => it.ready).map(it => it.key)), selectAll: importData.every(it => it.ready) });
        setMessages((m) => [...m, { role: "assistant", text: `识别到 ${allItems.length} 条记录，请核对。`, trace: parsed.trace }]);
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
    setMessages((m) => [...m, { role: "user", text: `已上传截图：${file.name}` }]);
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
          missingFields: getMissingFields(item)
        }));
        setImportConfirmDialog({ items: importData, selectedKeys: new Set(importData.filter(it => it.ready).map(it => it.key)), selectAll: importData.every(it => it.ready) });
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

  async function onUndoLastDelete() {
    if (!undoDeleteTargets.length || loading) return;
    setLoading(true);
    try {
      const transactionIds = [...new Set(undoDeleteTargets.map((t) => t.transactionId).filter(Boolean))];
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", transactionIds }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setMessages((m) => [...m, { role: "assistant", text: `↩ 已撤销删除，恢复 ${data.count} 条记录。` }]);
      setUndoDeleteTargets([]);
      setTimeout(() => router.refresh(), 300);
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `撤销失败：${e.message}` }]);
    } finally { setLoading(false); }
  }

  async function onConfirmBatchAction() {
    if (!confirmDialog || loading) return;
    setLoading(true);
    try {
      const src = String(confirmDialog.payload.sourceText ?? "").trim();
      const text = `${src}，确认执行`;
      const parsed = await parseStatement({ text });
      if (parsed.ok) {
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已确认执行：${parsed.deletedCount || parsed.restoredCount || parsed.updatedCount || 0} 条记录。`, trace: parsed.trace }]);
        setConfirmDialog(null);
        setTimeout(() => router.refresh(), 500);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: `执行失败：${e.message}` }]);
    } finally { setLoading(false); }
  }

  async function onConfirmBatchImport() {
    if (!importConfirmDialog || loading) return;
    const selected = importConfirmDialog.items.filter(it => importConfirmDialog.selectedKeys.has(it.key)).map(it => it.item);
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

  if (collapsed) {
    return (
      <aside className="w-12 bg-background border-l border-foreground/5 flex flex-col items-center py-6 shrink-0 transition-all duration-300">
        <button onClick={() => setCollapsedPersist(false)} className="w-8 h-8 rounded-lg bg-foreground text-background flex items-center justify-center hover:bg-foreground/80">
          <ChevronLeft size={16} />
        </button>
        <div className="mt-12 flex flex-col gap-6 items-center text-foreground/20">
          <Sparkles size={20} />
          <div className="text-[10px] font-bold uppercase tracking-widest" style={{ writingMode: 'vertical-rl' }}>Zen Master</div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-80 ai-panel-glass shrink-0 flex flex-col h-screen overflow-hidden transition-all duration-300 relative border-l border-foreground/5">
      <div className="p-8 h-full flex flex-col">
        {/* Japandi Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-foreground rounded-xl flex items-center justify-center shadow-lg shadow-foreground/10 relative text-accent-clay">
              <Sparkles size={20} />
              <span className="absolute -top-1 -right-1 w-3 h-3 bg-accent-green rounded-full border-2 border-background animate-pulse"></span>
            </div>
            <div>
              <h5 className="font-heading text-xl text-foreground">Zen Master</h5>
              <p className="text-[10px] font-bold text-foreground/40 uppercase tracking-widest">Autonomous Insight</p>
            </div>
          </div>
          <button onClick={() => setCollapsedPersist(true)} className="text-foreground/20 hover:text-foreground p-1 transition-colors">
            <ChevronRight size={20} />
          </button>
        </div>

        <div className="mb-6 rounded-2xl border border-foreground/5 bg-surface-white/70 p-2 text-foreground shadow-sm">
          <div className="mb-1 px-1 text-[9px] font-bold uppercase tracking-widest text-foreground/30">默认 LLM 模型</div>
          {modelNames.length > 0 ? (
            <select
              value={activeModel}
              onChange={(e) => {
                const next = e.target.value;
                setActiveModel(next);
                try { localStorage.setItem("wiseme_ai_active_model", next); } catch { /* ignore */ }
              }}
              className="w-full rounded-xl bg-background/60 px-3 py-2 text-xs font-bold text-foreground outline-none border border-transparent focus:border-accent-green/30"
            >
              {modelNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : (
            <div className="rounded-xl bg-background/60 px-3 py-2 text-[10px] font-bold text-foreground/40">
              {modelsLoading ? "正在加载模型…" : "未配置模型，请到设置添加"}
            </div>
          )}
        </div>

        {/* Chat History */}
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4 mb-6">
          {messages.map((m, idx) => (
            <div key={idx} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"} gap-2`}>
              {m.role === "assistant" && m.trace && (
                <div className="text-[9px] font-mono text-foreground/30 bg-foreground/5 p-2 rounded-lg w-full border border-foreground/5">
                  {m.trace.slice(0, 3).map((t, i) => <div key={i} className="truncate">› {t}</div>)}
                </div>
              )}
              <div className={`px-4 py-3 rounded-2xl text-sm shadow-sm transition-all ${
                m.role === "user" 
                  ? "bg-foreground text-background rounded-tr-none" 
                  : "bg-surface-white text-foreground rounded-tl-none border border-foreground/5"
              }`}>
                {m.text}
              </div>
            </div>
          ))}
          {loading && (
             <div className="flex items-center gap-2 text-[10px] text-foreground/30 px-2 italic">
               <Wand2 size={12} className="animate-spin text-accent-green" /> Sensing intent...
             </div>
          )}
        </div>

        {/* Action Dialogs */}
        {(confirmDialog || importConfirmDialog) && (
          <div className="absolute inset-0 z-40 bg-background/95 backdrop-blur-md p-8 flex flex-col animate-in fade-in duration-300">
             <div className="flex justify-between items-center mb-8">
               <h6 className="font-heading text-lg text-foreground">{confirmDialog?.label || "Confirm Import"}</h6>
               <button onClick={() => { setConfirmDialog(null); setImportConfirmDialog(null); }} className="text-foreground/20 hover:text-foreground"><X size={20} /></button>
             </div>
             <div className="flex-1 overflow-y-auto space-y-3 mb-8">
               {confirmDialog?.kind === "update" ? (
                 <>
                   <div className="rounded-2xl border border-foreground/10 bg-surface-white p-4 text-foreground shadow-sm">
                     <div className="flex items-center justify-between gap-3">
                       <div>
                         <div className="text-[9px] font-bold uppercase tracking-widest text-foreground/35">操作类型</div>
                         <div className="mt-1 text-sm font-bold">{confirmDialog.preview?.operationType ?? "批量修改"} · {confirmDialog.preview?.action ?? "字段修改"}</div>
                       </div>
                       <div className="rounded-full bg-accent-green/10 px-3 py-1 text-[10px] font-bold text-accent-green">{confirmDialog.count} 条</div>
                     </div>
                     <div className="mt-4 grid grid-cols-2 gap-2 text-[10px]">
                       {(confirmDialog.preview?.scopeFields ?? []).map((field) => (
                         <div key={field.label} className="rounded-xl bg-background/60 p-2">
                           <div className="text-foreground/35">{field.label}</div>
                           <div className="mt-1 truncate font-bold text-foreground" title={field.value}>{field.value}</div>
                         </div>
                       ))}
                     </div>
                     <div className="mt-3 rounded-xl bg-foreground/5 p-3 text-[10px]">
                       <div className="text-foreground/40">修改字段</div>
                       <div className="mt-1 font-bold text-foreground">{confirmDialog.preview?.targetField ?? "账户"}</div>
                       <div className="mt-1 text-foreground/60">{confirmDialog.preview?.oldValue ?? "原值"} → <span className="font-bold text-accent-green">{confirmDialog.preview?.newValue ?? "新值"}</span></div>
                     </div>
                   </div>
                   <div className="space-y-2">
                     <div className="text-[9px] font-bold uppercase tracking-widest text-foreground/35">操作记录预览</div>
                     {(confirmDialog.targets ?? []).map((t, i) => (
                       <div key={t.transactionId ?? t.id ?? i} className="rounded-xl border border-foreground/5 bg-surface-white p-3 text-[10px] text-foreground">
                         <div className="flex items-center justify-between gap-2">
                           <span className="font-mono text-foreground/50">{t.date}</span>
                           <span className="font-bold text-accent-green">¥{formatMoney(Math.abs(t.amount || 0))}</span>
                         </div>
                         <div className="mt-1 truncate font-bold" title={t.accountName}>{t.accountName}</div>
                         <div className="mt-1 flex items-center justify-between gap-2 text-foreground/45">
                           <span>{t.type ?? "record"}</span>
                           <span className="truncate" title={t.remark}>{t.remark || "无备注"}</span>
                         </div>
                       </div>
                     ))}
                     {confirmDialog.count > (confirmDialog.targets?.length ?? 0) && (
                       <div className="rounded-xl border border-dashed border-foreground/10 p-3 text-center text-[10px] text-foreground/40">还有 {confirmDialog.count - (confirmDialog.targets?.length ?? 0)} 条将在确认后一起修改</div>
                     )}
                   </div>
                 </>
               ) : (
                 (confirmDialog?.targets || importConfirmDialog?.items)?.map((t: any, i: number) => (
                   <div key={i} className="p-3 bg-surface-white rounded-xl border border-foreground/5 text-[10px] flex justify-between text-foreground">
                     <span>{t.date || t.item?.date}</span>
                     <span className="font-bold text-accent-green">¥{formatMoney(Math.abs(t.amount || t.item?.amount || 0))}</span>
                   </div>
                 ))
               )}
             </div>
             <div className="flex gap-2">
               <button onClick={() => { setConfirmDialog(null); setImportConfirmDialog(null); }} className="flex-1 py-4 bg-background border border-foreground/10 text-foreground rounded-2xl font-bold text-sm">取消</button>
               <button 
                 onClick={confirmDialog ? onConfirmBatchAction : onConfirmBatchImport}
                 className="flex-[2] py-4 bg-foreground text-background rounded-2xl font-bold text-sm shadow-xl active:scale-95 transition-transform"
               >
                 确认执行
               </button>
             </div>
          </div>
        )}

        {/* Input Area */}
        <div className="mt-auto pt-6 border-t border-foreground/5">
          <div className="relative group">
            <input 
              className="w-full pl-5 pr-14 py-4 bg-background/50 rounded-2xl outline-none text-sm placeholder-foreground/20 border border-transparent focus:border-accent-green/30 focus:bg-surface-white transition-all font-medium text-foreground"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onSend()}
              onPaste={onPaste}
              placeholder="Ren, how can I help?"
            />
            <button 
              onClick={onSend}
              disabled={loading || !input.trim()}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-foreground text-background rounded-xl flex items-center justify-center hover:bg-accent-green transition-all duration-300 disabled:opacity-20 shadow-lg shadow-foreground/10"
            >
              <Send size={18} />
            </button>
          </div>
          <div className="flex gap-2 mt-4 text-foreground">
             <button onClick={() => setImportModalOpen(true)} className="flex-1 py-2.5 bg-surface-white border border-foreground/5 rounded-xl text-[9px] font-bold uppercase tracking-widest flex items-center justify-center gap-1.5 opacity-40 hover:opacity-100 transition-all">
               <FileText size={14} /> Import
             </button>
             <label className="flex-1 py-2.5 bg-surface-white border border-foreground/5 rounded-xl text-[9px] font-bold uppercase tracking-widest flex items-center justify-center gap-1.5 opacity-40 hover:opacity-100 transition-all cursor-pointer">
               <Mic size={14} /> Voice
               <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); e.target.value = ""; }} />
             </label>
          </div>
        </div>
      </div>
    </aside>
  );
}
