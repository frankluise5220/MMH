"use client";

import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export type ClearableNoteFieldProps = {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  /** Classes applied to the input/textarea itself (e.g. "form-input"). */
  className?: string;
  /** Extra classes for the relative wrapper (e.g. "flex-1", "mt-1", "min-w-[240px]"). */
  wrapperClassName?: string;
  name?: string;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  ariaLabel?: string;
};

/**
 * Shared note/remark field with a floating clear ("X") button on the right.
 * The button only shows when the field holds content and overlays the field's
 * right edge without taking layout space.
 */
export function ClearableNoteField({
  value,
  onValueChange,
  placeholder,
  className = "form-input",
  wrapperClassName,
  name,
  multiline = false,
  rows,
  disabled = false,
  readOnly = false,
  required = false,
  ariaLabel,
}: ClearableNoteFieldProps) {
  const { t } = useI18n();
  const clearTitle = t("table.clear");
  const canClear = !disabled && !readOnly && value.length > 0;
  const fieldClassName = `${className} pr-8`;
  const clearButtonClassName = multiline
    ? "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-200/80 text-slate-500 transition-colors hover:bg-slate-300 hover:text-slate-700"
    : "absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-slate-200/80 text-slate-500 transition-colors hover:bg-slate-300 hover:text-slate-700";

  return (
    <div className={wrapperClassName ? `relative ${wrapperClassName}` : "relative"}>
      {multiline ? (
        <textarea
          name={name}
          value={value}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-label={ariaLabel}
          onChange={(event) => onValueChange(event.target.value)}
          className={fieldClassName}
        />
      ) : (
        <input
          name={name}
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-label={ariaLabel}
          onChange={(event) => onValueChange(event.target.value)}
          className={fieldClassName}
        />
      )}
      {canClear ? (
        <button
          type="button"
          tabIndex={-1}
          title={clearTitle}
          aria-label={clearTitle}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onValueChange("");
          }}
          className={clearButtonClassName}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}
