"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export interface EditField {
  name: string;
  label: string;
  type: "text" | "number" | "select" | "date" | "textarea" | "checkbox";
  placeholder?: string;
  defaultValue?: string | number;
  options?: { value: string; label: string }[];
  required?: boolean;
  disabled?: boolean;
  step?: string;
  min?: string;
  className?: string;
}

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
          await new Promise((resolve) => setTimeout(resolve, 100));
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/28 p-4 backdrop-blur-[2px]">
      <div className={`modal-surface w-full ${maxWidth}`}>
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{title}</div>
          {showCloseButton ? (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="secondary-button h-8 px-2"
            >
              关闭
            </button>
          ) : null}
        </div>

        <form className="max-h-[80vh] space-y-3 overflow-y-auto p-4" onSubmit={handleSubmit}>
          {fields.map((field) => (
            <div key={field.name} className="space-y-1">
              <div className="form-label">
                {field.label}
                {field.required ? <span className="ml-1 text-red-500">*</span> : null}
              </div>

              {field.type === "text" ? (
                <input
                  type="text"
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={field.disabled}
                  className={`form-input ${field.className || ""}`}
                />
              ) : null}

              {field.type === "number" ? (
                <input
                  type="number"
                  step={field.step}
                  min={field.min}
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={field.disabled}
                  className={`form-input ${field.className || ""}`}
                />
              ) : null}

              {field.type === "select" ? (
                <select
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  required={field.required}
                  disabled={field.disabled}
                  className={`form-input ${field.className || ""}`}
                >
                  {!field.required ? <option value="">请选择</option> : null}
                  {field.options?.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : null}

              {field.type === "date" ? (
                <input
                  type="date"
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  required={field.required}
                  disabled={field.disabled}
                  className={`form-input ${field.className || ""}`}
                />
              ) : null}

              {field.type === "textarea" ? (
                <textarea
                  value={formData[field.name]}
                  onChange={(e) => updateField(field.name, e.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  disabled={field.disabled}
                  rows={3}
                  className={`form-textarea ${field.className || ""}`}
                />
              ) : null}

              {field.type === "checkbox" ? (
                <input
                  type="checkbox"
                  checked={formData[field.name] === "true"}
                  onChange={(e) => updateField(field.name, e.target.checked ? "true" : "false")}
                  disabled={field.disabled}
                  className="h-4 w-4 rounded border-slate-200"
                />
              ) : null}
            </div>
          ))}

          <div className="flex justify-end pt-1">
            <button type="submit" disabled={submitting} className="primary-button h-9 px-4">
              {submitting ? "保存中…" : submitButtonText}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
