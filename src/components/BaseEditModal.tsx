"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

/**
 * 编辑模态框字段定义
 */
export interface EditField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "date" | "textarea" | "checkbox";
  placeholder?: string;
  defaultValue?: string | number;
  options?: { value: string; label: string }[];
  required?: boolean;
  disabled?: boolean;
  step?: string; // for number inputs
  min?: string; // for number inputs
  className?: string;
}

/**
 * 统一的编辑模态框组件
 *
 * 提供打开/关闭逻辑、表单处理、刷新等标准功能
 */
export function BaseEditModal({
  title,
  fields,
  isOpen,
  onOpenChange,
  onSubmit,
  submitButtonText = "保存",
  refreshOnSave = true,
  maxWidth = "max-w-md",
  showCloseButton = true,
}: {
  title: string;
  fields: EditField[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (formData: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
  submitButtonText?: string;
  refreshOnSave?: boolean;
  maxWidth?: string;
  showCloseButton?: boolean;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    fields.forEach((field) => {
      initial[field.name] = String(field.defaultValue ?? "");
    });
    return initial;
  });

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      const result = await onSubmit(formData);
      if (result.ok) {
        onOpenChange(false);
        if (refreshOnSave) {
          await new Promise(resolve => setTimeout(resolve, 100));
          router.refresh();
        }
      } else {
        window.alert(result.error || "保存失败");
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const updateField = (name: string, value: string) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className={`w-full ${maxWidth} rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden`}>
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-800">{title}</div>
          {showCloseButton && (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
            >
              关闭
            </button>
          )}
        </div>

        <form className="p-4 space-y-3 overflow-y-auto max-h-[80vh]" onSubmit={handleSubmit}>
          {fields.map((field) => (
            <div key={field.name} className="space-y-1">
              <div className="text-xs font-medium text-slate-600">
                {field.label}
                {field.required && <span className="text-red-500 ml-1">*</span>}
              </div>

              {field.type === "text" && (
                <input
                  type="text"
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={field.disabled}
                  className={`h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:bg-slate-50 disabled:text-slate-600 ${field.className || ""}`}
                />
              )}

              {field.type === "number" && (
                <input
                  type="number"
                  step={field.step}
                  min={field.min}
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={field.disabled}
                  className={`h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:bg-slate-50 disabled:text-slate-600 ${field.className || ""}`}
                />
              )}

              {field.type === "select" && (
                <select
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  required={field.required}
                  disabled={field.disabled}
                  className={`h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:bg-slate-50 ${field.className || ""}`}
                >
                  {!field.required && <option value="">请选择</option>}
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}

              {field.type === "date" && (
                <input
                  type="date"
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  required={field.required}
                  disabled={field.disabled}
                  className={`h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none disabled:bg-slate-50 disabled:text-slate-600 ${field.className || ""}`}
                />
              )}

              {field.type === "textarea" && (
                <textarea
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={field.disabled}
                  rows={3}
                  className={`w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none disabled:bg-slate-50 disabled:text-slate-600 ${field.className || ""}`}
                />
              )}

              {field.type === "checkbox" && (
                <input
                  type="checkbox"
                  checked={formData[field.name] === "true"}
                  onChange={(e) => updateField(field.name, e.target.checked ? "true" : "false")}
                  disabled={field.disabled}
                  className="h-4 w-4 rounded border-slate-200"
                />
              )}
            </div>
          ))}

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={submitting}
              className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "保存中…" : submitButtonText}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}