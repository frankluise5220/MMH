"use client";

import { useState, useEffect, type DragEvent } from "react";
import { parseBaseUrl, buildBaseUrl, PROTOCOL_OPTIONS, PORT_SUGGESTIONS } from "@/lib/urlInput";
import type { ParsedUrl } from "@/lib/urlInput";

type FundQueryApiRecord = {
  id: string;
  code: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  priority: number;
  isActive: boolean;
};

type EditForm = Omit<Partial<FundQueryApiRecord>, "baseUrl"> & {
  urlParts: ParsedUrl;
};

function makeForm(api?: Partial<FundQueryApiRecord> | null): EditForm {
  return {
    code: api?.code ?? "",
    name: api?.name ?? "",
    urlParts: parseBaseUrl(api?.baseUrl),
    apiKey: api?.apiKey ?? "",
    priority: api?.priority ?? 0,
    isActive: api?.isActive ?? true,
  };
}

function flatForm(f: EditForm): Omit<EditForm, "urlParts"> & { baseUrl: string } {
  return {
    code: f.code,
    name: f.name,
    baseUrl: buildBaseUrl(f.urlParts),
    apiKey: f.apiKey,
    priority: f.priority,
    isActive: f.isActive,
  };
}

function sortApis(apis: FundQueryApiRecord[]) {
  return [...apis].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function reorderApis(apis: FundQueryApiRecord[], sourceId: string, targetId: string) {
  const next = [...apis];
  const from = next.findIndex((api) => api.id === sourceId);
  const to = next.findIndex((api) => api.id === targetId);
  if (from < 0 || to < 0 || from === to) return apis;
  const [moved] = next.splice(from, 1);
  if (!moved) return apis;
  next.splice(to, 0, moved);
  return next.map((api, index) => ({ ...api, priority: index + 1 }));
}

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
          placeholder="fund.example.com"
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
          placeholder="/api/fund（可选）"
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
      </div>
    </div>
  );
}

