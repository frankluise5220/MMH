"use client";

import { useState, useEffect } from "react";

type FundQueryApiRecord = {
  id: string;
  code: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  priority: number;
  isActive: boolean;
};

export default function FundQueryApiPage() {
  const [apis, setApis] = useState<FundQueryApiRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<FundQueryApiRecord>>({});
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
      .catch((error) => {
        setApis([]);
        setLoadError("请求失败（网络或服务异常）");
      })
      .finally(() => setLoading(false));
  }, []);

  function openEdit(api: FundQueryApiRecord) {
    setEditingId(api.id);
    setForm({
      name: api.name,
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      priority: api.priority,
      isActive: api.isActive,
    });
  }

  function openCreate() {
    setEditingId("__new__");
    setForm({
      code: "",
      name: "",
      baseUrl: "",
      apiKey: "",
      priority: apis.length,
      isActive: true,
    });
  }

  async function save() {
    if (!editingId) return;
    setSaving(true);
    try {
      const isCreate = editingId === "__new__";
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isCreate ? form : { id: editingId, ...form }),
      });
      const data = await res.json();
      if (data.ok) {
        if (isCreate && data.api) {
          setApis(prev => [...prev, data.api].sort((a, b) => a.priority - b.priority));
        } else {
          setApis(prev => prev.map(a => a.id === editingId ? { ...a, ...form } as FundQueryApiRecord : a));
        }
        setEditingId(null);
        setForm({});
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
                <input value={form.baseUrl ?? ""} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono" />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">API Key（可选）</div>
                <input value={form.apiKey ?? ""} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => { setEditingId(null); setForm({}); }}
                  className="h-8 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">取消</button>
                <button onClick={save} disabled={saving}
                  className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">创建</button>
              </div>
            </div>
          </div>
        )}

        {apis.length === 0 && editingId !== "__new__" && (
          <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
            暂无基金查询 API，请点击右上角“添加 API”。
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
                  <input value={form.baseUrl ?? ""} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))}
                    className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono" />
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
