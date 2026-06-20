"use client";

import { ChevronUp, ChevronDown } from "lucide-react";

export function DateStepper({ value, onChange, onBlur, min, className }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  min?: string;
  className?: string;
}) {
  const shift = (d: number) => {
    if (!value) return;
    const [y, m, day] = value.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, day + d)).toISOString().slice(0, 10);
    onChange(next);
    onBlur?.();
  };
  return (
    <div className="relative h-9">
      <input type="date" value={value} min={min}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={`form-input pl-2.5 pr-8 ${className ?? ""}`} />
      <div className="absolute right-0.5 top-0 bottom-0 flex flex-col justify-center">
        <button type="button" onClick={() => shift(1)} tabIndex={-1}
          className="flex h-[18px] w-5 items-center justify-center rounded-t-[6px] text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          <ChevronUp className="w-3 h-3" />
        </button>
        <button type="button" onClick={() => shift(-1)} tabIndex={-1}
          className="flex h-[18px] w-5 items-center justify-center rounded-b-[6px] text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          <ChevronDown className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
