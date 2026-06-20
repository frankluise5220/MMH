"use client";

import { useState, useEffect } from "react";
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

  useEffect(() => {
    // 移除导致无限闪烁或重绘的 debug 上报
    fetch("/api/v1/settings/fund-query-api")
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
          setApis(Array.isArray(payload.apis) ? payload.apis : []);
          setLoadError("");
        } else {
          setApis([]);
          const hint = "ok" in payload ? (payload.error || `请求失败（${status}）`) : `请求失败（${status}）`;
          setLoadError(hint);
        }
      })
      .catch(() => {
        setApis([]);
        setLoadError("请求失败（网络或服务异常）");
      })
      .finally(() => setLoading(false));
  }, []);

  function openEdit(api: FundQueryApiRecord) {
    setEditingId(api.id);
    setForm(makeForm(api));
  }

  function openCreate() {
    setEditingId("__new__");
    setForm(makeForm({ code: "", name: "", priority: apis.length, isActive: true }));
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
            优先级数值越小越先执行。
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
                  <div className="text-xs font-medium text-slate-600">优先级</div>
                  <input type="number" value={form.priority ?? 0} onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
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
        {apis.map((api) => (
          <div key={api.id}
            className={`rounded-lg border p-4 ${api.isActive ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-60"}`}
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
                    <div className="text-xs font-medium text-slate-600">优先级</div>
                    <input type="number" value={form.priority ?? 0} onChange={e => setForm(f => ({ ...f, priority: Number(e.target.value) }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
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
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{api.name}</span>
                    <span className="text-[10px] text-slate-400 font-mono">{api.code}</span>
                    <span className="text-[10px] text-slate-400">优先级:{api.priority}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5 truncate">{api.baseUrl}</div>
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