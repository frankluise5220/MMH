"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface ModelInfo {
  name: string;
  dbName: string;
  title: string;
}

interface DataRow {
  id: string;
  [key: string]: any;
}

export function DbClient() {
  const router = useRouter();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [data, setData] = useState<DataRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingCell, setEditingCell] = useState<{ rowId: string; field: string } | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // 获取模型列表
  useEffect(() => {
    fetch("/api/v1/db/models")
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setModels(d.models);
          if (d.models.length > 0) {
            setSelectedModel(d.models[0].name);
          }
        }
      })
      .catch(e => console.error("获取模型列表失败:", e));
  }, []);

  // 获取选中的模型数据
  useEffect(() => {
    if (!selectedModel) return;
    setLoading(true);
    fetch(`/api/v1/db/data?model=${selectedModel}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setData(d.data);
        }
      })
      .catch(e => console.error("获取数据失败:", e))
      .finally(() => setLoading(false));
  }, [selectedModel]);

  // 开始编辑单元格
  const startEdit = (rowId: string, field: string, currentValue: any) => {
    setEditingCell({ rowId, field });
    setEditValue(String(currentValue ?? ""));
  };

  // 保存编辑
  const saveEdit = async () => {
    if (!editingCell || saving) return;
    setSaving(true);

    try {
      const res = await fetch("/api/v1/db/data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          id: editingCell.rowId,
          data: { [editingCell.field]: editValue },
        }),
      });

      const d = await res.json();
      if (d.ok) {
        // 更新本地数据
        setData(prev =>
          prev.map(row =>
            row.id === editingCell.rowId
              ? { ...row, [editingCell.field]: editValue }
              : row
          )
        );
        setEditingCell(null);
        setEditValue("");
        router.refresh();
      } else {
        window.alert(d.error || "保存失败");
      }
    } catch (e) {
      window.alert("保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 取消编辑
  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  // 删除记录
  const deleteRow = async (id: string) => {
    if (!window.confirm("确认删除这条记录吗？")) return;

    try {
      const res = await fetch(`/api/v1/db/data?model=${selectedModel}&id=${id}`, {
        method: "DELETE",
      });

      const d = await res.json();
      if (d.ok) {
        setData(prev => prev.filter(row => row.id !== id));
        router.refresh();
      } else {
        window.alert(d.error || "删除失败");
      }
    } catch (e) {
      window.alert("删除失败");
    }
  };

  // 格式化显示值
  const formatValue = (v: any, field: string): string => {
    if (v === null || v === undefined) return "-";
    if (field.includes("Date") || field === "createdAt" || field === "updatedAt") {
      return new Date(v).toLocaleString("zh-CN");
    }
    if (typeof v === "boolean") return v ? "✓" : "✗";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };

  const currentModel = models.find(m => m.name === selectedModel);

  if (models.length === 0) {
    return <div className="p-4 text-slate-500">加载中...</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧导航 */}
      <nav className="w-[200px] border-r border-slate-200 bg-slate-50 flex flex-col overflow-y-auto shrink-0">
        <div className="px-3 py-2 border-b border-slate-200 bg-slate-100 font-bold text-sm">
          表导航 ({models.length})
        </div>
        {models.map((m) => (
          <button
            key={m.name}
            onClick={() => setSelectedModel(m.name)}
            className={`px-3 py-1.5 text-xs text-left truncate border-b border-slate-100 ${
              selectedModel === m.name
                ? "bg-blue-50 text-blue-600 font-semibold"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            {m.title} <span className="text-slate-300 font-mono">({m.name})</span>
          </button>
        ))}
      </nav>

      {/* 右侧内容 */}
      <main className="flex-1 min-w-0 min-h-0 overflow-hidden p-4">
        {loading ? (
          <div className="text-slate-500">加载中...</div>
        ) : currentModel && data.length > 0 ? (
          <div className="h-full min-h-0 border border-slate-200 rounded-lg overflow-hidden flex flex-col">
            <div className="text-xs font-semibold bg-slate-100 px-3 py-2 border-b border-slate-200 flex items-center gap-2">
              <span>{currentModel.title}</span>
              <span className="text-slate-400 font-normal">({data.length})</span>
              <span className="text-slate-300 font-mono font-normal">{currentModel.name}</span>
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
              <table className="min-w-full">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
                  <tr>
                    {Object.keys(data[0])
                      .slice(0, 40) // 显示前40个字段（包含基金字段）
                      .map((field) => (
                        <th
                          key={field}
                          className="text-xs font-semibold text-slate-600 px-2 py-1.5 text-left whitespace-nowrap"
                        >
                          {field}
                          {field === "id" && <span className="text-blue-500 ml-1">★</span>}
                        </th>
                      ))}
                    <th className="text-xs font-semibold text-slate-600 px-2 py-1.5 text-right">操作</th>
                  </tr>
                </thead>

                <tbody className="text-xs">
                  {data.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50 border-b border-slate-100">
                      {Object.keys(row)
                        .slice(0, 40)
                        .map((field) => {
                          const isEditing =
                            editingCell?.rowId === row.id &&
                            editingCell?.field === field;

                          return (
                            <td
                              key={field}
                              className="px-2 py-1 whitespace-nowrap cursor-pointer hover:bg-blue-50"
                              onClick={() => {
                                if (!isEditing && !saving && field !== "id") {
                                  startEdit(row.id, field, row[field]);
                                }
                              }}
                            >
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveEdit();
                                    if (e.key === "Escape") cancelEdit();
                                  }}
                                  className="w-full px-1 py-0.5 border border-blue-300 rounded text-xs"
                                  autoFocus
                                />
                              ) : (
                                formatValue(row[field], field)
                              )}
                            </td>
                          );
                        })}
                      <td className="px-2 py-1 text-right">
                        <button
                          onClick={() => deleteRow(row.id)}
                          className="text-red-500 hover:text-red-700"
                          disabled={saving}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="text-slate-500 text-xs">暂无数据</div>
        )}
      </main>
    </div>
  );
}