"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";

type Tag = {
  id: string;
  name: string;
  color: string | null;
};

const COLORS = [
  "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#22C55E",
  "#14B8A6", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899",
  "#64748B", "#0EA5E9",
];

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLORS[6]);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { fetchTags(); }, []);

  async function fetchTags() {
    const res = await fetch("/api/v1/tags").catch(() => null);
    if (!res) return;
    const data = await res.json();
    if (data.ok) setTags(data.tags);
  }

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true);
    const res = await fetch("/api/v1/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), color: newColor }),
    });
    const data = await res.json();
    if (data.ok) {
      setTags(prev => [...prev, data.tag]);
      setNewName("");
      inputRef.current?.focus();
    } else {
      window.alert(data.error || "添加失败");
    }
    setAdding(false);
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/v1/tags?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) setTags(prev => prev.filter(t => t.id !== id));
    else window.alert(data.error || "删除失败");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">标签管理</h2>
          <p className="mt-1 text-xs text-slate-500">创建标签，记账时可关联，便于按标签分类统计。</p>
        </div>
      </div>

      {/* 新增 */}
      <div className="bg-white border border-slate-200 rounded-xl">
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-medium text-slate-700">新建标签</div>
        </div>
        <div className="p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs text-slate-500 mb-1.5">名称</label>
              <input ref={inputRef} value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleAdd(); }}
                className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
                placeholder="输入标签名称" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1.5">颜色</label>
              <div className="flex gap-1.5">
                {COLORS.map(c => (
                  <button key={c} type="button"
                    onClick={() => setNewColor(c)}
                    className={`w-7 h-7 rounded-full border-2 transition-transform ${newColor === c ? "border-slate-800 scale-110" : "border-transparent hover:scale-105"}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            <button onClick={handleAdd} disabled={adding || !newName.trim()}
              className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1 shrink-0">
              <Plus className="w-3.5 h-3.5" />添加
            </button>
          </div>
        </div>
      </div>

      {/* 标签列表 */}
      <div className="bg-white border border-slate-200 rounded-xl">
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="text-sm font-medium text-slate-700">
            已有标签
            <span className="ml-1 text-xs text-slate-400">（{tags.length} 个）</span>
          </div>
        </div>
        <div className="p-4">
          {tags.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">暂无标签，请在上方创建</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map(tag => (
                <div key={tag.id}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white group hover:border-slate-300">
                  <div className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: tag.color || "#64748B" }} />
                  <span className="text-sm text-slate-700">{tag.name}</span>
                  <button onClick={() => handleDelete(tag.id)}
                    className="h-5 w-5 flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-500 hover:bg-red-50">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