export default function FundQueryApiPage() {
  const [apis, setApis] = useState<FundQueryApiRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm>(makeForm());
  const [saving, setSaving] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/settings/fund-query-api", { signal: controller.signal })
      .then(async (r) => {
        const text = await r.text();
        let payload: { ok?: boolean; apis?: FundQueryApiRecord[]; error?: string } | { raw: string } = { raw: "" };
        try {
          payload = JSON.parse(text) as { ok?: boolean; apis?: FundQueryApiRecord[]; error?: string };
        } catch {
          payload = { raw: text.slice(0, 200) };
        }
        return { status: r.status, ok: r.ok, payload };
      })
      .then(({ status, payload }) => {
        if ("ok" in payload && payload.ok) {
          setApis(sortApis(Array.isArray(payload.apis) ? payload.apis : []));
          setLoadError("");
        } else {
          setApis([]);
          const hint = "ok" in payload ? (payload.error || `请求失败（${status}）`) : `请求失败（${status}）`;
          setLoadError(hint);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setApis([]);
        setLoadError("请求失败（网络或服务异常）");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function openEdit(api: FundQueryApiRecord) {
    setEditingId(api.id);
    setForm(makeForm(api));
  }

  function openCreate() {
    setEditingId("__new__");
    setForm(makeForm({ code: "", name: "", priority: apis.length + 1, isActive: true }));
  }

  async function saveOrder(nextApis: FundQueryApiRecord[]) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorities: nextApis.map((api, index) => ({ id: api.id, priority: index + 1 })),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setApis(sortApis(Array.isArray(data.apis) ? data.apis : nextApis));
        return true;
      } else {
        alert(data.error || "排序保存失败");
        return false;
      }
    } catch {
      alert("排序保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, id: string) {
    setDraggingId(id);
    setDragOverId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    const ghost = event.currentTarget.cloneNode(true) as HTMLElement;
    ghost.style.width = `${event.currentTarget.offsetWidth}px`;
    ghost.style.border = "2px solid rgb(37 99 235)";
    ghost.style.borderRadius = "0.75rem";
    ghost.style.boxShadow = "0 18px 45px rgba(15, 23, 42, 0.22)";
    ghost.style.background = "white";
    ghost.style.opacity = "0.98";
    ghost.style.position = "fixed";
    ghost.style.top = "-1000px";
    ghost.style.left = "-1000px";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 28, 28);
    window.setTimeout(() => ghost.remove(), 0);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, id: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (draggingId && draggingId !== id) setDragOverId(id);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>, id: string) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (dragOverId === id) setDragOverId(null);
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault();
    const sourceId = draggingId || event.dataTransfer.getData("text/plain");
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId || saving) return;
    const previous = apis;
    const next = reorderApis(apis, sourceId, targetId);
    if (next === apis) return;
    setApis(next);
    const saved = await saveOrder(next);
    if (!saved) setApis(previous);
  }

  async function save() {
    if (!editingId) return;
    setSaving(true);
    try {
      const isCreate = editingId === "__new__";
      const body = isCreate ? flatForm(form) : { id: editingId, ...flatForm(form) };
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        if (isCreate && data.api) {
          setApis(prev => [...prev, data.api].sort((a, b) => a.priority - b.priority));
        } else {
          const flat = flatForm(form);
          setApis(prev => prev.map(a => a.id === editingId ? { ...a, ...flat } as FundQueryApiRecord : a));
        }
        setEditingId(null);
        setForm(makeForm());
      } else {
        alert(data.error || "保存失败");
      }
    } catch {
      alert("保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(api: FundQueryApiRecord) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: api.id, isActive: !api.isActive }),
      });
      const data = await res.json();
      if (data.ok) {
        setApis(prev => prev.map(a => a.id === api.id ? { ...a, isActive: !a.isActive } : a));
      }
    } catch {
      alert("操作失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-slate-400">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">基金查询 API 管理</h2>
          <p className="text-xs text-slate-500 leading-relaxed mt-1">
            请求地址含 <code className="bg-slate-100 px-1 rounded text-[11px]">{"{date}"}</code> 占位符的 API 支持按日期查询历史净值；
            不含 <code className="bg-slate-100 px-1 rounded text-[11px]">{"{date}"}</code> 的 API 仅返回最新净值，查询指定日期时会被自动跳过。
            拖拽卡片调整全局优先级，越上面越先尝试；账户里单独指定默认 API 时优先于这里的顺序。
          </p>
        </div>
        <button
          onClick={openCreate}
          className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0"
        >
          + 添加 API
        </button>
      </div>

      {loadError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      <div className="space-y-2">
        {editingId === "__new__" && (
          <div className="rounded-lg border border-blue-200 bg-white p-4">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">代码</div>
                  <input value={form.code ?? ""} onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono" />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">排序</div>
                  <div className="h-9 flex items-center rounded-md border border-slate-100 bg-slate-50 px-3 text-sm text-slate-500">
                    创建后可拖拽调整
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">名称</div>
                <input value={form.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">请求地址</div>
                <UrlInputGroup value={form.urlParts} onChange={next => setForm(f => ({ ...f, urlParts: next }))} />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">API Key（可选）</div>
                <input value={form.apiKey ?? ""} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => { setEditingId(null); setForm(makeForm()); }}
                  className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">取消</button>
                <button onClick={save} disabled={saving}
                  className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">创建</button>
              </div>
            </div>
          </div>
        )}

        {apis.length === 0 && editingId !== "__new__" && (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
            暂无基金查询 API，请点击右上角"添加 API"。
          </div>
        )}
        {apis.map((api, index) => (
          <div key={api.id}
            draggable={editingId === null && !saving}
            onDragStart={(event) => handleDragStart(event, api.id)}
            onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
            onDragOver={(event) => handleDragOver(event, api.id)}
            onDragLeave={(event) => handleDragLeave(event, api.id)}
            onDrop={(event) => handleDrop(event, api.id)}
            className={`relative rounded-lg border p-4 transition ${api.isActive ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-60"} ${draggingId === api.id ? "z-10 border-blue-500 bg-blue-50/70 opacity-95 shadow-xl shadow-blue-100 ring-2 ring-blue-200" : ""} ${dragOverId === api.id && draggingId !== api.id ? "border-blue-400 bg-blue-50/60 shadow-md before:absolute before:-top-1 before:left-4 before:right-4 before:h-1 before:rounded-full before:bg-blue-500" : ""}`}
          >
            {editingId === api.id ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">名称</div>
                    <input value={form.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">排序</div>
                    <div className="h-9 flex items-center rounded-md border border-slate-100 bg-slate-50 px-3 text-sm text-slate-500">
                      第 {index + 1} 位，退出编辑后可拖拽调整
                    </div>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">请求地址</div>
                  <UrlInputGroup value={form.urlParts} onChange={next => setForm(f => ({ ...f, urlParts: next }))} />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">API Key（可选）</div>
                  <input value={form.apiKey ?? ""} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditingId(null)}
                    className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">取消</button>
                  <button onClick={save} disabled={saving}
                    className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">保存</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <div className="flex h-9 w-9 shrink-0 cursor-grab select-none items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500 active:cursor-grabbing">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{api.name}</span>
                    <span className="text-[10px] text-slate-400 font-mono">{api.code}</span>
                    {api.code === "alipay" && (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">支付宝账户优先</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{api.baseUrl}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <button onClick={() => toggleActive(api)} disabled={saving}
                    className={`text-xs px-2 py-0.5 rounded ${api.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                    {api.isActive ? "启用" : "停用"}
                  </button>
                  <button onClick={() => openEdit(api)}
                    className="h-7 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-700 hover:bg-slate-50">编辑</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
