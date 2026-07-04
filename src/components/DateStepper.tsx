"use client";

import { ChevronUp, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";

function isValidDateText(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatDigitsAsDate(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

function formatDateDraft(value: string) {
  if (!value.includes("-")) return formatDigitsAsDate(value);

  const parts = value.split("-");
  const year = (parts[0] ?? "").replace(/\D/g, "").slice(0, 4);
  const monthDigits = (parts[1] ?? "").replace(/\D/g, "");
  const dayDigits = parts.length > 2
    ? (parts[2] ?? "").replace(/\D/g, "")
    : monthDigits.slice(2);
  const month = monthDigits.slice(0, 2);
  const day = dayDigits.slice(0, 2);
  const hasMonthPart = value.includes("-");
  const hasDayPart = parts.length > 2 || monthDigits.length > 2;

  if (!hasMonthPart) return year;
  if (!hasDayPart) return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function clampMin(value: string, min?: string) {
  if (min && isValidDateText(value) && isValidDateText(min) && value < min) return min;
  return value;
}

export function DateStepper({ value, onChange, onBlur, min, className, disabled, name }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  min?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    const clamped = clampMin(next, min);
    setDraft(clamped);
    onChange(clamped);
  };

  const shift = (d: number) => {
    const baseValue = isValidDateText(draft) ? draft : value;
    if (!isValidDateText(baseValue)) return;
    const [y, m, day] = baseValue.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, day + d)).toISOString().slice(0, 10);
    commit(next);
    onBlur?.();
  };

  const handleChange = (rawValue: string) => {
    const next = formatDateDraft(rawValue);
    setDraft(next);
    if (isValidDateText(next)) {
      onChange(clampMin(next, min));
    }
  };

  const handleBlur = () => {
    if (!draft.trim()) {
      onChange("");
    } else if (isValidDateText(draft)) {
      commit(draft);
    } else {
      setDraft(value);
    }
    onBlur?.();
  };

  return (
    <div className="relative h-9">
      <input
        name={name}
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        placeholder="YYYY-MM-DD"
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        className={`form-input pl-2.5 pr-8 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 ${className ?? ""}`}
      />
      <div className="absolute right-0.5 top-0 bottom-0 flex flex-col justify-center">
        <button type="button" onClick={() => shift(1)} tabIndex={-1} disabled={disabled}
          className="flex h-[18px] w-5 items-center justify-center rounded-t-[6px] text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">
          <ChevronUp className="w-3 h-3" />
        </button>
        <button type="button" onClick={() => shift(-1)} tabIndex={-1} disabled={disabled}
          className="flex h-[18px] w-5 items-center justify-center rounded-b-[6px] text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40">
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
