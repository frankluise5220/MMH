"use client";

import { Pencil } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { CalcInput } from "@/components/CalcInput";

export type BatchReplaceInputKind = "date" | "text" | "number" | "select";

export type BatchReplaceOption = {
  value: string;
  label: string;
};

export type BatchReplaceFieldConfig<Field extends string> = {
  value: Field;
  label: string;
  kind: BatchReplaceInputKind;
  options?: BatchReplaceOption[];
  placeholder?: string;
  allowEmpty?: boolean;
};

type Props<Field extends string> = {
  fields: BatchReplaceFieldConfig<Field>[];
  targetCount: number;
  targetLabel?: string;
  disabledTitle?: string;
  buttonTitle?: string;
  panelAlign?: "left" | "right";
  buttonClassName?: string;
  messageClassName?: string;
  children?: ReactNode;
  onApply: (field: Field, value: string) => Promise<string | void> | string | void;
};

export function BatchReplacePopoverButton<Field extends string>({
  fields,
  targetCount,
  targetLabel = "已选",
  disabledTitle = "请先勾选记录",
  buttonTitle,
  panelAlign = "right",
  buttonClassName,
  messageClassName = "text-xs text-slate-500",
  children,
  onApply,
}: Props<Field>) {
  const firstField = fields[0]?.value;
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<Field | undefined>(firstField);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const fieldConfig = useMemo(() => fields.find((item) => item.value === field) ?? fields[0], [field, fields]);
  const disabled = targetCount === 0 || fields.length === 0;
  const canApply = Boolean(fieldConfig) && !submitting && targetCount > 0 && (fieldConfig.allowEmpty || value.trim().length > 0);

  async function applyReplace() {
    if (!fieldConfig || !canApply) return;
    setSubmitting(true);
    setMessage("");
    try {
      const resultMessage = await onApply(fieldConfig.value, value);
      if (resultMessage) setMessage(resultMessage);
      setOpen(false);
      setValue("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量修改失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex items-center gap-2">
      {message ? <span className={messageClassName}>{message}</span> : null}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className={buttonClassName ?? "h-8 w-8 rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"}
        title={disabled ? disabledTitle : (buttonTitle ?? `批量修改${targetLabel} ${targetCount} 条记录`)}
        aria-label={disabled ? disabledTitle : (buttonTitle ?? `批量修改${targetLabel} ${targetCount} 条记录`)}
      >
        <Pencil className="w-4 h-4" />
      </button>
      {open ? (
        <div className={`absolute ${panelAlign === "right" ? "right-0" : "left-0"} top-full z-30 mt-2 w-[360px] rounded-lg border border-blue-100 bg-white p-3 text-xs shadow-lg`}>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-slate-700">修改{targetLabel} {targetCount} 条</span>
            <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">关闭</button>
          </div>
          {children ? <div className="mb-2 text-xs text-slate-500">{children}</div> : null}
          <div className="grid grid-cols-[96px_1fr] gap-2">
            <select
              value={fieldConfig?.value ?? ""}
              onChange={(event) => {
                setField(event.target.value as Field);
                setValue("");
              }}
              className="h-8 rounded border border-slate-200 bg-white px-2 outline-none focus:border-blue-400"
            >
              {fields.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            {fieldConfig?.kind === "select" ? (
              <select value={value} onChange={(event) => setValue(event.target.value)} className="h-8 rounded border border-slate-200 bg-white px-2 outline-none focus:border-blue-400">
                {(fieldConfig.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : fieldConfig?.kind === "number" ? (
              <CalcInput
                value={value}
                onChange={setValue}
                placeholder={fieldConfig?.placeholder ?? "输入数值"}
              />
            ) : (
              <input
                type={fieldConfig?.kind === "date" ? "date" : "text"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={fieldConfig?.placeholder ?? "输入修改内容"}
                className="h-8 rounded border border-slate-200 bg-white px-2 outline-none focus:border-blue-400"
              />
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => { setOpen(false); setValue(""); }} className="h-8 px-3 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50">取消</button>
            <button type="button" onClick={applyReplace} disabled={!canApply} className="h-8 px-3 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? "修改中…" : "应用修改"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
