"use client";

import { useEffect, useState, useRef } from "react";
import { Trash2, ChevronRight, ChevronDown, Plus, Save, Pencil, X } from "lucide-react";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { fetchSettingsCategories, getCachedSettingsCategories, setSettingsCategories } from "@/lib/client/settingsCache";

type Category = {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  isSystem: boolean;
};

const typeLabel = (t: string) =>
  t === "expense" ? "支出" : t === "income" ? "收入" : t === "advance" ? "代付" : t === "investment" ? "投资" : t;

const typeColor = (t: string) =>
  t === "expense" ? "text-red-600" : t === "income" ? "text-emerald-600" : t === "advance" ? "text-amber-600" : "text-blue-600";

const TYPE_ORDER = ["expense", "income", "advance"] as const;

export default function SettingsCategoriesClient({ categories: initialCategories }: { categories: Category[] }) {
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [addingType, setAddingType] = useState<string>("expense");
  const [editingName, setEditingName] = useState("");
  const [inlineEditingId, setInlineEditingId] = useState<string | null>(null);
  const [inlineEditingName, setInlineEditingName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [inlineSavingId, setInlineSavingId] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const cached = getCachedSettingsCategories();
    if (cached) setCategories(cached as Category[]);
    fetchSettingsCategories()
      .then((next) => setCategories(next as Category[]))
      .catch(() => null);
  }, []);

  const roots = categories.filter(c => c.parentId === null);
  const childrenMap = new Map<string, Category[]>();
  for (const c of categories) {
    if (c.parentId) {
      const list = childrenMap.get(c.parentId) || [];
      list.push(c);
      childrenMap.set(c.parentId, list);
    }
  }
  function getChildren(id: string) { return childrenMap.get(id) || []; }

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function select(id: string) {
    const category = categories.find(c => c.id === id);
    setSelectedId(id);
    setAddingUnder(null);
    setEditingName(category?.name ?? "");
    setEditError("");
  }

  function openAdd(parentId: string | null, type?: string) {
    setAddingUnder(parentId);
    if (type) setAddingType(type);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  /** Handle entity creation from EntityCreateForm */
  function handleCategoryCreated(id: string, name: string) {
    // We need to construct the full category object. The API returns it, but
    // EntityCreateForm only passes id/name/extra. We reconstruct from the form context.
    const parent = addingUnder && addingUnder !== "__root__"
      ? categories.find(c => c.id === addingUnder)
      : null;
    const created: Category = {
      id,
      name,
      type: parent?.type ?? addingType,
      parentId: addingUnder === "__root__" ? null : addingUnder || null,
      isSystem: false,
    };
    setCategories(prev => {
      const next = [...prev, created];
      setSettingsCategories(next);
      return next;
    });
    if (addingUnder && addingUnder !== "__root__") {
      setExpanded(prev => new Set([...prev, addingUnder]));
    }
    setAddingUnder(null);
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch("/api/v1/settings/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "category", id }),
      });
      const data = await res.json();
      if (data.ok) {
        setCategories(prev => {
          const next = prev.filter(c => c.id !== id);
          setSettingsCategories(next);
          return next;
        });
        if (selectedId === id) setSelectedId(null);
        setExpanded(prev => { const next = new Set(prev); next.delete(id); return next; });
      } else {
        window.alert(data.error || "删除失败");
      }
    } catch { window.alert("删除失败"); }
  }

  async function renameCategory(id: string, name: string) {
    const nextName = name.trim();
    const target = categories.find(c => c.id === id);
    if (!target) return false;
    if (!nextName) {
      setEditError("请填写分类名称");
      return false;
    }
    if (nextName === target.name) return true;

    setEditError("");
    try {
      const res = await fetch("/api/v1/category", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: nextName }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setEditError(data.error ?? "修改失败");
        return false;
      }
      setCategories(prev => {
        const next = prev.map(c => c.id === id ? { ...c, name: data.category.name } : c);
        setSettingsCategories(next);
        return next;
      });
      if (selectedId === id) setEditingName(data.category.name);
      return true;
    } catch {
      setEditError("修改失败");
      return false;
    }
  }

  async function handleRename() {
    if (!selectedCategory) return;
    setSavingEdit(true);
    try {
      await renameCategory(selectedCategory.id, editingName);
    } finally {
      setSavingEdit(false);
    }
  }

  function startInlineEdit(category: Category) {
    setInlineEditingId(category.id);
    setInlineEditingName(category.name);
    setEditError("");
  }

  async function saveInlineEdit(id: string) {
    setInlineSavingId(id);
    try {
      const ok = await renameCategory(id, inlineEditingName);
      if (ok) {
        setInlineEditingId(null);
        setInlineEditingName("");
      }
    } finally {
      setInlineSavingId(null);
    }
  }

  /** Build parent category options for EntityCreateForm — all categories with hierarchy. */
  const parentCategoryOptions = (() => {
    const byParentId = new Map<string | null, Category[]>();
    for (const c of categories) {
      const list = byParentId.get(c.parentId) ?? [];
      list.push(c);
      byParentId.set(c.parentId, list);
    }
    const opts: Array<{ id: string; name: string; label: string; type: string; depth: number; parentId?: string }> = [];
    function walk(pid: string | null, depth: number, currentHeaderId?: string) {
      const children = byParentId.get(pid) ?? [];
      for (const child of children) {
        const headerId = depth === 0 ? child.id : currentHeaderId;
        opts.push({ id: child.id, name: child.name, label: `${typeLabel(child.type)} — ${child.name}`, type: child.type, depth, parentId: depth > 0 ? headerId : undefined });
        walk(child.id, depth + 1, headerId);
      }
    }
    walk(null, 0);
    return opts;
  })();

  function renderCategory(cat: Category, depth: number) {
    const children = getChildren(cat.id);
    const isExpanded = expanded.has(cat.id);
    const isSelected = selectedId === cat.id;
    const hasChildren = children.length > 0;

    return (
      <div key={cat.id}>
        <div onClick={() => select(cat.id)}
          className={`flex items-center gap-1 py-1 px-2 rounded cursor-pointer group ${isSelected ? "bg-blue-50" : "hover:bg-slate-50"}`}
          style={{ paddingLeft: `${12 + depth * 18}px` }}>
          <button onClick={(e) => { e.stopPropagation(); toggleExpand(cat.id); }}
            className="w-4 h-4 flex items-center justify-center shrink-0 text-slate-400 hover:text-slate-600">
            {hasChildren ? (isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />) : <span className="w-3" />}
          </button>
          {inlineEditingId === cat.id ? (
            <input
              value={inlineEditingName}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setInlineEditingName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void saveInlineEdit(cat.id);
                if (e.key === "Escape") {
                  setInlineEditingId(null);
                  setInlineEditingName("");
                }
              }}
              autoFocus
              className="h-7 min-w-0 flex-1 rounded-md border border-blue-200 bg-white px-2 text-sm outline-none focus:border-blue-400"
            />
          ) : (
            <span className={`text-sm flex-1 truncate ${isSelected ? "text-blue-700 font-medium" : "text-slate-700"}`}>{cat.name}</span>
          )}
          {cat.isSystem && <span className="text-[10px] text-slate-400 shrink-0">系统</span>}
          {hasChildren && !isExpanded && <span className="text-[10px] text-slate-400 shrink-0">{children.length}</span>}
          {inlineEditingId === cat.id ? (
            <>
              <button onClick={(e) => { e.stopPropagation(); void saveInlineEdit(cat.id); }}
                disabled={inlineSavingId === cat.id}
                className="h-5 w-5 flex items-center justify-center rounded hover:bg-blue-100 text-blue-600 disabled:opacity-50 shrink-0" title="保存">
                <Save className="w-3 h-3" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); setInlineEditingId(null); setInlineEditingName(""); }}
                className="h-5 w-5 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600 shrink-0" title="取消">
                <X className="w-3 h-3" />
              </button>
            </>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); startInlineEdit(cat); }}
              className="h-5 w-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-slate-100 text-slate-400 hover:text-slate-600 shrink-0" title="修改名称">
              <Pencil className="w-3 h-3" />
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); openAdd(cat.id); }}
            className="h-5 w-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-blue-100 text-slate-400 hover:text-blue-600 shrink-0" title="添加子分类">
            <Plus className="w-3 h-3" />
          </button>
          {!cat.isSystem && (
            <button onClick={(e) => { e.stopPropagation(); handleDelete(cat.id); }}
              className="h-5 w-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 text-slate-400 hover:text-red-500 shrink-0" title="删除">
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        {isExpanded && addingUnder === cat.id && (
          <div style={{ paddingLeft: `${12 + (depth + 1) * 18}px` }}>
            <EntityCreateForm
              mode="full" layout="inline" entityType="category"
              defaultParentId={cat.id}
              defaultType={cat.type}
              parentCategories={parentCategoryOptions}
              onCreated={handleCategoryCreated}
              existingNames={categories.filter(c => c.parentId === cat.id).map(c => c.name)}
              hiddenFields={["parentId"]}
            />
          </div>
        )}
        {isExpanded && children.map(child => renderCategory(child, depth + 1))}
      </div>
    );
  }

  const selectedCategory = selectedId ? categories.find(c => c.id === selectedId) : null;
  const selectedChildren = selectedId ? getChildren(selectedId) : [];
  const selectedPath: string[] = [];
  if (selectedCategory) {
    let cur: Category | undefined = selectedCategory;
    while (cur) {
      selectedPath.unshift(cur.name);
      cur = cur.parentId ? (categories.find(c => c.id === cur!.parentId) ?? undefined) : undefined;
    }
  }

  return (
    <div className="flex" style={{ height: "calc(100vh - 8.5rem)" }}>
      {/* 左侧：分类树 */}
      <div className="w-64 flex flex-col shrink-0 border-r border-slate-200 bg-white">
        <div className="px-4 py-3 border-b border-slate-200 shrink-0">
          <div className="text-sm font-semibold text-slate-800">分类管理</div>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {TYPE_ORDER.map(type => {
            const typeKey = `type:${type}`;
            const typeRoots = roots.filter(c => c.type === type);
            const isExpanded = expanded.has(typeKey);

            return (
              <div key={type} className="mb-0.5">
                <div
                  onClick={() => {
                    if (typeRoots.length > 0) toggleExpand(typeKey);
                    else openAdd("__root__", type);
                  }}
                  className="flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:bg-slate-50 rounded">
                  {typeRoots.length > 0 ? (
                    isExpanded ? <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />
                  ) : <span className="w-3" />}
                  <span className={`text-xs font-semibold ${typeColor(type)} flex-1`}>{typeLabel(type)}</span>
                  <span className="text-[10px] text-slate-400">{typeRoots.length}</span>
                  <button onClick={(e) => { e.stopPropagation(); openAdd("__root__", type); }}
                    className="h-5 w-5 flex items-center justify-center rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 shrink-0"
                    title="创建一级分类">
                    <Plus className="w-3 h-3" />
                  </button>
                </div>

                {addingUnder === "__root__" && addingType === type && (
                  <div className="px-3 py-1">
                    <EntityCreateForm
                      mode="full" layout="inline" entityType="category"
                      defaultType={type}
                      extraFields={{ type }}
                      hiddenFields={["type", "parentId"]}
                      onCreated={handleCategoryCreated}
                      existingNames={categories.filter(c => c.parentId === null && c.type === type).map(c => c.name)}
                    />
                  </div>
                )}

                {isExpanded && typeRoots.map(root => renderCategory(root, 1))}
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧：详情 */}
      <div className="flex-1 bg-slate-50 p-6 min-w-0">
        {selectedCategory ? (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <div className="text-sm font-semibold text-slate-800">分类详情</div>
              </div>
              <div className="p-4">
                <div className="text-xs text-slate-500 mb-3">路径：{selectedPath.join(" 〉")}</div>
                <div className="flex items-end gap-3">
                  <label className="min-w-0 flex-1">
                    <span className="form-label mb-1 block">分类名称</span>
                    <input
                      value={editingName}
                      onChange={(e) => {
                        setEditingName(e.target.value);
                        setEditError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRename();
                      }}
                      className="form-input"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleRename}
                    disabled={savingEdit || !editingName.trim() || editingName.trim() === selectedCategory.name}
                    className="primary-button h-9 gap-1.5 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" />
                    保存
                  </button>
                </div>
                {editError && <div className="mt-2 text-xs text-red-600">{editError}</div>}
                <div className="flex items-center gap-2 mt-3">
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    selectedCategory.type === "expense" ? "bg-red-50 text-red-600" :
                    selectedCategory.type === "income" ? "bg-emerald-50 text-emerald-600" :
                    selectedCategory.type === "advance" ? "bg-amber-50 text-amber-600" :
                    "bg-blue-50 text-blue-600"}`}>
                    {typeLabel(selectedCategory.type)}
                  </span>
                  {selectedCategory.isSystem && <span className="text-xs text-slate-400">系统内置</span>}
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">在「{selectedCategory.name}」下添加子分类</div>
              </div>
              <div className="p-4">
                <EntityCreateForm
                  mode="full" layout="card" entityType="category"
                  defaultParentId={selectedId ?? undefined}
                  defaultType={selectedCategory.type}
                  parentCategories={parentCategoryOptions}
                  hiddenFields={["parentId"]}
                  onCreated={(id, name) => {
                    const created: Category = {
                      id,
                      name,
                      type: selectedCategory.type,
                      parentId: selectedId,
                      isSystem: false,
                    };
                    setCategories(prev => {
                      const next = [...prev, created];
                      setSettingsCategories(next);
                      return next;
                    });
                    setExpanded(prev => new Set([...prev, selectedId!]));
                  }}
                  existingNames={selectedChildren.map(c => c.name)}
                />
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl">
              <div className="px-4 py-3 border-b border-slate-100">
                <div className="text-sm font-medium text-slate-700">
                  {selectedCategory.name} 的子分类
                  <span className="ml-1 text-xs text-slate-400">（{selectedChildren.length} 个）</span>
                </div>
              </div>
              <div className="p-4">
                {selectedChildren.length === 0 ? (
                  <div className="text-xs text-slate-400 py-4 text-center">暂无子分类</div>
                ) : (
                  <div className="space-y-0.5">
                    {selectedChildren.map(child => (
                      <div key={child.id} onClick={() => select(child.id)}
                        className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded cursor-pointer ${selectedId === child.id ? "bg-blue-50" : "hover:bg-slate-50"}`}>
                        {inlineEditingId === child.id ? (
                          <input
                            value={inlineEditingName}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setInlineEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Enter") void saveInlineEdit(child.id);
                              if (e.key === "Escape") {
                                setInlineEditingId(null);
                                setInlineEditingName("");
                              }
                            }}
                            autoFocus
                            className="form-input h-8 min-w-0 flex-1"
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{child.name}</span>
                        )}
                        <div className="flex items-center gap-1">
                          {child.isSystem && <span className="text-[10px] text-slate-400">系统</span>}
                          {inlineEditingId === child.id ? (
                            <>
                              <button onClick={(e) => { e.stopPropagation(); void saveInlineEdit(child.id); }}
                                disabled={inlineSavingId === child.id}
                                className="h-6 w-6 flex items-center justify-center rounded hover:bg-blue-50 text-blue-600 disabled:opacity-50"
                                title="保存">
                                <Save className="w-3 h-3" />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setInlineEditingId(null); setInlineEditingName(""); }}
                                className="h-6 w-6 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                                title="取消">
                                <X className="w-3 h-3" />
                              </button>
                            </>
                          ) : (
                            <button onClick={(e) => { e.stopPropagation(); startInlineEdit(child); }}
                              className="h-6 w-6 flex items-center justify-center rounded hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                              title="修改名称">
                              <Pencil className="w-3 h-3" />
                            </button>
                          )}
                          {!child.isSystem && (
                            <button onClick={(e) => { e.stopPropagation(); handleDelete(child.id); }}
                              className="h-6 w-6 flex items-center justify-center rounded hover:bg-red-50 text-slate-400 hover:text-red-500">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-slate-400">
            选择一个分类查看详情
          </div>
        )}
      </div>
    </div>
  );
}
