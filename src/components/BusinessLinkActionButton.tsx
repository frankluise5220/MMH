"use client";

import { ROW_ACTION_BUTTON_BOX_CLASS } from "@/components/AdvancedDataTable";
import { useI18n } from "@/lib/i18n";

type BusinessLinkActionButtonProps = {
  active: boolean;
  title?: string;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

export function BusinessLinkActionButton({
  active,
  title,
  busy = false,
  disabled = false,
  onClick,
}: BusinessLinkActionButtonProps) {
  const { t } = useI18n();
  const effectiveTitle = active
    ? title ?? t("businessLink.linked")
    : busy
    ? t("businessLink.linking")
    : title ?? t("detailView.notLinked");
  const clickable = !active && !!onClick && !disabled && !busy;

  return (
    <button
      type="button"
      data-row-double-click-ignore
      onClick={(event) => {
        event.stopPropagation();
        if (!clickable) return;
        onClick();
      }}
      disabled={!clickable}
      className={[
        ROW_ACTION_BUTTON_BOX_CLASS,
        "bg-white disabled:cursor-default",
        active
          ? "border-slate-200 text-slate-500"
          : "border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-60",
      ].join(" ")}
      title={effectiveTitle}
      aria-label={effectiveTitle}
    >
      <span
        className={[
          // 圆环与其中的图标都从按钮尺寸派生（0.7 / 0.42）：尺寸只有一个来源。
          "inline-flex h-[calc(var(--mmh-row-action-btn,20px)*0.7)] w-[calc(var(--mmh-row-action-btn,20px)*0.7)] items-center justify-center rounded-full border",
          active
            ? "border-sky-300 bg-sky-100 text-sky-700 shadow-[0_0_0_2px_rgba(14,165,233,0.08)]"
            : "border-slate-200 bg-transparent text-slate-300",
        ].join(" ")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[calc(var(--mmh-row-action-btn,20px)*0.42)] w-[calc(var(--mmh-row-action-btn,20px)*0.42)]">
          <path
            d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      </span>
    </button>
  );
}
