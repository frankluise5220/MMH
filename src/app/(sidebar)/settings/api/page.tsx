"use client";

import { useState, useEffect } from "react";
import { copyToClipboard } from "@/lib/client/clipboard";

type AccessKey = {
  id: string;
  name: string;
  key: string;
  createdAt?: string;
};

function generateRandomKey(length = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let key = "";
  for (let i = 0; i < length; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
  return key;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [showKeyIds, setShowKeyIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    fetchKeys(controller.signal);
    return () => controller.abort();
  }, []);

  async function fetchKeys(signal?: AbortSignal) {
    try {
      const res = await fetch("/api/v1/settings/access-keys", { signal });
      const data = await res.json();
      if (data.ok && Array.isArray(data.keys)) setKeys(data.keys);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }

  async function handleCreate() {
    if (!name.trim() || !newKey.trim()) return;
    try {
      const res = await fetch("/api/v1/settings/access-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), key: newKey }),
      });
      const data = await res.json();
      if (data.ok && data.key) {
        setKeys(prev => [...prev, data.key]);
        setShowModal(false);
        setName("");
        setNewKey("");
      }
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/v1/settings/access-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) setKeys(prev => prev.filter(k => k.id !== id));
    } catch { /* ignore */ }
  }

  function toggleShow(id: string) {
    setShowKeyIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">外接 API Key</h2>
          <p className="mt-1 text-xs text-slate-500">用于第三方 Agent 访问本系统的认证密钥。</p>
        </div>
        <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700"
          onClick={() => { setNewKey(generateRandomKey()); setName(""); setShowModal(true); }}>
          + 新 增 Key
        </button>
      </div>

      {keys.length > 0 ? (
        <div className="border border-slate-200 rounded-md overflow-hidden bg-white">
          <div className="px-3 py-2 text-xs text-slate-500 bg-slate-50 border-b border-slate-100">已创建 Key</div>
          <div className="divide-y divide-slate-100">
            {keys.map((k) => (
              <div key={k.id} className="px-3 py-2 flex items-center gap-2">
                <span className="text-sm text-slate-800 w-32 truncate shrink-0">{k.name}</span>
                <span className="text-xs text-slate-400 flex-1 truncate font-mono">{showKeyIds.has(k.id) ? k.key : "••••••••"}</span>
                <button className="text-xs text-slate-500 hover:text-blue-600 shrink-0" onClick={() => toggleShow(k.id)}>
                  {showKeyIds.has(k.id) ? "隐藏" : "显示"}
                </button>
                {showKeyIds.has(k.id) && <button className="text-xs text-slate-500 hover:text-blue-600 shrink-0" onClick={() => copyToClipboard(k.key)}>复制</button>}
                <button className="text-xs text-red-500 hover:text-red-600 shrink-0" onClick={() => handleDelete(k.id)}>删除</button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="h-20 flex flex-col items-center justify-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-md bg-white">
          <span>暂无 API Key</span>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">新增 API Key</div>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">名称</label>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={name} onChange={(e) => setName(e.target.value)} placeholder="如：OpenClaw-Prod" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Key</label>
                <div className="flex items-center gap-2">
                  <div className="h-9 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 overflow-hidden font-mono">{newKey}</div>
                  <button className="h-9 px-3 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                    onClick={() => copyToClipboard(newKey)}>复制</button>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  onClick={() => setShowModal(false)}>取消</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  onClick={handleCreate} disabled={!name.trim()}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
