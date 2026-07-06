"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { fetchSettingsTags, getCachedSettingsTags, setSettingsTags } from "@/lib/client/settingsCache";

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

export default function SettingsTagsClient({
  initialTags,
  initialLoaded = false,
}: {
  initialTags: Tag[];
  initialLoaded?: boolean;
}) {
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(COLORS[6]);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialLoaded) {
      setSettingsTags(initialTags);
      return;
    }
    const cached = getCachedSettingsTags();
    if (cached) {
      setTags(cached);
      return;
    }
    fetchTags();
  }, [initialLoaded, initialTags]);

  async function fetchTags() {
    const next = await fetchSettingsTags().catch(() => null);
    if (next) setTags(next);
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
      setTags(prev => {
        const next = [...prev, data.tag];
        setSettingsTags(next);
        return next;
      });
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
    if (data.ok) setTags(prev => {
      const next = prev.filter(t => t.id !== id);
      setSettingsTags(next);
      return next;
    });
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

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="text-sm font-medium text-slate-700">新建标签</div>
        </div>
        <div className="p-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1.5 block text-xs text-slate-500">名称</label>
              <input
                ref={inputRef}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleAdd(); }}
                className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
                placeholder="输入标签名称"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-slate-500">颜色</label>
              <div className="flex gap-1.5">
                {COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`h-7 w-7 rounded-full border-2 transition-transform ${newColor === c ? "scale-110 border-slate-800" : "border-transparent hover:scale-105"}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <button
              onClick={handleAdd}
              disabled={adding || !newName.trim()}
              className="flex h-9 shrink-0 items-center gap-1 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />添加
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <div className="text-sm font-medium text-slate-700">
            已有标签
            <span className="ml-1 text-xs text-slate-400">（{tags.length} 个）</span>
          </div>
        </div>
        <div className="p-4">
          {tags.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-400">暂无标签，请在上方创建</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map(tag => (
                <div
                  key={tag.id}
                  className="group flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300"
                >
                  <div
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color || "#64748B" }}
                  />
                  <span className="text-sm text-slate-700">{tag.name}</span>
                  <button
                    onClick={() => handleDelete(tag.id)}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
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
