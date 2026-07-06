"use client";

export function DateStepper({ value, onChange, onBlur, min, className, disabled, name }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  min?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <input
      name={name}
      type="date"
      value={value}
      min={min}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onBlur}
      className={`form-input disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 ${className ?? ""}`}
    />
  );
}
