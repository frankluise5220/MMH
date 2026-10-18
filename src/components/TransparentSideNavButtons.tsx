"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  getSideNavTopOffsetPreference,
  getStoredSideNavTopOffset,
  normalizeSideNavTopOffsetPx,
  setSideNavTopOffsetPreference,
  type SideNavTopOffsetScope,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

type TransparentSideNavButtonsProps = {
  onPrevious: () => void;
  onNext: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  previousLabel: string;
  nextLabel: string;
  /** Which persisted preference stores the vertical offset. */
  scope: SideNavTopOffsetScope;
  /** Center vertically in the panel until the user drags the buttons elsewhere. */
  defaultCentered?: boolean;
  /** Show the resting circles more clearly so the pager is discoverable. */
  emphasized?: boolean;
};

/** Pointer travel (px) before a press counts as a drag instead of a click. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Large translucent prev/next buttons anchored to the sides of a modal panel.
 * Position is relative to the panel (parent must be `relative`). The vertical
 * offset is draggable and persisted per scope so content growth only extends
 * the panel downward.
 */
export function TransparentSideNavButtons({
  onPrevious,
  onNext,
  previousDisabled = false,
  nextDisabled = false,
  previousLabel,
  nextLabel,
  scope,
  defaultCentered = false,
  emphasized = false,
}: TransparentSideNavButtonsProps) {
  const { t } = useI18n();
  // null = 未拖动过且要求默认居中：用 CSS 50% 定位，面板高度变化时仍保持居中。
  const readOffset = useCallback((): number | null => {
    const stored = getStoredSideNavTopOffset(scope);
    if (stored != null) return stored;
    return defaultCentered ? null : getSideNavTopOffsetPreference(scope);
  }, [defaultCentered, scope]);
  const [topOffset, setTopOffset] = useState<number | null>(readOffset);
  const offsetRef = useRef(topOffset);
  offsetRef.current = topOffset;
  const dragRef = useRef<{ pointerId: number; startY: number; startOffset: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setTopOffset(readOffset());
  }, [readOffset]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // 居中模式下把当前的实际像素位置作为拖动起点，避免第一次拖动跳变。
    const startOffset = offsetRef.current ?? event.currentTarget.offsetTop;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startOffset,
      moved: false,
    };
    suppressClickRef.current = false;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    suppressClickRef.current = true;
    event.preventDefault();
    setTopOffset(normalizeSideNavTopOffsetPx(drag.startOffset + delta));
  }, []);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
    if (!drag.moved) return;
    const next = normalizeSideNavTopOffsetPx(drag.startOffset + (event.clientY - drag.startY));
    setTopOffset(next);
    setSideNavTopOffsetPreference(scope, next);
  }, [scope]);

  const handleActivate = useCallback((event: ReactMouseEvent<HTMLButtonElement>, action: () => void, disabled: boolean) => {
    if (disabled || suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    action();
  }, []);

  const dragHint = t("common.dragVerticalHint");
  // emphasized：静止状态也保留一定可见度，便于发现可以翻页；默认为极低透明度。
  const restingOpacity = emphasized ? "opacity-30" : "opacity-5";
  const buttonClassName = (disabled: boolean) => [
    "absolute z-30 inline-flex h-12 w-12 -translate-y-1/2 touch-none items-center justify-center rounded-full",
    "bg-blue-500/10 text-blue-700 shadow-sm backdrop-blur-[1px] transition-all",
    disabled
      ? "cursor-not-allowed opacity-[0.06] hover:opacity-[0.1]"
      : `${restingOpacity} cursor-grab hover:bg-blue-600/30 hover:text-blue-900 hover:opacity-100 hover:shadow-md active:cursor-grabbing`,
  ].join(" ");
  const positionStyle = topOffset == null ? ({ top: "50%" } as const) : ({ top: `${topOffset}px` } as const);

  const renderButton = (
    direction: "previous" | "next",
    action: () => void,
    disabled: boolean,
    label: string,
  ) => {
    const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
    const sideClassName = direction === "previous" ? "left-1" : "right-1";
    const title = `${label} · ${dragHint}`;
    return (
      <button
        type="button"
        onClick={(event) => handleActivate(event, action, disabled)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        aria-disabled={disabled || undefined}
        className={`${buttonClassName(disabled)} ${sideClassName}`}
        style={positionStyle}
        title={title}
        aria-label={label}
      >
        <Icon className="h-8 w-8" />
      </button>
    );
  };

  return (
    <>
      {renderButton("previous", onPrevious, previousDisabled, previousLabel)}
      {renderButton("next", onNext, nextDisabled, nextLabel)}
    </>
  );
}
