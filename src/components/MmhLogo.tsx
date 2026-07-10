import type { CSSProperties } from "react";

type MmhLogoProps = {
  className?: string;
  size?: number;
  showWordmark?: boolean;
  style?: CSSProperties;
};

export function MmhLogo({
  className,
  size = 32,
  showWordmark = false,
  style,
}: MmhLogoProps) {
  const mark = (
    <svg
      aria-hidden="true"
      className="shrink-0"
      width={size}
      height={size}
      viewBox="0 0 128 128"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="128" height="128" rx="32" fill="#141414" />
      <path d="M24 98V31.5c0-2.1 2.5-3 4-1.4L64 69.5l36-39.4c1.5-1.6 4-.7 4 1.4V98H86V57.4L67 78.2c-1.6 1.8-4.4 1.8-6 0L42 57.4V98H24Z" fill="#F7F3E7" />
      <path d="M24 98V31.5c0-2.1 2.5-3 4-1.4L64 69.5l36-39.4c1.5-1.6 4-.7 4 1.4" fill="none" stroke="#D2B36A" strokeLinecap="round" strokeLinejoin="round" strokeWidth="8" />
    </svg>
  );

  if (!showWordmark) {
    return (
      <span className={className} style={style} aria-label="MoneyMoneyHome">
        {mark}
      </span>
    );
  }

  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className ?? ""}`} style={style}>
      {mark}
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold tracking-tight text-slate-900">MoneyMoneyHome</span>
        <span className="block truncate text-[10px] font-medium uppercase tracking-[0.12em] text-slate-400">Family Finance</span>
      </span>
    </span>
  );
}
