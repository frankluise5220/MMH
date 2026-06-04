"use client";

import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Bot, BrainCircuit, ChevronRight, ChevronLeft, Mic, Send, FileText, X } from "lucide-react";
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
        kind: "delete" | "restore";
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
  }>(null);
  const [batchUpdateDialog, setBatchUpdateDialog] = useState<null | {
    remarkKeyword: string;
    newAccountName: string;
    entries: Array<{ id: string; date: string; accountName: string; amount: number; remark: string; type?: string }>;
    drafts: Record<string, { accountName?: string; remark?: string; type?: string }>;
    batchAccountName?: string;
    batchType?: string;
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
  const [modelNames, setModelNames] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("wiseme_ai_models");
      if (raw) return (JSON.parse(raw) as Array<{ name?: string; model: string }>).map(m => m.name || m.model).filter(Boolean);
    } catch { /* ignore */ }
    return [];
  });
  const [modelConfigs, setModelConfigs] = useState<Record<string, { baseUrl: string; apiKey: string; model: string }>>(() => {
    try {
      const raw = localStorage.getItem("wiseme_ai_models");
      if (raw) {
        const models = JSON.parse(raw) as Array<{ name?: string; model: string; baseUrl: string; apiKey: string }>;
        const cfgs: Record<string, { baseUrl: string; apiKey: string; model: string }> = {};
        for (const m of models) { const k = m.name || m.model; if (k) cfgs[k] = { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model }; }
        return cfgs;
      }
    } catch { /* ignore */ }
    return {};
  });
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
      if (dbResult && dbResult.names.length > 0) {
        setModelNames(dbResult.names);
        setModelConfigs(dbResult.configs);
        setActiveModel(dbResult.active);
      } else {
        // DB empty, fallback to localStorage
        const { names, configs, active } = readModelsFromStorage();
        setModelNames(names);
        setModelConfigs(configs);
        setActiveModel(active || names[0] || "");
      }
    });
  }

  function handleProviderRequired() {
    setApiModalOpen(true);
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

  function readModelsFromStorage(): {
    names: string[];
    configs: Record<string, { baseUrl: string; apiKey: string; model: string }>;
    active: string;
  } {
    // Legacy: return current state, not localStorage
    return {
      names: modelNames,
      configs: modelConfigs,
      active: activeModel,
    };
  }

  async function parseStatement(payload: { text?: string; imageDataUrl?: string; accountName?: string }) {
    let cfg: { baseUrl: string; apiKey: string; model: string } | undefined = modelConfigs[activeModel];
    if (!cfg) {
      // try re-loading from DB
      const dbResult = await loadModelsFromDB();
      if (dbResult) {
        setModelNames(dbResult.names);
        setModelConfigs(dbResult.configs);
        setActiveModel(dbResult.active);
        cfg = dbResult.configs[dbResult.active] ?? Object.values(dbResult.configs)[0];
      }
    }
    const url = (cfg?.baseUrl ?? "").trim();
    const key = (cfg?.apiKey ?? "").trim();

    const fundContext = getFundContext();

    const res = await fetch("/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: payload.text,
        imageDataUrl: payload.imageDataUrl,
        baseUrl: url || undefined,
        apiKey: key || undefined,
        modelName: cfg?.model || undefined,
        accountName: payload.accountName || undefined,
        fundContext: fundContext || undefined,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText.includes("<!DOCTYPE") ? `服务端错误 (HTTP ${res.status})，请检查后端日志` : errText || `HTTP ${res.status}`);
    }
    const data = (await res.json().catch(() => null)) as
      | { ok: true; items: ParsedItem[]; trace?: string[]; directImport?: boolean; duplicates?: unknown }
      | { ok: true; operation: "delete"; stage?: "confirm" | "applied"; deletedCount: number; accountName?: string; yearMonth?: string; targets?: Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string }>; trace?: string[] }
      | { ok: true; operation: "restore"; stage?: "confirm" | "applied"; restoredCount: number; targets?: Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string }>; trace?: string[] }
      | { ok: true; operation: "update"; stage?: "confirm" | "applied"; count?: number; updatedCount?: number; accountName?: string; remarkKeyword?: string; newType?: string; targets?: Array<{ transactionId: string; date: string; accountName: string; amount: number; remark: string; type?: string }>; trace?: string[] }
      | { ok: true; operation: "batchEdit"; stage?: "confirm" | "applied"; count?: number; targets?: Array<{ id: string; date: string; accountName: string; amount: number; remark: string; type?: string }>; trace?: string[] }
      | { ok: true; operation: "stats"; metric: "count" | "sum"; type: string; count: number; sum: number; trace?: string[] }
      | { ok: true; operation: "query"; queryType: "recycle_recent"; records: Array<{ id: string; date: string; deletedAt: string | null; type: string; amount: number; accountName: string; remark: string }>; trace?: string[] }
      | { ok: true; operation: "regularInvest"; plan: { accountId: string; fundCode: string; fundName: string; cashAccountId: string | null; amount: number; intervalUnit: string; intervalValue: number; executionDay: number | null; startDate: string; endDate: string | null; totalRuns: number | null }; trace?: string[] }
      | { ok: true; operation: "batchInvest"; plan: { amount: number; intervalUnit: string; intervalValue: number; startDate: string; endDate: string | null }; trace?: string[] }
      | { ok: false; error: string }
      | null;
    if (!data || !("ok" in data) || data.ok !== true) {
      throw new Error((data as { error?: string } | null)?.error ?? "解析失败");
    }
    return data;
  }

  async function importItems(items: ParsedItem[]) {
    const defaultAcc = (defaultAccountName ?? "").trim();
    const res = await fetch("/api/v1/ai/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, defaultAccountName: defaultAcc || undefined }),
    });
    const data = (await res.json()) as
      | { ok: true; createdCount: number; skippedCount?: number; errors?: Array<{ index: number; rawText: string; error: string }> }
      | { ok: false; error: string };
    if (!("ok" in data) || data.ok !== true) {
      throw new Error((data as { error?: string }).error ?? "导入失败");
    }
    return data;
  }

  function inferSuggestedAccountName(item: ParsedItem) {
    const fromItem = item.account?.trim();
    if (fromItem) return fromItem;
    const raw = `${item.rawText ?? ""} ${item.remark ?? ""} ${item.counterparty ?? ""}`;
    if (/民生/.test(raw)) return "民生信用卡";
    if (/平安/.test(raw)) return "平安信用卡";
    if (/招商|招行/.test(raw)) return "招商信用卡";
    if (/支付宝/.test(raw)) return "支付宝";
    if (/微信/.test(raw)) return "微信支付";
    return "";
  }

  async function retryImportWithAccount(index: number, accountName: string) {
    const item = pendingItems?.[index];
    if (!item) return;
    setLoading(true);
    try {
      const patched = normalizeItemForImport({ ...item, account: accountName });
      const result = await importItems([patched]);
      if (result.createdCount > 0) {
        const next = (pendingItems ?? []).filter((_, i) => i !== index);
        setPendingItems(next.length ? next : null);
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已按账户“${accountName}”导入该条记录。` }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", text: `仍未成功导入：${result.errors?.[0]?.error ?? "未知错误"}` }]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      setMessages((m) => [...m, { role: "assistant", text: `导入失败：${msg}` }]);
    } finally {
      setLoading(false);
      setAccountResolveDialog(null);
    }
  }

  async function onConfirmCreateAccount() {
    if (!accountResolveDialog) return;
    const name = accountResolveDialog.suggested.trim();
    if (!name) {
      setAccountResolveDialog((d) => d ? { ...d, stage: "pickExisting" } : d);
      return;
    }
    await retryImportWithAccount(accountResolveDialog.index, name);
  }

  function onCancelCreateGoPick() {
    setAccountResolveDialog((d) => d ? { ...d, stage: "pickExisting" } : d);
  }

  async function onConfirmPickExisting() {
    if (!accountResolveDialog) return;
    const picked = accountResolveDialog.selected.trim();
    if (!picked) return;
    await retryImportWithAccount(accountResolveDialog.index, picked);
  }

  async function onConfirmBatchUpdate() {
    if (!batchUpdateDialog || loading) return;
    setLoading(true);
    try {
      const updates: Array<{ id: string; accountName: string; remark: string; type: string }> = [];
      for (const entry of batchUpdateDialog.entries) {
        const draft = batchUpdateDialog.drafts[entry.id] ?? {};
        const newAccountName = (batchUpdateDialog.batchAccountName || draft.accountName || entry.accountName).trim();
        const newRemark = (draft.remark ?? entry.remark).trim();
        const newType = batchUpdateDialog.batchType || draft.type || entry.type || "expense";
        if (newAccountName !== entry.accountName || newRemark !== entry.remark || newType !== (entry.type ?? "expense")) {
          updates.push({ id: entry.id, accountName: newAccountName, remark: newRemark, type: newType });
        }
      }
      if (updates.length === 0) {
        setMessages((m) => [...m, { role: "assistant", text: "没有变更，无需更新。" }]);
        setBatchUpdateDialog(null);
        return;
      }
      const res = await fetch("/api/v1/entries/batch-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; updatedCount?: number; error?: string };
      if (data?.ok) {
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已批量修改 ${data.updatedCount ?? updates.length} 条记录。` }]);
        setBatchUpdateDialog(null);
        setTimeout(() => router.refresh(), 300);
      } else {
        throw new Error(data?.error ?? "更新失败");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "更新失败";
      setMessages((m) => [...m, { role: "assistant", text: `批量修改失败：${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  // ── Batch investment: client-side date generation from AI-parsed plan ──

  function generateDatesFromPlan(plan: { amount: number; intervalUnit: string; intervalValue: number; startDate: string; endDate: string | null; month?: number; year?: number }) {
    const dates: Array<{ date: string; amount: number }> = [];
    const start = new Date(plan.startDate);
    const maxDays = 366;
    let d = new Date(start);
    let count = 0;

    while (count < maxDays) {
      if (plan.endDate && d.toISOString().slice(0, 10) > plan.endDate) break;
      const dow = d.getDay();
      if (dow !== 0 && dow !== 6) {
        dates.push({ date: d.toISOString().slice(0, 10), amount: plan.amount });
      }
      count++;
      if (plan.intervalUnit === "day") d.setDate(d.getDate() + plan.intervalValue);
      else if (plan.intervalUnit === "week") d.setDate(d.getDate() + 7 * plan.intervalValue);
      else if (plan.intervalUnit === "biweek") d.setDate(d.getDate() + 14 * plan.intervalValue);
      else if (plan.intervalUnit === "month") d.setMonth(d.getMonth() + plan.intervalValue);
    }
    return dates;
  }

  function showBatchInvestConfirm(plan: {
    amount: number; intervalUnit: string; intervalValue: number;
    startDate: string; endDate: string | null; fundCode: string; accountId: string;
  }) {
    const dates = generateDatesFromPlan(plan);
    const fc = getFundContext();
    const fundCode = plan.fundCode || fc?.fundCode || "";
    const intervalLabels: Record<string, string> = { day: "每天", week: "每周", biweek: "每两周", month: "每月" };
    const intervalText = intervalLabels[plan.intervalUnit] ?? plan.intervalUnit;
    const total = dates.length;

    setMessages((m) => [...m, {
      role: "assistant",
      text: `${fundCode}，${intervalText}，每期${plan.amount}元${plan.endDate ? `，${plan.startDate}~${plan.endDate}` : "，无截止日期"}，共 ${total} 期，合计 ${(total * plan.amount).toFixed(2)} 元`,
    }]);
    setConfirmDialog({
      kind: "batchInvest",
      label: "确认批量买入",
      count: total,
      payload: {
        accountId: plan.accountId || fc?.accountId || "",
        fundCode,
        fundName: fundCode,
        cashAccountId: fc?.cashAccountId ?? null,
        amount: plan.amount,
        items: dates.map(d => ({
          rawText: `买入 ${fundCode} ${plan.amount}元`,
          type: "investment",
          date: d.date,
          amount: plan.amount,
        })),
      },
      tip: `${fundCode}，${intervalText}，每期${plan.amount}元${plan.endDate ? `，${plan.startDate} ~ ${plan.endDate}` : `，${plan.startDate} 起`}`,
      targets: dates.map((d, i) => ({
        date: d.date,
        accountName: fundCode,
        amount: d.amount,
        remark: `买入 ${fundCode}`,
        id: `bi-${d.date}`,
      })),
    });
  }

  async function onSend() {
    const text = input.trim();
    if (!text || loading) return;

    // No model configured: show config prompt instead of error
    const cfg = modelConfigs[activeModel];
    if (!cfg?.baseUrl) {
      setApiModalOpen(true);
      setInput(text);
      return;
    }

    setInput("");
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text }]);

    try {
      const parsed = await parseStatement({ text, accountName: defaultAccountName });
      if ("operation" in parsed && parsed.operation === "delete") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({
            kind: "delete",
            label: "确认删除记录",
            count: parsed.deletedCount,
            payload: { yearMonth: parsed.yearMonth ?? "", accountName: parsed.accountName ?? "", sourceText: text },
            tip: `将删除 ${parsed.deletedCount} 条记录`,
            targets: (parsed as any).targets ?? [],
          });
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: `⚠️ 命中 ${parsed.deletedCount} 条记录，已暂停执行，请在确认窗口里选择是否继续。`,
              trace: parsed.trace,
            },
          ]);
          return;
        }

        const targetLines = (parsed.targets ?? []).map((t, i) => {
          const amt = Math.abs(Number(t.amount || 0)).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          return `${i + 1}. ${t.date} | ${t.accountName} | ¥${amt}${t.remark ? ` | ${t.remark}` : ""}`;
        });
        const detailText = parsed.deletedCount <= 5 && targetLines.length
          ? `\n操作对象：\n${targetLines.join("\n")}`
          : "";

        setPendingItems(null);
        pendingRef.current = null;
        setPendingRaw("");
        setPendingTrace(undefined);
        setDrafts({});
        setConfirmRequestId(null);
        setDuplicates([]);
        setPendingDuplicates([]);
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `✓ 已将 ${parsed.yearMonth ?? ""} ${parsed.accountName ?? ""} 的记录移入回收站：${parsed.deletedCount} 条。${detailText}`,
            trace: parsed.trace,
          },
        ]);
        if (parsed.deletedCount <= 5) {
          setUndoDeleteTargets(parsed.targets ?? []);
        } else {
          setUndoDeleteTargets([]);
        }
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "restore") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({
            kind: "restore",
            label: "确认恢复记录",
            count: parsed.restoredCount,
            payload: { sourceText: text },
            tip: `将恢复 ${parsed.restoredCount} 条记录`,
            targets: (parsed as any).targets ?? [],
          });
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: `⚠️ 命中 ${parsed.restoredCount} 条记录，已暂停执行，请在确认窗口里选择是否继续。`,
              trace: parsed.trace,
            },
          ]);
          return;
        }

        const targetLines = (parsed.targets ?? []).map((t, i) => {
          const amt = Math.abs(Number(t.amount || 0)).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          return `${i + 1}. ${t.date} | ${t.accountName} | ¥${amt}${t.remark ? ` | ${t.remark}` : ""}`;
        });
        const detailText = parsed.restoredCount <= 5 && targetLines.length
          ? `\n操作对象：\n${targetLines.join("\n")}`
          : "";

        setPendingItems(null);
        pendingRef.current = null;
        setPendingRaw("");
        setPendingTrace(undefined);
        setDrafts({});
        setConfirmRequestId(null);
        setDuplicates([]);
        setPendingDuplicates([]);
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `✓ 已恢复 ${parsed.restoredCount} 条记录。${detailText}`,
            trace: parsed.trace,
          },
        ]);
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "stats") {
        const typeText = parsed.type === "expense" ? "支出" : parsed.type === "income" ? "收入" : parsed.type === "transfer" ? "转账" : parsed.type;
        const textOut = parsed.metric === "sum"
          ? `统计结果（${typeText}）：合计 ¥${Number(parsed.sum || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : `统计结果（${typeText}）：共 ${parsed.count} 条`;
        setMessages((m) => [...m, { role: "assistant", text: textOut, trace: parsed.trace }]);
        return;
      }

      if ("operation" in parsed && parsed.operation === "update") {
        if (parsed.stage === "confirm" && parsed.targets?.length) {
          const entries = parsed.targets.map(t => ({
            id: t.transactionId,
            date: t.date,
            accountName: t.accountName,
            amount: t.amount,
            remark: t.remark,
            type: t.type,
          }));
          const drafts: Record<string, { accountName?: string; remark?: string; type?: string }> = {};
          entries.forEach(e => {
            drafts[e.id] = { accountName: e.accountName, remark: e.remark, type: e.type };
          });
          const typeMap: Record<string, string> = { "投资": "investment", "支出": "expense", "收入": "income", "转账": "transfer" };
          setBatchUpdateDialog({
            remarkKeyword: parsed.remarkKeyword ?? "",
            newAccountName: parsed.accountName ?? "",
            entries,
            drafts,
            batchAccountName: parsed.accountName ?? "",
            batchType: parsed.newType ? (typeMap[parsed.newType] ?? parsed.newType) : "",
          });
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: `⚠️ 命中 ${parsed.count} 条记录，请在下表中编辑后点击"批量修改"执行。`,
              trace: parsed.trace,
            },
          ]);
          return;
        }

        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `✓ 已更新 ${parsed.updatedCount ?? 0} 条记录${parsed.accountName ? `为"${parsed.accountName}"` : ""}`,
            trace: parsed.trace,
          },
        ]);
        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "batchEdit") {
        if (parsed.stage === "confirm" && parsed.targets?.length) {
          const entries = parsed.targets.map(t => ({
            id: t.id,
            date: t.date,
            accountName: t.accountName,
            amount: t.amount,
            remark: t.remark,
            type: t.type,
          }));
          const drafts: Record<string, { accountName?: string; remark?: string; type?: string }> = {};
          entries.forEach(e => {
            drafts[e.id] = { accountName: e.accountName, remark: e.remark, type: e.type };
          });
          setBatchUpdateDialog({
            remarkKeyword: "",
            newAccountName: "",
            entries,
            drafts,
            batchAccountName: entries[0]?.accountName ?? "",
            batchType: "",
          });
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: `⚠️ 命中 ${parsed.count} 条记录，请在下表中编辑后点击"批量修改"执行。`,
              trace: parsed.trace,
            },
          ]);
          return;
        }

        setTimeout(() => router.refresh(), 300);
        return;
      }

      if ("operation" in parsed && parsed.operation === "query") {
        const lines = parsed.records.map((r, i) => {
          const amt = Number.isFinite(r.amount) ? Math.abs(r.amount).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00";
          const typeText = r.type === "expense" ? "支出" : r.type === "income" ? "收入" : r.type === "transfer" ? "转账" : "投资";
          const deletedAt = r.deletedAt ? r.deletedAt.slice(0, 19).replace("T", " ") : "-";
          return `${i + 1}. ${r.date} | ${r.accountName} | ${typeText} | ¥${amt} | 删除于 ${deletedAt}${r.remark ? ` | ${r.remark}` : ""}`;
        });
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: lines.length ? `以下是刚刚移入回收站的记录：\n${lines.join("\n")}` : "回收站暂无记录。",
            trace: parsed.trace,
          },
        ]);
        return;
      }

      if ("operation" in parsed && parsed.operation === "regularInvest") {
        const plan = parsed.plan;
        setLoading(true);
        try {
          const res = await fetch("/api/v1/regular-invest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(plan),
          });
          const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; id?: string } | null;
          if (data?.ok) {
            setMessages((m) => [
              ...m,
              {
                role: "assistant",
                text: `✓ 已创建定投计划：${plan.fundCode}，每${plan.intervalUnit === "day" ? "天" : plan.intervalUnit === "week" ? "周" : plan.intervalUnit === "biweek" ? "两周" : "月"}${plan.amount}元，${plan.startDate} 起`,
                trace: parsed.trace,
              },
            ]);
            setPendingItems(null);
            setPendingRaw("");
            setPendingTrace(undefined);
            setDrafts({});
            setConfirmRequestId(null);
            setTimeout(() => router.refresh(), 500);
          } else {
            setMessages((m) => [
              ...m,
              { role: "assistant", text: `创建定投计划失败：${data?.error ?? "未知错误"}`, trace: parsed.trace },
            ]);
          }
        } catch (e) {
          setMessages((m) => [
            ...m,
            { role: "assistant", text: `创建定投计划失败：${e instanceof Error ? e.message : "网络错误"}` },
          ]);
        } finally {
          setLoading(false);
        }
        return;
      }

      // ── AI returned batch investment plan → show confirmation table ──
      if ("operation" in parsed && parsed.operation === "batchInvest") {
        setLoading(false);
        const plan = parsed.plan;
        const fc = getFundContext();
        if (!fc) {
          setMessages((m) => [...m, { role: "assistant", text: "请先打开基金持仓页面，选中一只基金后再执行批量操作。" }]);
          return;
        }
        showBatchInvestConfirm({
          amount: plan.amount,
          intervalUnit: plan.intervalUnit,
          intervalValue: plan.intervalValue,
          startDate: plan.startDate,
          endDate: plan.endDate,
          fundCode: fc.fundCode,
          accountId: fc.accountId ?? "",
        });
        return;
      }

      const withSkills = applySkills(parsed.items, text);
      const ready = withSkills.filter(isRowReadyForImport).map(normalizeItemForImport);
      const needConfirmItems = withSkills.filter((x) => !isRowReadyForImport(x)).map(normalizeItemForImport);

      const shouldAutoImport = parsed.directImport === true;

      if (!shouldAutoImport) {
        setPendingItems([...needConfirmItems, ...ready]);
        setPendingTrace(parsed.trace);
        const confirmText = ready.length
          ? `识别到 ${ready.length} 条记录，请确认后导入：`
          : `识别到 ${needConfirmItems.length} 条记录，部分信息不完整，请补充后导入：`;
        setMessages((m) => [
          ...m,
          { role: "assistant", text: confirmText, trace: parsed.trace },
        ]);
        setLoading(false);
        return;
      }

      const duplicateList = (parsed as any).duplicates as Array<{ index: number; existingEntryId: string; existingDate: string; existingAmount: number; accountName: string }> | undefined;

      let importedCount = 0;
      if (ready.length) {
        const result = await importItems(ready);
        importedCount = result.createdCount;

        const accountErr = (result.errors ?? []).find((e) => /账户|account|找不到/.test(e.error));
        if (accountErr) {
          const idx = Math.max(0, Math.min(ready.length - 1, accountErr.index));
          const suggested = inferSuggestedAccountName(ready[idx] as ParsedItem);
          setAccountResolveDialog({
            index: idx,
            stage: "confirmCreate",
            suggested,
            selected: accountOptions.find((a) => a.label.includes(suggested))?.label ?? accountOptions[0]?.label ?? suggested,
          });
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              text: `有一条记录账户未能稳定匹配。建议新建账户“${suggested || "（未命名）"}”并继续，或改为从已有账户中选择。`,
              trace: parsed.trace,
            },
          ]);
          setLoading(false);
          return;
        }
      }

      if (duplicateList?.length) {
        const dupActions: DuplicateAction[] = duplicateList.map((d) => ({
          entryId: d.existingEntryId,
          index: d.index,
          accountName: d.accountName,
          amount: d.existingAmount,
          date: d.existingDate,
          action: "pending" as const,
        }));
        setDuplicates(dupActions);
        setPendingDuplicates(duplicateList);
      } else {
        setDuplicates([]);
        setPendingDuplicates([]);
      }

      if (needConfirmItems.length) {
        setPendingItems(needConfirmItems);
        pendingRef.current = needConfirmItems;
        setPendingRaw(text);
        setPendingTrace(parsed.trace);
        setDrafts({});
        setConfirmIndex(0);
        setTimeout(() => openCreateTransactionWindow(0), 0);
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text:
              importedCount > 0
                ? `✓ 已自动导入 ${importedCount} 条记录。还有 ${needConfirmItems.length} 条信息不全，需要你在记账窗口里补齐后再导入。`
                : `已解析出 ${needConfirmItems.length} 条记录，但信息不全，需要你在记账窗口里补齐后再导入。`,
            trace: parsed.trace,
            items: needConfirmItems,
          },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `✓ 已解析并导入 ${importedCount} 条记录。`,
            trace: parsed.trace,
          },
        ]);
        const accName = (defaultAccountName ?? "").trim();
        const accountId = new URLSearchParams(window.location.search).get("accountId");
        const target = accName ? `/?accountName=${encodeURIComponent(accName)}` : accountId ? `/?accountId=${accountId}` : "/";
        setPendingItems(null);
        setPendingRaw("");
        setPendingTrace(undefined);
        setDrafts({});
        setConfirmRequestId(null);
        setTimeout(() => { router.push(target); router.refresh(); }, 800);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "解析失败";
      setPendingItems(null);
      setPendingTrace(undefined);
      setConfirmRequestId(null);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: msg.includes("请先") ? "请先在 AI Provider 页面完成配置后重试。" : `解析失败：${msg}`, error: msg },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function onPickImage(file: File) {
    if (loading) return;
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text: `已上传截图：${file.name}` }]);

    try {
      const imageDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
      });

      const parsed = await parseStatement({ imageDataUrl });
      if (!('items' in parsed) || !parsed.items) {
        throw new Error("解析失败，未返回账单条目");
      }
      const ready = parsed.items.filter(isRowReadyForImport).map(normalizeItemForImport);
      const needConfirmItems = parsed.items.filter((x) => !isRowReadyForImport(x)).map(normalizeItemForImport);

      const duplicateList = (parsed as any).duplicates as Array<{ index: number; existingEntryId: string; existingDate: string; existingAmount: number; accountName: string }> | undefined;

      if (duplicateList?.length) {
        const dupActions: DuplicateAction[] = duplicateList.map((d) => ({
          entryId: d.existingEntryId,
          index: d.index,
          accountName: d.accountName,
          amount: d.existingAmount,
          date: d.existingDate,
          action: "pending" as const,
        }));
        setDuplicates(dupActions);
        setPendingDuplicates(duplicateList);
      } else {
        setDuplicates([]);
        setPendingDuplicates([]);
      }

      let importedCount = 0;
      if (ready.length) {
        const result = await importItems(ready);
        importedCount = result.createdCount;
      }

      if (needConfirmItems.length) {
        setPendingItems(needConfirmItems);
        pendingRef.current = needConfirmItems;
        setPendingRaw(`[图片] ${file.name}`);
        setPendingTrace(parsed.trace);
        setDrafts({});
        setConfirmIndex(0);
        setTimeout(() => openCreateTransactionWindow(0), 0);
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text:
              importedCount > 0
                ? `✓ 已自动导入 ${importedCount} 条记录。还有 ${needConfirmItems.length} 条信息不全，需要你在记账窗口里补齐后再导入。`
                : `已解析出 ${needConfirmItems.length} 条记录，但信息不全，需要你在记账窗口里补齐后再导入。`,
            trace: parsed.trace,
            items: needConfirmItems,
          },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            text: `✓ 已解析并导入 ${importedCount} 条记录。`,
            trace: parsed.trace,
          },
        ]);
        const accName = (defaultAccountName ?? "").trim();
        const accountId = new URLSearchParams(window.location.search).get("accountId");
        const target = accName ? `/?accountName=${encodeURIComponent(accName)}` : accountId ? `/?accountId=${accountId}` : "/";
        setPendingItems(null);
        setPendingRaw("");
        setPendingTrace(undefined);
        setDrafts({});
        setConfirmRequestId(null);
        setTimeout(() => { router.push(target); router.refresh(); }, 800);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "解析失败";
      setPendingItems(null);
      setPendingTrace(undefined);
      setConfirmRequestId(null);
      setMessages((m) => [
        ...m,
        { role: "assistant", text: msg.includes("请先") ? "请先在 AI Provider 页面完成配置后重试。" : `解析失败：${msg}`, error: msg },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f && f.type.startsWith("image/")) {
          e.preventDefault();
          setInput("");
          await onPickImage(f);
          return;
        }
      }
    }
  }

  async function onImportAll() {
    if (!pendingItems?.length || loading) return;
    setLoading(true);
    try {
      const normalized = pendingItems.map(normalizeItemForImport);
      const result = await importItems(normalized);
      const needConfirm = result.skippedCount ?? 0;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text:
            needConfirm > 0
              ? `✓ 已导入 ${result.createdCount} 条记录；还有 ${needConfirm} 条需要你确认/补齐后再导入。`
              : `✓ 已导入 ${result.createdCount} 条记录。`,
        },
      ]);
      const accName = (defaultAccountName ?? "").trim();
      const accountId = new URLSearchParams(window.location.search).get("accountId");
      const target = accName ? `/?accountName=${encodeURIComponent(accName)}` : accountId ? `/?accountId=${accountId}` : "/";
      setPendingItems(null);
      setPendingRaw("");
      setPendingTrace(undefined);
      setDrafts({});
      setConfirmRequestId(null);
      setDuplicates([]);
      setPendingDuplicates([]);
      setTimeout(() => { router.push(target); router.refresh(); }, 800);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      setMessages((m) => [...m, { role: "assistant", text: msg.includes("请先") ? "请先在 AI Provider 页面完成配置后重试。" : "导入失败。", error: msg }]);
    } finally {
      setLoading(false);
    }
  }

  async function onImportOne(item: ParsedItem) {
    if (loading) return;
    setLoading(true);
    try {
      const result = await importItems([normalizeItemForImport(item)]);
      const err = result.errors?.[0]?.error;
      setMessages((m) => [
        ...m,
        { role: "assistant", text: result.createdCount > 0 ? `✓ 已导入 1 条记录。` : `需要确认：${err ?? "无法导入"}` },
      ]);
      if (result.createdCount > 0) {
        setPendingItems((items) => items ? items.filter((x) => x !== item) : items);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "导入失败";
      setMessages((m) => [...m, { role: "assistant", text: msg.includes("请先") ? "请先在 AI Provider 页面完成配置后重试。" : "导入失败。", error: msg }]);
    } finally {
      setLoading(false);
    }
  }

  async function onConfirmBatchAction() {
    const d = confirmDialog;
    if (!d) return;
    setLoading(true);
    try {
      if (d.kind === "batchInvest") {
        const p = d.payload as any;
        const items = p.items as Array<{ rawText: string; type: string; date: string; amount: number }>;
        const res = await fetch("/api/v1/ai/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items,
            fundContext: {
              accountId: p.accountId,
              cashAccountId: p.cashAccountId || undefined,
              fundCode: p.fundCode,
              fundName: p.fundName,
            },
          }),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; createdCount?: number; error?: string; errors?: Array<{ error: string }> } | null;
        if (data?.ok) {
          const done = data.createdCount ?? 0;
          const failed = data.errors?.length ?? 0;
          setMessages((m) => [...m, {
            role: "assistant",
            text: `✓ 已批量创建 ${done} 条买入记录${failed > 0 ? `，${failed} 条失败` : ""}。${p.fundCode}，${p.amount}元/期`,
          }]);
          setConfirmDialog(null);
          setTimeout(() => router.refresh(), 500);
        } else {
          throw new Error(data?.error ?? data?.errors?.[0]?.error ?? "创建失败");
        }
        setLoading(false);
        return;
      }

      const src = String(d.payload.sourceText ?? "").trim();
      if (!src) { setConfirmDialog(null); setLoading(false); return; }
      const text = `${src}，确认执行`;
      const parsed = await parseStatement({ text });
      if ("operation" in parsed && parsed.operation === "delete" && parsed.stage === "applied") {
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已确认执行，移入回收站 ${parsed.deletedCount} 条。`, trace: parsed.trace }]);
        if (parsed.deletedCount <= 5) {
          setUndoDeleteTargets(parsed.targets ?? []);
        } else {
          setUndoDeleteTargets([]);
        }
      } else if ("operation" in parsed && parsed.operation === "restore" && parsed.stage === "applied") {
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已确认执行，恢复 ${parsed.restoredCount} 条。`, trace: parsed.trace }]);
      } else if ("operation" in parsed && parsed.operation === "update" && parsed.stage === "applied") {
        setMessages((m) => [...m, { role: "assistant", text: `✓ 已确认执行，更新 ${parsed.updatedCount} 条记录。`, trace: parsed.trace }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", text: "确认执行失败，请重试。" }]);
      }
      setConfirmDialog(null);
      setTimeout(() => router.refresh(), 300);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "确认失败";
      setMessages((m) => [...m, { role: "assistant", text: `确认失败：${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  async function onUndoLastDelete() {
    if (!undoDeleteTargets.length || loading) return;
    setLoading(true);
    try {
      const transactionIds = [...new Set(undoDeleteTargets.map((t) => t.transactionId).filter(Boolean))];
      if (!transactionIds.length) {
        setMessages((m) => [...m, { role: "assistant", text: "没有可撤销的对象。" }]);
        return;
      }
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", transactionIds }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; count?: number } | null;
      if (!data?.ok) {
        throw new Error(data?.error ?? "撤销失败");
      }
      setMessages((m) => [...m, { role: "assistant", text: `↩ 已撤销刚刚的删除，恢复 ${data.count ?? transactionIds.length} 条记录。` }]);
      setUndoDeleteTargets([]);
      setTimeout(() => router.refresh(), 300);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "撤销失败";
      setMessages((m) => [...m, { role: "assistant", text: `撤销失败：${msg}` }]);
    } finally {
      setLoading(false);
    }
  }

  async function onDeleteDuplicate(entryId: string) {
    if (loading) return;
    setDuplicates((prev) => prev.map((d) => d.entryId === entryId ? { ...d, action: "deleting" as const } : d));
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 15000);
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: [entryId] }),
        signal: controller.signal,
      }).finally(() => window.clearTimeout(timeoutId));

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) {
        throw new Error(data?.error ?? "删除失败");
      }
      setDuplicates((prev) => prev.map((d) => d.entryId === entryId ? { ...d, action: "deleted" as const } : d));
      setMessages((m) => [...m, { role: "assistant", text: "✓ 重复记录已移至回收站" }]);
      setTimeout(() => {
        setDuplicates((prev) => prev.filter((d) => d.entryId !== entryId));
        setPendingDuplicates((prev) => prev.filter((d) => d.existingEntryId !== entryId));
      }, 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      setDuplicates((prev) => prev.map((d) => d.entryId === entryId ? { ...d, action: "pending" as const } : d));
      setMessages((m) => [...m, { role: "assistant", text: msg }]);
    }
  }

  async function onRestoreDuplicate(entryId: string) {
    if (loading) return;
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 15000);
      const res = await fetch("/api/v1/entries/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", transactionIds: [entryId] }),
        signal: controller.signal,
      }).finally(() => window.clearTimeout(timeoutId));

      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) {
        throw new Error(data?.error ?? "恢复失败");
      }
      setDuplicates((prev) => prev.filter((d) => d.entryId !== entryId));
      setPendingDuplicates((prev) => prev.filter((d) => d.existingEntryId !== entryId));
      setMessages((m) => [...m, { role: "assistant", text: "✓ 记录已恢复" }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "恢复失败";
      setMessages((m) => [...m, { role: "assistant", text: msg }]);
    }
  }


  function onRemember(index: number) {
    const rawText = pendingRaw || pendingItems?.[index]?.rawText || "";
    const item = getItemAt(index);
    const keyword = extractKeyword(rawText);
    const skill: CorrectionSkill = {
      keyword,
      account: item.account || undefined,
      counterparty: item.counterparty || undefined,
      category: item.category || undefined,
      remark: item.remark || undefined,
      type: item.type || undefined,
    };
    const existing = loadSkills();
    const withoutThis = existing.filter((s) => s.keyword !== keyword);
    saveSkills([...withoutThis, skill]);
    setSkillMsg(`✓ 已记住：以后类似"${keyword}"会自动填入`);
    setTimeout(() => setSkillMsg(""), 3000);
  }

  function getItemAt(index: number): ParsedItem {
    const items = pendingItems ?? [];
    const base = items[index]!;
    return drafts[index] ?? base;
  }

  function setDraftField(index: number, patch: Partial<ParsedItem>) {
    if (!pendingItems) return;
    const base = pendingItems[index]!;
    setDrafts((d) => ({ ...d, [index]: { ...base, ...d[index], ...patch } }));
  }

  function confirmRow(index: number) {
    if (!pendingItems) return;
    const draft = drafts[index];
    if (!draft) return;
    const normalized: ParsedItem = normalizeItemForImport(draft);
    setPendingItems((items) => { if (!items) return items; const next = items.slice(); next[index] = normalized; return next; });
    setDrafts((d) => { const next = { ...d }; delete next[index]; return next; });
  }

  return (
    <div
      className={`${collapsed ? "w-12" : "w-[380px]"} bg-white border-l border-slate-200 flex flex-col h-full shrink-0 shadow-[-4px_0_24px_rgba(0,0,0,0.02)] relative z-10`}
    >
      {collapsed ? (
        <div className="h-full flex flex-col items-center justify-between py-3">
          <button
            type="button"
            className="h-9 w-9 rounded-md bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center"
            onClick={() => setCollapsedPersist(false)}
            title="展开 AI 助手"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex flex-col items-center gap-2 text-slate-400">
            <Bot className="w-5 h-5" />
            <div className="writing-mode-vertical-rl text-[11px] select-none" style={{ writingMode: "vertical-rl" }}>
              AI
            </div>
          </div>
          <div className="h-9 w-9" />
        </div>
      ) : null}

      {!collapsed ? (
        <>

      {apiModalOpen ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">配置 AI Provider</div>
              <div className="mt-1 text-xs text-slate-500">请先在 AI Provider 页面完成大模型配置。</div>
            </div>
            <div className="p-4 flex flex-col gap-2">
              <a href="/settings/ai" className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 flex items-center justify-center">去配置 AI Provider</a>
              <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => setApiModalOpen(false)}>稍后</button>
            </div>
          </div>
        </div>
      ) : null}

      {importModalOpen ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden flex flex-col" style={{ maxHeight: "70vh" }}>
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
              <div className="text-sm font-semibold text-slate-800">导入账单文本</div>
              <div className="mt-1 text-xs text-slate-500">将银行账单/支付宝账单的纯文本粘贴进来，AI 将自动解析为多条记录。每行一条，可包含日期、金额、备注等信息。</div>
            </div>
            <div className="p-4 flex-1 min-h-0 flex flex-col gap-3">
              <textarea
                className="flex-1 min-h-[200px] rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none resize-none font-mono"
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"粘贴账单文本，例如：\n2024-01-01 超市消费 123.50\n2024-01-02 餐饮 45.00\n..."}
              />
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => { setImportModalOpen(false); setImportText(""); }}>取消</button>
                <button
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  disabled={!importText.trim() || loading}
                  onClick={() => {
                    if (!importText.trim()) return;
                    const text = importText.trim();
                    setImportModalOpen(false);
                    setInput(text);
                    setImportText("");
                    setTimeout(() => {
                      const sendBtn = document.querySelector("[data-ai-send]") as HTMLButtonElement | null;
                      if (sendBtn) sendBtn.click();
                    }, 50);
                  }}
                >
                  解析
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="h-12 border-b border-slate-200 flex items-center px-4 shrink-0 bg-slate-50/80 backdrop-blur-sm gap-2">
        <Bot className="w-4 h-4 text-blue-600 shrink-0" />
        <span className="text-sm font-medium text-slate-800 shrink-0">AI 助手</span>
        <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="h-7 w-7 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 flex items-center justify-center shrink-0"
          onClick={() => setCollapsedPersist(true)}
          title="收起"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        {mounted ? (
          <select
            className="flex-1 h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none min-w-0 max-w-[160px]"
            value={activeModel}
            onChange={(e) => {
              const next = e.target.value;
              if (!next) return;
              setActiveModel(next);
              try { localStorage.setItem("wiseme_ai_active_model", next); } catch { /* ignore */ }
            }}
          >
            {modelNames.length === 0 && <option value="">无模型</option>}
            {modelNames.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((m, idx) => {
          if (m.role === "user") {
            return (
              <div key={idx} className="flex flex-col items-end gap-1">
                <div className="bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-tr-sm max-w-[90%] text-sm shadow-sm whitespace-pre-wrap">{m.text}</div>
              </div>
            );
          }

          return (
            <div key={idx} className="flex flex-col items-start gap-2">
              {m.trace?.length ? (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 max-w-[95%] w-full">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 mb-2">
                    <BrainCircuit className="w-4 h-4 text-slate-400" />
                    处理过程
                  </div>
                  <div className="text-xs text-slate-600 space-y-1.5 font-mono bg-white p-2 rounded border border-slate-100">
                    {m.trace.map((t, i) => <div key={i}>› {t}</div>)}
                  </div>
                </div>
              ) : null}

              <div className="bg-slate-100 text-slate-800 px-4 py-2.5 rounded-2xl rounded-tl-sm max-w-[90%] text-sm shadow-sm border border-slate-200/50 whitespace-pre-wrap">
                {m.text}
                {m.error ? <div className="mt-1 text-xs text-red-500 font-mono">{m.error}</div> : null}
              </div>

              {m.items?.length ? (
                <div className="bg-white border border-slate-200 rounded-xl w-full overflow-hidden">
                  <div className="px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-50 flex items-center justify-between">
                    <span>解析结果</span>
                    <button
                      className="text-xs px-2 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                      disabled={loading || !(pendingItems?.length ?? 0)}
                      onClick={() => openCreateTransactionWindow(confirmIndexRef.current)}
                    >
                      打开记账窗口
                    </button>
                  </div>
                  <div className="p-3 text-xs text-slate-600">
                    {pendingItems?.length ? `待补齐并导入：${pendingItems.length} 条。` : "暂无数据"}
                  </div>
                </div>
              ) : null}

              {duplicates.length > 0 ? (
                <div className="bg-amber-50 border border-amber-200 rounded-xl w-full overflow-hidden">
                  <div className="px-3 py-2 text-xs font-semibold text-amber-700 bg-amber-100/50 flex items-center gap-2">
                    <span>⚠️ 检测到 {duplicates.length} 条可能重复的记录</span>
                  </div>
                  <div className="p-2 space-y-2 max-h-64 overflow-y-auto">
                    {duplicates.map((dup) => (
                      <div key={dup.entryId} className="bg-white border border-amber-200 rounded-lg p-2.5 text-xs">
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-700">{dup.accountName}</span>
                            <span className="text-red-500 font-semibold">¥{formatMoney(Math.abs(dup.amount))}</span>
                            <span className="text-slate-400">{dup.date}</span>
                          </div>
                          {dup.action === "pending" && (
                            <div className="flex gap-1.5">
                              <button
                                className="px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 text-[10px]"
                                onClick={() => onDeleteDuplicate(dup.entryId)}
                                disabled={loading}
                              >
                                删除
                              </button>
                              <button
                                className="px-2 py-0.5 rounded bg-emerald-500 text-white hover:bg-emerald-600 text-[10px]"
                                onClick={() => {
                                  setDuplicates((prev) => prev.filter((d) => d.entryId !== dup.entryId));
                                  setPendingDuplicates((prev) => prev.filter((d) => d.existingEntryId !== dup.entryId));
                                  setMessages((m) => [...m, { role: "assistant", text: "已忽略此重复提示" }]);
                                }}
                              >
                                忽略
                              </button>
                            </div>
                          )}
                          {dup.action === "deleting" && (
                            <span className="text-amber-600 text-[10px]">删除中...</span>
                          )}
                          {dup.action === "deleted" && (
                            <span className="text-emerald-600 text-[10px]">✓ 已删除</span>
                          )}
                        </div>
                        <div className="text-slate-500 text-[10px]">
                          已有相同金额记录，是否删除？
                        </div>
                      </div>
                    ))}
                  </div>
                  {duplicates.some((d) => d.action === "pending") && (
                    <div className="px-3 py-2 border-t border-amber-200 flex gap-2">
                      <button
                        className="flex-1 h-7 text-xs px-3 rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
                        disabled={loading}
                        onClick={async () => {
                          const pending = duplicates.filter((d) => d.action === "pending");
                          for (const dup of pending) {
                            await onDeleteDuplicate(dup.entryId);
                            await new Promise((r) => setTimeout(r, 300));
                          }
                        }}
                      >
                        全部删除
                      </button>
                      <button
                        className="flex-1 h-7 text-xs px-3 rounded bg-slate-200 text-slate-700 hover:bg-slate-300"
                        onClick={() => {
                          setDuplicates([]);
                          setPendingDuplicates([]);
                          setMessages((m) => [...m, { role: "assistant", text: "已忽略全部重复提示" }]);
                        }}
                      >
                        全部忽略
                      </button>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}

        {loading && (
          <div className="flex items-center gap-2 text-xs text-slate-500 pl-4">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
            处理中…
          </div>
        )}
      </div>

      {skillMsg && (
        <div className="absolute bottom-20 left-4 right-4 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 z-30">{skillMsg}</div>
      )}

      {accountResolveDialog ? (
        <div className="absolute inset-0 z-40 bg-black/35 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 shadow-lg">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800">账户确认</div>
            {accountResolveDialog.stage === "confirmCreate" ? (
              <div className="px-4 py-3 text-sm text-slate-700 space-y-3">
                <div>识别到账户：<span className="font-medium">{accountResolveDialog.suggested || "（空）"}</span></div>
                <div>是否新建此账户并写入该条记录？</div>
                <div className="flex justify-end gap-2 pt-1">
                  <button className="h-8 px-3 rounded-md border border-slate-300 text-slate-700 text-sm hover:bg-slate-50" onClick={onCancelCreateGoPick} disabled={loading}>取消并改选</button>
                  <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={onConfirmCreateAccount} disabled={loading}>确定新建并写入</button>
                </div>
              </div>
            ) : (
              <div className="px-4 py-3 text-sm text-slate-700 space-y-3">
                <div>请选择目标账户（默认已给出相关账户）：</div>
                <select
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={accountResolveDialog.selected}
                  onChange={(e) => setAccountResolveDialog((d) => d ? { ...d, selected: e.target.value } : d)}
                >
                  {accountOptions.map((a) => <option key={a.id} value={a.label}>{a.label}</option>)}
                </select>
                <div className="flex justify-end gap-2 pt-1">
                  <button className="h-8 px-3 rounded-md border border-slate-300 text-slate-700 text-sm hover:bg-slate-50" onClick={() => setAccountResolveDialog(null)} disabled={loading}>继续取消</button>
                  <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={onConfirmPickExisting} disabled={loading}>确定并写入</button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {confirmDialog ? (
        <div className="absolute inset-0 z-40 bg-black/35 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl max-h-[70vh] rounded-xl bg-white border border-slate-200 shadow-lg flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-semibold text-slate-800 flex items-center justify-between">
              <span>{confirmDialog.label}</span>
              <button className="h-7 w-7 rounded hover:bg-slate-100 flex items-center justify-center" onClick={() => setConfirmDialog(null)} disabled={loading}>
                <span className="text-slate-400 text-lg">&times;</span>
              </button>
            </div>
            <div className="px-4 py-2 text-sm text-slate-700">
              <div className="mb-2 font-medium">{confirmDialog.tip}</div>
              {confirmDialog.targets && confirmDialog.targets.length > 0 && (
                <div className="max-h-[250px] overflow-y-auto border border-slate-100 rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        {confirmDialog.kind === "batchInvest" && <th className="text-right px-2 py-1 text-slate-500 w-12">序号</th>}
                        <th className="text-left px-2 py-1 text-slate-500">日期</th>
                        {confirmDialog.kind !== "batchInvest" && <th className="text-left px-2 py-1 text-slate-500">账户</th>}
                        <th className="text-right px-2 py-1 text-slate-500">金额</th>
                        <th className="text-left px-2 py-1 text-slate-500">备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {confirmDialog.targets.map((t, i) => (
                        <tr key={t.id ?? t.transactionId ?? i} className="border-t border-slate-50">
                          {confirmDialog.kind === "batchInvest" && <td className="px-2 py-1 text-right tabular-nums text-slate-400">{i + 1}</td>}
                          <td className="px-2 py-1 tabular-nums">{t.date}</td>
                          {confirmDialog.kind !== "batchInvest" && <td className="px-2 py-1">{t.accountName}</td>}
                          <td className="px-2 py-1 text-right tabular-nums">{formatMoney(Math.abs(t.amount))}</td>
                          <td className="px-2 py-1 text-slate-400 truncate max-w-[120px]">{t.remark || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                    {confirmDialog.kind === "batchInvest" && (
                      <tfoot className="bg-slate-50 font-medium">
                        <tr>
                          <td className="px-2 py-1 text-right text-slate-600" colSpan={3}>合计 {confirmDialog.count} 期</td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-800">{formatMoney(confirmDialog.count * (confirmDialog.targets?.[0]?.amount ?? 0))}</td>
                          <td></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
              {confirmDialog.count > 10 && confirmDialog.kind !== "batchInvest" && (
                <div className="mt-1 text-xs text-slate-400">… 共 {confirmDialog.count} 条</div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                className="h-8 px-3 rounded-md border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
                onClick={() => setConfirmDialog(null)}
                disabled={loading}
              >
                取消
              </button>
              <button
                className={`h-8 px-3 rounded-md text-white text-sm disabled:opacity-50 ${confirmDialog.kind === "batchInvest" ? "bg-blue-600 hover:bg-blue-700" : "bg-red-600 hover:bg-red-700"}`}
                onClick={onConfirmBatchAction}
                disabled={loading}
              >
                {confirmDialog.kind === "batchInvest" ? "确认创建" : "确认执行"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {batchUpdateDialog ? (
        <div className="absolute inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[80vh] rounded-xl bg-white border border-slate-200 shadow-lg flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div>
                <div className="text-sm font-semibold text-slate-800">批量修改记录</div>
                <div className="text-xs text-slate-500 mt-0.5">共 {batchUpdateDialog.entries.length} 条</div>
              </div>
              <button className="h-7 w-7 rounded hover:bg-slate-100 flex items-center justify-center" onClick={() => setBatchUpdateDialog(null)}>
                <X className="w-4 h-4 text-slate-500" />
              </button>
            </div>
            <div className="px-4 py-2 border-b border-slate-100 bg-slate-50 flex gap-4 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">批量账户：</span>
                <select
                  className="h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none"
                  value={batchUpdateDialog.batchAccountName ?? ""}
                  onChange={(e) => setBatchUpdateDialog((d) => d ? { ...d, batchAccountName: e.target.value } : d)}
                >
                  <option value="">（不修改）</option>
                  {accountOptions.map((a) => <option key={a.id} value={a.label}>{a.label}</option>)}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">批量类型：</span>
                <select
                  className="h-7 rounded border border-slate-200 bg-white px-2 text-xs outline-none"
                  value={batchUpdateDialog.batchType ?? ""}
                  onChange={(e) => setBatchUpdateDialog((d) => d ? { ...d, batchType: e.target.value } : d)}
                >
                  <option value="">（不修改）</option>
                  <option value="expense">支出</option>
                  <option value="income">收入</option>
                  <option value="transfer">转账</option>
                </select>
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-slate-600 font-medium w-24">日期</th>
                    <th className="px-2 py-1.5 text-right text-slate-600 font-medium w-24">金额</th>
                    <th className="px-2 py-1.5 text-left text-slate-600 font-medium w-28">类型</th>
                    <th className="px-2 py-1.5 text-left text-slate-600 font-medium">账户</th>
                    <th className="px-2 py-1.5 text-left text-slate-600 font-medium">备注</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {batchUpdateDialog.entries.map((entry) => {
                    const draft = batchUpdateDialog.drafts[entry.id] ?? {};
                    const accountName = batchUpdateDialog.batchAccountName
                      ? batchUpdateDialog.batchAccountName
                      : (draft.accountName ?? entry.accountName);
                    const type = batchUpdateDialog.batchType
                      ? batchUpdateDialog.batchType
                      : (draft.type ?? entry.type ?? "expense");
                    return (
                      <tr key={entry.id}>
                        <td className="px-2 py-1.5 text-slate-700">{entry.date}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">¥{Math.abs(entry.amount).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="px-2 py-1.5">
                          <select
                            className="w-full px-1 py-1 rounded border border-slate-200 text-slate-700 focus:border-blue-400 focus:outline-none"
                            value={type}
                            onChange={(e) => setBatchUpdateDialog((d) => d ? {
                              ...d,
                              drafts: { ...d.drafts, [entry.id]: { ...d.drafts[entry.id], type: e.target.value } },
                            } : d)}
                          >
                            <option value="expense">支出</option>
                            <option value="income">收入</option>
                            <option value="transfer">转账</option>
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text"
                            className="w-full px-2 py-1 rounded border border-slate-200 text-slate-700 focus:border-blue-400 focus:outline-none"
                            value={accountName}
                            onChange={(e) => setBatchUpdateDialog((d) => d ? {
                              ...d,
                              drafts: { ...d.drafts, [entry.id]: { ...d.drafts[entry.id], accountName: e.target.value } },
                            } : d)}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text"
                            className="w-full px-2 py-1 rounded border border-slate-200 text-slate-700 focus:border-blue-400 focus:outline-none"
                            value={draft.remark ?? entry.remark}
                            onChange={(e) => setBatchUpdateDialog((d) => d ? {
                              ...d,
                              drafts: { ...d.drafts, [entry.id]: { ...d.drafts[entry.id], remark: e.target.value } },
                            } : d)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2 shrink-0">
              <button
                className="h-8 px-4 rounded-md border border-slate-300 text-slate-700 text-sm hover:bg-slate-50"
                onClick={() => setBatchUpdateDialog(null)}
                disabled={loading}
              >
                取消
              </button>
              <button
                className="h-8 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                onClick={onConfirmBatchUpdate}
                disabled={loading}
              >
                批量修改
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {undoDeleteTargets.length > 0 ? (
        <div className="px-3 pb-2">
          <button
            className="w-full h-8 rounded-md border border-amber-300 bg-amber-50 text-amber-700 text-sm hover:bg-amber-100 disabled:opacity-50"
            onClick={onUndoLastDelete}
            disabled={loading}
          >
            ↩ 撤销刚刚删除（{undoDeleteTargets.length} 条）
          </button>
        </div>
      ) : null}

      <div className="p-3 border-t border-slate-200 space-y-2">
        <div className="flex gap-2">
          <input
            className="flex-1 h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            onPaste={onPaste}
            placeholder="输入指令或粘贴账单文本，回车发送"
          />
          <button className="h-9 w-9 flex items-center justify-center rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50" disabled={loading || !input.trim()} onClick={onSend} data-ai-send>
            {loading ? <span className="animate-spin h-4 w-4 block">⟳</span> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <div className="flex gap-2">
          <button
            className="flex-1 h-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50"
            onClick={() => setImportModalOpen(true)}
          >
            <FileText className="w-3.5 h-3.5 mr-1" />导入账单
          </button>
          <label className="flex-1 h-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 cursor-pointer">
            <Mic className="w-3.5 h-3.5 mr-1" />截图识别
            <input type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); e.target.value = ""; }} />
          </label>
          <button
            className="flex-1 h-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            disabled={loading}
            onClick={() => {
              const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
              if (SpeechRecognition) {
                const r = new SpeechRecognition();
                r.lang = "zh-CN";
                r.onresult = (e: any) => { setInput(i => i + e.results[0][0].transcript); };
                r.start();
              }
            }}
          >
            <Mic className="w-3.5 h-3.5 mr-1" />语音输入
          </button>
        </div>
      </div>
        </>
      ) : null}
    </div>
  );
}
