"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, ChevronRight } from "lucide-react";

type Category = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  isSystem: boolean;
};

const typeLabel = (t: string) =>
  t === "expense" ? "支出" : t === "income" ? "收入" : t === "investment" ? "投资" : t === "transfer" ? "转账" : t;

const TYPE_ORDER = ["expense", "income", "investment", "transfer"] as const;

export default function SettingsCategoriesClient({ categories }: { categories: Category[] }) {
  const [selectedType, setSelectedType] = useState<string>("expense");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const roots = categories.filter((c) => c.parentId === null);
  const rootMap = new Map(roots.map((c) => [c.type, c]));

  // Ensure the 4 type roots exist
  const existingTypes = new Set(roots.map(c => c.type));
  const missingTypes = TYPE_ORDER.filter(t => !existingTypes.has(t));

  const selectedRoot = rootMap.get(selectedType);
  const selectedCategory = selectedId ? categories.find((c) => c.id === selectedId) : null;

  // L2: children of selected root
  const l2Categories = selectedRoot
    ? categories.filter((c) => c.parentId === selectedRoot.id)
    : [];

  // L3: grandchildren of selected L2
  const l3Categories = selectedCategory
    ? categories.filter((c) => c.parentId === selectedCategory.id)
    : [];

  // What parent will a new category be created under?
  const addParentId = selectedCategory?.id ?? selectedRoot?.id ?? null;
  const addParentLabel = selectedCategory
    ? selectedCategory.name
    : selectedRoot
      ? typeLabel(selectedType)
      : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, [selectedId, selectedType]);

  function selectType(type: string) {
    setSelectedType(type);
    setSelectedId(null);
  }

  async function handleAdd() {
    if (!newName.trim() || !addParentId) return;
    setSaving(true);
    try {
      const parent = categories.find(c => c.id === addParentId);
      const res = await fetch("/api/v1/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          type: parent?.type ?? selectedType,
          parentId: addParentId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewName("");
        window.location.reload();
      } else {
        window.alert(data.error || "添加失败");
      }
    } catch {
      window.alert("添加失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch("/api/v1/settings/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "category", id }),
      });
      const data = await res.json();
      if (data.ok) window.location.reload();
      else window.alert(data.error || "删除失败");
    } catch {
      window.alert("删除失败");
    }
  }

  async function handleCreateRoot(type: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: typeLabel(type), type }),
      });
      const data = await res.json();
      if (data.ok) window.location.reload();
      else window.alert(data.error || "创建失败");
    } catch {
      window.alert("创建失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* 左侧：类型标签 + L2列表 */}
      <div className="w-64 border-r border-slate-200 bg-white flex flex-col shrink-0">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-800">分类管理</div>
        </div>

        {/* 类型标签 */}
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="flex flex-wrap gap-1">
            {TYPE_ORDER.map((type) => {
              const root = rootMap.get(type);
              if (!root) {
                return (
                  <button key={type} disabled={saving}
                    onClick={() => handleCreateRoot(type)}
                    className="px-2 py-1 text-xs rounded-md bg-slate-100 text-slate-400 hover:bg-slate-200"
                    title={`创建${typeLabel(type)}根分类`}>
                    + {typeLabel(type)}
                  </button>
                );
              }
              const active = selectedType === type;
              return (
                <button key={type}
                  onClick={() => selectType(type)}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${active ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {typeLabel(type)}
                </button>
              );
            })}
          </div>
        </div>

        {/* L2 列表 */}
        <div className="flex-1 overflow-auto py-1">
          {!selectedRoot && (
            <div className="px-4 py-8 text-center text-xs text-slate-400">请先选择类型标签</div>
          )}
          {selectedRoot && l2Categories.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-slate-400">暂无子分类</div>
          )}
          {l2Categories.map((cat) => (
            <div key={cat.id}
              onClick={() => setSelectedId(cat.id === selectedId ? null : cat.id)}
              className={`flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-slate-50 ${selectedId === cat.id ? "bg-blue-50" : ""}`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-slate-700 truncate">{cat.name}</span>
                {categories.filter(c => c.parentId === cat.id).length > 0 && (
                  <span className="text-[10px] text-slate-400 shrink-0">({categories.filter(c => c.parentId === cat.id).length})</span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {cat.isSystem && <span className="text-[10px] text-slate-400">系统</span>}
                <ChevronRight className="w-3 h-3 text-slate-300" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧：新增 + L3列表 */}
      <div className="flex-1 bg-slate-50 p-6 flex flex-col gap-4 min-w-0">
        {/* 新增表单 */}
        {addParentLabel && (
          <div className="bg-white border border-slate-200 rounded-xl shrink-0">
            <div className="px-4 py-3 border-b border-slate-200">
              <div className="text-sm font-semibold text-slate-800">
                新增分类
                <span className="ml-2 text-sm font-normal text-slate-500">在「{addParentLabel}」下</span>
              </div>
            </div>
            <div className="p-4">
              <div className="flex gap-2">
                <input ref={inputRef}
                  value={newName} onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
                  className="flex-1 h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
                  placeholder="输入分类名称" />
                <button onClick={handleAdd} disabled={saving || !newName.trim()}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1 shrink-0">
                  <Plus className="w-3.5 h-3.5" />添加
                </button>
              </div>
            </div>
          </div>
        )}

        {/* L3 子分类 */}
        {selectedCategory && (
          <div className="bg-white border border-slate-200 rounded-xl">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="text-sm font-medium text-slate-700">{selectedCategory.name} 的子分类</div>
            </div>
            <div className="p-4">
              {l3Categories.length === 0 ? (
                <div className="text-xs text-slate-400 py-4 text-center">暂无子分类，请在上方添加</div>
              ) : (
                <div className="space-y-1">
                  {l3Categories.map((gc) => (
                    <div key={gc.id} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-slate-50">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-700">{gc.name}</span>
                        {gc.isSystem && <span className="text-[10px] text-slate-400">系统</span>}
                      </div>
                      {!gc.isSystem && (
                        <button onClick={() => handleDelete(gc.id)}
                          className="h-7 w-7 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:text-red-600 hover:border-red-200"
                          title={`删除：${gc.name}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
