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
      <rect width="128" height="128" rx="30" fill="#193B3A" />
      <path
        d="M27 96V59C27 40 42.5 27 64 27C85.5 27 101 40 101 59V96"
        fill="none"
        stroke="#FFF9F0"
        strokeLinecap="round"
        strokeWidth="13"
      />
      <path d="M64 54V96" fill="none" stroke="#E56F4D" strokeLinecap="round" strokeWidth="11" />
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
        <span className="block truncate text-sm font-semibold tracking-normal text-slate-900">MoneyMoneyHome</span>
        <span className="block truncate text-[10px] font-medium uppercase tracking-normal text-slate-400">Family Finance</span>
      </span>
    </span>
  );
}
