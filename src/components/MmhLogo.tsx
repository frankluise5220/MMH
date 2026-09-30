import Image from "next/image";
import type { CSSProperties } from "react";
import { withBasePath } from "@/lib/base-path";

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
  // next/image does not apply basePath to `src` (Next docs: you must add it
  // yourself), so the fnOS gateway build needs it prefixed by hand.
  const mark = (
    <Image
      aria-hidden="true"
      className="shrink-0"
      width={size}
      height={size}
      src={withBasePath("/branding/mmh-logo-pageflip.square.png")}
      alt=""
      unoptimized
      style={{ objectFit: "contain" }}
    />
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
