"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { SettingsDeleteButton } from "@/components/SettingsDeleteButton";

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

export default function SettingsCategoriesClient({
  categories,
}: {
  categories: Category[];
}) {
  const [selectedType, setSelectedType] = useState<string | null>("expense");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const topLevel = categories.filter((c) => c.parentId === null);
  const selectedParent = selectedType ? topLevel.find((c) => c.type === selectedType) : null;
  const selectedCategory = categories.find((c) => c.id === selectedId);
  const parentCategory = selectedCategory?.parentId
    ? categories.find((c) => c.id === selectedCategory.parentId)
    : selectedParent;

  const parentLabel = parentCategory?.name ?? (selectedType ? typeLabel(selectedType) : "无父级");

  const children = selectedType
    ? categories.filter((c) => c.parentId !== null && c.type === selectedType && c.parentId === selectedParent?.id)
    : [];

  const grandChildren = selectedCategory
    ? categories.filter((c) => c.parentId === selectedId)
    : [];

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      <div className="w-72 border-r border-slate-200 bg-white flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-800">分类管理</div>
        </div>
        <div className="px-3 py-2 border-b border-slate-100">
          <div className="flex gap-1">
            {TYPE_ORDER.map((type) => {
              const cat = topLevel.find((c) => c.type === type);
              if (!cat) return null;
              const isActive = selectedType === type;
              return (
                <button
                  key={type}
                  onClick={() => {
                    setSelectedType(type);
                    setSelectedId(null);
                  }}
                  className={`px-2 py-1 text-xs rounded-md transition-colors ${
                    isActive ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {typeLabel(type)}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex-1 overflow-auto py-2">
          {children.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-400">暂无子分类</div>
          ) : (
            children.map((cat) => (
              <div
                key={cat.id}
                onClick={() => setSelectedId(cat.id)}
                className={`flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-slate-50 ${
                  selectedId === cat.id ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-700">{cat.name}</span>
                  {grandChildren.length > 0 && (
                    <span className="text-xs text-slate-400">({grandChildren.length})</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {cat.isSystem && <span className="text-xs text-slate-400">系统</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedId(cat.id);
                    }}
                    className="w-5 h-5 flex items-center justify-center text-slate-400 hover:text-blue-600"
                  >
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="flex-1 bg-slate-50 p-6">
        <div className="bg-white border border-slate-200 rounded-xl">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-800">
              新增分类
              {parentLabel !== typeLabel(selectedType ?? "") && (
                <span className="ml-2 text-sm font-normal text-slate-500">（父级：{parentLabel}）</span>
              )}
            </div>
          </div>
          <div className="p-4">
            <form action="createCategory" className="space-y-3">
              {(selectedCategory ?? parentCategory) && (
                <input type="hidden" name="parentId" value={selectedCategory?.id ?? parentCategory?.id} />
              )}
              <div>
                <label className="block text-xs text-slate-500 mb-1">名称</label>
                <input
                  name="categoryName"
                  className="w-full h-10 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
                  placeholder="输入分类名称"
                />
              </div>
              <button className="w-full h-10 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700">新增</button>
            </form>
          </div>
        </div>
        {grandChildren.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl mt-4">
            <div className="px-4 py-3 border-b border-slate-100">
              <div className="text-sm font-medium text-slate-700">{selectedCategory?.name} 下的子分类</div>
            </div>
            <div className="p-4">
              <div className="space-y-2">
                {grandChildren.map((gc) => (
                  <div key={gc.id} className="flex items-center justify-between py-1">
                    <span className="text-sm text-slate-700">{gc.name}</span>
                    {!gc.isSystem && (
                      <SettingsDeleteButton label={`分类：${gc.name}`} entity="category" id={gc.id} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
